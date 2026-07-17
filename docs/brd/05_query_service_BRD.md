# BRD 05 — query-service

**Service:** query-service · **Language:** Go · **Phase:** 1
**Inherits:** `00_MASTER_BRD.md` · **Architecture:** `../../WINDROSE_PLATFORM_ARCHITECTURE.md` §6, §9
**V1 sources mined:** `ido/app/models/{query,saved_query,dataset}.rb` (`process_vars!`, `build_statement`, `verify_statement`), `ido/app/controllers/api/v1/queries_controller.rb` routes, Blazer-based execution, `ido/config/settings.yml` warehouse config/timeouts

---

## 1. Overview

**Purpose.** query-service is the single SQL execution broker of the platform: **saved queries with typed variables**, **safe substitution**, **engine routing** (DuckDB for small/interactive, Trino/cloud warehouse for large), **dry-run/EXPLAIN with cost estimation and enforced ceilings**, **streamed results** (Arrow internally, paginated JSON at the edge), per-tenant concurrency governance, and query history. Every consumer — UI SQL editor, chart-service, semantic-service compiled SQL, the analytics agent — executes through this one service.

**Business value.** V1 executed SQL via Blazer inside the Rails monolith with three systemic defects this BRD designs out: (1) **the `process_vars!` bug** — `Query.process_vars!` quoted variable values with the *local Rails Postgres* connection's quoting rules regardless of the target dialect, spliced them into the SQL string with `gsub`, and — due to a `return` inside its loop — substituted **only the first variable**, leaving later `{var}` placeholders raw in the shipped SQL. String splicing + wrong-dialect quoting is an injection and tenant-safety hazard; the rebuild forbids string interpolation of values entirely. (2) DML "denial" by regex (`delete|insert|update` match) — trivially bypassable; replaced with AST-level statement classification. (3) No cost controls: `limit: 0` full-result fetches with a 1 600s timeout.

**In scope:** saved-query CRUD + versions; typed variable declarations; execution API (sync small / async streamed); routing rules; dry-run + cost ceilings; result streaming and caps; result cache; concurrency caps; history; MCP read tools.

**Out of scope:** SQL generation from metrics (semantic-service); federated queries against customer source databases (ingestion pulls them into the lakehouse first); dashboards/rendering (chart-service); notebook sessions.

## 2. Actors & user stories

Personas: **Analyst (AN)**, **Data Engineer (DE)**, **Chart-service (CH)**, **Semantic-service/Analytics agent (AG)**, **Tenant Admin (TA)**, **Platform Operator (OP)**.

- **US-1** As an AN, I write SQL against a dataset using logical table refs (`{{dataset('Orders')}}`, `{{dataset('Orders', version=7)}}`) and run it without knowing physical Iceberg paths.
- **US-2** As an AN, I save a query with declared variables (`:region string`, `:since date`) and re-run it with different values; a missing or mistyped value is rejected before execution.
- **US-3** As a DE, I dry-run a heavy query and see estimated scan bytes and partition pruning before paying for it.
- **US-4** As an AN, my 200MB result streams into the UI grid page by page; I never wait for the whole set.
- **US-5** As CH, I execute compiled aggregation SQL with a result-shape contract (columns/types/rows) and get sub-second responses for cached/small queries.
- **US-6** As AG, I execute agent-generated SQL that is force-routed through dry-run, cost ceiling, injected row limit, and read-only enforcement.
- **US-7** As a TA, I cap concurrent queries and per-query scan bytes for my tenant's analysts and see who ran what in history.
- **US-8** As an AN, I cancel a long-running query and get partial-cost accounting.
- **US-9** As a DE, I export a result set to CSV/Parquet delivered as a time-limited download link.
- **US-10** As an OP, I identify the top-N most expensive queries per tenant this week from history.

## 3. Functional requirements

