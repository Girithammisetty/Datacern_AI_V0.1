# BRD 10 — experiment-service

**Service:** experiment-service · **Lang/stack:** Python 3.12 / FastAPI / SQLAlchemy 2 / Alembic / Postgres / Kafka / Temporal / MLflow
**Phase:** 3 · **Status:** Approved for build · **Inherits:** `00_MASTER_BRD.md` (all MASTER-FR-\*)
**Replaces (V1):** `model-builder` (Rails wrapper over MLflow; per-request live MLflow fetches, no registry, no stage model).

---

## 1. Overview

**Purpose.** experiment-service is the platform's system of record for ML experiments, runs, registered models, and model promotion. MLflow remains the tracking backend the ML runtime writes to (every component logs params/metrics/models to MLflow — kept per architecture §7), but the platform **never reads MLflow in the request path**. Instead, experiment-service maintains an event-driven mirror: MLflow **webhooks** push run/model changes, a periodic **reconciliation sweep** repairs missed events, and all UI/agent reads are served from the service's own indexed Postgres store. The service owns the registered-model stage workflow (`none → staging → production → archived`) with a Temporal-backed human approval gate, server-side run comparison, auto-generated model cards, and a metrics/params/tags query API.

**Business value.** In V1 (model-builder), every run detail view triggered live `Mlflow::Run.find` calls, comparisons fanned out one MLflow REST call per compared run, and metrics were re-read from object storage per request; promotion was a single unaudited `register` action with no stages and no approval. The rebuild eliminates the N+1 read pattern, gives model promotion a governed lifecycle (required for agent-initiated promotions via the proposal framework), and makes experiment data queryable at platform scale.

**In scope**
- Experiments and runs mirrored from MLflow via webhooks + reconciliation (params, metrics incl. history, tags, artifacts index, dataset refs).
- Run comparison API (server-side, paginated, no MLflow fan-out).
- Registered models + versions; stage promotion workflow with approval gate (Temporal signal; proposal-framework integration for agents).
- Model cards (auto-generated, editable overlay).
- Metrics/params/tags query API with documented indexes.
- Promotion audit history (successor of V1 `RegisteredRunsLog`).

**Out of scope** (§11): pipeline execution (pipeline-orchestrator); batch/online inference (inference-service); MLflow server operation (platform infra); training-metric visualization rendering (ui-web/chart-service); drift monitoring (governance agent, Phase 6).

---

## 2. Actors & user stories

| Persona | Description |
|---|---|
| Data scientist (DS) | Creates experiments, inspects/compares runs, writes notes |
| ML engineer (MLE) | Registers models, requests promotions, manages versions |
| Reviewer / model owner | Approves or rejects stage promotions |
| Model-training agent | Reads run history for grounding; proposes registrations/promotions |
| Governance agent | Reads production model metadata; proposes retrains |
| inference-service | Resolves registered model versions + schemas at job submit |

- **US-1** As a DS, I create an experiment tied to my training pipelines and see runs appear automatically as pipeline-orchestrator executes them, with live status from events — no refresh, no polling.
- **US-2** As a DS, I open a finished run and see params, final metrics, metric time-series, tags, artifacts list, and input dataset refs — all served locally in < 300 ms even when MLflow is down.
- **US-3** As a DS, I compare up to 20 runs on selected metrics/params in one paginated call, with per-metric best-value highlighting done server-side.
- **US-4** As an MLE, I register a finished run as a model version and request promotion to `production`; a reviewer gets an approval task, and the promotion happens only on approval, with the full decision trail auditable.
- **US-5** As a reviewer, I see promotion requests in my approval inbox with the model card, delta vs current production version, and the requester's rationale; I can approve, reject with a message, or edit the target stage.
- **US-6** As a model-training agent, I query "best run by `f1_score` in experiment X in the last 30 days" via an MCP read tool, and propose registering it; my proposal enters the same approval flow, attributed `actor=user via agent`.
- **US-7** As an inference-service developer, I fetch a registered model version's artifact URI, flavor, and input schema in one call to validate an inference job.
- **US-8** As an MLE, I archive a production model version and the previous production version's history remains intact and queryable.
- **US-9** As a DS, I read an auto-generated model card (training data refs, algorithm, params, metrics, lineage, owner, promotion history) and add a free-text evaluation summary.
- **US-10** As a platform operator, I trigger a reconciliation sweep after an MLflow outage and see mirror lag return to zero with drift metrics reported.

