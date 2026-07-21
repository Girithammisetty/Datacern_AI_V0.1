# BRD 17 — usage-service

**Service:** usage-service · **Language:** Go · **Phase:** 2–5 · **Status:** Approved for build
**Inherits:** `00_MASTER_BRD.md` (all MASTER-FR requirements apply). Architecture: `../../DATACERN_PLATFORM_ARCHITECTURE.md` §6, §1.2 (cost attribution NFR).

---

## 1. Overview

**Purpose.** usage-service is the platform's metering, cost-attribution, and budget-enforcement authority. It consumes usage events from every service via Kafka, aggregates them into per-tenant/workspace/user/agent rollups, exposes showback and chargeback reporting, maintains budget objects whose threshold events gate spend (notably LLM spend enforced by ai-gateway), detects spend anomalies, and reconciles internal meters against cloud/LLM provider bills.

**Business value.** The V1 platform had no per-tenant cost attribution; LLM adoption makes uncontrolled spend an existential risk. Master NFR (§1.2 architecture doc) mandates "per-tenant metering of compute, storage, and LLM tokens; showback from day one, chargeback-capable." Budgets with hard stops prevent runaway agent loops from burning tokens; showback lets customer admins self-serve cost questions; chargeback rate cards enable revenue.

**In scope.** Meter catalog; idempotent ingestion of metering events; time-series rollups (raw→hourly→daily→monthly) with tiered retention; budget CRUD + threshold evaluation + `budget.threshold`/`budget.exhausted` events; showback report APIs with CSV export; chargeback rate cards with per-tenant overrides; z-score spend anomaly detection; provider-bill reconciliation job.

**Out of scope.** Invoicing/payment collection (external billing system consumes chargeback exports); real-time admission control (ai-gateway enforces budget state, this service only publishes it); infrastructure rightsizing recommendations; forecasting beyond simple linear projection in reports.

## 2. Actors & user stories

Personas: **Platform Operator** (Datacern SRE/finance-ops), **Tenant Admin**, **Workspace Owner**, **Finance Analyst** (customer-side), **ai-gateway** (system consumer), **AI Agent** (metered subject; read-only MCP facade).

- **US-1** As a Tenant Admin, I want a monthly usage report broken down by workspace and meter, so I can attribute cost internally.
- **US-2** As a Workspace Owner, I want to see LLM token consumption per user and per agent this week, so I can spot expensive workflows.
- **US-3** As a Tenant Admin, I want to set a monthly budget of 50M LLM input tokens for a workspace with alerts at 80% and 95%, so spend never surprises me.
- **US-4** As a Platform Operator, I want ai-gateway to stop serving LLM calls for a scope whose budget hit 100%, so an agent loop cannot burn unbounded money.
- **US-5** As a Finance Analyst, I want to export a CSV of daily usage per meter for the last quarter, so I can load it into our BI system.
- **US-6** As a Platform Operator, I want per-tenant rate cards that override default pricing, so enterprise contracts with negotiated rates are billed correctly.
- **US-7** As a Platform Operator, I want an alert when a tenant's daily spend deviates anomalously from its recent baseline, so I can catch abuse or bugs early.
- **US-8** As a Platform Operator, I want a monthly reconciliation report comparing metered LLM/warehouse usage against the provider invoice, so metering drift is detected and bounded.
- **US-9** As a Tenant Admin, I want to see which agent consumed the most `agent_tasks_completed` and tokens, so I can evaluate agent ROI.
- **US-10** As a Workspace Owner, I want budget state visible in the UI cost panel in near-real-time (≤ 60s lag), so decisions use current data.
- **US-11** As an AI Agent (via MCP read facade), I want to query my own remaining budget for a scope, so I can degrade gracefully (smaller model, fewer steps) before a hard stop.
- **US-12** As a Platform Operator, I want an unmapped-events metric per topic, so new event types that should be metered are caught within a day.

## 3. Functional requirements

### Meter catalog
- **USG-FR-001 (Must)** The service ships a seeded, versioned meter catalog. Meters are platform-defined (no tenant-defined meters in v1):

