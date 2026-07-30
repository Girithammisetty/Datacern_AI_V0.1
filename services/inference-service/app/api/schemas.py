"""Pydantic request/response models + payload builders (BRD §5)."""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field, field_validator, model_validator

from app.domain.entities import InferenceJob, ScoringSchedule
from app.domain.enums import output_mode_from_str, stage_name, status_name


class OutputSpec(BaseModel):
    dataset_name: str | None = None
    mode: str | None = None  # create | append | replace


class AutoCaseSpec(BaseModel):
    """Score→case bridge (CASE-FR-003, learning-loop slice 7): when set on a
    job's ``parameters["auto_case"]``, qualifying rows are carried on the
    ``inference.completed`` event and case-service's InferenceHandler opens
    them as cases on the job's workspace worklist.

    Qualification is EITHER numeric (``threshold``: score_field ≥ threshold —
    regressors / probability outputs) OR categorical (``positive_label``:
    str(score_field) == positive_label — classifiers whose pyfunc ``predict``
    emits class labels, e.g. the random_forest template). Exactly one must be
    set. ``max_cases`` bounds the event (case-service's CreateCases caps
    batches at 500); the emitter logs loudly when the cap truncates."""

    threshold: float | None = None
    positive_label: str | None = None
    row_pk_field: str = Field(min_length=1)
    score_field: str = "prediction"
    projection_fields: list[str] = Field(default_factory=list, max_length=12)
    max_cases: int = Field(default=500, ge=1, le=500)

    @model_validator(mode="after")
    def _exactly_one_mode(self) -> AutoCaseSpec:
        if (self.threshold is None) == (self.positive_label is None):
            raise ValueError("auto_case requires exactly one of threshold / positive_label")
        return self


def validate_auto_case(parameters: dict[str, Any] | None) -> dict[str, Any] | None:
    """Normalize/validate parameters["auto_case"] at every job-creating entry
    point (submit, bulk, schedule fires reuse the stored, already-normalized
    dict). Raises pydantic.ValidationError on a malformed spec."""
    if not parameters or "auto_case" not in parameters:
        return parameters
    spec = AutoCaseSpec.model_validate(parameters["auto_case"])
    return {**parameters, "auto_case": spec.model_dump()}


class SubmitBody(BaseModel):
    model_version_urn: str
    input_dataset_urn: str
    name: str | None = None
    description: str | None = None
    parameters: dict[str, Any] | None = None
    output: OutputSpec | None = None
    allow_unpromoted: bool = False
    allow_empty: bool = False

    @field_validator("parameters")
    @classmethod
    def _normalize_auto_case(cls, v: dict[str, Any] | None) -> dict[str, Any] | None:
        return validate_auto_case(v)


class ValidateBody(BaseModel):
    model_version_urn: str
    input_dataset_urn: str
    allow_unpromoted: bool = False
    allow_empty: bool = False


class BulkBody(BaseModel):
    model_version_urn: str
    input_dataset_urns: list[str] = Field(default_factory=list)
    parameters: dict[str, Any] | None = None
    output: OutputSpec | None = None

    @field_validator("parameters")
    @classmethod
    def _normalize_auto_case(cls, v: dict[str, Any] | None) -> dict[str, Any] | None:
        return validate_auto_case(v)


class ScheduleBody(BaseModel):
    name: str
    input_selector: dict[str, Any]
    output: dict[str, Any]
    model_version_urn: str | None = None
    model_urn: str | None = None
    stage_selector: str | None = None
    cron: str | None = None
    interval_seconds: int | None = None
    timezone: str = "UTC"
    overlap_policy: str | None = None
    enabled: bool = True
    notify_on_failure: bool = True


class SchedulePatch(BaseModel):
    cron: str | None = None
    interval_seconds: int | None = None
    timezone: str | None = None
    overlap_policy: str | None = None
    input_selector: dict[str, Any] | None = None
    output: dict[str, Any] | None = None
    notify_on_failure: bool | None = None


def output_mode_value(spec: OutputSpec | None) -> int:
    if spec is None:
        return 0
    return int(output_mode_from_str(spec.mode))


def page_envelope(items: list, next_cursor: str | None, has_more: bool) -> dict:
    return {"data": items, "page": {"next_cursor": next_cursor, "has_more": has_more}}


def _iso(dt) -> str | None:
    return dt.isoformat() if dt else None


def job_payload(job: InferenceJob) -> dict:
    model = {
        "urn": job.model_version_urn,
        "name": job.model_name,
        "version": job.model_version,
        "stage_at_submit": stage_name(job.model_stage_at_submit),
    }
    return {
        "id": job.id,
        "status": status_name(job.status),
        "name": job.name,
        "description": job.description,
        "model": model,
        "input_dataset": {"urn": job.input_dataset_urn, "version": job.input_dataset_version},
        "output_dataset": (
            {"urn": job.output_dataset_urn, "version": job.output_dataset_version}
            if job.output_dataset_urn else None
        ),
        "output_mode": job.output_mode,
        "parameters": job.parameters,
        "compatibility_report": job.compatibility_report,
        "pipeline_run_urn": job.pipeline_run_urn,
        "components_status": job.components_status,
        "error": job.error,
        "row_count": job.row_count,
        "schedule_id": job.schedule_id,
        "retried_from_job_id": job.retried_from_job_id,
        "via_agent": job.via_agent,
        "timestamps": {
            "queued_at": _iso(job.queued_at),
            "submitted_at": _iso(job.submitted_at),
            "started_at": _iso(job.started_at),
            "finished_at": _iso(job.finished_at),
            "created_at": _iso(job.created_at),
        },
    }


def schedule_payload(sch: ScoringSchedule) -> dict:
    return {
        "id": sch.id,
        "name": sch.name,
        "enabled": sch.enabled,
        "paused_reason": sch.paused_reason,
        "model_version_urn": sch.model_version_urn,
        "model_urn": sch.model_urn,
        "stage_selector": stage_name(sch.stage_selector),
        "input_selector": sch.input_selector,
        "output": sch.output,
        "cron": sch.cron,
        "interval_seconds": sch.interval_seconds,
        "timezone": sch.timezone,
        "overlap_policy": sch.overlap_policy,
        "consecutive_failures": sch.consecutive_failures,
        "temporal_schedule_id": sch.temporal_schedule_id,
        "notify_on_failure": sch.notify_on_failure,
        "next_fire_preview": {"at": _iso(sch.next_fire_at)},
    }