### Saved queries & typed variables
- **QRY-FR-001 (Must)** Saved-query CRUD: `{name, description, sql_text, variables[], default_engine_hint?, dataset_refs[] (resolved), tags[], module_names[] (≥1, V1 SavedQuery rule)}`. Name unique per workspace. Every update creates an immutable `saved_query_versions` row; execution can pin `?query_version=`.
- **QRY-FR-002 (Must)** Variable declaration: `{name, type ∈ (string, integer, decimal, boolean, date, timestamp, string_list, integer_list), required (default true), default?, allowed_values?, min?/max?}`. SQL references variables **only** as named placeholders `:name`. The legacy `{var}` syntax is rejected at save time with a migration hint.
- **QRY-FR-003 (Must)** **Safe substitution — no string interpolation of values, ever.** At execution, values are validated against declared types/constraints, then passed to the engine as **bound parameters** (Trino `EXECUTE … USING` / DuckDB prepared statements / warehouse driver params). List types bind as arrays or safely expanded parameter sets. There is no code path that concatenates a user value into SQL text; CI includes a static check + a fuzz test asserting `'; DROP TABLE` round-trips as data. *(Designs out the V1 `process_vars!` defect: wrong-dialect `ActiveRecord::Base.connection.quote`, `gsub` splicing, and first-variable-only substitution.)*
- **QRY-FR-004 (Must)** **All** declared required variables must be supplied; unknown variables in the payload → 422; a placeholder in SQL without a declaration → 422 at save time (V1 failed at run time with "param missing" for the first var only).
- **QRY-FR-005 (Must)** Dataset references: `{{dataset('<name>'|'<urn>', version?)}}` resolve via dataset-service (cached, ETag) to fully qualified Iceberg tables at plan time; unresolved refs → 422 `DATASET_NOT_FOUND`. Direct physical table names outside the tenant's namespaces are rejected (BR-2).
- **QRY-FR-006 (Should)** Ad-hoc execution (`POST /sql/run`) accepts inline SQL + inline variable declarations under the same safety rules; ad-hoc runs are recorded in history but not saved.

### Statement safety
- **QRY-FR-020 (Must)** SQL is parsed to an AST before execution. Only a single `SELECT` (incl. CTEs, set ops) is allowed on the user path. `INSERT/UPDATE/DELETE/MERGE/CREATE/DROP/ALTER/GRANT/CALL/SET/EXPLAIN ANALYZE` → 403 `STATEMENT_NOT_ALLOWED` (replaces V1 regex `verify_statement`). Multi-statement batches rejected.
- **QRY-FR-021 (Must)** Identifier-level tenant guard: every referenced table after resolution must be within the tenant's catalog namespaces; system catalogs are blocked except a whitelisted `information_schema` subset scoped by the engine's session catalog/schema.
- **QRY-FR-022 (Must)** For `caller_class=agent` requests: mandatory dry-run first, mandatory `LIMIT` injection (`min(requested, 10 000)`) when the outermost query lacks one, and stricter ceilings (§ QRY-FR-044).

