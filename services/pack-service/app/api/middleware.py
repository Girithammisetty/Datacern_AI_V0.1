"""Auth middleware: RS256 JWT for /api/v1 (public health/metrics excepted)."""

from __future__ import annotations

import uuid

from fastapi import Request
from starlette.middleware.base import BaseHTTPMiddleware

from app.api.errors import error_response
from app.domain.errors import AppError, Unauthenticated

_PUBLIC_PATHS = {"/healthz", "/readyz", "/metrics", "/docs", "/openapi.json"}


class AuthMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        path = request.url.path
        if path in _PUBLIC_PATHS or path.startswith("/internal/"):
            return await call_next(request)
        trace_id = getattr(request.state, "trace_id", str(uuid.uuid4()))
        auth_header = request.headers.get("authorization", "")
        if not auth_header.lower().startswith("bearer "):
            return error_response(401, "UNAUTHENTICATED", "missing bearer token", trace_id)
        token = auth_header[7:]
        try:
            verifier = request.app.state.token_verifier
            request.state.principal = await verifier.verify(token)
            request.state.raw_token = token
        except Unauthenticated as exc:
            return error_response(401, exc.code, exc.message, trace_id)
        except AppError as exc:
            return error_response(exc.status, exc.code, exc.message, trace_id)
        return await call_next(request)
