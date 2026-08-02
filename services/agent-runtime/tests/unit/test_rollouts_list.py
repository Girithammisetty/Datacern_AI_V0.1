"""GET /registry/rollouts — the live-rollout-state read the BFF's
AgentFleetRollout enum needs (without it CANARY/SHADOW resolve to UNKNOWN).
Exercises the list itself (newest first), the agent_key/status/cell filters and
the route-level authz (ai.agent.read — operator or tenant admin, same bar as
the kill-switch list; rollout WRITES stay operator-only) over the in-memory
store double."""

from __future__ import annotations

import httpx
import pytest

from app.agents.catalog import seed_catalog
from app.container import build_container
from app.main import create_app
from tests.conftest import TENANT_A, make_settings, make_token


class _CapAuthz:
    """Capability-based authz double (P4): control-plane reads authorize on the
    rbac ai.agent.* capability via OPA, not a JWT scope. Models "u-admin holds
    the ai.agent.* capabilities, u-user does not"."""

    async def allow(self, *, subject, action, tenant, resource_urn=None, workspace_id=None):
        return subject.get("id") == "u-admin" and action.startswith("ai.agent.")


@pytest.fixture
async def client_and_container():
    c = build_container(make_settings(), mode="memory", authz=_CapAuthz())
    await seed_catalog(c.store, c.signing_key)
    app = create_app(c)
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        yield client, c


def _auth(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def _admin() -> str:
    # No JWT scope — authorization comes from the rbac capability double.
    return make_token(sub="u-admin", tenant_id=TENANT_A, scopes=[])


def _user() -> str:
    return make_token(sub="u-user", tenant_id=TENANT_A, scopes=[])


def _operator() -> str:
    return make_token(sub="svc:ops", tenant_id=TENANT_A, typ="service", scopes=["operator"])


async def _create(client, *, agent_key: str, mode: str = "canary", cell: str = "prod-1",
                  pct: int = 10) -> str:
    r = await client.post("/api/v1/registry/rollouts", headers=_auth(_operator()),
                          json={"agent_key": agent_key, "cell": cell, "mode": mode,
                                "candidate_version": 2, "baseline_version": 1, "pct": pct})
    assert r.status_code == 200, r.text
    return r.json()["data"]["rollout_id"]


async def test_list_returns_created_rollouts_newest_first(client_and_container):
    client, _ = client_and_container
    first = await _create(client, agent_key="case-triage", mode="canary")
    second = await _create(client, agent_key="analytics", mode="shadow")

    r = await client.get("/api/v1/registry/rollouts", headers=_auth(_admin()))
    assert r.status_code == 200, r.text
    rows = r.json()["data"]
    assert [row["rollout_id"] for row in rows] == [second, first]  # newest first
    row = next(row for row in rows if row["rollout_id"] == first)
    # Full Rollout shape, snake_case like the neighbouring registry views.
    assert row == {"rollout_id": first, "agent_key": "case-triage", "cell": "prod-1",
                   "mode": "canary", "candidate_version": 2, "baseline_version": 1,
                   "pct": 10, "tenant_filter": {}, "status": "active"}


async def test_list_filters_by_agent_key_status_and_cell(client_and_container):
    client, _ = client_and_container
    triage = await _create(client, agent_key="case-triage", cell="prod-1")
    analytics = await _create(client, agent_key="analytics", cell="prod-2")
    r = await client.post(f"/api/v1/registry/rollouts/{analytics}/rollback",
                          headers=_auth(_operator()))
    assert r.status_code == 200

    r = await client.get("/api/v1/registry/rollouts", params={"agent_key": "case-triage"},
                         headers=_auth(_admin()))
    assert [row["rollout_id"] for row in r.json()["data"]] == [triage]

    r = await client.get("/api/v1/registry/rollouts", params={"status": "rolled_back"},
                         headers=_auth(_admin()))
    assert [row["rollout_id"] for row in r.json()["data"]] == [analytics]

    r = await client.get("/api/v1/registry/rollouts", params={"cell": "prod-2"},
                         headers=_auth(_admin()))
    assert [row["rollout_id"] for row in r.json()["data"]] == [analytics]

    # Filters compose; a non-matching combination is an empty list, not an error.
    r = await client.get("/api/v1/registry/rollouts",
                         params={"agent_key": "case-triage", "status": "rolled_back"},
                         headers=_auth(_admin()))
    assert r.json()["data"] == []


async def test_list_allows_operator(client_and_container):
    client, _ = client_and_container
    rollout_id = await _create(client, agent_key="case-triage")
    r = await client.get("/api/v1/registry/rollouts", headers=_auth(_operator()))
    assert r.status_code == 200
    assert any(row["rollout_id"] == rollout_id for row in r.json()["data"])


async def test_list_requires_operator_or_tenant_admin(client_and_container):
    client, _ = client_and_container
    r = await client.get("/api/v1/registry/rollouts", headers=_auth(_user()))
    assert r.status_code == 403
