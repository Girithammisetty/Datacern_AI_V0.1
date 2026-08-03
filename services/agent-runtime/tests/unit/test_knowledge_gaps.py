"""Knowledge Spine WS5 — the missing-knowledge steward queue.

Humans already record "what knowledge was missing" when deciding a proposal
(the 4th Agent-in-the-Loop signal, joined onto the transcript). WS5 surfaces
those signals as a queue (GET /knowledge-gaps) a steward can turn into governed
ontology proposals — the self-improving spine. Only transcripts that actually
carry the signal appear; the projection exposes the gap + provenance, never the
full transcript body.
"""

from __future__ import annotations

import datetime as dt

import httpx
import pytest

from app.container import build_container
from app.domain.entities import Transcript, new_uuid
from app.main import create_app
from tests.conftest import TENANT_A, TENANT_B, make_settings, make_token


@pytest.fixture
async def client_and_container():
    c = build_container(make_settings(), mode="memory")
    app = create_app(c)
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        yield client, c


def _auth(tenant=TENANT_A) -> dict:
    tok = make_token(sub="steward-1", tenant_id=tenant, scopes=["tenant.admin"])
    return {"Authorization": f"Bearer {tok}"}


def _transcript(tenant: str, *, feedback: dict | None, decided_at=None) -> Transcript:
    return Transcript(
        transcript_id=new_uuid(), tenant_id=tenant, run_id=new_uuid(),
        session_id=None, agent_key="case-triage", agent_version=2,
        principal_type="user_obo", obo_sub="analyst-1", inputs={}, grounding={},
        final_text=None, proposed_action=None, proposal_id=new_uuid(),
        model="m", usage={}, consent=True,
        decision="reject" if feedback else None, corrected_output=None,
        decided_by="analyst-1" if feedback else None, decided_at=decided_at,
        feedback=feedback)


async def test_lists_only_transcripts_with_the_missing_knowledge_signal(client_and_container):
    client, c = client_and_container
    t0 = dt.datetime(2026, 8, 1, tzinfo=dt.UTC)
    # A gap, an ordinary decided transcript, and an undecided one.
    gap = _transcript(TENANT_A, feedback={
        "adoption": "reject", "preference": "rejected",
        "missing_knowledge": "the policy exclusion for cosmetic claims",
        "knowledge_relevance": "irrelevant"}, decided_at=t0)
    plain = _transcript(TENANT_A, feedback={"adoption": "approve", "preference": "adopted"},
                        decided_at=t0)
    undecided = _transcript(TENANT_A, feedback=None)
    for t in (gap, plain, undecided):
        await c.store.record_transcript(t)

    r = await client.get("/api/v1/knowledge-gaps", headers=_auth())
    assert r.status_code == 200, r.text
    rows = r.json()["data"]
    assert len(rows) == 1
    assert rows[0]["transcript_id"] == gap.transcript_id
    assert rows[0]["missing_knowledge"] == "the policy exclusion for cosmetic claims"
    assert rows[0]["knowledge_relevance"] == "irrelevant"
    assert rows[0]["adoption"] == "reject"
    assert rows[0]["agent_key"] == "case-triage"
    assert rows[0]["decided_by"] == "analyst-1"
    # The queue is a projection — no transcript body (inputs/grounding) leaks.
    assert "inputs" not in rows[0] and "grounding" not in rows[0]


async def test_gaps_are_tenant_scoped_and_newest_first(client_and_container):
    client, c = client_and_container
    older = _transcript(TENANT_A, feedback={"adoption": "reject", "missing_knowledge": "old gap"},
                        decided_at=dt.datetime(2026, 7, 1, tzinfo=dt.UTC))
    newer = _transcript(TENANT_A, feedback={"adoption": "edit", "missing_knowledge": "new gap"},
                        decided_at=dt.datetime(2026, 8, 1, tzinfo=dt.UTC))
    foreign = _transcript(
        TENANT_B, feedback={"adoption": "reject", "missing_knowledge": "not yours"},
        decided_at=dt.datetime(2026, 8, 2, tzinfo=dt.UTC))
    for t in (older, newer, foreign):
        await c.store.record_transcript(t)

    r = await client.get("/api/v1/knowledge-gaps", headers=_auth())
    gaps = [g["missing_knowledge"] for g in r.json()["data"]]
    assert gaps == ["new gap", "old gap"]  # newest decision first, no foreign rows
