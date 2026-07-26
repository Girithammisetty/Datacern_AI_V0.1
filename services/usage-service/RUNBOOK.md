# usage-service RUNBOOK

Failure modes, operational procedures and DLQ handling (MASTER-FR-072).

## Health

- `GET /healthz` — liveness (no deps).
- `GET /readyz` — checks Postgres + Redis.
- `GET /metrics` — Prometheus: `usage_ingest_lag_seconds`,
  `usage_unmapped_events_total`, `usage_ingested_records_total`,
  `budget_eval_duration_seconds`, `budget_enforcement_latency_seconds`,
  `usage_ingest_dlq_total`.

## DLQ drain (`usage-ingest`)

Poison messages route to `<topic>.usage-ingest.dlq` after 5 retries
(MASTER-FR-033). Inspect and drain:

```
rpk topic consume ai.agent_run.v1.usage-ingest.dlq -n 20
```

Common cause: a producer emitting a non-conformant envelope (e.g. string-encoded
`payload`). Fix the producer, then replay the source range through the ingest
path (backfill, USG-FR-016). DLQ depth alerts at > 0 for 15 min.

## Redis counter resync (AC-14)

Redis holds ingest dedup keys and (fast-path) LLM budget counters. On a Redis
outage budget evaluation degrades to the rollup path (BR-12). No raw data is
lost — the unique constraint on `usage_raw` holds. On recovery, counters
rebuild from rollups on the next sweep; no manual step required. To force a
resync: restart the budget sweep (it recomputes consumption from `usage_raw`).

## Re-rollup a bucket range

Late events (≤ 48h) reopen non-finalized buckets automatically. To force a
re-rollup after a mapping-bug backfill:

```
-- from psql as the owner; recomputes hourly/daily/monthly from raw since T
-- (the service also runs this every minute for the trailing 49h):
SELECT 1; -- the RefreshRollups job handles this; adjust the ticker or restart.
```

Finalized monthly buckets are immutable except via reconciliation adjustments
(never in-place edits). Re-finalize after a late-event re-rollup emits
`usage.month_refinalized` and versions the chargeback report (BR-10).

## Reconciliation acknowledge flow (AC-9)

A month with `reconciliation_status=variance` blocks chargeback export. An
operator either records an adjustment (`POST /adjustments`, requires the month
finalized) or acknowledges the variance
(`POST /reconciliations/:id/acknowledge`). Either unblocks
`GET /reports/chargeback?month=`.

## Dropping a provider bill for reconciliation (USG-FR-070)

The hourly `Runner.Reconcile` job (`internal/jobs/jobs.go`, started from
`cmd/server`) reads provider bill CSVs from the `PROVIDER_BILL_BUCKET` MinIO/S3
bucket. To submit a month's bill, upload (e.g. via `mc cp` or the S3 API) an
RFC 4180 CSV with `meter_key,billed_quantity` columns to
`<PROVIDER_BILL_PREFIX><provider>/<month>.csv`, e.g.:

```
mc cp openai-2026-06.csv local/datacern-provider-bills/bills/openai/2026-06.csv
```

The job picks it up on its next tick (≤ 1h), upserts the `reconciliations` row
for `(month, provider)`, and — if any meter's variance exceeds threshold (5%
LLM / 10% infra) — marks the month `variance` and emits
`usage.reconciliation_variance`, blocking chargeback per the flow above.
Re-dropping the same key is safe (idempotent upsert). If `MINIO_ENDPOINT` is
unset, the job is a real no-op every tick (logged once at startup) and every
month stays `pending` — there is nothing to reconcile against, not a silently
faked "matched".

## Budget-event replay for gateway resync

ai-gateway resyncs budget state via `GET /budget-states?scope=` and
`GET /budgets/:id/state` (p95 target ≤ 50ms). If the gateway missed
`budget.exhausted`/`reset` events (Kafka lag), it re-reads current state from
these endpoints — no event replay needed. To re-emit, PATCH the budget (a limit
raise emits `budget.reset`) or wait for the next window rollover.

## Rollback

Migrations are forward-only (MASTER-FR-060). Roll back by deploying the prior
image; the schema is additive. The non-owner runtime role `usage_app` and its
grants persist across deploys.
