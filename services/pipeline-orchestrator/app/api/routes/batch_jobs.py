"""BRD 73 — batch job CRUD + control, and batch job run reads/retry.

Auth + envelope mirror the pipeline-schedule routes exactly: every endpoint is
guarded with ``require(...)`` against an action in the registered manifest, and
returns the ``{"data": ...}`` envelope. run-now and retry drive the created run
through the same fire-and-forget path ``/pipelines/{id}/run`` uses, so the 202
returns before the (potentially long) trigger phase starts.

Retry lives under ``/batch-job-runs/{run_id}/retry`` rather than BRD 73's
``/batch-jobs/{id}/retry``: retry resumes a specific FAILED RUN from the phase it
failed in, so the run is the resource being acted on — a job can have many failed
runs and "retry the job" would not say which.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Query, Request, Response

from app.api.auth import Principal, require
from app.api.schemas import (
    BatchJobCreate,
    BatchJobUpdate,
    batch_job_payload,
    batch_run_payload,
    page_envelope,
)

router = APIRouter(prefix="/api/v1")


def _c(request: Request):
    return request.app.state.container


@router.post("/batch-jobs", status_code=201)
async def create_batch_job(request: Request, body: BatchJobCreate,
                           principal: Principal = Depends(
                               require("pipeline.batch_job.create"))):
    c = _c(request)
    job = await c.batch_job_service.create(
        principal.ctx(request.state.trace_id),
        body.model_dump(mode="python", exclude_none=False))
    return {"data": batch_job_payload(job)}


@router.get("/batch-jobs")
async def list_batch_jobs(request: Request,
                          principal: Principal = Depends(
                              require("pipeline.batch_job.read")),
                          limit: int = Query(default=50, ge=1, le=200),
                          cursor: str | None = None):
    c = _c(request)
    page = await c.batch_job_service.list(principal.ctx(request.state.trace_id),
                                          limit, cursor)
    return page_envelope([batch_job_payload(j) for j in page.items],
                         page.next_cursor, page.has_more)


@router.get("/batch-jobs/{job_id}")
async def get_batch_job(request: Request, job_id: str,
                        principal: Principal = Depends(
                            require("pipeline.batch_job.read"))):
    c = _c(request)
    job = await c.batch_job_service.get(principal.ctx(request.state.trace_id), job_id)
    return {"data": batch_job_payload(job)}


@router.patch("/batch-jobs/{job_id}")
async def update_batch_job(request: Request, job_id: str, body: BatchJobUpdate,
                           principal: Principal = Depends(
                               require("pipeline.batch_job.update"))):
    c = _c(request)
    job = await c.batch_job_service.update(
        principal.ctx(request.state.trace_id), job_id,
        body.model_dump(mode="python", exclude_unset=True))
    return {"data": batch_job_payload(job)}


@router.delete("/batch-jobs/{job_id}", status_code=204)
async def delete_batch_job(request: Request, job_id: str,
                           principal: Principal = Depends(
                               require("pipeline.batch_job.delete"))):
    c = _c(request)
    await c.batch_job_service.delete(principal.ctx(request.state.trace_id), job_id)
    return Response(status_code=204)


@router.post("/batch-jobs/{job_id}/pause")
async def pause_batch_job(request: Request, job_id: str,
                          principal: Principal = Depends(
                              require("pipeline.batch_job.update"))):
    c = _c(request)
    job = await c.batch_job_service.pause(principal.ctx(request.state.trace_id), job_id)
    return {"data": batch_job_payload(job)}


@router.post("/batch-jobs/{job_id}/resume")
async def resume_batch_job(request: Request, job_id: str,
                           principal: Principal = Depends(
                               require("pipeline.batch_job.update"))):
    c = _c(request)
    job = await c.batch_job_service.resume(principal.ctx(request.state.trace_id),
                                           job_id)
    return {"data": batch_job_payload(job)}


@router.post("/batch-jobs/{job_id}/run-now", status_code=202)
async def run_batch_job_now(request: Request, job_id: str,
                            principal: Principal = Depends(
                                require("pipeline.batch_job.execute"))):
    c = _c(request)
    run = await c.batch_job_service.run_now(principal.ctx(request.state.trace_id),
                                            job_id)
    c.drive_batch_run(run.tenant_id, run.id)
    return {"data": batch_run_payload(run)}


@router.get("/batch-jobs/{job_id}/runs")
async def list_batch_job_runs(request: Request, job_id: str,
                              principal: Principal = Depends(
                                  require("pipeline.batch_job.read")),
                              limit: int = Query(default=50, ge=1, le=200),
                              cursor: str | None = None):
    c = _c(request)
    page = await c.batch_job_service.list_runs(
        principal.ctx(request.state.trace_id), job_id, limit, cursor)
    return page_envelope([batch_run_payload(r) for r in page.items],
                         page.next_cursor, page.has_more)


@router.get("/batch-job-runs/{run_id}")
async def get_batch_job_run(request: Request, run_id: str,
                            principal: Principal = Depends(
                                require("pipeline.batch_job.read"))):
    c = _c(request)
    run, ingestions = await c.batch_job_service.get_run(
        principal.ctx(request.state.trace_id), run_id)
    return {"data": batch_run_payload(run, ingestions)}


@router.post("/batch-job-runs/{run_id}/retry", status_code=202)
async def retry_batch_job_run(request: Request, run_id: str,
                              principal: Principal = Depends(
                                  require("pipeline.batch_job.execute"))):
    c = _c(request)
    run = await c.batch_job_service.retry(principal.ctx(request.state.trace_id),
                                          run_id)
    c.drive_batch_run(run.tenant_id, run.id)
    return {"data": batch_run_payload(run)}


@router.put("/batch-job-runs/{run_id}/terminate")
async def terminate_batch_job_run(request: Request, run_id: str,
                                  principal: Principal = Depends(
                                      require("pipeline.batch_job.execute"))):
    c = _c(request)
    run = await c.batch_job_service.terminate(principal.ctx(request.state.trace_id),
                                              run_id)
    return {"data": batch_run_payload(run)}
