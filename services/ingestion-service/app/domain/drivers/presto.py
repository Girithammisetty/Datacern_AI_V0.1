"""Presto / Trino dialect for the DB-API harness (trino-python-client).

`presto` was the last declared connector type with no driver at all: it could be
created, tested, and previewed, and then every query job failed
UNSUPPORTED_CONNECTOR. The config model already said "Execution via Trino
driver (V1 'presto' parity)" — this is that driver.

Unlike the other warehouse dialects this one is NOT credential-gated: the local
stack runs a real Trino coordinator, so the adapter is verified end-to-end
against a live server rather than only through an injected connection.

The client's paramstyle is ``qmark``, so the watermark binds as ``?`` with its
typed value carried out-of-band — never spliced into the statement text
(ING-FR-061, BR-5).
"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel

from app.domain.drivers.dbapi import DbapiDialect
from app.domain.drivers.sql import to_qmark


def _connect(config: BaseModel, secrets: dict[str, str], timeout: float) -> Any:
    from trino import auth as trino_auth  # lazy: only on the real runtime path
    from trino import dbapi as trino_dbapi

    tls = bool(getattr(config, "tls", True))
    password = secrets.get("password")
    kwargs: dict[str, Any] = {
        "host": config.host,
        "port": getattr(config, "port", 8080),
        "user": config.username,
        "catalog": config.catalog,
        "http_scheme": "https" if tls else "http",
        "request_timeout": timeout,
    }
    # PrestoConfig declares the field as literally `schema` (BRD §4.2), which
    # shadows BaseModel.schema — getattr still resolves the instance value.
    schema = getattr(config, "schema", None)
    if isinstance(schema, str) and schema:
        kwargs["schema"] = schema
    if password:
        # BasicAuthentication is refused by the client over plain HTTP, which is
        # the correct behaviour — sending a password in the clear should fail
        # loudly here rather than on the wire.
        kwargs["auth"] = trino_auth.BasicAuthentication(config.username, password)
    return trino_dbapi.connect(**kwargs)


def presto_dialect() -> DbapiDialect:
    return DbapiDialect(name="presto", connect=_connect, translate=to_qmark)