---

## 3. Functional requirements

### Experiments & runs (mirror)
- **EXP-FR-001 (M)** Experiment CRUD: `name` (unique per workspace among non-archived), `description`, `model_type` ∈ {`anomaly_detection`, `classification`, `regression`, `forecasting`, `unsupervised`, `clustering`}, pipeline refs `{model_pipeline_urn, feature_engineering_pipeline_urn, training_pipeline_urn}` (all present and mutually distinct — V1 `PipelineInfoValidator` rule kept), `note`, tags. Creating an experiment creates the MLflow experiment (`mlflow_experiment_id` stored, unique) via one synchronous MLflow call — the only permitted synchronous MLflow write path besides run creation forwarding.
- **EXP-FR-002 (M)** Soft archive/restore of experiments (`deleted_at`), mirrored to MLflow as tag `archived`; restore de-duplicates name with `Copy of` prefix when taken.
- **EXP-FR-003 (M)** Runs are created by consuming `pipeline.events.v1: pipeline.run.submitted` (carries `mlflow_run_id`) — the service inserts the run row in `status=scheduled` linked to the experiment; **run status transitions come from pipeline events**, not MLflow: `pipeline.run.started → running`, `succeeded → finished`, `failed → failed`, `cancelled → killed`.
- **EXP-FR-004 (M)** Run status enum (MLflow-aligned, V1 mapping kept): `scheduled=0, running=1, finished=2, failed=3, killed=4`; UI labels `Pending / Processing / Ready / Failed / Failed`.
- **EXP-FR-005 (M)** Run row mirrors: `name`, `algorithm`, `params` (k/v), `metrics` (latest value + step/timestamp history), `tags`, `artifact_uri`, `artifacts_index` (paths + sizes), `input_dataset_urns[]`, `error_messages`, `duration`. Display filtering: the V1 hidden-param sets are kept as a serving-layer config (`HIDDEN_PARAMS` incl. `kubeflow_run_id, classes, flavor, argo_workflow_name, return_types, include_features, predict_proba, search_strategy, n_workers, n_iter, n_folds, cross_validation, average`; hidden prefixes `table_name, model_dataset., set-model-params., write-to-warehouse.`; hidden suffixes `.input_dataset, .output_dataset, .is_retry, .table_name_prefix_uuid, .view_name_prefix_uuid, .view_name_prefix`) — hidden from default responses, returned with `?include_hidden=true`.
- **EXP-FR-006 (M)** One note per run (free text, CRUD); run update limited to `name`, `note`, tags. Runs are never hard-deleted while their experiment exists; run delete soft-deletes and tombstones the MLflow run.

