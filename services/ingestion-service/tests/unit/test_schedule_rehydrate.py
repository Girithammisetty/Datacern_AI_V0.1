"""Boot-time schedule rehydration + the tick loop that actually fires them.

Before this, `InProcessScheduler.start()` had no caller anywhere in the service
and the registry lived only in memory: a schedule created through the API was
stored, reported a next_fire_at, and never fired unless someone called run_now.
These tests pin both halves — the loop exists, and it survives a restart.
"""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime, timedelta

import sqlalchemy as sa

from app.container import build_container
from app.domain.querysource import FakeQuerySource
from app.domain.services.schedules import ScheduleService, rehydrate
from app.store.models import Ingestion, Schedule
from tests.unit.test_api_schedules import ROWS, make_schedule, schedule_payload
from tests.util import TENANT_A, create_connection


async def make_second_schedule(client, auth, container, name: str):
    """A second schedule in the same tenant needs its own connection —
    connection names are unique per workspace."""
    container.query_sources.set("postgres", FakeQuerySource(rows=ROWS))
    conn = await create_connection(client, auth, name=name)
    resp = await client.post("/api/v1/schedules", json=schedule_payload(conn["id"]), headers=auth)
    assert resp.status_code == 201, resp.text
    return resp.json()["data"]


async def _restart(settings, container):
    """A fresh process against the SAME database: new container, new (empty)
    in-memory scheduler registry. This is what a pod restart looks like."""
    await container.db.dispose()
    fresh = build_container(settings)
    return fresh


async def test_enabled_schedules_are_restored_after_a_restart(
    client, auth_a, container, settings
) -> None:
    _conn, sched = await make_schedule(client, auth_a, container)

    fresh = await _restart(settings, container)
    try:
        # The bug: a fresh process knows nothing about the persisted schedule.
        assert fresh.scheduler.next_fire_at(sched["id"]) is None
        assert fresh.schedule_tenants == {}

        restored = await rehydrate(fresh)

        assert restored == 1
        assert fresh.scheduler.next_fire_at(sched["id"]) is not None
        # Without the tenant map the fire callback cannot resolve a tenant and
        # silently drops the run — restoring the timer alone is not enough.
        assert fresh.schedule_tenants[sched["id"]] == TENANT_A
    finally:
        await fresh.db.dispose()


async def test_rehydrate_binds_the_fire_callback(client, auth_a, container, settings) -> None:
    _conn, sched = await make_schedule(client, auth_a, container)
    fresh = await _restart(settings, container)
    try:
        assert fresh.scheduler_bound is False  # nothing has constructed a service yet
        await rehydrate(fresh)
        assert fresh.scheduler_bound is True

        # A tick now produces a real ingestion row, end to end.
        due = datetime.now(UTC) + timedelta(days=2)
        fired = await fresh.scheduler.tick(now=due)
        assert fired == [sched["id"]]

        async with fresh.db.tenant_session(TENANT_A) as session:
            rows = (
                await session.execute(
                    sa.select(Ingestion).where(Ingestion.schedule_id == sched["id"])
                )
            ).scalars().all()
        assert len(rows) == 1
        assert rows[0].trigger == "schedule"
    finally:
        await fresh.db.dispose()


async def test_paused_and_deleted_schedules_are_not_restored(
    client, auth_a, container, settings
) -> None:
    _conn, paused = await make_schedule(client, auth_a, container)
    deleted = await make_second_schedule(client, auth_a, container, name="Second Warehouse")
    r = await client.post(f"/api/v1/schedules/{paused['id']}/pause", headers=auth_a)
    assert r.status_code == 200, r.text
    r = await client.delete(f"/api/v1/schedules/{deleted['id']}", headers=auth_a)
    assert r.status_code == 204, r.text

    fresh = await _restart(settings, container)
    try:
        restored = await rehydrate(fresh)
        assert restored == 0
        assert fresh.scheduler.next_fire_at(paused["id"]) is None
        assert fresh.scheduler.next_fire_at(deleted["id"]) is None
    finally:
        await fresh.db.dispose()


