"""BRD 73 — batch job orchestration (chained ingest → pipeline).

Every failure mode this covers used to be SILENT, because there was no seam
between ingestion-service's cron and pipeline-orchestrator's cron — the pipeline
fired while the ingestion was still streaming and scored the previous batch, or
the ingestion failed and the pipeline ran anyway on stale data and reported
success. The assertions below are about ordering and refusal, not plumbing.

AC-1 the pipeline never starts before every ingestion is terminal · AC-2 a failed
ingestion fails the run in `ingestion` · AC-3 the run is pinned to the dataset
versions the batch produced · AC-4 a re-drive does not double-ingest · AC-5 two
instances racing one job, exactly one drives it · AC-6 retry resumes from the
failed phase · AC-7 a phase deadline fails rather than hangs · AC-8 batch-trigger
executes in the local executor and is idempotent · AC-9 phase transitions emit
outbox events.
"""

from __future__ import annotations

from datetime import timedelta

import httpx
import pytest

from app.api.schemas import batch_run_payload
from app.container import build_container
from app.domain.batch import BatchJobService
from app.domain.enums import BatchPhase, BatchRunStatus, RunStatus
from app.main import create_app
from tests.conftest import (
    TENANT_A,
    TENANT_B,
    WORKSPACE,
    FakeExecutor,
    FakeMlflow,
    auth,
    data_prep_definition,
    make_settings,
)

# No module-level asyncio mark: this file mixes async and sync tests, and
# `asyncio_mode = "auto"` (pyproject) already runs the async ones.

DATASET = "wr:t:dataset:dataset/claims"


# ---------------------------------------------------------------- test doubles

class FakeIngestionClient:
    """Speaks HttpIngestionClient's shape without ingestion-service, and — this is
    the part that matters — REPLAYS a repeated Idempotency-Key exactly as
    ingestion-service's `run_idempotent` does. A double that happily minted a
    second ingestion for the same key would make the AC-4 test prove nothing."""

    def __init__(self, *, fail: bool = False, inline_status: str = "created"):
        self.calls: list[tuple[str, dict, str]] = []
        self.by_key: dict[str, dict] = {}
        self.fail = fail
        self.inline_status = inline_status
        self._n = 0

    async def create_ingestion(self, tenant_id, args, *, idempotency_key):
        self.calls.append((tenant_id, dict(args), idempotency_key))
        if self.fail:
            from app.domain.errors import DependencyUnavailable

            raise DependencyUnavailable("ingestion-service unreachable")
        if idempotency_key in self.by_key:
            return dict(self.by_key[idempotency_key])
        self._n += 1
        ingestion = {"id": f"ing-{self._n}", "status": self.inline_status,
                     "dataset_urn": args.get("dataset_urn") or DATASET}
        self.by_key[idempotency_key] = ingestion
        return dict(ingestion)

    @property
    def created(self) -> list[str]:
        """Distinct ingestions actually created — a replay is not a creation."""
        return [i["id"] for i in self.by_key.values()]


def _container(tmp_path, clock, *, ingestion_client=None, **overrides):
    executor = overrides.pop("executor", None) or FakeExecutor()
    settings = make_settings(tmp_path, default_min_seconds_between_runs=0,
                             warehouse_sink="local", **overrides)
    c = build_container(settings, mode="memory", clock=clock, executor=executor,
                        mlflow=FakeMlflow(),
                        ingestion_client=ingestion_client or FakeIngestionClient())
    # Drive explicitly in tests so nothing races the assertions.
    c.schedule_drive = lambda *a, **k: None
    c.drive_batch_run = lambda *a, **k: None
    return c


async def _client(c):
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=create_app(c)),
                             base_url="http://test")


async def _template(cl, tenant=TENANT_A, name="claims-prep"):
    body = {"workspace_id": WORKSPACE, "name": name, "pipeline_type": "data_prep",
            "definition": data_prep_definition(dataset=DATASET)}
    resp = await cl.post("/api/v1/pipelines", json=body, headers=auth(tenant))
    assert resp.status_code in (200, 201), resp.text
    return resp.json()["data"]["id"]


def _bindings(n=1):
    return [{"connection_id": f"conn-{i}", "binding_key": f"b{i}",
             "ingestion_params": {"ingestion_mode": "query",
                                  "statement": f"select {i}"}}
            for i in range(n)]


async def _job(cl, template_id, *, bindings=None, tenant=TENANT_A, name="nightly",
               **extra):
    body = {"workspace_id": WORKSPACE, "name": name,
            "pipeline_template_id": template_id,
            "connection_bindings": bindings or _bindings(1), **extra}
    resp = await cl.post("/api/v1/batch-jobs", json=body, headers=auth(tenant))
    assert resp.status_code == 201, resp.text
    return resp.json()["data"]


async def _run_now(cl, job_id, tenant=TENANT_A):
    resp = await cl.post(f"/api/v1/batch-jobs/{job_id}/run-now", headers=auth(tenant))
    assert resp.status_code == 202, resp.text
    return resp.json()["data"]


async def _get_run(c, run_id, tenant=TENANT_A):
    async with c.deps.uow_factory(tenant) as uow:
        return await uow.batch_runs.get(run_id)


async def _records(c, run_id, tenant=TENANT_A):
    async with c.deps.uow_factory(tenant) as uow:
        return await uow.batch_ingestions.list_for_run(run_id)