### Execution brokering & routing
- **QRY-FR-040 (Must)** Engines: `duckdb` (in-service pool reading Iceberg directly), `trino` (cluster), `warehouse` (Athena/BigQuery/Synapse per cell cloud). Routing decision at plan time: DuckDB when estimated scan ≤ 500MB **and** referenced datasets' total size ≤ 5GB **and** no engine-specific syntax; else Trino; `warehouse` when Trino is unavailable in the cell or the tenant is configured `warehouse_primary`. `engine_hint` may downgrade to a bigger engine but never force DuckDB above thresholds. Decision + reasons recorded in history.
- **QRY-FR-041 (Must)** `POST /sql/dry-run` and implicit pre-execution planning return `{engine, estimated_scan_bytes, estimated_rows?, partitions_pruned, warnings[], ceiling_verdict}` using EXPLAIN + Iceberg stats. Estimates marked `confidence: high|low`.
- **QRY-FR-042 (Must)** Enforced ceilings (tenant-tier defaults, TA-configurable down, platform max): `max_scan_bytes` (default 50GB, agent 5GB), `max_runtime` (default 300s interactive, 1 600s async — V1 timeout preserved as the async cap), `max_result_bytes` (default 1GB, agent 50MB), `max_result_rows` (default 5M, agent 10K). Pre-execution breach → 422 `COST_CEILING_EXCEEDED` with the estimate; runtime breach → kill + status `ceiling_exceeded`.
- **QRY-FR-043 (Must)** Execution modes: **sync** (`?mode=sync`, only when plan says small: ≤10s expected, ≤10MB; else 409 suggesting async) and **async** (default): `202 {execution_id}` + status stream via realtime-hub; results fetched page-wise when `succeeded`.
- **QRY-FR-044 (Must)** Per-tenant concurrency caps: default 10 concurrently `running` (agent-class sub-cap 3); excess queues FIFO up to 50 with `queue_position` surfaced; queue overflow → 429 `RATE_LIMITED`. Per-user fairness: one user may hold at most half the tenant slots.
- **QRY-FR-045 (Must)** `POST /executions/{id}/cancel` propagates engine kill ≤ 5s; status `cancelled` with bytes-scanned-so-far recorded.
- **QRY-FR-046 (Should)** Result cache: key `(tenant, sql_fingerprint, bound_params_hash, dataset_versions)`; TTL 15 min; automatically invalidated because the key pins dataset versions. `?cache=false` bypass. Cache hits recorded in history with `cache_hit=true`.

### Results
- **QRY-FR-060 (Must)** Internal result format is **Apache Arrow**: engines stream Arrow batches to result storage (object storage, tenant-prefixed, `results/<tenant>/<execution_id>/part-*.arrow`), never fully materialized in service memory (bounded batch buffer ≤ 64MB per execution).
- **QRY-FR-061 (Must)** Edge delivery: `GET /executions/{id}/results?limit≤10 000&cursor=` returns paginated JSON `{columns:[{name,type}], rows:[[…]], page:{next_cursor, has_more}, stats}`. Internal consumers (chart-service, semantic-service, BFF) may request `Accept: application/vnd.apache.arrow.stream` for zero-copy transfer.
- **QRY-FR-062 (Must)** Result retention: 24h then GC (history row persists). `POST /executions/{id}/export {format: csv|parquet}` produces a signed URL (24h expiry, V1 download parity).
- **QRY-FR-063 (Must)** Type mapping for the JSON edge (Arrow → JSON), applied uniformly for every consumer:

| Arrow type | JSON representation | Note |
|---|---|---|
| int8/16/32, float32/64 | number | NaN/±Inf → null + column warning (V1 client silently treated as 0) |
| int64/uint64 | number if |v| < 2^53 else string | lossless guarantee |
| decimal(p,s) | string | no float rounding |
| bool | boolean | |
| date | "YYYY-MM-DD" | |
| timestamp | ISO-8601 UTC with `Z` | |
| binary | base64 string | |
| list/struct/map | JSON array/object | nested types preserved |
| null column | null | column type reported as declared |

### History
- **QRY-FR-080 (Must)** Every execution (incl. dry-runs, cache hits, failures) records: sql_fingerprint, full SQL text (compressed), bound param values **redacted for columns tagged PII**, engine, routing reason, ceilings applied, bytes scanned, rows returned, duration, status, actor + `via_agent`, trace_id. Queryable: `GET /executions?status=&user=&saved_query_id=&since=&sort=-cost`.
- **QRY-FR-081 (Should)** Aggregated stats endpoint for TA/OP: top queries by scan bytes, failure rates, per-user consumption over a window.

## 4. Domain model & data

### 4.1 Tables (Postgres, RLS)

**saved_queries** — `id uuidv7 PK`, `tenant_id`, `workspace_id`, `name`, `description`, `current_version_no int`, `tags text[]`, `module_names text[] CHECK (cardinality ≥ 1)`, `created_by`, timestamps, `deleted_at`. `UNIQUE (tenant_id, workspace_id, lower(name)) WHERE deleted_at IS NULL`.

