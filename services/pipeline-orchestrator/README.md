# pipeline-orchestrator

The RETRAIN half of the Datacern learning loop: it owns the definition, validation,
compilation, and execution lifecycle of ML pipelines, and turns human triage
corrections into trained models. Consolidates V1 `pipeline-manager` + `pipeline-service`
into one service (BRD 09).

**Stack:** Python 3.12 · FastAPI · SQLAlchemy 2 async · Alembic · Postgres (RLS) ·
Kafka (Redpanda) + transactional outbox · Redis · OPA · MinIO (S3) · **MLflow**.

## The critical execution decision (real on the Mac)

Pipeline templates are typed component DAGs — validated (acyclic, type-compatible edges,
arity, resource limits, terminal rules) and compiled to a **real, deterministic Argo
`WorkflowTemplate`** manifest (SHA-256 digest, idempotent). For EXECUTION the DEFAULT
backend is a **real local training executor**: given a dataset + algorithm + params it
runs genuine scikit-learn/xgboost training, logs the run + metrics + the fitted model
artifact to **real MLflow** (`:5500`, tracking + registry), and produces a registered
model version. This is not a mock — `mlflow.get_run` / the model registry show the run
and artifact afterward.

The **Argo backend** (`app/executor/argo.py`) is real code that speaks the Argo
Workflows server REST + Kubernetes watch API (informer, never polling), but is
**INFRA-GATED**: it needs a Kubernetes cluster + Argo server (no local-protocol
equivalent on the Mac), so `executor_backend` defaults to `local`. This is the single
documented exception, analogous to the cloud warehouses in `CONVENTIONS.md`.

`_drive_argo` submits the compiled workflow and then **watches it to a terminal
phase**, projecting Argo's per-node status onto `components_status` and reading the
outcome back from MLflow on success — the training pod, not the orchestrator, is what
logged the metrics and registered the model, so the run's recorded metrics are always
the ones a real fit produced. A stream that ends without a terminal phase fails the
run rather than guessing at success.

## Scaling on demand: run leases + orphan recovery

A run is driven only by the holder of an **unexpired lease** (`pipeline_runs.lease_owner`
/ `lease_expires_at`, migration 0004). `claim_lease` is one conditional `UPDATE`, so two
orchestrator instances racing the same run cannot both win — which matters because
double-driving would train the run twice and register two models for one four-eyes
approval. The driver heartbeats at a third of the TTL; losing the pod simply stops the
heartbeat.

The **orphan reaper** (`recover_orphans`, swept every `orphan_reaper_poll_seconds`) then
recovers what that pod was driving, and which of two outcomes applies is decided by where
the work actually lives:

- **Argo** — the workflow is still running in Kubernetes, entirely unaffected by the
  orchestrator pod going away. Re-attach the watch (in the background, so one long
  workflow cannot stall the sweep) and let the run finish normally.
- **local** — the fit ran in the dead pod's own process and is genuinely gone. Fail the
  run with `RUN_ORPHANED`: terminal, retryable, and it frees the tenant's concurrency
  slot. Leaving it `running` would misreport a dead run as live and hold that slot
  forever.

Every instance sweeps; no leader election is needed because `claim_lease` decides the
winner. Lease columns are written only by claim/renew/release — `SqlRunRepo.update`
excludes them, so a caller writing back a row it read before claiming cannot erase the
lease it is holding.

## The learning loop (corrections → real model)

`case.disposition_applied` events (the human triage correction) are consumed from real
Kafka and assembled into a labeled training dataset: `dataset_urn + row_pk → features`,
`disposition.category → label` (`app/domain/labeling.py`). A retrain run trains a real
model on those assembled labels. Proven end-to-end in
`tests/integration/test_real_training_mlflow.py`.

## Run

```bash
make install
make migrate                     # runs as a privileged role (PPL_MIGRATE_URL)
make run                         # REAL adapters + local executor are the DEFAULT
make test-unit                   # no infra; in-memory doubles (tests set use_real_adapters=False)
make test-integration            # real infra (Postgres, MLflow, Kafka, MinIO, OPA, Redis)
make lint
```

**Real adapters are the DEFAULT** (`use_real_adapters=True`): the shipped `app.main:app`
wires the Postgres (RLS) UoW, `RedisDedupStore`, the S3 manifest store (MinIO), the
`OpaAuthzClient`, the local training executor + MLflow gateway; it registers the action
catalog with rbac, bootstraps the component/algorithm catalog into Postgres, and runs
the outbox relay to Redpanda + the Kafka consumers. The in-memory doubles are reachable
**only from tests** (which set `use_real_adapters=False`), never from the runtime.

**RLS is FORCED.** Every tenant table has `FORCE ROW LEVEL SECURITY`, and the runtime
DSN uses the non-owner, non-superuser DML role `pipeline_app` — so isolation holds even
if the runtime role owned the tables. Migrations run as a privileged role.

> macOS note: xgboost needs `libomp` (`brew install libomp`).

## FR coverage (BRD 09 §3)

