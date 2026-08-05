"""BRD 73 against REAL Postgres: the migration, the RLS policies, and the two
constraints that carry semantics rather than hygiene.

The unit tier proves the phase machine over the in-memory store. What it CANNOT
prove is that the mirror is real — that `ux_batch_runs_active_job` actually stops
a second concurrent run at the database, that the worker policy actually lets the
cross-tenant sweeps see rows under FORCE RLS, and that a tenant-B session sees
nothing. Those are properties of migration 0005, so they are asserted here.
"""

from __future__ import annotations

from datetime import timedelta

import pytest
from sqlalchemy import text

from app.container import build_container
from app.domain.batch import BATCH_ACTOR
from app.domain.entities import CallCtx
from app.domain.enums import BatchPhase, BatchRunStatus
from tests.conftest import TENANT_A, TENANT_B, WORKSPACE, data_prep_definition, make_settings

pytestmark = pytest.mark.integration

DATASET = "wr:t:dataset:dataset/claims"


def _ctx(tenant=TENANT_A):
    return CallCtx(tenant_id=tenant, actor={"type": "user", "id": "a"},
                   workspace_id=WORKSPACE)


async def _job(c, *, name="nightly", tenant=TENANT_A, bindings=1, cron=None):
    template, _ = await c.template_service.create(_ctx(tenant), {
        "workspace_id": WORKSPACE, "name": f"{name}-tpl", "pipeline_type": "data_prep",
        "definition": data_prep_definition(dataset=DATASET)})
    return await c.batch_job_service.create(_ctx(tenant), {
        "workspace_id": WORKSPACE, "name": name,
        "pipeline_template_id": template.id,
        "connection_bindings": [{"connection_id": f"c{i}", "binding_key": f"b{i}",
                                 "ingestion_params": {"ingestion_mode": "query"}}
                                for i in range(bindings)],
        "cron": cron})


async def test_batch_jobs_and_runs_are_invisible_across_tenants(app_sf, clock):
    c = build_container(make_settings(), mode="sql", session_factory=app_sf,
                        clock=clock)
    job = await _job(c)
    run = await c.batch_job_service._create_run(job, trigger="manual",
                                                actor=dict(BATCH_ACTOR), advance=False)

    async with c.deps.uow_factory(TENANT_B) as uow:
        assert await uow.batch_jobs.get(job.id) is None
        assert await uow.batch_runs.get(run.id) is None
        assert await uow.batch_ingestions.list_for_run(run.id) == []
    async with c.deps.uow_factory(TENANT_A) as uow:
        assert await uow.batch_jobs.get(job.id) is not None
        assert await uow.batch_runs.get(run.id) is not None


async def test_a_second_active_run_for_one_job_is_refused_by_the_database(app_sf,
                                                                          clock):
    """The real ux_batch_runs_active_job index — two orchestrator instances that
    both see the job come due would otherwise each fire every binding, i.e. ingest
    the batch twice."""
    from sqlalchemy.exc import IntegrityError

    c = build_container(make_settings(), mode="sql", session_factory=app_sf,
                        clock=clock)
    job = await _job(c, name="racy")
    await c.batch_job_service._create_run(job, trigger="schedule",
                                          actor=dict(BATCH_ACTOR), advance=False)
    with pytest.raises(IntegrityError):
        await c.batch_job_service._create_run(job, trigger="schedule",
                                              actor=dict(BATCH_ACTOR), advance=False)


async def test_one_ingestion_record_per_binding_per_run(app_sf, clock):
    """The local half of trigger idempotency: even if two drivers somehow both got
    past the lease, the (run, binding) uniqueness stops a second record."""
    from sqlalchemy.exc import IntegrityError

    from app.domain.entities import BatchJobRunIngestion
    from app.utils import new_id

    c = build_container(make_settings(), mode="sql", session_factory=app_sf,
                        clock=clock)
    job = await _job(c, name="dupe")
    run = await c.batch_job_service._create_run(job, trigger="manual",
                                                actor=dict(BATCH_ACTOR), advance=False)

    def _rec():
        now = clock.now()
        return BatchJobRunIngestion(
            id=new_id(), tenant_id=TENANT_A, batch_job_run_id=run.id, binding_key="b0",
            ingestion_id=new_id(), status="triggered", dataset_urn=None,
            iceberg_snapshot_id=None, dataset_version_urn=None, error=None,
            created_at=now, updated_at=now)

    async with c.deps.uow_factory(TENANT_A) as uow:
        await uow.batch_ingestions.add(_rec())
    with pytest.raises(IntegrityError):
        async with c.deps.uow_factory(TENANT_A) as uow:
            await uow.batch_ingestions.add(_rec())