**saved_query_versions** — `id`, `tenant_id`, `saved_query_id FK`, `version_no int`, `sql_text text NOT NULL`, `variables jsonb NOT NULL` (validated array of declarations, ≤16KB), `dataset_refs jsonb`, `created_by`, `created_at`. `UNIQUE (saved_query_id, version_no)`. Immutable.

**executions** — `id uuidv7 PK`, `tenant_id`, `workspace_id`, `saved_query_id NULL`, `query_version_no NULL`, `sql_fingerprint text`, `sql_text_compressed bytea`, `bound_params jsonb (redacted)`, `caller_class text (user|service|agent)`, `engine text`, `routing_reason jsonb`, `status text`, `queue_position int NULL`, `estimated_scan_bytes bigint`, `actual_scan_bytes bigint`, `result_rows bigint`, `result_bytes bigint`, `result_uri text NULL`, `cache_hit bool DEFAULT false`, `error jsonb`, `ceilings jsonb`, `started_at`, `finished_at`, `created_by`, `via_agent jsonb NULL`, `trace_id`, `created_at`.
Indexes: `(tenant_id, created_at DESC)`, `(tenant_id, status) WHERE status IN ('queued','running')`, `(tenant_id, saved_query_id, created_at DESC)`, `(tenant_id, sql_fingerprint)`. **Monthly partitions; 13-month retention → Iceberg archive.**

**tenant_query_limits** — `tenant_id PK`, overrides jsonb (validated against platform maxima), `updated_by`, timestamps.

Plus `outbox`, `idempotency_keys`. Redis: concurrency slots (`SETNX`-based token buckets), result cache index, queue.

### 4.2 Execution state machine

| From | To | Trigger | Guard |
|---|---|---|---|
| created | planning | request accepted | payload valid, variables typed OK |
| planning | rejected | safety/ceiling/validation failure | verdict recorded in `error` |
| planning | queued | plan OK, no free slot | queue depth < 50 (else 429, no row transition) |
| planning | running | plan OK, slot free | tenant + per-user + agent-class slots acquired |
| queued | running | slot freed (FIFO) | same slot guards |
| running | streaming_results | first Arrow batch persisted | — |
| streaming_results | succeeded | engine EOF, parts sealed | result manifest written |
| running / streaming_results | failed | engine error | error categorized |
| running / streaming_results | cancelled | user/tenant-suspend cancel | engine kill confirmed ≤5s |
| running / streaming_results | ceiling_exceeded | runtime/scan/result cap breach | kill + partial accounting |

Terminal: `succeeded, failed, cancelled, rejected, ceiling_exceeded`. Illegal transition → 409.

### 4.3 Routing decision table (evaluated top-down at plan time)

| Condition | Engine | Recorded reason |
|---|---|---|
| tenant configured `warehouse_primary` | warehouse | `tenant_policy` |
| est. scan ≤ 500MB ∧ total referenced dataset size ≤ 5GB ∧ dialect-portable | duckdb | `small_interactive` |
| Trino healthy in cell | trino | `default_large` |
| Trino unhealthy | warehouse | `engine_fallback` (+ response warning) |

`engine_hint` may promote duckdb→trino/warehouse; a hint of duckdb above thresholds is ignored with warning `HINT_OVERRIDDEN`.

### 4.4 Error code catalog

`VALIDATION_FAILED` (422) · `VARIABLE_INVALID` (422, per-variable details) · `COST_CEILING_EXCEEDED` (422 plan-time) · `STATEMENT_NOT_ALLOWED` (403) · `DATASET_NOT_FOUND` (422/404) · `USE_ASYNC` (409 sync refusal) · `NOT_FOUND` (404, incl. cross-tenant) · `CONFLICT` (409: results not ready, terminal cancel, stale If-Match) · `GONE` (410 results expired) · `RATE_LIMITED` (429 queue overflow) · `ENGINE_UNAVAILABLE` (503, all engines down for this plan).

## 5. API specification (base `/api/v1`)

