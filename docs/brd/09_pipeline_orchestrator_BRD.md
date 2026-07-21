# BRD 09 — pipeline-orchestrator

**Service:** pipeline-orchestrator · **Lang/stack:** Python 3.12 / FastAPI / SQLAlchemy 2 / Alembic / Postgres / Kafka / Argo Workflows
**Phase:** 3 · **Status:** Approved for build · **Inherits:** `00_MASTER_BRD.md` (all MASTER-FR-\*)
**Replaces (V1):** `pipeline-manager` (Flask, system of record) + `pipeline-service` (Argo compiler/proxy) — consolidated into ONE service.

---

## 1. Overview

**Purpose.** pipeline-orchestrator owns the definition, validation, compilation, and execution lifecycle of ML pipelines. A pipeline is a typed, directed acyclic graph (DAG) of containerized components (the ML-runtime component contract, §7 of the architecture doc, is KEPT). The service compiles validated DAGs into Argo `WorkflowTemplate`s, submits runs to Argo in per-tenant namespaces, watches run status via **Argo informers (Kubernetes watch API)** — never polling — and publishes lifecycle events to Kafka. It also serves the **component registry** (from `component.json` metadata) and the **declarative algorithm templates** (train / tune / cross-validation variants) as first-class objects consumed by the UI pipeline editor and the model-training agent.

**Business value.** Pipelines are the core production asset of the platform: every trained model, every batch inference, and every scheduled scoring job flows through this service. V1 split this responsibility across two services with an unsigned-JWT internal hop, Redis-queue async compilation, and a completion model driven by an in-cluster `notify` sidecar component POSTing callbacks. The rebuild removes the split, removes callbacks/polling, and makes run state event-sourced and observable.

**In scope**
- Pipeline template CRUD with immutable versioning (component DAG as typed JSON).
- DAG validation: acyclicity, alias rules, type-compatible edges, input/output arity, parameter validation against component schemas, resource-limit enforcement, terminal-node rules per pipeline type.
- Compilation of a template version to an Argo `WorkflowTemplate` (deterministic, idempotent).
- Run lifecycle: submit, watch (informer → Kafka), terminate, per-step retry policy.
- Component registry: catalog of `component.json` metadata served to the UI and to agents (via MCP facade).
- Algorithm templates: the 21 per-algorithm declarative JSON templates (train / tune / cross-validation variants) as governed catalog objects.
- Per-tenant run quotas and node-pool routing.
- Artifact-passing conventions (object storage paths; Iceberg tables for tabular step IO).

**Out of scope** (see §11): scheduled/recurring runs (owned by inference-service for scoring and by ingestion-service for data jobs, both via Temporal); MLflow mirroring (experiment-service); online serving; component image build/publish (CI owns it); notebook execution.

---

## 2. Actors & user stories

| Persona | Description |
|---|---|
| Data scientist (DS) | Builds data-prep/feature-engineering/training pipelines in the visual editor |
| ML engineer (MLE) | Operates runs, tunes resources, debugs failures |
| Model-training agent | Proposes filled-in algorithm templates via MCP tools (write-proposal tier) |
| Inference-service / other services | Submit inference/profiling runs service-to-service |
| Platform admin | Manages quotas, node pools, component catalog |

- **US-1** As a DS, I compose a pipeline from catalog components in the UI, get inline validation errors (per node, per parameter), and save drafts even when invalid, so I can iterate.
- **US-2** As a DS, I run a pipeline and watch live per-component status stream into the UI (via realtime-hub) without refreshing.
- **US-3** As an MLE, I edit a pipeline and get a new immutable version; earlier versions remain runnable and restorable so past runs stay reproducible.
- **US-4** As an MLE, I terminate a stuck run and get a terminal `cancelled` state within seconds, with pod-level failure detail (timeout, OOM) surfaced in plain language.
- **US-5** As a model-training agent, I list algorithm templates, fill in the xgboost tune variant with parameters and dataset refs, and submit it as a *proposal*; on human approval the run is created attributed to me + the approving user.
- **US-6** As a platform admin, I set a tenant's max concurrent runs and per-component resource ceilings, and see submissions beyond quota queue or reject deterministically.
- **US-7** As an inference-service developer, I submit a compiled inference pipeline run via gRPC/REST and consume `pipeline.run.*` events instead of polling.
- **US-8** As a DS, I clone a pipeline into another workspace-visible copy, and archive/restore pipelines without breaking run history.
- **US-9** As an MLE, I inspect any run's exact compiled Argo manifest and effective parameters for debugging and audit.
- **US-10** As a UI developer, I fetch the component catalog (grouped, with parameter schemas, UI hints, arity) in one call to render the editor palette.

---

