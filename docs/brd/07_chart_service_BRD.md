# BRD 07 — chart-service (Go)

**Date:** 2026-07-09 · **Status:** Approved for build · **Phase:** 2
**Inherits:** `00_MASTER_BRD.md` (all MASTER-FR requirements apply). Architecture: `../../DATACERN_PLATFORM_ARCHITECTURE.md` §6 (chart-service row), §5 (Viz domain).

---

## 1. Overview

**Purpose.** chart-service owns dashboards and charts for the Insights and Case Management modules. It resolves chart data by compiling chart definitions through semantic-service and executing through query-service, applies **server-side aggregation by default**, caches shaped results in Redis, and serves drilldowns and exports.

**Business value.** V1 (Rails `chart-service`) shipped raw rows to the browser and aggregated client-side (`aggregateData()` in `InsightsChartControl.tsx`), which collapsed above ~50K rows and made every dashboard load re-query the warehouse. V1 also stored chart sources as untyped JSONB (`sources: [{type, id}]`) pointing at IDO queries/MLflow runs with no referential integrity. The rebuild moves aggregation to the server, replaces JSONB source blobs with typed references to semantic measures/saved queries, and adds an event-invalidated result cache — targeting p95 dashboard render < 1.5s at 10M-row datasets.

**In scope:** dashboard CRUD/layout/archive/sharing; chart CRUD with the full 30-type catalog; data-resolution flow (semantic compile → query execute → shape); Redis result cache + ETag/304; drilldown; CSV/PNG export; cross-module chart linking (insights ↔ case_management); dashboard import/export (content migration); MCP read facade + draft-dashboard write-proposal tools for the dashboard-designer agent.

**Out of scope:** SQL generation (semantic-service), query execution (query-service), case creation from chart rows (case-service, via `chart.meta.isAllowedCases` linkage), scheduled email reports (notification-service consumes `chart.report_requested`), rendering pixels for the UI (ui-web renders; PNG export uses a headless renderer sidecar).

## 2. Actors & user stories

Personas: **Analyst** (builds dashboards), **Viewer** (consumes), **Case Manager** (uses case-management dashboards), **Workspace Admin**, **Dashboard-designer agent** (drafts via proposals), **BFF** (system caller).

- **US-1** As an Analyst, I create a dashboard in a workspace and add charts bound to semantic measures so numbers are governed and consistent.
- **US-2** As an Analyst, I pick any of the supported chart types and configure axes/series/aggregation without writing SQL.
- **US-3** As a Viewer, I open a dashboard and all charts render from cache in under 2 seconds; a refresh that changed nothing costs no warehouse query (304).
- **US-4** As an Analyst, I click a bar and drill down into the underlying rows, paginated, with the clicked dimension injected as a filter.
- **US-5** As a Case Manager, I link a case-management grid chart to an insights chart (shared_source or main_secondary link) so triage screens stay in sync with analytics.
- **US-6** As an Analyst, I export chart data as CSV and a chart image as PNG for a report.
- **US-7** As a Workspace Admin, I share a dashboard via content grants at view/edit levels and archive/restore dashboards without losing chart configs.
- **US-8** As an Analyst, I export a dashboard as a portable JSON bundle and import it into another workspace with source references remapped.
- **US-9** As a Dashboard-designer agent, I read the chart-type catalog and semantic model, then submit a draft dashboard as a proposal for human approval.
- **US-10** As a Viewer with a dashboard variable/filter set, I see all charts re-resolve with my variable values without the analyst's cache being polluted.

## 3. Functional requirements

