"""On-demand compute: run leases, orphan recovery, and the Argo watch loop.

These are what make the orchestrator safe to autoscale. Before them a run was
driven by an asyncio.Task inside whichever pod took the request, with nothing on
the row saying so — losing that pod stranded the run in `running` forever, still
consuming the tenant's concurrency — and the Argo backend submitted workflows it
then never watched, so it could not complete a single run.
"""

from __future__ import annotations

from datetime import timedelta

import httpx
import pytest

from app.container import build_container
from app.domain.enums import RunStatus
from app.main import create_app
from tests.conftest import (
    TENANT_A,
    WORKSPACE,
    FakeExecutor,
    FakeMlflow,
    auth,
    make_settings,
)

pytestmark = pytest.mark.asyncio


async def _training_template(cl):
    body = {"workspace_id": WORKSPACE, "mode": "train",
            "dataset_refs": {"TRAIN": "wr:t:dataset:dataset/x"},
            "parameters": {"label_column": "label"}, "name": "t"}
    r = await cl.post("/api/v1/algorithm-templates/xgboost/pipelines", json=body,
                      headers=auth())
    return r.json()["data"]["id"]


class FakeArgo:
    """Speaks the ArgoWorkflowExecutor shape without a Kubernetes cluster: submit
    returns a workflow name, watch yields the phase sequence it was given."""

    def __init__(self, events, *, name="wf-abc"):
        self.events = events
        self.name = name
        self.submits: list[tuple] = []
        self.watched: list[str] = []
        self.terminated: list[str] = []

    async def submit(self, tenant_id, manifest, parameters):
        self.submits.append((tenant_id, manifest, parameters))
        return self.name

    async def watch(self, tenant_id, workflow_name):
        self.watched.append(workflow_name)
        for event in self.events:
            yield event

    async def terminate(self, tenant_id, workflow_name):
        self.terminated.append(workflow_name)


class ArgoMlflow(FakeMlflow):
    """The Argo path reads the outcome back from MLflow, because the TRAINING POD
    is what logged the metrics and registered the model."""

    def __init__(self, result=None):
        super().__init__()
        self.result = result
        self.asked: list[str] = []

    async def result_for_run(self, mlflow_run_id):
        self.asked.append(mlflow_run_id)
        return self.result


def _result(name="wr_model"):
    from app.domain.ports import TrainingResult

    return TrainingResult(
        mlflow_run_id="mlflow-0", model_uri=f"models:/{name}/3",
        registered_model_name=name, model_version="3",
        metrics={"accuracy": 0.91}, params={}, row_count=1000)


async def _run_on(c, cl, **params):
    tid = await _training_template(cl)
    r = await cl.post(f"/api/v1/pipelines/{tid}/run",
                      json={"run_parameters": {"training_data": [{"a": 1, "label": "x"}],
                                               **params}},
                      headers=auth())
    assert r.status_code == 202, r.text
    return r.json()["data"]["id"]


def _container(tmp_path, clock, **overrides):
    mlflow = overrides.pop("mlflow", None) or FakeMlflow()
    executor = overrides.pop("executor", None) or FakeExecutor()
    settings = make_settings(tmp_path, **overrides)
    c = build_container(settings, mode="memory", clock=clock,
                        executor=executor, mlflow=mlflow)
    c.schedule_drive = lambda *a, **k: None  # drive explicitly, no background race
    return c


async def _client(c):
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=create_app(c)),
                             base_url="http://test")


async def _get_run(c, run_id):
    async with c.run_service.d.uow_factory(TENANT_A) as uow:
        return await uow.runs.get(run_id)


# ---- the lease: exactly one driver per run ---------------------------------

