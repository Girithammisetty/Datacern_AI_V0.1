"""Integration (real Postgres + FORCE RLS): the BRD 74 D3 `q` filter on
GET /experiments and GET /models is real SQL — `ILIKE … ESCAPE '\\'` — so a term
containing a LIKE metacharacter matches literally, and another tenant running
the same search sees nothing."""

from __future__ import annotations

import uuid

import pytest

from tests.conftest import (
    PIPE_FE,
    PIPE_MODEL,
    PIPE_TRAIN,
    TENANT_A,
    TENANT_B,
    WORKSPACE,
    auth,
    ctx_for,
    make_experiment,
    seed_finished_run,
)

pytestmark = pytest.mark.integration


async def _create(client, name, description=None, tenant=TENANT_A):
    body = {"workspace_id": WORKSPACE, "name": name, "model_type": "classification",
            "model_pipeline_urn": PIPE_MODEL, "feature_engineering_pipeline_urn": PIPE_FE,
            "training_pipeline_urn": PIPE_TRAIN}
    if description is not None:
        body["description"] = description
    resp = await client.post("/api/v1/experiments", json=body, headers=auth(tenant))
    assert resp.status_code == 201, resp.text
    return resp.json()["data"]["name"]


async def test_experiment_q_is_real_sql(client):
    tag = uuid.uuid4().hex[:6]
    needle = f"denial{tag}"
    by_name = await _create(client, f"Denial{tag} rate")
    by_desc = await _create(client, f"Revenue {tag}", description=f"quarterly DENIAL{tag} mix")
    await _create(client, f"Churn {tag}", description="unrelated")

    resp = await client.get(f"/api/v1/experiments?q={needle}", headers=auth(TENANT_A))
    assert resp.status_code == 200, resp.text
    # Case-insensitive, and matched in the name of one row and the description
    # of another.
    assert {r["name"] for r in resp.json()["data"]} == {by_name, by_desc}

    # `%` is escaped: it matches the character, not "anything".
    pct = await _create(client, f"Coverage 100%{tag}")
    await _create(client, f"Coverage 100pct{tag}")
    resp = await client.get(f"/api/v1/experiments?q=100%25{tag}", headers=auth(TENANT_A))
    assert resp.status_code == 200
    assert {r["name"] for r in resp.json()["data"]} == {pct}

    # `_` is escaped too: an unescaped one would be a single-character wildcard
    # and would also match the "Underxscore" row.
    under = await _create(client, f"Under_score{tag}")
    await _create(client, f"Underxscore{tag}")
    resp = await client.get(f"/api/v1/experiments?q=Under_score{tag}", headers=auth(TENANT_A))
    assert resp.status_code == 200
    assert {r["name"] for r in resp.json()["data"]} == {under}


async def test_experiment_q_is_rls_isolated(client):
    tag = uuid.uuid4().hex[:6]
    await _create(client, f"Denialsecret{tag}")

    resp = await client.get(f"/api/v1/experiments?q=denialsecret{tag}", headers=auth(TENANT_B))
    assert resp.status_code == 200
    assert resp.json()["data"] == []


async def test_model_q_is_real_sql_and_rls_isolated(client, container):
    tag = uuid.uuid4().hex[:6]
    ctx = ctx_for(TENANT_A)
    exp = await make_experiment(container, ctx, name=f"mq-{tag}")
    run = await seed_finished_run(container, ctx, exp.id, mlflow_run_id=f"mqr-{tag}",
                                  metrics={"f1_score": 0.9})
    reg = await container.registry_service.register(
        ctx, exp.id, run.id, {"model_name": f"denial_rate_{tag}"})

    resp = await client.get(f"/api/v1/models?q=denial_rate_{tag}", headers=auth(TENANT_A))
    assert resp.status_code == 200, resp.text
    assert {m["id"] for m in resp.json()["data"]} == {reg["model_id"]}

    other = await client.get(f"/api/v1/models?q=denial_rate_{tag}", headers=auth(TENANT_B))
    assert other.status_code == 200 and other.json()["data"] == []
