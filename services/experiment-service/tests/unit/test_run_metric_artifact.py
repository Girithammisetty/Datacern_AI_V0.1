"""BRD 72 inc3 — `GET /api/v1/artifacts?urn=<run urn>`.

chart-service's `HTTPArtifacts.FetchArtifact` has always routed RUN urns to
`<experiment-service>/api/v1/artifacts?urn=`. That endpoint did not exist here
(only `/runs/{id}/artifacts`), so every `roc_curve` / `confusion_matrix` /
`decision_tree` chart resolved to a 404 that surfaced as `EUpstream` — the chart
types were catalogued end to end with no data path behind them.

Everything is served from the Postgres mirror: no MLflow call in the request path.
"""

from __future__ import annotations

import json

import pytest

from app.domain.entities import RunMetric, RunTag
from app.domain.errors import NotFound, ValidationFailed
from app.domain.services import CLASS_LABELS_TAG
from app.domain.urn import run_urn
from tests.conftest import TENANT_A, auth, ctx_for, make_experiment


async def _run_with(container, metrics: dict, tags: dict | None = None, algorithm="random_forest"):
    ctx = ctx_for()
    exp = await make_experiment(container, ctx)
    run = await container.run_service.create_from_pipeline(
        ctx, {"mlflow_run_id": f"mlf-{len(metrics)}-{algorithm}", "experiment_id": exp.id,
              "algorithm": algorithm})
    async with container.run_service.uow(TENANT_A) as uow:
        for k, v in metrics.items():
            await uow.runs.upsert_metric(RunMetric(run.id, TENANT_A, k, float(v), 0, None))
        for k, v in (tags or {}).items():
            await uow.runs.upsert_tag(RunTag(run.id, TENANT_A, k, v))
        await uow.commit()
    return ctx, run


# A real 2x2 confusion matrix as the executor flattens it, plus its labels tag.
_BINARY = {
    "accuracy": 0.91, "f1_weighted": 0.9, "roc_auc": 0.96,
    "test_rows": 40.0,
    "cm_0_0": 18.0, "cm_0_1": 2.0, "cm_1_0": 2.0, "cm_1_1": 18.0,
}
_LABELS = {CLASS_LABELS_TAG: json.dumps(["denied", "approved"])}


async def test_resolves_a_run_urn_to_its_metric_artifact(container):
    ctx, run = await _run_with(container, _BINARY, _LABELS)
    art = await container.run_service.metric_artifact(ctx, run_urn(TENANT_A, run.id))
    assert art["kind"] == "run_summary"
    assert art["run_id"] == run.id
    assert art["algorithm"] == "random_forest"


async def test_headline_metrics_are_present_and_ordered(container):
    # A generic {kind, metrics} client must still render something real.
    ctx, run = await _run_with(container, _BINARY, _LABELS)
    art = await container.run_service.metric_artifact(ctx, run_urn(TENANT_A, run.id))
    labels = [m["label"] for m in art["metrics"]]
    assert labels[:3] == ["Accuracy", "F1 (weighted)", "ROC AUC"]
    assert dict(zip(labels, [m["value"] for m in art["metrics"]], strict=True))["Accuracy"] == 0.91


async def test_confusion_matrix_is_rebuilt_from_the_flattened_metrics(container):
    ctx, run = await _run_with(container, _BINARY, _LABELS)
    art = await container.run_service.metric_artifact(ctx, run_urn(TENANT_A, run.id))
    cm = art["confusion_matrix"]
    assert cm["matrix"] == [[18, 2], [2, 18]]
    assert cm["total"] == 40


async def test_confusion_matrix_is_labelled_from_the_class_labels_tag(container):
    # The mirror carries metrics and tags but not artifact blobs, which is exactly
    # why the executor writes the labels as a tag.
    ctx, run = await _run_with(container, _BINARY, _LABELS)
    art = await container.run_service.metric_artifact(ctx, run_urn(TENANT_A, run.id))
    cm = art["confusion_matrix"]
    assert cm["labels"] == ["denied", "approved"]


async def test_missing_labels_are_flagged_not_fabricated(container):
    # The numbers are real, so the matrix is returned — but emitting "Class 0" as
    # if it were the class NAME would make a run whose executor never wrote the
    # tag look identical to one that did.
    ctx, run = await _run_with(container, _BINARY)
    art = await container.run_service.metric_artifact(ctx, run_urn(TENANT_A, run.id))
    cm = art["confusion_matrix"]
    assert cm["labels_available"] is False
    assert cm["labels"] == ["0", "1"]
    assert cm["matrix"] == [[18, 2], [2, 18]]


