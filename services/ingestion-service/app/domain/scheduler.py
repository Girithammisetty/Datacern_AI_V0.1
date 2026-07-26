"""Scheduler port (ING-FR-060/062/063).

InProcessScheduler is an APScheduler-style in-process implementation: it
computes next-fire times from cron/interval specs and fires a bound async
callback (tests drive `tick`/`run_now` deterministically; a background loop is
available via `start()`). It is the ONLY scheduler this deployment runs —
in-process cron is real logic, not a stub, in both the "memory" and "real"
container wirings (see `app/container.py`). ingestion-service is not part of
the Temporal-dependent service set (`deploy/services.yaml` lists Temporal only
for `agent-runtime`); a Temporal-backed scheduler is not available here.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Protocol
from zoneinfo import ZoneInfo

from croniter import croniter

logger = logging.getLogger(__name__)

FireCallback = Callable[[str], Awaitable[None]]


@dataclass(slots=True)
class ScheduleEntry:
    schedule_id: str
    cron: str | None
    interval_seconds: int | None
    timezone: str
    paused: bool
    next_fire_at: datetime | None


class Scheduler(Protocol):
    def bind(self, callback: FireCallback) -> None: ...

    async def register(
        self,
        schedule_id: str,
        *,
        cron: str | None,
        interval_seconds: int | None,
        timezone: str,
    ) -> str: ...

    async def unregister(self, schedule_id: str) -> None: ...

    async def pause(self, schedule_id: str) -> None: ...

    async def resume(self, schedule_id: str) -> None: ...

    async def run_now(self, schedule_id: str) -> None: ...

    def next_fire_at(self, schedule_id: str) -> datetime | None: ...

    def start(self, poll_interval: float = ...) -> None: ...

    async def stop(self) -> None: ...


def compute_next_fire(
    cron: str | None, interval_seconds: int | None, timezone: str, now: datetime | None = None
) -> datetime:
    tz = ZoneInfo(timezone)
    base = (now or datetime.now(UTC)).astimezone(tz)
    if cron:
        return croniter(cron, base).get_next(datetime).astimezone(UTC)
    assert interval_seconds is not None
    return (base + timedelta(seconds=interval_seconds)).astimezone(UTC)


class InProcessScheduler:
    def __init__(self) -> None:
        self._entries: dict[str, ScheduleEntry] = {}
        self._callback: FireCallback | None = None
        self._task: asyncio.Task[None] | None = None

    def bind(self, callback: FireCallback) -> None:
        self._callback = callback

    async def register(
        self,
        schedule_id: str,
        *,
        cron: str | None,
        interval_seconds: int | None,
        timezone: str,
    ) -> str:
        self._entries[schedule_id] = ScheduleEntry(
            schedule_id=schedule_id,
            cron=cron,
            interval_seconds=interval_seconds,
            timezone=timezone,
            paused=False,
            next_fire_at=compute_next_fire(cron, interval_seconds, timezone),
        )
        return f"inproc-{schedule_id}"

    async def unregister(self, schedule_id: str) -> None:
        self._entries.pop(schedule_id, None)

    async def pause(self, schedule_id: str) -> None:
        if schedule_id in self._entries:
            self._entries[schedule_id].paused = True

    async def resume(self, schedule_id: str) -> None:
        entry = self._entries.get(schedule_id)
        if entry:
            entry.paused = False
            entry.next_fire_at = compute_next_fire(
                entry.cron, entry.interval_seconds, entry.timezone
            )

    async def run_now(self, schedule_id: str) -> None:
        if self._callback is None:
            raise RuntimeError("scheduler callback not bound")
        await self._callback(schedule_id)

    def next_fire_at(self, schedule_id: str) -> datetime | None:
        entry = self._entries.get(schedule_id)
        return entry.next_fire_at if entry else None

    async def tick(self, now: datetime | None = None) -> list[str]:
        """Fire all due entries; returns fired schedule ids (test-drivable).

        `next_fire_at` is advanced BEFORE the callback runs and a failing fire
        is logged rather than raised: one tenant's broken connection must not
        stall every other tenant's schedules behind it, and must not leave an
        entry stuck in the past where it re-fires on every poll.
        """
        now = now or datetime.now(UTC)
        fired = []
        for entry in list(self._entries.values()):
            if entry.paused or entry.next_fire_at is None or entry.next_fire_at > now:
                continue
            entry.next_fire_at = compute_next_fire(
                entry.cron, entry.interval_seconds, entry.timezone, now
            )
            if self._callback is not None:
                try:
                    await self._callback(entry.schedule_id)
                except asyncio.CancelledError:
                    raise
                except Exception:  # noqa: BLE001
                    logger.exception(
                        "scheduled fire failed", extra={"schedule_id": entry.schedule_id}
                    )
                    continue
            fired.append(entry.schedule_id)
        return fired

    def start(self, poll_interval: float = 1.0) -> None:
        """Run the poll loop in the background until `stop()`.

        The loop swallows non-cancellation errors on purpose: an unhandled one
        would kill the task and silently end ALL scheduling for the life of the
        process, with a healthy /healthz the whole time.
        """

        async def _loop() -> None:
            while True:
                try:
                    await asyncio.sleep(poll_interval)
                    await self.tick()
                except asyncio.CancelledError:
                    break
                except Exception:  # noqa: BLE001
                    logger.exception("scheduler tick failed")
                    await asyncio.sleep(poll_interval)

        self._task = asyncio.get_running_loop().create_task(_loop())

    async def stop(self) -> None:
        if self._task is not None:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._task
            self._task = None