| Area | FRs | Where |
|---|---|---|
| Templates & versioning | PIPE-FR-001..005 | `domain/services.py::TemplateService` |
| Validation | PIPE-FR-010..017 | `domain/dag.py`, `domain/params.py`, `domain/resources.py` |
| Compilation | PIPE-FR-020..025 | `domain/compiler.py` |
| Run lifecycle | PIPE-FR-030..038 | `domain/services.py::RunService`, `executor/local.py`, `executor/argo.py` |
| Quotas & node routing | PIPE-FR-040..042 | `RunService` quota/queue + compiler node affinity labels |
| Component & algorithm catalog | PIPE-FR-050..053 | `domain/catalog.py`, `mcp/facade.py` |
| Artifacts | PIPE-FR-060..062 | `adapters/manifest_store.py`, run `output_registered` events |
| Batch jobs (BRD 73, B1/B2) | — | `domain/batch.py`, `adapters/ingestion_client.py`, `api/routes/batch_jobs.py`, `migrations/versions/0005_batch_jobs.py` |

31 Must FRs implemented; PIPE-FR-005/037 (Should) implemented. Node-pool routing
(PIPE-FR-041) is emitted as manifest labels/affinity (applied by the infra-gated Argo
backend). Informer-driven status (PIPE-FR-032) is the Argo path; the local executor
drives the equivalent status transitions + events directly.

## Acceptance criteria → tests

| AC | Test |
|---|---|
| AC-1 cycle → DAG_CYCLE aliases | `unit/test_dag_validation.py::test_ac1_cycle_reports_exact_aliases` |
| AC-2 edge type mismatch | `unit/test_dag_validation.py::test_ac2_edge_type_mismatch_names_both_types`, `integration/test_dag_and_boot.py` |
| AC-3 deterministic idempotent compile | `unit/test_templates_api.py::test_ac3_compile_is_deterministic_and_idempotent`, `unit/test_compiler.py` |
| AC-5 quota queue | `unit/test_runs.py::test_ac5_quota_queue_when_concurrency_exhausted` |
| AC-6 terminate idempotent | `unit/test_runs.py::test_ac6_terminate_idempotent_single_cancel_event` |
| AC-8 xgboost tune roles | `unit/test_algorithms.py::test_ac8_*` |
| AC-9 rate limit | `unit/test_runs.py::test_ac9_rate_limit_second_run_429_with_retry_after` |
| AC-10 cross-tenant 404 / RLS | `unit/test_isolation_authz.py`, `integration/test_rls_isolation.py` |
| AC-11 resource inheritance | `unit/test_dag_validation.py::test_ac11_*` |
| AC-14 model type not runnable | `unit/test_runs.py::test_ac14_model_type_not_runnable` |
| Learning loop (corrections → real MLflow model) | `integration/test_real_training_mlflow.py` |
| Run lifecycle on real Kafka | `integration/test_kafka_lifecycle.py::test_run_lifecycle_events_on_real_kafka` |
| Labeled dataset from real disposition Kafka | `integration/test_kafka_lifecycle.py::test_labeled_dataset_from_real_disposition_kafka` |
| Real adapters + local executor by default | `integration/test_dag_and_boot.py::test_app_main_wires_real_adapters_and_local_executor` |
| BRD 73 AC-1..AC-9 batch jobs (ordering, failed-ingestion refusal, version pinning, no double-ingest, the lease, retry-from-phase, deadlines, `batch-trigger`, events) | `unit/test_batch_jobs.py` |
| BRD 73 migration + RLS + at-most-one-active-run + lease, on real Postgres | `integration/test_batch_jobs_sql.py` |

## Remaining stubs / documented exceptions

- **Argo Workflows backend** — real code (submit + watch-to-terminal + terminate),
  INFRA-GATED on a k8s cluster + Argo server (`executor_backend=local` is the Mac
  default). No `NotImplementedError`; unreachable infra raises `DependencyUnavailable`.
  The watch loop is covered by unit tests against a fake that speaks the adapter's
  shape; end-to-end verification still needs a real cluster.
- In-memory store / dedup / feature source are unit/dev-tier doubles selected only in
  `mode="memory"` with `use_real_adapters=False` — set only by tests, never reachable
  from the shipped `app.main` default.
- **Batch jobs (BRD 73)** — there is deliberately NO in-memory ingestion double in the
  runtime wiring: with no `HttpIngestionClient` configured a batch job run FAILS in its
  `trigger` phase rather than skipping the phase and scoring stale data. AC-3 pins the
  exact dataset version URN + Iceberg snapshot id onto the run, but the executor still
  READS a dataset's *current* version — dataset-service has no version-scoped rows API;
  flagged, not faked. The BFF/UI leg and the `data_pipeline_builder` agent proposal
  (AC-10 / inc4) are deferred.

Verified: `make test-unit` (44) + `make test-integration` (9) green; `ruff` clean; the
shipped `app.main` wires real adapters by default and the default-DSN role
(`pipeline_app`, non-owner, FORCE RLS) proves cross-tenant isolation.