| Method & path | Purpose | Notable errors |
|---|---|---|
| `POST /queries` · `GET /queries` · `GET /queries/{id}` · `PATCH /queries/{id}` · `DELETE /queries/{id}` | saved-query CRUD (PATCH bumps version) | 409 name, 422 undeclared placeholder / legacy `{var}` syntax |
| `GET /queries/{id}/versions` | version list | |
| `POST /queries/{id}/run` | execute saved query `{variables:{}, mode?, engine_hint?, limit?}` | 422 VARIABLE_INVALID / COST_CEILING_EXCEEDED, 403 STATEMENT_NOT_ALLOWED, 429 |
| `POST /sql/run` | ad-hoc execute `{sql, variables?, declarations?}` | same |
| `POST /sql/dry-run` | plan + estimate only | 422 with estimate details |
| `GET /executions` · `GET /executions/{id}` | history / status | |
| `GET /executions/{id}/results` | paginated JSON or Arrow stream (Accept) | 409 not succeeded, 410 results expired |
| `POST /executions/{id}/cancel` | cancel | 409 terminal |
| `POST /executions/{id}/export` | CSV/Parquet signed URL | 410 |
| `GET /stats/queries` | TA/OP aggregates | 403 |

Example — run with typed variables:
```json
POST /api/v1/queries/018f…/run
{"variables":{"region":"EMEA","since":"2026-06-01"},"mode":"async"}
→ 202 {"data":{"execution_id":"018f…","status":"queued","queue_position":0,
       "plan":{"engine":"duckdb","estimated_scan_bytes":41231204,"ceiling_verdict":"ok"}}}
```
Error — injection attempt as value: `{"variables":{"region":"x' OR '1'='1"}}` → executes safely as a bound literal; matching rows: none. Error — undeclared variable: 422 `{"error":{"code":"VARIABLE_INVALID","details":[{"name":"regoin","problem":"not declared"}]}}`.

Example — dry-run response:
```json
POST /api/v1/sql/dry-run
{"sql":"SELECT region, sum(order_total) FROM {{dataset('Orders')}} GROUP BY 1","variables":{}}
→ 200 {"data":{"engine":"trino","estimated_scan_bytes":21474836480,"estimated_rows":6,
 "partitions_pruned":"312/365","confidence":"high",
 "ceiling_verdict":"ok","ceilings":{"max_scan_bytes":53687091200,"max_runtime_s":300},
 "warnings":[]}}
```

Example — results page:
```json
GET /api/v1/executions/018f…/results?limit=2
→ 200 {"data":{"columns":[{"name":"region","type":"string"},{"name":"revenue","type":"decimal"}],
 "rows":[["EMEA","1284211.50"],["AMER","2011870.25"]],
 "page":{"next_cursor":"b2Zmc2V0OjI","has_more":true},
 "stats":{"result_rows":6,"actual_scan_bytes":19834211122,"duration_ms":8412,"engine":"trino","cache_hit":false}}}
```

Example — saved-query variable declarations:
```json
POST /api/v1/queries
{"name":"Orders by region","module_names":["insights"],
 "sql_text":"SELECT region, count(*) c FROM {{dataset('Orders')}} WHERE region = :region AND order_date >= :since GROUP BY 1",
 "variables":[{"name":"region","type":"string","required":true,"allowed_values":["EMEA","AMER","APAC"]},
              {"name":"since","type":"date","required":false,"default":"2026-01-01"}]}
→ 201 (version_no: 1)
```

**MCP facade (read tier):** registered in tool-registry with JSON Schema I/O and argument constraints enforced by the MCP gateway:

| Tool | Args (constraints) | Returns |
|---|---|---|
| `list_saved_queries` | `q?, limit ≤ 50` | query summaries (no SQL bodies over 4KB — truncated with flag) |
| `get_saved_query` | `id` | full definition incl. variable declarations |
| `dry_run_sql` | `sql ≤ 32KB, variables?` | plan, estimate, ceiling verdict |
| `run_saved_query` | `id, variables` | execution_id + first page (≤ 1 000 rows) |
| `run_sql` | `sql ≤ 32KB, variables?, declarations?` | same; forced dry-run + LIMIT injection + agent ceilings (QRY-FR-022/042) |