### Dashboards
- **CHART-FR-001 (M)** CRUD for dashboards: `{name, module, description, layout, meta, tags[], archived}`. `module ∈ {insights, case_management, inspector}` (mined from V1 route namespaces). Name unique per (workspace, module) among non-archived dashboards (V1 `unique_name_per_workspace`); violation → `409 CONFLICT`.
- **CHART-FR-002 (M)** Dashboard layout is a first-class column: ordered grid placements `[{chart_id, x, y, w, h}]` validated for overlap; not free-form JSONB metadata.
- **CHART-FR-003 (M)** Archive (`POST :id/archive`) and restore (`PATCH :id/restore`); archived dashboards excluded from default lists, listable via `GET /dashboards?filter[archived]=true`. Archiving cascades `archived` to attached documentation (V1 `sync_documentation_archive_state`).
- **CHART-FR-004 (M)** Sharing via rbac-service content grants on `wr:<t>:chart:dashboard/<id>` at levels `view|edit|manage`. chart-service enforces via OPA only; it stores no ACLs. Charts inherit the dashboard's grant.
- **CHART-FR-005 (S)** Dashboard export → self-contained JSON bundle (dashboard + charts + source refs as URNs); import remaps dataset/query/measure URNs via a caller-supplied mapping, mirroring V1 `ContentMigration::Dashboards::{Exporter,Importer}` incl. drilldown `datasetId/queryId` remap.
- **CHART-FR-006 (S)** Per-dashboard documentation (markdown ≤ 64KB) attachable to dashboards and charts (V1 `Documentation` polymorphic).
- **CHART-FR-007 (C)** `GET /dashboards/:id` returns `last_content_updated_at` = max(dashboard, charts, documentation `updated_at`) for UI staleness badges.

### Charts & catalog
- **CHART-FR-010 (M)** Chart CRUD within a dashboard. Chart name unique per dashboard for custom charts (V1 rule). Each chart: `{name, chart_type, description, config, display_meta, chart_version (int, ++ on config change), sources[]}`.
- **CHART-FR-011 (M)** Support the full V1 chart-type catalog (30 types), grouped by data source class exactly as mined from V1 `Chart`:
  - **Query/semantic charts (25)** — V1 `IDO_CHARTS`: `line_chart, scatter_plot, pie_chart, funnel_chart, bubble_chart, gauge_chart, sunburst_chart, vertical_bar_chart, vertical_stackedbar_chart, sankey_chart, whisker_chart, combination_chart, grid_chart, geo_map_chart, tree_map_chart, heatmap_chart, histogram_chart, waterfall_chart, word_cloud_chart, chord_chart, decision_tree_chart, network_graph_chart, network_chart, tree_chart, pivot_table_chart`.
  - **Dataset charts (2)** — V1 `DATASET_CHARTS`: `metric_chart, parameter_chart` (dataset/version-level stats).
  - **Run charts (3)** — V1 `RUN_CHARTS`: `roc_curve, confusion_matrix, decision_tree` (MLflow-run-derived, resolved via experiment-service).
- **CHART-FR-012 (M)** Per-type config schemas (JSON Schema, served by `GET /chart-types`), derived from V1 `chart_config.yml` contracts:

  | Config family | Applies to | Required fields |
  |---|---|---|
  | `axis` | line, scatter, vertical_bar, vertical_stackedbar, combination, waterfall, histogram, whisker, bubble, geo_map | `x` (dimension ref), `y[]` (measure refs, ≥1), optional `dataseries` (group-by dimension), per-y `agg_fn` |
  | `y_only` | pie, funnel, gauge, word_cloud | `y[]` (or `x` slice label + `y` value for pie), `agg_fn` |
  | `heatmap` | heatmap, tree_map, sunburst, chord, sankey | `x`, `y`, `dataseries` (all required) |
  | `network` | network_chart, network_graph_chart, tree_chart, decision_tree_chart | `nodes`, `children` (required), `node_values`, optional `x`,`y` |
  | `grid` | grid_chart, pivot_table_chart | `columns[]` projection, optional pivot rows/cols/values |
  | `metric` | metric_chart, parameter_chart, roc_curve, confusion_matrix, decision_tree | run/dataset ref only |
