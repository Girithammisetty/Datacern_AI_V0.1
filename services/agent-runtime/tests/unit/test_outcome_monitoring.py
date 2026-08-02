"""BRD 55 inc1: decision outcome monitoring — capture realized outcomes joined
to a decision's provenance, and read decided-vs-realized effectiveness. Covers
the pure aggregator + the API (capture, join, effectiveness, isolation)."""

from __future__ import annotations

import httpx
import pytest

from app.container import build_container
from app.domain.entities import Proposal, new_uuid, now
from app.domain.outcomes import (
    OutcomeLabel, compute_correct, detect_drift, effectiveness, sft_enrichment,
)
from app.main import create_app
from tests.conftest import TENANT_A, TENANT_B, make_settings, make_token

# ---- pure aggregator ----

def test_compute_correct():
    assert compute_correct("deny", "deny") is True
    assert compute_correct("Deny", " deny ") is True      # case/space-insensitive
    assert compute_correct("deny", "approve") is False
    assert compute_correct(None, "deny") is None           # nothing decided
    assert compute_correct("", "deny") is None


def test_effectiveness_grouping():
    labs = [
        OutcomeLabel("1", "t", "d1", "case.apply_disposition", "won", "won", True, producer="agent-x"),  # noqa: E501
        OutcomeLabel("2", "t", "d2", "case.apply_disposition", "won", "lost", False, producer="agent-x"),  # noqa: E501
        OutcomeLabel("3", "t", "d3", "case.apply_disposition", "won", "won", True, producer="table-y"),  # noqa: E501
        OutcomeLabel("4", "t", "d4", "case.apply_disposition", None, "won", None, producer="table-y"),  # noqa: E501
    ]
    by_type = effectiveness(labs, by="decision_type")
    assert by_type[0]["total"] == 4 and by_type[0]["correct"] == 2
    assert by_type[0]["incorrect"] == 1 and by_type[0]["unknown"] == 1
    assert by_type[0]["effectiveness_rate"] == round(2 / 3, 4)  # unknown excluded

    by_prod = effectiveness(labs, by="producer")
    prod = {r["key"]: r for r in by_prod}
    assert prod["agent-x"]["effectiveness_rate"] == 0.5
    assert prod["table-y"]["correct"] == 1 and prod["table-y"]["unknown"] == 1


# ---- OM-FR-030 drift detection (pure) ----

def _lab(i, correct, dtype="case.apply_disposition", producer="agent-x"):
    return OutcomeLabel(str(i), "t", f"d{i}", dtype, "won",
                        "won" if correct else "lost", correct, producer=producer)


def test_detect_drift_flags_material_drop():
    # 10 correct then 10 incorrect (same type, chronological): baseline 100% ->
    # recent 0%, a 1.0 drop, both windows = 10 scored.
    labels = [_lab(i, True) for i in range(10)] + [_lab(10 + i, False) for i in range(10)]
    signals = detect_drift(labels, min_drop=0.15, min_scored_per_window=10)
    assert len(signals) == 1
    s = signals[0]
    assert s["key"] == "case.apply_disposition"
    assert s["baseline_rate"] == 1.0 and s["recent_rate"] == 0.0 and s["drop"] == 1.0
    assert s["baseline_scored"] == 10 and s["recent_scored"] == 10


def test_detect_drift_respects_min_drop():
    # baseline 100% (10) -> recent 90% (9/10): only a 0.1 drop, below 0.15.
    labels = [_lab(i, True) for i in range(10)] + \
             [_lab(10 + i, i != 0) for i in range(10)]
    assert detect_drift(labels, min_drop=0.15, min_scored_per_window=10) == []


def test_detect_drift_requires_enough_scored_labels():
    # A big drop but only 4 labels per window -> no flag (noise floor).
    labels = [_lab(i, True) for i in range(4)] + [_lab(4 + i, False) for i in range(4)]
    assert detect_drift(labels, min_drop=0.15, min_scored_per_window=10) == []