## 3. Functional requirements

### Templates & versioning
- **PIPE-FR-001 (M)** CRUD for pipeline templates. A template has `name` (unique per workspace among non-archived), `pipeline_type` ∈ {`data_prep`, `feature_engineering`, `model`, `training`, `inference`, `profiling`, `scheduled`}, optional `model_type` ∈ {`anomaly_detection`, `classification`, `regression`, `forecasting`, `unsupervised`, `clustering`}, and a `definition` (typed DAG JSON, §4.3).
- **PIPE-FR-002 (M)** Every mutation of `definition`, `run_parameters`, or `name` creates a new immutable `template_version` (UUIDv7). Exactly one version per template is `active`. `POST .../versions/:version_id/activate` re-activates a prior version. Runs reference (template_id, version_id) forever.
- **PIPE-FR-003 (M)** Invalid definitions are savable as `draft` with the full `validation_report` persisted; drafts cannot be compiled or run.
- **PIPE-FR-004 (M)** Soft archive/restore (`deleted_at`); archived templates excluded from default lists; system-owned (profiling) templates cannot be archived (409 `CONFLICT`).
- **PIPE-FR-005 (S)** Clone endpoint producing a new template (new id, version 1, name `Copy of <name>` de-duplicated).

### Validation
- **PIPE-FR-010 (M)** Structural validation: non-empty DAG; node aliases match `^[A-Za-z0-9]+([-._ ]+[A-Za-z0-9]+)*$` and are unique; graph is acyclic (reject on any simple cycle, reporting the cycle's aliases); no dangling edge references; every non-terminal output consumed or explicitly marked unused.
- **PIPE-FR-011 (M)** **Type-compatible edges**: every edge carries the producer's declared output port type and must match the consumer's input port type (port types: `dataframe`, `model`, `metrics`, `json`, `dataset_ref`). Mismatch → `VALIDATION_FAILED` with both types named. (V1 inferred edges by output-name string matching; V2 edges are explicit and typed — see §4.3.)
- **PIPE-FR-012 (M)** Arity validation: per component, `min_inputs ≤ |inputs| ≤ max_inputs` and `|outputs| ≤ max_outputs`, from the component registry entry.
- **PIPE-FR-013 (M)** Terminal-node rules by pipeline type (mined from V1 `PipelineValidator`): every runnable pipeline except `model` and `scheduled` types must contain a read component (`read-from-warehouse`); `data_prep`/`inference` terminals must be `write-to-warehouse` (or comment nodes); `feature_engineering` terminals ⊆ {`write-to-warehouse`, `model-input`, comment}; `scheduled` must contain `batch-read-from-warehouse` and terminate in `batch-write-to-warehouse`; no two write components may share an `output_dataset_name`; `model` and `feature_engineering` templates are composable building blocks and are **not directly runnable** (422 `CANNOT_RUN_PIPELINE_TYPE`).
- **PIPE-FR-014 (M)** Parameter validation against the component's `component.json` schema: unknown params rejected; required params must be present at save time or declared as run-time parameters; type checks for `boolean|int|number|string|restricted_string|text|dictionary|array|autocomplete|dataset_column|anomaly_metric`; numeric `minimum/maximum`; string `enum`/`min_length`/`max_length`; `restricted_string` matches `^[a-zA-Z0-9_\s]*$`; arrays honor `min_items/max_items/unique_items/item_description`; params listed in a component's `hide_for` for the template's `model_type` are skipped; `global_attribute: true` params are hoisted to pipeline-level run parameters (e.g., `label_column`, `index_columns`).
- **PIPE-FR-015 (M)** Model-input typing: training/tuning pipelines must wire exactly one `model-input` per required role; required roles come from the algorithm template's `input_type` (`training: [TRAIN]`, `tuning: [TRAIN, VALIDATION]`, `tuning_cross_validation: [TRAIN]`).
- **PIPE-FR-016 (M)** Resource validation per node: `cpus`, `ram_gb`, `timeout_minutes` within tenant limits (defaults `{1, 2, 30}`; floor `{1, 2, 5}`; ceilings from tenant quota config, platform default max `{7, 24, 480}`). Nodes without resources inherit the max of their predecessors' resources (topological order), falling back to defaults.
- **PIPE-FR-017 (M)** `POST /pipelines/validate` runs validation without persisting; modes `structure_only` (default), `provided_parameters`, `all`. Returns the full `validation_report`; HTTP 200 when clean, 422 with report otherwise.

### Compilation
- **PIPE-FR-020 (M)** Compile an active, valid template version into an Argo `WorkflowTemplate` synchronously at first-run or via explicit `POST .../compile`. Compilation is **deterministic and idempotent**: same version ⇒ byte-identical manifest; manifest stored in object storage with a pointer + SHA-256 digest on the version row.
- **PIPE-FR-021 (M)** Compilation preserves the V1 container contract: each node becomes an Argo template whose container is built from the component's `component.yaml` (`implementation.container`), with CLI args `--input-path[N] --component-parameters --resources --mlflow-run-id --output-path[N] --current-context`; env `COMPONENT_ALIAS=<alias>`; envFrom configmaps `datacern-global-variables`, `tenant-specific-variables` and secret `datacern-global-secrets`.
- **PIPE-FR-022 (M)** Compilation transforms: strip comment nodes; inject `clone-input` nodes wherever one output feeds >1 consumer (Argo duplicate-input restriction); inject the data-profiler step for non-profiling pipelines; fan-out steps (hyperparameter search, split chunks) compile to `withParam` over the producer's `chunks` output parameter with `continueOn` support.
- **PIPE-FR-023 (M)** Per-node `retryStrategy`: `limit: 3`, `retryPolicy: Always`, backoff `{duration: 5s, factor: 2}`, expression retrying only infrastructure errors: `lastRetry.status == "Error" or (lastRetry.status == "Failed" and asInt(lastRetry.exitCode) not in [0, 1])` (clean model failures are not retried). Retry policy is tenant-overridable per template within bounds `limit ≤ 5`.
- **PIPE-FR-024 (M)** Workflow hygiene: `ttlStrategy {secondsAfterSuccess: 0, secondsAfterFailure: 600}`, `podGC OnPodSuccess`, `activeDeadlineSeconds = timeout_minutes × 60` per node. QoS: requests = limits when `guaranteed_qos` or `ram_gb ≥ 15`; else requests = limits/4.
- **PIPE-FR-025 (M)** The V1 `onExit` notify-callback component is **removed**. No component may call back into the orchestrator for status (the error-report endpoint PIPE-FR-036 is the single component-facing exception).

### Run lifecycle
- **PIPE-FR-030 (M)** `POST /pipelines/:id/run` creates a run: resolves active version, merges run parameters over defaults (validate `all`), creates the MLflow run (obtains `mlflow_run_id`), applies quota check, submits to Argo in the tenant namespace, persists `argo_workflow_name`. Returns `202 {operation_id, run_id}` (MASTER-FR-027).
- **PIPE-FR-031 (M)** Run states: `pending → submitted → running → {succeeded | failed | cancelled}` plus `quota_queued` (pre-submitted) — full machine in §4.5. Argo phase mapping: `Pending→submitted`, `Running→running`, `Succeeded→succeeded`, `Failed|Error→failed` (Argo `Error` and `Failed` are both platform `failed`, per V1 behavior).
- **PIPE-FR-032 (M)** **Status via informers, never polling**: a controller deployment per cell maintains Kubernetes watch informers on Argo `Workflow` objects across tenant namespaces (label selector `datacern.io/managed=true`). Every phase or node-status change updates the run row (through the outbox) and emits `pipeline.run.status_changed`. Informer resync interval 5 min guards against missed watch events. Neither the UI nor any service polls Argo or the orchestrator's list endpoints.
- **PIPE-FR-033 (M)** Per-component status snapshot maintained on the run: for each pod node `{alias, phase, started_at, finished_at, message, exit_code, resources_requested, resources_limit, retry_count}`. Special-case error extraction (mined from V1): pod message `Pod was active on the node longer than the specified deadline` → `COMPONENT_TIMEOUT`; `OOMKilled` → `OUT_OF_MEMORY`; both rendered with the offending alias and its configured limits.
- **PIPE-FR-034 (M)** `PUT /runs/:id/terminate` → Argo terminate; run → `cancelled` when the informer confirms; idempotent (terminating a terminal run returns the run unchanged, 200).
- **PIPE-FR-035 (M)** On terminal state: set MLflow run status (`FINISHED`/`FAILED`/`KILLED`); on `failed` for non-scheduled/non-profiling runs, emit `pipeline.run.outputs_invalidated` so dataset-service can garbage-collect partial output datasets (V1 called the dataset service synchronously; V2 is event-driven).
- **PIPE-FR-036 (M)** Component error-report endpoint `POST /internal/runs/:argo_workflow_name/error` (SPIFFE mTLS, service identity only): components report structured exceptions `{title, detail, source, alias}` for UI display; stored on the run's `error` field.
- **PIPE-FR-037 (S)** `POST /runs/:id/retry` resubmits a failed run with identical version + parameters as a **new** run linked via `retried_from_run_id`.
- **PIPE-FR-038 (M)** Per-user run-submission rate limit: minimum 15 s between run creations per user (429 `RATE_LIMITED` with `Retry-After`), tenant-configurable.

### Quotas & node routing
- **PIPE-FR-040 (M)** Per-tenant run quotas: `max_concurrent_runs` (default 10), `max_concurrent_pods` (default 40), `max_run_duration_minutes` (default 480). At submission, if concurrency is exhausted the run enters `quota_queued` (FIFO per tenant, max queue depth 50, then 429 `BUDGET_EXHAUSTED`); the informer controller dequeues on completions.
- **PIPE-FR-041 (M)** Node-pool routing per cloud (mined from V1, now config-driven per cell): AWS → nodeAffinity requiring `node.group in [ml]` OR `workload in [processing]`, preferring `processing`; high-memory nodes (request ≥ 15 GB) route to the large pool; Azure → AppArmor `runtime/default` annotations on every pod; GCP → `serviceAccountName = <tenant>-<env>-wl-ksa` + nodeSelector `iam.gke.io/gke-metadata-server-enabled: "true"`. Tenant tier may pin a dedicated node pool (`datacern.io/tenant-pool` taint/toleration pair).
- **PIPE-FR-042 (M)** All workflows run in the tenant's processing namespace; the orchestrator derives the namespace from the verified tenant context — never from a request header (V1's `Tenant-Namespace` header is designed out).

