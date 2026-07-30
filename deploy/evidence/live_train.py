"""LIVE local ML workflow: template -> run -> REAL sklearn fit -> REAL MLflow
tracking + model registry (sqlite, no server) -> read the registered model back.
Nothing faked: the container gets NO executor/mlflow overrides, so the real
LocalTrainingExecutor and real MlflowGateway are wired, exactly as in app.main.
"""
import asyncio
import sys
import tempfile
from pathlib import Path

import httpx

sys.path.insert(0, ".")
from app.container import build_container  # noqa: E402
from tests.conftest import TENANT_A, auth, make_settings  # noqa: E402


async def main():
    tmp = Path(tempfile.mkdtemp(prefix="dc-live-"))
    mlflow_uri = f"sqlite:///{tmp}/mlflow.db"
    settings = make_settings(tmp, mlflow_tracking_uri=mlflow_uri)
    # NO executor= / mlflow= overrides -> REAL LocalTrainingExecutor + MlflowGateway.
    c = build_container(settings, mode="memory")
    c.schedule_drive = lambda *a, **k: None  # drive explicitly below

    rows = []
    for i in range(400):
        fraud = i % 3 == 0
        rows.append({"amount": 5000 + i * 7 if fraud else 40 + i % 60,
                     "prior_disputes": 4 if fraud else i % 2,
                     "label": "fraud" if fraud else "ok"})

    from app.main import create_app
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=create_app(c)),
                                 base_url="http://test") as cl:
        r = await cl.post("/api/v1/algorithm-templates/random_forest/pipelines",
                          json={"workspace_id": "33333333-3333-4333-8333-333333333333",
                                "mode": "train",
                                "dataset_refs": {"TRAIN": "wr:t:dataset:dataset/claims"},
                                "parameters": {"label_column": "label"},
                                "name": "fraud-rf-live"}, headers=auth())
        assert r.status_code == 201, r.text
        tid = r.json()["data"]["id"]

        r = await cl.post(f"/api/v1/pipelines/{tid}/run",
                          json={"run_parameters": {"training_data": rows,
                                                   "label_column": "label",
                                                   "n_estimators": 30}},
                          headers=auth())
        assert r.status_code == 202, r.text
        run_id = r.json()["data"]["id"]

        final = await c.run_service.drive_run(TENANT_A, run_id)
        got = (await cl.get(f"/api/v1/runs/{run_id}", headers=auth())).json()["data"]

    print("run_status :", got["status"])
    print("model_uri  :", got["model_uri"])
    print("metrics    :", {k: round(v, 4) for k, v in (got["metrics"] or {}).items()
                           if k in ("accuracy", "f1_weighted", "roc_auc", "train_rows")})
    assert got["status"] == "succeeded", got

    # Independent verification straight from the MLflow registry (same sqlite).
    from mlflow.tracking import MlflowClient
    mc = MlflowClient(tracking_uri=mlflow_uri)
    rms = mc.search_registered_models()
    assert rms, "no registered model in the registry"
    name = rms[0].name
    mv = mc.get_latest_versions(name)[0]
    mr = mc.get_run(mv.run_id)
    print("registry   :", name, "version", mv.version)
    print("mlflow n_rows metric:", mr.data.metrics.get("train_rows"))
    assert final.status == 4  # succeeded
    lifecycle = {x["payload"]["event_type"] for x in c.memory_state.outbox}
    print("events     :", sorted(e for e in lifecycle if e.startswith("pipeline.run")))
    print("LIVE-TRAIN OK")

asyncio.run(main())