| meter_key | Unit | Aggregation | Source event (topic · event_type) | Emitting service |
|---|---|---|---|---|
| `api_calls` | count | sum | `usage.metering.v1 · api.request_completed` | edge gateway middleware |
| `query_bytes_scanned` | bytes | sum | `query.events.v1 · query.executed` (`payload.bytes_scanned`) | query-service |
| `pipeline_minutes` | minutes (float, 2dp) | sum | `pipeline.events.v1 · pipeline_run.completed/failed` (`payload.node_minutes`) | pipeline-orchestrator |
| `storage_gb_month` | GB-month (float, 3dp) | time-weighted avg × elapsed | `usage.metering.v1 · storage.sampled` (hourly sampler) | dataset-service sampler |
| `llm_input_tokens` | tokens | sum | `ai.tool_invoked.v1` / `usage.metering.v1 · llm.request_completed` (`gen_ai.usage.input_tokens`) | ai-gateway |
| `llm_output_tokens` | tokens | sum | same event, `gen_ai.usage.output_tokens` | ai-gateway |
| `agent_tasks_completed` | count | sum | `ai.agent_run.v1 · agent_run.completed` (`payload.status='succeeded'`) | agent-runtime |

- **USG-FR-002 (Must)** Every metering record carries dimensions: `tenant_id`, `workspace_id?`, `user_id?`, `agent_id?`, `resource_urn?`, `model?` (LLM meters), `cloud` (aws|azure|gcp). Unknown dimensions are stored as NULL, never dropped.
- **USG-FR-003 (Should)** `GET /api/v1/meters` returns the catalog (key, unit, aggregation, description, dimensions) for UI/BFF consumption.
- **USG-FR-004 (Could)** Catalog additions are config-deployed (no code change); removals are forbidden (deprecate flag only).
- **USG-FR-005 (Must)** Meter units are canonical and never change post-launch (bytes not KB, tokens not "kilotokens"); any unit change is a new meter_key. Display formatting (GB, M tokens) is a client concern.

### Ingestion & aggregation
- **USG-FR-010 (Must)** Consume `usage.metering.v1`, `query.events.v1`, `pipeline.events.v1`, `ai.tool_invoked.v1`, `ai.agent_run.v1` (consumer group `usage-ingest`). Map each event to zero or more meter records via the catalog's source-event mapping.
- **USG-FR-011 (Must)** Ingestion is idempotent: dedup on `event_id` via Redis `SETNX` (24h TTL, MASTER-FR-032) **and** a unique constraint on `(tenant_id, event_id, meter_key)` in the raw store; replays are no-ops.
- **USG-FR-012 (Must)** Raw records land in the time-series store within p95 ≤ 30s of event publish; ingest lag is a Prometheus metric with alert at > 120s for 10 min.
- **USG-FR-013 (Must)** Events failing schema/mapping validation route to `usage.metering.v1.usage-ingest.dlq` after 5 retries (MASTER-FR-033); a counter per failure reason is exported.
- **USG-FR-014 (Must)** Late events (occurred_at older than the open hourly bucket) are accepted up to 48h late and trigger re-rollup of affected buckets; events > 48h late are recorded to raw but flagged `late=true` and excluded from closed monthly rollups until the reconciliation job (USG-FR-070) re-opens them.
- **USG-FR-015 (Must)** Mapping table (event → meter records) is declarative config validated at startup: `{topic, event_type, meter_key, quantity_jsonpath, dimension_jsonpaths, filter_predicate?}`. An event matching zero mappings increments an `unmapped_events` counter (no DLQ — unmapped is legal).
- **USG-FR-016 (Should)** Backfill tooling: an operator CLI replays a topic time-range through the ingest path with dedup active, for recovering from mapping bugs; backfills are recorded in `adjustments` context and audited.

### Rollups & retention
- **USG-FR-020 (Must)** Time-series storage is **TimescaleDB** (Postgres extension — keeps DB-per-service and RLS conventions; ClickHouse is the documented alternative if a cell exceeds 2B raw rows/month, same logical schema). Continuous aggregates: raw → hourly → daily → monthly, keyed by `(tenant_id, meter_key, workspace_id, user_id, agent_id, model, cloud)`.
- **USG-FR-021 (Must)** Rollup freshness: hourly aggregates ≤ 5 min behind raw; daily finalize at 00:30 UTC; monthly finalize on the 1st at 02:00 UTC. Finalized (closed) buckets are immutable except via reconciliation adjustments (stored as separate signed adjustment rows, never in-place edits).
- **USG-FR-022 (Must)** Retention per tier: raw 90 days · hourly 13 months · daily 3 years · monthly 7 years. Enforced by Timescale retention policies; documented per table (§4).
- **USG-FR-023 (Must)** All rollup tables are hypertables partitioned by time (1-month chunks) per MASTER-FR-062.