def _ingestion_event(tenant, ingestion_id, event_type="ingestion.completed", **payload):
    return {"event_id": f"ev-{ingestion_id}-{event_type}", "event_type": event_type,
            "tenant_id": tenant, "actor": {"type": "service", "id": "ingestion"},
            "resource_urn": f"wr:{tenant}:ingestion:ingestion/{ingestion_id}",
            "payload": {"ingestion_id": ingestion_id, "dataset_urn": DATASET,
                        "iceberg_snapshot_id": 4242, **payload}}


def _version_event(tenant, ingestion_id, version_no=7, dataset_id="claims"):
    return {"event_id": f"ev-v-{ingestion_id}", "event_type": "dataset.version_created",
            "tenant_id": tenant, "actor": {"type": "service", "id": "dataset"},
            "resource_urn": f"wr:{tenant}:dataset:version/{dataset_id}@v{version_no}",
            "payload": {"dataset_urn": f"wr:{tenant}:dataset:dataset/{dataset_id}",
                        "version_no": version_no, "iceberg_snapshot_id": 4242,
                        "produced_by_urn":
                            f"wr:{tenant}:ingestion:ingestion/{ingestion_id}"}}


async def _land(c, run_id, tenant=TENANT_A, *, version_no=7):
    """Deliver the real event sequence ingestion-service + dataset-service emit
    when a batch lands, through the actual consumer."""
    for rec in await _records(c, run_id, tenant):
        await c.consumer.handle(_ingestion_event(tenant, rec.ingestion_id))
        await c.consumer.handle(_version_event(tenant, rec.ingestion_id,
                                               version_no=version_no))
    await c.batch_job_service.wait_for_drives()


# ------------------------------------------------------------------ AC-1 order

async def test_the_pipeline_phase_does_not_start_until_every_ingestion_is_terminal(
        tmp_path, clock):
    """AC-1. The whole point: two independent crons cannot express "wait for the
    batch", so the pipeline fired while data was still streaming and scored the
    PREVIOUS batch, silently."""
    c = _container(tmp_path, clock)
    async with await _client(c) as cl:
        job = await _job(cl, await _template(cl), bindings=_bindings(2))
        run = await _run_now(cl, job["id"])

    await c.batch_job_service.drive_run(TENANT_A, run["id"])
    parked = await _get_run(c, run["id"])
    assert parked.phase == int(BatchPhase.ingestion)
    assert parked.pipeline_run_id is None, "the pipeline started before the batch landed"

    # Only ONE of the two ingestions lands.
    recs = await _records(c, run["id"])
    await c.consumer.handle(_ingestion_event(TENANT_A, recs[0].ingestion_id))
    await c.consumer.handle(_version_event(TENANT_A, recs[0].ingestion_id))
    await c.batch_job_service.wait_for_drives()

    still_waiting = await _get_run(c, run["id"])
    assert still_waiting.phase == int(BatchPhase.ingestion)
    assert still_waiting.pipeline_run_id is None

    # ...and now the second.
    await c.consumer.handle(_ingestion_event(TENANT_A, recs[1].ingestion_id))
    await c.consumer.handle(_version_event(TENANT_A, recs[1].ingestion_id))
    await c.batch_job_service.wait_for_drives()

    final = await _get_run(c, run["id"])
    assert final.status == int(BatchRunStatus.succeeded)
    assert final.phase == int(BatchPhase.pipeline)
    assert final.pipeline_run_id is not None


async def test_the_ingestion_phase_is_advanced_by_events_not_by_polling(tmp_path,
                                                                        clock):
    """The consumer is the informer. Driving the run again without any event must
    change nothing — there is no poll that could discover the ingestion landed."""
    c = _container(tmp_path, clock)
    async with await _client(c) as cl:
        job = await _job(cl, await _template(cl))
        run = await _run_now(cl, job["id"])
    await c.batch_job_service.drive_run(TENANT_A, run["id"])

    for _ in range(3):
        await c.batch_job_service.drive_run(TENANT_A, run["id"])
    assert (await _get_run(c, run["id"])).phase == int(BatchPhase.ingestion)
    # Re-driving must not have re-fired anything either.
    assert len(c.deps.ingestion_client.created) == 1


# ------------------------------------------------------- AC-2 failed ingestion

async def test_a_failed_ingestion_fails_the_run_in_the_ingestion_phase(tmp_path,
                                                                       clock):
    """AC-2. Before this, a failed ingestion left the pipeline cron to run anyway
    on stale data and report success — the worst outcome available."""
    c = _container(tmp_path, clock)
    async with await _client(c) as cl:
        job = await _job(cl, await _template(cl))
        run = await _run_now(cl, job["id"])
    await c.batch_job_service.drive_run(TENANT_A, run["id"])

    rec = (await _records(c, run["id"]))[0]
    await c.consumer.handle(_ingestion_event(
        TENANT_A, rec.ingestion_id, event_type="ingestion.failed",
        error_category="SOURCE_UNREACHABLE", attempts=3))
    await c.batch_job_service.wait_for_drives()

    failed = await _get_run(c, run["id"])
    assert failed.status == int(BatchRunStatus.failed)
    assert failed.phase == int(BatchPhase.ingestion)
    assert failed.error["code"] == "BATCH_INGESTION_FAILED"
    assert failed.error["phase"] == "ingestion"
    assert failed.pipeline_run_id is None, "the pipeline ran on a batch that failed"


