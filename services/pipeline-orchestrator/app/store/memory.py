"""In-memory store (unit/dev tier). Mirrors the SQL repo interface so services are
storage-agnostic. NOT reachable from real-adapter runtime wiring (CONVENTIONS.md)."""

from __future__ import annotations

import copy
from dataclasses import replace
from datetime import datetime

from app.domain.entities import (
    AlgorithmTemplate,
    BatchJob,
    BatchJobRun,
    BatchJobRunIngestion,
    Component,
    LabeledExample,
    PipelineRun,
    PipelineSchedule,
    PipelineTemplate,
    TemplateVersion,
    TenantQuota,
)
from app.domain.enums import BATCH_ACTIVE_STATUSES, BatchPhase, RunStatus
from app.domain.errors import Conflict
from app.domain.ports import Page
from app.utils import decode_cursor, encode_cursor


class MemoryState:
    def __init__(self):
        self.templates: dict[str, PipelineTemplate] = {}
        self.versions: dict[str, TemplateVersion] = {}
        self.runs: dict[str, PipelineRun] = {}
        self.components: dict[str, Component] = {}
        self.algorithms: dict[str, AlgorithmTemplate] = {}
        self.quotas: dict[str, TenantQuota] = {}
        self.queue: list[tuple[str, str, datetime]] = []
        self.labeled: dict[tuple[str, str, str], LabeledExample] = {}
        self.schedules: dict[str, PipelineSchedule] = {}
        self.batch_jobs: dict[str, BatchJob] = {}
        self.batch_runs: dict[str, BatchJobRun] = {}
        self.batch_ingestions: dict[str, BatchJobRunIngestion] = {}
        self.outbox: list[dict] = []
        self.idempotency: dict[tuple[str, str], dict] = {}
        self.processed: set[str] = set()


def _page(items: list, limit: int, cursor: str | None) -> Page:
    offset = int(decode_cursor(cursor).get("o", 0)) if cursor else 0
    window = items[offset:offset + limit]
    has_more = offset + limit < len(items)
    return Page(items=window,
                next_cursor=encode_cursor({"o": offset + limit}) if has_more else None,
                has_more=has_more)


class _Templates:
    def __init__(self, s, tid):
        self.s, self.tid = s, tid

    async def add(self, t: PipelineTemplate):
        self.s.templates[t.id] = copy.deepcopy(t)

    async def get(self, tid: str, include_deleted=False):
        t = self.s.templates.get(tid)
        if not t or t.tenant_id != self.tid:
            return None
        if t.deleted_at and not include_deleted:
            return None
        return copy.deepcopy(t)

    async def get_by_name(self, workspace_id, name):
        for t in self.s.templates.values():
            if (t.tenant_id == self.tid and t.workspace_id == workspace_id
                    and t.name.lower() == name.lower() and not t.deleted_at):
                return copy.deepcopy(t)
        return None

    async def update(self, t: PipelineTemplate):
        self.s.templates[t.id] = copy.deepcopy(t)

    async def list(self, filters, limit, cursor):
        rows = [t for t in self.s.templates.values() if t.tenant_id == self.tid]
        if not filters.include_archived:
            rows = [t for t in rows if not t.deleted_at]
        if filters.name:
            rows = [t for t in rows if filters.name.lower() in t.name.lower()]
        if filters.pipeline_type:
            from app.domain.enums import pipeline_type_from_str
            pt = pipeline_type_from_str(filters.pipeline_type)
            rows = [t for t in rows if t.pipeline_type == pt]
        if filters.workspace_id:
            rows = [t for t in rows if t.workspace_id == filters.workspace_id]
        rows.sort(key=lambda t: t.created_at, reverse=True)
        return _page([copy.deepcopy(t) for t in rows], limit, cursor)