### Component registry & algorithm templates
- **PIPE-FR-050 (M)** Component registry: ingest `component.json` + `component.yaml` per component at deploy time (CI publishes to object storage; the service syncs on a signed manifest change event). Serve the catalog: `GET /components` (grouped by `component_type`), `GET /components/:name` (full parameter schema + arity + container spec digest). Catalog is versioned; templates pin the catalog version they validated against.
- **PIPE-FR-051 (M)** Component types (V1 catalog kept): data-prep set {`add-guid-column, cast-data, clone-input, correlation-filter, filter-data, group-by, handle-missing-values, join-data, linear-combination, long-to-wide-converter, merge-data, minmax-scale, model-input, one-hot-encoder, ordinal-encoder, pca, python-expression, quantization, quasi-constant-filter, remove-duplicate-rows, remove-outliers, rename-columns, sample-data, select-columns, sort-data, split-data, statistical-filter, target-encoder, transform-data, union, variance-filter, wide-to-long-converter, zscore-normalization`} plus IO components and the algorithm components (§ below). `notify` is retired (PIPE-FR-025).
- **PIPE-FR-052 (M)** Algorithm templates as first-class objects: the 21 declarative templates (`agglomerative_clustering, dbscan, decision_tree, decision_tree_regressor, isolation_forest, kmeans, knn, light_gbm, linear_regression, logistic_regression, mean_shift, naive_bayes, one_class_svm, random_forest, random_forest_regressor, stats_forecast, support_vector_regression, svm, xgboost, xgboost_regressor, z_score_based_anomaly_detection`) with fields `{name, label, model_type, order, model_type_order, input_type{training, tuning, tuning_cross_validation}, pipeline, tuning_pipeline, tuning_pipeline_cross_validation, parameters, tuning_parameters, metadata}`. `GET /algorithm-templates`, `GET /algorithm-templates/:name`; `POST /algorithm-templates/:name/pipelines` instantiates a training pipeline from a filled template (variant selected by `mode ∈ {train, tune, cross_validation}`), reusing full validation. Tune/CV variants of supervised algorithms swap in the shared `hyperparameter-search` component with `parameters.algorithm=<name>`; clustering/forecasting variants reuse the native `*-train` step (V1 semantics preserved).
- **PIPE-FR-053 (M)** MCP facade exposes read tools (`pipeline.components.list`, `pipeline.templates.get`, `pipeline.runs.get`) and write-proposal tools (`pipeline.template.create_from_algorithm`, `pipeline.run.submit`) per master §2.2-015; agent-filled templates are validated identically to UI submissions.

