# BRD 73 — Batch job orchestration (chained ingest → pipeline)

**Status:** OPEN — 2026-08-04 · part of the [V1 parity wave-2 index](71_v1_parity_wave2_index.md)
**Owner:** platform · **Services:** `pipeline-orchestrator` (owner) · `ingestion-service` · `bff-graphql` · `ui-web` · `agent-runtime`
**Gaps closed:** B1 (chained ingest→run batch job), B2 (`batch-trigger` component)

---

## Analysis

V1 has a first-class **Job** aggregate (`pipeline_manager/models/jobs.py`) that Datacern
has no equivalent for. A `Job` binds:

- a **pipeline** (`pipeline_id` + `pipeline_version_no`, FK to the exact version),
- a set of **source connections** (`connections` JSON — the batch datasources to pull),
- a **schedule** (`schedule` cron, `start_date`/`end_date`, `next_schedule_date`),

and each `JobRun` advances through an explicit three-phase state machine:

```python
class JOB_PHASE(Enum):
    trigger   = 0   # fire ingestions on the bound connections
    ingestion = 1   # wait for those ingestions to land as a new batch
    pipeline  = 2   # run the pipeline over exactly that batch
```

recording `input_datasets` and `output_datasets` per run. The `batch_trigger` IO
component is the in-pipeline half of the same idea ("trigger dataset ingestions").
Ingestions carry `batch_version` / `batch_date`, so phase 2 can wait for *that* batch
rather than "some newer data".

**Datacern has both halves and no seam between them.** `ingestion-service` has schedules
(`POST /schedules`, cron, `run_now`, pause/resume) that refresh a dataset;
`pipeline-orchestrator` has schedules (`POST /pipeline-schedules`, cron, `run-now`,
pause/resume) that run a pipeline. `app/domain/scheduler.py` is **cron-only** —
`compute_next_fire` and nothing else — and while `app/events/consumer.py` does consume
`dataset.events.v1`, it uses it for tenant provisioning (`_provision`), not for
triggering runs.

So the only way to express "pull last night's claims, then score them" today is two
independent crons with a hopeful gap between them. Failure modes, all silent:

- the pipeline fires while the ingestion is still streaming → it scores the previous batch;
- the ingestion fails → the pipeline runs anyway on stale data, and reports success;
- nothing records that run *N* consumed batch *N* — there is no per-run input/output
  dataset record tying them together, so the lineage question "which data produced this
  score" has no answer at the job level.

This is the last piece of V1's orchestration story with no Datacern equivalent, and it is
the one that matters for the recurring-batch customers (claims, AML, RCM) the packs
target.

---

## Design

Own it in `pipeline-orchestrator` (it already owns run leases, orphan recovery, and the
Argo/local executor split), with `ingestion-service` as a driven dependency.

### 1. Aggregate

`BatchJob` — `{id, name, pipeline_template_id, pipeline_version_id, connection_bindings,
cron, timezone, start_at, end_at, paused, next_fire_at, lease_*}`.
`BatchJobRun` — `{id, batch_job_id, phase, status, batch_key, ingestion_ids[],
input_dataset_urns[], output_dataset_urns[], error, started_at, finished_at}`.

`connection_bindings`: `[{connection_id, dataset_id, ingestion_params}]` — the V1
`connections` JSON, typed.

### 2. Phase machine

`trigger → ingestion → pipeline → (succeeded | failed)`, driven by the **same lease +
orphan-reaper machinery** `PipelineRun` already uses (`claim_lease`, heartbeat at ⅓ TTL,
`recover_orphans`) so two orchestrator pods cannot double-drive a job — which matters
more here than for a plain run, because double-driving would double-ingest.

- **trigger** — `POST /internal/ingestions` per binding via ingestion-service, stamping a
  shared `batch_key` (the run's id) on each. Idempotent by `Idempotency-Key = batch_key +
  binding` so a reaper re-drive cannot double-ingest.
- **ingestion** — advance when every triggered ingestion reaches a terminal state. Driven
  by the **`ingestion.events.v1` consumer**, not polling (the codebase's stated
  preference — cf. the Argo informer). A per-phase deadline fails the run rather than
  hanging.
- **pipeline** — submit the bound pipeline **version** with the batch's dataset versions
  as run parameters, so the run is pinned to exactly the data phase 2 landed. Reuses
  `PipelineRunService` wholesale; a `BatchJobRun` holds the resulting `run_id`.

Any phase failing fails the job run with the phase recorded. `retry` resumes **from the
failed phase** (re-running a succeeded ingestion phase would double-ingest).

### 3. `batch-trigger` component

Catalog entry (IO, 0 in / 0 out, params `{connection_id, dataset}`) plus a local-executor
operator that calls the same internal trigger path, for pipelines that want to pull
mid-DAG. Same idempotency key discipline.

### 4. Surfaces

REST: `POST/GET/PATCH/DELETE /api/v1/batch-jobs`, `/{id}/pause|resume|run-now`,
`GET /{id}/runs`, `GET /batch-job-runs/{id}`, `POST /{id}/retry`.
Events: `batch_job.run.{started,phase_changed,succeeded,failed}` on the existing outbox.
BFF + a Batch Jobs page under Data › Pipelines showing the phase timeline per run.

### 5. Agent

Extend `data_pipeline_builder` to propose a batch job — connections + cadence + pipeline
— as one governed WriteIntent, so "every night pull the claims feed and score it" is a
single proposal under four-eyes.

### Increment plan

- **inc1** — aggregate + migrations + phase machine + lease/reaper reuse; unit tests with
  a fake ingestion client.
- **inc2** — real ingestion-service trigger + `ingestion.events.v1` consumer advance;
  integration test.
- **inc3** — `batch-trigger` component; REST + events + BFF + UI.
- **inc4** — agent proposal + live-verify.

## Acceptance criteria

| AC | Statement |
|----|-----------|
| AC-1 | A batch job runs `trigger → ingestion → pipeline` in order; the pipeline never starts before every triggered ingestion is terminal. |
| AC-2 | A failed ingestion fails the job run in phase `ingestion`; the pipeline phase never runs. |
| AC-3 | The pipeline run is pinned to the dataset versions the ingestion phase produced (recorded in `input_dataset_urns`). |
| AC-4 | Re-driving after a lost lease does not double-ingest (idempotency by `batch_key`). |
| AC-5 | Two orchestrator instances racing one job: exactly one drives it. |
| AC-6 | `retry` resumes from the failed phase, not from `trigger`. |
| AC-7 | A per-phase deadline fails the run with a phase-scoped error rather than hanging. |
| AC-8 | `batch-trigger` executes in the local executor and is idempotent under re-run. |
| AC-9 | Phase transitions emit outbox events; the UI timeline reflects them. |
| AC-10 | `data_pipeline_builder` proposes a batch job in proposal-mode; cross-tenant reads 404. |

## Implement & Test log

_(pending)_