- **CHART-FR-013 (M)** **Typed sources replace V1 JSONB.** `chart_sources` rows: `(chart_id, position, source_type ∈ {semantic_measure, saved_query, dataset, ml_run}, source_urn)`. Field refs in `config` (`x`, `y[]`, `dataseries`) name semantic dimensions/measures or query result columns — validated at write time against semantic-service/query-service metadata; unknown refs → `422 VALIDATION_FAILED` with per-field details.
- **CHART-FR-014 (M)** `agg_fn` whitelist: `sum, avg, min, max, count, first` (V1 `ALLOWED_AGG_FNS`); anything else rejected at write time and again at resolve time (defense in depth).
- **CHART-FR-015 (M)** Cross-module chart linking (V1 `link_type` enum): `shared_source` (0) and `main_secondary` (1). A parent chart declares `linked_child_id` + `linked_columns` (pairs of parent col → child col); service maintains the back-reference `linked_by_keys_parents` on the child atomically in one transaction, rejects circular links, and cleans both directions on chart delete (V1 `add_column_pairs_links` / `remove_column_pairs_links` semantics, without the V1 read-modify-write races — see BR-9).
- **CHART-FR-016 (M)** Guard: a chart with `display_meta.allow_cases=true` (V1 `meta.isAllowedCases`), or a `grid_chart` with any insights child having it, cannot be deleted → `412 PRECONDITION_FAILED` `{code: CHART_HAS_CASES}` (V1 controller rule).

### Data resolution
- **CHART-FR-020 (M)** `GET /charts/:id/data` resolves: (1) load chart + sources; (2) semantic sources → `POST semantic-service /compile` `{measures, dimensions, filters, variables}` → SQL; saved-query sources → fetch SQL from query-service with tenant-safe variable substitution; (3) `query-service /run` (paginated internally); (4) shape per chart-type into `{columns[], rows[], aggregated, chart_version, row_count, truncated}`.
- **CHART-FR-021 (M)** **`aggregated=true` is the default.** Server performs GROUP BY on `x` (+`dataseries`) with whitelisted `agg_fn` per `y` — the V1 client-side `aggregateData` contract moved server-side. `?aggregated=false` (V1 `meta.aggregate.checked=false` charts) returns raw `[x, y, dataseries]` triples only, capped at 10,000 points with deterministic sampling beyond, `truncated:true` flagged.
- **CHART-FR-022 (M)** Dashboard variables/filters: request accepts `{variables: {k:v}, filters: [{field, op, value}]}`; ops whitelist `eq, neq, in, gt, gte, lt, lte, between, like`; values are bind parameters, never interpolated.
- **CHART-FR-023 (M)** `POST /charts/preview` resolves an unsaved chart definition inline (V1 `preview_aggregated`) — same pipeline, no persistence, never cached, per-tenant concurrency cap 5.
- **CHART-FR-024 (S)** Batch endpoint `POST /dashboards/:id/data` resolves all charts of a dashboard concurrently (fan-out ≤ 8 per request), returning per-chart results or per-chart errors independently.
- **CHART-FR-025 (M)** Run charts resolve via experiment-service (`roc_curve`, `confusion_matrix`, `decision_tree` artifacts by run URN); dataset charts via dataset-service profile pointers. Same response envelope.

### Caching
- **CHART-FR-030 (M)** Redis result cache. Key: `chart:{tenant}:{chart_id}:{chart_version}:{sha256(canonical_json(variables, filters, aggregated, page))}`. Value: shaped response, gzip, ≤ 1MB (larger → skip cache, log metric). TTL 1h.
- **CHART-FR-031 (M)** Event-driven invalidation: on own `chart.updated/deleted` and consumed `semantic.model.updated`, `query.updated`, `dataset.version.created` → delete `chart:{tenant}:{chart_id}:*` for every chart referencing the changed URN (reverse index `src:{urn} → set<chart_id>` maintained on chart write).
- **CHART-FR-032 (M)** HTTP caching: strong ETag = cache key digest; `If-None-Match` hit → `304` with no query execution; `Cache-Control: private, max-age=300` (V1 pattern: private browser cache, 5-min fresh window, never CDN-cached).
- **CHART-FR-033 (S)** Stampede protection: per-key singleflight lock (Redis `SET NX PX 30s`); concurrent identical misses wait on the leader's result.