### Budgets
- **USG-FR-030 (Must)** Budget CRUD. A budget = `{scope: {tenant_id, workspace_id?, user_id?, agent_id?}, meter_key | 'usd_total', window: calendar_month | calendar_day | rolling_7d, limit (numeric in meter unit or USD), thresholds: [80, 95, 100] (fixed set v1), action_at_100: alert_only | hard_stop}`.
- **USG-FR-031 (Must)** Budget evaluation runs on every hourly rollup refresh and on-demand after high-velocity meters update (LLM meters evaluated every ≤ 60s via incremental counters in Redis). Crossing a threshold emits exactly one event per (budget, window-instance, threshold): `budget.threshold` at 80/95, `budget.exhausted` at 100 — to `usage.events.v1`.
- **USG-FR-032 (Must)** `budget.exhausted` with `action_at_100=hard_stop` is consumed by ai-gateway (contract: ai-gateway rejects LLM calls in scope with error code `BUDGET_EXHAUSTED` until window reset or limit raise). usage-service also serves `GET /api/v1/budgets/:id/state` and a bulk `GET /api/v1/budget-states?scope=` for gateway warm-up/resync.
- **USG-FR-033 (Must)** Window reset (new month/day) emits `budget.reset`; raising a limit above current consumption emits `budget.reset` immediately.
- **USG-FR-034 (Should)** Overlapping budgets are allowed; the most restrictive exhausted budget wins for enforcement. Deleting a budget that is currently exhausted emits `budget.reset`.
- **USG-FR-035 (Should)** Budget state changes fan out to realtime-hub (via `usage.events.v1`) so the UI cost panel updates without polling.

### Showback & chargeback
- **USG-FR-040 (Must)** Showback API: `GET /api/v1/reports/usage` with params `group_by` (any of tenant|workspace|user|agent|meter|model|day|month), `from`, `to`, `meter_key?`, `workspace_id?`, cursor-paginated. Values returned in meter units and, when a rate card exists, USD.
- **USG-FR-041 (Must)** CSV export: same endpoint with `Accept: text/csv` streams CSV (no buffering; RFC 4180; header row = group-by keys + unit + quantity + usd). Exports > 100K rows return `202 {operation_id}` and deliver via signed object-storage URL (MASTER-FR-027).
- **USG-FR-042 (Must)** Rate cards: a default platform rate card (per meter: `{meter_key, price_per_unit_usd, effective_from}` versions) plus per-tenant override rate cards. Price resolution: tenant override if present at usage time, else default effective at usage time. Historical rate-card versions are immutable.
- **USG-FR-043 (Must)** Chargeback report: `GET /api/v1/reports/chargeback?month=YYYY-MM` returns priced monthly rollups per tenant/workspace with rate-card version references; only available for finalized months.
- **USG-FR-044 (Should)** Rate card CRUD is platform-operator-only (`usage.ratecard.write` action); all changes audited with before/after digests (MASTER-FR-040).

### Anomaly detection
- **USG-FR-050 (Must)** Daily job (01:00 UTC, after daily finalize): per (tenant, meter), compute z-score of yesterday's daily total against the trailing 28-day mean/stddev (minimum 7 days of history; else skip). |z| ≥ 3 emits `usage.anomaly_detected` to `usage.events.v1` with `{meter_key, scope, observed, mean, stddev, z}`; notification-service subscribes.
- **USG-FR-051 (Should)** Zero-usage days after ≥ 14 active days also flag (z on log1p-transformed series handles this); anomalies are queryable via `GET /api/v1/anomalies` and dismissible (`POST /api/v1/anomalies/:id/dismiss`, audited).
- **USG-FR-052 (Could)** Per-workspace granularity behind feature flag `usage.anomaly.workspace_scope`.

### Reconciliation
- **USG-FR-070 (Must)** Monthly reconciliation job ingests provider bill exports (AWS CUR / Azure Cost export / GCP billing export / LLM provider usage CSVs) dropped in a configured object-storage prefix, maps line items to meters via a static mapping table, and produces a variance report per (tenant?, meter, month): metered vs billed, absolute and % variance.
- **USG-FR-071 (Must)** Variance > 5% on any LLM meter or > 10% on infra meters raises `usage.reconciliation_variance` event and marks the month `reconciliation_status=variance` (blocking chargeback export until an operator records an adjustment or acknowledges).
- **USG-FR-072 (Should)** Operator adjustments (`POST /api/v1/adjustments`) create signed adjustment rows on closed months with mandatory reason; adjustments appear as distinct lines in chargeback output.

### Decision-linked cost & ROI

The platform's cost thesis (make every AI call attributable to a business decision so ROI is measurable and unit-economics are visible) requires usage-service to be the source of truth for **cost per decision** and **ROI per pack/agent/workspace**. All requirements below stack on the metering pipeline above; they do not replace it.