class _Versions:
    def __init__(self, s, tid):
        self.s, self.tid = s, tid

    async def add(self, v: TemplateVersion):
        self.s.versions[v.id] = copy.deepcopy(v)

    async def get_by_id(self, vid):
        v = self.s.versions.get(vid)
        return copy.deepcopy(v) if v and v.tenant_id == self.tid else None

    async def get(self, template_id, version_no):
        for v in self.s.versions.values():
            if v.template_id == template_id and v.version_no == version_no:
                return copy.deepcopy(v)
        return None

    async def latest(self, template_id):
        vs = [v for v in self.s.versions.values() if v.template_id == template_id]
        return copy.deepcopy(max(vs, key=lambda v: v.version_no)) if vs else None

    async def list(self, template_id, limit, cursor):
        vs = sorted((v for v in self.s.versions.values()
                     if v.template_id == template_id),
                    key=lambda v: v.version_no, reverse=True)
        return _page([copy.deepcopy(v) for v in vs], limit, cursor)

    async def list_all(self, template_id):
        return [copy.deepcopy(v) for v in self.s.versions.values()
                if v.template_id == template_id]

    async def next_version_no(self, template_id):
        vs = [v.version_no for v in self.s.versions.values()
              if v.template_id == template_id]
        return (max(vs) if vs else 0) + 1

    async def update(self, v: TemplateVersion):
        self.s.versions[v.id] = copy.deepcopy(v)


class _Runs:
    def __init__(self, s, tid):
        self.s, self.tid = s, tid

    async def add(self, r: PipelineRun):
        self.s.runs[r.id] = copy.deepcopy(r)

    async def get(self, rid):
        r = self.s.runs.get(rid)
        return copy.deepcopy(r) if r and r.tenant_id == self.tid else None

    async def update(self, r: PipelineRun):
        # The lease belongs to claim/renew/release alone — carry the stored values
        # over so a caller writing back a copy it read BEFORE claiming cannot erase
        # the lease it is currently holding (mirrors SqlRunRepo.update).
        stored = self.s.runs.get(r.id)
        fresh = copy.deepcopy(r)
        if stored is not None:
            fresh.lease_owner = stored.lease_owner
            fresh.lease_expires_at = stored.lease_expires_at
        self.s.runs[r.id] = fresh

    async def get_by_workflow(self, argo_workflow_name):
        for r in self.s.runs.values():
            if r.tenant_id == self.tid and r.argo_workflow_name == argo_workflow_name:
                return copy.deepcopy(r)
        return None

    async def list(self, filters, limit, cursor):
        rows = [r for r in self.s.runs.values() if r.tenant_id == self.tid]
        if filters.status:
            st = RunStatus[filters.status]
            rows = [r for r in rows if r.status == st]
        if filters.template_id:
            rows = [r for r in rows if r.template_id == filters.template_id]
        rows.sort(key=lambda r: r.created_at, reverse=True)
        return _page([copy.deepcopy(r) for r in rows], limit, cursor)

    async def count_active(self, tenant_id):
        active = {RunStatus.pending, RunStatus.submitted, RunStatus.running}
        return sum(1 for r in self.s.runs.values()
                   if r.tenant_id == tenant_id and r.status in active)

    async def last_submission_at(self, tenant_id, submitted_by):
        times = [r.submitted_at or r.created_at for r in self.s.runs.values()
                 if r.tenant_id == tenant_id and r.submitted_by == submitted_by]
        return max(times) if times else None

    async def claim_lease(self, run_id, owner: str, now, expires_at) -> bool:
        r = self.s.runs.get(run_id)
        if r is None:
            return False
        if r.lease_owner is not None and r.lease_expires_at is not None \
                and r.lease_expires_at >= now:
            return False  # someone else holds a live lease
        r.lease_owner, r.lease_expires_at = owner, expires_at
        return True

    async def renew_lease(self, run_id, owner: str, expires_at) -> bool:
        r = self.s.runs.get(run_id)
        if r is None or r.lease_owner != owner:
            return False
        r.lease_expires_at = expires_at
        return True

    async def release_lease(self, run_id) -> None:
        r = self.s.runs.get(run_id)
        if r is not None:
            r.lease_owner, r.lease_expires_at = None, None


class _Quotas:
    def __init__(self, s, tid):
        self.s, self.tid = s, tid

    async def get(self, tenant_id):
        q = self.s.quotas.get(tenant_id)
        return replace(q) if q else None

    async def upsert(self, q: TenantQuota):
        self.s.quotas[q.tenant_id] = replace(q)


