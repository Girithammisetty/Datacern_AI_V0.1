"""Case Streams (realtime-case-streams add-on, slice 3).

A Case Stream is the first-class object a business user means by "stream this
source into that department's worklist": one named, workspace-scoped binding of
a connection + a watermark-incremental schedule (+ optionally the case-service
CaseTrigger it feeds). The streaming engine is deliberately NOT new code — the
underlying Schedule row carries the watermark cursor and the Temporal timing,
and ingestion.completed events fire case-service triggers exactly as before.
This service composes and gates; it does not re-implement.

Entitlement (the add-on boundary): CREATE and RESUME require the tenant to
hold the `feature`-kind entitlement `realtime_case_streams`. Fail-closed
(CPL-NFR-004): a projection that cannot be consulted refuses with 503 rather
than granting; a present projection without the grant refuses with a 403 that
names the SKU. Pause and delete are never gated — a lapsed tenant can always
turn things off.
"""

from __future__ import annotations

from typing import Any

import sqlalchemy as sa

from app.api.auth import Principal
from app.api.schemas import CaseStreamCreate, CaseStreamPatch, ScheduleCreate
from app.container import Container
from app.domain.entitlements import (
    FEATURE_REALTIME_CASE_STREAMS,
    EntitlementStatus,
    check_feature,
)
from app.domain.errors import AppError, NotFoundError, PermissionDeniedError
from app.domain.services.schedules import ScheduleService
from app.store.models import CaseStream, utcnow


def _serialize(stream: CaseStream, schedule: dict[str, Any] | None) -> dict[str, Any]:
    out = {
        "id": stream.id,
        "workspace_id": stream.workspace_id,
        "name": stream.name,
        "connection_id": stream.connection_id,
        "schedule_id": stream.schedule_id,
        "case_trigger_id": stream.case_trigger_id,
        "status": stream.status,
        "created_by": stream.created_by,
        "created_at": stream.created_at.isoformat() if stream.created_at else None,
        "updated_at": stream.updated_at.isoformat() if stream.updated_at else None,
    }
    if schedule is not None:
        # The stream's live cursor, surfaced for the UX tiles: where the
        # watermark stands is literally "how far the stream has read".
        out["schedule"] = {
            "cron": schedule.get("cron"),
            "interval_seconds": schedule.get("interval_seconds"),
            "next_fire_at": schedule.get("next_fire_at"),
            "last_fired_at": schedule.get("last_fired_at"),
            "watermark": schedule.get("watermark"),
            "enabled": schedule.get("enabled"),
        }
    return out


