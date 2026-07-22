"""B6/B7 (BRD 58): generic retention reaper — batching, identifier-safety and
SQL-shape, tested with a fake async session (no real database)."""

from __future__ import annotations

from datetime import timedelta

import pytest

from datacern_common.retention import RetentionSpec, UnsafeIdentifierError, prune_table


class _FakeResult:
    def __init__(self, rowcount: int) -> None:
        self.rowcount = rowcount


class _FakeSession:
    def __init__(self, rowcounts: list[int]) -> None:
        self._rowcounts = list(rowcounts)
        self.calls: list[tuple[str, dict]] = []

    async def execute(self, stmt, params):
        self.calls.append((str(stmt), dict(params)))
        n = self._rowcounts.pop(0) if self._rowcounts else 0
        return _FakeResult(n)

    async def commit(self) -> None:
        pass

    async def __aenter__(self) -> _FakeSession:
        return self

    async def __aexit__(self, *exc) -> None:
        pass


def _factory(session: _FakeSession):
    return lambda: session


async def test_single_batch_stops_after_one_call():
    session = _FakeSession([42])  # fewer than batch -> stop after 1 call
    spec = RetentionSpec(table="processed_events", ts_col="created_at",
                          retention=timedelta(hours=48), batch_size=1000)
    total = await prune_table(_factory(session), spec)
    assert total == 42
    assert len(session.calls) == 1


async def test_multiple_batches_until_partial():
    session = _FakeSession([5, 5, 2])  # two full batches then a partial
    spec = RetentionSpec(table="outbox", ts_col="published_at",
                          retention=timedelta(days=30), require_not_null=True, batch_size=5)
    total = await prune_table(_factory(session), spec)
    assert total == 12
    assert len(session.calls) == 3


async def test_nothing_to_prune():
    session = _FakeSession([0])
    spec = RetentionSpec(table="outbox", ts_col="published_at",
                          retention=timedelta(days=30), batch_size=1000)
    total = await prune_table(_factory(session), spec)
    assert total == 0


async def test_require_not_null_adds_guard_for_outbox():
    session = _FakeSession([0])
    spec = RetentionSpec(table="outbox", ts_col="published_at",
                          retention=timedelta(days=30), require_not_null=True)
    await prune_table(_factory(session), spec)
    sql, params = session.calls[0]
    assert "published_at IS NOT NULL" in sql
    assert params["retention_seconds"] == 30 * 24 * 3600


async def test_processed_events_has_no_not_null_guard():
    session = _FakeSession([0])
    spec = RetentionSpec(table="processed_events", ts_col="created_at",
                          retention=timedelta(hours=48))  # require_not_null defaults False
    await prune_table(_factory(session), spec)
    sql, _ = session.calls[0]
    assert "IS NOT NULL" not in sql


@pytest.mark.parametrize("bad_table", [
    "outbox; DROP TABLE users", "out box", "1outbox", "", "outbox--",
])
async def test_rejects_unsafe_table_name(bad_table):
    spec = RetentionSpec(table=bad_table, ts_col="created_at", retention=timedelta(hours=1))
    with pytest.raises(UnsafeIdentifierError):
        await prune_table(_factory(_FakeSession([0])), spec)


async def test_rejects_unsafe_column_name():
    spec = RetentionSpec(table="outbox", ts_col="ts; DROP TABLE x", retention=timedelta(hours=1))
    with pytest.raises(UnsafeIdentifierError):
        await prune_table(_factory(_FakeSession([0])), spec)


async def test_default_batch_size_is_1000():
    session = _FakeSession([0])
    spec = RetentionSpec(table="outbox", ts_col="published_at", retention=timedelta(days=1))
    await prune_table(_factory(session), spec)
    _, params = session.calls[0]
    assert params["batch"] == 1000


async def test_worker_guc_set_before_each_batch_delete():
    # 2 calls per batch (set_config + delete); two full batches then a partial.
    session = _FakeSession([0, 5, 0, 5, 0, 2])
    spec = RetentionSpec(table="outbox", ts_col="published_at", retention=timedelta(days=30),
                          require_not_null=True, batch_size=5,
                          worker_guc="app.worker", worker_val="true")
    total = await prune_table(_factory(session), spec)
    assert total == 12
    assert len(session.calls) == 6  # 3 batches x (set_config, delete)
    for i in (0, 2, 4):
        sql, params = session.calls[i]
        assert "set_config" in sql
        assert params == {"guc": "app.worker", "val": "true"}


async def test_no_worker_guc_skips_set_config():
    session = _FakeSession([3])
    spec = RetentionSpec(table="processed_events", ts_col="created_at",
                          retention=timedelta(hours=48))  # worker_guc unset
    total = await prune_table(_factory(session), spec)
    assert total == 3
    assert len(session.calls) == 1  # delete only, no set_config


async def test_rejects_unsafe_worker_guc():
    spec = RetentionSpec(table="outbox", ts_col="published_at", retention=timedelta(days=1),
                          worker_guc="app.worker; DROP TABLE x")
    with pytest.raises(UnsafeIdentifierError):
        await prune_table(_factory(_FakeSession([0])), spec)
