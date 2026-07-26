from __future__ import annotations

from typing import Any


class AppError(Exception):
    status = 500
    code = "INTERNAL"

    def __init__(self, message: str = "", *, details: dict[str, Any] | None = None):
        self.message = message or self.code
        self.details = details
        super().__init__(self.message)


class Unauthenticated(AppError):
    status = 401
    code = "UNAUTHENTICATED"


class PermissionDenied(AppError):
    status = 403
    code = "PERMISSION_DENIED"


class NotFound(AppError):
    status = 404
    code = "NOT_FOUND"


class ValidationFailed(AppError):
    status = 422
    code = "VALIDATION_FAILED"


class Conflict(AppError):
    status = 409
    code = "CONFLICT"


class EntitlementRequired(AppError):
    """CPL-FR-030: the tenant lacks the pack_sku entitlement this install
    needs. Envelope matches docs/initiatives/commercial-plane.md's
    "Enforcement hook contracts" exactly: 403, code ENTITLEMENT_REQUIRED,
    details.missing_sku."""

    status = 403
    code = "ENTITLEMENT_REQUIRED"

    def __init__(self, missing_sku: str):
        super().__init__(
            f"pack_sku:{missing_sku} is not entitled for this tenant",
            details={"missing_sku": missing_sku},
        )


class EntitlementUnavailable(AppError):
    """CPL-NFR-004: the entitlements_flat projection is unreadable/missing --
    entitlement-gated writes fail CLOSED, never silently proceed."""

    status = 503
    code = "ENTITLEMENT_UNAVAILABLE"

    def __init__(self, message: str = "entitlement projection unavailable"):
        super().__init__(message)