class CaseStreamService:
    def __init__(self, container: Container) -> None:
        self.c = container
        self.schedules = ScheduleService(container)

    # ---- entitlement gate ----------------------------------------------------

    async def _gate(self, principal: Principal) -> None:
        status = await check_feature(
            getattr(self.c, "entitlements_redis", None),
            principal.tenant_id,
            FEATURE_REALTIME_CASE_STREAMS,
        )
        if status is EntitlementStatus.ENTITLED:
            return
        if status is EntitlementStatus.BLOCKED:
            raise PermissionDeniedError(
                "case streams require the realtime-case-streams add-on "
                "(feature entitlement 'realtime_case_streams'); contact your "
                "administrator to enable the SKU for this tenant"
            )
        raise AppError(
            "cannot verify the realtime-case-streams entitlement right now; "
            "refusing to start a stream rather than granting it unchecked",
            code="ENTITLEMENT_UNAVAILABLE",
            status=503,
        )

    # ---- lifecycle -----------------------------------------------------------

    async def create(self, principal: Principal, body: CaseStreamCreate) -> dict[str, Any]:
        await self._gate(principal)
        # Compose the watermark schedule through the EXISTS path — connection
        # validation, template validation, timing validation, Temporal
        # registration and serialization all stay in one place.
        sched = await self.schedules.create(
            principal,
            ScheduleCreate(
                connection_id=body.connection_id,
                ingestion_template=body.ingestion_template,
                cron=body.cron,
                interval_seconds=body.interval_seconds,
                timezone=body.timezone,
                watermark=body.watermark,
                overlap_policy=body.overlap_policy,
                enabled=body.enabled,
                workspace_id=body.workspace_id,
            ),
        )
        async with self.c.db.tenant_session(principal.tenant_id) as session:
            stream = CaseStream(
                tenant_id=principal.tenant_id,
                workspace_id=body.workspace_id,
                name=body.name,
                connection_id=body.connection_id,
                schedule_id=sched["id"],
                case_trigger_id=body.case_trigger_id,
                status="active" if body.enabled else "paused",
                created_by=principal.sub,
            )
            session.add(stream)
            try:
                await session.commit()
            except sa.exc.IntegrityError as exc:
                raise AppError(
                    f"a case stream named {body.name!r} already exists in this workspace",
                    code="CONFLICT",
                    status=409,
                ) from exc
            await session.refresh(stream)
            return _serialize(stream, sched)

    async def _get_row(self, session, principal: Principal, stream_id: str) -> CaseStream:
        row = await session.get(CaseStream, stream_id)
        if row is None or row.tenant_id != principal.tenant_id or row.deleted_at is not None:
            raise NotFoundError("case stream not found")
        return row

    async def get(self, principal: Principal, stream_id: str) -> dict[str, Any]:
        async with self.c.db.tenant_session(principal.tenant_id) as session:
            row = await self._get_row(session, principal, stream_id)
            sched = await self.schedules.get(principal, row.schedule_id)
            return _serialize(row, sched)

    async def list(self, principal: Principal, workspace_id: str | None) -> list[dict[str, Any]]:
        async with self.c.db.tenant_session(principal.tenant_id) as session:
            stmt = (
                sa.select(CaseStream)
                .where(CaseStream.deleted_at.is_(None))
                .order_by(CaseStream.created_at.desc())
            )
            if workspace_id:
                stmt = stmt.where(CaseStream.workspace_id == workspace_id)
            rows = (await session.execute(stmt)).scalars().all()
            return [_serialize(r, None) for r in rows]

    async def pause(self, principal: Principal, stream_id: str) -> dict[str, Any]:
        # Never gated: a lapsed tenant can always turn a stream off.
        async with self.c.db.tenant_session(principal.tenant_id) as session:
            row = await self._get_row(session, principal, stream_id)
            sched = await self.schedules.pause(principal, row.schedule_id)
            row.status = "paused"
            row.updated_at = utcnow()
            await session.commit()
            await session.refresh(row)
            return _serialize(row, sched)

    async def resume(self, principal: Principal, stream_id: str) -> dict[str, Any]:
        # Gated like create: resuming restarts billable streaming intake, and a
        # lapsed entitlement must refuse here too (CPL-FR-022 precedent).
        await self._gate(principal)
        async with self.c.db.tenant_session(principal.tenant_id) as session:
            row = await self._get_row(session, principal, stream_id)
            sched = await self.schedules.resume(principal, row.schedule_id)
            row.status = "active"
            row.updated_at = utcnow()
            await session.commit()
            await session.refresh(row)
            return _serialize(row, sched)

    async def patch(
        self, principal: Principal, stream_id: str, body: CaseStreamPatch
    ) -> dict[str, Any]:
        async with self.c.db.tenant_session(principal.tenant_id) as session:
            row = await self._get_row(session, principal, stream_id)
            row.case_trigger_id = body.case_trigger_id
            row.updated_at = utcnow()
            await session.commit()
            await session.refresh(row)
            return _serialize(row, None)

    async def delete(self, principal: Principal, stream_id: str) -> None:
        # Never gated. The underlying schedule is deleted through the existing
        # path (Temporal deregistration included); the stream row soft-deletes
        # so the name frees up while history stays queryable.
        async with self.c.db.tenant_session(principal.tenant_id) as session:
            row = await self._get_row(session, principal, stream_id)
            await self.schedules.delete(principal, row.schedule_id)
            row.deleted_at = utcnow()
            row.status = "paused"
            await session.commit()
