"""SQL repositories + RLS unit of work (MASTER-FR-001/034).

Each tenant UoW opens a transaction and sets ``app.tenant_id`` so Postgres RLS
applies to the non-privileged app role. The outbox relay uses a worker session
(``app.worker=true``). Components/algorithm_templates are global (no RLS)."""

from __future__ import annotations

import dataclasses
import os
from datetime import datetime

from sqlalchemy import and_, func, or_, select, text, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import (
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from app.domain.entities import (
    BatchJob,
    BatchJobRun,
    BatchJobRunIngestion,
    LabeledExample,
    PipelineRun,
    PipelineSchedule,
    PipelineTemplate,
    TemplateVersion,
    TenantQuota,
)
from app.domain.enums import BATCH_ACTIVE_STATUSES, RunStatus
from app.domain.ports import Page
from app.store.orm import (
    BatchJobRow,
    BatchJobRunIngestionRow,
    BatchJobRunRow,
    IdempotencyKeyRow,
    LabeledExampleRow,
    OutboxRow,
    PipelineScheduleRow,
    ProcessedEventRow,
    QuotaRow,
    RunQueueRow,
    RunRow,
    TemplateRow,
    VersionRow,
)
from app.utils import decode_cursor, encode_cursor, new_id, utcnow

_T_FIELDS = [f.name for f in dataclasses.fields(PipelineTemplate)]
_V_FIELDS = [f.name for f in dataclasses.fields(TemplateVersion)]
_R_FIELDS = [f.name for f in dataclasses.fields(PipelineRun)]
#: Lease columns are written ONLY by claim_lease/renew_lease/release_lease, never
#: by a whole-row update — see SqlRunRepo.update.
_LEASE_FIELDS = ("lease_owner", "lease_expires_at")
_R_UPDATE_FIELDS = [f for f in _R_FIELDS if f not in _LEASE_FIELDS]
_L_FIELDS = [f.name for f in dataclasses.fields(LabeledExample)]
_S_FIELDS = [f.name for f in dataclasses.fields(PipelineSchedule)]
_BJ_FIELDS = [f.name for f in dataclasses.fields(BatchJob)]
_BR_FIELDS = [f.name for f in dataclasses.fields(BatchJobRun)]
#: Same rule as pipeline_runs: the lease belongs to claim/renew/release alone.
_BR_UPDATE_FIELDS = [f for f in _BR_FIELDS if f not in _LEASE_FIELDS]
_BI_FIELDS = [f.name for f in dataclasses.fields(BatchJobRunIngestion)]
_BATCH_ACTIVE = [int(s) for s in BATCH_ACTIVE_STATUSES]


def make_engine(database_url: str):
    return create_async_engine(
        database_url,
        pool_pre_ping=True,
        pool_size=int(os.getenv("DB_POOL_SIZE", "10")),
        max_overflow=int(os.getenv("DB_MAX_OVERFLOW", "10")),
    )


def _to(row, fields, cls):
    return cls(**{f: getattr(row, f) for f in fields})


def _apply(row, entity, fields):
    for f in fields:
        setattr(row, f, getattr(entity, f))


def _page(rows, limit, cursor):
    offset = int(decode_cursor(cursor).get("o", 0)) if cursor else 0
    has_more = len(rows) > limit
    return Page(items=rows[:limit],
                next_cursor=encode_cursor({"o": offset + limit}) if has_more else None,
                has_more=has_more)


class SqlTemplateRepo:
    def __init__(self, s, tid):
        self.s, self.tid = s, tid

    async def add(self, t):
        row = TemplateRow()
        _apply(row, t, _T_FIELDS)
        self.s.add(row)
        await self.s.flush()

    async def get(self, tid, include_deleted=False):
        row = await self.s.get(TemplateRow, tid)
        if row is None or (row.deleted_at is not None and not include_deleted):
            return None
        return _to(row, _T_FIELDS, PipelineTemplate)

    async def get_by_name(self, workspace_id, name):
        stmt = select(TemplateRow).where(
            TemplateRow.workspace_id == workspace_id,
            func.lower(TemplateRow.name) == name.lower(),
            TemplateRow.deleted_at.is_(None))
        row = (await self.s.execute(stmt)).scalars().first()
        return _to(row, _T_FIELDS, PipelineTemplate) if row else None

    async def update(self, t):
        row = await self.s.get(TemplateRow, t.id)
        if row is not None:
            _apply(row, t, _T_FIELDS)
            await self.s.flush()

    async def list(self, filters, limit, cursor):
        stmt = select(TemplateRow)
        if not filters.include_archived:
            stmt = stmt.where(TemplateRow.deleted_at.is_(None))
        if filters.name:
            stmt = stmt.where(TemplateRow.name.ilike(f"%{filters.name}%"))
        if filters.pipeline_type:
            from app.domain.enums import pipeline_type_from_str
            stmt = stmt.where(
                TemplateRow.pipeline_type == int(pipeline_type_from_str(
                    filters.pipeline_type)))
        if filters.workspace_id:
            stmt = stmt.where(TemplateRow.workspace_id == filters.workspace_id)
        offset = int(decode_cursor(cursor).get("o", 0)) if cursor else 0
        stmt = stmt.order_by(TemplateRow.created_at.desc(), TemplateRow.id.desc())
        rows = (await self.s.execute(stmt.offset(offset).limit(limit + 1))).scalars().all()
        return _page([_to(r, _T_FIELDS, PipelineTemplate) for r in rows], limit, cursor)


class SqlVersionRepo:
    def __init__(self, s, tid):
        self.s, self.tid = s, tid

    async def add(self, v):
        row = VersionRow()
        _apply(row, v, _V_FIELDS)
        self.s.add(row)
        await self.s.flush()

    async def get_by_id(self, vid):
        row = await self.s.get(VersionRow, vid)
        return _to(row, _V_FIELDS, TemplateVersion) if row else None

    async def get(self, template_id, version_no):
        stmt = select(VersionRow).where(VersionRow.template_id == template_id,
                                        VersionRow.version_no == version_no)
        row = (await self.s.execute(stmt)).scalars().first()
        return _to(row, _V_FIELDS, TemplateVersion) if row else None

    async def latest(self, template_id):
        stmt = (select(VersionRow).where(VersionRow.template_id == template_id)
                .order_by(VersionRow.version_no.desc()).limit(1))
        row = (await self.s.execute(stmt)).scalars().first()
        return _to(row, _V_FIELDS, TemplateVersion) if row else None

    async def list(self, template_id, limit, cursor):
        offset = int(decode_cursor(cursor).get("o", 0)) if cursor else 0
        stmt = (select(VersionRow).where(VersionRow.template_id == template_id)
                .order_by(VersionRow.version_no.desc()).offset(offset).limit(limit + 1))
        rows = (await self.s.execute(stmt)).scalars().all()
        return _page([_to(r, _V_FIELDS, TemplateVersion) for r in rows], limit, cursor)

    async def list_all(self, template_id):
        stmt = (select(VersionRow).where(VersionRow.template_id == template_id)
                .order_by(VersionRow.version_no.asc()))
        rows = (await self.s.execute(stmt)).scalars().all()
        return [_to(r, _V_FIELDS, TemplateVersion) for r in rows]

    async def next_version_no(self, template_id):
        await self.s.execute(
            text("SELECT pg_advisory_xact_lock(hashtextextended(:tid, 7))"),
            {"tid": template_id})
        result = await self.s.execute(
            select(func.coalesce(func.max(VersionRow.version_no), 0)).where(
                VersionRow.template_id == template_id))
        return int(result.scalar_one()) + 1

    async def update(self, v):
        row = await self.s.get(VersionRow, v.id)
        if row is not None:
            _apply(row, v, _V_FIELDS)
            await self.s.flush()


class SqlRunRepo:
    def __init__(self, s, tid):
        self.s, self.tid = s, tid

    async def add(self, r):
        row = RunRow()
        _apply(row, r, _R_FIELDS)
        self.s.add(row)
        await self.s.flush()

    async def get(self, rid):
        row = await self.s.get(RunRow, rid)
        return _to(row, _R_FIELDS, PipelineRun) if row else None

    async def update(self, r):
        row = await self.s.get(RunRow, r.id)
        if row is not None:
            # Never through here: the lease is owned by claim/renew/release alone.
            # A caller holds a PipelineRun it read before claiming, so writing the
            # whole row back would silently erase the lease it is holding — the
            # heartbeat would then find nothing to renew and the reaper would
            # eventually reclaim a run that is very much alive.
            _apply(row, r, _R_UPDATE_FIELDS)
            await self.s.flush()

    async def get_by_workflow(self, argo_workflow_name):
        stmt = select(RunRow).where(RunRow.argo_workflow_name == argo_workflow_name)
        row = (await self.s.execute(stmt)).scalars().first()
        return _to(row, _R_FIELDS, PipelineRun) if row else None

    async def list(self, filters, limit, cursor):
        stmt = select(RunRow)
        if filters.status:
            stmt = stmt.where(RunRow.status == int(RunStatus[filters.status]))
        if filters.template_id:
            stmt = stmt.where(RunRow.template_id == filters.template_id)
        offset = int(decode_cursor(cursor).get("o", 0)) if cursor else 0
        stmt = stmt.order_by(RunRow.created_at.desc(), RunRow.id.desc())
        rows = (await self.s.execute(stmt.offset(offset).limit(limit + 1))).scalars().all()
        return _page([_to(r, _R_FIELDS, PipelineRun) for r in rows], limit, cursor)

    async def count_active(self, tenant_id):
        active = [int(RunStatus.pending), int(RunStatus.submitted), int(RunStatus.running)]
        result = await self.s.execute(
            select(func.count()).select_from(RunRow).where(RunRow.status.in_(active)))
        return int(result.scalar_one())

    async def last_submission_at(self, tenant_id, submitted_by):
        result = await self.s.execute(
            select(func.max(func.coalesce(RunRow.submitted_at, RunRow.created_at)))
            .where(RunRow.submitted_by == submitted_by))
        return result.scalar_one_or_none()

    async def claim_lease(self, run_id, owner: str, now, expires_at) -> bool:
        """Take the driving lease for a run if it is free or expired as of ``now``.
        Returns whether we got it.

        One conditional UPDATE, so two orchestrator instances racing to drive the
        same run cannot both win: the row lock serializes them and the loser's
        WHERE no longer matches. A check-then-set would let two pods train the
        same run and register two models for it.
        """
        result = await self.s.execute(
            update(RunRow)
            .where(RunRow.id == run_id,
                   or_(RunRow.lease_owner.is_(None),
                       RunRow.lease_expires_at.is_(None),
                       RunRow.lease_expires_at < now))
            .values(lease_owner=owner, lease_expires_at=expires_at))
        return result.rowcount > 0

    async def renew_lease(self, run_id, owner: str, expires_at) -> bool:
        """Heartbeat. Returns False if we no longer hold it — someone reclaimed the
        run while we were working, and we must stop rather than double-drive it."""
        result = await self.s.execute(
            update(RunRow)
            .where(RunRow.id == run_id, RunRow.lease_owner == owner)
            .values(lease_expires_at=expires_at))
        return result.rowcount > 0

    async def release_lease(self, run_id) -> None:
        await self.s.execute(
            update(RunRow).where(RunRow.id == run_id)
            .values(lease_owner=None, lease_expires_at=None))


class SqlQuotaRepo:
    def __init__(self, s, tid):
        self.s, self.tid = s, tid

    async def get(self, tenant_id):
        row = await self.s.get(QuotaRow, tenant_id)
        if row is None:
            return None
        return TenantQuota(
            tenant_id=row.tenant_id, max_concurrent_runs=row.max_concurrent_runs,
            max_concurrent_pods=row.max_concurrent_pods,
            max_run_duration_minutes=row.max_run_duration_minutes,
            min_seconds_between_runs=row.min_seconds_between_runs,
            resource_ceiling=row.resource_ceiling or {}, node_pool=row.node_pool)

    async def upsert(self, q: TenantQuota):
        row = await self.s.get(QuotaRow, q.tenant_id)
        if row is None:
            row = QuotaRow(tenant_id=q.tenant_id)
            self.s.add(row)
        row.max_concurrent_runs = q.max_concurrent_runs
        row.max_concurrent_pods = q.max_concurrent_pods
        row.max_run_duration_minutes = q.max_run_duration_minutes
        row.min_seconds_between_runs = q.min_seconds_between_runs
        row.resource_ceiling = q.resource_ceiling
        row.node_pool = q.node_pool
        await self.s.flush()


class SqlQueueRepo:
    def __init__(self, s, tid):
        self.s, self.tid = s, tid

    async def enqueue(self, run_id, tenant_id, at):
        self.s.add(RunQueueRow(run_id=run_id, tenant_id=tenant_id, enqueued_at=at))
        await self.s.flush()

    async def depth(self, tenant_id):
        result = await self.s.execute(select(func.count()).select_from(RunQueueRow))
        return int(result.scalar_one())

    async def dequeue_next(self, tenant_id):
        stmt = (select(RunQueueRow).order_by(RunQueueRow.enqueued_at.asc())
                .limit(1).with_for_update(skip_locked=True))
        row = (await self.s.execute(stmt)).scalars().first()
        if row is None:
            return None
        rid = row.run_id
        await self.s.delete(row)
        await self.s.flush()
        return rid

    async def remove(self, run_id):
        row = await self.s.get(RunQueueRow, run_id)
        if row is not None:
            await self.s.delete(row)
            await self.s.flush()


class SqlLabeledRepo:
    def __init__(self, s, tid):
        self.s, self.tid = s, tid

    async def upsert(self, ex: LabeledExample):
        stmt = select(LabeledExampleRow).where(
            LabeledExampleRow.dataset_urn == ex.dataset_urn,
            LabeledExampleRow.row_pk == ex.row_pk)
        row = (await self.s.execute(stmt)).scalars().first()
        if row is None:
            row = LabeledExampleRow(id=ex.id, tenant_id=ex.tenant_id)
            self.s.add(row)
        row.dataset_urn = ex.dataset_urn
        row.row_pk = ex.row_pk
        row.features = ex.features
        row.label = ex.label
        row.source_case_urn = ex.source_case_urn
        row.created_at = ex.created_at
        await self.s.flush()

    async def list_for_dataset(self, dataset_urn):
        stmt = select(LabeledExampleRow).where(
            LabeledExampleRow.dataset_urn == dataset_urn)
        rows = (await self.s.execute(stmt)).scalars().all()
        return [_to(r, _L_FIELDS, LabeledExample) for r in rows]

    async def count_for_dataset(self, dataset_urn):
        result = await self.s.execute(
            select(func.count()).select_from(LabeledExampleRow).where(
                LabeledExampleRow.dataset_urn == dataset_urn))
        return int(result.scalar_one())


class SqlScheduleRepo:
    """Tenant-scoped schedule CRUD (RLS applies on this session)."""

    def __init__(self, s, tid):
        self.s, self.tid = s, tid

    async def add(self, sc: PipelineSchedule):
        row = PipelineScheduleRow()
        _apply(row, sc, _S_FIELDS)
        self.s.add(row)
        await self.s.flush()

    async def get(self, schedule_id):
        row = await self.s.get(PipelineScheduleRow, schedule_id)
        return _to(row, _S_FIELDS, PipelineSchedule) if row else None

    async def list(self):
        stmt = (select(PipelineScheduleRow)
                .order_by(PipelineScheduleRow.created_at.desc(),
                          PipelineScheduleRow.schedule_id.desc()))
        rows = (await self.s.execute(stmt)).scalars().all()
        return [_to(r, _S_FIELDS, PipelineSchedule) for r in rows]

    async def update(self, sc: PipelineSchedule):
        row = await self.s.get(PipelineScheduleRow, sc.schedule_id)
        if row is not None:
            _apply(row, sc, _S_FIELDS)
            await self.s.flush()

    async def delete(self, schedule_id):
        row = await self.s.get(PipelineScheduleRow, schedule_id)
        if row is not None:
            await self.s.delete(row)
            await self.s.flush()


class SqlBatchJobRepo:
    """Tenant-scoped batch-job CRUD (RLS applies on this session)."""

    def __init__(self, s, tid):
        self.s, self.tid = s, tid

    async def add(self, job: BatchJob):
        row = BatchJobRow()
        _apply(row, job, _BJ_FIELDS)
        self.s.add(row)
        await self.s.flush()

    async def get(self, job_id, include_deleted=False):
        row = await self.s.get(BatchJobRow, job_id)
        if row is None or (row.deleted_at is not None and not include_deleted):
            return None
        return _to(row, _BJ_FIELDS, BatchJob)

    async def get_by_name(self, workspace_id, name):
        stmt = select(BatchJobRow).where(
            BatchJobRow.workspace_id == workspace_id,
            func.lower(BatchJobRow.name) == name.lower(),
            BatchJobRow.deleted_at.is_(None))
        row = (await self.s.execute(stmt)).scalars().first()
        return _to(row, _BJ_FIELDS, BatchJob) if row else None

    async def list(self, limit, cursor):
        offset = int(decode_cursor(cursor).get("o", 0)) if cursor else 0
        stmt = (select(BatchJobRow).where(BatchJobRow.deleted_at.is_(None))
                .order_by(BatchJobRow.created_at.desc(), BatchJobRow.id.desc())
                .offset(offset).limit(limit + 1))
        rows = (await self.s.execute(stmt)).scalars().all()
        return _page([_to(r, _BJ_FIELDS, BatchJob) for r in rows], limit, cursor)

    async def update(self, job: BatchJob):
        row = await self.s.get(BatchJobRow, job.id)
        if row is not None:
            _apply(row, job, _BJ_FIELDS)
            await self.s.flush()


class SqlBatchRunRepo:
    def __init__(self, s, tid):
        self.s, self.tid = s, tid

    async def add(self, run: BatchJobRun):
        row = BatchJobRunRow()
        _apply(row, run, _BR_FIELDS)
        self.s.add(row)
        await self.s.flush()

    async def get(self, run_id):
        row = await self.s.get(BatchJobRunRow, run_id)
        return _to(row, _BR_FIELDS, BatchJobRun) if row else None

    async def update(self, run: BatchJobRun):
        row = await self.s.get(BatchJobRunRow, run.id)
        if row is not None:
            _apply(row, run, _BR_UPDATE_FIELDS)
            await self.s.flush()

    async def list_for_job(self, job_id, limit, cursor):
        offset = int(decode_cursor(cursor).get("o", 0)) if cursor else 0
        stmt = (select(BatchJobRunRow).where(BatchJobRunRow.batch_job_id == job_id)
                .order_by(BatchJobRunRow.created_at.desc(), BatchJobRunRow.id.desc())
                .offset(offset).limit(limit + 1))
        rows = (await self.s.execute(stmt)).scalars().all()
        return _page([_to(r, _BR_FIELDS, BatchJobRun) for r in rows], limit, cursor)

    async def active_for_job(self, job_id):
        stmt = (select(BatchJobRunRow)
                .where(BatchJobRunRow.batch_job_id == job_id,
                       BatchJobRunRow.status.in_(_BATCH_ACTIVE))
                .limit(1))
        row = (await self.s.execute(stmt)).scalars().first()
        return _to(row, _BR_FIELDS, BatchJobRun) if row else None

    async def claim_lease(self, run_id, owner: str, now, expires_at) -> bool:
        result = await self.s.execute(
            update(BatchJobRunRow)
            .where(BatchJobRunRow.id == run_id,
                   or_(BatchJobRunRow.lease_owner.is_(None),
                       BatchJobRunRow.lease_expires_at.is_(None),
                       BatchJobRunRow.lease_expires_at < now))
            .values(lease_owner=owner, lease_expires_at=expires_at))
        return result.rowcount > 0

    async def renew_lease(self, run_id, owner: str, expires_at) -> bool:
        result = await self.s.execute(
            update(BatchJobRunRow)
            .where(BatchJobRunRow.id == run_id, BatchJobRunRow.lease_owner == owner)
            .values(lease_expires_at=expires_at))
        return result.rowcount > 0

    async def release_lease(self, run_id) -> None:
        await self.s.execute(
            update(BatchJobRunRow).where(BatchJobRunRow.id == run_id)
            .values(lease_owner=None, lease_expires_at=None))


class SqlBatchIngestionRepo:
    def __init__(self, s, tid):
        self.s, self.tid = s, tid

    async def add(self, rec: BatchJobRunIngestion):
        row = BatchJobRunIngestionRow()
        _apply(row, rec, _BI_FIELDS)
        self.s.add(row)
        await self.s.flush()

    async def update(self, rec: BatchJobRunIngestion):
        row = await self.s.get(BatchJobRunIngestionRow, rec.id)
        if row is not None:
            _apply(row, rec, _BI_FIELDS)
            await self.s.flush()

    async def list_for_run(self, run_id):
        stmt = (select(BatchJobRunIngestionRow)
                .where(BatchJobRunIngestionRow.batch_job_run_id == run_id)
                .order_by(BatchJobRunIngestionRow.binding_key.asc()))
        rows = (await self.s.execute(stmt)).scalars().all()
        return [_to(r, _BI_FIELDS, BatchJobRunIngestion) for r in rows]

    async def get_by_ingestion_id(self, ingestion_id):
        stmt = select(BatchJobRunIngestionRow).where(
            BatchJobRunIngestionRow.ingestion_id == ingestion_id)
        row = (await self.s.execute(stmt)).scalars().first()
        return _to(row, _BI_FIELDS, BatchJobRunIngestion) if row else None


class SqlBatchJobScanner:
    """Cross-tenant scans for the batch-job background workers, all through a
    worker session (``app.worker=true``) exactly like SqlScheduleScanner and
    SqlOrphanScanner. Reads only — every write goes back through the tenant-scoped
    repos above so the tenant_isolation WITH CHECK still governs it."""

    def __init__(self, session_factory: async_sessionmaker):
        self._sf = session_factory

    async def _worker(self, session):
        await session.execute(text("SELECT set_config('app.worker', 'true', true)"))

    async def due(self, now, limit: int = 100) -> list[BatchJob]:
        async with self._sf() as session:
            await self._worker(session)
            stmt = (select(BatchJobRow)
                    .where(BatchJobRow.deleted_at.is_(None),
                           BatchJobRow.paused.is_(False),
                           BatchJobRow.next_fire_at.is_not(None),
                           BatchJobRow.next_fire_at <= now,
                           or_(BatchJobRow.end_at.is_(None), BatchJobRow.end_at > now))
                    .order_by(BatchJobRow.next_fire_at.asc()).limit(limit))
            rows = (await session.execute(stmt)).scalars().all()
            return [_to(r, _BJ_FIELDS, BatchJob) for r in rows]

    async def orphaned(self, now, stale_before, limit: int = 50) -> list[BatchJobRun]:
        """Batch runs nobody is driving: an expired lease, or a run left `pending`
        with no lease at all because its pod died before it could claim.

        A run sitting in the `ingestion` phase with no lease is NOT orphaned — it
        is waiting for ingestion events by design, and the phase deadline (not the
        reaper) is what stops it hanging.
        """
        from app.domain.enums import BatchPhase

        async with self._sf() as session:
            await self._worker(session)
            stmt = (select(BatchJobRunRow)
                    .where(BatchJobRunRow.status.in_(_BATCH_ACTIVE),
                           or_(BatchJobRunRow.lease_expires_at < now,
                               and_(BatchJobRunRow.lease_expires_at.is_(None),
                                    BatchJobRunRow.phase != int(BatchPhase.ingestion),
                                    BatchJobRunRow.created_at < stale_before)))
                    .order_by(func.coalesce(BatchJobRunRow.lease_expires_at,
                                            BatchJobRunRow.created_at).asc())
                    .limit(limit))
            rows = (await session.execute(stmt)).scalars().all()
            return [_to(r, _BR_FIELDS, BatchJobRun) for r in rows]

    async def past_deadline(self, now, limit: int = 50) -> list[BatchJobRun]:
        async with self._sf() as session:
            await self._worker(session)
            stmt = (select(BatchJobRunRow)
                    .where(BatchJobRunRow.status.in_(_BATCH_ACTIVE),
                           BatchJobRunRow.phase_deadline_at.is_not(None),
                           BatchJobRunRow.phase_deadline_at < now)
                    .order_by(BatchJobRunRow.phase_deadline_at.asc()).limit(limit))
            rows = (await session.execute(stmt)).scalars().all()
            return [_to(r, _BR_FIELDS, BatchJobRun) for r in rows]


class SqlScheduleScanner:
    """Cross-tenant DUE scan for the background ticker. Reads via a worker session
    (``app.worker=true``) so the permissive worker RLS policy lets fire_due see
    due schedules across ALL tenants — mirrors OutboxDispatcher. WRITES (create run +
    advance next_fire) always go through the tenant-scoped SqlScheduleRepo, so the
    tenant_isolation WITH CHECK still governs them."""

    def __init__(self, session_factory: async_sessionmaker):
        self._sf = session_factory

    async def due(self, now, limit: int = 100) -> list[PipelineSchedule]:
        async with self._sf() as session:
            await session.execute(text("SELECT set_config('app.worker', 'true', true)"))
            stmt = (select(PipelineScheduleRow)
                    .where(PipelineScheduleRow.enabled.is_(True),
                           PipelineScheduleRow.next_fire_at.is_not(None),
                           PipelineScheduleRow.next_fire_at <= now)
                    .order_by(PipelineScheduleRow.next_fire_at.asc())
                    .limit(limit))
            rows = (await session.execute(stmt)).scalars().all()
            return [_to(r, _S_FIELDS, PipelineSchedule) for r in rows]


class SqlOrphanScanner:
    """Cross-tenant scan for runs whose driver died (BR: on-demand compute).

    Reads via a worker session (``app.worker=true``) so migration 0004's
    permissive ``worker_pipeline_runs`` policy lets the reaper see stranded runs
    across ALL tenants — the same shape as SqlScheduleScanner and OutboxDispatcher.
    Recovery WRITES go back through the tenant-scoped SqlRunRepo, so
    tenant_isolation's WITH CHECK still governs every mutation.
    """

    def __init__(self, session_factory: async_sessionmaker):
        self._sf = session_factory

    async def orphaned(self, now, stale_before, limit: int = 50) -> list[PipelineRun]:
        """Runs nobody is driving: an expired lease, or — the case a lease alone
        misses — a run left `submitted` with no lease at all because its pod died
        in the window between returning 202 and claiming."""
        drivable = [int(RunStatus.submitted), int(RunStatus.running)]
        async with self._sf() as session:
            await session.execute(text("SELECT set_config('app.worker', 'true', true)"))
            stmt = (select(RunRow)
                    .where(RunRow.status.in_(drivable),
                           or_(RunRow.lease_expires_at < now,
                               and_(RunRow.lease_expires_at.is_(None),
                                    func.coalesce(RunRow.submitted_at,
                                                  RunRow.created_at) < stale_before)))
                    .order_by(func.coalesce(RunRow.lease_expires_at,
                                            RunRow.submitted_at).asc())
                    .limit(limit))
            rows = (await session.execute(stmt)).scalars().all()
            return [_to(r, _R_FIELDS, PipelineRun) for r in rows]


class SqlOutboxRepo:
    def __init__(self, s, tid):
        self.s, self.tid = s, tid

    async def add(self, topic, envelope):
        self.s.add(OutboxRow(
            id=new_id(), tenant_id=self.tid, topic=topic,
            event_type=envelope["event_type"], payload=envelope, created_at=utcnow()))
        await self.s.flush()


class SqlIdempotencyRepo:
    def __init__(self, s, tid):
        self.s, self.tid = s, tid

    async def get(self, key):
        row = await self.s.get(IdempotencyKeyRow, (self.tid, key))
        if row is None:
            return None
        return {"request_hash": row.request_hash, "status_code": row.status_code,
                "body": row.response_body}

    async def put(self, key, request_hash, status_code, body):
        self.s.add(IdempotencyKeyRow(
            tenant_id=self.tid, key=key, request_hash=request_hash,
            status_code=status_code, response_body=body, created_at=utcnow()))
        await self.s.flush()


class SqlUnitOfWork:
    def __init__(self, session_factory: async_sessionmaker, tenant_id: str):
        self.tenant_id = tenant_id
        self._sf = session_factory
        self._session: AsyncSession | None = None

    async def __aenter__(self):
        self._session = self._sf()
        await self._session.execute(
            text("SELECT set_config('app.tenant_id', :tid, true)"),
            {"tid": self.tenant_id})
        s = self._session
        self.templates = SqlTemplateRepo(s, self.tenant_id)
        self.versions = SqlVersionRepo(s, self.tenant_id)
        self.runs = SqlRunRepo(s, self.tenant_id)
        self.quotas = SqlQuotaRepo(s, self.tenant_id)
        self.run_queue = SqlQueueRepo(s, self.tenant_id)
        self.labeled_examples = SqlLabeledRepo(s, self.tenant_id)
        self.schedules = SqlScheduleRepo(s, self.tenant_id)
        self.batch_jobs = SqlBatchJobRepo(s, self.tenant_id)
        self.batch_runs = SqlBatchRunRepo(s, self.tenant_id)
        self.batch_ingestions = SqlBatchIngestionRepo(s, self.tenant_id)
        self.outbox = SqlOutboxRepo(s, self.tenant_id)
        self.idempotency = SqlIdempotencyRepo(s, self.tenant_id)
        return self

    async def __aexit__(self, exc_type, exc, tb):
        try:
            if exc_type is None:
                await self._session.commit()
            else:
                await self._session.rollback()
        finally:
            await self._session.close()

    async def commit(self):
        await self._session.commit()
        await self._session.execute(
            text("SELECT set_config('app.tenant_id', :tid, true)"),
            {"tid": self.tenant_id})


def sql_uow_factory(session_factory: async_sessionmaker):
    def factory(tenant_id: str):
        return SqlUnitOfWork(session_factory, tenant_id)

    return factory


class SqlDedupStore:
    def __init__(self, session_factory: async_sessionmaker):
        self._sf = session_factory

    async def already_processed(self, tenant_id, event_id):
        async with self._sf() as session:
            await session.execute(
                text("SELECT set_config('app.tenant_id', :tid, true)"),
                {"tid": tenant_id})
            row = await session.get(ProcessedEventRow, event_id)
            return row is not None

    async def mark_processed(self, tenant_id, event_id):
        async with self._sf() as session:
            await session.execute(
                text("SELECT set_config('app.tenant_id', :tid, true)"),
                {"tid": tenant_id})
            stmt = (pg_insert(ProcessedEventRow)
                    .values(event_id=event_id, tenant_id=tenant_id, created_at=utcnow())
                    .on_conflict_do_nothing(index_elements=["event_id"]))
            await session.execute(stmt)
            await session.commit()


class OutboxDispatcher:
    """Polls unpublished outbox rows and publishes to the bus (MASTER-FR-034)."""

    def __init__(self, session_factory: async_sessionmaker, bus, batch_size=100):
        self._sf = session_factory
        self._bus = bus
        self._batch = batch_size

    async def run_once(self) -> int:
        async with self._sf() as session:
            await session.execute(text("SELECT set_config('app.worker', 'true', true)"))
            stmt = (select(OutboxRow).where(OutboxRow.published_at.is_(None))
                    .order_by(OutboxRow.created_at.asc()).limit(self._batch)
                    .with_for_update(skip_locked=True))
            rows = (await session.execute(stmt)).scalars().all()
            for row in rows:
                await self._bus.publish(row.topic, row.payload)
            if rows:
                await session.execute(
                    update(OutboxRow).where(OutboxRow.id.in_([r.id for r in rows]))
                    .values(published_at=utcnow()))
            await session.commit()
            return len(rows)


async def bootstrap_catalog(session_factory: async_sessionmaker, components, algorithms):
    """Idempotently persist the seed component registry + algorithm templates into the
    global (non-RLS) catalog tables so the API serves real rows.

    Inserts target the underlying ``Table`` with DB-column-name keys so the ``metadata``
    and ``order_no`` columns cannot shadow ORM/MetaData attributes (BUG-2)."""
    from app.store.orm import AlgorithmTemplateRow, ComponentRow

    comp_t = ComponentRow.__table__
    algo_t = AlgorithmTemplateRow.__table__
    async with session_factory() as session:
        for c in components:
            stmt = pg_insert(comp_t).values(
                name=c.name, component_type=c.component_type,
                internal_component_type=c.internal_component_type, label=c.label,
                definition=c.definition, yaml_ref=c.yaml_ref,
                image_digest=c.image_digest, catalog_version=c.catalog_version,
                enabled=c.enabled).on_conflict_do_update(
                index_elements=["name"],
                set_={"definition": c.definition, "label": c.label,
                      "catalog_version": c.catalog_version, "enabled": c.enabled})
            await session.execute(stmt)
        for a in algorithms:
            stmt = pg_insert(algo_t).values({
                "name": a.name, "label": a.label, "model_type": a.model_type,
                "order_no": a.order, "model_type_order": a.model_type_order,
                "input_type": a.input_type, "pipeline": a.pipeline,
                "tuning_pipeline": a.tuning_pipeline,
                "tuning_pipeline_cross_validation": a.tuning_pipeline_cross_validation,
                "parameters": a.parameters, "tuning_parameters": a.tuning_parameters,
                "metadata": a.metadata, "catalog_version": a.catalog_version,
                "runnable": a.runnable}).on_conflict_do_update(
                index_elements=["name"],
                set_={"pipeline": a.pipeline, "runnable": a.runnable,
                      "catalog_version": a.catalog_version})
            await session.execute(stmt)
        await session.commit()


_ = datetime
