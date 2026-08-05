# BRD 71–75 — V1 → Datacern Parity Wave 2 (initiative index)

**Status:** IN PROGRESS — 2026-08-05 · 11/11 gaps closed (BRD 71, 72, 73 and 75 landed;
74 partial — D1+D2 landed, D3 deferred and redesigned)
**Owner:** platform · **Driver:** a second cross-verification of the legacy V1 platform
(Rails/Flask services + Argo + pandas component containers) against Datacern's rebuilt
services. The [wave-1 index](62_pipeline_ml_parity_index.md) audited **pipeline + ML
compute only** and closed 13/13 gaps there. This wave audits the four surfaces it never
looked at — **data sourcing, ingestion, the pipeline *builder* (UI + component config),
and dashboards/charts/grids** — plus the cross-cutting discovery and profiling paths.

Same rules as wave 1. Each BRD follows **Analysis → Design → Implement & Test**, and
carries the same hard acceptance criterion: **the feature must be drivable by an AI
agent** (extend an existing `agent-runtime` graph or add one), in proposal-mode under
the same four-eyes / WORM governance as every other governed write.

---

## Scope note: three questions this audit had to answer first

**1. Does V1 use Apache Spark?** **No.** The `spark-jsonapi` repo is an in-house fork of
`flask-rest-jsonapi`, and `Vault::SparkClient` is a Vault wrapper — both named after
**SparkTech**, the vendor (`gitlab.sparktech.ro`), not the engine. `grep -ri pyspark |
SparkSession | spark-submit` over the whole V1 tree returns **zero** hits. V1's data
plane is **pandas inside per-component containers, orchestrated by Argo** — exactly the
shape Datacern's `executor/local_pipeline.py` + `executor/argo.py` reproduce. So there
is **nothing to replace**: Datacern's answer to `spark-jsonapi` is FastAPI/chi plus the
shared error-envelope + cursor-pagination contract in `libs/py-common` / go-common, and
its answer to pandas-on-Argo is the local pandas executor with the Argo backend behind
`executor_backend`. Recorded here because "how did we replace Spark" is a question that
will be asked again.

**2. Are the data / IO / ML component catalogs complete?** Almost. 21/21 algorithm
templates match. IO and utility components match by design. Data-prep is **34 of 35** —
`drop-columns` is missing (§P6 below), and `select-columns` has no exclude mode, so
there is no way to express "drop these two columns" without enumerating every column to
keep.

**3. Are the per-component memory/CPU configurations there?** **In the backend, yes —
and better than V1** (`app/domain/resources.py`: defaults, floors, per-tenant ceilings,
predecessor inheritance, plus a RAM-derived training-row budget V1 has no equivalent
for). **In the UI, no.** The pipeline builder never renders them, so every node silently
takes `DEFAULTS` and a user cannot size a step at all (§U1).

---

## The parity gaps (source: 2026-08-04 cross-verification)

| ID | Gap | V1 today | Datacern today | → BRD |
|----|-----|----------|----------------|-------|
| **U1** | Per-component resource config in the builder | `timeout`/`ram`/`cpus` render as a **"Resource Parameters"** group on every component form, `global_attribute:true` so they can be set once for the pipeline | backend resolves them (`resolve_resources`); **the UI never renders them** — every node takes `DEFAULTS` | **71** |
| **U2** | DAG schema propagation in the builder | 33 components ship a `component.js` `process_header(header, params)` that computes a step's **output** columns from its inputs, so downstream column pickers are correct while designing | `resolveInputDatasetId` binds every `column`/`columns` widget to the **source** dataset — after a `select-columns` or `join-data` the pickers are wrong | **71** |
| **P6** | `drop-columns` operator | real component (with label-column protection) | absent from catalog + executor; `select-columns` has no exclude mode | **71** |
| **V1c** | Distinct chart renderers | 30 chart types render as 30 distinct visualizations | API catalogs 30; **the UI has 9 renderers** — 8 types fall back to a bar chart, 4 render as a data table | **72** |
| **V2c** | Run charts | `roc_curve` / `confusion_matrix` / `decision_tree` render | no renderer; a comment in `MetricChart.tsx` says "if ever previewed" | **72** |
| **B1** | Chained ingest→run batch job | `Job`/`JobRun` with a 3-phase state machine `trigger → ingestion → pipeline`, bound to source connections, recording input/output datasets per run | ingestion schedules and pipeline schedules are **independent crons**; nothing sequences them | **73** |
| **B2** | `batch-trigger` IO component | triggers dataset ingestions from inside a pipeline | absent | 73 |
| **D1** | Dataset download / export | `Download` model + `/datasets/:id/downloads` | no dataset export endpoint (only `/rows` paging) | **74** |
| **D2** | Cross-dashboard chart search | `POST /dashboards/search_charts` | absent | 74 |
| **D3** | Cross-service search index | `search_entries` registry fed by ido / chart-service / pipeline-manager (dataset, dashboard, pipeline, model) | ⌘K palette queries datasets + dashboards + decision tables only; dashboards fetched `first:50` and filtered **client-side** | 74 |
| **F1** | Profiling depth | `pandas_profiling`: HTML report, interactions, multiple correlation methods, per-column entropy/skew/kurtosis/MAD/monotonicity | spearman-only correlations, no HTML report, no interactions; skew computed but only used to raise an alert | **75** |

