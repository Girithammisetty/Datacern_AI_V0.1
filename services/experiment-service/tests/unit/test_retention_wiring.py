"""Unit: the B6/B7 (BRD 58) retention sweep loop calls prune_table for both
outbox and processed_events with the expected specs, on the SAME GUC
(app.worker) the outbox relay/_distinct_tenants already use (migrations 0001
worker_outbox, 0004 worker_processed_events).

Exercises `retention_loop` directly against a minimal fake container (it is
already a standalone function taking `(container, stop)`, unlike the other 5
services' inline lifespan closures) so this proves real invocation behavior
without needing to boot the whole Kafka/Temporal lifespan."""

from __future__ import annotations

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from app.workers.loops import retention_loop


@pytest.mark.asyncio
async def test_retention_loop_prunes_both_tables_then_stops(monkeypatch):
    prune_mock = AsyncMock(return_value=1)
    monkeypatch.setattr("datacern_common.retention.prune_table", prune_mock)

    stop = asyncio.Event()
    call_count = 0

    async def fake_sleep_or_stop(_stop, _seconds):
        nonlocal call_count
        call_count += 1
        if call_count >= 2:
            stop.set()

    monkeypatch.setattr("app.workers.loops._sleep_or_stop", fake_sleep_or_stop)

    container = SimpleNamespace(extras={"session_factory": "sf-sentinel"})
    await retention_loop(container, stop)

    assert prune_mock.await_count == 2
    called_tables = [call.args[1].table for call in prune_mock.await_args_list]
    assert called_tables == ["outbox", "processed_events"]
    for call in prune_mock.await_args_list:
        called_sf, called_spec = call.args
        assert called_sf == "sf-sentinel"
        assert called_spec.worker_guc == "app.worker"


@pytest.mark.asyncio
async def test_retention_loop_noop_without_session_factory(monkeypatch):
    prune_mock = AsyncMock()
    monkeypatch.setattr("datacern_common.retention.prune_table", prune_mock)

    stop = asyncio.Event()
    container = SimpleNamespace(extras={})
    await retention_loop(container, stop)  # returns immediately, no session_factory

    prune_mock.assert_not_awaited()
