"""Persistence for installs + the materialization ledger (RLS-scoped)."""

from __future__ import annotations

import json
from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncConnection


def _row(m) -> dict:
    return dict(m._mapping)


async def create_install(
    conn: AsyncConnection, *, install_id: str, tenant_id: str, workspace_id: str,
    pack_name: str, pack_version: str, status: str, plan: list[dict],
    created_by: str | None,
) -> None:
    await conn.execute(
        text(
            """
            INSERT INTO installs
              (id, tenant_id, workspace_id, pack_name, pack_version, status, plan, created_by)
            VALUES
              (:id, :tid, :ws, :name, :ver, :status, :plan, :by)
            """
        ),
        {
            "id": install_id, "tid": tenant_id, "ws": workspace_id,
            "name": pack_name, "ver": pack_version, "status": status,
            "plan": json.dumps(plan), "by": created_by,
        },
    )


async def set_install_status(
    conn: AsyncConnection, install_id: str, status: str, summary: dict | None = None
) -> None:
    await conn.execute(
        text(
            """
            UPDATE installs
               SET status = :status,
                   summary = COALESCE(CAST(:summary AS jsonb), summary),
                   updated_at = now()
             WHERE id = :id
            """
        ),
        {"id": install_id, "status": status,
         "summary": json.dumps(summary) if summary is not None else None},
    )


async def add_materialized(conn: AsyncConnection, install_id: str, tenant_id: str,
                           records: list[dict]) -> None:
    for r in records:
        await conn.execute(
            text(
                """
                INSERT INTO materialized_objects
                  (id, install_id, tenant_id, kind, identity, target_urn, target_id,
                   origin, action, detail, reversible, tombstoned)
                VALUES
                  (:id, :install, :tid, :kind, :identity, :urn, :target_id,
                   :origin, :action, :detail, :reversible, false)
                """
            ),
            {
                "id": r["id"], "install": install_id, "tid": tenant_id,
                "kind": r["kind"], "identity": r["identity"],
                "urn": r.get("target_urn"), "target_id": r.get("target_id"),
                "origin": r["origin"], "action": r["action"],
                "detail": r.get("detail", ""), "reversible": bool(r.get("reversible", False)),
            },
        )


async def list_installs(conn: AsyncConnection, workspace_id: str | None) -> list[dict]:
    if workspace_id:
        res = await conn.execute(
            text("SELECT * FROM installs WHERE workspace_id = :ws ORDER BY created_at DESC"),
            {"ws": workspace_id},
        )
    else:
        res = await conn.execute(text("SELECT * FROM installs ORDER BY created_at DESC"))
    return [_row(m) for m in res]


async def get_install(conn: AsyncConnection, install_id: str) -> dict | None:
    res = await conn.execute(text("SELECT * FROM installs WHERE id = :id"), {"id": install_id})
    m = res.first()
    return _row(m) if m else None


async def get_ledger(conn: AsyncConnection, install_id: str) -> list[dict]:
    res = await conn.execute(
        text(
            "SELECT * FROM materialized_objects WHERE install_id = :id ORDER BY created_at"
        ),
        {"id": install_id},
    )
    return [_row(m) for m in res]


async def mark_tombstoned(conn: AsyncConnection, ledger_id: str, detail: str) -> None:
    await conn.execute(
        text(
            "UPDATE materialized_objects SET tombstoned = true, detail = :d WHERE id = :id"
        ),
        {"id": ledger_id, "d": detail},
    )


def jloads(v: Any) -> Any:
    if isinstance(v, str):
        return json.loads(v)
    return v
