# BRD 11 — inference-service

**Service:** inference-service · **Lang/stack:** Python 3.12 / FastAPI / SQLAlchemy 2 / Alembic / Postgres / Kafka / Temporal
**Phase:** 3 · **Status:** Approved for build · **Inherits:** `00_MASTER_BRD.md` (all MASTER-FR-\*)
**Replaces (V1):** model-builder's `Inference` model + callback flow (status enum `processing/done/failed`, Pipeline-Manager HTTP callbacks, no schema validation, no scheduling).

---

## 1. Overview

**Purpose.** inference-service owns batch inference (scoring): a user or agent picks a **registered model version** (from experiment-service) and an **input dataset** (from dataset-service); the service validates schema compatibility *before* submission, submits the model's inference pipeline as a pipeline-orchestrator run (executed on Argo), tracks the job through an explicit state machine driven by `pipeline.events.v1` (no callbacks, no polling), and on success registers the **output dataset** in dataset-service with a **lineage edge** `model_version + input_dataset → inference_job → output_dataset`. It also owns **scheduled scoring** via Temporal schedules. Online serving via KServe is a later phase: out of scope to build, but the API namespace and data model reserve it (§11).

**Business value.** Scoring is how models produce business output (e.g., anomaly scores feeding case-service triage). V1 submitted inferences fire-and-forget to pipeline-manager and mutated state through unauthenticated-style HTTP callbacks; there was no input validation (bad column mappings failed 20 minutes into a run), no recurrence, no lineage, and outputs were loose dataset ids. The rebuild fails bad jobs in milliseconds, makes every scoring output a governed, versioned, lineage-tracked dataset, and lets scoring run on schedules with alerting.

**In scope**
- Batch inference jobs: submit, watch (event-driven), cancel, retry.
- Pre-submit compatibility validation: input dataset schema vs model version input schema; model stage policy.
- Scheduled scoring (Temporal schedules; cron + interval), overlap policy, pause/resume.
- Job status state machine + `inference.events.v1` lifecycle events.
- Output dataset naming/versioning conventions; registration in dataset-service; lineage edges.
- Failure semantics including the partial-results policy.
- MCP facade (read tools + `inference.job.submit` as write-proposal for agents).

**Out of scope** (§11): online/real-time serving (KServe — API reserved), model training/registration (experiment-service), pipeline compilation (pipeline-orchestrator), output data visualization (chart-service), drift monitoring.

---

## 2. Actors & user stories

| Persona | Description |
|---|---|
| Analyst / DS | Runs ad-hoc scoring of a production model on a new dataset |
| ML engineer (MLE) | Sets up nightly scheduled scoring, handles failures |
| Inference agent | Proposes inference jobs grounded in registry + dataset compatibility |
| case-service / downstream | Consumes output datasets and events for triage |
| Platform admin | Sets tenant concurrency caps, schedule limits |

- **US-1** As an analyst, I pick a registered model version and an input dataset; the UI immediately tells me whether the dataset is compatible (missing/mistyped columns listed per field) before I can submit.
- **US-2** As an analyst, I submit a batch inference and watch it progress (validating → running → succeeded) live via SSE, then open the output dataset directly from the job page.
- **US-3** As an MLE, I schedule daily scoring of the production fraud model on the previous day's ingested partition, with skip-if-still-running overlap policy and failure notifications.
- **US-4** As an MLE, when a nightly run fails, I see whether any partial output leaked (never, by policy), the component-level error, and I retry the job with one call preserving parameters.
- **US-5** As an inference agent, I check compatibility via a read tool, then propose a job; on human approval the job runs attributed to me + the approver.
- **US-6** As a case-service developer, I consume `inference.job.succeeded` events carrying the output dataset URN to trigger case generation — no polling.
- **US-7** As a DS, I find every output dataset a given model version ever produced via lineage, and every model that scored a given input dataset.
- **US-8** As an MLE, I pause a schedule during an incident and resume it later; missed windows are not backfilled unless I ask.
- **US-9** As a platform admin, I cap a tenant at N concurrent inference jobs; excess submissions queue deterministically.
- **US-10** As an analyst, I rely on predictable output names (`<model>-v<version>-scores-...`) and versions so downstream queries never break when scoring re-runs.