async def test_a_second_driver_is_declined_while_the_lease_is_held(tmp_path, clock):
    """Two orchestrator pods racing the same run would train it twice and register
    two models for one four-eyes approval."""
    c = _container(tmp_path, clock)
    async with await _client(c) as cl:
        run_id = await _run_on(c, cl)

    now = clock.now()
    async with c.run_service.d.uow_factory(TENANT_A) as uow:
        got = await uow.runs.claim_lease(run_id, "pod-a", now, now + timedelta(seconds=300))
    assert got

    # A second instance now tries to drive it — and must decline.
    c.run_service.d.settings.instance_id = "pod-b"
    final = await c.run_service.drive_run(TENANT_A, run_id)

    assert final.status == int(RunStatus.submitted)  # untouched, not driven
    assert c.deps.executor.specs == []               # no training happened


async def test_a_run_updates_its_status_without_erasing_its_own_lease(tmp_path, clock):
    """The subtle one: drive_run reads the run, claims the lease, then writes the
    run back to set `running`. If that whole-row write carried the pre-claim
    lease columns it would erase the lease the driver is holding — the heartbeat
    would find nothing to renew and the reaper would reclaim a live run."""
    c = _container(tmp_path, clock)
    async with await _client(c) as cl:
        run_id = await _run_on(c, cl)

    now = clock.now()
    async with c.run_service.d.uow_factory(TENANT_A) as uow:
        stale = await uow.runs.get(run_id)          # read BEFORE the claim
        assert stale.lease_owner is None
        await uow.runs.claim_lease(run_id, "pod-a", now, now + timedelta(seconds=300))
        stale.status = int(RunStatus.running)
        await uow.runs.update(stale)                # write back the stale copy

    run = await _get_run(c, run_id)
    assert run.status == int(RunStatus.running)
    assert run.lease_owner == "pod-a", "the whole-row update erased the live lease"


async def test_lease_is_released_when_the_run_finishes(tmp_path, clock):
    c = _container(tmp_path, clock)
    async with await _client(c) as cl:
        run_id = await _run_on(c, cl)
    await c.run_service.drive_run(TENANT_A, run_id)

    run = await _get_run(c, run_id)
    assert run.status == int(RunStatus.succeeded)
    assert run.lease_owner is None and run.lease_expires_at is None


async def test_an_expired_lease_can_be_taken_over(tmp_path, clock):
    c = _container(tmp_path, clock)
    async with await _client(c) as cl:
        run_id = await _run_on(c, cl)

    now = clock.now()
    async with c.run_service.d.uow_factory(TENANT_A) as uow:
        await uow.runs.claim_lease(run_id, "dead-pod", now, now + timedelta(seconds=300))
    clock.advance(seconds=400)
    async with c.run_service.d.uow_factory(TENANT_A) as uow:
        took = await uow.runs.claim_lease(run_id, "live-pod", clock.now(),
                                          clock.now() + timedelta(seconds=300))
    assert took
    assert (await _get_run(c, run_id)).lease_owner == "live-pod"


async def test_heartbeat_only_renews_for_the_holder(tmp_path, clock):
    c = _container(tmp_path, clock)
    async with await _client(c) as cl:
        run_id = await _run_on(c, cl)
    now = clock.now()
    async with c.run_service.d.uow_factory(TENANT_A) as uow:
        await uow.runs.claim_lease(run_id, "pod-a", now, now + timedelta(seconds=300))
        assert await uow.runs.renew_lease(run_id, "pod-a", now + timedelta(seconds=600))
        assert not await uow.runs.renew_lease(run_id, "pod-b", now + timedelta(seconds=900))


# ---- orphan recovery -------------------------------------------------------