### MLflow webhook mirror (NO polling)
- **EXP-FR-010 (M)** The service registers MLflow **webhooks** at deploy time for entities the pipeline events don't carry: `run.updated` (param/metric/tag logged), `model_version.created`, `model_version.tag.set`, `registered_model.created`. Webhook endpoint `POST /internal/mlflow/webhook` (mTLS + shared HMAC signature header verified; replay-window 5 min; body ≤ 256 KB).
- **EXP-FR-011 (M)** Webhook handling is ingest-only: payload → `mirror_inbox` table (dedup on MLflow-provided delivery id) → async worker applies to mirror tables → outbox event. Handler responds 204 in < 100 ms; application is idempotent (upsert keyed by `mlflow_run_id` + field).
- **EXP-FR-012 (M)** Metric mirroring: latest value per key upserted into `run_metrics`; full step history appended into `run_metric_history` (partitioned monthly). Params are write-once (a changed value for a logged param is recorded and flagged `param_conflict` — MLflow semantics preserved). Tags upsert; oversized tag values (> 5000 chars, V1 chunking) are stored whole in the mirror.
- **EXP-FR-013 (M)** **Reconciliation sweep** (spelled out): a Temporal cron workflow every 15 min per tenant lists MLflow runs changed since the stored `last_reconciled_at` watermark (`GET /api/2.0/mlflow/runs/search` filtered on `attributes.end_time`/last_update ranges, paginated `max_results=1000`), diffs against the mirror, and repairs: missing runs inserted, stale metrics/params/tags upserted, mirror rows whose MLflow source is deleted are tombstoned. Sweep emits `experiment.mirror.reconciled {repaired_count, drift_count}` and exposes gauges `mlflow_mirror_lag_seconds`, `mlflow_mirror_drift_total`. A manual `POST /internal/reconcile` (admin) triggers an immediate full sweep. The sweep is a safety net, not a source of truth — steady-state repair rate must be ~0 (alert if `drift_count > 0` for 3 consecutive sweeps).
- **EXP-FR-014 (M)** Read endpoints never call MLflow synchronously. Artifact **content** (e.g., metric-chart JSONs `confusion_matrix`, `roc_curve`, `decision_tree` — V1 catalog kept) is served via short-lived signed object-storage URLs generated from the mirrored `artifact_uri`; the artifacts index is mirrored, the bytes are not.

### Run comparison
- **EXP-FR-020 (M)** `POST /runs/compare` with `{run_ids[] (2..20), metrics[]?, params[]?, include_all?}` → server-side comparison matrix from mirror tables in a single query set (no per-run fan-out): per metric `{run_id → value}` + `best_run_id` (direction from metric metadata, default max; loss-like keys min via configurable prefix list), per param `{run_id → value}` + `differs: bool`. Paginated over metric/param keys (cursor, default 50 keys/page). Cross-experiment comparison allowed within one workspace.
- **EXP-FR-021 (S)** `GET /runs/:id/metric-history?keys=` returns paginated time-series for charting (indexed by `(run_id, key, step)`).

### Registered models & promotion
- **EXP-FR-030 (M)** Registered models are first-class (V2 addition; V1 had only `experiment.registered_run_id`): `RegisteredModel {name unique per workspace, model_type, description, owner}` with `ModelVersion {version int seq, source_run_id, mlflow_model_ref, flavor, input_schema JSONB, output_schema JSONB, stage, created_by}`.
- **EXP-FR-031 (M)** `POST /experiments/:id/runs/:run_id/register {model_name, …}` — guard: run must be `finished` (422 `RUN_NOT_FINISHED`, V1 rule kept). Creates the model on first use, appends the next version at stage `none`, snapshots the run (immutably) into `model_registration_log` (successor of V1 `RegisteredRunsLog`), captures input/output schema from the run's logged model signature, and emits `experiment.model_version.created`.
- **EXP-FR-032 (M)** Stage state machine per version: `none → staging → production → archived`, plus `staging → archived`, `production → archived`, `archived → staging` (reinstate via new approval). Guards in §4.5. At most **one `production` version per model**; promoting version N to production auto-transitions the incumbent to `archived` in the same transaction (both recorded in the audit trail).
- **EXP-FR-033 (M)** Promotion is a **Temporal workflow with an approval gate**: `POST /models/:id/versions/:v/promote {target_stage, rationale}` → 202 `{operation_id, promotion_id}`; workflow validates guards, creates an approval task (approval inbox via notification-service; approvers = model owner + role `model_approver`), and durably `awaits signal` (`approve | reject{message} | edit{target_stage}`). Timeout 14 days → `expired`. On approve: stage transition + events; on reject: no change, reason stored. Every decision records `{actor, decided_at, decision, message?, edit_diff?}` (EU AI Act oversight evidence per master §8.5).
- **EXP-FR-034 (M)** Agent-initiated promotions/registrations arrive as **proposals** (tool tier `write-proposal`): the MCP tools `experiment.model.register` and `experiment.model.promote` create a Proposal whose approval *is* the Temporal signal — one human decision serves both frameworks; dual attribution per MASTER-FR-041. Promotion to `production` can **never** auto-execute regardless of tenant policy.
- **EXP-FR-035 (M)** `GET /models/:id/versions/:v/promotions` returns the promotion history (paginated); `GET /models` supports `filter[stage]=production` to list current production versions.
- **EXP-FR-036 (S)** Demotion (`production → archived` without replacement) follows the same approval workflow with `target_stage=archived`.