---

## 3. Functional requirements

### Job submission & validation
- **INF-FR-001 (M)** `POST /inferences` with `{name?, description?, model_version_urn, input_dataset_urn, parameters?{}, output?{dataset_name?, mode?}}` creates a job. `name` unique per workspace among non-deleted (auto-generated when absent, §INF-FR-030). Returns `202 {operation_id, job_id}` with the job in `validating`.
- **INF-FR-002 (M)** **Schema compatibility validation before submit** (synchronous, part of the 202 pipeline; job fails to `rejected` without ever touching Argo when invalid):
  1. Model version fetched from experiment-service (gRPC): must exist, be workspace-visible, carry an `input_schema` (MLflow signature), and satisfy stage policy — default allowed stages `{production, staging}`; `none`/`archived` require explicit `allow_unpromoted=true` + `inference.job.submit_unpromoted` permission.
  2. Input dataset's current-version schema fetched from dataset-service: every model input column must exist with a compatible type (numeric widening allowed `int→long→float→double`; `string` never coerced; nullable input for a non-nullable model column → incompatible unless the model pipeline contains a missing-values handler flagged in the template metadata).
  3. Extra dataset columns are allowed (passed through or dropped per `parameters.include_features`).
  4. Row-count 0 → warning `EMPTY_INPUT` (submittable with `allow_empty=true`, else rejected).
  Result stored on the job as `compatibility_report JSONB` (per-column verdicts); failures → state `rejected` with `error.code=SCHEMA_INCOMPATIBLE` listing every violation (not just the first).