async def test_a_cancelled_ingestion_also_stops_the_pipeline_phase(tmp_path, clock):
    c = _container(tmp_path, clock)
    async with await _client(c) as cl:
        job = await _job(cl, await _template(cl))
        run = await _run_now(cl, job["id"])
    await c.batch_job_service.drive_run(TENANT_A, run["id"])
    rec = (await _records(c, run["id"]))[0]
    await c.consumer.handle(_ingestion_event(TENANT_A, rec.ingestion_id,
                                             event_type="ingestion.cancelled"))
    await c.batch_job_service.wait_for_drives()

    failed = await _get_run(c, run["id"])
    assert failed.status == int(BatchRunStatus.failed)
    assert failed.pipeline_run_id is None


async def test_a_failed_trigger_fails_the_run_in_the_trigger_phase(tmp_path, clock):
    c = _container(tmp_path, clock,
                   ingestion_client=FakeIngestionClient(fail=True))
    async with await _client(c) as cl:
        job = await _job(cl, await _template(cl))
        run = await _run_now(cl, job["id"])

    await c.batch_job_service.drive_run(TENANT_A, run["id"])
    failed = await _get_run(c, run["id"])
    assert failed.status == int(BatchRunStatus.failed)
    assert failed.error["phase"] == "trigger"
    assert failed.error["code"] == "DEPENDENCY_UNAVAILABLE"


async def test_a_batch_job_without_an_ingestion_client_fails_honestly(tmp_path,
                                                                      clock):
    """No stubs: with nothing wired to ingestion-service the run must FAIL, not
    quietly skip the trigger phase and go score whatever is already there."""
    c = _container(tmp_path, clock)
    c.deps.ingestion_client = None
    async with await _client(c) as cl:
        job = await _job(cl, await _template(cl))
        run = await _run_now(cl, job["id"])

    await c.batch_job_service.drive_run(TENANT_A, run["id"])
    failed = await _get_run(c, run["id"])
    assert failed.status == int(BatchRunStatus.failed)
    assert "ingestion client" in failed.error["message"]


# --------------------------------------------------------------- AC-3 pinning

async def test_the_pipeline_run_is_pinned_to_the_versions_this_batch_produced(
        tmp_path, clock):
    """AC-3. "Which data produced this score" had no answer at the job level: the
    only link between run N and batch N was that they happened near each other."""
    c = _container(tmp_path, clock)
    async with await _client(c) as cl:
        job = await _job(cl, await _template(cl))
        run = await _run_now(cl, job["id"])
    await c.batch_job_service.drive_run(TENANT_A, run["id"])
    await _land(c, run["id"], version_no=12)

    final = await _get_run(c, run["id"])
    version_urn = f"wr:{TENANT_A}:dataset:version/claims@v12"
    assert final.input_dataset_urns == [version_urn]

    async with c.deps.uow_factory(TENANT_A) as uow:
        pipeline_run = await uow.runs.get(final.pipeline_run_id)
    assert version_urn in pipeline_run.input_dataset_urns
    # and the exact snapshot rides along as a run parameter
    pins = pipeline_run.run_parameters["batch_datasets"]
    assert pins[0]["dataset_version_urn"] == version_urn
    assert pins[0]["iceberg_snapshot_id"] == "4242"
    assert pipeline_run.run_parameters["batch_key"] == final.batch_key


async def test_the_run_waits_for_the_version_before_starting_the_pipeline(tmp_path,
                                                                          clock):
    """A completed ingestion whose dataset version has not been registered yet
    cannot be pinned to, so advancing would produce a run that cannot say what it
    consumed. Wait instead."""
    c = _container(tmp_path, clock)
    async with await _client(c) as cl:
        job = await _job(cl, await _template(cl))
        run = await _run_now(cl, job["id"])
    await c.batch_job_service.drive_run(TENANT_A, run["id"])

    rec = (await _records(c, run["id"]))[0]
    await c.consumer.handle(_ingestion_event(TENANT_A, rec.ingestion_id))
    await c.batch_job_service.wait_for_drives()
    assert (await _get_run(c, run["id"])).pipeline_run_id is None

    await c.consumer.handle(_version_event(TENANT_A, rec.ingestion_id))
    await c.batch_job_service.wait_for_drives()
    assert (await _get_run(c, run["id"])).pipeline_run_id is not None


# ------------------------------------------------- AC-4 no double-ingest

async def test_a_reaper_re_drive_does_not_double_ingest(tmp_path, clock):
    """AC-4. Double-driving a plain pipeline run wastes compute; double-driving a
    batch job ingests the same batch twice, which corrupts the data."""
    c = _container(tmp_path, clock)
    async with await _client(c) as cl:
        job = await _job(cl, await _template(cl), bindings=_bindings(2))
        run = await _run_now(cl, job["id"])

    await c.batch_job_service.drive_run(TENANT_A, run["id"])
    assert len(c.deps.ingestion_client.created) == 2

    # The pod died; the lease lapsed; the reaper hands the run to this instance.
    clock.advance(seconds=400)
    assert await c.batch_job_service.recover_orphans() == []  # parked in `ingestion`

    # Force the re-drive the reaper would do if the pod had died mid-TRIGGER.
    async with c.deps.uow_factory(TENANT_A) as uow:
        stranded = await uow.batch_runs.get(run["id"])
        stranded.phase = int(BatchPhase.trigger)
        await uow.batch_runs.update(stranded)
    await c.batch_job_service.drive_run(TENANT_A, run["id"])

    assert len(c.deps.ingestion_client.created) == 2, "the batch was ingested twice"
    assert len(await _records(c, run["id"])) == 2