- **USG-FR-080 (Must)** Consume `decision_urns[]` from `ai.token_usage.v1` (contract with ai-gateway §AIG-FR-089): when present, split the cost of the metered call evenly across the listed URNs and insert one row per URN into a new `usage_decisions` hypertable `{time, tenant_id, decision_urn, decision_kind (case|chart|proposal|other), workspace_id, agent_id?, model?, cost_usd, input_tokens, output_tokens, savings_usd_est?, cached bool, handler text?}`. URNs are opaque — the service does not resolve them to their objects except for `decision_kind` derived from the URN prefix segment.
- **USG-FR-081 (Must)** Maintain a `decisions` fact table `{decision_urn PK, tenant_id, kind, workspace_id, agent_id?, created_at, resolved_at?, resolution_verdict? text, value_usd numeric NULL, source_service text}` populated by consuming `case.events.v1 :: case.created/resolved`, `chart.events.v1 :: chart.viewed` (sampled 1%), and `agent.events.v1 :: proposal.approved`. `value_usd` is set when the source emits it (case-service on `case.resolved` carries `recovered_value_usd` for insurance/AML/collections packs); otherwise NULL and treated as "unknown value" (never zero).
- **USG-FR-082 (Must)** New showback endpoint `GET /api/v1/reports/decisions` — params: `group_by` (any of decision_kind|workspace|agent|pack|model|day|month), `from`, `to`, `workspace_id?`, `pack?`, cursor-paginated. Response fields per group: `decisions_count`, `total_cost_usd`, `mean_cost_usd`, `p50_cost_usd`, `p95_cost_usd`, `total_value_usd`, `roi (total_value_usd / total_cost_usd, null when total_value_usd unknown)`, `savings_usd_est` (sum of gateway savings estimates). CSV export via `Accept: text/csv` per USG-FR-041.
- **USG-FR-083 (Must)** New MCP tool `usage.get_decision_cost(decision_urn) → {cost_usd, input_tokens, output_tokens, cached, handler?, savings_usd_est?, first_call_at, last_call_at, source_calls_count}` for inline UI hovers on cases, charts, and proposals (per MASTER-FR-097). Tenant-scoped; cross-tenant URN → `NOT_FOUND`.
- **USG-FR-084 (Should)** **Pack ROI benchmarks.** `POST /api/v1/packs/{pack_id}/benchmarks/publish?workspace_id=` — workspace-admin action that computes and publishes an aggregate row `{avg_cost_per_decision, median_cost_per_decision, avg_time_to_resolution_seconds, override_rate, roi_multiplier, sample_size}` to pack-service `POST /packs/{id}/versions/{v}/benchmarks` (BRD 23 §PKG-FR-054). Never emits row-level data. Requires workspace-admin explicit opt-in (default off); revocable.
- **USG-FR-085 (Should)** Anomaly detection additions for decision cost: per (tenant, agent_id, day), z-score of mean cost-per-decision against the trailing-28-day baseline; |z| ≥ 3 emits `usage.decision_cost_anomaly` — surfaces "agent got 5× more expensive since Monday" without waiting for a budget threshold to fire.
- **USG-FR-086 (Should)** Workspace-level "cost-per-decision" widget served by BFF from `GET /api/v1/reports/decisions?group_by=day&workspace_id=…&from=now-30d`; result cache 60s; used by the UI cost panel (§MASTER-FR-097).

## 4. Domain model & data

Postgres 16 + TimescaleDB. All tables carry `tenant_id, created_at, updated_at` and RLS per MASTER-FR-001 (platform-operator endpoints use a `app.tenant_id = '*'` bypass role, audited).

