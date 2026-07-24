"""Unit: the B6/B7 (BRD 58) retention sweep loop calls prune_table for both
outbox and processed_events with the expected specs, on the SAME GUC
(app.worker) the outbox relay already uses (migrations 0001 worker_outbox,
0003 worker_processed_events).

Exercises `_run_retention_loop` directly (module-level, not a nested lifespan
closure) so this proves real invocation behavior without needing to boot the
whole Kafka lifespan."""

from __future__ import annotations

import asyncio
from datetime import timedelta
from unittest.mock import AsyncMock

import pytest
from datacern_common.retention import RetentionSpec

from app.main import _run_retention_loop


@pytest.mark.asyncio
async def test_run_retention_loop_prunes_both_tables_each_tick(monkeypatch):
    prune_mock = AsyncMock(return_value=1)
    monkeypatch.setattr("datacern_common.retention.prune_table", prune_mock)

    tick_count = 0

    async def fast_sleep(_seconds):
        nonlocal tick_count
        tick_count += 1
        if tick_count >= 2:
            raise asyncio.CancelledError()

    monkeypatch.setattr("app.main.asyncio.sleep", fast_sleep)

    specs = [
        RetentionSpec(table="outbox", ts_col="published_at",
                      retention=timedelta(days=30), require_not_null=True,
                      worker_guc="app.worker", worker_val="true"),
        RetentionSpec(table="processed_events", ts_col="created_at",
                      retention=timedelta(hours=48),
                      worker_guc="app.worker", worker_val="true"),
    ]

    with pytest.raises(asyncio.CancelledError):
        await _run_retention_loop("sf-sentinel", specs, interval_seconds=9999)

    assert prune_mock.await_count == 2
    called_tables = [call.args[1].table for call in prune_mock.await_args_list]
    assert called_tables == ["outbox", "processed_events"]
    for call in prune_mock.await_args_list:
        called_sf, called_spec = call.args
        assert called_sf == "sf-sentinel"
        assert called_spec.worker_guc == "app.worker"