### Artifacts
- **PIPE-FR-060 (M)** Inter-step artifact convention (object storage): key `runs/<tenant_id>/<argo_workflow_name>/<producer_alias>/<output_name>[/<chunk>]` in the cell's artifacts bucket; components resolve IO via the base-component `StorageIO` (env `CLOUD_PLATFORM` ∈ aws|azure|gcp, bucket env `ARGO_ARTIFACTS_BUCKET`). Intermediate artifacts inherit the workflow TTL (deleted with the workflow record; bucket lifecycle 7 days).
- **PIPE-FR-061 (M)** Tabular step outputs destined for reuse (write-to-warehouse) are **Iceberg table appends/creates** registered with dataset-service (event `pipeline.run.output_registered` carries `{dataset_urn, iceberg_snapshot_id}` per output), replacing V1 loose CSV/pickle files for persisted data. Pickled intermediates remain allowed between steps within a run.
- **PIPE-FR-062 (M)** `GET /runs/:id/manifest` returns the compiled Argo manifest and the fully-resolved parameter set (secrets redacted) for reproducibility/audit.

---

## 4. Domain model & data

### 4.1 Tables (all include `id UUIDv7 PK, tenant_id, created_at, updated_at`, RLS per MASTER-FR-001)

**pipeline_templates** — `workspace_id UUID NOT NULL`, `name TEXT NOT NULL`, `pipeline_type SMALLINT NOT NULL`, `model_type SMALLINT NULL`, `algorithm_template_name TEXT NULL`, `active_version_id UUID NULL`, `is_system BOOL DEFAULT false`, `created_by UUID`, `deleted_at TIMESTAMPTZ NULL`. Unique partial index `(tenant_id, workspace_id, name) WHERE deleted_at IS NULL`.

