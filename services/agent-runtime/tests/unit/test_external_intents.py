"""BRD 60 WS1: governed external-agent write ingress (POST /external/v1/intents).

Drives the REAL route through the REAL ProposalService (in-memory container, no
mocks): an external agent's proposed write is forced through the same four-eyes
+ guardrail rails an internal agent uses, and can only ever become a pending
proposal — never an inline write.
"""

from __future__ import annotations

import time

import httpx
import jwt as pyjwt
import pytest

from app.container import build_container
from app.domain.entities import AgentVersion
from app.main import create_app
from tests.conftest import TENANT_A, TEST_PRIV, make_settings, make_token


@pytest.fixture
async def client_and_container():
    c = build_container(make_settings(), mode="memory")
    # A registered EXTERNAL agent version whose declared toolset is the enforced
    # allow-list (this is what makes a customer agent's tools "real").
    await c.store.create_agent_version(AgentVersion(
        agent_key="acme-bot", version=1, graph_ref="external", graph_digest="x",
        toolset=[{"tool_id": "case.apply_disposition"}], status="published"))
    app = create_app(c)
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        yield client, c


def _agent_token(*, agent_id="acme-bot", version="1", obo_sub="u-77",
                 typ="agent_obo", tenant=TENANT_A) -> str:
    now = int(time.time())
    claims = {
        "iss": "https://identity.datacern.local", "aud": "datacern",
        "sub": f"agent:{agent_id}@{version}", "tenant_id": tenant, "typ": typ,
        "scopes": [], "iat": now, "exp": now + 3600,
        "agent_id": agent_id, "agent_version": version,
    }
    if obo_sub:
        claims["obo_sub"] = obo_sub
    return pyjwt.encode(claims, TEST_PRIV, algorithm="RS256")


def _auth(**kw):
    return {"Authorization": f"Bearer {_agent_token(**kw)}"}


_VALID = {
    "tool_id": "case.apply_disposition", "tool_version": "1.0.0",
    "tier": "write-proposal", "side_effects": "reversible",
    "args": {"case_id": "c-91", "severity": "high", "assignee_id": "u-dana"},
    "rationale": "Vendor pattern matches 14 resolved cases.",
    "affected_urns": [f"wr:{TENANT_A}:case:case/c-91"],
    "predicted_effect": {"summary": "assign + severity high"},
}


async def test_external_intent_creates_pending_proposal(client_and_container):
    client, c = client_and_container
    r = await client.post("/external/v1/intents", json=_VALID, headers=_auth())
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["executed"] is False  # propose-only, ALWAYS
    prop = body["data"]
    assert prop["status"] == "pending"
    # via_agent attribution: the proposal records WHICH agent acted.
    assert prop["agent_key"] == "acme-bot" and prop["agent_version"] == 1
    # anti-laundering: the agent's own summary is demoted, effect is server-derived.
    assert prop["predicted_effect"]["agent_summary"] == "assign + severity high"
    assert "case.apply_disposition" in prop["predicted_effect"]["authoritative_summary"]
    # it landed in the real four-eyes inbox.
    pending = await c.store.list_proposals(TENANT_A, status="pending")
    assert any(p.proposal_id == prop["id"] for p in pending)


async def test_external_write_never_auto_executes(client_and_container):
    client, _ = client_and_container
    # A reversible, low-risk, single-URN write — exactly the shape a tenant
    # auto-execute policy would fast-path for an INTERNAL graph run. The
    # external ingress passes an empty policy unconditionally, so it can never
    # auto-execute: it always stays pending for a human. (Governance stance:
    # the auto-execute fast-path is denied to external callers entirely.)
    r = await client.post("/external/v1/intents", json=_VALID, headers=_auth())
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["executed"] is False
    assert body["data"]["status"] == "pending"


async def test_external_intent_rejects_tool_off_allowlist(client_and_container):
    client, _ = client_and_container
    off = {**_VALID, "tool_id": "case.delete_everything"}
    r = await client.post("/external/v1/intents", json=off, headers=_auth())
    assert r.status_code == 403, r.text
    assert r.json()["error"]["code"] == "GUARDRAIL_VIOLATION"


async def test_external_intent_rejects_above_tier_ceiling(client_and_container):
    client, _ = client_and_container
    # write-direct is above the write-proposal ceiling: an external agent can
    # NEVER get a direct write, only a proposal.
    direct = {**_VALID, "tier": "write-direct"}
    r = await client.post("/external/v1/intents", json=direct, headers=_auth())
    assert r.status_code == 403, r.text
    assert r.json()["error"]["code"] == "GUARDRAIL_VIOLATION"


async def test_external_intent_requires_agent_principal(client_and_container):
    client, _ = client_and_container
    # A raw USER token is refused: this endpoint is only for agent identities.
    user_tok = make_token(sub="u-77", tenant_id=TENANT_A, typ="user")
    r = await client.post("/external/v1/intents", json=_VALID,
                          headers={"Authorization": f"Bearer {user_tok}"})
    assert r.status_code == 403, r.text
    assert r.json()["error"]["code"] == "PERMISSION_DENIED"


async def test_external_proposal_blocks_self_approval_when_high_risk(client_and_container):
    client, c = client_and_container
    # A destructive (high-risk) external write, proposed on behalf of u-77.
    risky = {**_VALID, "side_effects": "destructive"}
    r = await client.post("/external/v1/intents", json=risky, headers=_auth(obo_sub="u-77"))
    assert r.status_code == 200, r.text
    pid = r.json()["data"]["id"]
    # u-77 (the on-behalf-of user) cannot rubber-stamp their own agent's
    # high-risk write, even if the tenant allows self-approval — four-eyes binds
    # external proposals exactly as it binds internal ones.
    with pytest.raises(Exception) as ei:
        await c.proposal_service.decide(
            tenant_id=TENANT_A, proposal_id=pid, actor_sub="u-77",
            action="approve", self_approval_allowed=True)
    assert "distinct approver" in str(ei.value)


async def test_external_intent_rejects_unregistered_agent(client_and_container):
    client, _ = client_and_container
    # An external token whose agent_id is NOT registered (no agent_version row,
    # hence no declared toolset). For the less-trusted external boundary an
    # absent allow-list must be DENY-ALL, not allow-all: the ingress fails closed
    # before any run/proposal exists (BRD 60 allow-list defense-in-depth).
    r = await client.post("/external/v1/intents", json=_VALID,
                          headers=_auth(agent_id="ghost-bot"))
    assert r.status_code == 403, r.text
    assert r.json()["error"]["code"] == "GUARDRAIL_VIOLATION"


async def test_external_intent_rejects_empty_toolset_agent(client_and_container):
    client, c = client_and_container
    # A registered external agent whose declared toolset is EMPTY. Same deny-all
    # stance: without an allow-list an external agent may not propose anything,
    # so the empty-toolset skip in _enforce_guardrail can never open the surface.
    await c.store.create_agent_version(AgentVersion(
        agent_key="empty-bot", version=1, graph_ref="external", graph_digest="x",
        toolset=[], status="published"))
    r = await client.post("/external/v1/intents", json=_VALID,
                          headers=_auth(agent_id="empty-bot"))
    assert r.status_code == 403, r.text
    assert r.json()["error"]["code"] == "GUARDRAIL_VIOLATION"


async def test_external_intent_validates_body(client_and_container):
    client, _ = client_and_container
    bad = {k: v for k, v in _VALID.items() if k != "affected_urns"}
    r = await client.post("/external/v1/intents", json=bad, headers=_auth())
    assert r.status_code == 422, r.text
    assert r.json()["error"]["code"] == "VALIDATION_FAILED"