These are the analytics agent's **only** execution path; no bypass API exists.

## 6. Events

**Emitted → `query.events.v1`:** `query.saved/updated/deleted`, `execution.started {engine, saved_query_id?, caller_class}`, `execution.succeeded {actual_scan_bytes, result_rows, duration_ms, cache_hit}`, `execution.failed {error_code}`, `execution.cancelled`, `execution.ceiling_exceeded {ceiling, estimate, actual}`. Usage-service meters scan bytes from these; audit-service consumes all.

**Consumed:** `dataset.events.v1 :: dataset.deleted` → invalidate cached plans/results for that URN and fail queued executions referencing it (`DATASET_NOT_FOUND`); `dataset.version_created` → result-cache entries keyed to older versions naturally miss (no action) but plan caches for `latest` are invalidated; `identity.events.v1 :: tenant.suspended` → cancel queued+running executions, block new ones.

## 7. Business rules & edge cases

- **BR-1** No code path concatenates a variable value into SQL. Identifier substitution (dataset refs) uses engine-quoted identifiers from the resolver — never user-typed strings.
- **BR-2** After resolution, any table outside `bronze|silver|gold.<tenant_id>` (or tenant warehouse schema) → 403; queries cannot name another tenant's namespace even syntactically (planner rejects before engine contact).
- **BR-3** Variable coercion is strict: `"2026-6-1"` fails `date` (must be ISO-8601); numeric strings do not coerce to integers; `allowed_values` and min/max enforced pre-bind.
- **BR-4** A saved query whose `dataset_refs` point at a deprecated dataset still runs but the response carries `warnings:[DATASET_DEPRECATED]`; a deleted dataset fails with `DATASET_NOT_FOUND` (V1 silently broke).
- **BR-5** Sync mode never queues: if no slot is instantly available → 409 `USE_ASYNC`.
- **BR-6** Timeout hierarchy: statement timeout is set on the engine session; the service-side watchdog fires at ceiling+30s as backstop; both cancellation paths are idempotent.
- **BR-7** DuckDB pool isolation: one in-flight query per pooled worker process, per-worker memory cap 2GB, worker recycled after each query — a poisoned query cannot affect another tenant's execution.
- **BR-8** Estimated-vs-actual drift: if actual scan exceeds estimate ×3 and crosses the ceiling, kill (never "finish since we started"); record `confidence:low` learning signal in history.
- **BR-9** Result pagination cursors are stable (Arrow file offsets), valid until result GC; after GC → 410 with `re_run_hint`.
- **BR-10** Retry of a failed execution is a **new** execution (no in-place restart); Idempotency-Key on run endpoints dedups accidental double-submits for 24h.
- **BR-11** Concurrent PATCH of a saved query uses `If-Match` etag; version numbers never fork (per-query advisory lock).
- **BR-12** PII redaction in history: parameters bound to columns tagged `pii:*` (via dataset profile tags) store `"«redacted»"`; full values never persist in history.
- **BR-13** Engine outage degradation: Trino down → route eligible queries to warehouse with `warnings:[ENGINE_FALLBACK]`; DuckDB-eligible queries unaffected.
- **BR-14** `first`-page fetch of a succeeded execution must not require the engine (results are fully decoupled in object storage).

## 8. Dependencies

- **Upstream:** dataset-service (`GET /datasets/{id}` resolution, ETag-cached; `dataset.events.v1`), identity/rbac/OPA, Iceberg REST catalog + object storage, Trino cluster (per cell), warehouse (Athena/BigQuery/Synapse per cloud), Redis (slots, cache, queue), Kafka.
- **Downstream contracts:** chart-service executes compiled SQL via `POST /sql/run` (Arrow accept); semantic-service calls `dry-run` during compile validation; analytics agent via MCP; usage-service meters `query_scan_bytes`, `query_seconds`; realtime-hub streams execution status.
- **Libraries:** vitess/sqlparser or antlr-based dialect-aware parser (per engine), Arrow Go, ADBC/engine drivers.

