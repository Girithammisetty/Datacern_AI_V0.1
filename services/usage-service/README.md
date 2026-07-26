# usage-service (Go)

Metering, cost-attribution and budget-enforcement authority for the datacern
platform (BRD 17). Consumes usage events from every service, aggregates them
into per-tenant/workspace/user/agent rollups, exposes showback + chargeback
reporting, maintains budget objects whose threshold events gate LLM spend at
ai-gateway, detects spend anomalies, and reconciles metered usage against
provider bills. **Every adapter is real** — Postgres, Redpanda (Kafka), Redis,
OPA — with no runtime stubs (CONVENTIONS END STATE).

## Architecture

- **Meter store + rollups**: real Postgres 16. `usage_raw` is a monthly
  range-partitioned hypertable-style table; `usage_hourly/daily/monthly` are
  materialized rollups refreshed by the rollup engine (TimescaleDB-style done in
  plain Postgres per the deploy image, which is pgvector/pg16 not Timescale).
- **Ingestion**: real Redpanda consumer group `usage-ingest` over
  `usage.metering.v1`, `query.events.v1`, `pipeline.events.v1`,
  `ai.tool_invoked.v1`, `ai.agent_run.v1`, `ai.token_usage.v1`. A declarative
  mapping catalog (validated at startup) turns each event into raw meter
  records. Idempotent: Redis `SETNX` dedup **and** a unique constraint on
  `(tenant_id, event_id, meter_key, time)`.
- **Budgets**: evaluated on ingest and by a periodic sweep; threshold crossings
  (80/95/100) emit `budget.threshold` / `budget.exhausted` on `usage.events.v1`
  via the transactional outbox → real Kafka. This is the FinOps feedback loop
  ai-gateway consumes for admission control.
- **Authz**: real OPA sidecar over the Redis `permissions_flat` projection
  (never calls rbac synchronously). Action manifest registered with rbac at
  startup.

## Run

```
# real infra (repo root): docker compose -f deploy/docker-compose.dev.yml up -d
createdb usage   # or: psql -U datacern -c 'CREATE DATABASE usage'
make run
```

Default env wires REAL adapters (no flags):

| Var | Default | Adapter |
|---|---|---|
| `MIGRATE_DATABASE_URL` | `postgres://datacern:datacern_dev@localhost:5432/usage` | owner DSN for migrations (creates the runtime role) |
| `DATABASE_URL` | `postgres://usage_app:usage_app@localhost:5432/usage` | **non-owner** NOSUPERUSER NOBYPASSRLS runtime role (RLS applies) |
| `KAFKA_BROKERS` | `localhost:9092` | Redpanda |
| `REDIS_ADDR` | `localhost:6379` | Redis |
| `OPA_URL` | `http://localhost:8281` | OPA sidecar |
| `JWKS_URL` | identity-service JWKS | JWT verification |
| `MINIO_ENDPOINT` | unset (dev falls back with a loud warning) | MinIO/S3, backs both value-report exports and provider-bill reconciliation drops |
| `PROVIDER_BILL_BUCKET` | `datacern-provider-bills` | bucket the reconciliation job reads (USG-FR-070) |
| `PROVIDER_BILL_PREFIX` | `bills/` | key prefix; objects are `<prefix><provider>/<month>.csv` |

RLS is enforced under the shipped **non-owner** role with `ALTER TABLE … FORCE
ROW LEVEL SECURITY`, so neither the app role nor a table owner can escape tenant
isolation.

## Test

```
make test-unit         # -short; no infra; test doubles live only in *_test.go
make test-integration  # real Postgres/Kafka/Redis/OPA; auto-skips if infra down
```

## FR traceability (implemented)