async def test_a_crash_between_the_remote_call_and_the_local_record_still_replays(
        tmp_path, clock):
    """The window a local record alone cannot close: ingestion-service created the
    ingestion, then this pod died before writing the row. The re-drive sends the
    SAME Idempotency-Key, so the remote replays instead of creating a second."""
    client = FakeIngestionClient()
    c = _container(tmp_path, clock, ingestion_client=client)
    async with await _client(c) as cl:
        job = await _job(cl, await _template(cl))
        run = await _run_now(cl, job["id"])

    # Simulate the lost write: call the remote, drop the record on the floor.
    fresh = await _get_run(c, run["id"])
    await client.create_ingestion(TENANT_A, {}, idempotency_key=f"{fresh.batch_key}:b0")
    assert len(client.created) == 1

    await c.batch_job_service.drive_run(TENANT_A, run["id"])
    assert len(client.created) == 1, "the remote minted a second ingestion"
    assert (await _records(c, run["id"]))[0].ingestion_id == "ing-1"


# ------------------------------------------------------------- AC-5 the lease

async def test_two_instances_racing_one_run_only_one_drives_it(tmp_path, clock):
    """AC-5. The loser must not fire the bindings: that is the double-ingest."""
    c = _container(tmp_path, clock)
    async with await _client(c) as cl:
        job = await _job(cl, await _template(cl))
        run = await _run_now(cl, job["id"])

    now = clock.now()
    async with c.deps.uow_factory(TENANT_A) as uow:
        assert await uow.batch_runs.claim_lease(run["id"], "pod-a", now,
                                                now + timedelta(seconds=300))
    c.deps.settings.instance_id = "pod-b"

    final = await c.batch_job_service.drive_run(TENANT_A, run["id"])
    assert final.status == int(BatchRunStatus.pending), "pod-b drove a leased run"
    assert c.deps.ingestion_client.calls == [], "pod-b fired the bindings anyway"


async def test_two_instances_firing_one_due_job_create_only_one_run(tmp_path, clock):
    """The other half of AC-5: both instances' tickers scan the same due row
    BEFORE either has created its run. A second run would fire every binding a
    second time, so the at-most-one-active-run constraint has to refuse it."""
    from app.domain.batch import BATCH_ACTOR
    from app.domain.errors import Conflict

    c = _container(tmp_path, clock)
    async with await _client(c) as cl:
        job = await _job(cl, await _template(cl), cron="*/5 * * * *")

    other = BatchJobService(c.deps, c.run_service, c.batch_job_service.scanner)
    clock.advance(hours=1)
    due = await c.batch_job_service.scanner.due(clock.now())
    assert len(due) == 1

    await c.batch_job_service._create_run(due[0], trigger="schedule",
                                          actor=dict(BATCH_ACTOR), advance=True)
    with pytest.raises(Conflict):
        await other._create_run(due[0], trigger="schedule", actor=dict(BATCH_ACTOR),
                                advance=True)

    async with c.deps.uow_factory(TENANT_A) as uow:
        page = await uow.batch_runs.list_for_job(job["id"], 50, None)
    assert len(page.items) == 1


async def test_the_ticker_skips_a_job_whose_previous_run_is_still_active(tmp_path,
                                                                         clock):
    """Same constraint from the ticker's side: it advances the cron and moves on
    rather than hot-looping or stacking a second ingest on top of a live one."""
    c = _container(tmp_path, clock)
    async with await _client(c) as cl:
        job = await _job(cl, await _template(cl), cron="*/5 * * * *")
    clock.advance(hours=1)
    assert len(await c.batch_job_service.fire_due()) == 1
    clock.advance(hours=1)
    assert await c.batch_job_service.fire_due() == []

    async with c.deps.uow_factory(TENANT_A) as uow:
        page = await uow.batch_runs.list_for_job(job["id"], 50, None)
        refreshed = await uow.batch_jobs.get(job["id"])
    assert len(page.items) == 1
    assert refreshed.next_fire_at > clock.now()  # advanced, not hot-looping


async def test_a_finished_run_releases_its_lease(tmp_path, clock):
    c = _container(tmp_path, clock)
    async with await _client(c) as cl:
        job = await _job(cl, await _template(cl))
        run = await _run_now(cl, job["id"])
    await c.batch_job_service.drive_run(TENANT_A, run["id"])
    await _land(c, run["id"])

    final = await _get_run(c, run["id"])
    assert final.status == int(BatchRunStatus.succeeded)
    assert final.lease_owner is None and final.lease_expires_at is None


async def test_a_run_updates_itself_without_erasing_its_own_lease(tmp_path, clock):
    """Same trap as pipeline_runs: a whole-row write of a copy read BEFORE the
    claim would erase the lease its holder is heartbeating."""
    c = _container(tmp_path, clock)
    async with await _client(c) as cl:
        job = await _job(cl, await _template(cl))
        run = await _run_now(cl, job["id"])
    now = clock.now()
    async with c.deps.uow_factory(TENANT_A) as uow:
        stale = await uow.batch_runs.get(run["id"])
        await uow.batch_runs.claim_lease(run["id"], "pod-a", now,
                                         now + timedelta(seconds=300))
        stale.status = int(BatchRunStatus.running)
        await uow.batch_runs.update(stale)
    assert (await _get_run(c, run["id"])).lease_owner == "pod-a"


async def test_a_run_parked_in_the_ingestion_phase_is_not_treated_as_orphaned(
        tmp_path, clock):
    """It holds no lease because it is WAITING, not working. Reaping it would
    re-drive (and eventually re-trigger) a perfectly healthy run."""
    c = _container(tmp_path, clock)
    async with await _client(c) as cl:
        job = await _job(cl, await _template(cl))
        run = await _run_now(cl, job["id"])
    await c.batch_job_service.drive_run(TENANT_A, run["id"])
    clock.advance(seconds=100_000)

    assert await c.batch_job_service.recover_orphans() == []


