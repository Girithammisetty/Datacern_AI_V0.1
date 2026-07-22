"""B6 (BRD 58): outbox retention prune — the SQLite (unit-tier) path used by
the local dev / test stack, which has no RLS and no SECURITY DEFINER function."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from app.events.outbox import emit_event, prune_pending
from tests.util import TENANT_A


async def _seed(container, *, published_at, event_type="x") -> None:
    async with container.db.tenant_session(TENANT_A) as session:
        event = emit_event(
            session, tenant_id=TENANT_A, event_type=event_type,
            resource_urn="urn:x:1", payload={},
        )
        event.published_at = published_at
        await session.commit()


async def test_prunes_old_published_rows(container):
    old = datetime.now(UTC) - timedelta(days=40)
    await _seed(container, published_at=old)

    async with container.db.session_factory() as session:
        n = await prune_pending(session, retention_seconds=30 * 24 * 3600)
    assert n == 1


async def test_does_not_prune_recent_rows(container):
    recent = datetime.now(UTC) - timedelta(hours=1)
    await _seed(container, published_at=recent)

    async with container.db.session_factory() as session:
        n = await prune_pending(session, retention_seconds=30 * 24 * 3600)
    assert n == 0


async def test_does_not_prune_unpublished_rows(container):
    # published_at=None (never published) must survive regardless of age --
    # only DELIVERED events are safe to drop.
    async with container.db.tenant_session(TENANT_A) as session:
        emit_event(
            session, tenant_id=TENANT_A, event_type="x",
            resource_urn="urn:x:1", payload={},
        )
        await session.commit()

    async with container.db.session_factory() as session:
        n = await prune_pending(session, retention_seconds=0)
    assert n == 0


async def test_returns_zero_when_nothing_to_prune(container):
    async with container.db.session_factory() as session:
        n = await prune_pending(session, retention_seconds=30 * 24 * 3600)
    assert n == 0
