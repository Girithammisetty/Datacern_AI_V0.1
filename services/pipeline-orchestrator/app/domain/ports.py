"""Port dataclasses shared across services, executors and stores."""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class Page:
    items: list
    next_cursor: str | None
    has_more: bool


@dataclass
class TemplateFilters:
    name: str | None = None
    pipeline_type: str | None = None
    include_archived: bool = False
    workspace_id: str | None = None


@dataclass
class RunFilters:
    status: str | None = None
    template_id: str | None = None


@dataclass
class TrainingSpec:
    """Everything the executor needs to run REAL training for a run
    (BRD CRITICAL EXECUTION DECISION): a dataset (as assembled labeled rows) +
    algorithm + params → a trained model logged/registered to MLflow."""

    tenant_id: str
    run_id: str
    algorithm: str
    model_type: str
    params: dict
    rows: list[dict]
    feature_columns: list[str]
    label_column: str | None
    experiment: str
    registered_model_name: str
    mlflow_run_id: str | None = None
    tags: dict = field(default_factory=dict)
    #: CPUs the run's resources resolved to — the same figure the compiler puts
    #: in the pod's cpu request. The executor spends it on cross-validation
    #: parallelism; without it a node declared with 7 CPUs fitted on one.
    cpus: int = 1


@dataclass
class TrainingResult:
    mlflow_run_id: str
    model_uri: str
    registered_model_name: str
    model_version: str
    metrics: dict
    params: dict
    row_count: int
