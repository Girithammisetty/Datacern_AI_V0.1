"""Unit: the B6 (BRD 58) retention sweep loop actually calls prune_table for
the outbox table with the expected spec, and does so on the SAME GUC
(app.worker) the outbox relay itself uses (migration 0002 worker_outbox).

Exercises `_run_retention_loop` directly (module-level, not a nested lifespan
closure) so this proves real invocation behavior without needing to boot the
whole Temporal/Kafka lifespan."""

from __future__ import annotations

import asyncio
from datetime import timedelta
from unittest.mock import AsyncMock

import pytest
from datacern_common.retention import RetentionSpec

from app.main import _run_retention_loop


@pytest.mark.asyncio
async def test_run_retention_loop_prunes_outbox_each_tick(monkeypatch):
    prune_mock = AsyncMock(return_value=2)
    monkeypatch.setattr("datacern_common.retention.prune_table", prune_mock)

    tick_count = 0

    async def fast_sleep(_seconds):
        nonlocal tick_count
        tick_count += 1
        if tick_count >= 2:
            raise asyncio.CancelledError()

    monkeypatch.setattr("app.main.asyncio.sleep", fast_sleep)

    spec = RetentionSpec(
        table="outbox", ts_col="published_at", retention=timedelta(days=30),
        require_not_null=True, worker_guc="app.worker", worker_val="true",
    )

    with pytest.raises(asyncio.CancelledError):
        await _run_retention_loop("sf-sentinel", [spec], interval_seconds=9999)

    assert prune_mock.await_count == 1
    called_sf, called_spec = prune_mock.await_args_list[0].args
    assert called_sf == "sf-sentinel"
    assert called_spec.table == "outbox"
    assert called_spec.worker_guc == "app.worker"