## 9. NFRs (deltas from master)

Service-specific Prometheus metrics (beyond master RED set): `query_executions_total{engine,status,caller_class}`, `query_scan_bytes_total{engine}`, `query_queue_depth{tenant}`, `query_slot_wait_seconds` (histogram), `query_ceiling_rejections_total{ceiling}`, `query_cache_hits_total`, `duckdb_worker_recycles_total`, `result_gc_bytes_total`. Dashboards-as-code ship with the service (MASTER-FR-072).

- Sync small-query p95 ≤ 1.5s end-to-end (DuckDB path, warm pool); dry-run p95 ≤ 800ms.
- First result page available ≤ 2s after `succeeded`; Arrow internal throughput ≥ 200MB/s per stream.
- Planner/safety layer adds ≤ 100ms p95 overhead per execution.
- Service memory bounded: ≤ 64MB buffered per execution regardless of result size (10GB-result soak test is a release gate).
- Availability 99.95%; engine outages degrade per BR-13 without availability breach of the API itself.

## 10. Acceptance criteria

- **AC-1** Given a saved query with variables `:region string` and `:since date`, when run with both values, then the engine receives a parameterized statement (assert via engine query log: placeholders, not literals) and **both** variables are bound — a regression test named `process_vars_multi_variable` covers the V1 first-variable-only defect.
- **AC-2** Given `region = "x'; DROP TABLE users;--"`, when run, then execution succeeds treating it as a literal, no DDL occurs, and the fuzz suite passes for all declared types.
- **AC-3** Given SQL containing `DELETE FROM t` (or `select…; delete…` multi-statement, or `dElEtE` obfuscation), when run or saved, then 403 `STATEMENT_NOT_ALLOWED` from AST classification — regex-bypass corpus test passes.
- **AC-4** Given a query with a missing required variable and an extra undeclared one, then 422 listing both per-field problems in `details`.
- **AC-5** Given a query estimated at 400MB scan over a 3GB dataset, then it routes to DuckDB; given 60GB estimated, then 422 `COST_CEILING_EXCEEDED` at plan time with the estimate; given 20GB, it routes to Trino — all three routing reasons recorded in history.
- **AC-6** Given an agent-class run without a LIMIT, then the executed SQL contains an injected `LIMIT 10000`, dry-run ran first, and the 5GB agent scan ceiling applied.
- **AC-7** Given tenant cap 10 with 10 running, the 11th run is `queued` with `queue_position=1` and starts when a slot frees; the 61st (queue full) receives 429.
- **AC-8** Given a running query that exceeds `max_runtime`, then the engine statement is killed ≤ 5s after breach, status `ceiling_exceeded`, and an `execution.ceiling_exceeded` event is emitted.
- **AC-9** Given a 2M-row result, when fetched with `limit=10000` pages, then pages stream from Arrow parts with stable cursors, service RSS delta stays < 64MB, and an internal Arrow-stream fetch by chart-service returns identical data.
- **AC-10** Given the same saved query + params + dataset version run twice within 15 min, then the second is a `cache_hit=true` in history and returns identical results without engine contact; after a new dataset version, it misses.
- **AC-11** Given `POST /executions/{id}/cancel` on a running Trino query, then Trino shows the query killed, status `cancelled`, and partial `actual_scan_bytes` recorded.
- **AC-12** Given tenant A's token on tenant B's execution id (status, results, cancel), then 404 + audit event for each endpoint (isolation suite).
- **AC-13** Given results older than 24h, then `GET …/results` returns 410 and the history row remains queryable.
- **AC-14** Given a parameter bound to a column tagged `pii:email`, then the history row stores `«redacted»` for that parameter while non-PII parameters persist in clear.

## 11. Out of scope / future

Materialized-view management and automatic query rewrite; cross-engine federation of a single statement; scheduled query runs (compose ingestion-service schedules or pipeline-orchestrator); user-defined functions; write-back / DML sessions (proposal-gated, later phase); query optimization advisor; Arrow Flight SQL public endpoint (internal Arrow only in this phase).
