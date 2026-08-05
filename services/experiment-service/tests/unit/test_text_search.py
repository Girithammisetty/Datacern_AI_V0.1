"""BRD 74 D3 — text search on the experiment and registered-model lists.

experiment-service had no `q` of any kind before this increment, which is why
the cross-service search fan-out could not reach experiments or models. `q` is a
case-insensitive contains over the row's own name + description, applied in
Postgres (`ILIKE … ESCAPE '\\'`) and cursor-paged like the rest of the list.
"""

from __future__ import annotations

from app.utils import like_contains
from tests.conftest import (
    PIPE_FE,
    PIPE_MODEL,
    PIPE_TRAIN,
    TENANT_B,
    WORKSPACE,
    auth,
    ctx_for,
    make_experiment,
    seed_finished_run,
)


async def _create(client, name, description=None, tenant=None):
    body = {"workspace_id": WORKSPACE, "name": name, "model_type": "classification",
            "model_pipeline_urn": PIPE_MODEL, "feature_engineering_pipeline_urn": PIPE_FE,
            "training_pipeline_urn": PIPE_TRAIN}
    if description is not None:
        body["description"] = description
    headers = auth(tenant) if tenant else auth()
    resp = await client.post("/api/v1/experiments", json=body, headers=headers)
    assert resp.status_code == 201, resp.text
    return resp.json()["data"]["id"]


async def _names(client, url, headers=None):
    resp = await client.get(url, headers=headers or auth())
    assert resp.status_code == 200, resp.text
    return [row["name"] for row in resp.json()["data"]]


# ---- like_contains -----------------------------------------------------------

def test_like_contains_escapes_metacharacters():
    assert like_contains("denial") == "%denial%"
    assert like_contains("100%") == "%100\\%%"
    assert like_contains("a_b") == "%a\\_b%"
    assert like_contains("back\\slash") == "%back\\\\slash%"


# ---- experiments -------------------------------------------------------------

async def test_experiment_q_matches_name_and_description(client):
    await _create(client, "Denial rate classifier")
    await _create(client, "Revenue forecaster", description="quarterly DENIAL trend")
    await _create(client, "Churn model", description="unrelated")

    names = await _names(client, "/api/v1/experiments?q=denial")
    assert sorted(names) == ["Denial rate classifier", "Revenue forecaster"]


async def test_experiment_q_is_case_insensitive(client):
    await _create(client, "Denial rate classifier")
    for needle in ("denial", "DENIAL", "DeNiAl"):
        assert await _names(client, f"/api/v1/experiments?q={needle}") == [
            "Denial rate classifier"]


async def test_experiment_q_treats_like_metacharacters_literally(client):
    await _create(client, "Coverage 100% model")
    await _create(client, "Coverage partial model")

    assert await _names(client, "/api/v1/experiments?q=100%25") == ["Coverage 100% model"]
    # A bare underscore would be a single-character wildcard if unescaped.
    assert await _names(client, "/api/v1/experiments?q=e_m") == []


async def test_experiment_q_is_cursor_paged(client):
    for i in range(3):
        await _create(client, f"Denial model {i}")
    await _create(client, "Unrelated model")

    seen: list[str] = []
    url = "/api/v1/experiments?q=denial&limit=1"
    for _ in range(5):
        resp = await client.get(url, headers=auth())
        assert resp.status_code == 200, resp.text
        body = resp.json()
        seen.extend(row["name"] for row in body["data"])
        if not body["page"]["has_more"]:
            break
        url = f"/api/v1/experiments?q=denial&limit=1&cursor={body['page']['next_cursor']}"
    assert sorted(seen) == ["Denial model 0", "Denial model 1", "Denial model 2"]


async def test_experiment_q_applies_to_the_archived_list_too(client):
    exp_id = await _create(client, "Denial legacy")
    await _create(client, "Denial live")
    assert (await client.delete(f"/api/v1/experiments/{exp_id}",
                                headers=auth())).status_code == 200

    assert await _names(client, "/api/v1/experiments?q=denial") == ["Denial live"]
    assert await _names(client, "/api/v1/experiments/list_archived?q=denial") == ["Denial legacy"]


async def test_experiment_q_is_tenant_isolated(client):
    await _create(client, "Denial rate classifier")
    # Tenant B runs the same search and sees nothing of tenant A's.
    assert await _names(client, "/api/v1/experiments?q=denial", headers=auth(TENANT_B)) == []


async def test_experiment_q_composes_with_the_workspace_filter(client):
    await _create(client, "Denial rate classifier")
    other_ws = "44444444-4444-4444-8444-444444444444"
    assert await _names(
        client, f"/api/v1/experiments?q=denial&filter[workspace_id]={other_ws}") == []
    assert await _names(
        client, f"/api/v1/experiments?q=denial&filter[workspace_id]={WORKSPACE}") == [
        "Denial rate classifier"]


# ---- registered models -------------------------------------------------------

async def _register(container, ctx, exp_id, mlflow_run_id, model_name):
    run = await seed_finished_run(container, ctx, exp_id, mlflow_run_id=mlflow_run_id,
                                  metrics={"f1_score": 0.9})
    return await container.registry_service.register(
        ctx, exp_id, run.id, {"model_name": model_name})


async def test_model_q_filters_the_registry(client, container):
    ctx = ctx_for()
    exp = await make_experiment(container, ctx, name="registry-q")
    await _register(container, ctx, exp.id, "mq0", "denial_rate_v1")
    await _register(container, ctx, exp.id, "mq1", "churn_v1")

    assert await _names(client, "/api/v1/models?q=denial") == ["denial_rate_v1"]
    assert await _names(client, "/api/v1/models?q=DENIAL") == ["denial_rate_v1"]
    assert await _names(client, "/api/v1/models?q=nothing-here") == []


async def test_model_q_is_tenant_isolated(client, container):
    ctx = ctx_for()
    exp = await make_experiment(container, ctx, name="registry-q-iso")
    await _register(container, ctx, exp.id, "mqi0", "denial_rate_iso")

    assert await _names(client, "/api/v1/models?q=denial", headers=auth(TENANT_B)) == []


async def test_model_q_composes_with_the_id_filter(client, container):
    ctx = ctx_for()
    exp = await make_experiment(container, ctx, name="registry-q-ids")
    a = await _register(container, ctx, exp.id, "mqc0", "denial_rate_a")
    await _register(container, ctx, exp.id, "mqc1", "denial_rate_b")

    assert await _names(
        client, f"/api/v1/models?q=denial&filter[id]={a['model_id']}") == ["denial_rate_a"]