| FR | Where | Test |
|---|---|---|
| USG-FR-001/003/005 meter catalog | `internal/domain/types.go`, `store/pg.go` (SeedMeters/ListMeters) | boot seed; `GET /meters` |
| USG-FR-010/015 ingest + mapping | `internal/ingest/*` | `ingest/pipeline_test.go`, AC01 |
| USG-FR-011 idempotency | `store/raw.go` (unique constraint) + Redis dedup | AC02 |
| USG-FR-014 late events / re-rollup | `store/rollups.go` RefreshRollups (49h window) | AC08 data path |
| USG-FR-020/021/022 rollups + retention | `store/rollups.go`, `jobs/jobs.go` | AC01, AC06 |
| USG-FR-030..034 budgets + threshold events | `store/budgets.go`, `budget/window.go` | AC03, AC04, `budget/window_test.go` |
| USG-FR-032 gateway resync | `GET /budgets/:id/state`, `/budget-states` | AC04 |
| USG-FR-040/041 showback + CSV | `api/handlers_reports.go`, `store/rollups.go` | AC06 |
| USG-FR-042/043 rate cards + chargeback | `store/ratecards.go`, `store/rollups.go` | AC09 |
| USG-FR-050/051 anomaly z-score | `internal/anomaly`, `jobs/jobs.go` | AC08, `anomaly/detect_test.go` |
| USG-FR-070/071/072 reconciliation + adjustments, hourly job | `internal/recon`, `internal/jobs/jobs.go` (`Runner.Reconcile`), `internal/jobs/billstore.go`, `store/recon.go`, `cmd/server/main.go` (bill object store wiring + ticker) | AC09, `recon/variance_test.go`, `test/integration/reconciliation_job_test.go` (AC09 via the job itself, written/compile-checked — Docker unavailable in this environment) |
| MASTER-FR-001/003 RLS + cross-tenant 404 | `migrations/000002_rls`, `store/*` | RLS default-role test, AC10 |
| MASTER-FR-012 OPA authz | `internal/authz/opa_client.go` | OPA-sidecar test |
| MASTER-FR-034 outbox → Kafka | `store/pg.go`, `events/*` | AC03 (real Kafka) |
| BRD 67 slice 1 `governed_decision`/`auto_executed_action` meters | `internal/domain/types.go`, `internal/ingest/mapping.go`, `migrations/000004_value_meters` | `test/integration/governed_decision_test.go` |
| BRD 69 ROI-FR-001/002 value assumptions (versioned, pinned) | `internal/domain/value.go`, `internal/store/value_assumptions.go`, `migrations/000005_value_assumptions` | `internal/valuecalc/valuecalc_test.go`, `test/integration/value_test.go` (AC1-3, written/compile-checked — Docker unavailable in this environment, see docs/initiatives/value-roi-reporting.md §3) |
| BRD 69 ROI-FR-010 `GET /value/summary`, ROI-NFR-004 `EstimatedValue` null-guarantee | `internal/valuecalc/valuecalc.go`, `internal/api/handlers_value.go`, `internal/store/value_summary.go` | `internal/valuecalc/valuecalc_test.go` (all tiers, run — see below) |
| BRD 69 new authz action (design §2.9, gates assumption edits) | `internal/authz/authz.go` (`usage.assumptions.update` — see doc comment for the "manage"→"update" verb deviation from the design doc, forced by rbac's closed verb grammar) | `internal/api/drift_test.go` (run) |
| BRD 69 ROI-FR-011 `GET /value/trend` | `internal/store/value_trend.go`, `internal/api/handlers_value.go` | `test/integration/value_export_test.go` (written/compile-checked, Docker unavailable) |
| BRD 69 ROI-FR-021 `value-report.v1` export (§2.8) | `internal/valueexport/`, `internal/store/value_exports.go`, `migrations/000006_value_exports`, `internal/api/handlers_value_export.go` | `internal/valueexport/export_test.go` (run — CSV/checksum/FSStore round-trip + never-overwrite); `test/integration/value_export_test.go` (AC4, written/compile-checked) |

## Known upstream-contract note

`ai.agent_run.v1` messages currently on the dev broker carry a **string-encoded**
`payload` (non-conformant with MASTER-FR-031, which requires an object). Such
messages are correctly routed to the `ai.agent_run.v1.usage-ingest.dlq` after 5
retries (MASTER-FR-033). Real `ai.token_usage.v1` events from ai-gateway carry
object payloads and are metered end-to-end (verified in AC01/AC03). Once
agent-runtime conforms, `agent_tasks_completed` metering flows without change.

## No credential-gated exceptions

All adapters are local-protocol real. Provider-bill reconciliation reads CSV
line items (RFC 4180) from a configured object-storage prefix; the parser and
variance math are real and unit-tested. Live cloud-provider billing APIs
(AWS CUR / Azure / GCP) are the only credential-gated path, per CONVENTIONS.

**What "reconciliation" actually checks today.** `Runner.Reconcile`
(`internal/jobs/jobs.go`) runs hourly from `cmd/server` and is the thing that
makes the USG-FR-071 block gate live: it lists `bills/<provider>/<month>.csv`
objects under a real MinIO/S3 bucket (`PROVIDER_BILL_BUCKET`,
`internal/jobs/billstore.go` wraps `go-common/objectstore`, same real client
the value-report exports use, separate bucket), parses each with
`recon.ParseBillCSV`, and diffs it against `MeteredMonthly`. This is real
end-to-end wiring against real infra, but "provider bill" only means whatever
CSV was dropped in that bucket -- there is no live pull from an actual
Anthropic/OpenAI/AWS/Azure/GCP billing API anywhere in this repo, and building
one is out of scope (credential-gated, per CONVENTIONS). Getting the real
provider invoice into the bucket in the first place (an operator export, or an
out-of-repo scheduled pull) is an operational step, not code in this service.
Until a bucket has bill objects, `Reconcile` is a real, scheduled, provably-
wired no-op (see `TestReconcile_NoBillsConfigured_NoOp`) and every month stays
`reconciliation_status=pending` -- honestly inert, not a fake "matched".