def test_detect_drift_ignores_unknown_labels():
    # Unknown (correct=None) labels never count toward a window.
    labels = [_lab(i, True) for i in range(10)]
    labels += [OutcomeLabel(f"u{i}", "t", f"du{i}", "case.apply_disposition", "won",
                            "won", None, producer="agent-x") for i in range(50)]
    labels += [_lab(100 + i, False) for i in range(10)]
    signals = detect_drift(labels, min_drop=0.15, min_scored_per_window=10)
    assert len(signals) == 1 and signals[0]["recent_scored"] == 10


def test_detect_drift_input_not_mutated():
    labels = [_lab(i, True) for i in range(10)] + [_lab(10 + i, False) for i in range(10)]
    before = list(labels)
    detect_drift(labels)
    assert labels == before


# ---- OM-FR-040 SFT enrichment (pure) ----

def test_sft_enrichment_weights():
    correct = sft_enrichment(_lab(1, True))
    assert correct["outcome"] == "correct" and correct["sample_weight"] == 1.0
    assert correct["decision_ref"] == "d1"

    wrong = sft_enrichment(_lab(2, False))
    assert wrong["outcome"] == "incorrect" and wrong["sample_weight"] == 0.0

    unlabeled = sft_enrichment(
        OutcomeLabel("3", "t", "d3", "case.apply_disposition", "won", "won", None))
    assert unlabeled["outcome"] == "unlabeled" and unlabeled["sample_weight"] == 0.5


# ---- API ----

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


def _auth(tenant=TENANT_A, sub="u-mgr"):
    return {"Authorization": f"Bearer {make_token(sub=sub, tenant_id=tenant, scopes=[])}"}


async def _seed_proposal(c, tenant=TENANT_A, agent="cust-x-copilot",
                         disposition="escalate_fraud_review"):
    from datetime import UTC, datetime
    pid = new_uuid()
    await c.store.create_proposal(Proposal(
        proposal_id=pid, tenant_id=tenant, session_id=new_uuid(), run_id=new_uuid(),
        agent_key=agent, agent_version=1, obo_user="u-77",
        tool_id="case.apply_disposition", tool_version="1.2.0", tier="write-proposal",
        side_effects="reversible",
        args={"case_id": "c-91", "disposition_code": disposition, "severity": "high"},
        rationale="x", affected_urns=[f"wr:{tenant}:case:case/c-91"],
        predicted_effect={"summary": "x", "reversibility": "reversible", "blast_radius": 1},
        expires_at=datetime.fromtimestamp(now().timestamp() + 3600, tz=UTC),
        status="approved"))
    return pid


async def test_mark_outcome_joins_proposal_provenance(client_and_container):
    client, c = client_and_container
    pid = await _seed_proposal(c, disposition="escalate_fraud_review")
    r = await client.post(f"/api/v1/decisions/{pid}/outcome",
                          json={"realized_outcome": "escalate_fraud_review",
                                "note": "SIU confirmed fraud"}, headers=_auth())
    assert r.status_code == 201, r.text
    d = r.json()["data"]
    # decided outcome + producer were joined from the proposal; agreement computed
    assert d["decision_type"] == "case.apply_disposition"
    assert d["producer"] == "cust-x-copilot"
    assert d["decided_outcome"] == "escalate_fraud_review"
    assert d["correct"] is True


async def test_mark_outcome_disagreement(client_and_container):
    client, c = client_and_container
    pid = await _seed_proposal(c, disposition="escalate_fraud_review")
    r = await client.post(f"/api/v1/decisions/{pid}/outcome",
                          json={"realized_outcome": "deny_no_error_found"}, headers=_auth())
    assert r.json()["data"]["correct"] is False