async def test_a_run_stranded_mid_trigger_is_re_driven(tmp_path, clock):
    c = _container(tmp_path, clock)
    async with await _client(c) as cl:
        job = await _job(cl, await _template(cl))
        run = await _run_now(cl, job["id"])
    now = clock.now()
    async with c.deps.uow_factory(TENANT_A) as uow:
        await uow.batch_runs.claim_lease(run["id"], "dead-pod", now,
                                         now + timedelta(seconds=300))
    clock.advance(seconds=400)

    assert await c.batch_job_service.recover_orphans() == [run["id"]]
    await c.batch_job_service.wait_for_drives()
    assert (await _get_run(c, run["id"])).phase == int(BatchPhase.ingestion)
    assert len(c.deps.ingestion_client.created) == 1


# ---------------------------------------------------------------- AC-6 retry

async def test_retry_resumes_from_the_failed_phase_without_re_ingesting(tmp_path,
                                                                        clock):
    """AC-6. The ingestion phase SUCCEEDED; only the pipeline failed. Restarting
    at `trigger` would pull the same batch a second time."""
    executor = FakeExecutor(fail=True)
    c = _container(tmp_path, clock, executor=executor)
    async with await _client(c) as cl:
        # A training template so the (failing) FakeExecutor is on the path.
        r = await cl.post("/api/v1/algorithm-templates/xgboost/pipelines",
                          json={"workspace_id": WORKSPACE, "mode": "train",
                                "dataset_refs": {"TRAIN": DATASET},
                                "parameters": {"label_column": "label"}, "name": "t"},
                          headers=auth())
        template_id = r.json()["data"]["id"]
        job = await _job(cl, template_id,
                         run_parameters={"training_data": [{"a": 1, "label": "x"}]})
        run = await _run_now(cl, job["id"])
        await c.batch_job_service.drive_run(TENANT_A, run["id"])
        await _land(c, run["id"])

        failed = await _get_run(c, run["id"])
        assert failed.status == int(BatchRunStatus.failed)
        assert failed.phase == int(BatchPhase.pipeline)
        triggered_once = len(c.deps.ingestion_client.created)

        resp = await cl.post(f"/api/v1/batch-job-runs/{run['id']}/retry",
                             headers=auth())
        assert resp.status_code == 202, resp.text
        retried = resp.json()["data"]

    assert retried["phase"] == "pipeline", "retry restarted at trigger"
    assert retried["retried_from_run_id"] == run["id"]

    executor.fail = False
    await c.batch_job_service.drive_run(TENANT_A, retried["id"])

    final = await _get_run(c, retried["id"])
    assert final.status == int(BatchRunStatus.succeeded)
    assert len(c.deps.ingestion_client.created) == triggered_once, \
        "retrying a succeeded ingestion phase ingested the batch again"
    # ...and the retry is pinned to the SAME batch the first attempt landed.
    assert final.input_dataset_urns == failed.input_dataset_urns


async def test_retry_of_an_ingestion_failure_re_triggers_only_the_failed_binding(
        tmp_path, clock):
    """Resuming `ingestion` means "get these bindings ingested". The one that
    landed is carried over untouched; only the failed one is fired again — and as
    a genuinely NEW ingestion, not a replay of the failed one."""
    c = _container(tmp_path, clock)
    async with await _client(c) as cl:
        job = await _job(cl, await _template(cl), bindings=_bindings(2))
        run = await _run_now(cl, job["id"])
        await c.batch_job_service.drive_run(TENANT_A, run["id"])

        recs = await _records(c, run["id"])
        await c.consumer.handle(_ingestion_event(TENANT_A, recs[0].ingestion_id))
        await c.consumer.handle(_version_event(TENANT_A, recs[0].ingestion_id))
        await c.consumer.handle(_ingestion_event(TENANT_A, recs[1].ingestion_id,
                                                 event_type="ingestion.failed"))
        await c.batch_job_service.wait_for_drives()
        assert (await _get_run(c, run["id"])).phase == int(BatchPhase.ingestion)

        resp = await cl.post(f"/api/v1/batch-job-runs/{run['id']}/retry",
                             headers=auth())
        retried = resp.json()["data"]
    assert retried["phase"] == "ingestion"

    await c.batch_job_service.drive_run(TENANT_A, retried["id"])
    new_recs = {r.binding_key: r for r in await _records(c, retried["id"])}
    assert new_recs["b0"].ingestion_id == recs[0].ingestion_id, "re-ingested b0"
    assert new_recs["b0"].status == "completed"
    assert new_recs["b1"].ingestion_id != recs[1].ingestion_id, \
        "replayed the FAILED ingestion instead of starting a new one"
    assert len(c.deps.ingestion_client.created) == 3


async def test_only_failed_runs_can_be_retried(tmp_path, clock):
    c = _container(tmp_path, clock)
    async with await _client(c) as cl:
        job = await _job(cl, await _template(cl))
        run = await _run_now(cl, job["id"])
        resp = await cl.post(f"/api/v1/batch-job-runs/{run['id']}/retry",
                             headers=auth())
    assert resp.status_code == 409


# ------------------------------------------------------------- AC-7 deadlines

