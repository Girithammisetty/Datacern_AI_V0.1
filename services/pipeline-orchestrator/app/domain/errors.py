"""Domain error envelope (MASTER-FR-024). Each maps to an HTTP status + code."""

from __future__ import annotations


class AppError(Exception):
    status = 500
    code = "INTERNAL"

    def __init__(self, message: str = "", *, details=None, code: str | None = None,
                 status: int | None = None):
        super().__init__(message or self.code)
        self.message = message or self.code
        self.details = details
        if code is not None:
            self.code = code
        if status is not None:
            self.status = status


class Unauthenticated(AppError):
    status = 401
    code = "UNAUTHENTICATED"


class PermissionDenied(AppError):
    status = 403
    code = "PERMISSION_DENIED"


class NotFound(AppError):
    status = 404
    code = "NOT_FOUND"


class Conflict(AppError):
    status = 409
    code = "CONFLICT"


class ValidationFailed(AppError):
    status = 422
    code = "VALIDATION_FAILED"


class TrainingDataExceedsBudget(AppError):
    """The labeled set is larger than the run's resolved RAM budget allows.

    Deliberately an ERROR rather than a silent truncation: training on the first
    N rows of a much larger dataset and registering the result as "trained on
    dataset X" is a fabricated provenance claim — the metrics, the model card and
    the four-eyes promotion approval would all describe a model the reviewer
    cannot see was fitted to a sliver. Refusing is recoverable (raise the node's
    ram_gb, or sample deliberately upstream so the sampling is on the record);
    silently truncating is not.
    """

    status = 422
    code = "TRAINING_DATA_EXCEEDS_BUDGET"


class RunOrphaned(AppError):
    """The orchestrator instance driving this run stopped before it finished.

    Only ever raised for work that lived INSIDE that process (the local executor).
    An Argo run is not orphaned by a lost orchestrator — the workflow keeps running
    in Kubernetes and another instance re-attaches to it.

    Failing is the honest outcome, not a workaround: the run's work is genuinely
    gone, and leaving it in `running` would misreport a dead run as live while
    permanently consuming one of the tenant's concurrency slots.
    """

    status = 503
    code = "RUN_ORPHANED"


class CannotCompile(AppError):
    status = 422
    code = "CANNOT_COMPILE"


class CannotRunPipelineType(AppError):
    status = 422
    code = "CANNOT_RUN_PIPELINE_TYPE"


class TemplateNotRunnable(AppError):
    status = 422
    code = "TEMPLATE_NOT_RUNNABLE"


class RateLimited(AppError):
    status = 429
    code = "RATE_LIMITED"

    def __init__(self, message: str = "", *, retry_after: int = 15, **kw):
        super().__init__(message, **kw)
        self.retry_after = retry_after


class BudgetExhausted(AppError):
    status = 429
    code = "BUDGET_EXHAUSTED"


class DependencyUnavailable(AppError):
    status = 503
    code = "DEPENDENCY_UNAVAILABLE"