async def test_effectiveness_read(client_and_container):
    client, c = client_and_container
    p1 = await _seed_proposal(c, disposition="escalate_fraud_review")
    p2 = await _seed_proposal(c, disposition="escalate_fraud_review")
    await client.post(f"/api/v1/decisions/{p1}/outcome",
                      json={"realized_outcome": "escalate_fraud_review"}, headers=_auth())
    await client.post(f"/api/v1/decisions/{p2}/outcome",
                      json={"realized_outcome": "deny_no_error_found"}, headers=_auth())
    r = await client.get("/api/v1/decision-effectiveness?by=decision_type", headers=_auth())
    assert r.status_code == 200
    d = r.json()["data"]
    assert d["labeled_decisions"] == 2
    row = d["groups"][0]
    assert row["total"] == 2 and row["correct"] == 1 and row["effectiveness_rate"] == 0.5


async def test_label_annotates_not_mutates_and_upserts(client_and_container):
    client, c = client_and_container
    pid = await _seed_proposal(c)
    await client.post(f"/api/v1/decisions/{pid}/outcome",
                      json={"realized_outcome": "deny_no_error_found"}, headers=_auth())
    # a corrected outcome supersedes (BR-1 annotate; one label per decision)
    await client.post(f"/api/v1/decisions/{pid}/outcome",
                      json={"realized_outcome": "escalate_fraud_review"}, headers=_auth())
    got = await client.get(f"/api/v1/decisions/{pid}/outcome", headers=_auth())
    assert got.json()["data"]["realized_outcome"] == "escalate_fraud_review"
    # the underlying proposal is untouched
    prop = await c.store.get_proposal(TENANT_A, pid)
    assert prop.status == "approved"


async def test_tenant_isolation(client_and_container):
    client, c = client_and_container
    pid = await _seed_proposal(c, tenant=TENANT_A)
    await client.post(f"/api/v1/decisions/{pid}/outcome",
                      json={"realized_outcome": "x", "decision_type": "case.apply_disposition"},
                      headers=_auth(tenant=TENANT_A))
    # TENANT_B sees no labels + cannot read A's
    eff = await client.get("/api/v1/decision-effectiveness", headers=_auth(tenant=TENANT_B))
    assert eff.json()["data"]["labeled_decisions"] == 0
    g = await client.get(f"/api/v1/decisions/{pid}/outcome", headers=_auth(tenant=TENANT_B))
    assert g.status_code == 404


async def test_decision_drift_endpoint(client_and_container):
    client, c = client_and_container
    # 12 correct then 12 incorrect, labeled in that order (the store lists
    # newest-first; the endpoint reverses to chronological so the earlier window
    # is the baseline). Baseline 100% -> recent 0% => a flag.
    for _ in range(12):
        pid = await _seed_proposal(c, disposition="escalate_fraud_review")
        await client.post(f"/api/v1/decisions/{pid}/outcome",
                          json={"realized_outcome": "escalate_fraud_review"}, headers=_auth())
    for _ in range(12):
        pid = await _seed_proposal(c, disposition="escalate_fraud_review")
        await client.post(f"/api/v1/decisions/{pid}/outcome",
                          json={"realized_outcome": "deny_no_error_found"}, headers=_auth())
    r = await client.get("/api/v1/decision-drift?min_scored=10", headers=_auth())
    assert r.status_code == 200, r.text
    sigs = r.json()["data"]["signals"]
    assert len(sigs) == 1
    assert sigs[0]["key"] == "case.apply_disposition"
    assert sigs[0]["baseline_rate"] > sigs[0]["recent_rate"]


async def test_sft_enrichment_endpoint(client_and_container):
    client, c = client_and_container
    pid = await _seed_proposal(c, disposition="escalate_fraud_review")
    await client.post(f"/api/v1/decisions/{pid}/outcome",
                      json={"realized_outcome": "escalate_fraud_review"}, headers=_auth())
    r = await client.get(f"/api/v1/decisions/{pid}/sft-enrichment", headers=_auth())
    assert r.status_code == 200, r.text
    d = r.json()["data"]
    assert d["outcome"] == "correct" and d["sample_weight"] == 1.0 and d["decision_ref"] == pid
    # a decision with no label yet -> 404
    missing = await client.get("/api/v1/decisions/nope/sft-enrichment", headers=_auth())
    assert missing.status_code == 404