async def test_a_phase_deadline_fails_the_run_rather_than_hanging(tmp_path, clock):
    """AC-7. The ingestion phase waits on events, and events can simply never
    arrive. Hanging would look alive AND block the job forever, because its
    previous run is still active."""
    c = _container(tmp_path, clock, batch_phase_deadline_seconds=600)
    async with await _client(c) as cl:
        job = await _job(cl, await _template(cl))
        run = await _run_now(cl, job["id"])
    await c.batch_job_service.drive_run(TENANT_A, run["id"])
    assert await c.batch_job_service.sweep_deadlines() == []

    clock.advance(seconds=900)
    assert await c.batch_job_service.sweep_deadlines() == [run["id"]]

    timed_out = await _get_run(c, run["id"])
    assert timed_out.status == int(BatchRunStatus.failed)
    assert timed_out.error["code"] == "BATCH_PHASE_TIMEOUT"
    assert timed_out.error["phase"] == "ingestion"
    assert timed_out.lease_owner is None


async def test_a_per_job_phase_timeout_overrides_the_default(tmp_path, clock):
    c = _container(tmp_path, clock, batch_phase_deadline_seconds=100_000)
    async with await _client(c) as cl:
        job = await _job(cl, await _template(cl), phase_timeout_seconds=60)
        run = await _run_now(cl, job["id"])
    await c.batch_job_service.drive_run(TENANT_A, run["id"])
    clock.advance(seconds=120)
    assert await c.batch_job_service.sweep_deadlines() == [run["id"]]


async def test_a_timed_out_run_is_retryable_from_the_phase_it_timed_out_in(tmp_path,
                                                                           clock):
    c = _container(tmp_path, clock, batch_phase_deadline_seconds=600)
    async with await _client(c) as cl:
        job = await _job(cl, await _template(cl))
        run = await _run_now(cl, job["id"])
        await c.batch_job_service.drive_run(TENANT_A, run["id"])
        clock.advance(seconds=900)
        await c.batch_job_service.sweep_deadlines()
        resp = await cl.post(f"/api/v1/batch-job-runs/{run['id']}/retry",
                             headers=auth())
    assert resp.status_code == 202
    assert resp.json()["data"]["phase"] == "ingestion"


# -------------------------------------------------------- AC-8 batch-trigger

def test_batch_trigger_is_in_the_catalog_as_a_zero_in_zero_out_io_component():
    from app.domain.catalog import IO, seed_components

    comp = {c.name: c for c in seed_components()}["batch-trigger"]
    assert comp.component_type == IO
    assert comp.definition["min_inputs"] == 0
    assert comp.definition["max_inputs"] == 0
    assert comp.definition["max_outputs"] == 0
    assert comp.definition["parameters"]["connection_id"]["required"] is True


def test_a_pipeline_containing_batch_trigger_validates():
    """It has no output port, so it is always a graph terminal — a terminal rule
    that did not know about it would reject every pipeline that pulls mid-DAG."""
    from app.domain.catalog import seed_components
    from app.domain.dag import validate_definition
    from app.domain.enums import PipelineType

    definition = data_prep_definition(dataset=DATASET)
    definition["nodes"].append({"alias": "pull-1", "component": "batch-trigger",
                                "parameters": {"connection_id": "conn-1"},
                                "outputs": []})
    report = validate_definition(
        definition, pipeline_type=PipelineType.data_prep, model_type=None,
        components={c.name: c for c in seed_components()},
        quota_ceiling={"cpus": 7, "ram_gb": 24, "timeout_minutes": 480}, mode="all")
    assert report.valid, report.items


def test_batch_trigger_executes_in_the_local_executor_and_is_idempotent():
    """AC-8. The same run re-driven fires the same Idempotency-Key, so the
    ingestion is replayed rather than duplicated."""
    from app.executor.local_pipeline import LocalPipelineExecutor

    seen: list[tuple[str, dict]] = []
    minted: dict[str, dict] = {}

    def trigger(alias, params):
        seen.append((alias, dict(params)))
        key = f"run-1:{alias}"
        if key not in minted:
            minted[key] = {"id": f"ing-{len(minted) + 1}", "status": "created"}
        return dict(minted[key])

    definition = {"nodes": [{"alias": "pull-1", "component": "batch-trigger",
                             "parameters": {"connection_id": "conn-1",
                                            "ingestion_mode": "query"}}],
                  "edges": []}
    ex = LocalPipelineExecutor(trigger=trigger)
    first = ex.run(definition, {})
    second = ex.run(definition, {})

    assert first.triggered_ingestions["pull-1"]["id"] == "ing-1"
    assert second.triggered_ingestions["pull-1"]["id"] == "ing-1"
    assert len(minted) == 1
    assert first.statuses[0].component == "batch-trigger"
    assert first.statuses[0].phase == "Succeeded"
    assert seen[0][1]["connection_id"] == "conn-1"


def test_batch_trigger_fails_closed_when_nothing_is_wired():
    """A node that silently did nothing would be exactly the "the pipeline ran, so
    the data must be fresh" lie BRD 73 exists to remove."""
    from app.executor.local_pipeline import LocalPipelineExecutor, PipelineExecutionError

    definition = {"nodes": [{"alias": "pull-1", "component": "batch-trigger",
                             "parameters": {"connection_id": "conn-1"}}], "edges": []}
    with pytest.raises(PipelineExecutionError):
        LocalPipelineExecutor().run(definition, {})


