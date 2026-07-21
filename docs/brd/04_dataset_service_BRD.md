# BRD 04 — dataset-service

**Service:** dataset-service · **Language:** Python (FastAPI) · **Phase:** 1
**Inherits:** `00_MASTER_BRD.md` · **Architecture:** `../../DATACERN_PLATFORM_ARCHITECTURE.md` §5, §6, §9
**V1 sources mined:** `ido/app/models/{dataset,dataset_data_history,dataset_lineage}.rb`, `ido/app/controllers/api/v1/datasets_controller.rb`, `profiling-service/{app,profiler_service,data_profiler}.py`

---

## 1. Overview

**Purpose.** dataset-service is the catalog and system of record for **datasets**, their **versions** (Iceberg snapshot references), their **profiles** (stored in object storage, pointer in Postgres), and the tenant-wide **lineage graph** (URN nodes/edges). It replaces the dataset half of V1 `ido` plus the standalone Flask `profiling-service`.

**Business value.** Every consumer — query-service, semantic-service, pipeline components, the data-onboarding agent — resolves "what data exists, what shape is it, where did it come from, can I trust it" through this service. V1 pain designed out: MB-sized `data_profile` JSON blobs in Postgres, profiling run in an unsupervised Flask thread with an unauthenticated `set_profile` callback, warehouse-loading responsibilities leaking into the profiler, and a lineage table keyed on integer IDs that could not span services.

**In scope:** dataset CRUD + catalog search; dataset versions pinned to Iceberg snapshots; schema storage and evolution record; profiling orchestration (containerized profiler jobs) and the profile content contract; quality flags; lineage graph write/read APIs with activity semantics; version retention; MCP read facade.

**Out of scope:** executing user SQL (query-service); ingesting data (ingestion-service); metric definitions (semantic-service); loading data into warehouses — V1's profiler created Athena/BigQuery tables, the rebuild's warehouse views are Iceberg-native and owned by data-platform tooling.

## 2. Actors & user stories

Personas: **Data Engineer (DE)**, **Analyst (AN)**, **Data Steward (DS)**, **ML Engineer (MLE)**, **Data-Onboarding Agent (AG)**, **Platform services (SVC: ingestion, pipeline-orchestrator, inference)**.

- **US-1** As a DE, I see a new dataset appear automatically with a `processing` profile the moment my ingestion completes, and `ready` when profiling finishes.
- **US-2** As an AN, I open a dataset and read its schema, row count, null percentages, and per-column distributions without downloading anything.
- **US-3** As a DS, I search the catalog by name, column name, tag, source type, and quality flag ("show datasets with >20% nulls in any column").
- **US-4** As an MLE, I pin my training run to dataset version `v7` so retraining later uses the exact same Iceberg snapshot.
- **US-5** As a DE, I trace a model's predictions back through inference → training → transformation → ingestion to the original source connection in one lineage query.
- **US-6** As a DS, I mark a dataset deprecated with a successor pointer so downstream users are steered to the replacement.
- **US-7** As an SVC (pipeline component), I register an output dataset version and its lineage edge (`transformed`) at the end of my run via service-to-service API.
- **US-8** As an AG, I call MCP tools `search_datasets`, `get_dataset_profile`, `get_lineage` to ground onboarding proposals.
- **US-9** As a DE, I re-trigger profiling after a large append, or skip it for a bulk backfill.
- **US-10** As a DS, I restore a dataset deleted in the last 30 days, name conflicts resolved automatically (V1 `Copy of` behavior).
- **US-11** As an AN, I find datasets similar to a CSV I'm about to upload (schema/column overlap) to avoid duplicates (V1 `similar_with_schema/columns`).

## 3. Functional requirements