| Table | Key columns | Notes |
|---|---|---|
| `meters` | `meter_key PK, unit, aggregation, description, dimensions text[], deprecated bool` | seeded, global (no tenant_id) |
| `usage_raw` (hypertable) | `time timestamptz, tenant_id, meter_key, quantity numeric(20,6), workspace_id?, user_id?, agent_id?, model?, cloud, resource_urn?, event_id uuid, late bool` | UNIQUE `(tenant_id, event_id, meter_key)`; retention 90d; chunk 1mo |
| `usage_hourly/daily/monthly` (continuous aggregates) | bucket time + dimension cols + `quantity_sum` | retention 13mo / 3y / 7y; `finalized_at` on daily/monthly |
| `budgets` | `id uuidv7, tenant_id, scope_workspace_id?, scope_user_id?, scope_agent_id?, meter_key, window, limit_value numeric, action_at_100, status active|deleted` | soft delete |
| `budget_states` | `budget_id, window_start, consumed numeric, last_threshold int (0/80/95/100), exhausted_at?` | UNIQUE `(budget_id, window_start)` |
| `rate_cards` | `id, tenant_id NULL for default, version int, effective_from date, status draft|active|superseded` | immutable once active |
| `rate_card_items` | `rate_card_id, meter_key, price_per_unit_usd numeric(14,8)` | |
| `anomalies` | `id, tenant_id, meter_key, day, observed, mean, stddev, z, status open|dismissed, dismissed_by?` | index `(tenant_id, status, day desc)` |
| `reconciliations` | `id, month, provider, status pending|matched|variance|adjusted|acknowledged, report_uri` | monthly |
| `adjustments` | `id, tenant_id, meter_key, month, quantity_delta, usd_delta, reason text NOT NULL, actor` | append-only |
| `outbox` | standard transactional outbox (MASTER-FR-034) | |

**Indexes:** `usage_raw (tenant_id, meter_key, time desc)`; each aggregate `(tenant_id, meter_key, bucket desc)` plus `(tenant_id, workspace_id, bucket)` and `(tenant_id, agent_id, bucket)` for agent showback; `budgets (tenant_id, status)`; `anomalies (tenant_id, status, day desc)`.

**State machine — budget window:**
```
ok --consumed≥80%--> warned_80 --≥95%--> warned_95 --≥100%--> exhausted
 ^                                                              |
 +---- window rollover / limit raised / budget deleted ---------+  (emits budget.reset)
```
Transitions are forward-only within a window; guard: threshold events emitted exactly once (SELECT … FOR UPDATE on the `budget_states` row). **State machine — reconciliation month:** `pending → matched | variance → adjusted | acknowledged`; chargeback export allowed only from `matched | adjusted | acknowledged`.

## 5. API specification

Base `/api/v1`. AuthZ actions: `usage.report.read`, `usage.budget.read/write`, `usage.ratecard.read/write`, `usage.anomaly.read/write`, `usage.reconciliation.read/write` (last two platform-operator only).

| Method & path | Purpose | Errors |
|---|---|---|
| `GET /meters` | meter catalog | — |
| `GET /reports/usage` | showback rollups (params §USG-FR-040); CSV via Accept header | `VALIDATION_FAILED` (bad group_by/range > 400 days) |
| `GET /reports/chargeback?month=` | priced monthly report | `CONFLICT` (month not finalized/variance-blocked) |
| `POST /budgets` · `GET /budgets` · `GET/PATCH/DELETE /budgets/:id` | budget CRUD (Idempotency-Key on POST) | `VALIDATION_FAILED` (limit ≤ 0, unknown meter), `NOT_FOUND` |
| `GET /budgets/:id/state` · `GET /budget-states?scope=` | current window state (gateway resync) | `NOT_FOUND` |
| `POST /rate-cards` · `POST /rate-cards/:id/activate` · `GET /rate-cards` | rate card mgmt | `CONFLICT` (activate superseded) |
| `GET /anomalies` · `POST /anomalies/:id/dismiss` | anomaly review | `NOT_FOUND` |
| `GET /reconciliations` · `POST /adjustments` · `POST /reconciliations/:id/acknowledge` | reconciliation ops | `PERMISSION_DENIED` |

Example — `GET /reports/usage?group_by=workspace,meter&from=2026-06-01&to=2026-06-30`:
```json
{"data":[{"workspace_id":"ws-7","meter_key":"llm_input_tokens","unit":"tokens","quantity":18234412,"usd":36.47}],
 "page":{"next_cursor":"…","has_more":true}}
```

Example — create a hard-stop budget:
```json
POST /api/v1/budgets   (Idempotency-Key: 7c1e…)
{"scope":{"workspace_id":"ws-7"},"meter_key":"llm_input_tokens","window":"calendar_month",
 "limit_value":50000000,"action_at_100":"hard_stop"}
→ 201
{"id":"b-1","scope":{"tenant_id":"t-42","workspace_id":"ws-7"},"meter_key":"llm_input_tokens",
 "window":"calendar_month","limit_value":50000000,"thresholds":[80,95,100],
 "action_at_100":"hard_stop","status":"active","created_at":"2026-07-01T09:00:00Z"}
```

Example — budget state (gateway resync): `GET /budgets/b-1/state` →
```json
{"budget_id":"b-1","window_start":"2026-07-01","consumed":50100000,"limit":50000000,
 "last_threshold":100,"exhausted_at":"2026-07-08T14:02:11Z","action":"hard_stop"}
```