async def test_real_labels_carry_no_unavailable_flag(container):
    ctx, run = await _run_with(container, _BINARY, _LABELS)
    art = await container.run_service.metric_artifact(ctx, run_urn(TENANT_A, run.id))
    assert "labels_available" not in art["confusion_matrix"]


async def test_a_malformed_labels_tag_falls_back_instead_of_failing(container):
    ctx, run = await _run_with(container, _BINARY, {CLASS_LABELS_TAG: "not json"})
    art = await container.run_service.metric_artifact(ctx, run_urn(TENANT_A, run.id))
    cm = art["confusion_matrix"]
    assert cm["labels_available"] is False


async def test_a_labels_tag_of_the_wrong_length_is_ignored(container):
    # Three labels cannot describe a 2x2 matrix; using them would mislabel it.
    ctx, run = await _run_with(container, _BINARY, {CLASS_LABELS_TAG: json.dumps(["a", "b", "c"])})
    art = await container.run_service.metric_artifact(ctx, run_urn(TENANT_A, run.id))
    cm = art["confusion_matrix"]
    assert cm["labels_available"] is False


async def test_a_3x3_matrix_reconstructs_at_the_right_size(container):
    metrics = {f"cm_{i}_{j}": float(i * 3 + j) for i in range(3) for j in range(3)}
    ctx, run = await _run_with(container, metrics, algorithm="decision_tree")
    art = await container.run_service.metric_artifact(ctx, run_urn(TENANT_A, run.id))
    cm = art["confusion_matrix"]
    assert len(cm["matrix"]) == 3 and all(len(r) == 3 for r in cm["matrix"])
    assert cm["matrix"][2][1] == 7


async def test_no_confusion_matrix_key_for_a_regression_run(container):
    # The artifact must not claim a matrix that was never computed.
    ctx, run = await _run_with(container, {"r2": 0.88, "rmse": 1.2},
                               algorithm="linear_regression")
    art = await container.run_service.metric_artifact(ctx, run_urn(TENANT_A, run.id))
    assert "confusion_matrix" not in art
    assert [m["label"] for m in art["metrics"]] == ["R²", "RMSE"]


async def test_roc_auc_scalar_is_surfaced_without_implying_a_curve(container):
    # The curve POINTS live in the run's evaluation.json, which the mirror does not
    # carry. Reporting the scalar lets the UI say what it has instead of drawing a
    # curve it cannot draw.
    ctx, run = await _run_with(container, _BINARY, _LABELS)
    art = await container.run_service.metric_artifact(ctx, run_urn(TENANT_A, run.id))
    assert art["roc_auc"] == 0.96
    assert "roc_curve" not in art


async def test_non_cm_metrics_never_leak_into_the_matrix(container):
    ctx, run = await _run_with(container, {**_BINARY, "cm_total": 40.0}, _LABELS)
    art = await container.run_service.metric_artifact(ctx, run_urn(TENANT_A, run.id))
    cm = art["confusion_matrix"]
    assert len(cm["matrix"]) == 2  # cm_total is not a cm_<int>_<int> key


async def test_a_dataset_urn_is_rejected(container):
    # dataset-service owns dataset URNs; answering for one here would be wrong.
    ctx = ctx_for()
    with pytest.raises(ValidationFailed):
        await container.run_service.metric_artifact(
            ctx, f"wr:{TENANT_A}:dataset:dataset/abc")


async def test_an_unknown_run_404s(container):
    ctx = ctx_for()
    with pytest.raises(NotFound):
        await container.run_service.metric_artifact(ctx, run_urn(TENANT_A, "no-such-run"))


async def test_endpoint_is_reachable_over_http(client, container):
    ctx, run = await _run_with(container, _BINARY, _LABELS)
    resp = await client.get(f"/api/v1/artifacts?urn={run_urn(TENANT_A, run.id)}",
                            headers=auth(scopes=["experiment.run.read"]))
    assert resp.status_code == 200, resp.text
    assert resp.json()["data"]["confusion_matrix"]["labels"] == ["denied", "approved"]


async def test_cross_tenant_run_is_not_readable(client, container):
    ctx, run = await _run_with(container, _BINARY, _LABELS)
    other = "22222222-2222-4222-8222-222222222222"
    resp = await client.get(f"/api/v1/artifacts?urn={run_urn(TENANT_A, run.id)}",
                            headers=auth(tenant_id=other, scopes=["experiment.run.read"]))
    assert resp.status_code == 404


