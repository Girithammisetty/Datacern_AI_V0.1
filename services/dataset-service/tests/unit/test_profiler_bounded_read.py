"""Unit: InProcessProfilerRunner reads snapshots through the bounded
`read_snapshot_head` path, never the unbounded `read_snapshot`.

Regression test for the bug where the profiler loaded an ENTIRE Iceberg
snapshot into a pandas DataFrame (`read_snapshot`) before profile_dataframe's
own `max_rows` sampling ever ran -- meaning a 10M-row table was fully
materialized in memory before ever being sampled down. The fix swaps to the
already-existing bounded reader `read_snapshot_head(..., max_rows=...)` (the
same primitive `app/domain/services.py`'s `read_rows`/`resolve_entities` use)
so the row cap applies at READ time, not after full materialization.
"""

from __future__ import annotations

import pandas as pd
import pytest

from app.adapters.catalog import LocalCatalog
from app.adapters.object_store import LocalFSObjectStore
from app.adapters.profiler_runner import InProcessProfilerRunner
from app.domain.ports import ProfileJobSpec
from app.utils import Clock


class _SpyCatalog:
    """Wraps a real LocalCatalog and records which read method was called,
    so the test fails loudly if the runner ever regresses to the unbounded
    `read_snapshot` call for a snapshot larger than max_rows."""

    def __init__(self, inner: LocalCatalog):
        self._inner = inner
        self.read_snapshot_calls: list[tuple[str, int]] = []
        self.read_snapshot_head_calls: list[tuple[str, int, int]] = []

    async def read_snapshot(self, table: str, snapshot_id: int) -> pd.DataFrame:
        self.read_snapshot_calls.append((table, snapshot_id))
        return await self._inner.read_snapshot(table, snapshot_id)

    async def read_snapshot_head(self, table: str, snapshot_id: int, max_rows: int):
        self.read_snapshot_head_calls.append((table, snapshot_id, max_rows))
        return await self._inner.read_snapshot_head(table, snapshot_id, max_rows)

    def __getattr__(self, name):
        return getattr(self._inner, name)


@pytest.mark.asyncio
async def test_profiler_uses_bounded_head_read_not_full_snapshot(tmp_path):
    inner = LocalCatalog(str(tmp_path / "catalog"))
    catalog = _SpyCatalog(inner)
    object_store = LocalFSObjectStore(str(tmp_path / "objects"))

    # 500 rows in the "snapshot", but max_rows=50 -- the OOM scenario is any
    # total_rows > max_rows, just at a size cheap enough to unit-test fast.
    df = pd.DataFrame({"a": range(500), "b": [str(i) for i in range(500)]})
    await catalog.commit_snapshot("t1", 1, df)

    reported: dict = {}

    async def reporter(spec, body):
        reported["body"] = body

    runner = InProcessProfilerRunner(
        catalog, object_store, reporter, profiler_version="test/1",
        clock=Clock(), max_rows=50,
    )
    spec = ProfileJobSpec(
        tenant_id="t1", dataset_id="d1", dataset_urn="wr:t1:dataset:dataset/d1",
        version_no=1, profile_id="p1", iceberg_table="t1", iceberg_snapshot_id=1,
        sample_strategy="full", callback_token="tok", output_prefix="profiles/p1",
    )

    await runner.launch(spec)

    # The unbounded whole-table reader must never be called for a snapshot
    # that exceeds max_rows.
    assert catalog.read_snapshot_calls == []
    assert catalog.read_snapshot_head_calls == [("t1", 1, 50)]

    assert reported["body"]["status"] == "completed"
    assert reported["body"]["summary"]["table"]["row_count"] <= 50