async def test_batch_trigger_runs_through_a_real_data_prep_run(tmp_path, clock):
    """End to end on the local executor path: a data-prep run whose DAG contains a
    batch-trigger node really calls the ingestion client and records the ingestion
    id on the node's component status."""
    from app.adapters.dataset_reader import InMemoryDatasetReader

    c = _container(tmp_path, clock)
    c.deps.dataset_reader = InMemoryDatasetReader({DATASET: [{"a": 1}, {"a": 2}]})
    definition = data_prep_definition(dataset=DATASET)
    definition["nodes"].append({"alias": "pull-1", "component": "batch-trigger",
                                "parameters": {"connection_id": "conn-9"},
                                "outputs": []})
    async with await _client(c) as cl:
        resp = await cl.post("/api/v1/pipelines",
                             json={"workspace_id": WORKSPACE, "name": "pull-and-prep",
                                   "pipeline_type": "data_prep",
                                   "definition": definition}, headers=auth())
        assert resp.status_code in (200, 201), resp.text
        template_id = resp.json()["data"]["id"]
        r = await cl.post(f"/api/v1/pipelines/{template_id}/run", json={},
                          headers=auth())
        run_id = r.json()["data"]["id"]

    final = await c.run_service.drive_run(TENANT_A, run_id)
    assert final.status == int(RunStatus.succeeded), final.error
    assert final.components_status["pull-1"]["ingestion_id"] == "ing-1"
    assert c.deps.ingestion_client.calls[0][2] == f"{run_id}:pull-1"


# --------------------------------------------------------------- AC-9 events

async def test_phase_transitions_emit_outbox_events(tmp_path, clock):
    c = _container(tmp_path, clock)
    async with await _client(c) as cl:
        job = await _job(cl, await _template(cl))
        run = await _run_now(cl, job["id"])
    await c.batch_job_service.drive_run(TENANT_A, run["id"])
    await _land(c, run["id"])

    events = [e["payload"] for e in c.memory_state.outbox]
    types = [e["event_type"] for e in events]
    assert "batch_job.created" in types
    assert "batch_job.run.started" in types
    assert "batch_job.run.succeeded" in types
    phases = [e["payload"]["phase"] for e in events
              if e["event_type"] == "batch_job.run.phase_changed"]
    assert phases == ["ingestion", "pipeline"]
    urns = {e["resource_urn"] for e in events
            if e["event_type"].startswith("batch_job.run.")}
    assert urns == {f"wr:{TENANT_A}:pipeline:batch-job-run/{run['id']}"}


async def test_a_failed_run_emits_a_phase_scoped_failure_event(tmp_path, clock):
    c = _container(tmp_path, clock)
    async with await _client(c) as cl:
        job = await _job(cl, await _template(cl))
        run = await _run_now(cl, job["id"])
    await c.batch_job_service.drive_run(TENANT_A, run["id"])
    rec = (await _records(c, run["id"]))[0]
    await c.consumer.handle(_ingestion_event(TENANT_A, rec.ingestion_id,
                                             event_type="ingestion.failed"))
    await c.batch_job_service.wait_for_drives()

    failed = [e["payload"] for e in c.memory_state.outbox
              if e["payload"]["event_type"] == "batch_job.run.failed"]
    assert len(failed) == 1
    assert failed[0]["payload"]["phase"] == "ingestion"


# ------------------------------------------------------ CRUD / API / isolation

async def test_batch_job_crud_and_run_timeline(tmp_path, clock):
    c = _container(tmp_path, clock)
    async with await _client(c) as cl:
        template_id = await _template(cl)
        job = await _job(cl, template_id, cron="0 2 * * *")
        assert job["next_fire_at"] is not None

        listed = await cl.get("/api/v1/batch-jobs", headers=auth())
        assert [j["id"] for j in listed.json()["data"]] == [job["id"]]

        patched = await cl.patch(f"/api/v1/batch-jobs/{job['id']}",
                                 json={"name": "renamed"}, headers=auth())
        assert patched.json()["data"]["name"] == "renamed"

        paused = await cl.post(f"/api/v1/batch-jobs/{job['id']}/pause", headers=auth())
        assert paused.json()["data"]["paused"] is True
        resumed = await cl.post(f"/api/v1/batch-jobs/{job['id']}/resume",
                                headers=auth())
        assert resumed.json()["data"]["paused"] is False

        run = await _run_now(cl, job["id"])
        await c.batch_job_service.drive_run(TENANT_A, run["id"])
        detail = await cl.get(f"/api/v1/batch-job-runs/{run['id']}", headers=auth())
        body = detail.json()["data"]
        assert body["phase"] == "ingestion"
        assert [i["binding_key"] for i in body["ingestions"]] == ["b0"]
        assert body["ingestions"][0]["ingestion_id"] == "ing-1"

        runs = await cl.get(f"/api/v1/batch-jobs/{job['id']}/runs", headers=auth())
        assert [r["id"] for r in runs.json()["data"]] == [run["id"]]

        assert (await cl.delete(f"/api/v1/batch-jobs/{job['id']}",
                                headers=auth())).status_code == 204
        assert (await cl.get(f"/api/v1/batch-jobs/{job['id']}",
                             headers=auth())).status_code == 404


async def test_a_paused_job_does_not_fire(tmp_path, clock):
    c = _container(tmp_path, clock)
    async with await _client(c) as cl:
        job = await _job(cl, await _template(cl), cron="*/5 * * * *")
        await cl.post(f"/api/v1/batch-jobs/{job['id']}/pause", headers=auth())
    clock.advance(hours=1)
    assert await c.batch_job_service.fire_due() == []


async def test_a_cron_fire_creates_and_advances(tmp_path, clock):
    c = _container(tmp_path, clock)
    async with await _client(c) as cl:
        job = await _job(cl, await _template(cl), cron="*/5 * * * *")
    before = job["next_fire_at"]
    clock.advance(hours=1)

    fired = await c.batch_job_service.fire_due()
    assert len(fired) == 1 and fired[0].trigger == "schedule"
    async with c.deps.uow_factory(TENANT_A) as uow:
        refreshed = await uow.batch_jobs.get(job["id"])
    assert refreshed.next_fire_at.isoformat() != before
    assert refreshed.last_run_id == fired[0].id


