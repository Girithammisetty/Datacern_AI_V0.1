"""Presto / Trino driver — the last declared connector type with no driver.

Before this, a `presto` connection could be created, tested and previewed, and
then every query job failed UNSUPPORTED_CONNECTOR. These tests pin the binding
contract (watermark as a `?` parameter, never spliced) and the wiring; the live
counterpart against the local Trino coordinator is in
tests/integration/test_presto_live.py.
"""

from __future__ import annotations

from dataclasses import replace
from datetime import UTC, datetime

import pytest

from app.domain.connectors import PrestoConfig
from app.domain.drivers.dbapi import DbapiQuerySource
from app.domain.drivers.presto import _connect, presto_dialect
from app.domain.drivers.sql import to_qmark
from app.domain.watermark import WatermarkSpec, build_incremental_query
from tests.unit.test_cloud_driver_contracts import _FakeConn, _FakeCursor

WM = datetime(2026, 7, 1, tzinfo=UTC)
WRAPPED_SQL, WRAPPED_PARAMS = build_incremental_query(
    "SELECT * FROM orders",
    WatermarkSpec(
        column="updated_at", operator=">", value_type="timestamp", value="2026-07-01T00:00:00Z"
    ),
)

CONFIG = PrestoConfig(host="trino.internal", catalog="hive", username="ro", tls=False)


# ------------------------------------------------------------------- to_qmark


def test_to_qmark_translates_named_placeholders_positionally() -> None:
    sql, values = to_qmark("SELECT * FROM t WHERE a > :x AND b < :y", {"x": 1, "y": 2})
    assert sql == "SELECT * FROM t WHERE a > ? AND b < ?"
    assert values == [1, 2]


def test_to_qmark_repeats_a_reused_name_positionally() -> None:
    sql, values = to_qmark("SELECT :x, :x", {"x": 7})
    assert sql == "SELECT ?, ?"
    assert values == [7, 7]  # qmark has no names — the value must appear twice


def test_to_qmark_leaves_literal_percent_alone() -> None:
    """to_format doubles `%` because it interpolates. qmark does not, so
    doubling here would corrupt a LIKE pattern into `%%acme%%`."""
    sql, values = to_qmark("SELECT * FROM t WHERE name LIKE '%acme%' AND id > :x", {"x": 1})
    assert "'%acme%'" in sql
    assert values == [1]


def test_to_qmark_raises_on_a_missing_parameter() -> None:
    """Never silently fall back to text substitution."""
    with pytest.raises(KeyError):
        to_qmark("SELECT * FROM t WHERE a > :missing", {})


def test_to_qmark_ignores_postgres_casts() -> None:
    sql, values = to_qmark("SELECT a::text FROM t WHERE b > :x", {"x": 1})
    assert sql == "SELECT a::text FROM t WHERE b > ?"
    assert values == [1]


# --------------------------------------------------------------- binding path


async def test_presto_binds_the_watermark_as_a_qmark_parameter() -> None:
    cursor = _FakeCursor(
        rows=[{"id": 1, "updated_at": "2026-07-02T00:00:00+00:00"}],
        description=[("id",), ("updated_at",)],
    )
    dialect = replace(presto_dialect(), connect=lambda cfg, sec, to: _FakeConn(cursor))
    source = DbapiQuerySource(dialect)

    rows = []
    async for batch in source.execute(CONFIG, {"password": "p"}, WRAPPED_SQL, WRAPPED_PARAMS, 10):
        rows.extend(batch)
    assert rows == [{"id": 1, "updated_at": "2026-07-02T00:00:00+00:00"}]

    sent_sql, sent_params = cursor.executed[-1]
    assert sent_sql.endswith("WHERE updated_at > ?")
    assert "2026" not in sent_sql  # the value never enters the query text
    assert isinstance(sent_params, list)
    assert sent_params[0] == WM  # typed datetime, carried out-of-band


# --------------------------------------------------------------- connect args


def _capture_connect(monkeypatch) -> dict:
    """Intercept the real trino client's `connect` so the kwarg shaping can be
    asserted without opening a socket."""
    import trino.dbapi as trino_dbapi

    captured: dict = {}
    monkeypatch.setattr(
        trino_dbapi, "connect", lambda **kw: captured.update(kw) or object()
    )
    return captured


def test_connect_uses_plain_http_when_tls_is_off(monkeypatch) -> None:
    captured = _capture_connect(monkeypatch)
    _connect(CONFIG, {}, 12.0)

    assert captured["http_scheme"] == "http"
    assert captured["host"] == "trino.internal"
    assert captured["catalog"] == "hive"
    assert captured["user"] == "ro"
    assert captured["request_timeout"] == 12.0
    assert "auth" not in captured  # no password supplied -> no auth object
    assert "schema" not in captured  # schema is optional and unset here


def test_connect_passes_schema_and_tls_when_configured(monkeypatch) -> None:
    captured = _capture_connect(monkeypatch)
    _connect(
        PrestoConfig(host="h", catalog="c", username="u", tls=True, **{"schema": "public"}),
        {},
        5.0,
    )
    assert captured["http_scheme"] == "https"
    # `schema` shadows BaseModel.schema on the config model — assert the
    # instance value reaches the driver, not the bound pydantic method.
    assert captured["schema"] == "public"


def test_connect_attaches_basic_auth_only_when_a_password_is_stored(monkeypatch) -> None:
    from trino.auth import BasicAuthentication

    captured = _capture_connect(monkeypatch)
    _connect(
        PrestoConfig(host="h", catalog="c", username="u", tls=True), {"password": "pw"}, 5.0
    )
    assert isinstance(captured["auth"], BasicAuthentication)


# -------------------------------------------------------------------- wiring


def test_real_container_wires_a_real_presto_driver(tmp_path) -> None:
    from app.config import Settings
    from app.container import _build_real
    from app.domain.probers import UnsupportedConnectorProber
    from app.domain.querysource import UnsupportedQuerySource

    c = _build_real(
        Settings(
            database_url=f"sqlite+aiosqlite:///{tmp_path}/real.db",
            adapter_mode="real",
            data_dir=str(tmp_path / "data"),
        )
    )
    assert not isinstance(c.probers.get("presto"), UnsupportedConnectorProber)
    assert not isinstance(c.query_sources.get("presto"), UnsupportedQuerySource)