**Explicitly NOT gaps** (checked and closed as covered-by-design):

- `read-from-storage` (V1 IO component) — subsumed by ingestion-service owning
  file→dataset; a pipeline reads the resulting dataset.
- `notify` (V1 data-prep component) — subsumed by the transactional outbox + event
  relay; run completion is an event, not a callback container.
- Connectors — Datacern has **19** vs V1's 15 (adds Redshift, Databricks, Spanner,
  Salesforce) plus `:test` / `preview` / `connector-types` catalog endpoints.
- Ingestion formats — Datacern has **csv/tsv/json/jsonl/parquet/avro/xml** plus
  X12/HL7v2/FHIR vs V1's 5, plus chunked resumable upload, DLQ, watermarks.
- Chart **API** surface — 30 types, tags, insights/case_management/inspector modules,
  archive/restore, import/export bundle, drilldown, cross-filter, links, documentation,
  email-report subscriptions. Server-side aggregation is **on by default** here and
  env-gated in V1.
- Per-tenant dedicated infrastructure stamping — a deliberate architecture difference
  (shared services + FORCE RLS, with `docs/design/byo-infra-hardening.md` covering the
  dedicated case), not a regression.

---

## BRD breakdown + agent plan

### BRD 71 — Pipeline builder completeness (foundation)
Resource parameters in the builder UI (per-node + pipeline-global, sourced from the
backend's floors/ceilings so the form cannot propose a rejected value), DAG schema
propagation so every downstream column picker is correct, and the `drop-columns`
operator. The highest-leverage gap of the wave: without U1 a user cannot size a step,
and without U2 every multi-step pipeline is built against stale column lists.
**Agent:** EXTEND `data_pipeline_builder` — propose per-step resources grounded in the
input dataset's row count × width, and use the same propagation to ground column
choices for steps after a projection/join.

### BRD 72 — Chart renderer completeness
Distinct renderers for the 30 catalogued types (scatter, bubble, box/whisker,
combination, geo map, histogram, waterfall, funnel, sunburst, sankey, treemap, chord,
tree) and the three run charts (ROC curve, confusion matrix, decision tree). ECharts is
already the engine — the wrapper's `Kind` union is the constraint, not the library.
**Agent:** EXTEND the analytics/insight agent's chart proposal to choose from the full
type set instead of the 9 that currently render.

### BRD 73 — Batch job orchestration
A `BatchJob` / `BatchJobRun` aggregate with the V1 3-phase state machine
(`trigger → ingestion → pipeline`), binding a set of source connections to a pipeline
template, so "refresh from source, then run the pipeline over exactly that batch" is one
governed, schedulable, resumable unit — plus the `batch-trigger` component.
**Agent:** EXTEND `data_pipeline_builder` to propose a batch job (connections + cadence
+ pipeline) as a governed WriteIntent.

### BRD 74 — Discovery & export completeness
Dataset export (async, signed artifact, reusing the query-service export path),
cross-dashboard chart search, and a real cross-service search index covering datasets,
dashboards, pipelines, models/experiments and cases — with server-side query instead of
the current `first:50` + client-side filter.
**Agent:** the search index is what makes every agent's grounding step cheap; expose it
as an MCP read tool.

### BRD 75 — Profiling depth parity
Pearson + spearman + a categorical association measure, per-column skew / kurtosis /
MAD / entropy / monotonicity as **exposed statistics**, top-K common values, and a
rendered profile report. No new infra — the profiling engine already runs pandas.
**Agent:** the richer profile is grounding data; surface the new fields through the
existing dataset MCP facade.

---

## Sequencing
71 (builder foundation — the surface every classic-pipeline user touches) → 72 (charts,
the most visible loss) → 73 (batch orchestration) → 74 (discovery) → 75 (profiling
depth). Each is independently shippable, unit-tested, and lands its agent support in the
same increment.

## Non-negotiables (carried from wave 1)
Real / no-stub / no-fake; e2e-testable on a Mac; infra-only legs flagged honestly; agent
writes always proposal-mode through `create_from_intent` (four-eyes + WORM); don't
over-engineer.

## Status

| BRD | Gaps | State |
|-----|------|-------|
| **71** pipeline builder completeness | U1, U2, P6 | **inc1–inc4 DONE** — backend (`drop-columns`, exclude mode, `GET /resource-policy`, `effective_resources`), BFF (`pipelineResourcePolicy`, `effectiveResources`), UI (resource round trip + "Resource Parameters" group + DAG schema propagation), agent (clamped envelope proposal). 74 new tests; orchestrator 220 / bff 450 / ui-web 876 / agent-runtime 409 all green. Live-verify pending. |
| **72** chart renderer completeness | V1c, V2c | **inc1–inc3b DONE** — every catalogued type now has a true renderer (boxplot / waterfall / combination / histogram / sankey / treemap / sunburst / chord / force-graph / tree / bubble size channel), the network family's `graph` data path is threaded through ui-web, and `geo_map_chart` is a declared gap. 45 tests; ui-web 921 green. **inc3 (run charts) is backend-first**: `experiment-service` has no `GET /artifacts?urn=` and the executor logs no ROC points or tree structure, so those renderers have no real data yet. |
| **73** batch job orchestration | B1, B2 | **inc1–inc3 (backend) DONE** — `BatchJob`/`BatchJobRun` + migration 0005 (RLS + at-most-one-active-run), the 3-phase machine on the existing lease/reaper machinery, idempotent triggering via ingestion-service's internal MCP facade, an event-driven ingestion phase off `ingestion.events.v1` + `dataset.version_created`, phase deadlines, retry-from-the-failed-phase, REST + outbox events, and the `batch-trigger` component. 52 new tests; orchestrator unit 260 + integration 16, ingestion-service unit 596, all green. **BFF/UI (AC-9 UI half) and the agent proposal (AC-10 / inc4) deferred.** |
| **74** discovery & export completeness | D1, D2, D3 | **PARTIAL — D2 + D1 DONE, D3 DEFERRED.** chart-service `GET /charts?q=` (cross-dashboard, RLS, cursor-paged); dataset-service `POST /datasets/{id}/exports` + `GET /exports/{id}`, version-pinned and delegated to query-service's export path (migration 0007, new action `dataset.dataset.export`). 58 new tests; chart-service unit+integration and dataset-service 301 unit / 22 integration all green. **D3 not built**: bff-graphql has no DB/consumer/cache *by CI-enforced policy*, so the specced projection would invert its architecture — the BRD records a fan-out redesign instead. Parquet export deferred (query-service returns 501). |
| **75** profiling depth parity | F1 | **inc1–inc3 DONE** — schema_version 2: per-column entropy / skewness / kurtosis / mad / variance / monotonicity / top_values (numeric-only fields absent, never zeroed), correlations as a list of pearson + spearman + bias-corrected Cramér's V (cardinality cap 50, skipped not faked), depth rendered into the existing HTML artifact, and a new read-tier MCP tool `get_dataset_column_stats`. 34 new tests; dataset-service unit 304 + integration 19 green. Live-verified against real Iceberg REST + MinIO. Interactions / missing-value matrix / duplicate-row samples and Kendall's τ deferred (see the BRD). |