### Model cards
- **EXP-FR-040 (M)** Every model version has an auto-generated model card assembled at registration and refreshed on promotion: **auto fields** — model name/version/stage, algorithm, `model_type`, owner, created/promoted timestamps, source run URN + experiment, training pipeline URN + template version, input dataset URNs (with dataset-service names resolved asynchronously and cached), params (visible set), final metrics, metric-chart artifact links, input/output schema, promotion history, `via_agent` attribution if any. **Editable overlay** — `intended_use`, `limitations`, `evaluation_summary`, `ethical_considerations` (markdown, versioned edits). `GET /models/:id/versions/:v/card` returns merged card; export `?format=markdown`.

### Query API
- **EXP-FR-050 (M)** `GET /runs?filter[experiment_id]=&filter[status]=&filter[algorithm]=&metric[f1_score][gte]=0.9&param[max_depth]=6&filter[tag]=k:v&sort=-metric.f1_score&sort=-created_at` — indexed metric/param/tag predicates (§4 indexes); at most 3 metric predicates and 3 param predicates per query (422 beyond); cursor-paginated per master.
- **EXP-FR-051 (M)** `GET /experiments/:id/runs/best?metric=f1_score&direction=max&status=finished` returns the single best run (index-served).
- **EXP-FR-052 (M)** MCP facade read tools: `experiment.runs.search`, `experiment.runs.compare`, `experiment.models.get`, `experiment.model_card.get` — same filters, same RLS.

## 4. Domain model & data

### 4.1 Tables (all: `id UUIDv7, tenant_id, created_at, updated_at`; RLS per master)

**experiments** — `workspace_id`, `name`, `description`, `model_type SMALLINT`, `mlflow_experiment_id TEXT UNIQUE NOT NULL`, `model_pipeline_urn`, `feature_engineering_pipeline_urn`, `training_pipeline_urn`, `note TEXT`, `created_by`, `deleted_at`. Unique partial `(tenant_id, workspace_id, name) WHERE deleted_at IS NULL`.

**runs** — `experiment_id FK`, `mlflow_run_id TEXT UNIQUE NOT NULL`, `pipeline_run_urn`, `name`, `status SMALLINT NOT NULL`, `algorithm TEXT DEFAULT ''`, `artifact_uri TEXT`, `input_dataset_urns TEXT[]`, `error_messages JSONB`, `started_at/ended_at`, `created_by`, `deleted_at`. Indexes: `(tenant_id, experiment_id, created_at DESC)`, `(tenant_id, status)`, `(mlflow_run_id)`, `(algorithm)`.

**run_params** — `run_id FK`, `key TEXT`, `value TEXT`, `is_hidden BOOL`, `param_conflict BOOL DEFAULT false`. PK `(run_id, key)`. Index `(tenant_id, key, value)`.

**run_metrics** (latest) — `run_id FK`, `key TEXT`, `value DOUBLE PRECISION`, `step BIGINT`, `logged_at`. PK `(run_id, key)`. Index `(tenant_id, key, value DESC)` — serves metric filters/sorts and `best`.

**run_metric_history** — `run_id`, `key`, `step`, `value`, `logged_at`. Partitioned monthly; retention 12 months hot then Iceberg. Index `(run_id, key, step)`.

**run_tags** — `run_id`, `key`, `value TEXT`. PK `(run_id, key)`; index `(tenant_id, key, value)`. **run_notes** — `run_id UNIQUE`, `description TEXT NOT NULL`.

**run_artifacts** — `run_id`, `path TEXT`, `size_bytes`, `content_type`. PK `(run_id, path)`.

