"""Domain entities — plain dataclasses whose fields mirror the DB columns so the
SQL repos can round-trip them field-by-field (BRD §4.1)."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime


@dataclass
class CallCtx:
    tenant_id: str
    actor: dict
    via_agent: dict | None = None
    workspace_id: str | None = None
    subject_id: str | None = None
    trace_id: str | None = None


@dataclass
class PipelineTemplate:
    id: str
    tenant_id: str
    workspace_id: str
    name: str
    pipeline_type: int
    model_type: int | None
    algorithm_template_name: str | None
    active_version_id: str | None
    is_system: bool
    created_by: str | None
    created_at: datetime
    updated_at: datetime
    deleted_at: datetime | None = None


@dataclass
class TemplateVersion:
    id: str
    tenant_id: str
    template_id: str
    version_no: int
    definition: dict
    validation_status: int  # 0=draft, 1=valid
    validation_report: dict | None
    run_parameters: dict
    global_parameters: list[str]
    component_catalog_version: str | None
    compiled_manifest_ref: str | None
    manifest_digest: str | None
    argo_template_name: str | None
    created_by: str | None
    created_at: datetime


@dataclass
class PipelineRun:
    id: str
    tenant_id: str
    template_id: str
    version_id: str
    status: int
    argo_workflow_name: str | None
    mlflow_run_id: str | None
    run_parameters: dict
    components_status: dict
    error: dict | None
    input_dataset_urns: list[str]
    output_dataset_urns: list[str]
    retried_from_run_id: str | None
    submitted_by: str | None
    via_agent: dict | None
    model_uri: str | None
    metrics: dict | None
    created_at: datetime
    updated_at: datetime
    queued_at: datetime | None = None
    submitted_at: datetime | None = None
    started_at: datetime | None = None
    finished_at: datetime | None = None
    #: Which orchestrator instance is currently driving this run, and until when.
    #: A run is only ever driven by the holder of an unexpired lease, so a pod that
    #: is evicted mid-run (routine under autoscaling) releases it by simply
    #: failing to heartbeat, and the reaper can recover the run elsewhere instead
    #: of leaving it stuck in `running` forever.
    lease_owner: str | None = None
    lease_expires_at: datetime | None = None


@dataclass
class Component:
    name: str
    component_type: int
    internal_component_type: int
    label: str
    definition: dict
    yaml_ref: str | None
    image_digest: str | None
    catalog_version: str
    enabled: bool = True


@dataclass
class AlgorithmTemplate:
    name: str
    label: str
    model_type: int
    order: int
    model_type_order: int
    input_type: dict
    pipeline: dict
    tuning_pipeline: dict
    tuning_pipeline_cross_validation: dict
    parameters: dict
    tuning_parameters: dict
    metadata: dict
    catalog_version: str
    runnable: bool = True


@dataclass
class TenantQuota:
    tenant_id: str
    max_concurrent_runs: int = 10
    max_concurrent_pods: int = 40
    max_run_duration_minutes: int = 480
    min_seconds_between_runs: int = 15
    resource_ceiling: dict = field(default_factory=lambda: {"cpus": 7, "ram_gb": 24,
                                                            "timeout_minutes": 480})
    node_pool: str | None = None


@dataclass
class PipelineSchedule:
    """A recurring trigger that fires an existing pipeline template on a cron
    (PIPE-FR-050). Fields mirror the ``pipeline_schedules`` columns so the SQL repo
    round-trips them field-by-field."""

    schedule_id: str
    tenant_id: str
    template_id: str
    name: str | None
    cron: str | None
    timezone: str
    run_parameters: dict
    enabled: bool
    next_fire_at: datetime | None
    last_fire_at: datetime | None
    last_run_id: str | None
    created_by: str | None
    created_at: datetime
    updated_at: datetime


@dataclass
class BatchJob:
    """BRD 73 — a recurring job that chains *ingest then run* (V1's ``Job``).

    Binds a pipeline VERSION to a set of source connections and a cadence, so
    "every night pull the claims feed and score it" is one governed object rather
    than two independent crons with a hopeful gap between them.

    ``connection_bindings`` is V1's ``connections`` JSON, typed:
    ``[{binding_key, connection_id, dataset_urn?, ingestion_params{}}]``.
    ``pipeline_version_id`` may be NULL — the run then pins itself to whatever
    version was active when it fired, and records that id on the run.
    """

    id: str
    tenant_id: str
    workspace_id: str
    name: str
    pipeline_template_id: str
    pipeline_version_id: str | None
    connection_bindings: list[dict]
    cron: str | None
    timezone: str
    run_parameters: dict
    start_at: datetime | None
    end_at: datetime | None
    paused: bool
    phase_timeout_seconds: int | None
    next_fire_at: datetime | None
    last_fire_at: datetime | None
    last_run_id: str | None
    created_by: str | None
    created_at: datetime
    updated_at: datetime
    deleted_at: datetime | None = None


@dataclass
class BatchJobRun:
    """One `trigger → ingestion → pipeline` execution of a :class:`BatchJob`.

    ``batch_key`` is the run's own id, stamped on every ingestion this run fires
    (as the ingestion-service Idempotency-Key together with the binding key) so a
    reaper re-drive re-plays the ORIGINAL ingestion instead of creating a second
    one — double-driving a plain pipeline run wastes compute, but double-driving
    a batch job double-ingests, which corrupts the data.

    The lease is the same mechanism ``PipelineRun`` uses (claim / heartbeat at ⅓
    TTL / release), and is held only while a phase is actively being driven — the
    `ingestion` phase is advanced by the ``ingestion.events.v1`` consumer, not by
    a coroutine sitting on a lease waiting.
    """

    id: str
    tenant_id: str
    batch_job_id: str
    pipeline_template_id: str
    pipeline_version_id: str | None
    batch_key: str
    phase: int
    status: int
    trigger: str
    input_dataset_urns: list[str]
    output_dataset_urns: list[str]
    pipeline_run_id: str | None
    error: dict | None
    phase_deadline_at: datetime | None
    retried_from_run_id: str | None
    submitted_by: str | None
    via_agent: dict | None
    created_at: datetime
    updated_at: datetime
    started_at: datetime | None = None
    finished_at: datetime | None = None
    lease_owner: str | None = None
    lease_expires_at: datetime | None = None


@dataclass
class BatchJobRunIngestion:
    """One binding's ingestion within a batch job run — the record that makes the
    trigger phase idempotent AND gives the consumer a reverse lookup from an
    ``ingestion.events.v1`` event back to the run waiting on it."""

    id: str
    tenant_id: str
    batch_job_run_id: str
    binding_key: str
    ingestion_id: str | None
    status: str  # triggered | completed | failed | cancelled
    dataset_urn: str | None
    iceberg_snapshot_id: str | None
    dataset_version_urn: str | None
    error: dict | None
    created_at: datetime
    updated_at: datetime


@dataclass
class LabeledExample:
    """A single human-correction turned into a labeled training row (learning loop).
    Assembled from ``case.disposition_applied`` events (BRD LEARNING-LOOP TIE-IN)."""

    id: str
    tenant_id: str
    dataset_urn: str
    row_pk: str
    features: dict
    label: str
    source_case_urn: str | None
    created_at: datetime