Example — chargeback line (finalized month):
```json
{"tenant_id":"t-42","workspace_id":"ws-7","month":"2026-06","meter_key":"llm_input_tokens",
 "quantity":812004411,"rate_card_id":"rc-t42-v3","price_per_unit_usd":0.000002,"usd":1624.01,
 "adjustments_usd":-12.40,"total_usd":1611.61}
```

**Error semantics per endpoint (non-obvious):** `POST /budgets` returns `VALIDATION_FAILED` with per-field details for unknown `meter_key`, non-positive limit, or a scope not visible to the caller (workspace in another tenant → `404` per master). `GET /reports/chargeback` returns `CONFLICT {details:{reason:"reconciliation_variance"|"month_open"}}`. `POST /adjustments` on an open month → `CONFLICT {details:{reason:"month_open"}}`. All report endpoints enforce per-tenant concurrency cap of 4 simultaneous heavy report queries (`RATE_LIMITED` beyond).

## 6. Events

**Emitted** on `usage.events.v1` (envelope per MASTER-FR-031; `resource_urn` = the budget/anomaly/reconciliation URN):
- `budget.threshold` — `{budget_id, scope: {tenant_id, workspace_id?, user_id?, agent_id?}, meter_key, threshold: 80|95, consumed, limit, window_start}`
- `budget.exhausted` — same fields + `{action: alert_only|hard_stop}` (consumed by ai-gateway for admission control, notification-service, UI via realtime-hub)
- `budget.reset` — `{budget_id, window_start, reason: window_rollover|limit_raised|budget_deleted}`
- `budget.created / budget.updated / budget.deleted` — full budget snapshot + before/after digests (MASTER-FR-040)
- `usage.anomaly_detected` — `{anomaly_id, meter_key, scope, day, observed, mean, stddev, z}`
- `usage.reconciliation_variance` — `{reconciliation_id, month, provider, meter_key, metered, billed, variance_pct}`
- `usage.month_refinalized` — `{month, affected_meters[], chargeback_report_version}`
- `ratecard.activated` — `{rate_card_id, tenant_id?, version, effective_from}`
- `adjustment.recorded` — `{adjustment_id, month, meter_key, quantity_delta, usd_delta, reason}`

**Consumed:** `usage.metering.v1`, `query.events.v1`, `pipeline.events.v1`, `ai.tool_invoked.v1`, `ai.agent_run.v1` — handler pipeline: envelope validate → mapping lookup (USG-FR-015) → dedup (Redis + unique constraint) → raw insert → incremental Redis counters for LLM budget scopes → (outbox for any resulting budget event). Replay-safe end to end.

**Producer contract imposed on emitting services** (validated in contract tests, MASTER-FR-070): metering-relevant events MUST carry `tenant_id`, `workspace_id` where the resource is workspace-scoped, `gen_ai.usage.*` token fields on all LLM completions (ai-gateway), `bytes_scanned` on query completion (query-service), `node_minutes` per node on pipeline terminal events (pipeline-orchestrator), and dual attribution (`actor` + `via_agent`) per MASTER-FR-041 so agent showback is possible.

## 7. Business rules & edge cases