### Drilldown & export
- **CHART-FR-040 (M)** Drilldown config per chart: `{drilldown: {query_urn, dataset_urn}}` (V1 `meta.drilldown.{queryId,datasetId}`). `POST /charts/:id/drilldown` `{clicked: {dimension, value}, dataseries_value?, filters, cursor, limit}` executes the drilldown query as a **separate paginated query** with the clicked dimension injected as an additional AND bind-parameter predicate (resolving V1 open question §7.6 — no `{var}` string substitution). Response is a standard paginated envelope; never cached in the chart result cache.
- **CHART-FR-041 (M)** `POST /charts/:id/export` `{format: csv|png}` → `202 {operation_id}`; CSV streams full un-truncated resolved data (server-paginated under the hood, RFC 4180, UTF-8 BOM) to object storage with a 15-min signed URL; PNG rendered at requested `{width, height, theme}` (default 1200×675) by the headless renderer. Completion signaled via realtime-hub `run-status:<operation_urn>`. Cap: 5 concurrent exports/tenant.
- **CHART-FR-042 (C)** `POST /dashboards/:id/export.pdf` composing all charts — Phase 6.

### Agent facade
- **CHART-FR-050 (S)** MCP tools: `chart.list_dashboards`, `chart.get_chart`, `chart.get_chart_data` (read tier); `chart.draft_dashboard` (write-proposal tier — creates dashboard with `status=draft`, visible only to proposer + approvers until approved per master §8.5 flow).

## 4. Domain model & data

```
dashboards      id uuidv7 PK · tenant_id · workspace_id · name text · module text CHECK IN ('insights','case_management','inspector')
                · description · layout jsonb (≤64KB, grid placements — documented JSONB use) · meta jsonb (≤8KB display prefs)
                · owner_user_id · archived bool default false · archived_at · created_at · updated_at · deleted_at
  UX uq_dash_ws_name_module ON (tenant_id, workspace_id, module, lower(name)) WHERE NOT archived AND deleted_at IS NULL
  IX (tenant_id, workspace_id, module, archived, updated_at DESC)

charts          id uuidv7 PK · tenant_id · dashboard_id FK · name · chart_type text CHECK (30-type enum) · description
                · config jsonb (≤64KB, schema-validated per type) · display_meta jsonb (≤16KB: allow_cases, colors, legend, drilldown ref)
                · chart_version int default 1 · custom bool default true · link_type smallint NULL CHECK IN (0,1)
                · linked_parent_id FK charts NULL · created_at · updated_at · deleted_at
  UX uq_chart_dash_name ON (tenant_id, dashboard_id, lower(name)) WHERE custom AND deleted_at IS NULL
  IX (tenant_id, dashboard_id) · IX (linked_parent_id)

chart_sources   id PK · tenant_id · chart_id FK · position smallint · source_type text CHECK IN ('semantic_measure','saved_query','dataset','ml_run')
                · source_urn text NOT NULL
  UX (chart_id, position) · IX (tenant_id, source_urn)   -- reverse lookup for invalidation

chart_links     id PK · tenant_id · parent_chart_id FK · child_chart_id FK · linked_columns jsonb ([{parent_col, child_col}])
  UX (parent_chart_id, child_chart_id) · CHECK (parent_chart_id <> child_chart_id)

documentations  id PK · tenant_id · documentable_type · documentable_id · content text (≤64KB) · archived bool · archived_at
outbox          (master §2.4-034 standard shape)
```

Retention: soft-deleted dashboards/charts hard-purged after 90 days. No monthly partitioning (low volume, <100K rows/tenant). Export artifacts in object storage expire after 7 days.

**State machine — dashboard:** `active → archived` (guard: actor has `manage`) → `active` (restore); `active|archived → deleted` (soft; guard: no chart has `allow_cases` — else 412). **Chart version:** any change to `config`, `chart_type`, or `chart_sources` increments `chart_version` (cache epoch); display-only `display_meta` changes do not.

## 5. API specification

Base `/api/v1`. All collections paginated per master. Actions: `chart.dashboard.*`, `chart.chart.*`.