async def test_rehydrate_restores_every_tenants_schedules(
    client, auth_a, auth_b, container, settings
) -> None:
    _ca, sa_ = await make_schedule(client, auth_a, container)
    _cb, sb = await make_schedule(client, auth_b, container)

    fresh = await _restart(settings, container)
    try:
        assert await rehydrate(fresh) == 2
        # Each schedule fires under its OWN tenant — a cross-tenant read at boot
        # must not collapse the tenant it belongs to.
        assert fresh.schedule_tenants[sa_["id"]] != fresh.schedule_tenants[sb["id"]]
    finally:
        await fresh.db.dispose()


async def test_one_failing_schedule_does_not_stop_the_others(container) -> None:
    """A tenant's broken connection must not stall the whole tick."""
    ScheduleService(container)
    fired: list[str] = []

    async def callback(schedule_id: str) -> None:
        if schedule_id == "boom":
            raise RuntimeError("connection refused")
        fired.append(schedule_id)

    container.scheduler.bind(callback)
    for sid in ("boom", "healthy"):
        await container.scheduler.register(sid, cron=None, interval_seconds=1, timezone="UTC")

    due = datetime.now(UTC) + timedelta(seconds=5)
    result = await container.scheduler.tick(now=due)

    assert fired == ["healthy"]
    assert result == ["healthy"]  # the failed one is reported as not fired
    # ...and its timer still advanced, so it does not re-fire on every poll.
    assert container.scheduler.next_fire_at("boom") > due


async def test_start_runs_the_loop_and_stop_cancels_it(container) -> None:
    fired: list[str] = []

    async def callback(schedule_id: str) -> None:
        fired.append(schedule_id)

    container.scheduler.bind(callback)
    await container.scheduler.register("s1", cron=None, interval_seconds=1, timezone="UTC")
    container.scheduler.start(poll_interval=0.05)
    try:
        for _ in range(60):
            await asyncio.sleep(0.05)
            if fired:
                break
        assert fired, "the background loop never fired a due schedule"
    finally:
        await container.scheduler.stop()

    count = len(fired)
    await asyncio.sleep(0.2)
    assert len(fired) == count, "stop() did not cancel the loop"


async def test_a_raising_callback_does_not_kill_the_loop(container) -> None:
    """The loop must outlive a failing fire — otherwise one bad schedule ends
    ALL scheduling for the life of the process behind a healthy /healthz."""
    calls: list[str] = []

    async def callback(schedule_id: str) -> None:
        calls.append(schedule_id)
        raise RuntimeError("boom")

    container.scheduler.bind(callback)
    await container.scheduler.register("s1", cron=None, interval_seconds=1, timezone="UTC")
    container.scheduler.start(poll_interval=0.05)
    try:
        for _ in range(80):
            await asyncio.sleep(0.05)
            if len(calls) >= 2:
                break
        assert len(calls) >= 2, f"loop died after the first failure (calls={len(calls)})"
    finally:
        await container.scheduler.stop()


async def test_rehydrate_survives_an_unparseable_persisted_schedule(
    client, auth_a, container, settings
) -> None:
    """Timing is validated on write, so this only happens to rows that predate a
    validation change — one of them must not cost everyone else their schedules.
    """
    _conn, good = await make_schedule(client, auth_a, container)
    bad = await make_second_schedule(client, auth_a, container, name="Legacy Warehouse")
    async with container.db.tenant_session(TENANT_A) as session:
        await session.execute(
            sa.update(Schedule).where(Schedule.id == bad["id"]).values(timezone="Mars/Olympus")
        )
        await session.commit()

    fresh = await _restart(settings, container)
    try:
        assert await rehydrate(fresh) == 1
        assert fresh.scheduler.next_fire_at(good["id"]) is not None
        assert fresh.scheduler.next_fire_at(bad["id"]) is None
    finally:
        await fresh.db.dispose()
