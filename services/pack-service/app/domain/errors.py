from __future__ import annotations


class AppError(Exception):
    status = 500
    code = "INTERNAL"

    def __init__(self, message: str = ""):
        self.message = message or self.code
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
