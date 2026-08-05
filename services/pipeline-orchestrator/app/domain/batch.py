"""BRD 73 — batch job orchestration: the chained `trigger → ingestion → pipeline`
state machine.

Datacern had both halves of "pull last night's claims, then score them" and no
seam between them: an ingestion-service cron that refreshes a dataset, and a
pipeline-orchestrator cron that runs a pipeline, with a hopeful gap in between.
Every failure mode of that gap is silent — the pipeline fires while the ingestion
is still streaming and scores the PREVIOUS batch; the ingestion fails and the
pipeline runs anyway on stale data and reports success; and nothing records that
run N consumed batch N, so "which data produced this score" has no answer.

A :class:`~app.domain.entities.BatchJobRun` closes the seam by making the
ordering explicit and enforced:

* **trigger** — fire one ingestion per binding through ingestion-service's
  internal path, each stamped with an Idempotency-Key of ``batch_key`` + binding.
* **ingestion** — wait until every one of those ingestions is terminal, driven by
  the ``ingestion.events.v1`` consumer rather than by polling. A per-phase
  deadline fails the run instead of letting it hang forever.
* **pipeline** — submit the bound pipeline version through the existing
  ``RunService``, with the dataset versions this batch produced recorded on the
  run and passed as run parameters.

Concurrency uses the SAME machinery ``PipelineRun`` already has — ``claim_lease``,
a heartbeat at ⅓ TTL, and an orphan reaper — because double-driving matters more
here: for a plain run it wastes compute, for a batch job it double-ingests.

The lease is held only while a phase is actively being DRIVEN. The ingestion
phase is a wait, not work, so a run sitting in it holds nothing and the reaper
deliberately ignores it (``phase != ingestion`` in the orphan scan); the phase
deadline is what bounds it.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
from datetime import datetime, timedelta

from app.domain.entities import BatchJob, BatchJobRun, BatchJobRunIngestion, CallCtx
from app.domain.enums import (
    INGESTION_TERMINAL,
    BatchPhase,
    BatchRunStatus,
    RunStatus,
)
from app.domain.errors import (
    Conflict,
    DependencyUnavailable,
    NotFound,
    ValidationFailed,
)
from app.domain.scheduler import compute_next_fire
from app.events.envelope import make_envelope
from app.utils import new_id

logger = logging.getLogger(__name__)

BATCH_ACTOR = {"type": "service", "id": "batch-job-orchestrator"}

#: Ingestion modes a batch binding may request. `file_upload` is excluded on
#: purpose: it needs a human to push bytes, so it can never complete unattended
#: and a scheduled job bound to one would hang until its deadline.
BATCH_INGESTION_MODES = {"query", "file_poll", "scheduled_run", "webhook_batch"}


def batch_job_urn(tenant_id: str, job_id: str) -> str:
    return f"wr:{tenant_id}:pipeline:batch-job/{job_id}"


def batch_run_urn(tenant_id: str, run_id: str) -> str:
    return f"wr:{tenant_id}:pipeline:batch-job-run/{run_id}"


def ingestion_urn(tenant_id: str, ingestion_id: str) -> str:
    """The URN ingestion-service stamps as an event's resource_urn and
    dataset-service records as a version's ``produced_by_urn``."""
    return f"wr:{tenant_id}:ingestion:ingestion/{ingestion_id}"


def binding_key(binding: dict, index: int) -> str:
    return str(binding.get("binding_key") or f"b{index}")