**registered_models** — `workspace_id`, `name`, `model_type SMALLINT`, `description`, `owner_id UUID`, `deleted_at`. Unique partial `(tenant_id, workspace_id, name) WHERE deleted_at IS NULL`.

**model_versions** — `model_id FK`, `version INT`, `source_run_id FK runs`, `mlflow_model_ref TEXT`, `flavor TEXT DEFAULT 'mlflow.sklearn'`, `input_schema JSONB`, `output_schema JSONB`, `stage SMALLINT NOT NULL DEFAULT 0`, `stage_updated_at`, `created_by`. Unique `(model_id, version)`; partial unique `(model_id) WHERE stage = 2` (single production); index `(tenant_id, stage)`.

**promotions** — `model_version_id FK`, `target_stage SMALLINT`, `from_stage SMALLINT`, `status SMALLINT` (`pending=0, approved=1, rejected=2, expired=3, cancelled=4`), `rationale TEXT`, `requested_by`, `via_agent JSONB NULL`, `temporal_workflow_id TEXT`, `decision JSONB` (`{actor, decided_at, message?, edit_diff?}`), `decided_at`. Index `(tenant_id, status, created_at DESC)`.

**model_registration_log** — `model_version_id`, `experiment_id`, `run_snapshot JSONB` (immutable full run serialization), `registered_by`, `via_agent JSONB NULL`. Append-only; retention permanent.

**model_cards** — `model_version_id UNIQUE`, `auto_fields JSONB`, `overlay JSONB`, `overlay_updated_by`, `overlay_version INT`.

**mirror_inbox** — `delivery_id TEXT UNIQUE`, `event_type`, `payload JSONB`, `received_at`, `applied_at NULL`, `error NULL`. Retention 7 days. **reconciliation_watermarks** — `tenant_id`, `mlflow_experiment_id`, `last_reconciled_at`. **outbox** — per MASTER-FR-034.

### 4.2 Enums
`run.status`: scheduled=0, running=1, finished=2, failed=3, killed=4. `model_version.stage`: none=0, staging=1, production=2, archived=3. `model_type`: as pipeline-orchestrator §4.2.

### 4.3 Retention
`run_metric_history` 12 mo hot → Iceberg; `mirror_inbox` 7 d; `promotions`, `model_registration_log` permanent (governance); soft-deleted runs purged after 24 mo.

### 4.4 JSONB justifications (MASTER-FR-061)
`run_snapshot` (immutable audit blob ≤ 64 KB), `input_schema/output_schema` (MLflow signature, schemaless, ≤ 16 KB), `auto_fields/overlay` (card doc), `decision`, `error_messages`, `mirror_inbox.payload`. None used for relational queries beyond GIN-indexed tag lookups.

### 4.5 Stage state machine
```
none ──promote(approval)──▶ staging ──promote(approval)──▶ production
  │                            │  ▲                            │
  └──archive(approval)──▶ archived ◀──archive/auto-demote──────┘
guards: promote requires source run status=finished AND model_version not soft-deleted;
production promote auto-archives incumbent atomically; archived→staging = reinstate (approval);
no transition while another promotion for the same version is pending (409 CONFLICT).
```

## 5. API specification (`/api/v1`; representative)

