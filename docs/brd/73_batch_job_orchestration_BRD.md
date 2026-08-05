# BRD 73 — Batch job orchestration (chained ingest → pipeline)

**Status:** inc1–inc3 DONE (backend + BFF + UI) — 2026-08-05 · AC-9 CLOSED · agent (AC-10 / inc4) deferred · part of the [V1 parity wave-2 index](71_v1_parity_wave2_index.md)
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
| AC-9 | Phase transitions emit outbox events; the UI timeline reflects them. **DONE** (event half inc3, UI half inc3b). |
| AC-10 | `data_pipeline_builder` proposes a batch job in proposal-mode; cross-tenant reads 404. |

## Implement & Test log

### Design corrections — two of this BRD's premises were WRONG against the code

Checked before building, and the code won:

1. **`POST /internal/ingestions` does not exist** (Design §2, trigger). ingestion-service
   has exactly two ingestion-create surfaces: `POST /api/v1/ingestions`, which requires a
   **user bearer token** (`PrincipalDep` → `verify_token_async`) that a cron-fired batch
   job does not have and must not mint; and `POST /internal/v1/mcp/invoke` with
   `tool_id="ingestion.create"`, gated by `require_internal` (SPIFFE peer identity) and
   delegating to the *same* `IngestionService.create` the REST route uses. The trigger
   phase therefore speaks the MCP facade. Two small, real changes were needed in
   ingestion-service to make that honest rather than fictional:
   `spiffe://datacern/ns/ml/sa/pipeline-orchestrator` added to `internal_allowed_spiffe`,
   and an optional `idempotency_key` on `McpInvokeRequest` routed through the *existing*
   `run_idempotent` — the internal path had no equivalent of the REST route's
   `Idempotency-Key` header, so **AC-4 was not achievable at all** without it.
2. **`ingestion.events.v1` alone cannot pin a dataset VERSION** (Design §2, pipeline).
   `ingestion.completed` carries `{ingestion_id, dataset_urn, dataset_id,
   iceberg_snapshot_id, rows_appended, …}` — no version URN, because the version does not
   exist yet: dataset-service *consumes* that event and mints the version afterwards. The
   exact version URN is published on `dataset.events.v1:: dataset.version_created`, whose
   `produced_by_urn` is `wr:{tenant}:ingestion:ingestion/{id}`. So the ingestion phase
   consumes **both** topics, and a completed binding is only "landed" once its version is
   known. That is what makes AC-3 a real pin instead of a timestamp guess.

Two more, found in inc3b while building the BFF **against the code rather than against
this document's Design §1/§4**:

3. **`BatchJobRun` has no `ingestion_ids[]`** (Design §1). The shipped aggregate keeps a
   separate `BatchJobRunIngestion` row per binding — id, status, dataset urn, snapshot
   id, dataset **version** urn, error — which is what makes the per-binding UI timeline
   possible at all; an array of ids could not carry a per-binding outcome. Design §1's
   `BatchJob` also lists `lease_*`, but the lease columns are on the **RUN**, not the
   job: a job is never "held", a run being driven is.
4. **§4 undercounts the run surface.** `PUT /batch-job-runs/{id}/terminate` exists and is
   in the action manifest but is absent from §4's route list, so the BFF exposes
   `terminateBatchJobRun` on evidence from `app/api/routes/batch_jobs.py`, not from here.

A third original premise held but is narrower than it reads: `PipelineRun`'s lease machinery
(`claim_lease` / heartbeat at ⅓ TTL / `recover_orphans`) is reused **exactly**, but a
batch run holds its lease only while a phase is actively being DRIVEN. The ingestion
phase is a *wait*, not work, so a run parked in it holds nothing and the orphan scan
deliberately skips it (`phase != ingestion`) — reaping a healthy waiting run would
eventually re-enter its trigger step. The phase deadline, not the reaper, is what bounds
that phase.

### inc1 — aggregate + migration + phase machine + lease/reaper reuse — DONE