**pipeline_template_versions** — `template_id UUID FK`, `version_no INT NOT NULL`, `definition JSONB NOT NULL` (≤ 64 KB; larger → object-storage pointer per MASTER-FR-061), `validation_status SMALLINT` (`draft=0, valid=1`), `validation_report JSONB`, `run_parameters JSONB`, `global_parameters TEXT[]`, `component_catalog_version TEXT`, `compiled_manifest_ref TEXT NULL`, `manifest_digest TEXT NULL`, `argo_template_name TEXT NULL UNIQUE`, `created_by UUID`. Unique `(template_id, version_no)`. Index `(template_id, created_at DESC)`.

**pipeline_runs** — `template_id UUID`, `version_id UUID FK`, `status SMALLINT NOT NULL`, `argo_workflow_name TEXT UNIQUE NULL`, `mlflow_run_id TEXT NULL`, `run_parameters JSONB NOT NULL`, `components_status JSONB`, `error JSONB`, `input_dataset_urns TEXT[]`, `output_dataset_urns TEXT[]`, `retried_from_run_id UUID NULL`, `submitted_by UUID`, `via_agent JSONB NULL`, `queued_at/submitted_at/started_at/finished_at TIMESTAMPTZ`. Partitioned by month (MASTER-FR-062), retention 18 months then Iceberg archive. Indexes: `(tenant_id, status, created_at DESC)`, `(template_id, created_at DESC)`, `(argo_workflow_name)`.

**components** — `name TEXT UNIQUE`, `component_type SMALLINT`, `internal_component_type SMALLINT`, `label TEXT`, `definition JSONB` (params + metadata: `min_inputs, max_inputs, max_outputs, guaranteed_qos`), `yaml_ref TEXT`, `image_digest TEXT`, `catalog_version TEXT`, `enabled BOOL`. Global (not tenant-scoped) with per-tenant enablement table `tenant_components(tenant_id, component_name, enabled)`.

**algorithm_templates** — `name TEXT UNIQUE`, `label`, `model_type SMALLINT`, `order INT`, `model_type_order INT`, `input_type JSONB`, `pipeline JSONB`, `tuning_pipeline JSONB`, `tuning_pipeline_cross_validation JSONB`, `parameters JSONB`, `tuning_parameters JSONB`, `metadata JSONB`, `catalog_version TEXT`.

**tenant_quotas** — `tenant_id UNIQUE`, `max_concurrent_runs INT DEFAULT 10`, `max_concurrent_pods INT DEFAULT 40`, `max_run_duration_minutes INT DEFAULT 480`, `min_seconds_between_runs INT DEFAULT 15`, `resource_ceiling JSONB` (`{cpus, ram_gb, timeout_minutes}`), `node_pool TEXT NULL`.

**run_queue** — `run_id UUID UNIQUE`, `enqueued_at`, per-tenant FIFO for `quota_queued` runs. **outbox** — standard transactional outbox (MASTER-FR-034).

### 4.2 Enums
`pipeline_type`: data_prep=0, feature_engineering=1, model=2, training=3, inference=4, profiling=5, scheduled=6. `model_type`: anomaly_detection=0, classification=1, regression=2, forecasting=3, unsupervised=4, clustering=5. `run.status`: pending=0, quota_queued=1, submitted=2, running=3, succeeded=4, failed=5, cancelled=6.