async def test_a_local_run_whose_pod_died_is_failed_not_left_running(tmp_path, clock):
    """The defect: with the driving pod gone the run's in-process work is gone
    too, but the row said `running` forever — misreporting a dead run as live and
    permanently holding one of the tenant's concurrency slots."""
    c = _container(tmp_path, clock)
    async with await _client(c) as cl:
        run_id = await _run_on(c, cl)

    now = clock.now()
    async with c.run_service.d.uow_factory(TENANT_A) as uow:
        run = await uow.runs.get(run_id)
        run.status = int(RunStatus.running)
        await uow.runs.update(run)
        await uow.runs.claim_lease(run_id, "dead-pod", now, now + timedelta(seconds=300))
    clock.advance(seconds=400)  # the pod stopped heartbeating

    recovered = await c.run_service.recover_orphans()

    assert recovered == [run_id]
    run = await _get_run(c, run_id)
    assert run.status == int(RunStatus.failed)
    assert run.error["code"] == "RUN_ORPHANED"
    assert "dead-pod" in run.error["message"] and "Retry" in run.error["message"]
    types = {x["payload"]["event_type"] for x in c.memory_state.outbox}
    assert "pipeline.run.failed" in types  # terminal, and observable


async def test_a_live_run_is_never_reclaimed(tmp_path, clock):
    """The reaper must not take a run away from a driver that is merely slow."""
    c = _container(tmp_path, clock)
    async with await _client(c) as cl:
        run_id = await _run_on(c, cl)
    now = clock.now()
    async with c.run_service.d.uow_factory(TENANT_A) as uow:
        run = await uow.runs.get(run_id)
        run.status = int(RunStatus.running)
        await uow.runs.update(run)
        await uow.runs.claim_lease(run_id, "busy-pod", now, now + timedelta(seconds=300))
    clock.advance(seconds=100)  # well inside the lease

    assert await c.run_service.recover_orphans() == []
    assert (await _get_run(c, run_id)).status == int(RunStatus.running)


async def test_a_run_stranded_before_any_lease_is_recovered(tmp_path, clock):
    """The case a lease alone misses: the pod died between returning 202 and
    claiming, so the run sits `submitted` with no lease and nobody driving it."""
    c = _container(tmp_path, clock)
    async with await _client(c) as cl:
        run_id = await _run_on(c, cl)
    assert (await _get_run(c, run_id)).lease_expires_at is None
    clock.advance(seconds=400)

    assert await c.run_service.recover_orphans() == [run_id]
    assert (await _get_run(c, run_id)).status == int(RunStatus.failed)


async def test_a_freshly_submitted_run_is_not_swept(tmp_path, clock):
    c = _container(tmp_path, clock)
    async with await _client(c) as cl:
        run_id = await _run_on(c, cl)

    assert await c.run_service.recover_orphans() == []
    assert (await _get_run(c, run_id)).status == int(RunStatus.submitted)


async def test_recovery_frees_the_tenants_concurrency_slot(tmp_path, clock):
    """Why failing beats leaving it `running`: an orphan used to count against
    max_concurrent_runs forever, so enough lost pods deadlocked the tenant."""
    c = _container(tmp_path, clock)
    async with await _client(c) as cl:
        run_id = await _run_on(c, cl)
    now = clock.now()
    async with c.run_service.d.uow_factory(TENANT_A) as uow:
        run = await uow.runs.get(run_id)
        run.status = int(RunStatus.running)
        await uow.runs.update(run)
        await uow.runs.claim_lease(run_id, "dead-pod", now, now + timedelta(seconds=300))
        before = await uow.runs.count_active(TENANT_A)
    clock.advance(seconds=400)

    await c.run_service.recover_orphans()

    async with c.run_service.d.uow_factory(TENANT_A) as uow:
        after = await uow.runs.count_active(TENANT_A)
    assert before == 1 and after == 0


# ---- the Argo watch loop ---------------------------------------------------

