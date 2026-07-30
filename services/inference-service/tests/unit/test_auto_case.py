"""Score→case bridge (CASE-FR-003, learning-loop slice 7).

Before this slice the bridge was HALF-built: case-service ships a complete
InferenceHandler for ``inference.completed`` + ``auto_case=true`` — an event no
producer ever emitted (found while writing the learn journey). These tests pin
the producer side: the spec is validated at the API boundary, the executor's
collected rows ride the event with the exact contract the consumer parses
(auto_case, workspace_id, dataset_urn, score_threshold, rows[{row_pk, score,
display_projection}]), truncation is visible (over_threshold_total / capped),
and a job WITHOUT the spec emits nothing new.
"""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from app.api.schemas import AutoCaseSpec, SubmitBody
from app.domain.enums import JobStatus
from app.domain.ports import CallCtx, ResolvedDataset, ResolvedModel, ScoringResult
from app.domain.services import SubmitRequest
from tests.conftest import TENANT_A, WORKSPACE, FakeExecutor, add_input_dataset

MODEL = f"wr:{TENANT_A}:experiment:model_version/fraud-xgb@3"
DS = f"wr:{TENANT_A}:dataset:dataset/ds-txn"

AC = {"threshold": 0.8, "row_pk_field": "claim_id",
      "projection_fields": ["claim_id", "amount"]}


def _ctx():
    return CallCtx(tenant_id=TENANT_A, actor={"type": "user", "id": "u1", "scopes": ["*"]},
                   workspace_id=WORKSPACE, submitted_by="u1")


class AutoCaseExecutor(FakeExecutor):
    """FakeExecutor returning collected over-threshold rows, as the real
    executor does when parameters["auto_case"] is set."""

    def __init__(self, rows, total_over):
        super().__init__()
        self._rows, self._total = rows, total_over

    async def run(self, *, model: ResolvedModel, dataset: ResolvedDataset, job,
                  parameters: dict) -> ScoringResult:
        base = await super().run(model=model, dataset=dataset, job=job,
                                 parameters=parameters)
        base.auto_case_rows = self._rows if parameters.get("auto_case") else None
        base.auto_case_total_over = self._total
        return base


# ---- spec validation at the API boundary -----------------------------------


def test_submit_body_normalizes_auto_case_with_defaults():
    b = SubmitBody(model_version_urn=MODEL, input_dataset_urn=DS,
                   parameters={"auto_case": AC})
    spec = b.parameters["auto_case"]
    assert spec["score_field"] == "prediction"
    assert spec["max_cases"] == 500
    assert spec["threshold"] == 0.8
    # round-trips through the spec model
    AutoCaseSpec.model_validate(spec)


@pytest.mark.parametrize("bad", [
    {"threshold": 0.8},                                   # no row_pk_field
    {"row_pk_field": "id"},                               # no threshold
    {"threshold": 0.8, "row_pk_field": ""},               # empty pk
    {"threshold": 0.8, "row_pk_field": "id", "max_cases": 0},
    {"threshold": 0.8, "row_pk_field": "id", "max_cases": 5000},
    {"threshold": 0.8, "row_pk_field": "id",
     "projection_fields": [f"c{i}" for i in range(13)]},  # > 12 projection cols
])
def test_submit_body_rejects_malformed_auto_case(bad):
    with pytest.raises(ValidationError):
        SubmitBody(model_version_urn=MODEL, input_dataset_urn=DS,
                   parameters={"auto_case": bad})


# ---- the event, end to end through the service tier -------------------------


async def _run_job(registry, executor, parameters):
    from app.container import build_container
    from tests.conftest import FakeClock, make_settings

    container = build_container(make_settings(), mode="memory", clock=FakeClock(),
                                registry=registry, executor=executor)
    add_input_dataset(container, urn=DS)
    job = await container.inference.submit(
        _ctx(), SubmitRequest(MODEL, DS, parameters=parameters))
    await container.inference.execute_job(TENANT_A, job.id)
    fetched = await container.inference.get(_ctx(), job.id)
    events = [e for _, e in container.memory_state.outbox]
    return fetched, events