### Datasets & versions
- **DST-FR-001 (Must)** Dataset CRUD: `{name, description, tags[], visibility (workspace|tenant_public), iceberg_table, partition_spec}`. Name unique per workspace case-insensitively (V1 rule); `is_public` parity via `visibility=tenant_public`.
- **DST-FR-002 (Must)** Dataset status: `draft → processing → ready | failed` (state machine §4.3). `failed` requires non-null `error_log`; `ready` requires a current version (V1 invariants preserved).
- **DST-FR-003 (Must)** Every data change creates a **dataset_version**: monotonically increasing `version_no`, `iceberg_snapshot_id`, `schema jsonb` (column name → `{type, nullable, tags[]}`), `row_count`, `bytes`, `produced_by_urn` (ingestion/pipeline-run/inference-job URN), `profile_ref`, `created_at`. Versions are immutable once written.
- **DST-FR-004 (Must)** `current_version_id` points at the latest `ready` version; readers may request any retained version (`?version=`). Time-travel semantics come free via Iceberg snapshots — no `all_data_table/historical_view` string plumbing as in V1 `DatasetDataHistory`; consumers reference logical names `latest` and `as_of(version|timestamp)`.
- **DST-FR-005 (Must)** Schema evolution between consecutive versions is computed and stored as `schema_diff` (`added[], removed[], type_changed[]`); breaking changes (removed/type_changed) set flag `breaking_change=true` on the version and emit `dataset.schema_changed`.
- **DST-FR-006 (Must)** Soft-delete with 30-day restore window; restore auto-renames on conflict (`Copy of <name>`, repeated as needed — V1 behavior). Hard cleanup (Postgres rows + profile objects + Iceberg table drop) via retention job after window.
- **DST-FR-007 (Should)** Deprecation: `PATCH {lifecycle: deprecated, successor_urn?}`; deprecated datasets stay queryable, surface warnings in list/read payloads and to the analytics agent.
- **DST-FR-008 (Could)** Dataset-level custom metadata key/values (≤32 pairs, string values ≤1KB).