async def test_argo_run_is_watched_to_success_not_left_running(tmp_path, clock):
    """The defect: _drive_argo returned right after submit, so a run on the Argo
    backend went to `running` and stayed there forever — _finish_success was
    unreachable and the elastic backend could not complete a single run."""
    argo = FakeArgo([{"phase": "Running", "status": "running", "nodes": {}},
                     {"phase": "Succeeded", "status": "succeeded", "nodes": {}}])
    mlflow = ArgoMlflow(result=_result())
    c = _container(tmp_path, clock, executor_backend="argo", mlflow=mlflow)
    c.deps.workflow_backend = argo
    async with await _client(c) as cl:
        run_id = await _run_on(c, cl)

    final = await c.run_service.drive_run(TENANT_A, run_id)

    assert final.status == int(RunStatus.succeeded)
    assert argo.watched == ["wf-abc"], "submitted but never watched"
    assert final.model_uri == "models:/wr_model/3"
    assert final.metrics == {"accuracy": 0.91}
    assert mlflow.asked == [final.mlflow_run_id]  # read back, not invented


async def test_argo_failure_phase_fails_the_run(tmp_path, clock):
    argo = FakeArgo([{"phase": "Failed", "status": "failed", "nodes": {}}])
    c = _container(tmp_path, clock, executor_backend="argo", mlflow=ArgoMlflow())
    c.deps.workflow_backend = argo
    async with await _client(c) as cl:
        run_id = await _run_on(c, cl)

    final = await c.run_service.drive_run(TENANT_A, run_id)
    assert final.status == int(RunStatus.failed)
    assert "wf-abc" in final.error["message"]


async def test_a_watch_stream_that_ends_early_does_not_claim_success(tmp_path, clock):
    """The workflow's fate is genuinely unknown, so guessing `succeeded` would be
    a fabricated outcome — and would register a model nobody trained."""
    argo = FakeArgo([{"phase": "Running", "status": "running", "nodes": {}}])
    c = _container(tmp_path, clock, executor_backend="argo", mlflow=ArgoMlflow())
    c.deps.workflow_backend = argo
    async with await _client(c) as cl:
        run_id = await _run_on(c, cl)

    final = await c.run_service.drive_run(TENANT_A, run_id)
    assert final.status == int(RunStatus.failed)
    assert "terminal phase" in final.error["message"]


async def test_argo_success_without_a_registered_model_is_a_failure(tmp_path, clock):
    """Exit code zero is not evidence a model exists. Recording success here would
    leave a run claiming a model_uri it does not have."""
    argo = FakeArgo([{"phase": "Succeeded", "status": "succeeded", "nodes": {}}])
    c = _container(tmp_path, clock, executor_backend="argo",
                   mlflow=ArgoMlflow(result=None))
    c.deps.workflow_backend = argo
    async with await _client(c) as cl:
        run_id = await _run_on(c, cl)

    final = await c.run_service.drive_run(TENANT_A, run_id)
    assert final.status == int(RunStatus.failed)
    assert "did not report a result" in final.error["message"]


async def test_workflow_name_is_persisted_before_the_watch_begins(tmp_path, clock):
    """Recovery re-attaches by name. Persisting it only after the watch returned
    would mean a pod lost mid-watch could never find the workflow again."""
    seen = {}
    argo = FakeArgo([{"phase": "Succeeded", "status": "succeeded", "nodes": {}}])
    c = _container(tmp_path, clock, executor_backend="argo",
                   mlflow=ArgoMlflow(result=_result()))

    original_watch = argo.watch

    async def watch(tenant_id, workflow_name):
        seen["at_watch_time"] = (await _get_run(c, run_id)).argo_workflow_name
        async for ev in original_watch(tenant_id, workflow_name):
            yield ev

    argo.watch = watch
    c.deps.workflow_backend = argo
    async with await _client(c) as cl:
        run_id = await _run_on(c, cl)

    await c.run_service.drive_run(TENANT_A, run_id)
    assert seen["at_watch_time"] == "wf-abc"