| Method & path | Purpose | Errors |
|---|---|---|
| POST/GET `/experiments` · GET/PATCH/DELETE `/experiments/:id` | CRUD (soft delete) | 409 name, 404 |
| PATCH `/experiments/:id/restore` · GET `/experiments/list_archived` | Restore / archived list | 404 |
| GET `/experiments/:id/runs` · GET `/runs/:id` | List / detail (`?include_hidden=`) | 404 |
| PATCH `/runs/:id` · DELETE `/runs/:id` | Update name/note/tags / soft delete | 404 |
| POST/GET/PATCH/DELETE `/runs/:id/note` | Run note | 404 |
| GET `/runs` | Cross-experiment search (metric/param/tag filters) | 422 too many predicates |
| POST `/runs/compare` | Comparison matrix | 422 <2 or >20 runs |
| GET `/runs/:id/metric-history?keys=` | Time series | 404 |
| GET `/runs/:id/artifacts` · GET `/runs/:id/artifacts/url?path=` | Index / signed URL | 404 |
| POST `/experiments/:id/runs/:run_id/register` | Create model version (stage none) | 422 RUN_NOT_FINISHED |
| GET `/models` · GET `/models/:id` · GET `/models/:id/versions/:v` | Registry reads (`filter[stage]`) | 404 |
| POST `/models/:id/versions/:v/promote` | Start promotion workflow → 202 | 409 pending, 422 guard |
| POST `/promotions/:id/decision` | Approve/reject/edit (signal) | 403, 409 decided |
| GET `/models/:id/versions/:v/promotions` | Promotion history | 404 |
| GET `/models/:id/versions/:v/card` (`?format=markdown`) · PATCH `.../card` | Model card read / overlay edit | 404 |
| GET `/experiments/:id/runs/best?metric=&direction=` | Best run | 404, 422 unknown metric |
| POST `/internal/mlflow/webhook` | Webhook ingest (HMAC) | 401 bad signature |
| POST `/internal/reconcile` | Manual sweep (admin) | 403 |

Compare response example:
```json
POST /api/v1/runs/compare  {"run_ids": ["run_A", "run_B"], "metrics": ["f1_score", "rmse"]}
→ 200 {"data": {"runs": ["run_A","run_B"],
  "metrics": [{"key":"f1_score","values":{"run_A":0.91,"run_B":0.87},"best_run_id":"run_A","direction":"max"}],
  "params":  [{"key":"max_depth","values":{"run_A":"6","run_B":"8"},"differs":true}]},
 "page": {"next_cursor":"...","has_more":true}}
```

Promotion request / decision example:
```json
POST /api/v1/models/mdl_01J.../versions/2/promote
{"target_stage": "production", "rationale": "beats v1 f1 by 4pts on holdout"}
→ 202 {"operation_id": "op_01J...", "data": {"promotion_id": "prm_01J...", "status": "pending"}}

POST /api/v1/promotions/prm_01J.../decision
{"decision": "approve"}            // or {"decision": "reject", "message": "..."}
→ 200 {"data": {"promotion_id": "prm_01J...", "status": "approved",
       "decision": {"actor": "user:u-77", "decided_at": "2026-07-09T14:02:11Z"}}}
```

Webhook ingest (MLflow → service): headers `X-MLflow-Signature: hmac-sha256=<sig>`, `X-MLflow-Delivery-Id: <uuid>`; body `{"event": "run.updated", "run_id": "...", "experiment_id": "...", "data": {"metrics": [{"key": "f1_score", "value": 0.91, "step": 10, "timestamp": 1783000000}]}}` → 204.

## 6. Events (`experiment.events.v1`)

### Emitted

| Event type | Payload fields |
|---|---|
| `experiment.created` / `updated` / `archived` / `restored` | `experiment_id, name, model_type, workspace_id` |
| `run.mirrored` | `run_id, mlflow_run_id, experiment_id` |
| `run.status_changed` | `run_id, status, previous_status` |
| `run.metrics_updated` | `run_id, keys[]` (coalesced ≤ 1 event/run/10 s) |
| `model.created` | `model_id, name, model_type` |
| `model_version.created` | `model_id, version, source_run_id, stage` |
| `model_version.promotion_requested` | `promotion_id, model_id, version, target_stage, requested_by, via_agent?` |
| `model_version.promoted` | `model_id, version, from_stage, to_stage, promotion_id, decision_actor` |
| `model_version.promotion_rejected` / `promotion_expired` | `promotion_id, model_id, version, reason?` |
| `model_version.archived` | `model_id, version, cause` (`manual` \| `superseded`) |
| `model_card.updated` | `model_version_id, overlay_version` |
| `experiment.mirror.reconciled` | `tenant_id, repaired_count, drift_count, swept_experiments` |

### Consumed