class _Queue:
    def __init__(self, s, tid):
        self.s, self.tid = s, tid

    async def enqueue(self, run_id, tenant_id, at):
        self.s.queue.append((run_id, tenant_id, at))

    async def depth(self, tenant_id):
        return sum(1 for _, t, _ in self.s.queue if t == tenant_id)

    async def dequeue_next(self, tenant_id):
        for i, (rid, t, _) in enumerate(self.s.queue):
            if t == tenant_id:
                self.s.queue.pop(i)
                return rid
        return None

    async def remove(self, run_id):
        self.s.queue = [x for x in self.s.queue if x[0] != run_id]


class _Labeled:
    def __init__(self, s, tid):
        self.s, self.tid = s, tid

    async def upsert(self, ex: LabeledExample):
        self.s.labeled[(ex.tenant_id, ex.dataset_urn, ex.row_pk)] = replace(ex)

    async def list_for_dataset(self, dataset_urn):
        return [replace(e) for (t, d, _), e in self.s.labeled.items()
                if t == self.tid and d == dataset_urn]

    async def count_for_dataset(self, dataset_urn):
        return len(await self.list_for_dataset(dataset_urn))


class _Schedules:
    def __init__(self, s, tid):
        self.s, self.tid = s, tid

    async def add(self, sc: PipelineSchedule):
        self.s.schedules[sc.schedule_id] = replace(sc)

    async def get(self, schedule_id):
        sc = self.s.schedules.get(schedule_id)
        return replace(sc) if sc and sc.tenant_id == self.tid else None

    async def list(self):
        rows = [sc for sc in self.s.schedules.values() if sc.tenant_id == self.tid]
        rows.sort(key=lambda x: x.created_at, reverse=True)
        return [replace(sc) for sc in rows]

    async def update(self, sc: PipelineSchedule):
        cur = self.s.schedules.get(sc.schedule_id)
        if cur is not None and cur.tenant_id == self.tid:
            self.s.schedules[sc.schedule_id] = replace(sc)

    async def delete(self, schedule_id):
        sc = self.s.schedules.get(schedule_id)
        if sc is not None and sc.tenant_id == self.tid:
            self.s.schedules.pop(schedule_id, None)


class _BatchJobs:
    def __init__(self, s, tid):
        self.s, self.tid = s, tid

    async def add(self, job: BatchJob):
        self.s.batch_jobs[job.id] = copy.deepcopy(job)

    async def get(self, job_id, include_deleted=False):
        job = self.s.batch_jobs.get(job_id)
        if not job or job.tenant_id != self.tid:
            return None
        if job.deleted_at and not include_deleted:
            return None
        return copy.deepcopy(job)

    async def get_by_name(self, workspace_id, name):
        for job in self.s.batch_jobs.values():
            if (job.tenant_id == self.tid and job.workspace_id == workspace_id
                    and job.name.lower() == name.lower() and not job.deleted_at):
                return copy.deepcopy(job)
        return None

    async def list(self, limit, cursor):
        rows = [j for j in self.s.batch_jobs.values()
                if j.tenant_id == self.tid and not j.deleted_at]
        rows.sort(key=lambda j: j.created_at, reverse=True)
        return _page([copy.deepcopy(j) for j in rows], limit, cursor)

    async def update(self, job: BatchJob):
        self.s.batch_jobs[job.id] = copy.deepcopy(job)