# ---------------------------------------------------------------------------
# BRD 72 inc3b — the evaluation blob (ROC points + tree) merged from the store
# ---------------------------------------------------------------------------

_BLOB = {
    "roc_curve": {
        "positive_label": "approved",
        "points": [{"fpr": 0.0, "tpr": 0.0}, {"fpr": 0.1, "tpr": 0.8, "threshold": 0.6},
                   {"fpr": 1.0, "tpr": 1.0, "threshold": 0.0}],
    },
    "confusion_matrix": {"labels": ["denied", "approved"], "matrix": [[19, 1], [1, 19]]},
    "tree": {"root": {"feature": "amount", "threshold": 1.5, "samples": 40, "leaf": False,
                      "children": [{"samples": 20, "leaf": True, "prediction": "denied"},
                                   {"samples": 20, "leaf": True, "prediction": "approved"}]},
             "node_count": 3},
}


class _Signer:
    """Unit-tier stand-in for the object store. Real S3 reads are integration-tier."""

    def __init__(self, blob=None, uri_seen=None):
        self.blob = blob
        self.calls: list[tuple[str, str]] = []

    async def signed_url(self, artifact_uri, path, ttl_seconds):  # pragma: no cover
        return "https://example/x"

    async def fetch_json(self, artifact_uri, path, max_bytes=None):
        self.calls.append((artifact_uri, path))
        return self.blob


async def _run_with_blob(container, blob, *, artifact_uri="s3://mlflow/1/abc/artifacts"):
    ctx, run = await _run_with(container, _BINARY, _LABELS)
    async with container.run_service.uow(TENANT_A) as uow:
        fresh = await uow.runs.get(run.id)
        fresh.artifact_uri = artifact_uri
        await uow.runs.update(fresh)
        await uow.commit()
    signer = _Signer(blob)
    container.run_service.deps.artifact_signer = signer
    return ctx, run, signer


async def test_roc_curve_points_are_merged_from_the_evaluation_blob(container):
    ctx, run, signer = await _run_with_blob(container, _BLOB)
    art = await container.run_service.metric_artifact(ctx, run_urn(TENANT_A, run.id))
    assert len(art["roc_curve"]["points"]) == 3
    assert art["roc_curve"]["positive_label"] == "approved"
    assert signer.calls == [("s3://mlflow/1/abc/artifacts", "evaluation.json")]


async def test_tree_structure_is_merged_from_the_evaluation_blob(container):
    ctx, run, _ = await _run_with_blob(container, _BLOB)
    art = await container.run_service.metric_artifact(ctx, run_urn(TENANT_A, run.id))
    assert art["tree"]["root"]["feature"] == "amount"
    assert len(art["tree"]["root"]["children"]) == 2


async def test_the_blob_matrix_wins_over_the_reconstruction(container):
    # The blob's matrix is what the fit actually produced, labels included; the
    # flattened-metric reconstruction is the fallback, not the source of truth.
    ctx, run, _ = await _run_with_blob(container, _BLOB)
    art = await container.run_service.metric_artifact(ctx, run_urn(TENANT_A, run.id))
    cm = art["confusion_matrix"]
    assert cm["matrix"] == [[19, 1], [1, 19]]
    assert cm["total"] == 40


async def test_an_absent_blob_still_serves_the_mirrored_payload(container):
    # A run predating the artifact, or one whose blob was GC'd, must not fail the
    # whole chart — the mirrored confusion matrix stands on its own.
    ctx, run, _ = await _run_with_blob(container, None)
    art = await container.run_service.metric_artifact(ctx, run_urn(TENANT_A, run.id))
    assert art["confusion_matrix"]["matrix"] == [[18, 2], [2, 18]]  # reconstruction
    assert "roc_curve" not in art and "tree" not in art


async def test_a_blob_without_points_does_not_claim_a_curve(container):
    ctx, run, _ = await _run_with_blob(container, {"roc_curve": {"points": []}})
    art = await container.run_service.metric_artifact(ctx, run_urn(TENANT_A, run.id))
    assert "roc_curve" not in art


async def test_no_store_read_is_attempted_without_an_artifact_uri(container):
    ctx, run, signer = await _run_with_blob(container, _BLOB, artifact_uri="")
    art = await container.run_service.metric_artifact(ctx, run_urn(TENANT_A, run.id))
    assert signer.calls == []
    assert "roc_curve" not in art
