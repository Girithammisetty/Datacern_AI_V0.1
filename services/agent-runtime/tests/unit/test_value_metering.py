"""BRD 67 slice 1 — `governed_decision` meter emission (VMB-FR-002/003).

Covers:
  - the pure helpers in app/domain/metering.py
  - proposals/service.py: terminal human decisions (approve/edit/reject) carry
    the metering fields on the `ai.proposal.v1` envelope; supersede/expiry
    never call `_emit` at all so they can never carry them; `respond`
    (-> cancelled) is terminal but NOT a governed decision, so it carries none
    either; edit-approve produces edit_distance_bucket; auto-executed
    approvals also carry metering fields (the design's governed_decision
    table has no actor filter — see docs/initiatives/value-metering-billing-
    export.md §2.2).
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from app.domain import metering
from app.domain.entities import Run, new_uuid
from app.graphs.base import WriteIntent
from tests.conftest import TENANT_A, make_settings
from app.container import build_container


def _container():
    return build_container(make_settings(), mode="memory")


async def _run(c, tenant=TENANT_A, agent="case-triage"):
    r = Run(run_id=new_uuid(), tenant_id=tenant, session_id=new_uuid(), agent_key=agent,
            agent_version=1, temporal_workflow_id=None, status="running",
            principal_type="user_obo", obo_sub="u-77")
    await c.store.create_run(r)
    return r


def _intent():
    return WriteIntent(
        tool_id="case.apply_disposition", tool_version="1.0.0", tier="write-proposal",
        side_effects="reversible",
        args={"case_id": "c-91", "severity": "high", "assignee_id": "u-dana"},
        rationale="Vendor pattern matches 14 resolved cases.",
        affected_urns=[f"wr:{TENANT_A}:case:case/c-91"],
        predicted_effect={"summary": "assign + severity high", "reversibility": "reversible",
                          "blast_radius": 1})


# ---- pure helpers (app/domain/metering.py) ---------------------------------

def test_proposal_kind_derives_from_tool_id_namespace():
    assert metering.proposal_kind("case.apply_disposition") == "case"
    assert metering.proposal_kind("chart.dashboard.create") == "chart"
    assert metering.proposal_kind("mlops.open_retrain") == "mlops"
    assert metering.proposal_kind("") == "unknown"
    assert metering.proposal_kind(None) == "unknown"


def test_decision_label_only_for_terminal_governed_statuses():
    assert metering.decision_label("approved") == "approved"
    assert metering.decision_label("edited_approved") == "edited"
    assert metering.decision_label("rejected") == "rejected"
    # not governed decisions:
    assert metering.decision_label("cancelled") is None
    assert metering.decision_label("pending") is None
    assert metering.decision_label("expired") is None
    assert metering.decision_label("superseded") is None


def test_edit_distance_bucket_thresholds():
    assert metering.edit_distance_bucket(None) is None
    assert metering.edit_distance_bucket([]) == "none"
    assert metering.edit_distance_bucket([{"field": "a"}]) == "minor"
    assert metering.edit_distance_bucket([{"field": "a"}, {"field": "b"}]) == "minor"
    assert metering.edit_distance_bucket(
        [{"field": "a"}, {"field": "b"}, {"field": "c"}]) == "major"


def test_decision_latency_ms_computes_delta():
    created = datetime(2026, 7, 25, 12, 0, 0, tzinfo=UTC)
    decided = created + timedelta(milliseconds=2500)
    assert metering.decision_latency_ms(created, decided) == 2500


# ---- emission integration (proposals/service.py) ---------------------------

async def test_approve_carries_governed_decision_metering_fields():
    c = _container()
    run = await _run(c)
    prop, _ = await c.proposal_service.create_from_intent(
        run=run, intent=_intent(), obo_user="u-77", auto_execute_policy={})
    await c.proposal_service.decide(
        tenant_id=TENANT_A, proposal_id=prop.proposal_id, actor_sub="u-super",
        action="approve")

    events = c.bus.of_type("proposal.approved")
    assert len(events) == 1
    payload = events[0]["payload"]
    assert payload["decision_label"] == "approved"
    assert payload["proposal_kind"] == "case"
    assert payload["pack_name"] is None
    assert isinstance(payload["decision_latency_ms"], int)
    assert payload["decision_latency_ms"] >= 0
    assert "edit_distance_bucket" not in payload  # approve-only, not edit


async def test_reject_carries_governed_decision_metering_fields():
    c = _container()
    run = await _run(c)
    prop, _ = await c.proposal_service.create_from_intent(
        run=run, intent=_intent(), obo_user="u-77", auto_execute_policy={})
    await c.proposal_service.decide(
        tenant_id=TENANT_A, proposal_id=prop.proposal_id, actor_sub="u-super",
        action="reject", message="not this vendor")

    events = c.bus.of_type("proposal.rejected")
    assert len(events) == 1
    payload = events[0]["payload"]
    assert payload["decision_label"] == "rejected"
    assert payload["proposal_kind"] == "case"
    assert isinstance(payload["decision_latency_ms"], int)


async def test_edit_approve_carries_edit_distance_bucket():
    c = _container()
    run = await _run(c)
    prop, _ = await c.proposal_service.create_from_intent(
        run=run, intent=_intent(), obo_user="u-77", auto_execute_policy={})
    await c.proposal_service.decide(
        tenant_id=TENANT_A, proposal_id=prop.proposal_id, actor_sub="u-super",
        action="edit_args",
        edited_args={"case_id": "c-91", "severity": "medium", "assignee_id": "u-dana"})

    events = c.bus.of_type("proposal.edited_approved")
    assert len(events) == 1
    payload = events[0]["payload"]
    assert payload["decision_label"] == "edited"
    # one field changed (severity) -> minor bucket
    assert payload["edit_distance_bucket"] == "minor"
    assert isinstance(payload["decision_latency_ms"], int)


async def test_respond_cancelled_carries_no_metering_fields():
    """`respond` is a terminal proposal status (cancelled) but NOT a governed
    decision (VMB-FR-002) — it must not be counted by the governed_decision
    meter, so its event carries none of the metering keys."""
    c = _container()
    run = await _run(c)
    prop, _ = await c.proposal_service.create_from_intent(
        run=run, intent=_intent(), obo_user="u-77", auto_execute_policy={})
    await c.proposal_service.decide(
        tenant_id=TENANT_A, proposal_id=prop.proposal_id, actor_sub="u-super",
        action="respond", message="need more context first")

    events = c.bus.of_type("proposal.cancelled")
    assert len(events) == 1
    payload = events[0]["payload"]
    for key in ("decision_label", "proposal_kind", "pack_name",
                "decision_latency_ms", "edit_distance_bucket"):
        assert key not in payload


async def test_proposal_created_carries_no_metering_fields():
    c = _container()
    run = await _run(c)
    await c.proposal_service.create_from_intent(
        run=run, intent=_intent(), obo_user="u-77", auto_execute_policy={})

    events = c.bus.of_type("proposal.created")
    assert len(events) == 1
    payload = events[0]["payload"]
    for key in ("decision_label", "proposal_kind", "pack_name",
                "decision_latency_ms", "edit_distance_bucket"):
        assert key not in payload


async def test_supersede_pending_emits_no_event_at_all():
    """A second WriteIntent on the same run/tool/URNs supersedes the first
    PENDING proposal (store.supersede_pending — a bare SQL/dict UPDATE, no
    _emit call anywhere in that path). VMB-FR-002: supersede is never metered
    because it is never even an event, let alone one with metering fields."""
    c = _container()
    run = await _run(c)
    prop1, _ = await c.proposal_service.create_from_intent(
        run=run, intent=_intent(), obo_user="u-77", auto_execute_policy={})
    prop2, _ = await c.proposal_service.create_from_intent(
        run=run, intent=_intent(), obo_user="u-77", auto_execute_policy={})

    superseded = await c.store.get_proposal(TENANT_A, prop1.proposal_id)
    assert superseded.status == "superseded"
    # exactly two proposal.created events (one per intent) and NOTHING else —
    # no proposal.superseded / expired event type exists anywhere on the bus.
    assert len(c.bus.of_type("proposal.created")) == 2
    all_types = {e["event_type"] for _, e in c.bus.published}
    assert "proposal.superseded" not in all_types
    assert "proposal.expired" not in all_types


async def test_auto_executed_approval_also_carries_metering_fields():
    """The design's governed_decision source filter (ai.proposal.v1 ::
    proposal.approved|edited_approved|rejected) has no actor exclusion —
    an auto-executed proposal is still a decision made under the governed
    proposal framework (the tenant's auto-execute policy IS the governance),
    and it is separately, additionally counted by auto_executed_action via
    its own decision.actor=='policy:auto' filter (design §2.1/§2.2)."""
    c = _container()
    run = await _run(c, agent="dashboard-designer")
    policy = {"dashboard-designer": {"write-proposal": {"reversible": "auto"}}}
    prop, executed = await c.proposal_service.create_from_intent(
        run=run, intent=_intent(), obo_user="u-77", auto_execute_policy=policy)
    assert executed is True

    events = c.bus.of_type("proposal.approved")
    assert len(events) == 1
    payload = events[0]["payload"]
    assert payload["decision_label"] == "approved"
    assert payload["decision"]["actor"] == "policy:auto"
    assert isinstance(payload["decision_latency_ms"], int)
    assert payload["decision_latency_ms"] >= 0