| Method & path | Purpose | Errors |
|---|---|---|
| `POST /dashboards` | create | 409 name conflict, 422 |
| `GET /dashboards` | list; `filter[module]`, `filter[archived]`, `filter[tag]`, `sort=-updated_at` | — |
| `GET /dashboards/:id` · `PATCH` · `DELETE` | read/update/soft-delete | 404, 412 CHART_HAS_CASES |
| `POST /dashboards/:id/archive` · `PATCH /dashboards/:id/restore` | archive/restore | 404, 409 restore-name-conflict |
| `POST /dashboards/:id/export-bundle` · `POST /dashboards/import` | content migration | 422 unmapped URNs |
| `POST /dashboards/:id/data` | batch resolve all charts | 207-style per-chart errors in body |
| `POST /dashboards/:id/charts` · `GET/PATCH/DELETE /charts/:id` | chart CRUD | 409, 412, 422 schema |
| `GET /chart-types` | catalog + JSON Schemas | — |
| `GET /charts/:id/data?aggregated=&cursor=` | resolve data (ETag/304) | 422 INVALID_AGGREGATION, 502 UPSTREAM_QUERY_FAILED |
| `POST /charts/preview` | resolve unsaved definition | 422, 429 |
| `POST /charts/:id/drilldown` | paginated drilldown | 404 NO_DRILLDOWN_CONFIGURED, 422 |
| `POST /charts/:id/export` | CSV/PNG async | 429 EXPORT_LIMIT |
| `PUT /charts/:id/link` · `DELETE /charts/:id/link` | manage cross-module link | 409 CIRCULAR_LINK, 422 |

**Response shaping per chart-type family** (the shape contract the UI renders; `columns` order is normative):

| Family | Shaped row form | Notes |
|---|---|---|
| axis (line, bar, stacked bar, combination, waterfall, histogram, whisker, geo_map) | `[x, m1, m2, …]` or `[x, dataseries, m1, …]` when series present | histogram: server computes buckets (`x` = bucket lower bound, `bucket_width` in meta); whisker: `[x, min, q1, median, q3, max]` |
| y_only (pie, funnel, gauge, word_cloud) | `[label, value]` | gauge returns single row; funnel rows sorted desc by value |
| heatmap family (heatmap, tree_map, sunburst, chord, sankey) | `[x, y, value]` (sankey: `[source, target, value]`) | sunburst/tree_map: hierarchical `path` array in place of `x` |
| network (network, network_graph, tree, decision_tree_chart) | `{nodes: [{id, value}], edges: [{from, to, value}]}` | object shape, not tabular rows |
| grid (grid_chart, pivot_table) | raw projected columns; pivot pre-pivoted server-side | grid always paginated (never fully materialized) |
| metric/run (metric, parameter, roc_curve, confusion_matrix, decision_tree) | pass-through artifact JSON | resolved from experiment-/dataset-service |

`POST /dashboards/:id/charts` example request:
```json
{"name":"Revenue by Region","chart_type":"vertical_bar_chart",
 "sources":[{"source_type":"semantic_measure","source_urn":"wr:t-42:semantic:measure/revenue"}],
 "config":{"x":{"dimension":"region"},
           "y":[{"measure":"revenue","agg_fn":"sum"},{"measure":"orders","agg_fn":"count"}],
           "dataseries":null},
 "display_meta":{"allow_cases":false,"legend":true,
                 "drilldown":{"query_urn":"wr:t-42:query:query/q-771","dataset_urn":"wr:t-42:dataset:dataset/ds-9f2"}}}
```
Validation failure shape (per master §2.3-024):
```json
{"error":{"code":"VALIDATION_FAILED","message":"chart config invalid",
  "details":[{"field":"config.y[0].agg_fn","code":"INVALID_AGGREGATION","allowed":["sum","avg","min","max","count","first"]},
             {"field":"config.x.dimension","code":"UNKNOWN_DIMENSION","message":"'regin' not found in semantic model sm-11"}],
  "trace_id":"7f2c…"}}
```

`GET /charts/:id/data` example response:
```json
{"data": {"chart_id":"01977f2e-…","chart_type":"vertical_bar_chart","chart_version":4,
  "aggregated":true,"columns":["region","sum_revenue","count_orders"],
  "rows":[["EMEA",1250000.5,842],["APAC",990321.0,617]],
  "row_count":2,"truncated":false,"resolved_at":"2026-07-09T10:15:00Z"},
 "meta":{"cache":"hit","etag":"W/\"9f2c…\""}}
```
Drilldown request: `{"clicked":{"dimension":"region","value":"EMEA"},"limit":50,"cursor":null}` → standard `{data:{columns,rows}, page:{next_cursor,has_more}}`.