### Profiling orchestration
- **DST-FR-020 (Must)** On `ingestion.completed` (unless `skip_profiling`) or `POST /datasets/{id}/versions/{v}/profile`, the service launches a **containerized profiler job** (K8s Job on the `data` node pool, image `datacern/profiler`, resource-capped) parameterized by `{tenant_id, dataset_urn, version_no, iceberg_snapshot_id, sample_strategy}` — replacing V1's Flask thread + `callback_url` PUT.
- **DST-FR-021 (Must)** Profiler reads the Iceberg snapshot directly (never via presigned CSV), profiles on full data up to 10M rows, else a deterministic 10M-row sample (`sample: {strategy, fraction, seed}` recorded in the profile).
- **DST-FR-022 (Must)** Profiler writes the **profile document** (JSON, content per §4.4) and an HTML report to object storage `profiles/<tenant_id>/<dataset_id>/v<version_no>/profile.{json,html}`; only the pointer + summary land in Postgres (MASTER-FR-061; V1 stored whole profiles in `data_profile json` — designed out).
- **DST-FR-023 (Must)** Job completion is reported by the profiler via an **mTLS service-to-service** call `PUT /internal/v1/profiles/{profile_id}` (SPIFFE identity, no unauthenticated callback as V1's `set_profile`), including failure taxonomy: `EMPTY_DATA, UNNAMED_COLUMNS, SAMPLING_FAILED, OOM, TIMEOUT, INTERNAL` (V1 profiler exceptions preserved as categories).
- **DST-FR-024 (Must)** Profile lifecycle: `pending → running → completed | failed`; timeout 30 min → failed/TIMEOUT with one automatic retry; profile failure does **not** fail the dataset version — the version stays `ready` with `profile_status=failed` (data is usable without a profile; V1 marked datasets "not ready", blocking usable data — changed deliberately).
- **DST-FR-025 (Must)** Type inference contract (parity with V1 `DataProfiler._infer_column_types`, normalized to Iceberg types): profiler reports **logical types** `boolean, int, long, float, double, decimal(p,s), date, timestamp, string, categorical` plus per-column `inferred_semantic` ∈ `{id, email, phone, country, currency, url, free_text, null}`; boolean-like string columns (`Y/N`, `T/F`, `true/false` case-insensitive) are reported as `boolean` with `coercion_hint`.
- **DST-FR-026 (Should)** PII tags from ingestion (Presidio) are merged into column tags; the profiler additionally flags candidate PII columns (`pii_suspect`).
- **DST-FR-027 (Should)** `GET /datasets/{id}/profile` returns the summary + a short-lived (24h) signed URL for the full JSON and HTML report (V1 `report`/`advanced_report` endpoints parity).

### Lineage
- **DST-FR-040 (Must)** Lineage is a DAG of **URN nodes** and typed edges: `edge {from_urn, to_urn, activity, properties jsonb, occurred_at, actor}`. Activity enum: `ingested, transformed, trained, inferred, exported, derived` (V1's polymorphic `source (Ingestion|Dataset) → destination Dataset` with `edge_properties.action_name` generalized to URNs so edges can reference connections, models, pipeline runs across services).
- **DST-FR-041 (Must)** Write API `POST /lineage/edges` (service scope or user with `dataset.lineage.write`): validates URN syntax, tenant match, activity enum; duplicate edge (same from/to/activity within one producing run URN) is idempotent-upserted.
- **DST-FR-042 (Must)** Read API `GET /lineage?urn=&direction=upstream|downstream|both&depth=1..10 (default 3)&activities=` returns `{nodes[], edges[]}` breadth-first with **hard depth limit 10 and node limit 1 000**; truncation flagged `truncated=true` (V1's unbounded recursive CTE bounded by design).
- **DST-FR-043 (Must)** Edges are append-only; nodes referencing deleted resources remain (lineage is historical record). Node payload enriches URNs it owns (dataset names/status) and returns bare URNs for foreign resources.
- **DST-FR-044 (Should)** Automatic edge creation from consumed events: `ingestion.completed` → `(connection_urn|upload) -[ingested]-> dataset_version_urn`; `pipeline.run_completed` → `transformed`/`trained`; `inference.completed` → `inferred`.

### Catalog & search
- **DST-FR-060 (Must)** List/search: filter by `q` (name/description), `status`, `tags`, `source_type`, `created_by`, `has_pii`, `quality_flag`, column name; sort by `-created_at`, `name`, `row_count`. Backed by OpenSearch projection (CDC-fed); Postgres remains the source of truth and serves point reads.
- **DST-FR-061 (Must)** Similarity search (V1 parity): `POST /datasets:similar {schema: {col: type,…}} | {columns: [..]}` → ranked datasets sharing schema/columns (case-insensitive match).
- **DST-FR-062 (Must)** Catalog changes publish search events (`dataset.created/updated/deleted/restored`) for the platform search projection.
- **DST-FR-063 (Should)** `GET /datasets/{id}/consumers` — downstream lineage summary (charts, models, cases counts by service) for impact analysis before deletion; deletion of a dataset with downstream edges requires `?force=true` and emits `dataset.deleted_with_consumers`.

### Retention
- **DST-FR-080 (Must)** Per-tenant version retention policy (default: keep all versions 90 days, then keep last 10 + monthly boundary versions for 13 months). Expiring a version: expire Iceberg snapshot, delete profile objects, keep the version row with `expired=true` (schema + stats remain for history).
- **DST-FR-081 (Must)** The current version and any version pinned by a lineage `trained` edge less than 400 days old are never expired.
- **DST-FR-082 (Should)** Tenant-configurable overrides bounded by plan tier; changes audited.

## 4. Domain model & data

### 4.1 Tables (Postgres, RLS)

**datasets** — `id uuidv7 PK`, `tenant_id`, `workspace_id`, `name text NOT NULL`, `description text`, `visibility text DEFAULT 'workspace'`, `lifecycle text DEFAULT 'active' (active|deprecated)`, `successor_urn text`, `status text DEFAULT 'draft'`, `error_log jsonb (≤64KB)`, `iceberg_table text NOT NULL` (`bronze.<tenant>.ds_<id>`), `partition_spec jsonb`, `current_version_id uuid NULL FK`, `tags text[]`, `custom_metadata jsonb`, `created_by`, timestamps, `deleted_at`.
Indexes: `UNIQUE (tenant_id, workspace_id, lower(name)) WHERE deleted_at IS NULL`; `(tenant_id, status)`; GIN on `tags`.

**dataset_versions** — `id uuidv7 PK`, `tenant_id`, `dataset_id FK`, `version_no int NOT NULL`, `iceberg_snapshot_id bigint NOT NULL`, `schema jsonb NOT NULL (≤64KB)`, `schema_diff jsonb`, `breaking_change bool DEFAULT false`, `row_count bigint`, `bytes bigint`, `produced_by_urn text`, `profile_id uuid NULL`, `profile_status text DEFAULT 'none' (none|pending|running|completed|failed)`, `expired bool DEFAULT false`, `created_at`.
`UNIQUE (dataset_id, version_no)`; index `(tenant_id, dataset_id, version_no DESC)`. Monthly partitions; row retention 25 months (metadata cheap; data retention per §3 DST-FR-080).

**profiles** — `id uuidv7 PK`, `tenant_id`, `dataset_id`, `version_id FK`, `status text`, `error_category text`, `object_key_json text`, `object_key_html text`, `summary jsonb (≤64KB — headline stats only)`, `sample jsonb ({strategy, fraction, seed})`, `profiler_version text`, `started_at`, `finished_at`, `created_at`. Index `(tenant_id, dataset_id, created_at DESC)`.

**lineage_edges** — `id uuidv7 PK`, `tenant_id`, `from_urn text NOT NULL`, `to_urn text NOT NULL`, `activity text NOT NULL CHECK (IN ('ingested','transformed','trained','inferred','exported','derived'))`, `run_urn text`, `properties jsonb (≤16KB)`, `actor jsonb`, `occurred_at`, `created_at`.
`UNIQUE (tenant_id, from_urn, to_urn, activity, run_urn)`; indexes `(tenant_id, from_urn)`, `(tenant_id, to_urn)`. Append-only; monthly partitions, retained 7y (audit-adjacent).

Plus `outbox`, `idempotency_keys`.

### 4.2 URN forms used here
`wr:<tenant>:dataset:dataset/<id>` · `wr:<tenant>:dataset:version/<dataset_id>@v<no>` · `wr:<tenant>:ingestion:connection/<id>` · `wr:<tenant>:ingestion:ingestion/<id>` · `wr:<tenant>:pipeline:run/<id>` · `wr:<tenant>:experiment:model/<id>` · `wr:<tenant>:inference:job/<id>`.

### 4.3 State machines

**Dataset:**

| From | To | Trigger | Guard |
|---|---|---|---|
| draft | processing | first version production started (ingestion/pipeline) | — |
| processing | ready | version committed + registered | ≥1 version exists |
| processing | failed | producer reported terminal error | `error_log` set (invariant: failed ⇒ error_log non-null, V1 rule) |
| failed | processing | retry of producing job | — |
| ready | processing | new version being produced | readers keep serving `current_version_id` |
| any non-deleted | (soft-deleted) | user delete | consumer check or `force=true` (DST-FR-063) |
| (soft-deleted) | prior status | restore | ≤30 days since deletion; name conflict auto-renamed |

**Profile:** `pending → running` (K8s Job scheduled) → `completed` (result PUT with objects verified present) | `failed` (categorized). `failed → pending` on manual re-trigger; one automatic retry on `TIMEOUT|OOM` (retry runs at 16GiB). Illegal transitions → 409.

### 4.5 Error code catalog

`VALIDATION_FAILED` (422: bad URN, bad activity, depth >10, self-edge) · `NOT_FOUND` (404, incl. cross-tenant) · `CONFLICT` (409: name, duplicate snapshot registration, profile already running, delete-with-consumers, stale If-Match) · `GONE` (410: restore window passed, profile objects GC'd) · `PERMISSION_DENIED` (403) · `RATE_LIMITED` (429: profile re-trigger max 3/hour/dataset).

### 4.4 Profile content specification (`profile.json`, schema_version 1)
```
{ schema_version, dataset_urn, version_no, generated_at, profiler_version,
  sample: {strategy: full|reservoir, fraction, seed},
  table: {row_count, column_count, bytes, duplicate_row_pct},
  columns: [{ name, logical_type, inferred_semantic, nullable,
      null_count, null_pct, distinct_count, distinct_pct, is_unique,
      min, max, mean, stddev, median, p5, p25, p75, p95,      # numeric/temporal
      histogram: {bins:[{lo,hi,count}], max_bins: 50},         # numeric/temporal
      top_values: [{value, count}] (≤20, values truncated 128 chars),  # categorical/string
      min_length, max_length, avg_length,                      # string
      true_count, false_count,                                 # boolean
      tags: [pii:<kind>|pii_suspect|id|…],
      quality_flags: [HIGH_NULLS(>20%)|CONSTANT|MOSTLY_UNIQUE|MIXED_TYPES|
                      OUTLIERS_IQR|SKEWED|FUTURE_DATES|NEGATIVE_IN_AMOUNT] }],
  correlations: {method: spearman, pairs: [[a,b,r]] (|r|≥0.5, ≤200 pairs)},
  alerts: [{column?, flag, severity: info|warn, detail}] }
```
HTML report renders the same document (no pandas-profiling runtime dependency in consumers).

Quality-flag definitions (deterministic thresholds, profiler_version-pinned):

| Flag | Condition |
|---|---|
| HIGH_NULLS | null_pct > 20% |
| CONSTANT | distinct_count == 1 (non-null) |
| MOSTLY_UNIQUE | distinct_pct > 95% and not declared id/PK |
| MIXED_TYPES | >1% of sampled values fail the inferred logical type parse |
| OUTLIERS_IQR | >0.5% of values outside [Q1−3·IQR, Q3+3·IQR] |
| SKEWED | |skewness| > 3 |
| FUTURE_DATES | any date/timestamp > generated_at + 1 day |
| NEGATIVE_IN_AMOUNT | negative values in a column with inferred_semantic=currency |

## 5. API specification (base `/api/v1`)

| Method & path | Purpose | Notable errors |
|---|---|---|
| `POST /datasets` · `GET /datasets` · `GET /datasets/{id}` · `PATCH /datasets/{id}` · `DELETE /datasets/{id}` · `POST /datasets/{id}/restore` | CRUD + restore | 409 name conflict, 409 delete-with-consumers w/o force, 410 restore window passed |
| `GET /datasets/{id}/versions` · `GET /datasets/{id}/versions/{no}` | versions (paginated) | 404 |
| `POST /internal/v1/datasets/{id}/versions` | register version (service mTLS: ingestion/pipeline/inference) | 409 snapshot already registered |
| `POST /datasets/{id}/versions/{no}/profile` | (re)trigger profiling | 409 already running |
| `GET /datasets/{id}/profile` (`?version=`) | summary + signed URLs | 404 no profile |
| `PUT /internal/v1/profiles/{id}` | profiler result callback (mTLS) | 409 terminal |
| `POST /datasets:similar` | schema/column similarity | 422 |
| `GET /datasets/{id}/consumers` | downstream impact summary | |
| `POST /lineage/edges` · `GET /lineage` | write / graph query | 422 bad URN/activity, 422 depth>10 |

Example — dataset read (headline shape consumers cache by ETag):
```json
GET /api/v1/datasets/018f6b…
→ 200 ETag:"7d1c…"
{"data":{"id":"018f6b…","urn":"wr:t-42:dataset:dataset/018f6b…","name":"Orders","status":"ready",
 "lifecycle":"active","visibility":"workspace","iceberg_table":"bronze.t42.ds_018f6b",
 "current_version":{"version_no":7,"iceberg_snapshot_id":8817253340021,"row_count":48211004,
   "bytes":9123456789,"breaking_change":false,"profile_status":"completed"},
 "tags":["sales","pii:email"],"created_at":"2026-06-01T09:00:00Z"}}
```

Example — profile summary response:
```json
GET /api/v1/datasets/018f6b…/profile
→ 200 {"data":{"profile_id":"018f6c…","status":"completed","generated_at":"2026-07-09T02:14:00Z",
 "sample":{"strategy":"reservoir","fraction":0.21,"seed":42},
 "table":{"row_count":48211004,"column_count":34,"duplicate_row_pct":0.02},
 "columns":[{"name":"order_total","logical_type":"decimal","null_pct":0.4,"distinct_count":812345,
             "quality_flags":["OUTLIERS_IQR"]}],
 "alerts":[{"column":"discount_code","flag":"HIGH_NULLS","severity":"warn","detail":"41.7% null"}],
 "full_json_url":"https://…signed…(24h)","html_report_url":"https://…signed…(24h)"}}
```

Example — lineage read:
```json
GET /api/v1/lineage?urn=wr:t-42:dataset:dataset/018f..&direction=upstream&depth=3
→ 200 {"data":{"nodes":[{"urn":"wr:t-42:dataset:dataset/018f..","kind":"dataset","name":"Orders","status":"ready"},
  {"urn":"wr:t-42:ingestion:ingestion/018e..","kind":"foreign"}],
  "edges":[{"from_urn":"wr:t-42:ingestion:ingestion/018e..","to_urn":"wr:t-42:dataset:version/018f..@v1",
            "activity":"ingested","occurred_at":"2026-07-01T02:00:14Z"}],"truncated":false}}
```

**MCP facade (read-only tier):** `search_datasets(q, filters)`, `get_dataset(urn)`, `get_dataset_schema(urn, version?)`, `get_dataset_profile(urn, version?)` (summary only, no signed URLs), `get_lineage(urn, direction, depth≤5)`, `find_similar_datasets(columns[])`.

## 6. Events

**Emitted → `dataset.events.v1`:** `dataset.created`, `dataset.updated`, `dataset.deleted`, `dataset.restored`, `dataset.deprecated`, `dataset.version_created {dataset_urn, version_no, iceberg_snapshot_id, row_count, produced_by_urn, breaking_change}`, `dataset.schema_changed {schema_diff}`, `dataset.profile_completed {profile_summary_digest, alerts_count}`, `dataset.profile_failed {error_category}`, `dataset.version_expired`, `lineage.edge_created`.

**Consumed:** `ingestion.events.v1 :: ingestion.completed` → create/advance dataset + version, auto lineage edge, trigger profiling (handler idempotent on `ingestion_id`); `ingestion.failed` → if dataset was `draft/processing` with no prior version, mark `failed` with the ingestion's error digest; `pipeline.events.v1 :: run_completed`, `inference.events.v1 :: inference.completed` → register output versions + lineage; `rbac.events.v1 :: workspace.deleted` → soft-delete member datasets. All with Redis dedup + DLQ per master.

## 7. Business rules & edge cases

- **BR-1** A version row is written only after the Iceberg snapshot is committed and readable; registration with an unknown `iceberg_snapshot_id` is rejected (409) — the DB never points at data that doesn't exist.
- **BR-2** `version_no` is assigned by the service under a per-dataset advisory lock; concurrent registrations serialize, never skip or duplicate.
- **BR-3** Profile objects are immutable; re-profiling a version creates a new `profiles` row and repoints `dataset_versions.profile_id` (old objects GC'd after 30d).
- **BR-4** `summary` in Postgres is capped at 64KB: table stats + per-column `{logical_type, null_pct, distinct_count}` + alerts only. Anything more comes from the object-store document (MASTER-FR-061).
- **BR-5** Datasets remain fully usable while `profile_status ∈ {pending, running, failed}`; only `status` gates usability.
- **BR-6** Lineage writes accept only URNs whose `tenant_id` matches the caller's; violations → 404 + audit (cross-tenant rule).
- **BR-7** Graph queries are cycle-safe (visited-set) even though writes should form a DAG; a write that would create a self-edge (`from==to`) is rejected 422.
- **BR-8** Restore after the 30-day window → 410 GONE; retention hard-delete removes profile objects and drops the Iceberg table, but lineage edges and expired-version metadata survive.
- **BR-9** `visibility=tenant_public` grants tenant-wide read only; write always follows workspace RBAC (V1 `is_public` semantics).
- **BR-10** Schema stored per version is the profiler/ingestion-inferred logical schema; Iceberg remains authoritative for physical types — mismatches raise quality flag `MIXED_TYPES` rather than failing.
- **BR-11** Concurrent `PATCH` on the same dataset uses optimistic concurrency (`If-Match: <etag from updated_at>`; stale → 409).
- **BR-12** Event handlers never call other services synchronously except dataset-registration acks to ingestion (mTLS, retried); everything else is event-driven.
- **BR-13** A `breaking_change` version emits `dataset.schema_changed`, which semantic-service and chart-service consume to flag dependent models/charts — dataset-service does not block the version.

## 8. Dependencies

- **Upstream:** ingestion-service events; pipeline-orchestrator/inference-service version registrations; identity/rbac/OPA; Iceberg REST catalog (snapshot verification, expiry); object storage (profiles); K8s API (profiler Jobs); Kafka + Schema Registry; Redis; OpenSearch (catalog projection); Temporal (retention sweeps, profiler job supervision).
- **Downstream:** query-service and semantic-service resolve `dataset_urn → iceberg_table/snapshot` via `GET /datasets/{id}` (cache-friendly, ETag); chart-service consumes `schema_changed`; agents via MCP facade; usage-service meters `profile_runs`, `storage_bytes`.
- **Profiler image contract:** args `--tenant-id --dataset-urn --version-no --snapshot-id --sample-strategy --output-prefix`; exits 0 with result PUT delivered, non-zero → supervisor marks `failed/INTERNAL`.

## 9. NFRs (deltas from master)

- Profile job for a 10M-row/200-column dataset completes ≤ 10 min within 4 CPU / 8GiB (job resource cap; OOM → `failed/OOM`, one retry at 16GiB).
- Lineage query depth 3 over a 100K-edge tenant graph p95 ≤ 400ms; depth 10 ≤ 2s.
- Catalog search p95 ≤ 300ms (OpenSearch); point reads ≤ 150ms.
- `dataset.version_created` visible to consumers ≤ 5s after ingestion completion (event path budget).

## 10. Acceptance criteria

- **AC-1** Given an `ingestion.completed` event for a new dataset, when handled, then a dataset in `processing`, version `v1` with the event's `iceberg_snapshot_id`, an `ingested` lineage edge, and a `pending` profile all exist, and duplicate delivery of the same event creates none of them twice.
- **AC-2** Given profiling succeeds, when the profiler PUTs its result over mTLS, then `profile.json`/`profile.html` exist in object storage, Postgres holds only pointer + ≤64KB summary, dataset becomes `ready`, and `dataset.profile_completed` is emitted.
- **AC-3** Given the profiler exceeds 30 min, then the job is killed, one retry runs, and on second timeout the profile is `failed/TIMEOUT` while the version and dataset remain `ready` (with `profile_status=failed`).
- **AC-4** Given an empty source (0 rows), when the profiler runs, then it reports `EMPTY_DATA` and the profile is failed with that category (dataset usability unchanged).
- **AC-5** Given a second ingestion that adds column `discount` and drops `legacy_code`, when `v2` is registered, then `schema_diff` lists both, `breaking_change=true`, and `dataset.schema_changed` is emitted.
- **AC-6** Given versions v1..v12 older than the retention policy, when the retention job runs, then expired versions have `expired=true`, their Iceberg snapshots are expired and profile objects deleted, but the current version and a `trained`-pinned v3 (edge < 400 days) survive.
- **AC-7** Given `GET /lineage?urn=<model_urn>&direction=upstream&depth=10` over a chain inference→model→pipeline-run→dataset→ingestion→connection, then all five hops are returned with correct activities and `truncated=false`; with `depth=2` only two hops return and `truncated=true`.
- **AC-8** Given a lineage write whose `to_urn` carries tenant B while the caller's JWT is tenant A, then 404 and `security.cross_tenant_denied` audit event.
- **AC-9** Given two concurrent version registrations for one dataset, then they receive consecutive `version_no`s with no gap/duplicate (advisory-lock test).
- **AC-10** Given a dataset deleted 10 days ago whose name is now taken, when restored, then it returns as `Copy of <name>` and a `dataset.restored` event is emitted; after 31 days restore returns 410.
- **AC-11** Given `POST /datasets:similar` with columns `[customer_id, order_total]`, then datasets containing both columns (case-insensitive) rank above partial matches.
- **AC-12** Given a dataset with charts and a trained model downstream, when `DELETE` without `force`, then 409 with a consumer summary; with `force=true` it soft-deletes and emits `dataset.deleted_with_consumers`.
- **AC-13** Given tenant A's token listing datasets, then no tenant B rows appear even with crafted filters (RLS isolation suite, every endpoint).
- **AC-14** Given the MCP tool `get_dataset_profile`, when invoked by an agent with read tier, then it returns the summary without signed URLs and the call is audited as `ai.tool_invoked.v1`.

## 11. Out of scope / future

Data quality **rules engine** (user-defined expectations à la Great Expectations — profiles expose flags only); column-level lineage; drift detection between versions (governance agent, later phase reads profiles to compute it); dataset access-request workflow; business glossary; contract enforcement on producers; cross-tenant data sharing/marketplace.