class _BatchRuns:
    def __init__(self, s, tid):
        self.s, self.tid = s, tid

    async def add(self, run: BatchJobRun):
        # Mirrors migration 0005's ux_batch_runs_active_job partial unique index:
        # a job may have at most ONE non-terminal run, so two instances racing a
        # due job cannot both create one (and thus cannot both ingest the batch).
        if await self.active_for_job(run.batch_job_id) is not None:
            raise Conflict("batch job already has an active run")
        self.s.batch_runs[run.id] = copy.deepcopy(run)

    async def get(self, run_id):
        run = self.s.batch_runs.get(run_id)
        return copy.deepcopy(run) if run and run.tenant_id == self.tid else None

    async def update(self, run: BatchJobRun):
        # The lease belongs to claim/renew/release alone (mirrors SqlBatchRunRepo).
        stored = self.s.batch_runs.get(run.id)
        fresh = copy.deepcopy(run)
        if stored is not None:
            fresh.lease_owner = stored.lease_owner
            fresh.lease_expires_at = stored.lease_expires_at
        self.s.batch_runs[run.id] = fresh

    async def list_for_job(self, job_id, limit, cursor):
        rows = [r for r in self.s.batch_runs.values()
                if r.tenant_id == self.tid and r.batch_job_id == job_id]
        rows.sort(key=lambda r: r.created_at, reverse=True)
        return _page([copy.deepcopy(r) for r in rows], limit, cursor)

    async def active_for_job(self, job_id):
        active = {int(s) for s in BATCH_ACTIVE_STATUSES}
        for run in self.s.batch_runs.values():
            if (run.tenant_id == self.tid and run.batch_job_id == job_id
                    and run.status in active):
                return copy.deepcopy(run)
        return None

    async def claim_lease(self, run_id, owner: str, now, expires_at) -> bool:
        run = self.s.batch_runs.get(run_id)
        if run is None:
            return False
        if run.lease_owner is not None and run.lease_expires_at is not None \
                and run.lease_expires_at >= now:
            return False
        run.lease_owner, run.lease_expires_at = owner, expires_at
        return True

    async def renew_lease(self, run_id, owner: str, expires_at) -> bool:
        run = self.s.batch_runs.get(run_id)
        if run is None or run.lease_owner != owner:
            return False
        run.lease_expires_at = expires_at
        return True

    async def release_lease(self, run_id) -> None:
        run = self.s.batch_runs.get(run_id)
        if run is not None:
            run.lease_owner, run.lease_expires_at = None, None


class _BatchIngestions:
    def __init__(self, s, tid):
        self.s, self.tid = s, tid

    async def add(self, rec: BatchJobRunIngestion):
        for existing in self.s.batch_ingestions.values():
            if (existing.batch_job_run_id == rec.batch_job_run_id
                    and existing.binding_key == rec.binding_key):
                raise Conflict("binding already triggered for this run")
        self.s.batch_ingestions[rec.id] = replace(rec)

    async def update(self, rec: BatchJobRunIngestion):
        if rec.id in self.s.batch_ingestions:
            self.s.batch_ingestions[rec.id] = replace(rec)

    async def list_for_run(self, run_id):
        rows = [r for r in self.s.batch_ingestions.values()
                if r.tenant_id == self.tid and r.batch_job_run_id == run_id]
        rows.sort(key=lambda r: r.binding_key)
        return [replace(r) for r in rows]

    async def get_by_ingestion_id(self, ingestion_id):
        for rec in self.s.batch_ingestions.values():
            if rec.tenant_id == self.tid and rec.ingestion_id == ingestion_id:
                return replace(rec)
        return None


class MemoryBatchJobScanner:
    """Cross-tenant batch scans (unit/dev tier). Mirrors SqlBatchJobScanner."""

    def __init__(self, state: MemoryState):
        self.s = state

    async def due(self, now, limit: int = 100) -> list[BatchJob]:
        rows = [j for j in self.s.batch_jobs.values()
                if not j.deleted_at and not j.paused and j.next_fire_at is not None
                and j.next_fire_at <= now and (j.end_at is None or j.end_at > now)]
        rows.sort(key=lambda j: j.next_fire_at)
        return [copy.deepcopy(j) for j in rows[:limit]]

    async def orphaned(self, now, stale_before, limit: int = 50) -> list[BatchJobRun]:
        active = {int(s) for s in BATCH_ACTIVE_STATUSES}
        rows = []
        for run in self.s.batch_runs.values():
            if run.status not in active:
                continue
            if run.lease_expires_at is not None:
                if run.lease_expires_at < now:
                    rows.append(run)
            elif (run.phase != int(BatchPhase.ingestion)
                    and run.created_at < stale_before):
                rows.append(run)
        rows.sort(key=lambda r: r.lease_expires_at or r.created_at)
        return [copy.deepcopy(r) for r in rows[:limit]]

    async def past_deadline(self, now, limit: int = 50) -> list[BatchJobRun]:
        active = {int(s) for s in BATCH_ACTIVE_STATUSES}
        rows = [r for r in self.s.batch_runs.values()
                if r.status in active and r.phase_deadline_at is not None
                and r.phase_deadline_at < now]
        rows.sort(key=lambda r: r.phase_deadline_at)
        return [copy.deepcopy(r) for r in rows[:limit]]


