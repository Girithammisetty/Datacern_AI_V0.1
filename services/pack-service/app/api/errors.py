from __future__ import annotations

import logging
import uuid

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware

from app.domain.errors import AppError

logger = logging.getLogger(__name__)


def error_response(status: int, code: str, message: str, trace_id: str) -> JSONResponse:
    return JSONResponse(
        status_code=status,
        content={"error": {"code": code, "message": message, "trace_id": trace_id}},
    )


class TraceMiddleware(BaseHTTPMiddleware):
    """Assigns a trace_id to every request (echoed in error envelopes)."""

    async def dispatch(self, request: Request, call_next):
        request.state.trace_id = request.headers.get("x-trace-id") or str(uuid.uuid4())
        response = await call_next(request)
        response.headers["x-trace-id"] = request.state.trace_id
        return response


def install_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(AppError)
    async def _app_error(request: Request, exc: AppError):  # noqa: ANN202
        trace_id = getattr(request.state, "trace_id", "")
        return error_response(exc.status, exc.code, exc.message, trace_id)

    @app.exception_handler(Exception)
    async def _unhandled(request: Request, exc: Exception):  # noqa: ANN202
        trace_id = getattr(request.state, "trace_id", "")
        logger.exception("unhandled error trace=%s", trace_id)
        return error_response(500, "INTERNAL", "internal error", trace_id)