### 4.3 Definition JSON (typed DAG)
```json
{ "metadata": {"description": "...", "global_parameters": ["label_column"]},
  "nodes": [ {"alias": "split-1", "component": "split-data",
              "parameters": {"split_size": 0.8},
              "resources": {"cpus": 2, "ram_gb": 4, "timeout_minutes": 30},
              "outputs": [{"name": "train", "type": "dataframe"}, {"name": "test", "type": "dataframe"}]} ],
  "edges": [ {"from": "read-1.out", "to": "split-1.in1", "type": "dataframe"} ] }
```
Edges are explicit and typed (V2 change from V1's output-name string matching); `$IN_TRAIN`/`$IN_VALID` placeholders remain valid in algorithm-template bodies and resolve to `model-input` roles at instantiation.

### 4.4 Retention
Runs: hot 18 months → Iceberg. Compiled manifests: object storage, lifetime of the version. Artifacts bucket: 7-day lifecycle for intermediates. `run_queue` rows deleted on dequeue.

### 4.5 Run state machine
```
pending ──quota ok──▶ submitted ──informer: Running──▶ running ──Succeeded──▶ succeeded
   │                        │                             ├──Failed|Error──▶ failed
   └─quota full─▶ quota_queued ─dequeue─▶ submitted       └──terminate ack──▶ cancelled
guards: terminate allowed from pending/quota_queued/submitted/running; terminal states immutable;
queue timeout 60 min → failed(QUOTA_TIMEOUT).
```

## 5. API specification (`/api/v1`, JWT per master; representative)

| Method & path | Purpose | Errors |
|---|---|---|
| POST `/pipelines/validate?mode=` | Validate without saving | 422 VALIDATION_FAILED |
| POST `/pipelines` | Create template (v1) | 409 CONFLICT (name), 422 |
| PUT `/pipelines/:id` | New version | 404, 409, 422 |
| GET `/pipelines` · GET `/pipelines/:id` | List (filter[name], filter[pipeline_type], sort) / get | 404 |
| GET `/pipelines/:id/versions` · POST `/pipelines/:id/versions/:vid/activate` | Version history / rollback | 404 |
| DELETE `/pipelines/:id` · PATCH `/pipelines/:id/restore` | Archive / restore | 409 (system) |
| POST `/pipelines/:id/compile` | Explicit compile | 422 CANNOT_COMPILE |
| POST `/pipelines/:id/run` | Submit run → 202 | 422, 429 RATE_LIMITED/BUDGET_EXHAUSTED |
| GET `/runs` · GET `/runs/:id` | List (filter[status], filter[template_id]) / detail incl. components_status | 404 |
| PUT `/runs/:id/terminate` · POST `/runs/:id/retry` | Terminate / retry | 404, 409 |
| GET `/runs/:id/manifest` | Compiled manifest + resolved params | 404 |
| GET `/components` · GET `/components/:name` | Registry catalog | 404 |
| GET `/algorithm-templates` · GET `/algorithm-templates/:name` | Algorithm catalog | 404 |
| POST `/algorithm-templates/:name/pipelines` | Instantiate training pipeline (`mode`) | 422 |
| POST `/internal/runs/:wf/error` | Component error report (mTLS) | 401 |

**Example — create template request (abbreviated):**
```json
POST /api/v1/pipelines
{ "name": "churn-feature-prep", "pipeline_type": "data_prep",
  "definition": { "metadata": {"description": "monthly churn features"},
    "nodes": [
      {"alias": "read-1", "component": "read-from-warehouse",
       "parameters": {"dataset": "wr:t-42:dataset:dataset/ds-9f2"},
       "outputs": [{"name": "out", "type": "dataframe"}]},
      {"alias": "write-1", "component": "write-to-warehouse",
       "parameters": {"output_dataset_name": "churn_features"}, "outputs": []}],
    "edges": [{"from": "read-1.out", "to": "write-1.in1", "type": "dataframe"}]}}
→ 201 {"data": {"id": "tpl_01J...", "active_version_id": "ver_01J...", "validation_status": "valid"}}
```

**Example — run submit / validation error:**
```json
POST /api/v1/pipelines/tpl_01J.../run  {"run_parameters": {"label_column": "churned"}}
→ 202 {"operation_id": "op_01J...", "data": {"id": "run_01J...", "status": "pending"}}

→ 422 {"error": {"code": "VALIDATION_FAILED", "trace_id": "...", "details": [
   {"alias": "join-1", "field": "parameters.join_type", "problem": "not in enum [inner, left, outer]"},
   {"alias": null, "field": "edges[2]", "problem": "EDGE_TYPE_MISMATCH: split-1.train(dataframe) -> train-1.in1(model)"}]}}
```

## 6. Events (`pipeline.events.v1`; envelope per MASTER-FR-031)

### Emitted

| Event type | Payload fields |
|---|---|
| `pipeline.template.created` / `updated` / `archived` / `restored` / `version_activated` | `template_id, version_id, pipeline_type, name, workspace_id` |
| `pipeline.template.compiled` | `template_id, version_id, manifest_digest, argo_template_name` |
| `pipeline.run.submitted` | `run_id, template_id, version_id, mlflow_run_id, argo_workflow_name, submitted_by, via_agent?` |
| `pipeline.run.started` | `run_id, argo_workflow_name, started_at` |
| `pipeline.run.status_changed` | `run_id, status, previous_status, components_status_digest` |
| `pipeline.run.component_status_changed` | `run_id, alias, phase, message?, exit_code?, retry_count` |
| `pipeline.run.succeeded` | `run_id, mlflow_run_id, duration_s, total_resources{cpu_core_s, ram_gb_s}` |
| `pipeline.run.failed` | `run_id, mlflow_run_id, error{code, alias?, message}, duration_s` |
| `pipeline.run.cancelled` | `run_id, cancelled_by, duration_s` |
| `pipeline.run.output_registered` | `run_id, dataset_urn, iceberg_snapshot_id, output_name` |
| `pipeline.run.outputs_invalidated` | `run_id, dataset_urns[]` |
| `pipeline.run.quota_queued` / `quota_dequeued` | `run_id, queue_position?, queued_ms?` |

### Consumed

| Topic / event | Handler behavior |
|---|---|
| `identity.events.v1: tenant.provisioned` | Create default `tenant_quotas` row; register tenant processing namespace with the informer controller's label selector |
| `dataset.events.v1: dataset.deleted` | Mark templates whose parameters pin the dataset as `validation_status=draft` with a `DATASET_DELETED` report item; notify owners |
| `usage.events.v1: budget.exhausted` (meter `pipeline_minutes`) | Reject new submissions with 429 `BUDGET_EXHAUSTED` until `budget.restored` for the scope |

## 7. Business rules & edge cases

- **BR-1** Resource bounds: default `{cpus:1, ram_gb:2, timeout:30m}`, floor `{1, 2, 5m}`, ceiling from tenant quota (platform default `{7, 24, 480m}`). Requests = limits when `guaranteed_qos` or ram ≥ 15 GB, else limits/4. Memory serialized in Mi.
- **BR-2** Missing node resources inherit the max of predecessors' (topological), else defaults (V1 `set_missing_resources` semantics).
- **BR-3** One active version per template; activation of version N deactivates the current atomically (single transaction + outbox event).
- **BR-4** Compile-time parameter contract: workflow parameter set must equal `{mlflow_run_id, current_context} ∪ {<alias>_component_parameters}`; any drift is a compile failure `CANNOT_COMPILE` (V1 invariant kept).
- **BR-5** Duplicate consumption of one output requires an injected `clone-input`; the injected node is invisible in the user-facing definition but present in the manifest.
- **BR-6** Terminate is idempotent; a terminate racing a natural completion resolves to whichever terminal state the informer records first — never both events.
- **BR-7** Informer outage: on reconnect, resync lists all managed workflows and reconciles run rows; a run whose workflow no longer exists and is non-terminal after TTL → `failed(WORKFLOW_LOST)`.
- **BR-8** Argo `Error` ≡ `Failed` at platform level; node-level retry expression distinguishes them (Error always retried; Failed retried only for exit codes ∉ {0,1}).
- **BR-9** Failure error enrichment: deadline message → `COMPONENT_TIMEOUT` (include configured timeout); `OOMKilled` → `OUT_OF_MEMORY` (include ram limit); both actionable in the UI.
- **BR-10** Per-user submissions < 15 s apart → 429 (tenant-tunable ≥ 5 s). Quota queue depth > 50 → immediate 429 `BUDGET_EXHAUSTED`.
- **BR-11** A template referencing a component absent from (or disabled in) the tenant's catalog fails validation with `COMPONENT_NOT_AVAILABLE`; existing compiled versions keep running (catalog pinning).
- **BR-12** Concurrent `PUT /pipelines/:id` requests: optimistic lock on `active_version_id` (`If-Match` ETag); loser gets 409 `CONFLICT`.
- **BR-13** Agent submissions (`typ=agent_obo`) for `pipeline.run.submit` and template creation are proposal-gated per master §8.5; auto-execution is never allowed for `terminate` on another user's run.
- **BR-14** `z_score_based_anomaly_detection` template has empty pipelines (V1 placeholder); it is served in the catalog with `runnable: false` and cannot be instantiated (422 `TEMPLATE_NOT_RUNNABLE`).
- **BR-15** MLflow unavailability at submit: run creation fails fast (503 `DEPENDENCY_UNAVAILABLE`); no orphan Argo workflow may exist without a run row (submit to Argo only after run row + MLflow run persist).

## 8. Dependencies

Upstream: identity-service (JWT/JWKS, tenant provisioning events), rbac-service (OPA/Redis authz), dataset-service (dataset URNs, output registration), experiment-service (consumes run events; MLflow run creation via MLflow REST), usage-service (pipeline-minutes metering from run events). Infra: Argo Workflows (server REST + CRD watch), Kubernetes API (informers), Postgres, Kafka + Schema Registry, Redis (idempotency/dedup), object storage (manifests, artifacts, component YAMLs), MLflow tracking server. Downstream contract: `pipeline.events.v1` consumed by experiment-service, inference-service, dataset-service, usage-service, audit-service, realtime-hub.

## 9. NFRs (deltas from master)

- Validation endpoint p95 ≤ 800 ms for DAGs ≤ 60 nodes (CPU-bound graph checks).
- Compile p95 ≤ 3 s; submit→Argo-accepted p95 ≤ 2 s; informer event→Kafka publish p95 ≤ 2 s.
- Informer controller: HA active-passive (leader election); missed-event tolerance covered by 5-min resync; zero polling of Argo REST for status.
- Scale: 200 concurrent workflows per cell; 5,000 runs/day/tenant.

## 10. Acceptance criteria

- **AC-1** Given a definition containing a cycle (`a→b→c→a`), when `POST /pipelines/validate` is called, then response is 422 with a `DAG_CYCLE` item listing exactly the aliases `[a, b, c]`.
- **AC-2** Given an edge from a `model`-typed output to a `dataframe`-typed input, when validating, then 422 with `EDGE_TYPE_MISMATCH` naming both port types and both aliases.
- **AC-3** Given a valid training template, when it is run for the first time, then a compiled manifest is stored with a digest, the same version compiled again produces an identical digest, and `pipeline.template.compiled` is emitted exactly once.
- **AC-4** Given a submitted run, when the Argo workflow transitions Pending→Running→Succeeded, then the run row transitions submitted→running→succeeded solely via informer updates (zero Argo REST status GETs in traces), and `pipeline.run.status_changed` events are emitted for each transition within 2 s p95.
- **AC-5** Given a tenant at `max_concurrent_runs=2` with 2 running runs, when a third run is submitted, then it enters `quota_queued`, `pipeline.run.quota_queued` is emitted, and it auto-submits when one running run reaches a terminal state.
- **AC-6** Given a running run, when `PUT /runs/:id/terminate` is called twice, then the first returns 200 with status transitioning to `cancelled`, the second returns 200 idempotently, and exactly one `pipeline.run.cancelled` event exists.
- **AC-7** Given a component pod OOMKilled, when the run fails, then `components_status` for that alias contains error code `OUT_OF_MEMORY` with the configured `ram_gb`, and the run error is surfaced in `GET /runs/:id`.
- **AC-8** Given the xgboost algorithm template, when `POST /algorithm-templates/xgboost/pipelines` is called with `mode=tune` and TRAIN+VALIDATION dataset refs, then the created pipeline contains the `hyperparameter-search` node with `parameters.algorithm="xgboost"` and validation passes; with `mode=tune` and only TRAIN, then 422 `MISSING_MODEL_INPUT_ROLE: VALIDATION`.
- **AC-9** Given a user submits two runs 5 s apart with default limits, then the second returns 429 `RATE_LIMITED` with `Retry-After ≥ 10`.
- **AC-10** Given tenant A's token, when it calls `GET /runs/:id` for tenant B's run, then 404 and a `security.cross_tenant_denied` audit event (isolation suite per MASTER-FR-004 passes for all endpoints).
- **AC-11** Given a node without resources whose two predecessors have `{cpus:2, ram_gb:8}` and `{cpus:4, ram_gb:4}`, when compiled, then the node gets `{cpus:4, ram_gb:8, timeout:30m}`.
- **AC-12** Given the informer is down for 3 minutes while a workflow completes, when it reconnects, then the resync reconciles the run to `succeeded` and emits the terminal event exactly once (Redis dedup verified).
- **AC-13** Given a run's write step completes, when the workflow succeeds, then `pipeline.run.output_registered` carries a dataset URN and Iceberg snapshot id, and dataset-service lineage shows run→dataset edges.
- **AC-14** Given a `model`-typed pipeline, when `POST /pipelines/:id/run` is called, then 422 `CANNOT_RUN_PIPELINE_TYPE`.

## 11. Out of scope / future

Scheduled/recurring pipeline execution (Temporal schedules live in inference-service/ingestion-service; they call `POST /pipelines/:id/run`). Component authoring/build tooling and image CI. Cross-pipeline composition UI beyond model/feature-engineering embedding. Kubeflow Pipelines compatibility layer. Dynamic DAGs (runtime-generated nodes) beyond `withParam` fan-out. GPU scheduling policy (Phase 6; schema reserves `resources.gpus`). Multi-cluster run federation.