class MemoryScheduleScanner:
    """Cross-tenant DUE scan (unit/dev tier). Mirrors SqlScheduleScanner: returns
    enabled schedules whose next_fire_at is due, across all tenants."""

    def __init__(self, state: MemoryState):
        self.s = state

    async def due(self, now, limit: int = 100) -> list[PipelineSchedule]:
        rows = [sc for sc in self.s.schedules.values()
                if sc.enabled and sc.next_fire_at is not None and sc.next_fire_at <= now]
        rows.sort(key=lambda x: x.next_fire_at)
        return [replace(sc) for sc in rows[:limit]]


class MemoryOrphanScanner:
    """Cross-tenant scan for runs nobody is driving (unit/dev tier). Mirrors
    SqlOrphanScanner, including the null-lease-but-stale case."""

    def __init__(self, state: MemoryState):
        self.s = state

    async def orphaned(self, now, stale_before, limit: int = 50) -> list[PipelineRun]:
        drivable = {int(RunStatus.submitted), int(RunStatus.running)}
        rows = []
        for r in self.s.runs.values():
            if r.status not in drivable:
                continue
            if r.lease_expires_at is not None:
                if r.lease_expires_at < now:
                    rows.append(r)
            elif (r.submitted_at or r.created_at) < stale_before:
                rows.append(r)
        rows.sort(key=lambda x: x.lease_expires_at or x.submitted_at or x.created_at)
        return [copy.deepcopy(r) for r in rows[:limit]]


class _Outbox:
    def __init__(self, s, tid):
        self.s, self.tid = s, tid

    async def add(self, topic, envelope):
        self.s.outbox.append({"topic": topic, "payload": envelope})


class _Idempotency:
    def __init__(self, s, tid):
        self.s, self.tid = s, tid

    async def get(self, key):
        return self.s.idempotency.get((self.tid, key))

    async def put(self, key, request_hash, status_code, body):
        self.s.idempotency[(self.tid, key)] = {
            "request_hash": request_hash, "status_code": status_code, "body": body}


class MemoryUnitOfWork:
    def __init__(self, state: MemoryState, tenant_id: str):
        self.s = state
        self.tenant_id = tenant_id

    async def __aenter__(self):
        self.templates = _Templates(self.s, self.tenant_id)
        self.versions = _Versions(self.s, self.tenant_id)
        self.runs = _Runs(self.s, self.tenant_id)
        self.quotas = _Quotas(self.s, self.tenant_id)
        self.run_queue = _Queue(self.s, self.tenant_id)
        self.labeled_examples = _Labeled(self.s, self.tenant_id)
        self.schedules = _Schedules(self.s, self.tenant_id)
        self.batch_jobs = _BatchJobs(self.s, self.tenant_id)
        self.batch_runs = _BatchRuns(self.s, self.tenant_id)
        self.batch_ingestions = _BatchIngestions(self.s, self.tenant_id)
        self.outbox = _Outbox(self.s, self.tenant_id)
        self.idempotency = _Idempotency(self.s, self.tenant_id)
        return self

    async def __aexit__(self, *exc):
        return None

    async def commit(self):
        return None


def memory_uow_factory(state: MemoryState):
    def factory(tenant_id: str) -> MemoryUnitOfWork:
        return MemoryUnitOfWork(state, tenant_id)

    return factory


class _InMemoryDedup:
    """Consumer dedup for the unit/dev tier (Redis in real mode)."""

    def __init__(self):
        self._seen: set[tuple[str, str]] = set()

    async def already_processed(self, tenant_id: str, event_id: str) -> bool:
        return (tenant_id, event_id) in self._seen

    async def mark_processed(self, tenant_id: str, event_id: str) -> None:
        self._seen.add((tenant_id, event_id))