| Topic / event | Handler behavior |
|---|---|
| `pipeline.events.v1: pipeline.run.submitted` | Insert run row (`scheduled`) linked by `mlflow_run_id`; emit `run.mirrored` |
| `pipeline.events.v1: pipeline.run.started/succeeded/failed/cancelled` | Transition run status (running/finished/failed/killed); copy duration + error; refresh model-card auto fields for registered runs |
| `pipeline.events.v1: pipeline.run.output_registered` | Append dataset URN to the run's `input/output` refs as applicable |
| `dataset.events.v1: dataset.deleted` | Flag model cards referencing the dataset (`training_data_unavailable=true`) |
| `identity.events.v1: tenant.provisioned` | Register MLflow webhooks for the tenant's tracking scope; create watermark row |

All handlers are idempotent and replay-safe per MASTER-FR-032; poison messages follow the DLQ policy of MASTER-FR-033.

## 7. Business rules & edge cases

- **BR-1** The mirror is authoritative for reads; MLflow is authoritative for writes from components. Conflict resolution: newest `logged_at` wins for metrics/tags; params are write-once with `param_conflict` flagging (never silently overwritten).
- **BR-2** A webhook arriving before the run row exists (race with `pipeline.run.submitted`) parks in `mirror_inbox` and is retried for 10 min before DLQ — never dropped, never creates an orphan run.
- **BR-3** Registration requires `status=finished`; `killed`/`failed` runs are never registrable (422). A run soft-deleted after registration keeps its `model_registration_log` snapshot intact.
- **BR-4** Exactly one pending promotion per model version (409 `CONFLICT`); concurrent promotions of *different* versions of the same model to `production` are serialized by the workflow taking a per-model Temporal mutex — the second waits, then re-validates guards.
- **BR-5** Approving a `production` promotion atomically archives the incumbent; the emitted `model_version.promoted` and `model_version.archived` share one `trace_id`.
- **BR-6** Approver ≠ requester (four-eyes): the requesting principal (or the OBO user of a requesting agent) cannot approve their own promotion (403 `SELF_APPROVAL_FORBIDDEN`).
- **BR-7** Promotion `expired` after 14 days without decision; requester notified; re-request allowed.
- **BR-8** MLflow outage: reads unaffected (mirror); webhook gap repaired by the next sweep; experiment creation degrades to 503 `DEPENDENCY_UNAVAILABLE` (MLflow experiment id is mandatory).
- **BR-9** Comparison rejects duplicate run ids, requires ≥ 2 distinct runs (V1 rule), caps at 20; all runs must be workspace-visible to the caller — any non-visible run makes the whole request 404.
- **BR-10** Metric direction: `best_run_id` uses `max` unless the key matches the loss-prefix config (`loss, rmse, mae, mse, error`, tenant-extendable) → `min`.
- **BR-11** Hidden params/tags are display filtering only — always stored, always exported in audit and `?include_hidden=true` responses.
- **BR-12** Model name collision on register with an existing model of a different `model_type` → 422 `MODEL_TYPE_MISMATCH` (no silent version append across types).
- **BR-13** Right-to-erasure: purging a user leaves runs/promotions intact with `created_by` pseudonymized (governance records are retained per MASTER-FR-042).
- **BR-14** Reconciliation sweep must be rate-limited against MLflow (max 5 rps per tenant) and abort-safe (watermark advances only after a page fully applies).

## 8. Dependencies

Upstream: pipeline-orchestrator (`pipeline.events.v1` — run lifecycle source), MLflow tracking server (webhooks in; REST out for experiment/run create + reconciliation), dataset-service (name resolution for cards; `dataset.deleted`), identity/rbac (JWT, OPA), notification-service (approval tasks), Temporal (promotion + sweep workflows), tool-plane (MCP facade, proposal integration). Downstream: inference-service (model version resolution + schemas), governance agent, ui-web (approval inbox), usage-service, audit-service. Infra: Postgres, Kafka + Schema Registry, Redis, object storage (signed artifact URLs), Temporal.