- **BR-1** Threshold events fire exactly once per (budget, window, threshold); concurrent evaluators serialize on the `budget_states` row lock.
- **BR-2** Consumption may legitimately exceed limit (in-flight requests at exhaustion); overage is reported, never clipped. Enforcement latency budget: ≤ 60s from crossing to gateway rejection.
- **BR-3** `storage_gb_month` uses hourly samples: monthly value = mean(samples) × 1.0 GB-months; missing samples interpolate from neighbors, > 24h gap flags the day for reconciliation.
- **BR-4** Deleting a workspace/user/agent does not delete usage history (dimension becomes a dangling URN — reports still render it, labeled "deleted").
- **BR-5** Rate resolution uses `occurred_at` of usage, not report time; re-pricing a closed month is only possible via adjustments.
- **BR-6** Clock skew: `occurred_at` from producers is trusted within ±5 min of broker timestamp; outside that, broker time wins and the record is flagged.
- **BR-7** Per-tenant ingest fairness: a tenant flooding metering events is throttled at 5K records/s (excess buffered, then DLQ'd with `reason=tenant_rate_exceeded`) — never blocks other tenants (partition-key isolation).
- **BR-8** Report queries cap at a 400-day range and 100K result rows synchronous; larger → async export path.
- **BR-9** Budget with scope agent_id + meter `usd_total` prices LLM meters via active rate card at evaluation time.
- **BR-10** Month finalize is idempotent and re-runnable; re-finalize after late-event re-rollup emits `usage.month_refinalized` and versions the chargeback report.
- **BR-11** Meters attributable to an agent OBO run carry BOTH `user_id` (the OBO principal) and `agent_id`; showback `group_by=user` includes agent-driven usage, `group_by=agent` isolates it — totals across either grouping must reconcile to the same sum.
- **BR-12** Budget evaluation during a Redis outage falls back to hourly-rollup evaluation (enforcement latency degrades to ≤ 5 min, alert raised); ai-gateway keeps last-known budget state meanwhile (fail-closed for already-exhausted scopes, fail-open otherwise — documented gateway contract).
- **BR-13** Timescale continuous-aggregate refresh failure does not lose data (raw is source of truth); a stuck aggregate > 30 min behind pages the on-call.
- **BR-14** Anomaly job never alerts on the first day after a budget raise or a new workspace's first 7 days (suppression rules recorded on the anomaly row as `suppressed_reason`).
- **BR-15** Decision cost splitting: a metering event listing K decision URNs writes K rows each with `cost_usd = call.cost_usd / K` — never K× the true cost. Rounding uses banker's rounding; the residual cent is assigned to the first URN.
- **BR-16** `decisions.value_usd` is monotonically single-writer: the source service owns updates and usage-service never mutates it. Late arrival of `value_usd` after a chargeback month closes triggers `usage.month_refinalized` per USG-FR-014.
- **BR-17** ROI is only computed when `total_value_usd > 0`; groups with unknown value show `roi: null` (never `∞` or `0`). CSV exports emit blank cell, not "null" text.

## 8. Dependencies

| Direction | Party | Contract |
|---|---|---|
| Upstream (Kafka in) | ai-gateway | `llm.request_completed` with `gen_ai.usage.*` tokens, model, scope dims |
| Upstream (Kafka in) | agent-runtime | `agent_run.completed` with status + attribution |
| Upstream (Kafka in) | query-service | `query.executed` with `bytes_scanned` |
| Upstream (Kafka in) | pipeline-orchestrator | terminal run events with `node_minutes` |
| Upstream (Kafka in) | dataset-service sampler / edge gateway | hourly `storage.sampled`; `api.request_completed` |
| Downstream (calls us) | ai-gateway | consumes `budget.exhausted/threshold/reset`; resync via `GET /budget-states` (p95 ≤ 50ms) |
| Downstream | bff-graphql | reports, budgets, anomalies, cost-panel queries |
| Downstream | notification-service, audit-service, realtime-hub | event consumers |

**Infra:** Postgres 16 + TimescaleDB, Kafka + Schema Registry, Redis (dedup + LLM counters), object storage (exports, provider bill drops), OPA sidecar, Temporal/cron for daily/monthly jobs. **MCP facade:** read-only tools `usage.get_report`, `usage.get_budget_state` (agent self-throttling, US-11).

## 9. NFRs (deltas from master)

- Ingest throughput: 20K metering records/s per cell sustained; burst 50K/s for 5 min without DLQ growth.
- Report read p95 ≤ 800ms for ≤ 31-day/tenant-scoped queries (relaxed from master 300ms — analytical workload); budget-state read p95 ≤ 50ms (gateway hot path).
- Budget evaluation→event p95 ≤ 60s for LLM meters; ≤ 5 min for batch meters.
- Metering accuracy: reconciliation variance ≤ 2% target on LLM meters (alert at 5%).
- Storage: raw hypertable ≤ 150GB/cell/90d at target load (compression policy after 7 days).
- Observability additions: `usage_ingest_lag_seconds`, `usage_unmapped_events_total`, `budget_eval_duration_seconds`, `budget_enforcement_latency_seconds` (crossing→event) exported; dashboards-as-code per MASTER-FR-072.

## 10. Acceptance criteria

- **AC-1** Given an `ai.tool_invoked.v1` event with 1200 input / 800 output tokens, when consumed, then `usage_raw` contains two rows (`llm_input_tokens`=1200, `llm_output_tokens`=800) with the event's tenant/workspace/user/agent/model dimensions within 30s.
- **AC-2** Given the same event replayed with an identical `event_id`, when consumed again, then no new raw rows exist and rollups are unchanged.
- **AC-3** Given a monthly workspace budget of 1,000,000 `llm_input_tokens` and consumption reaching 800,000, when the evaluator runs, then exactly one `budget.threshold` event with `threshold=80` is emitted, and re-running the evaluator emits none.
- **AC-4** Given a hard-stop budget at 100% consumed, when state is queried via `GET /budgets/:id/state`, then `last_threshold=100` and `exhausted_at` is set, and a `budget.exhausted` event with `action=hard_stop` exists on `usage.events.v1`.
- **AC-5** Given an exhausted monthly budget, when the next calendar month begins, then `budget.reset` is emitted and state shows `consumed=0, last_threshold=0`.
- **AC-6** Given June usage across 3 workspaces, when `GET /reports/usage?group_by=workspace,meter&from=2026-06-01&to=2026-06-30` is called with `Accept: text/csv`, then a streamed RFC-4180 CSV is returned whose totals equal the JSON report's totals.
- **AC-7** Given a tenant rate card pricing `llm_input_tokens` at $0.000002 and default at $0.000003, when the chargeback report for a finalized month runs, then that tenant's USD uses the override and the response references the tenant rate-card version.
- **AC-8** Given 28 days of daily spend history with mean 100 and stddev 5, when a day totals 130 (z=6), then `usage.anomaly_detected` is emitted and the anomaly appears in `GET /api/v1/anomalies` with `status=open`.
- **AC-9** Given a provider bill showing 8% more LLM tokens than metered for a month, when reconciliation runs, then the month is `reconciliation_status=variance`, `usage.reconciliation_variance` is emitted, and `GET /reports/chargeback` for that month returns `CONFLICT` until acknowledged/adjusted.
- **AC-10** Given tenant A's token, when it requests tenant B's budget by ID, then the response is `404` and a `security.cross_tenant_denied` audit event is emitted.
- **AC-11** Given an event with `occurred_at` 12h in the past, when ingested, then the affected hourly and daily (non-finalized) buckets are re-rolled and report totals include it.
- **AC-12** Given Kafka replays the last 24h of `query.events.v1` after a consumer redeploy, when processing completes, then all rollup totals are identical to pre-replay values.
- **AC-13** Given an agent OBO run that consumed 10K tokens for user u-77 via agent triage-copilot, when showback is grouped by `user` and separately by `agent`, then both groupings include the 10K tokens and the report grand totals are equal.
- **AC-14** Given Redis is unavailable for 3 minutes, when LLM usage continues, then no raw records are lost (unique-constraint dedup path holds), budget evaluation degrades to the rollup path with an alert, and Redis counters resync from rollups on recovery.
- **AC-15** Given an event with an unknown `event_type` on a consumed topic, when ingested, then it increments `usage_unmapped_events_total{topic,event_type}` and does not enter the DLQ.
- **AC-16** Given an `ai.token_usage.v1` event with `decision_urns: ["wr:t-42:case:case/c-9","wr:t-42:proposal:proposal/p-4"]` and `cost_usd=0.008`, when consumed, then two rows land in `usage_decisions` each with `cost_usd=0.004` (residual cent to the first URN) and the metering event's own `usage_raw` rows remain unchanged (§USG-FR-080 does not double-count against overall totals).
- **AC-17** Given a case with 12 metered agent calls totaling $2.61 and `case.resolved.recovered_value_usd=840`, when `GET /reports/decisions?group_by=decision_kind&from=…&to=…` is called, then `case` group returns `total_cost_usd≈2.61`, `total_value_usd=840`, `roi≈321.8`; grouping additionally by `pack` attributes the cost to the pack whose case-schema created the case.
- **AC-18** Given a workspace admin opts in and calls `POST /packs/{p}/benchmarks/publish`, when computed, then pack-service receives an aggregate benchmark row with sample_size ≥ 30 (below threshold → 409 `INSUFFICIENT_SAMPLE`) and no row-level identifiers; revoking opt-in stops future publishes but does not retract prior aggregates from pack-service (pack-service handles retraction per its own BRD).

**Delivery-specific (beyond MASTER-FR-072):** RUNBOOK.md must cover: DLQ drain for `usage-ingest`, Redis counter resync procedure, re-rollup command for a bucket range, reconciliation acknowledge flow, and budget-event replay for gateway resync. Load-test profile (50K records/s burst) ships with the Helm chart values.

## 11. Out of scope / future

Tenant-defined custom meters; real-time (< 5s) budget enforcement inside usage-service (remains gateway-side); ML-based anomaly detection (seasonal decomposition) replacing z-score; invoice generation and payment integration; per-query cost pre-estimation (query-service owns); carbon/energy meters; ClickHouse migration playbook execution (documented trigger: > 2B raw rows/month/cell).