Export flow example:
```
POST /charts/01977…/export {"format":"csv"}                → 202 {"operation_id":"op-01978…"}
(realtime-hub topic run-status:wr:t-42:chart:operation/op-01978… streams progress)
GET  /operations/op-01978…                                 → {"status":"completed","artifact_url":"https://…signed…","expires_at":"…"}
```

**Resolution sequence (normative):**
```
UI → chart-service GET /charts/:id/data
  1. OPA authz (chart.chart.read on dashboard URN)          — p99 10ms
  2. Redis GET cache key                                    — hit → 200 (or 304 on ETag match)
  3. miss → singleflight lock
  4. semantic-service POST /compile {measures, dims, filters, variables} → SQL   (or query-service saved-SQL fetch)
  5. query-service POST /sql/run {sql, binds, max_rows}     — streams pages internally
  6. shape per chart-type family; GROUP BY applied in SQL (aggregated=true) — service never aggregates in memory
  7. Redis SETEX (gzip) + reverse-index SADD src:{urn}
  8. 200 + ETag
```

## 6. Events

**Emitted** on `chart.events.v1` (master envelope): `dashboard.created|updated|archived|restored|deleted`, `chart.created|updated|deleted` (payload: `chart_id, dashboard_id, chart_type, chart_version, source_urns[]`), `chart.link.created|removed`, `chart.export.completed|failed` (payload: `operation_id, format, artifact_urn`), `chart.data.resolved` (sampled 1%, payload: latency_ms, cache_hit, row_count — for usage metering).

**Consumed:**
| Topic / type | Handler |
|---|---|
| `semantic.events.v1` / `semantic.model.updated`, `measure.updated|deleted` | invalidate cache for charts referencing the URN; mark charts whose measure was deleted `config_status=broken` and emit `chart.updated` |
| `query.events.v1` / `query.updated|deleted` | same invalidate/mark-broken flow |
| `dataset.events.v1` / `dataset.version.created` | invalidate cache for charts referencing dataset URN |
| `rbac.events.v1` / `grant.revoked` | no state change (OPA handles); drop any warmed cache entries scoped to revoked subject — none exist (cache is content-keyed, not user-keyed) → no-op, documented |

## 7. Business rules & edge cases

- **BR-1** Aggregation functions outside `{sum,avg,min,max,count,first}` are rejected on write and on resolve (`INVALID_AGGREGATION`).
- **BR-2** Raw mode (`aggregated=false`) caps at 10,000 points; overflow uses deterministic hash-sampling (stable across refreshes for the same chart_version) and sets `truncated:true`.
- **BR-3** A chart referencing a deleted measure/query resolves to `422 {code: SOURCE_BROKEN}` and renders a broken-source state in UI; it is never silently dropped.
- **BR-4** Deleting a dashboard requires no chart with `allow_cases=true` and no chart that is a link parent of a chart in another dashboard; otherwise 412 with the blocking chart ids in `details`.
- **BR-5** Cache entries are content-keyed (chart_version + variables + filters), never user-keyed; authorization is checked before cache lookup on every request — a cache hit must not bypass OPA.
- **BR-6** Variables and filter values are always bind parameters. chart-service never concatenates user input into SQL; it passes structured filters to semantic-service/query-service.
- **BR-7** Concurrent chart updates use optimistic locking (`If-Match: chart_version`); stale write → `409 CONFLICT`.
- **BR-8** Batch dashboard resolve isolates failures: one chart's upstream timeout (per-chart budget 10s) yields an error object for that chart only.
- **BR-9** Link maintenance is transactional: creating a `main_secondary` link writes `chart_links` + both charts' back-refs in one DB transaction; circular links (A→B→A, or any cycle up to depth 10) rejected `409 CIRCULAR_LINK`. (V1 did read-modify-write across two saves and could race.)
- **BR-10** Import with unmapped source URNs fails atomically (no partial dashboard) listing each unmapped URN.
- **BR-11** Preview endpoint: max 5 concurrent per tenant, 30s hard timeout, result row cap 1,000.
- **BR-12** Invalidation fan-out is bounded: a semantic-model update touching >500 charts enqueues invalidation as a background job (≤5s completion SLO) rather than inline consumer work.
- **BR-13** Export CSV reflects filters/variables in force at request time, snapshotted into the operation; later chart edits don't alter an in-flight export.

