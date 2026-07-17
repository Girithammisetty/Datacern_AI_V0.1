"""EXP-FR-014: mirror pipeline-orchestrator's MLflow-registered models into the
local registry so agent-launched trainings gain a promotable model version."""

from __future__ import annotations

from tests.conftest import TENANT_A, TENANT_B, WORKSPACE, ctx_for

_T8 = TENANT_A[:8]


def _mlflow_run(run_id: str, experiment_id: str, *, tenant: str = TENANT_A,
                workspace: str | None = WORKSPACE, family: str = "classification",
                algorithm: str = "xgboost", status: str = "FINISHED") -> dict:
    tags = [{"key": "windrose.tenant_id", "value": tenant},
            {"key": "windrose.family", "value": family},
            {"key": "windrose.algorithm", "value": algorithm},
            {"key": "windrose.template_id", "value": "tmpl-1"}]
    if workspace:
        tags.append({"key": "windrose.workspace_id", "value": workspace})
    return {
        "info": {"run_id": run_id, "experiment_id": experiment_id, "status": status,
                 "start_time": 1_700_000_000_000, "end_time": 1_700_000_100_000,
                 "artifact_uri": f"s3://mlflow/{experiment_id}/{run_id}/artifacts",
                 "run_name": "clumsy-bass-221"},
        "data": {"metrics": [{"key": "accuracy", "value": 0.96, "step": 0,
                              "timestamp": 1_700_000_000_000}],
                 "params": [{"key": "algorithm", "value": algorithm}], "tags": tags},
    }


async def _seed_registered(container, *, name: str, run_id: str, experiment_id: str,
                           **run_kwargs) -> str:
    """Seed a finished MLflow run + a registered model version pointing at it,
    exactly as pipeline-orchestrator leaves the tracking server."""
    mlflow = container.deps.mlflow  # LocalMlflowClient
    mlflow.seed_run(_mlflow_run(run_id, experiment_id, **run_kwargs))
    await mlflow.ensure_registered_model(name)
    return await mlflow.create_model_version(name, f"models:/m-{run_id}", run_id)


async def test_mirror_creates_experiment_run_and_version(container):
    ctx = ctx_for()
    name = f"wr_{_T8}_ml-engineer_xgboost"
    version = await _seed_registered(
        container, name=name, run_id="mlrun-abc", experiment_id="49")
    assert version == "1"

    created = await container.mirror_service.mirror_registered_model_version(ctx, name, "1")
    assert created is True

    # a local experiment container now exists for the orphan MLflow experiment
    page = await container.experiment_service.list(ctx, WORKSPACE, 50, None)
    assert any(e.mlflow_experiment_id == "49" for e in page.items)

    # the model + version are in the authoritative registry, in the run's workspace
    models = await container.registry_service.list_models(ctx, None, None, 50, None)
    assert [m["name"] for m in models.items] == [name]
    model_id = models.items[0]["id"]
    detail = await container.registry_service.get_model(ctx, model_id)
    v = detail["versions"][0]
    # the read payload exposes the MLflow run id so the agent resolver can match
    assert v["mlflow_run_id"] == "mlrun-abc"
    assert v["stage"] == "none"


async def test_mirror_is_idempotent(container):
    ctx = ctx_for()
    name = f"wr_{_T8}_repeat"
    await _seed_registered(container, name=name, run_id="mlrun-rep", experiment_id="50")
    assert await container.mirror_service.mirror_registered_model_version(ctx, name, "1") is True
    # re-running the mirror does not create a duplicate version
    assert await container.mirror_service.mirror_registered_model_version(ctx, name, "1") is False
    models = await container.registry_service.list_models(ctx, None, None, 50, None)
    detail = await container.registry_service.get_model(ctx, models.items[0]["id"])
    assert len(detail["versions"]) == 1


async def test_mirror_skips_other_tenants_run(container):
    """Guard the RLS wall: a run whose windrose.tenant_id is a different tenant is
    never mirrored under this tenant, even if the registry name prefix matches."""
    ctx = ctx_for()  # TENANT_A
    name = f"wr_{_T8}_cross"
    await _seed_registered(container, name=name, run_id="mlrun-x", experiment_id="51",
                           tenant=TENANT_B)
    assert await container.mirror_service.mirror_registered_model_version(ctx, name, "1") is False
    models = await container.registry_service.list_models(ctx, None, None, 50, None)
    assert models.items == []


async def test_mirror_tenant_registry_discovers_by_prefix(container):
    ctx = ctx_for()
    ours = f"wr_{_T8}_owned"
    await _seed_registered(container, name=ours, run_id="mlrun-own", experiment_id="60")
    # a different tenant's model must not be discovered for us
    await _seed_registered(container, name=f"wr_{TENANT_B[:8]}_theirs",
                           run_id="mlrun-oth", experiment_id="61", tenant=TENANT_B)

    mirrored = await container.mirror_service.mirror_tenant_registry(ctx)
    assert mirrored == [f"{ours} v1"]


async def test_mirrored_version_is_promotable(container):
    """End-to-end: the mirrored version can be promoted (four-eyes pending)."""
    ctx = ctx_for()
    name = f"wr_{_T8}_promote_me"
    await _seed_registered(container, name=name, run_id="mlrun-pm", experiment_id="70")
    await container.mirror_service.mirror_registered_model_version(ctx, name, "1")

    models = await container.registry_service.list_models(ctx, None, None, 50, None)
    model_id = models.items[0]["id"]
    result = await container.promotion_service.promote(
        ctx, model_id, 1, {"target_stage": "staging", "rationale": "great f1"})
    assert result["status"] == "pending"


async def test_sweep_tenant_includes_mirrored_models(container):
    ctx = ctx_for()
    name = f"wr_{_T8}_via_sweep"
    await _seed_registered(container, name=name, run_id="mlrun-sw", experiment_id="80")
    result = await container.reconciliation_service.sweep_tenant(ctx.tenant_id)
    assert result["mirrored_models"] == [f"{name} v1"]
    models = await container.registry_service.list_models(ctx, None, None, 50, None)
    assert [m["name"] for m in models.items] == [name]