- **INF-FR-003 (M)** `POST /inferences/validate` runs step INF-FR-002 standalone (no job created) — used by the UI live check and the inference agent's grounding tool.
- **INF-FR-004 (M)** On validation pass, the service resolves the model's **inference pipeline template** (from the model version's registration metadata; the shared `common/inference` component pipeline instantiated at model registration) and submits a run via pipeline-orchestrator `POST /pipelines/:id/run`, passing `{model_ref: models:/<name>/<version>, flavor, input_dataset_urn, output conventions (§INF-FR-030), parameters}`; stores `pipeline_run_urn`; job → `submitted`. Predict-proba, batching and include-features flags pass through as component parameters (V1 params kept: `predict_proba`, `return_types`, `include_features`).
- **INF-FR-005 (M)** Job status is driven exclusively by consuming `pipeline.events.v1` for the linked run (`started → running`, `succeeded → finalizing → succeeded`, `failed → failed`, `cancelled → cancelled`). **No HTTP callbacks** (V1's `PATCH /inferences/:id` callback contract is retired); no polling of pipeline-orchestrator.
- **INF-FR-006 (M)** `POST /inferences/:id/cancel` → forwards terminate to pipeline-orchestrator; job → `cancelling` → `cancelled` on event confirmation; idempotent.
- **INF-FR-007 (M)** `POST /inferences/:id/retry` creates a **new** job with identical inputs/parameters, `retried_from_job_id` set; re-runs full validation (the model or dataset may have changed since).
- **INF-FR-008 (M)** Per-tenant concurrency cap `max_concurrent_inference_jobs` (default 5): excess jobs wait in `queued` (FIFO, depth cap 100 → 429 `BUDGET_EXHAUSTED`); dequeue on terminal events.
- **INF-FR-009 (S)** Batch submit `POST /inferences/bulk` (≤ 20 jobs, same model, multiple datasets) returning per-item results.

### Output datasets & lineage
- **INF-FR-030 (M)** **Output naming convention:** default dataset name `"{model_name}-v{model_version}-scores"` (job `name` defaults to `"{dataset_name} @ {ISO date}"`); explicit `output.dataset_name` allowed (validated: `^[a-zA-Z0-9_\- ]{3,120}$`, unique per workspace for `mode=create`).
- **INF-FR-031 (M)** **Output versioning:** `output.mode ∈ {create (default), append, replace}`. `create` → new dataset, version 1; `append`/`replace` target an existing output dataset **owned by a prior job of the same model** (else 422 `OUTPUT_NOT_OWNED`) and produce a new DatasetVersion (Iceberg snapshot append / overwrite). Scheduled scoring defaults to `append` with partition column `scored_at::date`. Every output row set carries system columns `_datacern_job_id`, `_datacern_model_version`, `_scored_at`.
- **INF-FR-032 (M)** On `pipeline.run.succeeded` + `pipeline.run.output_registered`, the job enters `finalizing`: the service confirms the output dataset registration with dataset-service (URN + snapshot id), writes **lineage edges** — `(model_version_urn) -[used_by]-> (job_urn)`, `(input_dataset_urn) -[input_to]-> (job_urn)`, `(job_urn) -[produced]-> (output_dataset_urn@version)` — then transitions to `succeeded` and emits `inference.job.succeeded` with all URNs. Lineage write failure keeps the job in `finalizing` with retries (max 1 h) before `failed(LINEAGE_REGISTRATION_FAILED)` — the dataset remains but is flagged.
- **INF-FR-033 (M)** `GET /inferences/:id` returns the job with resolved input/output dataset descriptors, model version summary, `compatibility_report`, per-component status (proxied snapshot from the pipeline run row mirrored at event time), and error detail.

### Failure semantics
- **INF-FR-040 (M)** **Partial-results policy: none visible.** The inference pipeline writes to Iceberg such that data is committed in a single snapshot at completion; on `failed`/`cancelled`, no output DatasetVersion is registered, and the orchestrator's `pipeline.run.outputs_invalidated` flow garbage-collects any staged data. `append`-mode failures leave the prior version untouched and current. A job can never partially succeed; downstream consumers may treat `inference.job.succeeded` as "complete output or nothing".
- **INF-FR-041 (M)** Failure taxonomy on `error.code`: `SCHEMA_INCOMPATIBLE`, `MODEL_STAGE_DENIED`, `EMPTY_INPUT`, `COMPONENT_TIMEOUT`, `OUT_OF_MEMORY`, `PIPELINE_FAILED` (with component alias + message copied from the run), `LINEAGE_REGISTRATION_FAILED`, `QUOTA_TIMEOUT`, `DEPENDENCY_UNAVAILABLE`. Every failure emits `inference.job.failed` and a notification to the submitter (and schedule owner for scheduled jobs).
- **INF-FR-042 (M)** Jobs stuck non-terminal past `max_run_duration` (default 8 h, tenant-configurable) are reaped by a Temporal sweep → cancel + `failed(QUOTA_TIMEOUT)`.

### Scheduled scoring (Temporal)
- **INF-FR-050 (M)** Schedule CRUD: `{name unique/ws, model_version_urn | model_urn+stage_selector, input_selector, cron | interval, timezone, overlap_policy ∈ {skip (default), queue, cancel_running}, output {dataset_name, mode: append}, enabled, notify_on_failure}`. Backed by a **Temporal Schedule** per row (schedule id = schedule URN); each fire runs a workflow that resolves the input selector, then executes INF-FR-001..005 as a normal job with `schedule_id` set.
- **INF-FR-051 (M)** `input_selector` forms: fixed `dataset_urn` (score latest version at fire time) or `dataset_urn + partition_window` (e.g., previous day's partition — resolved via dataset-service). Resolution failure → job `rejected(INPUT_RESOLUTION_FAILED)` + notification; the schedule keeps running.
- **INF-FR-052 (M)** `stage_selector` (e.g., `production`) re-resolves the model version **at each fire** via experiment-service; if no version currently holds the stage, the fire is skipped with `inference.schedule.fire_skipped {reason: NO_MODEL_IN_STAGE}`. Pinned `model_version_urn` schedules are unaffected by later promotions.
- **INF-FR-053 (M)** Pause/resume (`POST /schedules/:id/pause|resume`); paused windows are **not** backfilled; explicit `POST /schedules/:id/trigger` runs one fire now (also the "backfill one window" tool). Deleting a schedule cancels the Temporal schedule and any `queued` fires; running jobs continue.
- **INF-FR-054 (M)** Consecutive-failure circuit breaker: after N (default 3) consecutive failed fires, the schedule auto-pauses and emits `inference.schedule.auto_paused`.
- **INF-FR-055 (S)** Per-tenant schedule quota (default 50 enabled schedules; 422 `BUDGET_EXHAUSTED` beyond).

### Agent & API surface
- **INF-FR-060 (M)** MCP facade: read tools `inference.jobs.list/get`, `inference.compatibility.check`, `inference.schedules.list`; write-proposal tools `inference.job.submit`, `inference.schedule.create/update`. Proposals carry the compatibility report as `predicted_effect`. Schedule mutations and job submissions by agents never auto-execute unless tenant policy allows write-direct for non-production model stages.
- **INF-FR-061 (M)** Model promotion awareness: consumes `experiment.events.v1: model_version.promoted|archived` to annotate affected stage-selector schedules (next-fire resolution preview updated) and to warn owners of pinned schedules whose version got archived (`inference.schedule.model_archived_warning`).

### Online serving (reserved — build later)
- **INF-FR-070 (C)** Reserve API namespace `/api/v1/endpoints` (online serving endpoints: create/get/list/delete, `POST /endpoints/:id/predict` proxy) and DB table `serving_endpoints`; all return 501 `NOT_IMPLEMENTED` in this phase. KServe `InferenceService` CRs, autoscaling, canary traffic are Phase 6 (§11).

## 4. Domain model & data

### 4.1 Tables (all: `id UUIDv7, tenant_id, created_at, updated_at`; RLS per master)

**inference_jobs** — `workspace_id`, `name`, `description`, `status SMALLINT NOT NULL`, `model_version_urn TEXT NOT NULL`, `model_name TEXT`, `model_version INT`, `model_stage_at_submit SMALLINT`, `input_dataset_urn TEXT NOT NULL`, `input_dataset_version INT`, `output_dataset_urn TEXT NULL`, `output_dataset_version INT NULL`, `output_mode SMALLINT`, `parameters JSONB`, `compatibility_report JSONB`, `pipeline_run_urn TEXT NULL`, `components_status JSONB`, `error JSONB NULL`, `schedule_id UUID NULL`, `retried_from_job_id UUID NULL`, `submitted_by`, `via_agent JSONB NULL`, `queued_at/submitted_at/started_at/finished_at`, `deleted_at`. Partitioned monthly (MASTER-FR-062); retention 18 months → Iceberg. Indexes: `(tenant_id, status, created_at DESC)`, `(tenant_id, workspace_id, name) unique partial WHERE deleted_at IS NULL AND schedule_id IS NULL`, `(model_version_urn, created_at DESC)`, `(schedule_id, created_at DESC)`, `(pipeline_run_urn)`.

**scoring_schedules** — `workspace_id`, `name`, `model_version_urn TEXT NULL`, `model_urn TEXT NULL`, `stage_selector SMALLINT NULL` (exactly one of pinned/selector — CHECK), `input_selector JSONB NOT NULL`, `cron TEXT NULL`, `interval_seconds INT NULL` (CHECK one of), `timezone TEXT DEFAULT 'UTC'`, `overlap_policy SMALLINT DEFAULT 0`, `output JSONB NOT NULL`, `enabled BOOL DEFAULT true`, `paused_reason TEXT NULL`, `consecutive_failures INT DEFAULT 0`, `temporal_schedule_id TEXT UNIQUE`, `notify_on_failure BOOL DEFAULT true`, `created_by`, `deleted_at`. Unique partial `(tenant_id, workspace_id, name) WHERE deleted_at IS NULL`. Index `(tenant_id, enabled)`.

**job_queue** — `job_id UUID UNIQUE`, `enqueued_at` (FIFO per tenant). **serving_endpoints** — reserved (INF-FR-070): `name`, `model_version_urn`, `status`, `kserve_ref` — no writes this phase. **outbox** — per MASTER-FR-034.

JSONB justifications (MASTER-FR-061): `parameters` (≤ 16 KB pass-through component params), `compatibility_report` (per-column verdict doc ≤ 64 KB), `components_status` (event-time snapshot), `error`, `input_selector`, `output` — none relationally queried.

### 4.2 Enums
`status`: validating=0, rejected=1, queued=2, submitted=3, running=4, finalizing=5, succeeded=6, failed=7, cancelling=8, cancelled=9. `output_mode`: create=0, append=1, replace=2. `overlap_policy`: skip=0, queue=1, cancel_running=2. (V1 mapping for migration: processing→running, done→succeeded, failed→failed.)

### 4.3 Job state machine
```
validating ──invalid──▶ rejected ⏹
    │ valid
    ▼
 queued ──capacity──▶ submitted ──run started──▶ running ──run succeeded──▶ finalizing ──lineage+registration ok──▶ succeeded ⏹
    │                     │                        │  │                        └─retries exhausted─▶ failed ⏹
    │                     └────── run failed ──────┴──┼──────────────────────▶ failed ⏹
    └──────── cancel ─────▶ cancelled ⏹    cancel ───▶ cancelling ──confirmed──▶ cancelled ⏹
guards: cancel allowed from queued/submitted/running (validating and finalizing are non-cancellable);
terminal states {rejected, succeeded, failed, cancelled} immutable; retry allowed only from terminal failure states.
```

## 5. API specification (`/api/v1`; representative)

| Method & path | Purpose | Errors |
|---|---|---|
| POST `/inferences` | Submit job → 202 | 422 SCHEMA_INCOMPATIBLE/MODEL_STAGE_DENIED, 429 |
| POST `/inferences/validate` | Compatibility check only | 404 model/dataset, 422 |
| GET `/inferences` | List (filter[status], filter[model_version_urn], filter[schedule_id], sort=-created_at) | — |
| GET `/inferences/:id` | Detail (report, components, error, URNs) | 404 |
| POST `/inferences/:id/cancel` · POST `/inferences/:id/retry` | Cancel / retry-as-new | 404, 409 non-cancellable |
| DELETE `/inferences/:id` | Soft delete (terminal jobs only) | 409 |
| POST `/inferences/bulk` | ≤ 20 jobs, per-item results | 207-style body |
| POST/GET `/schedules` · GET/PATCH/DELETE `/schedules/:id` | Schedule CRUD | 409 name, 422 |
| POST `/schedules/:id/pause` · `/resume` · `/trigger` | Ops | 404, 409 |
| GET `/schedules/:id/fires` | Fire history (jobs by schedule) | 404 |
| ALL `/endpoints*` | Reserved online serving | 501 NOT_IMPLEMENTED |

Validate response example:
```json
{"data": {"compatible": false, "model_stage": "production",
  "columns": [
    {"name": "amount", "required_type": "double", "actual_type": "double", "verdict": "ok"},
    {"name": "merchant_id", "required_type": "string", "actual_type": null, "verdict": "missing"},
    {"name": "age", "required_type": "long", "actual_type": "string", "verdict": "type_mismatch"}],
  "warnings": [{"code": "EXTRA_COLUMNS", "columns": ["notes"]}]}}
```
Submit error: `422 {"error":{"code":"SCHEMA_INCOMPATIBLE","message":"2 incompatible columns","details":[...same column objects...],"trace_id":"..."}}`.

Schedule create example:
```json
POST /api/v1/schedules
{ "name": "nightly-fraud-scoring",
  "model_urn": "wr:t-42:experiment:model/mdl-7a1", "stage_selector": "production",
  "input_selector": {"dataset_urn": "wr:t-42:dataset:dataset/ds-txn",
                     "partition_window": {"column": "ingested_at", "range": "previous_day"}},
  "cron": "0 3 * * *", "timezone": "America/New_York",
  "overlap_policy": "skip",
  "output": {"dataset_name": "fraud-scores-daily", "mode": "append"},
  "notify_on_failure": true }
→ 201 {"data": {"id": "sch_01J...", "enabled": true, "temporal_schedule_id": "wr:t-42:inference:schedule/sch_01J...",
       "next_fire_preview": {"at": "2026-07-10T07:00:00Z", "resolved_model_version": 3}}}
```

Job detail response (abbreviated):
```json
GET /api/v1/inferences/job_01J...
→ 200 {"data": {"id": "job_01J...", "status": "succeeded", "name": "txn-2026-07-08 @ 2026-07-09",
  "model": {"urn": "wr:t-42:experiment:model_version/mdl-7a1@3", "name": "fraud-xgb", "version": 3, "stage_at_submit": "production"},
  "input_dataset": {"urn": "wr:t-42:dataset:dataset/ds-txn", "version": 41},
  "output_dataset": {"urn": "wr:t-42:dataset:dataset/ds-scores", "version": 12},
  "compatibility_report": {"compatible": true, "columns": [...]},
  "pipeline_run_urn": "wr:t-42:pipeline:run/run_01J...",
  "components_status": [{"alias": "inference", "phase": "Succeeded", "duration_s": 312}],
  "timestamps": {"submitted_at": "...", "started_at": "...", "finished_at": "..."}}}
```

## 6. Events (`inference.events.v1`)

### Emitted

| Event type | Payload fields |
|---|---|
| `inference.job.created` | `job_id, model_version_urn, input_dataset_urn, schedule_id?, submitted_by, via_agent?` |
| `inference.job.rejected` | `job_id, error{code, details[]}` |
| `inference.job.queued` / `submitted` / `started` | `job_id, pipeline_run_urn?` |
| `inference.job.status_changed` | `job_id, status, previous_status` |
| `inference.job.succeeded` | `job_id, output_dataset_urn, output_dataset_version, model_version_urn, input_dataset_urn, row_count?, duration_s` |
| `inference.job.failed` | `job_id, error{code, component_alias?, message}, duration_s` |
| `inference.job.cancelled` | `job_id, cancelled_by` |
| `inference.schedule.created` / `updated` / `deleted` / `paused` / `resumed` | `schedule_id, name, enabled, paused_reason?` |
| `inference.schedule.fire_skipped` | `schedule_id, fire_at, reason` (`OVERLAP` \| `NO_MODEL_IN_STAGE` \| `INPUT_RESOLUTION_FAILED`) |
| `inference.schedule.auto_paused` | `schedule_id, consecutive_failures` |
| `inference.schedule.model_archived_warning` | `schedule_id, model_version_urn` |

### Consumed

| Topic / event | Handler behavior |
|---|---|
| `pipeline.events.v1: pipeline.run.started/succeeded/failed/cancelled` | Correlate by `pipeline_run_urn` → job transition per §4.3; copy component statuses + error; unknown run URNs ignored (not this service's runs) |
| `pipeline.events.v1: pipeline.run.output_registered` | Record output dataset URN + snapshot for the finalizing step |
| `experiment.events.v1: model_version.promoted/archived` | Refresh stage-selector schedules' next-fire preview; warn pinned schedules on archive (INF-FR-061) |
| `dataset.events.v1: dataset.deleted` | Pause schedules whose `input_selector` pins the dataset (`paused_reason=INPUT_DELETED`); notify owner |
| `usage.events.v1: budget.exhausted` (meter `inference_minutes`) | Reject new submissions 429 until `budget.restored` |

All handlers idempotent and replay-safe per MASTER-FR-032; DLQ per MASTER-FR-033.

## 7. Business rules & edge cases

- **BR-1** Validation is point-in-time: the job pins `input_dataset_version` and `model_version` at submit; later dataset versions or promotions never change a running job.
- **BR-2** Stage policy default `{production, staging}`; unpromoted scoring requires both the flag and the permission (`inference.job.submit_unpromoted`) — agents can never obtain this permission (toolset exclusion).
- **BR-3** Numeric type widening only (`int→long→float→double`); `string↔numeric` never coerces; column matching is case-sensitive exact (V1's silent case-insensitive mismatches are designed out).
- **BR-4** No partial output, ever: single-snapshot Iceberg commit; a `replace`-mode failure leaves the previous version current; `finalizing` retries never re-run the pipeline (registration is idempotent on `(job_id)`).
- **BR-5** Duplicate submits with the same `Idempotency-Key` return the original job (MASTER-FR-025); otherwise identical payloads create distinct jobs (re-scoring is legitimate).
- **BR-6** Cancel racing completion resolves to whichever pipeline event arrives first; a `cancelling` job receiving `run succeeded` proceeds to `finalizing` (data was complete) — the cancel is recorded as a no-op in audit.
- **BR-7** `overlap_policy=skip`: a fire while the previous fire's job is non-terminal emits `fire_skipped {reason: OVERLAP}`; `queue` allows at most 1 pending fire (further fires skip); `cancel_running` cancels the in-flight job before submitting.
- **BR-8** Schedule fires resolve everything fresh (model by stage, dataset latest version/partition); resolution errors reject the fire, count toward the circuit breaker, and never crash the schedule.
- **BR-9** Auto-pause after 3 consecutive failed fires (tenant-configurable 1–10); resume resets the counter.
- **BR-10** DST: cron schedules evaluate in the schedule's IANA `timezone`; skipped/duplicated wall-clock times follow Temporal schedule semantics (documented in the runbook).
- **BR-11** Output name collision in `create` mode → 422 `CONFLICT` at validation, not at finalize; scheduled `append` targets are created on first fire and owned by the schedule thereafter.
- **BR-12** `queued` timeout 60 min → `failed(QUOTA_TIMEOUT)`; queue depth > 100 → immediate 429.
- **BR-13** experiment-service or dataset-service unavailable during validation → 503 `DEPENDENCY_UNAVAILABLE` (job not created); unavailable during `finalizing` → bounded retries per INF-FR-032.
- **BR-14** Soft delete allowed only for terminal jobs; deleting a job never deletes its output dataset (dataset-service retention owns that); lineage edges are permanent.
- **BR-15** All list endpoints filter by workspace visibility; a job referencing a model/dataset the caller lost access to still lists, with unresolved descriptors masked as URN-only.

## 8. Dependencies

Upstream: experiment-service (model version resolution, input/output schema, stage — gRPC read + `experiment.events.v1`), dataset-service (schema/version/partition resolution, output registration, lineage API, `dataset.events.v1`), pipeline-orchestrator (run submit/terminate REST + `pipeline.events.v1` — sole status source), identity/rbac (JWT, OPA), Temporal (schedules, reaper, finalizing retries), notification-service (failure/auto-pause notices), tool-plane (MCP facade + proposals). Downstream: case-service (`inference.job.succeeded` → triage), chart-service, usage-service (inference-minutes), audit-service, realtime-hub (SSE job progress). Infra: Postgres, Kafka + Schema Registry, Redis, Temporal; no direct Argo/K8s access (always via pipeline-orchestrator).

## 9. NFRs (deltas from master)

- Compatibility validation p95 ≤ 1.5 s (includes two cross-service reads; both cached: model schema 60 s, dataset schema 30 s TTL).
- Pipeline event → job state transition p95 ≤ 2 s; job submit (validated) → orchestrator accepted p95 ≤ 2 s.
- Schedule fire jitter ≤ 30 s of the scheduled instant (Temporal SLA).
- Scale: 2,000 jobs/day/tenant; 50 enabled schedules/tenant; state transitions replay-safe at 10× event redelivery.

## 10. Acceptance criteria

- **AC-1** Given a model requiring column `merchant_id: string` and a dataset lacking it, when `POST /inferences` is called, then the job ends `rejected` with `error.code=SCHEMA_INCOMPATIBLE`, `compatibility_report` marks `merchant_id` as `missing`, and no pipeline-orchestrator run exists.
- **AC-2** Given a dataset with `age: string` vs model `age: long` plus a second missing column, when validated, then **both** violations appear in `details` (not just the first).
- **AC-3** Given a compatible dataset and a `production` model version, when submitted, then the job passes `validating → queued → submitted`, a pipeline run is created with the model ref `models:/<name>/<version>`, and `inference.job.submitted` is emitted.
- **AC-4** Given the linked pipeline run succeeds and emits `output_registered`, when finalizing completes, then the job is `succeeded`, the output dataset exists in dataset-service named `<model>-v<version>-scores` (default), lineage edges model→job, input→job, job→output@version all resolve via `GET /lineage?urn=`, and `inference.job.succeeded` carries all three URNs.
- **AC-5** Given the linked pipeline run fails mid-write, when the failure event is consumed, then the job is `failed` with the component alias and message, **no** output DatasetVersion is registered, and (append mode) the previous output version remains current.
- **AC-6** Given an `archived` model version, when submitted without `allow_unpromoted`, then 422 `MODEL_STAGE_DENIED`; with the flag but without the `submit_unpromoted` permission, then 403 `PERMISSION_DENIED`.
- **AC-7** Given a tenant cap of 2 with 2 running jobs, when a third is submitted, then it is `queued` and auto-submits when a slot frees; given 100 queued jobs, then the next submission returns 429 `BUDGET_EXHAUSTED`.
- **AC-8** Given a daily schedule with `overlap_policy=skip` whose previous job is still `running` at fire time, when the schedule fires, then no job is created and `inference.schedule.fire_skipped {reason: OVERLAP}` is emitted.
- **AC-9** Given a schedule with `stage_selector=production`, when version 3 is promoted over version 2 between fires, then the next fire scores with version 3 with no schedule edit; when no production version exists, the fire skips with `NO_MODEL_IN_STAGE`.
- **AC-10** Given 3 consecutive failed fires, when the third failure lands, then the schedule is paused with `paused_reason`, `inference.schedule.auto_paused` is emitted, and the owner is notified; `POST /schedules/:id/resume` re-enables it and resets the counter.
- **AC-11** Given a `running` job, when cancelled, then the orchestrator receives terminate, the job passes `cancelling → cancelled` on the event, and a second cancel call returns 200 idempotently; given the run actually completed first, the job ends `succeeded` per BR-6.
- **AC-12** Given duplicate delivery of `pipeline.run.succeeded` (replayed 3×), when consumed, then exactly one `finalizing` execution, one output registration, and one `inference.job.succeeded` event occur (Redis dedup + idempotent registration verified).
- **AC-13** Given tenant A's token against tenant B's job/schedule endpoints, then 404 + `security.cross_tenant_denied` for every endpoint (isolation suite green).
- **AC-14** Given an agent proposes `inference.job.submit`, then a Proposal exists carrying the compatibility report as predicted effect, no job runs before approval, and the created job records `via_agent` and the approving user.
- **AC-15** Given any call to `/api/v1/endpoints`, then 501 `NOT_IMPLEMENTED` with a stable error body (namespace reserved).

## 11. Out of scope / future

**Online serving via KServe** — later phase; reserved now: `/api/v1/endpoints` namespace (501), `serving_endpoints` table, `inference.endpoint.*` event names, URN type `wr:<t>:inference:endpoint/<id>`. Future scope: KServe `InferenceService` provisioning, scale-to-zero, canary traffic split, request logging to drift monitors. Also future: explanation artifacts (SHAP) attached to outputs (feeds case-triage copilot); cost-based scheduling windows; cross-region scoring; automatic backfill ranges for paused schedules; streaming (Kafka-in/Kafka-out) scoring.