## 8. Dependencies

**Upstream (sync):** semantic-service `POST /compile` (SQL from measures/dims/filters); query-service `POST /queries/:id/run`, `POST /sql/run` (execution, pagination, cost limits); experiment-service (run artifacts); dataset-service (profiles); OPA sidecar; rbac Redis projection. **Async:** Kafka topics per §6; realtime-hub for operation progress. **Infra:** Postgres, Redis (cache + reverse index), object storage (exports), headless PNG renderer sidecar. **Downstream:** bff-graphql, ui-web, case-service (reads chart/query linkage for case creation context), dashboard-designer agent via MCP, notification-service (email report events).

## 9. NFRs (deltas from master)

- `GET /charts/:id/data` p95 ≤ 400ms on cache hit ≤ 2.5s on miss (10M-row source, aggregated); `304` path p95 ≤ 50ms.
- Cache hit ratio ≥ 80% steady-state (dashboard-level alert below 60%).
- Invalidation propagation (source event → stale key deleted) p95 ≤ 5s.
- Dashboard batch resolve (12 charts) p95 ≤ 3s warm.

## 10. Acceptance criteria

- **AC-1** Given a saved `vertical_bar_chart` with `x=region`, `y=[{measure:revenue, agg_fn:sum}]`, when `GET /charts/:id/data`, then the response has `aggregated:true`, one row per region, and semantic-service received a compile call for measure `revenue` grouped by `region`.
- **AC-2** Given the same chart resolved once, when the identical request repeats within TTL, then query-service receives no call and `meta.cache="hit"`.
- **AC-3** Given a client holding the response ETag, when it re-requests with `If-None-Match`, then the service returns `304` with no upstream calls.
- **AC-4** Given a resolved chart, when semantic-service emits `measure.updated` for a referenced measure, then within 5s the cache entry is gone and the next request re-resolves with `meta.cache="miss"`.
- **AC-5** Given a chart with `agg_fn:"median"` in a PATCH, when submitted, then `422 VALIDATION_FAILED` names the offending field and lists the allowed set.
- **AC-6** Given a chart with drilldown configured on `query_urn=Q`, when `POST /drilldown` with `clicked={dimension:"region",value:"EMEA"}`, then query-service receives Q's SQL wrapped with a bind-parameter predicate `region = $1` and the response is paginated with `next_cursor`.
- **AC-7** Given `GET /chart-types`, when called, then exactly 30 chart types are returned, each with a JSON Schema whose required fields match CHART-FR-012.
- **AC-8** Given a chart with `display_meta.allow_cases=true`, when `DELETE /charts/:id`, then `412` with code `CHART_HAS_CASES` and the chart still exists.
- **AC-9** Given two active dashboards in one workspace, when creating a second `insights` dashboard with the same name (case-insensitive), then `409 CONFLICT`; after archiving the first, creation succeeds.
- **AC-10** Given a `main_secondary` link A→B, when B is linked back to A, then `409 CIRCULAR_LINK`; when A is deleted, then B's back-reference rows are removed in the same transaction.
- **AC-11** Given a CSV export of a 2M-row raw grid chart, when the operation completes, then the artifact contains all rows (not the 10K display cap), realtime-hub delivered progress events, and the signed URL expires within 15 min.
- **AC-12** Given tenant A's token, when requesting tenant B's chart data by id, then `404` and a `security.cross_tenant_denied` audit event exists (master isolation suite).
- **AC-13** Given `aggregated=false` on a 50K-point scatter source, when resolved, then ≤10,000 points return with `truncated:true`, and the identical request returns the identical sample.
- **AC-14** Given a dashboard bundle exported from workspace W1 referencing dataset URN D, when imported into W2 with a mapping D→D′, then all chart sources and drilldown refs point at D′ and no chart references D.

## 11. Out of scope / future

Dashboard-level PDF export; scheduled snapshot emails (owned by notification-service); real-time streaming charts (tick data); user-editable custom chart types/plugins; per-chart alert thresholds (future alerting service); mobile-optimized layout variants.