## 9. NFRs (deltas from master)

- Run detail read p95 ≤ 200 ms; compare (20 runs × 50 keys) p95 ≤ 500 ms — both with zero MLflow calls (CI contract test asserts no MLflow client usage in read handlers).
- Webhook ingest→mirror-applied p95 ≤ 5 s; mirror lag alert at > 60 s for 5 min.
- Reconciliation sweep completes ≤ 5 min per tenant at 100K runs; drift steady-state = 0.
- Scale: 1M runs, 50M metric points per tenant hot; metric-history queries index-only.

## 10. Acceptance criteria

- **AC-1** Given pipeline-orchestrator emits `pipeline.run.submitted` with an `mlflow_run_id`, when the event is consumed, then a run row exists in `scheduled` linked to the right experiment, and `run.mirrored` is emitted within 5 s.
- **AC-2** Given a component logs metric `f1_score=0.91` to MLflow, when the webhook is delivered, then `GET /runs/:id` reflects the metric within 5 s p95, with zero MLflow API calls in the read trace.
- **AC-3** Given 20 webhook deliveries are dropped during an MLflow outage, when the next reconciliation sweep runs, then all 20 changes appear in the mirror, `experiment.mirror.reconciled` reports `repaired_count=20`, and re-running the sweep reports 0.
- **AC-4** Given the same webhook delivery id is received twice, when both are processed, then the mirror is unchanged by the second and no duplicate outbox event exists.
- **AC-5** Given runs A and B with metrics/params, when `POST /runs/compare {run_ids:[A,B]}` is called, then one response contains the matrix with `best_run_id` computed with `max` for `f1_score` and `min` for `rmse`, and the DB trace shows no per-run loops (≤ 4 queries).
- **AC-6** Given a `finished` run, when registered to a new model name, then version 1 exists at stage `none`, a `model_registration_log` snapshot exists, the model card auto-fields are populated (algorithm, dataset URNs, metrics), and `model_version.created` is emitted. Given a `failed` run, then 422 `RUN_NOT_FINISHED`.
- **AC-7** Given a promotion of version 2 to `production` while version 1 is production, when the reviewer approves, then version 2 is `production`, version 1 is `archived` in the same transaction, both events share a `trace_id`, and the decision record holds the approver id and timestamp.
- **AC-8** Given a pending promotion, when the requester calls the decision endpoint, then 403 `SELF_APPROVAL_FORBIDDEN`; when a second promotion is requested for the same version, then 409 `CONFLICT`.
- **AC-9** Given an agent (`typ=agent_obo`) invokes `experiment.model.promote`, then a Proposal is created (never auto-executed for target `production`), the promotion record has `via_agent` populated, and approval by the OBO user is rejected per AC-8's four-eyes rule.
- **AC-10** Given a promotion pending for 14 days, when the timer fires, then status is `expired`, `model_version.promotion_rejected|expired` is emitted, and the stage is unchanged.
- **AC-11** Given `GET /runs?metric[f1_score][gte]=0.9&sort=-metric.f1_score`, then results are correct, cursor-paginated, and `EXPLAIN` shows index usage on `run_metrics (tenant_id, key, value DESC)`.
- **AC-12** Given tenant A's token against tenant B's experiment/run/model/promotion endpoints, then every endpoint returns 404 and emits `security.cross_tenant_denied` (isolation suite green).
- **AC-13** Given MLflow is fully down, when a user opens run detail, compare, and model card pages, then all return 200 from the mirror; only experiment creation returns 503.
- **AC-14** Given a model card, when the overlay `limitations` is edited, then `overlay_version` increments, the auto fields are untouched, and `?format=markdown` renders both merged.

## 11. Out of scope / future

Online model serving metadata (inference-service/KServe, later phase). Drift detection and retrain triggers (governance agent, Phase 6 — this service only serves the data). Champion/challenger auto-evaluation gates on promotion (future: eval-service integration). Cross-workspace model sharing. MLflow UI passthrough. Hyperparameter-search visualization beyond metric history. Fine-grained per-metric ACLs.
