"""Async Postgres access with per-transaction RLS binding.

Every unit of work runs inside a transaction that first sets
``app.tenant_id`` (transaction-local), so the ``tenant_isolation`` policies from
migration 0001 scope every row to the caller's tenant (MASTER-FR-001). The
runtime connects as the non-superuser ``pack_app`` role, so the policy is
actually enforced.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncConnection, AsyncEngine, create_async_engine


def make_engine(database_url: str) -> AsyncEngine:
    return create_async_engine(database_url, pool_size=5, max_overflow=5, pool_pre_ping=True)


class Db:
    def __init__(self, engine: AsyncEngine):
        self.engine = engine

    @asynccontextmanager
    async def tenant_tx(self, tenant_id: str) -> AsyncIterator[AsyncConnection]:
        """A transaction with ``app.tenant_id`` bound for RLS."""
        async with self.engine.begin() as conn:
            await conn.execute(
                text("SELECT set_config('app.tenant_id', :tid, true)"),
                {"tid": tenant_id},
            )
            yield conn
