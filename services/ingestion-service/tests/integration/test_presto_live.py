"""Integration: the REAL Presto/Trino driver against a REAL Trino coordinator.

Unlike the other warehouse dialects this one is not credential-gated — Trino
runs as a container, so the whole path (connect → probe → columns → streamed
batches → bound watermark) is exercised for real, not through a mock.

Uses the coordinator the local stack already runs when it is up
(``TRINO_URL``/localhost:8080); otherwise starts one with testcontainers.
Skips with a clear reason when neither is available.
"""

from __future__ import annotations

import os
import urllib.request
from datetime import UTC, datetime

import pytest

from app.domain.connectors import PrestoConfig
from app.domain.drivers.dbapi import DbapiProber, DbapiQuerySource
from app.domain.drivers.presto import presto_dialect
from app.domain.watermark import WatermarkSpec, build_incremental_query

pytestmark = pytest.mark.integration


def _reachable(host: str, port: int) -> bool:
    try:
        with urllib.request.urlopen(f"http://{host}:{port}/v1/info", timeout=3) as resp:
            return resp.status == 200
    except Exception:  # noqa: BLE001
        return False


@pytest.fixture(scope="session")
def trino_endpoint():
    url = os.getenv("TRINO_URL", "http://localhost:8080")
    host = url.split("//", 1)[-1].split(":")[0]
    port = int(url.rsplit(":", 1)[-1].split("/")[0])
    if _reachable(host, port):
        yield host, port
        return
    try:
        from testcontainers.core.container import DockerContainer
        from testcontainers.core.waiting_utils import wait_for_logs
    except ImportError as exc:  # pragma: no cover
        pytest.skip(f"no Trino at {url} and testcontainers not installed: {exc}")
    try:
        container = DockerContainer("trinodb/trino:latest").with_exposed_ports(8080)
        container.start()
        wait_for_logs(container, "SERVER STARTED", timeout=300)
    except Exception as exc:  # noqa: BLE001 # pragma: no cover
        pytest.skip(f"no Trino at {url} and Docker unavailable: {exc}")
    yield container.get_container_host_ip(), int(container.get_exposed_port(8080))
    container.stop()


@pytest.fixture()
def config(trino_endpoint) -> PrestoConfig:
    host, port = trino_endpoint
    # `system` is the one catalog every Trino coordinator always exposes, with
    # no connector configured and nothing seeded — so this test runs against the
    # stack's own Trino (which only mounts `iceberg`) and against a bare
    # container alike. Row data comes from `sequence()`, not from a dataset.
    return PrestoConfig(
        host=host, port=port, catalog="system", username="datacern", tls=False,
        **{"schema": "runtime"},
    )


async def test_probe_succeeds_against_a_real_trino_coordinator(config) -> None:
    result = await DbapiProber(presto_dialect(), connect_timeout_s=30).probe(config, {})
    assert result.status == "ok", (result.error_category, result.error_detail)
    assert result.latency_ms >= 0


async def test_probe_reports_source_unreachable_on_a_dead_port(config) -> None:
    dead = config.model_copy(update={"port": 1})
    result = await DbapiProber(presto_dialect(), connect_timeout_s=5).probe(dead, {})
    assert result.status == "failed"
    # Honest, categorized failure — never a silent "ok".
    assert result.error_category in ("SOURCE_UNREACHABLE", "TIMEOUT")


async def test_columns_introspects_without_fetching_rows(config) -> None:
    cols = await DbapiQuerySource(presto_dialect(), query_timeout_s=60).columns(
        config, {}, "SELECT node_id, node_version FROM system.runtime.nodes"
    )
    assert [c.lower() for c in cols] == ["node_id", "node_version"]


async def test_streams_real_rows_in_bounded_batches(config) -> None:
    source = DbapiQuerySource(presto_dialect(), query_timeout_s=60)
    batches = []
    async for batch in source.execute(
        config, {}, "SELECT n FROM UNNEST(sequence(1, 250)) AS t(n)", {}, 100
    ):
        batches.append(batch)
    rows = [r for b in batches for r in b]
    assert len(rows) == 250
    assert all(len(b) <= 100 for b in batches)  # bounded — never one giant list
    assert sorted(r["n"] for r in rows) == list(range(1, 251))


async def test_watermark_is_bound_as_a_parameter_not_spliced(config) -> None:
    """The whole point of to_qmark: the incremental bound reaches Trino as a
    driver parameter. If it were spliced as text this would still return rows,
    so assert on the SQL the harness sent as well as the result."""
    sql, params = build_incremental_query(
        "SELECT n FROM UNNEST(sequence(1, 250)) AS t(n)",
        WatermarkSpec(column="n", operator=">", value_type="int", value="245"),
    )
    assert ":watermark" in sql and "245" not in sql

    source = DbapiQuerySource(presto_dialect(), query_timeout_s=60)
    rows: list[dict] = []
    async for batch in source.execute(config, {}, sql, params, 100):
        rows.extend(batch)

    assert sorted(r["n"] for r in rows) == [246, 247, 248, 249, 250]


async def test_datetime_watermark_binds_as_a_typed_value(config) -> None:
    """A timestamp bound has to survive as a typed value through the client —
    a spliced ISO string would fail to parse or silently compare as text."""
    since = datetime(2026, 1, 8, tzinfo=UTC).date().isoformat()
    sql, params = build_incremental_query(
        "SELECT n, date_add('day', n, DATE '2026-01-01') AS d "
        "FROM UNNEST(sequence(1, 10)) AS t(n)",
        WatermarkSpec(column="d", operator=">", value_type="date", value=since),
    )
    assert since not in sql  # the date never enters the statement text

    source = DbapiQuerySource(presto_dialect(), query_timeout_s=60)
    rows: list[dict] = []
    async for batch in source.execute(config, {}, sql, params, 500):
        rows.extend(batch)

    assert [r["n"] for r in rows] == [8, 9, 10]
    assert all(r["d"].isoformat() > since for r in rows)