class BatchJobService:
    def __init__(self, deps, run_service, scanner):
        self.d = deps
        self.runs = run_service
        self.scanner = scanner
        #: Drives spawned from the consumer / reaper. Held so the loop keeps a
        #: strong reference (a bare create_task can be garbage collected
        #: mid-phase) and so tests can await a sweep's work.
        self._drive_tasks: set = set()

    # ------------------------------------------------------------------ misc
    @property
    def instance_id(self) -> str:
        return self.runs.instance_id

    def _lease_ttl(self) -> timedelta:
        return timedelta(seconds=self.d.settings.run_lease_seconds)

    def _phase_deadline(self, job: BatchJob | None, now: datetime) -> datetime:
        seconds = (job.phase_timeout_seconds if job and job.phase_timeout_seconds
                   else self.d.settings.batch_phase_deadline_seconds)
        return now + timedelta(seconds=seconds)

    def _spawn(self, coro) -> asyncio.Task | None:
        """Run a drive in the background. The consumer must not block a Kafka
        partition for the length of a training run, and the reaper must not stall
        its sweep behind one recovered job."""
        try:
            task = asyncio.get_running_loop().create_task(coro)
        except RuntimeError:  # no loop (sync context) — nothing to schedule onto
            coro.close()
            return None
        self._drive_tasks.add(task)
        task.add_done_callback(self._drive_tasks.discard)
        return task

    async def wait_for_drives(self) -> None:
        """Await every background drive this instance spawned (tests + shutdown)."""
        while self._drive_tasks:
            await asyncio.gather(*list(self._drive_tasks), return_exceptions=True)

    # ---------------------------------------------------------------- create
    def _validate_bindings(self, bindings: list[dict]) -> list[dict]:
        details: list[dict] = []
        if not bindings:
            details.append({"field": "connection_bindings",
                            "message": "at least one connection binding is required"})
        seen: set[str] = set()
        for i, binding in enumerate(bindings or []):
            if not isinstance(binding, dict):
                details.append({"field": f"connection_bindings[{i}]",
                                "message": "binding must be an object"})
                continue
            key = binding_key(binding, i)
            if key in seen:
                details.append({"field": f"connection_bindings[{i}].binding_key",
                                "message": f"duplicate binding_key {key!r}"})
            seen.add(key)
            if not binding.get("connection_id"):
                details.append({"field": f"connection_bindings[{i}].connection_id",
                                "message": "connection_id is required"})
            mode = (binding.get("ingestion_params") or {}).get("ingestion_mode", "query")
            if mode not in BATCH_INGESTION_MODES:
                details.append({
                    "field": f"connection_bindings[{i}].ingestion_params.ingestion_mode",
                    "message": f"ingestion_mode {mode!r} cannot run unattended "
                               f"(allowed: {sorted(BATCH_INGESTION_MODES)})"})
        if details:
            raise ValidationFailed("invalid batch job", code="VALIDATION_FAILED",
                                   details=details)
        return list(bindings)

    async def create(self, ctx: CallCtx, body: dict) -> BatchJob:
        bindings = self._validate_bindings(body.get("connection_bindings") or [])
        cron = body.get("cron")
        timezone = body.get("timezone") or "UTC"
        if cron:
            # Reuse the pipeline schedule validator so a batch job's cadence obeys
            # exactly the same rules (and error shape) as a pipeline schedule.
            from app.domain.scheduler import PipelineScheduleService

            PipelineScheduleService._validate(cron, timezone)
        now = self.d.clock.now()
        async with self.d.uow_factory(ctx.tenant_id) as uow:
            template = await uow.templates.get(body["pipeline_template_id"])
            if template is None:
                raise NotFound("pipeline template not found")
            version_id = body.get("pipeline_version_id")
            if version_id is not None:
                version = await uow.versions.get_by_id(version_id)
                if version is None or version.template_id != template.id:
                    raise NotFound("pipeline version not found for this template")
            if await uow.batch_jobs.get_by_name(body["workspace_id"], body["name"]):
                raise Conflict(f"batch job name {body['name']!r} already exists "
                               "in workspace")
            job = BatchJob(
                id=new_id(), tenant_id=ctx.tenant_id,
                workspace_id=body["workspace_id"], name=body["name"],
                pipeline_template_id=template.id, pipeline_version_id=version_id,
                connection_bindings=bindings, cron=cron, timezone=timezone,
                run_parameters=body.get("run_parameters") or {},
                start_at=body.get("start_at"), end_at=body.get("end_at"),
                paused=bool(body.get("paused")),
                phase_timeout_seconds=body.get("phase_timeout_seconds"),
                next_fire_at=(self._first_fire(cron, timezone, body.get("start_at"), now)
                              if cron else None),
                last_fire_at=None, last_run_id=None,
                created_by=ctx.actor.get("id"), created_at=now, updated_at=now)
            await uow.batch_jobs.add(job)
            await self._emit_job(uow, ctx, "batch_job.created", job)
        return job

    @staticmethod
    def _first_fire(cron, timezone, start_at, now) -> datetime:
        base = start_at if start_at and start_at > now else now
        return compute_next_fire(cron, timezone, base)

    # ------------------------------------------------------------------ read
    async def get(self, ctx: CallCtx, job_id: str) -> BatchJob:
        async with self.d.uow_factory(ctx.tenant_id) as uow:
            job = await uow.batch_jobs.get(job_id)
            if job is None:
                raise NotFound("batch job not found")
            return job

    async def list(self, ctx: CallCtx, limit: int, cursor: str | None):
        async with self.d.uow_factory(ctx.tenant_id) as uow:
            return await uow.batch_jobs.list(limit, cursor)

    async def list_runs(self, ctx: CallCtx, job_id: str, limit: int, cursor: str | None):
        async with self.d.uow_factory(ctx.tenant_id) as uow:
            if await uow.batch_jobs.get(job_id) is None:
                raise NotFound("batch job not found")
            return await uow.batch_runs.list_for_job(job_id, limit, cursor)

    async def get_run(self, ctx: CallCtx, run_id: str
                      ) -> tuple[BatchJobRun, list[BatchJobRunIngestion]]:
        async with self.d.uow_factory(ctx.tenant_id) as uow:
            run = await uow.batch_runs.get(run_id)
            if run is None:
                raise NotFound("batch job run not found")
            return run, await uow.batch_ingestions.list_for_run(run_id)

    # ---------------------------------------------------------------- update
    async def update(self, ctx: CallCtx, job_id: str, body: dict) -> BatchJob:
        async with self.d.uow_factory(ctx.tenant_id) as uow:
            job = await uow.batch_jobs.get(job_id)
            if job is None:
                raise NotFound("batch job not found")
            now = self.d.clock.now()
            if body.get("connection_bindings") is not None:
                job.connection_bindings = self._validate_bindings(
                    body["connection_bindings"])
            if body.get("name") and body["name"] != job.name:
                if await uow.batch_jobs.get_by_name(job.workspace_id, body["name"]):
                    raise Conflict("batch job name already exists")
                job.name = body["name"]
            for field in ("run_parameters", "phase_timeout_seconds", "end_at",
                          "pipeline_version_id"):
                if body.get(field) is not None:
                    setattr(job, field, body[field])
            if body.get("cron") is not None:
                from app.domain.scheduler import PipelineScheduleService

                tz = body.get("timezone") or job.timezone
                PipelineScheduleService._validate(body["cron"], tz)
                job.cron, job.timezone = body["cron"], tz
                job.next_fire_at = compute_next_fire(job.cron, job.timezone, now)
            job.updated_at = now
            await uow.batch_jobs.update(job)
            await self._emit_job(uow, ctx, "batch_job.updated", job)
        return job

    async def pause(self, ctx: CallCtx, job_id: str) -> BatchJob:
        return await self._set_paused(ctx, job_id, True)

    async def resume(self, ctx: CallCtx, job_id: str) -> BatchJob:
        return await self._set_paused(ctx, job_id, False)

    async def _set_paused(self, ctx, job_id, paused) -> BatchJob:
        async with self.d.uow_factory(ctx.tenant_id) as uow:
            job = await uow.batch_jobs.get(job_id)
            if job is None:
                raise NotFound("batch job not found")
            now = self.d.clock.now()
            job.paused = paused
            job.updated_at = now
            # Resuming recomputes the next fire from now, so a long-paused job does
            # not fire a backlog burst of ingestions the moment it wakes up.
            if not paused and job.cron:
                job.next_fire_at = compute_next_fire(job.cron, job.timezone, now)
            await uow.batch_jobs.update(job)
            await self._emit_job(uow, ctx, "batch_job.paused" if paused
                                 else "batch_job.resumed", job)
        return job

    async def delete(self, ctx: CallCtx, job_id: str) -> None:
        async with self.d.uow_factory(ctx.tenant_id) as uow:
            job = await uow.batch_jobs.get(job_id)
            if job is None:
                raise NotFound("batch job not found")
            now = self.d.clock.now()
            job.deleted_at = now
            job.updated_at = now
            job.paused = True
            await uow.batch_jobs.update(job)
            await self._emit_job(uow, ctx, "batch_job.deleted", job)

    # ------------------------------------------------------------- fire/run
    async def run_now(self, ctx: CallCtx, job_id: str) -> BatchJobRun:
        async with self.d.uow_factory(ctx.tenant_id) as uow:
            job = await uow.batch_jobs.get(job_id)
            if job is None:
                raise NotFound("batch job not found")
        return await self._create_run(job, trigger="manual", actor=ctx.actor,
                                      via_agent=ctx.via_agent, advance=False)

    async def fire_due(self, now: datetime | None = None) -> list[BatchJobRun]:
        """Create a run for every enabled batch job whose cron is due, then advance
        its next_fire_at. Returns the created runs; the caller drives them."""
        now = now or self.d.clock.now()
        fired: list[BatchJobRun] = []
        for job in await self.scanner.due(now):
            try:
                run = await self._create_run(job, trigger="schedule",
                                             actor=dict(BATCH_ACTOR), advance=True,
                                             now=now)
                if run is not None:
                    fired.append(run)
            except Conflict:
                # The job's previous run has not finished, or another instance
                # already created this one (ux_batch_runs_active_job). Skipping is
                # the point: a second run would ingest the same batch twice.
                logger.info("batch job %s still has an active run; skipping fire",
                            job.id)
                await self._advance_only(job, now)
            except Exception as exc:  # noqa: BLE001 — one job must not abort the tick
                logger.exception("batch job %s failed to fire: %s", job.id, exc)
                await self._advance_only(job, now)
        return fired

    async def _advance_only(self, job: BatchJob, now: datetime) -> None:
        if not job.cron:
            return
        try:
            async with self.d.uow_factory(job.tenant_id) as uow:
                fresh = await uow.batch_jobs.get(job.id)
                if fresh is not None:
                    fresh.next_fire_at = compute_next_fire(fresh.cron, fresh.timezone, now)
                    fresh.updated_at = now
                    await uow.batch_jobs.update(fresh)
        except Exception:  # noqa: BLE001
            logger.exception("failed to advance next_fire for batch job %s", job.id)

    async def _create_run(self, job: BatchJob, *, trigger: str, actor: dict,
                          via_agent: dict | None = None, advance: bool,
                          now: datetime | None = None,
                          phase: int = int(BatchPhase.trigger),
                          retried_from: str | None = None,
                          seed_ingestions: list[BatchJobRunIngestion] | None = None,
                          ) -> BatchJobRun:
        now = now or self.d.clock.now()
        ctx = CallCtx(tenant_id=job.tenant_id, actor=dict(actor), via_agent=via_agent)
        run_id = new_id()
        async with self.d.uow_factory(job.tenant_id) as uow:
            template = await uow.templates.get(job.pipeline_template_id)
            if template is None:
                raise NotFound("pipeline template not found")
            version_id = job.pipeline_version_id or template.active_version_id
            run = BatchJobRun(
                id=run_id, tenant_id=job.tenant_id, batch_job_id=job.id,
                pipeline_template_id=template.id, pipeline_version_id=version_id,
                # The run's own id IS the batch key: it is what every ingestion this
                # run fires is keyed by, so a re-drive replays rather than duplicates.
                batch_key=run_id, phase=phase, status=int(BatchRunStatus.pending),
                trigger=trigger,
                # A retry that resumes at `pipeline` never re-enters the ingestion
                # phase, so it must inherit the pins the first attempt landed —
                # otherwise the retried run could not say which data it consumed.
                input_dataset_urns=self._pinned_urns(seed_ingestions or []),
                output_dataset_urns=[],
                pipeline_run_id=None, error=None,
                phase_deadline_at=self._phase_deadline(job, now),
                retried_from_run_id=retried_from, submitted_by=actor.get("id"),
                via_agent=via_agent, created_at=now, updated_at=now)
            await uow.batch_runs.add(run)
            for seed in seed_ingestions or []:
                await uow.batch_ingestions.add(BatchJobRunIngestion(
                    id=new_id(), tenant_id=job.tenant_id, batch_job_run_id=run_id,
                    binding_key=seed.binding_key, ingestion_id=seed.ingestion_id,
                    status=seed.status, dataset_urn=seed.dataset_urn,
                    iceberg_snapshot_id=seed.iceberg_snapshot_id,
                    dataset_version_urn=seed.dataset_version_urn, error=None,
                    created_at=now, updated_at=now))
            fresh = await uow.batch_jobs.get(job.id)
            if fresh is not None:
                fresh.last_fire_at = now
                fresh.last_run_id = run_id
                fresh.updated_at = now
                if advance and fresh.cron:
                    fresh.next_fire_at = compute_next_fire(fresh.cron, fresh.timezone,
                                                           now)
                await uow.batch_jobs.update(fresh)
            await self._emit_run(uow, ctx, "batch_job.run.started", run,
                                 {"batch_job_id": job.id, "trigger": trigger,
                                  "batch_key": run.batch_key,
                                  "retried_from_run_id": retried_from})
        return run

    # ------------------------------------------------------------- retry
    async def retry(self, ctx: CallCtx, run_id: str) -> BatchJobRun:
        """Resume a failed run FROM THE PHASE IT FAILED IN.

        Restarting at ``trigger`` would re-fire ingestions that already landed —
        i.e. ingest the same batch twice — so the completed ingestion records are
        carried into the new run and the phase is preserved. A binding that FAILED
        is deliberately not carried over: the new run re-triggers it under its own
        batch key, which is a genuinely new ingestion rather than a replay of the
        failed one.
        """
        async with self.d.uow_factory(ctx.tenant_id) as uow:
            run = await uow.batch_runs.get(run_id)
            if run is None:
                raise NotFound("batch job run not found")
            if run.status != int(BatchRunStatus.failed):
                raise Conflict("only failed batch job runs can be retried")
            job = await uow.batch_jobs.get(run.batch_job_id)
            if job is None:
                raise NotFound("batch job not found")
            records = await uow.batch_ingestions.list_for_run(run_id)
        landed = [r for r in records if r.status == "completed"]
        return await self._create_run(
            job, trigger="retry", actor=ctx.actor, via_agent=ctx.via_agent,
            advance=False, phase=run.phase, retried_from=run_id,
            seed_ingestions=landed)

    async def terminate(self, ctx: CallCtx, run_id: str) -> BatchJobRun:
        async with self.d.uow_factory(ctx.tenant_id) as uow:
            run = await uow.batch_runs.get(run_id)
            if run is None:
                raise NotFound("batch job run not found")
            if run.status not in (int(BatchRunStatus.pending),
                                  int(BatchRunStatus.running)):
                return run  # idempotent
            run.status = int(BatchRunStatus.cancelled)
            run.finished_at = self.d.clock.now()
            run.updated_at = run.finished_at
            run.phase_deadline_at = None
            await uow.batch_runs.update(run)
            await self._emit_run(uow, ctx, "batch_job.run.cancelled", run,
                                 {"cancelled_by": ctx.actor.get("id")})
        return run

    # =========================================================== phase machine
    async def drive_run(self, tenant_id: str, run_id: str, *,
                        resuming: bool = False) -> BatchJobRun | None:
        """Advance a batch job run as far as it can go right now, under a lease.

        Returns having either finished the run or parked it in the ``ingestion``
        phase waiting on ``ingestion.events.v1``. Nothing here runs without an
        unexpired lease — two instances driving one job would fire every binding
        twice.
        """
        ctx = CallCtx(tenant_id=tenant_id, actor=dict(BATCH_ACTOR))
        now = self.d.clock.now()
        async with self.d.uow_factory(tenant_id) as uow:
            run = await uow.batch_runs.get(run_id)
            if run is None or run.status not in (int(BatchRunStatus.pending),
                                                 int(BatchRunStatus.running)):
                return run
            if not await uow.batch_runs.claim_lease(run_id, self.instance_id, now,
                                                    now + self._lease_ttl()):
                logger.info("batch run %s already leased by %s", run_id,
                            run.lease_owner)
                return run
            if run.status == int(BatchRunStatus.pending):
                run.status = int(BatchRunStatus.running)
                run.started_at = run.started_at or now
                run.updated_at = now
                await uow.batch_runs.update(run)

        heartbeat = asyncio.create_task(self._heartbeat_lease(tenant_id, run_id))
        try:
            await self._advance(ctx, run_id, resuming=resuming)
        except Exception as exc:  # noqa: BLE001 — surface as a failed run
            await self._fail(ctx, run_id, exc)
        finally:
            heartbeat.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await heartbeat
            async with self.d.uow_factory(tenant_id) as uow:
                await uow.batch_runs.release_lease(run_id)
        async with self.d.uow_factory(tenant_id) as uow:
            return await uow.batch_runs.get(run_id)

    async def _heartbeat_lease(self, tenant_id: str, run_id: str) -> None:
        """Renew at a third of the TTL — two consecutive missed beats still leave a
        full interval of margin before anyone may reclaim (mirrors RunService)."""
        interval = max(1.0, self.d.settings.run_lease_seconds / 3)
        while True:
            await asyncio.sleep(interval)
            try:
                async with self.d.uow_factory(tenant_id) as uow:
                    held = await uow.batch_runs.renew_lease(
                        run_id, self.instance_id,
                        self.d.clock.now() + self._lease_ttl())
                if not held:
                    logger.warning("lost lease on batch run %s (reclaimed by another "
                                   "instance) — still driving it here", run_id)
                    return
            except Exception:  # noqa: BLE001 — a failed beat must not kill the run
                logger.exception("batch lease heartbeat failed for run %s", run_id)

    async def _advance(self, ctx: CallCtx, run_id: str, *, resuming: bool) -> None:
        while True:
            async with self.d.uow_factory(ctx.tenant_id) as uow:
                run = await uow.batch_runs.get(run_id)
                job = await uow.batch_jobs.get(run.batch_job_id,
                                               include_deleted=True) if run else None
            if run is None or run.status not in (int(BatchRunStatus.pending),
                                                 int(BatchRunStatus.running)):
                return
            if job is None:
                raise NotFound("batch job not found")

            if run.phase == int(BatchPhase.trigger):
                await self._ensure_triggered(ctx, run, job)
                await self._enter_phase(ctx, run.id, BatchPhase.ingestion, job)
                continue

            if run.phase == int(BatchPhase.ingestion):
                # A retry may land here with a binding that has no ingestion yet.
                await self._ensure_triggered(ctx, run, job)
                ready, failed = await self._ingestion_state(ctx, run.id, job)
                if failed is not None:
                    raise failed
                if not ready:
                    return  # parked: the consumer resumes us when the events land
                await self._enter_phase(ctx, run.id, BatchPhase.pipeline, job)
                continue

            if run.phase == int(BatchPhase.pipeline):
                await self._phase_pipeline(ctx, run, resuming=resuming)
                return

            raise ValidationFailed(f"unknown batch phase {run.phase}")

    # ---------------------------------------------------------- phase: trigger
    async def _ensure_triggered(self, ctx: CallCtx, run: BatchJobRun,
                                job: BatchJob) -> None:
        """Fire an ingestion for every binding that does not have one on this run.

        Idempotent twice over: locally, because a binding with a record is skipped;
        and remotely, because the Idempotency-Key is derived from ``batch_key`` +
        binding, so even a crash between the remote call and the local record
        cannot produce a second ingestion — the retry replays the first one.
        """
        client = self.d.ingestion_client
        if client is None:
            raise DependencyUnavailable(
                "no ingestion client configured; a batch job cannot trigger "
                "ingestions without ingestion-service")
        async with self.d.uow_factory(ctx.tenant_id) as uow:
            existing = {r.binding_key for r in
                        await uow.batch_ingestions.list_for_run(run.id)}
        for i, binding in enumerate(job.connection_bindings or []):
            key = binding_key(binding, i)
            if key in existing:
                continue
            args = self._ingestion_args(job, binding)
            result = await client.create_ingestion(
                ctx.tenant_id, args, idempotency_key=f"{run.batch_key}:{key}")
            now = self.d.clock.now()
            status = str(result.get("status") or "triggered")
            record = BatchJobRunIngestion(
                id=new_id(), tenant_id=ctx.tenant_id, batch_job_run_id=run.id,
                binding_key=key, ingestion_id=str(result["id"]),
                # ingestion-service may run some modes INLINE, so the create
                # response can already be terminal. Record that instead of waiting
                # for an event we might have raced past.
                status=status if status in INGESTION_TERMINAL else "triggered",
                dataset_urn=result.get("dataset_urn"),
                iceberg_snapshot_id=(str(result["iceberg_snapshot_id"])
                                     if result.get("iceberg_snapshot_id") else None),
                dataset_version_urn=None, error=None,
                created_at=now, updated_at=now)
            async with self.d.uow_factory(ctx.tenant_id) as uow:
                await uow.batch_ingestions.add(record)

    def _ingestion_args(self, job: BatchJob, binding: dict) -> dict:
        params = dict(binding.get("ingestion_params") or {})
        args = {
            "ingestion_mode": params.pop("ingestion_mode", "query"),
            "connection_id": binding.get("connection_id"),
            "workspace_id": binding.get("workspace_id") or job.workspace_id,
        }
        if binding.get("dataset_urn"):
            args["dataset_urn"] = binding["dataset_urn"]
        args.update(params)
        return args

    async def _enter_phase(self, ctx: CallCtx, run_id: str, phase: BatchPhase,
                           job: BatchJob) -> None:
        now = self.d.clock.now()
        async with self.d.uow_factory(ctx.tenant_id) as uow:
            run = await uow.batch_runs.get(run_id)
            if run is None:
                return
            previous = BatchPhase(run.phase).name
            run.phase = int(phase)
            run.phase_deadline_at = self._phase_deadline(job, now)
            run.updated_at = now
            if phase == BatchPhase.pipeline:
                records = await uow.batch_ingestions.list_for_run(run_id)
                run.input_dataset_urns = self._pinned_urns(records)
            await uow.batch_runs.update(run)
            await self._emit_run(uow, ctx, "batch_job.run.phase_changed", run, {
                "previous_phase": previous, "phase": phase.name,
                "phase_deadline_at": run.phase_deadline_at.isoformat(),
                "input_dataset_urns": run.input_dataset_urns})

    # -------------------------------------------------------- phase: ingestion
    async def _ingestion_state(self, ctx: CallCtx, run_id: str, job: BatchJob):
        """(ready, failure). ``ready`` is True only once every binding has an
        ingestion, every ingestion is terminal, and every COMPLETED one has the
        dataset version it produced — that version URN is what the pipeline phase
        pins to, so advancing without it would leave the run unable to say which
        data it consumed."""
        async with self.d.uow_factory(ctx.tenant_id) as uow:
            records = await uow.batch_ingestions.list_for_run(run_id)
        expected = {binding_key(b, i)
                    for i, b in enumerate(job.connection_bindings or [])}
        by_key = {r.binding_key: r for r in records}
        if expected - set(by_key):
            return False, None
        for rec in records:
            if rec.status in ("failed", "cancelled"):
                return False, BatchIngestionFailed(
                    f"ingestion {rec.ingestion_id} for binding {rec.binding_key!r} "
                    f"{rec.status}; the pipeline phase was not started",
                    details={"binding_key": rec.binding_key,
                             "ingestion_id": rec.ingestion_id,
                             "ingestion_error": rec.error})
            if rec.status != "completed":
                return False, None
            if not rec.dataset_version_urn:
                return False, None
        return True, None

    @staticmethod
    def _pinned_urns(records: list[BatchJobRunIngestion]) -> list[str]:
        return [r.dataset_version_urn for r in records if r.dataset_version_urn]

    @staticmethod
    def _pins(records: list[BatchJobRunIngestion]) -> list[dict]:
        return [{"binding_key": r.binding_key, "ingestion_id": r.ingestion_id,
                 "dataset_urn": r.dataset_urn,
                 "dataset_version_urn": r.dataset_version_urn,
                 "iceberg_snapshot_id": r.iceberg_snapshot_id}
                for r in records if r.status == "completed"]

    # --------------------------------------------------------- phase: pipeline
    async def _phase_pipeline(self, ctx: CallCtx, run: BatchJobRun, *,
                              resuming: bool) -> None:
        """Submit (or re-attach to) the bound pipeline run over exactly this batch.

        The dataset versions the ingestion phase produced ride along as run
        parameters AND land on the pipeline run's ``input_dataset_urns``, so the
        lineage question "which data produced this score" is answerable at the run
        level rather than inferred from timestamps.
        """
        async with self.d.uow_factory(ctx.tenant_id) as uow:
            records = await uow.batch_ingestions.list_for_run(run.id)
            job = await uow.batch_jobs.get(run.batch_job_id, include_deleted=True)
        pins = self._pins(records)
        pipeline_run_id = run.pipeline_run_id
        if pipeline_run_id is None:
            params = {
                **(job.run_parameters if job else {}),
                "batch_key": run.batch_key,
                "batch_job_run_id": run.id,
                "input_dataset_urns": self._pinned_urns(records),
                "batch_datasets": pins,
            }
            _op, pipeline_run = await self.runs.create_run(
                ctx, run.pipeline_template_id, params, trigger="batch_job")
            pipeline_run_id = pipeline_run.id
            # Persist BEFORE driving: if this pod dies mid-run, recovery must know
            # which pipeline run belongs to this batch or it would submit a second.
            async with self.d.uow_factory(ctx.tenant_id) as uow:
                fresh = await uow.batch_runs.get(run.id)
                if fresh is not None:
                    fresh.pipeline_run_id = pipeline_run_id
                    fresh.updated_at = self.d.clock.now()
                    await uow.batch_runs.update(fresh)
        else:
            async with self.d.uow_factory(ctx.tenant_id) as uow:
                pipeline_run = await uow.runs.get(pipeline_run_id)

        if pipeline_run is not None and pipeline_run.status in (
                int(RunStatus.pending), int(RunStatus.submitted),
                int(RunStatus.running)):
            pipeline_run = await self.runs.drive_run(
                ctx.tenant_id, pipeline_run_id,
                resuming=resuming and pipeline_run.status == int(RunStatus.running))
        if pipeline_run is None:
            async with self.d.uow_factory(ctx.tenant_id) as uow:
                pipeline_run = await uow.runs.get(pipeline_run_id)
        if pipeline_run is None:
            raise DependencyUnavailable(
                f"pipeline run {pipeline_run_id} disappeared mid-batch")
        if pipeline_run.status == int(RunStatus.succeeded):
            await self._succeed(ctx, run.id, pipeline_run)
            return
        raise BatchPipelineFailed(
            f"pipeline run {pipeline_run_id} finished "
            f"{RunStatus(pipeline_run.status).name}",
            details={"pipeline_run_id": pipeline_run_id,
                     "pipeline_error": pipeline_run.error})

    # ------------------------------------------------------------- terminals
    async def _succeed(self, ctx: CallCtx, run_id: str, pipeline_run) -> None:
        now = self.d.clock.now()
        async with self.d.uow_factory(ctx.tenant_id) as uow:
            run = await uow.batch_runs.get(run_id)
            if run is None:
                return
            run.status = int(BatchRunStatus.succeeded)
            run.finished_at = now
            run.updated_at = now
            run.phase_deadline_at = None
            run.output_dataset_urns = list(pipeline_run.output_dataset_urns or [])
            await uow.batch_runs.update(run)
            await self._emit_run(uow, ctx, "batch_job.run.succeeded", run, {
                "pipeline_run_id": run.pipeline_run_id,
                "input_dataset_urns": run.input_dataset_urns,
                "output_dataset_urns": run.output_dataset_urns,
                "duration_s": (now - (run.started_at or now)).total_seconds()})

    async def _fail(self, ctx: CallCtx, run_id: str, exc: Exception) -> None:
        now = self.d.clock.now()
        async with self.d.uow_factory(ctx.tenant_id) as uow:
            run = await uow.batch_runs.get(run_id)
            if run is None or run.status not in (int(BatchRunStatus.pending),
                                                 int(BatchRunStatus.running)):
                return
            phase = BatchPhase(run.phase).name
            run.status = int(BatchRunStatus.failed)
            run.finished_at = now
            run.updated_at = now
            run.phase_deadline_at = None
            # The phase is part of the error, not a footnote: it is what `retry`
            # resumes from, and what tells an operator whether the data landed.
            run.error = {"code": getattr(exc, "code", "BATCH_RUN_FAILED"),
                         "phase": phase, "message": str(exc)[:500],
                         "details": getattr(exc, "details", None)}
            await uow.batch_runs.update(run)
            await self._emit_run(uow, ctx, "batch_job.run.failed", run,
                                 {"phase": phase, "error": run.error})

    # ------------------------------------------------------- consumer hooks
    async def on_ingestion_terminal(self, tenant_id: str, ingestion_id: str,
                                    status: str, payload: dict) -> bool:
        """``ingestion.events.v1`` reached a terminal state. Returns whether it
        belonged to a batch job run (so the consumer can log honestly)."""
        async with self.d.uow_factory(tenant_id) as uow:
            rec = await uow.batch_ingestions.get_by_ingestion_id(ingestion_id)
            if rec is None:
                return False
            now = self.d.clock.now()
            rec.status = status
            rec.updated_at = now
            if payload.get("dataset_urn"):
                rec.dataset_urn = payload["dataset_urn"]
            if payload.get("iceberg_snapshot_id") is not None:
                rec.iceberg_snapshot_id = str(payload["iceberg_snapshot_id"])
            if status in ("failed", "cancelled"):
                rec.error = {k: payload.get(k) for k in
                             ("error_category", "error_digest", "attempts")
                             if payload.get(k) is not None} or None
            await uow.batch_ingestions.update(rec)
            run = await uow.batch_runs.get(rec.batch_job_run_id)
        if run is not None and run.status in (int(BatchRunStatus.pending),
                                              int(BatchRunStatus.running)):
            self._spawn(self.drive_run(tenant_id, run.id))
        return True

    async def on_dataset_version_created(self, tenant_id: str, version_urn: str,
                                         payload: dict) -> bool:
        """``dataset.events.v1 :: dataset.version_created`` carries the
        ``produced_by_urn`` of the ingestion that landed it — the only place the
        exact version URN of a batch's data is available, and therefore what
        makes "pin the pipeline to what this batch produced" real rather than a
        timestamp guess."""
        produced_by = payload.get("produced_by_urn") or ""
        prefix = f"wr:{tenant_id}:ingestion:ingestion/"
        if not produced_by.startswith(prefix):
            return False
        ingestion_id = produced_by[len(prefix):]
        async with self.d.uow_factory(tenant_id) as uow:
            rec = await uow.batch_ingestions.get_by_ingestion_id(ingestion_id)
            if rec is None:
                return False
            now = self.d.clock.now()
            rec.dataset_version_urn = version_urn
            if payload.get("dataset_urn"):
                rec.dataset_urn = payload["dataset_urn"]
            if payload.get("iceberg_snapshot_id") is not None:
                rec.iceberg_snapshot_id = str(payload["iceberg_snapshot_id"])
            rec.updated_at = now
            await uow.batch_ingestions.update(rec)
            run = await uow.batch_runs.get(rec.batch_job_run_id)
        if run is not None and run.status in (int(BatchRunStatus.pending),
                                              int(BatchRunStatus.running)):
            self._spawn(self.drive_run(tenant_id, run.id))
        return True

    # ------------------------------------------------------ sweeps (workers)
    async def recover_orphans(self, limit: int = 50) -> list[str]:
        """Re-drive batch runs whose driver is gone.

        Unlike a pipeline run there is nothing to throw away: every phase is
        re-enterable, because the trigger step is idempotent by ``batch_key`` and
        the pipeline step re-attaches to the ``pipeline_run_id`` it already
        recorded rather than submitting a second one.
        """
        now = self.d.clock.now()
        stale_before = now - timedelta(seconds=self.d.settings.run_lease_seconds)
        recovered: list[str] = []
        for run in await self.scanner.orphaned(now, stale_before, limit):
            try:
                logger.info("re-driving orphaned batch run %s (phase=%s, owner=%s)",
                            run.id, BatchPhase(run.phase).name, run.lease_owner)
                self._spawn(self.drive_run(
                    run.tenant_id, run.id,
                    resuming=run.phase == int(BatchPhase.pipeline)))
                recovered.append(run.id)
            except Exception:  # noqa: BLE001 — one bad run must not stop the sweep
                logger.exception("failed to recover orphaned batch run %s", run.id)
        return recovered

    async def sweep_deadlines(self, now: datetime | None = None) -> list[str]:
        """Fail runs that overran their phase deadline.

        The ingestion phase is a wait on events, and events can simply never
        arrive — a source that never returns, an ingestion the bus dropped. Without
        this the run would sit in `ingestion` forever, looking alive, and the job
        would never fire again (its previous run is still active). Failing with the
        phase recorded is terminal, honest, and retryable from that phase.
        """
        now = now or self.d.clock.now()
        failed: list[str] = []
        for run in await self.scanner.past_deadline(now):
            ctx = CallCtx(tenant_id=run.tenant_id, actor=dict(BATCH_ACTOR))
            async with self.d.uow_factory(run.tenant_id) as uow:
                # Claim first so two instances cannot both fail (and both emit for)
                # one run.
                if not await uow.batch_runs.claim_lease(run.id, self.instance_id, now,
                                                        now + self._lease_ttl()):
                    continue
            phase = BatchPhase(run.phase).name
            await self._fail(ctx, run.id, BatchPhaseTimeout(
                f"batch job run exceeded its {phase} phase deadline "
                f"({run.phase_deadline_at.isoformat() if run.phase_deadline_at else '?'})"
                "; failing rather than hanging"))
            async with self.d.uow_factory(run.tenant_id) as uow:
                await uow.batch_runs.release_lease(run.id)
            failed.append(run.id)
        return failed

    # ------------------------------------------------------------- events
    async def _emit_job(self, uow, ctx, event_type, job) -> None:
        env = make_envelope(
            event_type=event_type, tenant_id=ctx.tenant_id, actor=ctx.actor,
            via_agent=ctx.via_agent, resource_urn=batch_job_urn(ctx.tenant_id, job.id),
            payload={"batch_job_id": job.id, "name": job.name,
                     "workspace_id": job.workspace_id, "cron": job.cron,
                     "paused": job.paused,
                     "pipeline_template_id": job.pipeline_template_id},
            trace_id=ctx.trace_id)
        await uow.outbox.add(self.d.events_topic, env)

    async def _emit_run(self, uow, ctx, event_type, run, extra) -> None:
        payload = {"batch_job_run_id": run.id, "batch_job_id": run.batch_job_id,
                   "phase": BatchPhase(run.phase).name,
                   "status": BatchRunStatus(run.status).name}
        payload.update(extra or {})
        env = make_envelope(
            event_type=event_type, tenant_id=ctx.tenant_id, actor=ctx.actor,
            via_agent=run.via_agent, resource_urn=batch_run_urn(ctx.tenant_id, run.id),
            payload=payload, trace_id=ctx.trace_id)
        await uow.outbox.add(self.d.events_topic, env)


class BatchIngestionFailed(Exception):
    """An ingestion this run depends on failed, so the pipeline phase must not run.

    Running the pipeline anyway is precisely the silent failure BRD 73 exists to
    remove: it would score stale data and report success.
    """

    code = "BATCH_INGESTION_FAILED"

    def __init__(self, message: str, *, details: dict | None = None):
        super().__init__(message)
        self.details = details


class BatchPipelineFailed(Exception):
    code = "BATCH_PIPELINE_FAILED"

    def __init__(self, message: str, *, details: dict | None = None):
        super().__init__(message)
        self.details = details


class BatchPhaseTimeout(Exception):
    code = "BATCH_PHASE_TIMEOUT"

    def __init__(self, message: str, *, details: dict | None = None):
        super().__init__(message)
        self.details = details