async def test_succeeded_job_with_auto_case_emits_inference_completed(registry):
    rows = [
        {"row_pk": "CLM-2", "score": 0.97,
         "display_projection": {"claim_id": "CLM-2", "amount": "9000", "score": "0.97"}},
    ]
    job, events = await _run_job(registry, AutoCaseExecutor(rows, total_over=1),
                                 {"auto_case": {**AC, "max_cases": 500,
                                                "score_field": "prediction"}})
    assert job.status == int(JobStatus.succeeded)

    completed = [e for e in events if e["event_type"] == "inference.completed"]
    assert len(completed) == 1, [e["event_type"] for e in events]
    p = completed[0]["payload"]
    # the EXACT contract case-service's InferenceHandler/AutoCreateFromInference
    # parses: auto_case gate, workspace uuid, dataset_urn, threshold, row shape.
    assert p["auto_case"] is True
    assert p["workspace_id"] == WORKSPACE
    assert p["dataset_urn"] == job.output_dataset_urn
    assert p["score_threshold"] == 0.8
    assert p["rows"] == rows
    assert p["over_threshold_total"] == 1
    assert p["capped"] is False
    # the standard succeeded event still rides alongside, unchanged
    assert any(e["event_type"] == "inference.job.succeeded" for e in events)


async def test_truncation_is_visible_not_silent(registry):
    rows = [{"row_pk": f"CLM-{i}", "score": 0.9, "display_projection": {}}
            for i in range(3)]
    _, events = await _run_job(registry, AutoCaseExecutor(rows, total_over=7),
                               {"auto_case": {**AC, "max_cases": 3}})
    p = next(e for e in events if e["event_type"] == "inference.completed")["payload"]
    assert p["over_threshold_total"] == 7
    assert p["capped"] is True
    assert len(p["rows"]) == 3


async def test_job_without_auto_case_emits_no_completed_event(registry, executor):
    _, events = await _run_job(registry, executor, None)
    types = [e["event_type"] for e in events]
    assert "inference.job.succeeded" in types
    assert "inference.completed" not in types


# ---- the executor's bounded collection (pure) -------------------------------


def test_collect_auto_case_rows_thresholds_caps_and_projects():
    import pyarrow as pa

    from app.adapters.executor import _collect_auto_case_rows

    table = pa.table({
        "claim_id": ["A", "B", "C", "D", None],
        "amount": [100, 9000, 8000, 7000, 6000],
        "prediction": [0.1, 0.95, 0.9, 0.85, 0.99],
    })
    spec = {"threshold": 0.8, "row_pk_field": "claim_id",
            "projection_fields": ["amount"], "max_cases": 2}
    out: list[dict] = []
    over = _collect_auto_case_rows(table, spec, out)
    # B, C, D are over threshold with a usable pk (the None-pk row is skipped);
    # the cap keeps the first two, the count reports all three.
    assert over == 3
    assert [r["row_pk"] for r in out] == ["B", "C"]
    assert out[0]["score"] == 0.95
    assert out[0]["display_projection"]["amount"] == "9000"
    assert out[0]["display_projection"]["score"] == "0.95"


def test_collect_auto_case_rows_missing_columns_is_config_error_not_crash():
    import pyarrow as pa

    from app.adapters.executor import _collect_auto_case_rows

    table = pa.table({"x": [1, 2], "prediction": [0.9, 0.9]})
    out: list[dict] = []
    assert _collect_auto_case_rows(
        table, {"threshold": 0.5, "row_pk_field": "nope"}, out) == 0
    assert out == []


def test_positive_label_mode_matches_classifier_output():
    import pyarrow as pa

    from app.adapters.executor import _collect_auto_case_rows

    table = pa.table({
        "claim_id": ["A", "B", "C"],
        "prediction": ["false_positive", "true_positive", "true_positive"],
    })
    spec = {"positive_label": "true_positive", "row_pk_field": "claim_id",
            "max_cases": 500}
    out: list[dict] = []
    assert _collect_auto_case_rows(table, spec, out) == 2
    assert [r["row_pk"] for r in out] == ["B", "C"]
    assert out[0]["score"] == 1.0
    assert out[0]["display_projection"]["score"] == "true_positive"


def test_spec_requires_exactly_one_of_threshold_or_positive_label():
    with pytest.raises(ValidationError):
        AutoCaseSpec.model_validate({"row_pk_field": "id"})  # neither
    with pytest.raises(ValidationError):
        AutoCaseSpec.model_validate({"row_pk_field": "id", "threshold": 0.5,
                                     "positive_label": "fraud"})  # both
    AutoCaseSpec.model_validate({"row_pk_field": "id", "positive_label": "fraud"})