async def test_argo_node_status_becomes_component_status(tmp_path, clock):
    """Per-pod progress, so the run view shows real components rather than one
    opaque row."""
    nodes = {"n1": {"displayName": "train-1", "phase": "Running",
                    "startedAt": "2026-01-01T00:00:00Z"}}
    argo = FakeArgo([{"phase": "Running", "status": "running", "nodes": nodes},
                     {"phase": "Succeeded", "status": "succeeded", "nodes": nodes}])
    c = _container(tmp_path, clock, executor_backend="argo",
                   mlflow=ArgoMlflow(result=_result()))
    c.deps.workflow_backend = argo
    async with await _client(c) as cl:
        run_id = await _run_on(c, cl)

    await c.run_service.drive_run(TENANT_A, run_id)
    run = await _get_run(c, run_id)
    assert run.components_status["train-1"]["phase"] in ("Running", "Succeeded")
    assert run.components_status["train-1"]["started_at"] == "2026-01-01T00:00:00Z"


async def test_an_orphaned_argo_run_reattaches_instead_of_failing(tmp_path, clock):
    """The whole point of separating the two recovery paths: the workflow is still
    running in Kubernetes, completely unaffected by the orchestrator pod that
    submitted it going away. Failing it would throw away real, paid-for work."""
    argo = FakeArgo([{"phase": "Succeeded", "status": "succeeded", "nodes": {}}])
    c = _container(tmp_path, clock, executor_backend="argo",
                   mlflow=ArgoMlflow(result=_result()))
    c.deps.workflow_backend = argo
    async with await _client(c) as cl:
        run_id = await _run_on(c, cl)

    now = clock.now()
    async with c.run_service.d.uow_factory(TENANT_A) as uow:
        run = await uow.runs.get(run_id)
        run.status = int(RunStatus.running)
        run.argo_workflow_name = "wf-abc"  # submitted before the pod died
        await uow.runs.update(run)
        await uow.runs.claim_lease(run_id, "dead-pod", now, now + timedelta(seconds=300))
    clock.advance(seconds=400)

    assert await c.run_service.recover_orphans() == [run_id]
    # The re-attachment runs in the background — the sweep must not block on a
    # workflow that could take hours — so wait for it before asserting.
    await c.run_service.wait_for_recoveries()

    run = await _get_run(c, run_id)
    assert run.status == int(RunStatus.succeeded), "a live workflow was thrown away"
    assert argo.submits == [], "re-submitted — that would train the run twice"
    assert argo.watched == ["wf-abc"]


async def test_the_sweep_does_not_block_on_a_reattached_workflow(tmp_path, clock):
    """A re-attached run watches its workflow until the workflow ends, which can be
    hours. Awaiting that inside the sweep would stall every other stranded run
    behind it — the reaper would recover one run per workflow lifetime."""
    import asyncio

    gate = asyncio.Event()

    class SlowArgo(FakeArgo):
        async def watch(self, tenant_id, workflow_name):
            self.watched.append(workflow_name)
            await gate.wait()          # the workflow is still running
            yield {"phase": "Succeeded", "status": "succeeded", "nodes": {}}

    argo = SlowArgo([])
    c = _container(tmp_path, clock, executor_backend="argo",
                   mlflow=ArgoMlflow(result=_result()))
    c.deps.workflow_backend = argo
    async with await _client(c) as cl:
        run_id = await _run_on(c, cl)
    now = clock.now()
    async with c.run_service.d.uow_factory(TENANT_A) as uow:
        run = await uow.runs.get(run_id)
        run.status = int(RunStatus.running)
        run.argo_workflow_name = "wf-abc"
        await uow.runs.update(run)
        await uow.runs.claim_lease(run_id, "dead-pod", now, now + timedelta(seconds=300))
    clock.advance(seconds=400)

    # Returns while the workflow is still going — that is the whole point.
    assert await asyncio.wait_for(c.run_service.recover_orphans(), timeout=2) == [run_id]
    assert (await _get_run(c, run_id)).status == int(RunStatus.running)

    gate.set()
    await c.run_service.wait_for_recoveries()
    assert (await _get_run(c, run_id)).status == int(RunStatus.succeeded)
