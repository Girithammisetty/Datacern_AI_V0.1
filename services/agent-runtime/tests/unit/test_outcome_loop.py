"""Closing the outcome loop (OM inbound / DM-FR-011).

Proves the AUTOMATED path: a realized outcome arrives from the system of record
keyed by a business entity URN (not our internal decision id), resolves to the
actioned decision that produced it, records a label_source=sor label with
agreement computed against what was decided, and then flows — with no further
call — into BOTH decision effectiveness and SFT curation weighting. Unmatched
keys are reported honestly; re-ingest is idempotent; tenants are isolated.
"""
from __future__ import annotations

from datetime import UTC, datetime

import httpx
import pytest

from app.container import build_container
from app.domain.entities import Proposal, new_uuid, now
from app.domain.outcomes import effectiveness, sft_enrichment
from app.main import create_app
from tests.conftest import TENANT_A, TENANT_B, make_settings, make_token


class _AllowAuthz:
    async def allow(self, **_):
        return True


@pytest.fixture
async def client_and_container():
    c = build_container(make_settings(), mode="memory", authz=_AllowAuthz())
    app = create_app(c)
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        yield client, c


def _auth(tenant=TENANT_A, sub="svc:outcome-feed"):
    return {"Authorization": f"Bearer {make_token(sub=sub, tenant_id=tenant, scopes=[])}"}


async def _seed_decision(c, *, tenant=TENANT_A, case="c-91", disposition="deny",
                         status="approved", tool="case.apply_disposition"):
    pid = new_uuid()
    await c.store.create_proposal(Proposal(
        proposal_id=pid, tenant_id=tenant, session_id=new_uuid(), run_id=new_uuid(),
        agent_key="cust-x-copilot", agent_version=1, obo_user="u-77",
        tool_id=tool, tool_version="1.2.0", tier="write-proposal",
        side_effects="reversible",
        args={"case_id": case, "disposition_code": disposition, "severity": "high"},
        rationale="x", affected_urns=[f"wr:{tenant}:case:case/{case}"],
        predicted_effect={"summary": "x", "reversibility": "reversible", "blast_radius": 1},
        expires_at=datetime.fromtimestamp(now().timestamp() + 3600, tz=UTC),
        status=status))
    return pid, f"wr:{tenant}:case:case/{case}"


async def test_sor_outcome_resolves_by_business_urn_and_scores(client_and_container):
    client, c = client_and_container
    pid, urn = await _seed_decision(c, disposition="deny")

    # The SoR reports the realized result for the CASE (business entity), not
    # our internal decision id — and it agrees with what was decided ("deny").
    r = await client.post("/api/v1/outcomes/ingest", headers=_auth(), json={
        "outcomes": [{"business_urn": urn, "realized_outcome": "deny"}]})
    assert r.status_code == 200, r.text
    d = r.json()["data"]
    assert d["resolved"] == 1 and d["unmatched"] == []
    lab = d["labels"][0]
    assert lab["decision_ref"] == pid
    assert lab["label_source"] == "sor"
    assert lab["correct"] is True          # decided "deny" == realized "deny"

    # ...and it flows into effectiveness with no extra call.
    eff = (await client.get("/api/v1/decision-effectiveness", headers=_auth())).json()["data"]
    assert eff["labeled_decisions"] == 1
    assert eff["groups"][0]["correct"] == 1


async def test_incorrect_realized_outcome_downweights_the_corpus(client_and_container):
    client, c = client_and_container
    _, urn = await _seed_decision(c, disposition="approve")

    # Decided "approve" but the real world said "deny" — a wrong decision.
    r = await client.post("/api/v1/outcomes/ingest", headers=_auth(), json={
        "outcomes": [{"business_urn": urn, "realized_outcome": "deny"}]})
    lab_view = r.json()["data"]["labels"][0]
    assert lab_view["correct"] is False

    # The SFT curator would down-weight this transcript (negative → not imitated).
    labels = await c.store.list_outcome_labels(TENANT_A)
    enr = sft_enrichment(labels[0])
    assert enr["outcome"] == "incorrect"
    assert enr["sample_weight"] == 0.0


async def test_unmatched_business_key_is_reported_not_fabricated(client_and_container):
    client, _ = client_and_container
    r = await client.post("/api/v1/outcomes/ingest", headers=_auth(), json={
        "outcomes": [{"business_urn": "wr:t:case:case/never-decided",
                      "realized_outcome": "deny"}]})
    d = r.json()["data"]
    assert d["resolved"] == 0
    assert d["unmatched"] == [{"business_urn": "wr:t:case:case/never-decided",
                               "reason": "no_actioned_decision"}]


async def test_rejected_decision_is_not_scored(client_and_container):
    client, c = client_and_container
    # A REJECTED proposal took no action — a SoR outcome is not its realized result.
    _, urn = await _seed_decision(c, status="rejected")
    r = await client.post("/api/v1/outcomes/ingest", headers=_auth(), json={
        "outcomes": [{"business_urn": urn, "realized_outcome": "deny"}]})
    assert r.json()["data"]["resolved"] == 0


async def test_decision_type_narrows_to_one_tool(client_and_container):
    client, c = client_and_container
    # Same case carried two actioned decisions; the SoR outcome pertains to one.
    await _seed_decision(c, case="c-5", tool="case.apply_disposition")
    await _seed_decision(c, case="c-5", tool="case.assign")
    urn = f"wr:{TENANT_A}:case:case/c-5"
    r = await client.post("/api/v1/outcomes/ingest", headers=_auth(), json={
        "outcomes": [{"business_urn": urn, "realized_outcome": "deny",
                      "decision_type": "case.apply_disposition"}]})
    d = r.json()["data"]
    assert d["resolved"] == 1
    assert d["labels"][0]["decision_type"] == "case.apply_disposition"


async def test_reingest_is_idempotent(client_and_container):
    client, c = client_and_container
    _, urn = await _seed_decision(c)
    body = {"outcomes": [{"business_urn": urn, "realized_outcome": "deny"}]}
    await client.post("/api/v1/outcomes/ingest", headers=_auth(), json=body)
    await client.post("/api/v1/outcomes/ingest", headers=_auth(), json=body)
    labels = await c.store.list_outcome_labels(TENANT_A)
    assert len(labels) == 1  # one decision → one label, re-ingest annotates not duplicates


async def test_tenant_isolation(client_and_container):
    client, c = client_and_container
    _, urn_a = await _seed_decision(c, tenant=TENANT_A)
    await client.post("/api/v1/outcomes/ingest", headers=_auth(tenant=TENANT_A),
                      json={"outcomes": [{"business_urn": urn_a, "realized_outcome": "deny"}]})
    # Tenant B ingesting A's business urn resolves nothing (RLS-scoped lookup).
    r = await client.post("/api/v1/outcomes/ingest", headers=_auth(tenant=TENANT_B),
                          json={"outcomes": [{"business_urn": urn_a,
                                              "realized_outcome": "deny"}]})
    assert r.json()["data"]["resolved"] == 0
    assert len(await c.store.list_outcome_labels(TENANT_B)) == 0
