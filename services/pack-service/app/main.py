"""FastAPI application factory for pack-service (BRD 23)."""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI

from app.api.auth import LocalScopeAuthz, OpaAuthzClient, TokenVerifier
from app.api.errors import TraceMiddleware, install_error_handlers
from app.api.middleware import AuthMiddleware
from app.api.routes import health, installs, packs
from app.config import Settings
from app.domain import catalog
from app.store.db import Db, make_engine

logger = logging.getLogger(__name__)


@asynccontextmanager
async def _lifespan(app: FastAPI):
    settings: Settings = app.state.settings
    if settings.use_real_adapters:
        try:
            from app.registration import register_actions

            await register_actions(settings)
        except Exception:  # noqa: BLE001
            logger.exception("pack-service action registration error")
    yield


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or Settings()
    app = FastAPI(title="pack-service", version="0.1.0", docs_url="/docs", lifespan=_lifespan)

    catalog.configure(settings.packs_dir)

    app.state.settings = settings
    app.state.token_verifier = TokenVerifier(settings)
    app.state.authz = (
        OpaAuthzClient(settings.opa_url, redis_url=settings.redis_url)
        if settings.use_real_adapters
        else LocalScopeAuthz()
    )
    app.state.db = Db(make_engine(settings.database_url))

    # Observability: RED metrics + tracing (env-gated, no-op unless enabled).
    try:
        from datacern_common.metricsx import RedMiddleware, instrument_app
        from datacern_common.otelx import configure_tracing

        configure_tracing("pack-service")
        app.add_middleware(AuthMiddleware)
        app.add_middleware(TraceMiddleware)
        app.add_middleware(RedMiddleware, service="pack-service")
        instrument_app(app, "pack-service")
    except Exception:  # noqa: BLE001 - metrics are optional, never block boot
        app.add_middleware(AuthMiddleware)
        app.add_middleware(TraceMiddleware)

    install_error_handlers(app)
    app.include_router(health.router)
    app.include_router(packs.router)
    app.include_router(installs.router)
    return app


app = create_app()