async def test_the_worker_policy_lets_the_sweeps_see_rows_across_tenants(app_sf,
                                                                         clock):
    """Under FORCE RLS the tenant_isolation policy alone matches ZERO rows for a
    session with no app.tenant_id — a silent no-op, not an error. Without the
    worker policy the due scan, the reaper and the deadline sweep would simply
    never find anything and the whole mechanism would look like it worked."""
    c = build_container(make_settings(), mode="sql", session_factory=app_sf,
                        clock=clock)
    job_a = await _job(c, name="tenant-a-job", cron="*/5 * * * *")
    job_b = await _job(c, name="tenant-b-job", tenant=TENANT_B, cron="*/5 * * * *")
    clock.advance(hours=1)

    due = {j.id for j in await c.batch_job_service.scanner.due(clock.now())}
    assert due == {job_a.id, job_b.id}

    # ...and a session with NO tenant context sees nothing without the worker GUC.
    async with app_sf() as s:
        blind = (await s.execute(text("SELECT count(*) FROM batch_jobs"))).scalar_one()
    assert blind == 0


async def test_the_orphan_scan_ignores_a_run_parked_in_the_ingestion_phase(app_sf,
                                                                           clock):
    """It holds no lease because it is WAITING on ingestion events, not working.
    Re-driving it would eventually re-enter the trigger step for a healthy run."""
    c = build_container(make_settings(), mode="sql", session_factory=app_sf,
                        clock=clock)
    job = await _job(c, name="parked")
    run = await c.batch_job_service._create_run(job, trigger="manual",
                                                actor=dict(BATCH_ACTOR), advance=False)
    async with c.deps.uow_factory(TENANT_A) as uow:
        fresh = await uow.batch_runs.get(run.id)
        fresh.phase = int(BatchPhase.ingestion)
        fresh.status = int(BatchRunStatus.running)
        await uow.batch_runs.update(fresh)
    clock.advance(seconds=100_000)
    now = clock.now()

    assert await c.batch_job_service.scanner.orphaned(
        now, now - timedelta(seconds=300)) == []

    # A run whose LEASE lapsed mid-trigger is a different story: that one is stranded.
    async with c.deps.uow_factory(TENANT_A) as uow:
        fresh = await uow.batch_runs.get(run.id)
        fresh.phase = int(BatchPhase.trigger)
        await uow.batch_runs.update(fresh)
        await uow.batch_runs.claim_lease(run.id, "dead-pod", now,
                                         now - timedelta(seconds=1))
    stranded = await c.batch_job_service.scanner.orphaned(
        now, now - timedelta(seconds=300))
    assert [r.id for r in stranded] == [run.id]


async def test_the_lease_is_a_single_conditional_update(app_sf, clock):
    """Two instances racing one run: the row lock serializes them and the loser's
    WHERE no longer matches. A check-then-set would let both drive — and both fire
    every binding."""
    c = build_container(make_settings(), mode="sql", session_factory=app_sf,
                        clock=clock)
    job = await _job(c, name="leased")
    run = await c.batch_job_service._create_run(job, trigger="manual",
                                                actor=dict(BATCH_ACTOR), advance=False)
    now = clock.now()
    ttl = now + timedelta(seconds=300)
    async with c.deps.uow_factory(TENANT_A) as uow:
        assert await uow.batch_runs.claim_lease(run.id, "pod-a", now, ttl)
    async with c.deps.uow_factory(TENANT_A) as uow:
        assert not await uow.batch_runs.claim_lease(run.id, "pod-b", now, ttl)
        assert await uow.batch_runs.renew_lease(run.id, "pod-a", ttl)
        assert not await uow.batch_runs.renew_lease(run.id, "pod-b", ttl)

    # An expired lease can be taken over.
    clock.advance(seconds=400)
    async with c.deps.uow_factory(TENANT_A) as uow:
        assert await uow.batch_runs.claim_lease(run.id, "pod-b", clock.now(),
                                                clock.now() + timedelta(seconds=300))


async def test_a_whole_row_update_cannot_erase_a_live_lease(app_sf, clock):
    c = build_container(make_settings(), mode="sql", session_factory=app_sf,
                        clock=clock)
    job = await _job(c, name="lease-keep")
    run = await c.batch_job_service._create_run(job, trigger="manual",
                                                actor=dict(BATCH_ACTOR), advance=False)
    now = clock.now()
    async with c.deps.uow_factory(TENANT_A) as uow:
        stale = await uow.batch_runs.get(run.id)          # read BEFORE the claim
        await uow.batch_runs.claim_lease(run.id, "pod-a", now,
                                         now + timedelta(seconds=300))
        stale.status = int(BatchRunStatus.running)
        await uow.batch_runs.update(stale)                # write back the stale copy
    async with c.deps.uow_factory(TENANT_A) as uow:
        fresh = await uow.batch_runs.get(run.id)
    assert fresh.status == int(BatchRunStatus.running)
    assert fresh.lease_owner == "pod-a", "the whole-row update erased the live lease"