- **`app/domain/entities.py`** — `BatchJob` (pipeline template + pinned version,
  `connection_bindings`, cron/timezone/start/end/paused, `phase_timeout_seconds`,
  next/last fire), `BatchJobRun` (`batch_key`, `phase`, `status`, `pipeline_run_id`,
  `input/output_dataset_urns`, `phase_deadline_at`, `retried_from_run_id`, lease
  columns), `BatchJobRunIngestion` (one row per binding: ingestion id, status,
  dataset urn, iceberg snapshot, dataset **version** urn).
- **`app/domain/enums.py`** — `BatchPhase{trigger,ingestion,pipeline}` (V1's `JOB_PHASE`),
  `BatchRunStatus`, `INGESTION_TERMINAL`.
- **`migrations/versions/0005_batch_jobs.py`** — three tables with RLS exactly like every
  other tenant table here (ENABLE + FORCE + `tenant_isolation` with an explicit
  `WITH CHECK`) plus a SELECT-only `app.worker` policy per table, because the due scan,
  the reaper and the deadline sweep all read across tenants and under FORCE RLS the
  isolation policy alone silently matches zero rows. Two constraints carry semantics:
  `ux_batch_runs_active_job` (PARTIAL unique on `batch_job_id` over the non-terminal
  statuses — two instances that both see a job come due cannot both create a run, i.e.
  cannot both ingest the batch) and `ux_batch_run_ingestions_binding` (one ingestion per
  run per binding).
- **`app/store/{orm,sql,memory}.py`** — repos + the cross-tenant `SqlBatchJobScanner` /
  `MemoryBatchJobScanner` (`due`, `orphaned`, `past_deadline`). `SqlBatchRunRepo.update`
  excludes the lease columns for the same reason `SqlRunRepo.update` does: a caller
  writing back a row it read BEFORE claiming would erase the lease it is holding.
- **`app/domain/batch.py`** — `BatchJobService`: CRUD, cron `fire_due`, `drive_run`
  (claim → heartbeat → advance → release), `_ensure_triggered`, `_ingestion_state`,
  `_phase_pipeline`, `retry`, `terminate`, `recover_orphans`, `sweep_deadlines`, and the
  two consumer hooks.

### inc2 — real ingestion trigger + event-driven ingestion phase — DONE

- **`app/adapters/ingestion_client.py`** — `HttpIngestionClient` against
  `POST /internal/v1/mcp/invoke`. A REAL dependency: any non-2xx, transport error, or
  missing ingestion id raises `DependencyUnavailable` and the run fails in `trigger`. It
  never fabricates an id. There is **no in-memory ingestion double in the runtime
  wiring** — with nothing configured a batch job fails honestly rather than skipping the
  trigger phase and scoring whatever was already there.
- **Idempotency, twice over.** Locally, a binding that already has a record on this run is
  skipped. Remotely, the key is `{batch_key}:{binding_key}`, so the window a local record
  cannot close — ingestion-service created the ingestion, then this pod died before
  writing the row — replays the original instead of creating a second.
- **`app/events/consumer.py`** — consumes `ingestion.events.v1` (added to
  `CONSUMED_TOPICS`) for `ingestion.{completed,failed,cancelled}`, and
  `dataset.version_created` off the already-consumed `dataset.events.v1`. Each records
  the outcome and spawns a background drive; a failed/cancelled ingestion fails the run
  in `ingestion` and the pipeline phase never runs. Events for ingestions that belong to
  no batch job are a clean no-op.
- **`app/main.py`** — two background loops behind `batch_jobs_enabled`: the ticker
  (fire_due + orphan sweep) and the deadline sweep. Three distinct ways a run gets stuck,
  three distinct answers.
- **`app/domain/services.py`** — `_input_urns` now also carries an explicit
  `input_dataset_urns` run parameter onto the pipeline run, so the pinned version URNs
  land on the run itself; the batch provenance params are excluded from the training
  hyperparameters (they are lineage, and passing them to an estimator would be an
  unknown-kwarg crash).

### inc3 — `batch-trigger` component + REST + events — DONE

- **`app/domain/catalog.py`** — `batch-trigger` (IO, 0 in / 0 out, params
  `connection_id` required + `ingestion_mode` / `dataset` / `statement`).
- **`app/domain/dag.py`** — it has no output port, so it is always a graph terminal;
  added to the allowed terminals for data_prep / inference / scheduled /
  feature_engineering, or every pipeline that pulls mid-DAG would be rejected as invalid.
- **`app/executor/local_pipeline.py`** — a `trigger(alias, params)` port alongside
  reader/writer, so the executor stays pure and synchronous while the async
  ingestion-service call lives in the service wiring
  (`asyncio.run_coroutine_threadsafe` back onto the main loop, since the DAG runs in a
  worker thread). Fails CLOSED with no port wired. `Idempotency-Key = {run_id}:{alias}`,
  so a reaper re-drive of the same run replays rather than re-ingests. The ingestion id
  is recorded on the node's `components_status`.
- **REST** — `POST/GET/PATCH/DELETE /api/v1/batch-jobs`, `/{id}/pause|resume|run-now`,
  `GET /{id}/runs`, `GET /batch-job-runs/{id}` (with the per-binding phase timeline),
  `POST /batch-job-runs/{id}/retry`, `PUT /batch-job-runs/{id}/terminate`. Five new
  actions in the registered manifest (`pipeline.batch_job.*`), asserted both ways by the
  existing `test_action_manifest` guard.
  *Deviation:* retry is on the RUN, not the job (BRD §4 said `/batch-jobs/{id}/retry`) —
  retry resumes a specific failed run from the phase it failed in, and a job can have
  many failed runs.
- **Events** — `batch_job.{created,updated,paused,resumed,deleted}` and
  `batch_job.run.{started,phase_changed,succeeded,failed,cancelled}` on the existing
  transactional outbox, resource_urn `wr:{tenant}:pipeline:batch-job-run/{id}`.

### inc3b — the BFF leg + the Batch Jobs page (AC-9's UI half) — DONE

The backend already served everything this needs; nothing about the aggregate changed.

- **`services/bff-graphql/src/clients/pipelines.ts`** — `BatchJobDTO`,
  `BatchJobRunDTO`, `BatchJobRunIngestionDTO` and eleven methods over the REST
  surface exactly as it exists: list/get jobs, list a job's runs, get one run,
  create/update/pause/resume/run-now/delete, retry and terminate a RUN.
- **`src/schema/typeDefs.ts` + `map.ts` + `resolvers/index.ts`** — `BatchJob`,
  `BatchJobRun`, `BatchJobRunIngestion`, `BatchJobList`, `BatchJobRunList`,
  `CreateBatchJobInput` / `UpdateBatchJobInput` / `BatchJobBindingInput`; four
  root queries and eight mutations. Pure passthrough on the established pattern —
  JWT forwarded verbatim, the orchestrator enforces every `pipeline.batch_job.*`
  guard, the BFF makes no authz decision and keeps its CI-enforced
  no-DB / no-consumer / no-cache shape (nothing was added to `eslint.config.js`'s
  `no-restricted-imports` or `deploy/services.yaml`'s `db: ~` / `migrate: false`).
  SDL snapshot regenerated (+237 lines).
- **Three places the REST contract forced a decision rather than a convention:**
  1. **`ingestions` is nullable, never `[]`-by-default.** `GET /batch-jobs/{id}/runs`
     omits the key entirely; only `GET /batch-job-runs/{id}` serializes it. Mapping
     an absent key to `[]` would render an empty timeline for a run that has two
     bindings, so `mapBatchJobRun` emits `null` and the SDL says so.
  2. **No `idempotencyKey` argument anywhere.** pipeline-orchestrator's API layer
     reads no `Idempotency-Key` header on ANY route — `SqlIdempotencyRepo` exists
     but is not wired to one — so accepting a key would advertise a guarantee the
     backend does not make. AC-4's idempotency is server-side
     (`{batch_key}:{binding_key}` against ingestion-service) and needs nothing
     from the caller.
  3. **`updateBatchJob` sends only the keys the caller supplied.** The backend
     PATCH is `model_dump(exclude_unset=True)`, so presence — not nullishness —
     is the test: `{cron: null}` is a deliberate clear and must be forwarded,
     while an omitted `cron` must not be.
- **`services/ui-web`** — types / operations / query keys / hooks, five new
  `FEATURE_GATES` on the real rbac actions the routes guard
  (`pipeline.batch_job.{read,create,update,delete,execute}`; note the backend
  guards run-now, retry AND terminate with `execute`, so the UI does not invent a
  finer split), and a `ROUTE_RULES` entry for `/data/pipelines/batch-jobs` gated
  on `pipeline.batch_job.read` — a LONGER prefix than `/data/pipelines`, because a
  persona holding `pipeline.template.read` does not automatically hold the
  batch-job capability. **Not added to `NAV_ITEMS`**: checked, and the neighbouring
  Runs / Schedules pages are not there either — they are reached from buttons in
  the Pipelines page header, so Batch Jobs is surfaced the same way.
- **`/data/pipelines/batch-jobs`** — the jobs grid (cadence, bindings count,
  paused/scheduled, next fire) with run-now / pause / resume / delete and a create
  dialog bound to the real pipeline-template and connection lists; below it, the
  picked job's runs, and per run the `trigger → ingestion → pipeline` timeline with
  each phase's state, the per-binding ingestion outcomes (status, ingestion id,
  the pinned dataset **version** urn and Iceberg snapshot id, the per-binding
  error) and the input/output dataset URNs the run recorded.
- **`BatchRunTimeline.phaseStates`** is a projection, not invented data. The
  backend records exactly two things — where the run IS (`phase`) and how it is
  doing there (`status`) — so phases before the current one completed (the machine
  cannot advance otherwise), the current one carries the run's status, and later
  ones were never reached. A phase name the enum does not contain returns `null`
  and renders an error, rather than guessing a position on the timeline.

### What the tests prove

`tests/unit/test_batch_jobs.py` (**40**, pipeline-orchestrator) — every assertion is
about ordering or refusal, because every one of these failures used to be silent:

- **AC-1** with two bindings, the run parks in `ingestion` and `pipeline_run_id` stays
  `None` after the FIRST ingestion lands; only the second unblocks it. A separate test
  re-drives the run three times with no events and shows nothing moves — there is no poll
  that could discover the batch landed.
- **AC-2** a failed (and separately, a cancelled) ingestion fails the run with
  `phase="ingestion"`, `code=BATCH_INGESTION_FAILED`, and no pipeline run. Plus: a failed
  trigger fails in `trigger`, and a missing ingestion client fails honestly rather than
  skipping the phase.
- **AC-3** `input_dataset_urns == ["wr:{t}:dataset:version/claims@v12"]` on both the batch
  run and the pipeline run, with the exact `iceberg_snapshot_id` and `batch_key` in the
  pipeline run's parameters; and a completed ingestion whose version has not been
  registered yet does NOT advance the phase.
- **AC-4** a re-drive of the trigger phase leaves exactly 2 distinct ingestions for 2
  bindings; and the crash-between-call-and-record window replays (the fake client mirrors
  ingestion-service's replay contract, so this proves something).
- **AC-5** a second instance declines a leased run *and fires no bindings*; two instances
  scanning the same due row produce exactly one run; a live lease survives a stale
  whole-row write; a run parked in `ingestion` is not reaped; a run stranded mid-trigger
  is.
- **AC-6** an ingestion phase that SUCCEEDED and a pipeline phase that failed → retry
  resumes at `pipeline`, ingests nothing more, and inherits the same pins. An ingestion
  phase where one of two bindings failed → retry resumes at `ingestion`, carries the
  landed binding over untouched, and fires a genuinely NEW ingestion for the failed one
  (not a replay of the failed ingestion).
- **AC-7** the deadline sweep is a no-op before the deadline and fails the run after it
  with `BATCH_PHASE_TIMEOUT` + the phase; per-job `phase_timeout_seconds` overrides the
  default; a timed-out run is retryable from the phase it timed out in.
- **AC-8** the catalog shape, a DAG containing `batch-trigger` validating, the executor
  running it twice against one Idempotency-Key and getting one ingestion, failing closed
  with no port, and a full data-prep RUN through the real local executor path recording
  `ingestion_id` on the node status with key `{run_id}:pull-1`.
- **AC-9** the outbox carries `batch_job.created`, `run.started`, `phase_changed`
  (`["ingestion", "pipeline"]`, in order), `run.succeeded`; a failed run emits exactly one
  phase-scoped `run.failed`.
- plus CRUD, pause/resume, cron fire + advance, ticker-skips-an-active-job, cross-tenant
  404s (job, run, and runs list), binding validation, and the `file_upload` refusal (it
  needs a human to push bytes, so a cron-fired job bound to one could only ever hang).

`tests/integration/test_batch_jobs_sql.py` (**7**, real Postgres 16 via Testcontainers) —
the unit tier proves the machine over the in-memory store; these prove the mirror is
real. Migration 0005 applies; cross-tenant reads of jobs/runs/ingestions return nothing;
`ux_batch_runs_active_job` raises `IntegrityError` on a second active run;
`ux_batch_run_ingestions_binding` raises on a duplicate binding; the worker policy lets
the due scan see BOTH tenants' jobs while a session with no GUC sees zero rows; the
orphan scan skips a parked `ingestion` run and catches a stranded `trigger` one; the
lease is a single conditional UPDATE (loser declined, non-holder cannot renew, expired
lease taken over); and a stale whole-row write cannot erase a live lease.

`tests/unit/test_internal_mcp_idempotency.py` (**5**, ingestion-service) — the internal
facade accepts pipeline-orchestrator's SPIFFE and still refuses an unknown one; a
repeated `idempotency_key` replays the SAME ingestion (one row in the table, not two); a
different key creates a genuinely new one; and a call with NO key still works, so
mcp-gateway's existing path is unchanged.

`tests/unit/batch-jobs.test.ts` (**14**, bff-graphql) — against a double that mirrors
the orchestrator's real payloads, including the asymmetry that matters: the runs list
omits `ingestions` and the single-run read carries it.

- the jobs list paginates with a `wr:{t}:pipeline:batch-job/{id}` urn and forwards the
  bindings verbatim; an unknown job id is `null`, not an error;
- **the runs LIST leaves `ingestions` null** and the single-run read carries both
  bindings, with `datasetVersionUrn` + `icebergSnapshotId` on the one that landed and
  its phase-scoped error on the one that failed — plus the run's own
  `inputDatasetUrns == ["wr:{t}:dataset:version/claims@v12"]` (AC-3);
- **a 503 on the jobs list surfaces as `SERVICE_UNAVAILABLE` with `data.batchJobs`
  null** — never an empty list;
- `createBatchJob` sources `workspace_id` from the JWT, maps camel bindings to the
  snake `ConnectionBinding` shape, and **fails closed with nothing sent downstream**
  when the token carries no workspace;
- `updateBatchJob` sends ONLY `{name}` for a name-only edit and forwards an explicit
  `{cron: null}` as a clear;
- pause/resume, run-now (a new run in `trigger`, `ingestions` null), retry (the NEW
  run resumes at `ingestion` with `retriedFromRunId` — not at `trigger`, AC-6),
  terminate, and delete-on-204.

`batch-jobs.test.tsx` (**10**, ui-web) and `BatchRunTimeline.test.tsx` (**9**, ui-web) —
the AC-9 UI half, with the error-vs-empty distinction asserted explicitly at every level:

- the jobs grid reflects the real `batchJobs` result; **no jobs** renders "No batch jobs
  yet" with NO alert, and a **failed** query renders the error panel with the downstream
  message and NO "No batch jobs yet" and no grid;
- the same split for a job's runs ("This batch job has not run yet" vs the error panel)
  and for the single-run read (an error panel, and **no** half-rendered timeline);
- a run that failed in `ingestion` renders trigger=`succeeded`, ingestion=`failed`,
  pipeline=`not reached`, both per-binding rows with the completed one's version pin and
  snapshot id and the failed one's `SOURCE_UNREACHABLE`, the recorded input urn, "None
  recorded." for the outputs it never produced, and the run's `BATCH_INGESTION_FAILED`;
- `phaseStates` unit-tested over succeeded / failed-in-ingestion / parked-in-ingestion /
  cancelled-in-trigger, and returning `null` (→ an error, not a drawn timeline) for a
  phase name the enum does not contain;
- **`ingestions: null` renders "the per-source timeline was not returned" while
  `ingestions: []` renders "no ingestions recorded yet"** — two different facts, two
  different strings;
- retry fires the real mutation for the failed run; create sends the real camel
  variables and refuses to submit with no binding (the backend requires ≥1).

**Suites:** pipeline-orchestrator unit **260** (was 220) green, `ruff` clean;
pipeline-orchestrator integration 16 green (the one pre-existing failure,
`test_corrections_produce_a_real_model_in_mlflow`, an xgboost string-label issue, fails
identically on a clean tree — untouched by this work). ingestion-service unit **596**
(was 591) green, `ruff` clean. bff-graphql **482** (was 468) green, `tsc --noEmit` and
`eslint src` clean; ui-web **965** (was 946) green, `tsc --noEmit` clean.

### Deferred, honestly

- ~~**AC-9's UI half and the BFF leg.**~~ CLOSED in inc3b — see above.
- **The batch-run timeline does not live-update off the outbox events.** AC-9's event
  half emits `batch_job.run.phase_changed`, but there is no realtime topic wiring it to
  the browser: the runs list and the run detail POLL every 5s while any loaded run is
  non-terminal and stop once they are all terminal. Honest and correct, but it is a poll,
  not a push. Closing it means a hub topic for `batch-job-run` alongside the existing
  `pipeline-run` one.
- **The UI edits nothing but lifecycle.** `updateBatchJob` is served by the BFF and
  tested, but the page has no edit form — create, pause/resume, run-now, retry,
  terminate and delete only. Deliberate: editing bindings mid-flight is a governance
  question (which runs does the change apply to?) that this increment does not answer.
- **`connectionBindings` is served as opaque JSON.** The backend stores V1's
  `connections` blob and `batch_job_payload` returns it unshaped; the UI narrows it only
  far enough to count bindings, and the create form writes `{connectionId}` per row
  (no per-binding `ingestion_params` or `dataset_urn` editor). Typing it in the SDL
  would mean asserting a shape the backend does not enforce on read.
- **AC-10 / inc4 — the `data_pipeline_builder` agent proposal.** Not started. The
  cross-tenant-404 half of AC-10 IS covered (unit + the RLS integration test).
- **Version-scoped READS.** AC-3 is satisfied as *recorded* pinning: the exact dataset
  version URN and Iceberg snapshot id are on the batch run, on the pipeline run's
  `input_dataset_urns`, and in its run parameters. The executor still READS through
  dataset-service's `GET /internal/v1/datasets/{id}/rows`, which serves the dataset's
  CURRENT version — normally the very version this batch just landed, but there is no
  version-scoped rows API to read an older one. Flagged rather than faked; closing it
  means a `?version=` parameter on that dataset-service endpoint.
- **Deadline sweep is a poll.** The ingestion PHASE is event-driven as specified; the
  deadline that bounds it is a 60s sweep. There is no event for "an event that never
  arrived".
- **Rate limiting.** Batch-submitted pipeline runs go through `RunService.create_run`,
  which rate-limits per `submitted_by`; the batch orchestrator submits as one service
  principal, so a fleet of jobs firing inside `min_seconds_between_runs` will see runs
  rejected and their batch runs fail in `pipeline`. Pre-existing behaviour shared with
  `PipelineScheduleService` (same single-principal shape), not introduced here, and not
  fixed here.