async def test_cross_tenant_reads_404(tmp_path, clock):
    c = _container(tmp_path, clock)
    async with await _client(c) as cl:
        job = await _job(cl, await _template(cl))
        run = await _run_now(cl, job["id"])
        assert (await cl.get(f"/api/v1/batch-jobs/{job['id']}",
                             headers=auth(TENANT_B))).status_code == 404
        assert (await cl.get(f"/api/v1/batch-job-runs/{run['id']}",
                             headers=auth(TENANT_B))).status_code == 404
        assert (await cl.get(f"/api/v1/batch-jobs/{job['id']}/runs",
                             headers=auth(TENANT_B))).status_code == 404


async def test_a_job_needs_at_least_one_binding_and_a_runnable_mode(tmp_path, clock):
    c = _container(tmp_path, clock)
    async with await _client(c) as cl:
        template_id = await _template(cl)
        empty = await cl.post("/api/v1/batch-jobs",
                              json={"workspace_id": WORKSPACE, "name": "x",
                                    "pipeline_template_id": template_id,
                                    "connection_bindings": []}, headers=auth())
        assert empty.status_code == 422

        # file_upload needs a human to push bytes, so a cron-fired job bound to one
        # could never complete unattended — it would hang until its deadline.
        bad_mode = await cl.post(
            "/api/v1/batch-jobs",
            json={"workspace_id": WORKSPACE, "name": "y",
                  "pipeline_template_id": template_id,
                  "connection_bindings": [
                      {"connection_id": "c1",
                       "ingestion_params": {"ingestion_mode": "file_upload"}}]},
            headers=auth())
        assert bad_mode.status_code == 422
        assert "unattended" in bad_mode.text


async def test_a_job_bound_to_an_unknown_template_404s(tmp_path, clock):
    c = _container(tmp_path, clock)
    async with await _client(c) as cl:
        resp = await cl.post("/api/v1/batch-jobs",
                             json={"workspace_id": WORKSPACE, "name": "z",
                                   "pipeline_template_id":
                                       "00000000-0000-4000-8000-000000000000",
                                   "connection_bindings": _bindings(1)},
                             headers=auth())
    assert resp.status_code == 404


async def test_duplicate_job_names_in_a_workspace_conflict(tmp_path, clock):
    c = _container(tmp_path, clock)
    async with await _client(c) as cl:
        template_id = await _template(cl)
        await _job(cl, template_id, name="nightly")
        dup = await cl.post("/api/v1/batch-jobs",
                            json={"workspace_id": WORKSPACE, "name": "nightly",
                                  "pipeline_template_id": template_id,
                                  "connection_bindings": _bindings(1)},
                            headers=auth())
    assert dup.status_code == 409


async def test_an_ingestion_event_for_another_service_is_ignored(tmp_path, clock):
    """The consumer sees every ingestion in the tenant, most of which belong to no
    batch job. Those must be a clean no-op, not an error or a spurious drive."""
    c = _container(tmp_path, clock)
    async with await _client(c) as cl:
        await _job(cl, await _template(cl))
    await c.consumer.handle(_ingestion_event(TENANT_A, "ing-not-ours"))
    await c.batch_job_service.wait_for_drives()
    assert c.memory_state.batch_runs == {}


async def test_terminate_stops_a_run_and_is_idempotent(tmp_path, clock):
    c = _container(tmp_path, clock)
    async with await _client(c) as cl:
        job = await _job(cl, await _template(cl))
        run = await _run_now(cl, job["id"])
        first = await cl.put(f"/api/v1/batch-job-runs/{run['id']}/terminate",
                             headers=auth())
        second = await cl.put(f"/api/v1/batch-job-runs/{run['id']}/terminate",
                              headers=auth())
    assert first.json()["data"]["status"] == "cancelled"
    assert second.json()["data"]["status"] == "cancelled"


def test_the_run_payload_exposes_the_phase_timeline_shape():
    """AC-9's UI half: the timeline is served from the run, not reconstructed."""
    from datetime import UTC, datetime

    from app.domain.entities import BatchJobRun, BatchJobRunIngestion

    now = datetime.now(UTC)
    run = BatchJobRun(
        id="r", tenant_id="t", batch_job_id="j", pipeline_template_id="p",
        pipeline_version_id="v", batch_key="r", phase=int(BatchPhase.pipeline),
        status=int(BatchRunStatus.running), trigger="schedule",
        input_dataset_urns=["wr:t:dataset:version/d@v1"], output_dataset_urns=[],
        pipeline_run_id="pr", error=None, phase_deadline_at=now,
        retried_from_run_id=None, submitted_by=None, via_agent=None,
        created_at=now, updated_at=now)
    rec = BatchJobRunIngestion(
        id="i", tenant_id="t", batch_job_run_id="r", binding_key="b0",
        ingestion_id="ing-1", status="completed", dataset_urn="wr:t:dataset:dataset/d",
        iceberg_snapshot_id="1", dataset_version_urn="wr:t:dataset:version/d@v1",
        error=None, created_at=now, updated_at=now)

    payload = batch_run_payload(run, [rec])
    assert payload["phase"] == "pipeline" and payload["status"] == "running"
    assert payload["ingestions"][0]["dataset_version_urn"] == "wr:t:dataset:version/d@v1"
