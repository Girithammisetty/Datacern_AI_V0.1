"""Trial-expiry commercial gate on the decide route (BRD 66 CPL-FR-022, AC-2).

Once the leader-elected trial sweep moves a tenant to `suspended_commercial`,
the tenant degrades to READ-ONLY: approving a proposal returns 403
TRIAL_EXPIRED and nothing executes, while listing/reading proposals -- and
rejecting them -- keep working. AC-2 states this literally: "a proposal-
approval attempt returns 403 TRIAL_EXPIRED while case reads still succeed."

The suspension signal is the `commercial_state` JWT claim identity-service
mints on every token (internal/domain/token.go:72), so the governed-write path
takes on no synchronous projection dependency (CPL-NFR-001).
"""

from __future__ import annotations

import httpx
import pytest

from app.container import build_container
from app.domain.entities import Run, new_uuid
from app.graphs.base import WriteIntent
from app.main import create_app
from tests.conftest import TENANT_A, make_settings, make_token


class _AllowAuthz:
    async def allow(self, *, subject, action, tenant, resource_urn=None, workspace_id=None):
        return True


@pytest.fixture
async def client_and_container():
    c = build_container(make_settings(), mode="memory", authz=_AllowAuthz())
    app = create_app(c)
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        yield client, c


def _auth(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def _suspended_token(sub: str = "u-approver") -> str:
    return make_token(sub=sub, tenant_id=TENANT_A, commercial_state="suspended_commercial")


def _active_token(sub: str = "u-approver") -> str:
    return make_token(sub=sub, tenant_id=TENANT_A, commercial_state="active")


async def _pending_proposal(c):
    """A PENDING proposal raised by u-77, so a decision by u-approver is a
    genuine second pair of eyes rather than a self-approval."""
    run = Run(run_id=new_uuid(), tenant_id=TENANT_A, session_id=new_uuid(),
              agent_key="case-triage", agent_version=1, temporal_workflow_id=None,
              status="running", principal_type="user_obo", obo_sub="u-77")
    await c.store.create_run(run)
    intent = WriteIntent(
        tool_id="case.apply_disposition", tool_version="1.0.0", tier="write-proposal",
        side_effects="reversible",
        args={"case_id": "c-91", "severity": "high", "assignee_id": "u-dana"},
        rationale="Vendor pattern matches 14 resolved cases.",
        affected_urns=[f"wr:{TENANT_A}:case:case/c-91"],
        predicted_effect={"summary": "assign + severity high",
                          "reversibility": "reversible", "blast_radius": 1})
    prop, _ = await c.proposal_service.create_from_intent(
        run=run, intent=intent, obo_user="u-77", auto_execute_policy={})
    return prop


async def test_approve_is_refused_and_executes_nothing_when_trial_expired(
        client_and_container):
    client, c = client_and_container
    prop = await _pending_proposal(c)

    resp = await client.post(f"/api/v1/proposals/{prop.proposal_id}/decide",
                             json={"action": "approve"}, headers=_auth(_suspended_token()))

    assert resp.status_code == 403
    assert resp.json()["error"]["code"] == "TRIAL_EXPIRED"
    # The gate must stop the write BEFORE the grant is released: a refusal that
    # still called tool-plane would be a revenue leak wearing a 403.
    assert c.tool_client.calls == []
    still = await c.store.get_proposal(TENANT_A, prop.proposal_id)
    assert still.status == "pending"


@pytest.mark.parametrize("action,body", [
    ("edit_args", {"edited_args": {"case_id": "c-91", "severity": "medium",
                                   "assignee_id": "u-dana"}}),
    ("respond", {"message": "please continue"}),
])
async def test_other_value_delivering_actions_are_refused_too(
        client_and_container, action, body):
    """edit_args releases a grant just like approve; respond continues an agent
    run and spends model budget. Both are value delivery, so both are gated."""
    client, c = client_and_container
    prop = await _pending_proposal(c)

    resp = await client.post(f"/api/v1/proposals/{prop.proposal_id}/decide",
                             json={"action": action, **body},
                             headers=_auth(_suspended_token()))

    assert resp.status_code == 403
    assert resp.json()["error"]["code"] == "TRIAL_EXPIRED"
    assert c.tool_client.calls == []


async def test_reads_still_succeed_when_trial_expired(client_and_container):
    """AC-2's other half: suspension is read-only, not lock-out."""
    client, c = client_and_container
    prop = await _pending_proposal(c)
    hdrs = _auth(_suspended_token())

    listed = await client.get("/api/v1/proposals", headers=hdrs)
    assert listed.status_code == 200
    assert any(p["id"] == prop.proposal_id for p in listed.json()["data"])

    one = await client.get(f"/api/v1/proposals/{prop.proposal_id}", headers=hdrs)
    assert one.status_code == 200


async def test_reject_still_allowed_when_trial_expired(client_and_container):
    """Rejecting executes nothing and is how a suspended tenant drains its
    queue -- blocking it would trap the customer with work it cannot clear."""
    client, c = client_and_container
    prop = await _pending_proposal(c)

    resp = await client.post(f"/api/v1/proposals/{prop.proposal_id}/decide",
                             json={"action": "reject", "message": "not this vendor"},
                             headers=_auth(_suspended_token()))

    assert resp.status_code == 200
    assert resp.json()["data"]["status"] == "rejected"
    assert c.tool_client.calls == []


async def test_approve_succeeds_for_a_live_tenant(client_and_container):
    """Non-vacuity: the same request that 403s above must pass on an active
    tenant, proving the gate keys on commercial_state and not on something
    incidental to the harness."""
    client, c = client_and_container
    prop = await _pending_proposal(c)

    resp = await client.post(f"/api/v1/proposals/{prop.proposal_id}/decide",
                             json={"action": "approve"}, headers=_auth(_active_token()))

    assert resp.status_code == 200
    assert resp.json()["data"]["status"] == "approved"
    assert len(c.tool_client.calls) == 1


async def test_token_without_commercial_claim_can_still_approve(client_and_container):
    """Tokens minted before the commercial plane shipped carry no
    `commercial_state`. Absent must mean "unknown", never "suspended" -- the
    opposite would lock every pre-existing tenant out of approvals."""
    client, c = client_and_container
    prop = await _pending_proposal(c)
    legacy = make_token(sub="u-approver", tenant_id=TENANT_A)  # no commercial_state

    resp = await client.post(f"/api/v1/proposals/{prop.proposal_id}/decide",
                             json={"action": "approve"}, headers=_auth(legacy))

    assert resp.status_code == 200
    assert resp.json()["data"]["status"] == "approved"
