# BRD 74 — Discovery & export completeness

**Status:** DONE — 2026-08-05 · **D2 + D1 + D3 DONE** (D3 built as the stateless
fan-out redesign the earlier deferral recommended, NOT the projection the Design
below specced — see C4 and the inc3 log; AC-6/AC-7 dropped as no longer
applicable, AC-10 scoped out with a cited architectural reason) · part of the
[V1 parity wave-2 index](71_v1_parity_wave2_index.md)
**Owner:** platform · **Services:** `dataset-service` · `chart-service` ·
`experiment-service` · `agent-runtime` · `bff-graphql` · `ui-web`
**Gaps closed:** D1 (dataset export), D2 (cross-dashboard chart search), D3 (cross-service search index)

---

## Analysis

### D1 — no dataset export

V1's ido has a `Download` model with `/api/v1/downloads` and
`/api/v1/datasets/:id/downloads`: ask for a dataset, get an artifact. Datacern's
`dataset-service` routes stop at `GET /datasets/{id}/rows` (cursor-paged JSON for the
browse grid). The only way to get a dataset out today is to hand-write a `SELECT *`
saved query and export **that** through query-service — which works, and which no user
will find. query-service already has the whole async-export machine
(`POST /queries/{id}/export`, `GET /downloads/{token}`, signed tokens, retention GC), so
this is a routing and affordance gap, not a capability gap.

### D2 — no cross-dashboard chart search

V1: `POST /api/v1/dashboards/search_charts`. Datacern's `chart-service/internal/api/
server.go` has no equivalent, so "which dashboard has the denial-rate chart" is
un-answerable without opening dashboards one at a time. ~~Charts already carry `tags` and
`documentation` — the searchable material exists and is unqueryable.~~ **Wrong — see
C1 below: `tags` is a `dashboards` column and `documentations` has no write path.**

### D3 — global search is narrower than it looks

V1 maintains a real cross-service index: `search_entries` in config-service
(`owner_service, entity_type, entity_id, display_name, workspace_id, group_ids,
version`, with `search_vector` populated by an ingest worker), fed by ido, chart-service
and pipeline-manager. So datasets, dashboards, pipelines and models are all findable from
one box, with workspace and content-group scoping applied at query time.

Datacern's ⌘K palette (`CommandPalette.tsx:82`) issues three GraphQL queries:

```ts
canData ? graphqlRequest(ops.DATASETS,        { first: 6, q })          : null,
canDash ? graphqlRequest(ops.DASHBOARDS,      { workspaceId, first: 50 }) : null,
canDec  ? graphqlRequest(ops.DECISION_MODELS)                            : null,
```

Two defects beyond the missing entity types: **dashboards are fetched `first: 50` and
filtered client-side** (dashboard 51 is unfindable), and **decision models are fetched
unfiltered**. Pipelines, experiments/registered models, and cases are not searchable at
all — and those are exactly the objects an agent needs to ground against, which is why
this is worth more than its UI surface suggests.

---

## Design

### D1 — dataset export

`POST /api/v1/datasets/{id}/exports` → `{operation_id}`; `GET /exports/{id}` → status +
signed URL. Formats `csv | parquet`. Implemented by **delegating to query-service**
(compile `SELECT * FROM <dataset urn>` at the pinned version, run through the existing
export path) rather than adding a second export machine — one retention GC, one signing
secret, one audit trail. Version-pinned: exporting a dataset exports a **version**, and
the artifact records which.

### D2 — chart search

`GET /api/v1/charts?q=&module=&tag=&dashboard_id=` on chart-service: tenant-scoped
(RLS), searching `name`, `description`, `documentation`, `tags`; cursor-paged like every
other list. Reuses the existing authz action `chart.chart.read`.

### D3 — search index

> **NOT BUILT AS SPECIFIED.** Everything in this subsection was superseded by C4
> and replaced by the stateless fan-out in the inc3 log. There is no
> `search_entries` table, no consumer and no new datastore anywhere. Read inc3,
> not this.

A `search_entries` projection owned by **`bff-graphql`** (the one service that already
fans out across every domain and holds the capability registry), fed by the existing
`*.events.v1` topics each service already publishes — no new producer code in the owning
services, which is the difference between this and V1's approach.

- Table: `(tenant_id, workspace_id, owner_service, entity_type, entity_id, display_name,
  description, tags[], group_ids[], updated_at, search_vector tsvector)`, RLS-bound,
  GIN index on `search_vector`.
- Consumers for `dataset.events.v1`, `chart.events.v1`, `pipeline.events.v1`,
  `experiment.events.v1`, `case.events.v1` upsert/delete entries.
- `search(q, types, workspaceId, first)` GraphQL query, capability-filtered per entity
  type using the same `cap()` gates the palette already applies.
- `CommandPalette` collapses its three queries into that one — fixing the `first:50`
  client-side filter as a side effect.
- Exposed as an MCP read tool so agents ground against it.

> **The Design above was written before the code was checked. Four of its premises are
> wrong — the searchable columns (D2), the authorization scope (D2), query-service's
> export contract (D1) and bff-graphql's ownership claim (D3). Read "Corrections to
> this BRD's own premises" below before treating any of it as the built design.**

### Increment plan

- **inc1** — D2 (chart search: smallest, self-contained).
- **inc2** — D1 (dataset export via query-service delegation).
- **inc3** — D3. ~~projection + consumers + GraphQL + palette + MCP tool~~ →
  **downstream `q` (chart/experiment/agent-runtime) + a stateless `search()`
  fan-out + palette**; the MCP tool scoped out (see D-3).

## Acceptance criteria

| AC | Statement |
|----|-----------|
| AC-1 | `POST /datasets/{id}/exports` produces a downloadable CSV/parquet of the pinned version; the artifact records the version. |
| AC-2 | Export honors RLS: a cross-tenant dataset id 404s. |
| AC-3 | Dataset export reuses query-service's signing + retention; no second GC path exists. |
| AC-4 | `GET /charts?q=` finds charts by name, description, documentation and tag, across dashboards, tenant-scoped. |
| AC-5 | Chart search is cursor-paged and respects `chart.chart.read`. |
| AC-6 | The search projection contains entries for datasets, dashboards, pipelines, models and cases after their events are consumed. |
| AC-7 | A deleted entity's entry is removed on its delete event. |
| AC-8 | `search()` returns only entity types the caller's capabilities allow. |
| AC-9 | The ⌘K palette issues **one** query and finds a dashboard ranked below the first 50 by name. |
| AC-10 | The search MCP tool returns the same results as the GraphQL query for the same principal. |

## Corrections to this BRD's own premises (checked against the code, 2026-08-05)

Four load-bearing claims in the Analysis/Design above turned out to be wrong. They
are corrected here rather than quietly worked around, because each one changed a
design decision.

**C1 — "Charts already carry `tags` and `documentation`" (D2). Charts carry
NEITHER.** `services/chart-service/migrations/000001_init.up.sql` puts `tags
TEXT[]` on **`dashboards`**, not `charts`; the `charts` table has no tags column and
`domain.Chart` has no `Tags` field. `documentation` is a separate `documentations`
table keyed by `(documentable_type, documentable_id)` — and chart-service has **no
write path for it at all**: the only three references to that table in the entire Go
tree are the archive cascade and two `max(updated_at)` reads (`store/pg.go:126,203,223`).
No handler, no store method, no OpenAPI path ever inserts a row.
→ Design change: `q` searches chart `name`/`description` plus the (real, RLS-bound,
currently unpopulated) chart documentation body; `module` and `tag` filter on the
**parent dashboard**, which is where those columns actually live. The documentation
leg is correct SQL over a real table that nothing writes to yet — stated plainly
rather than dropped, and covered by an integration test that inserts a row directly.

**C2 — `GET /charts?q=` cannot be workspace-agnostic (D2).** `chart.chart.read` is a
**workspace-scoped** grant (`authz.Manifest()`), and OPA's `ctx_ok` requires the
workspace context for workspace-scoped actions. A search spanning every workspace
could not be covered by one authorization decision.
→ Design change: `workspace_id` is a **required** query param, exactly as it already
is on `GET /dashboards`. "Cross-dashboard" is delivered; "cross-workspace" is not,
and cannot be without a per-row authz filter this service has no primitive for.

**C3 — query-service's export contract is not what the Design describes (D1).** The
Design says "delegate to query-service's existing async export machine (`POST
/queries/{id}/export`, `GET /downloads/{token}`)". Verified against
`services/query-service/internal/api/`:
- **`POST /queries/{id}/export` does not exist.** Export hangs off an *execution*:
  `POST /api/v1/executions/{id}/export` (`server.go:105`).
- **Export is synchronous, not async** — it returns **201** with
  `{format, url, expires_at}` and mints the signed URL inline
  (`handlers_executions.go:326`). There is **no export status endpoint and no
  operation id**. The asynchronous part is the *execution*, which is what gets polled.
- **No saved query has to be created.** `POST /api/v1/sql/run` produces a real
  execution, so the ad-hoc `SELECT *` never needs a `saved_queries` row.
- **`format: "parquet"` returns 501 NOT_IMPLEMENTED** (`handlers_executions.go:306`)
  — see D-1 below.
- Retention GC is real but **has no env var**: `resStore.GC(24 * time.Hour)` on a
  15-minute ticker, both hardcoded (`cmd/server/main.go:302`).
- `GET /api/v1/downloads/{token}` is correct as described: HMAC-SHA256 over the token
  payload with `EXPORT_SIGNING_SECRET`, **no JWT required**.
→ Design change: dataset-service drives `sql/run → poll execution → export`, and the
"operation id + status endpoint" the BRD asked for is provided by **dataset-service's
own** `dataset_exports` row, not by query-service.

**C4 — bff-graphql is the wrong owner for a search projection (D3), and does not hold
the capability registry.** The Design justifies putting `search_entries` in
bff-graphql because it "already fans out across every domain and holds the capability
registry". Neither half is a reason that survives contact with the code:
- bff-graphql has **no database, no event consumer and no cache — by explicit
  design, enforced in CI**. `services/bff-graphql/eslint.config.js` bans importing
  `pg` ("BFF holds no DB (BFF-FR-003 / BRD §4)"), `kafkajs` ("BFF emits/consumes no
  events (BRD §6)") and `ioredis` ("No tenant data at rest in the BFF (BRD §4)").
  `deploy/services.yaml:43` declares `db: ~, migrate: false`. There are no migrations,
  no SQL and no stateful test fixture anywhere in the service.
- It does **not** hold the capability registry. `cap()` lives in
  `services/ui-web/src/lib/authz/registry.ts`; the BFF only *passes through* rbac's
  `GET /api/v1/me/capabilities` and makes **no authorization decision in any
  resolver** — downstream services enforce on the forwarded JWT.
→ See the D3 deferral below.

---

## Implement & Test log

### inc1 — D2: cross-dashboard chart search — DONE

`GET /api/v1/charts?workspace_id=&q=&module=&tag=&dashboard_id=&include_archived=&limit=&cursor=`
in chart-service.

- **`internal/store/pg.go`** — `SearchCharts(ctx, tenant, domain.ChartSearchFilter)`:
  a single statement joining `charts → dashboards` (because `module`/`tags` are
  dashboard columns, per C1), with an `EXISTS` sub-select over `documentations` for
  chart-scoped documentation bodies, `ILIKE … ESCAPE '\'` over
  name/description/documentation, keyset pagination on `c.id`, and archived
  dashboards excluded by default. Runs inside `withTenant`, so **RLS** is what scopes
  it — a cross-tenant `workspace_id` matches nothing rather than being filtered in Go.
  Plus `LikePattern()`, which escapes `\ % _` so a search term containing a LIKE
  metacharacter matches literally. Sources are hydrated with **one batched**
  `chart_id = ANY($1)` query, not `ListCharts`' per-chart N+1.
- **`internal/api/handlers_charts.go`** — `handleSearchCharts`: required
  `workspace_id` (C2), one `authz.ActionChartRead` decision scoped to it, `httpx.ParsePage`
  + the existing base64 cursor, 422 on unknown module / malformed `dashboard_id` /
  corrupt cursor, and `chartSearchView` which decorates every hit with
  `dashboard_id`/`dashboard_name`/`dashboard_module`/`dashboard_tags` — the part that
  actually answers "which dashboard has the denial-rate chart".
- **`internal/domain/types.go`** — `ChartSearchFilter`, `ChartSearchHit`.
- **`internal/api/server.go`** — `r.Get("/charts", …)` inside the authenticated group;
  `SearchCharts` added to the `Store` port. **`api/openapi.yaml`** + README
  traceability row updated.

**Test:** `internal/api/chartsearch_test.go` (**15 cases / 11 funcs**) — finds a chart
on a *different* dashboard by name and returns its dashboard context; description
match; documentation match; module/tag/`dashboard_id` filters and `q`+filter
composition; archived dashboards excluded and `include_archived=true`; `limit=1`
cursor paging with no repeats and `has_more` clearing; `chart.chart.read` denied →
403 PERMISSION_DENIED; **cross-tenant search returns an empty page and a cross-tenant
chart id still 404s**; 5 bad-input cases are 422 not 500; another workspace's chart is
never returned. `test/integration/chartsearch_test.go` (**9 cases / 2 funcs**) is the
authoritative test of the SQL itself against real Postgres through the shipped
non-owner `chart_app` role: name/description/**documentation** matching (inserting a
real `documentations` row), case-insensitivity, `%` and `_` matching **literally**,
the dashboard filters, archived exclusion, cursor paging, and RLS proving tenant B
sees nothing. `make test-unit` green (all packages); `make lint` **0 issues**;
`make test-integration` green.

### inc2 — D1: dataset export by delegation — DONE (csv)

`POST /api/v1/datasets/{id}/exports` → 202 `{id, operation_id, status, version_no,
version_urn, …}`; `GET /api/v1/exports/{id}` → status + query-service's signed
`download_url` and its `expires_at`.

- **`app/adapters/query_export.py` (new)** — `QueryServiceExportRunner`, the only new
  moving part, speaking query-service's **real** contract (C3):
  `POST /api/v1/sql/run` (async) → poll `GET /api/v1/executions/{id}` to a terminal
  status → `POST /api/v1/executions/{id}/export` → absolutise the host-relative
  `/api/v1/downloads/{token}` URL it returns. `launch()` schedules the drive as a
  background task so the 202 is immediate; `drain()` is awaited on shutdown
  (`app/main.py`) so no export is stranded in `pending`. `build_export_sql()` emits
  `SELECT * FROM {{dataset('<name>', version=<n>)}}` — **version-pinned through
  query-service's own macro**, so the server resolves the pinned physical snapshot and
  nothing user-controlled ever reaches the engine as an identifier; dataset names
  containing `' \ { } \n` are **refused** (`UnsafeDatasetName`) because that macro
  parser has no escape sequence.
- **`app/domain/services.py`** — `ExportService.create/get/complete`. `create`
  resolves the version (explicit `version`, else the dataset's current), refuses an
  expired version (410) or a dataset with none (422), enforces a per-dataset
  in-flight cap (429), writes the operation + `dataset.export.requested` in one UoW,
  and launches **strictly after commit**. `complete` is **idempotent** — a second
  report against a terminal export is a no-op, so a redelivered result cannot rewrite
  a finished row.
- **Persistence** — `DatasetExport` entity, `ExportRepo` port, `DatasetExportRow`,
  `SqlExportRepo`/`MemoryExportRepo`, and migration **`0007_dataset_exports`** with
  `ENABLE`+`FORCE ROW LEVEL SECURITY` and the standard `tenant_isolation` policy.
  Deliberately thin: **no artifact column and no expiry sweeper** — only which
  version was exported, the query-service execution id, and the URL it minted.
- **Authorization** — new action `dataset.dataset.export` (canonical verb; added to
  `registration.py`'s manifest). The **caller's** bearer token is forwarded verbatim,
  so query-service re-authorizes the run and the export under the same user
  (`query.execution.execute` / `query.execution.export`). A dataset export therefore
  cannot reach data the user could not already query.
- **`app/config.py`** — `query_service_url`, `export_poll_interval_seconds`,
  `export_timeout_seconds`, `export_max_concurrent_per_dataset`. `api/openapi.yaml`
  + README adapter table + traceability row updated.

**AC-3 is structural, not incidental:** there is no artifact storage, no signing key
and no GC in dataset-service. The bytes are produced by query-service's result store,
the link is signed with `EXPORT_SIGNING_SECRET` there, and the 24h retention GC in
`query-service/cmd/server/main.go` is the only one that exists.

**Test:** `tests/unit/test_dataset_exports.py` (**30**) — the runner is driven against
an `httpx.MockTransport` implementing query-service's *actual* routes (a contract
fake, per CONVENTIONS.md; never a live service): happy path returning query-service's
signed URL, caller-token forwarding on every call, failed execution / rejected run /
501-on-parquet / timeout all reported rather than swallowed, `launch` reporting from
the background task, and a crashing client still producing a terminal `failed` report.
SQL construction: version-pinned text asserted exactly, 6 unsafe-name cases refused.
API/service: current-version pinning (incl. `version_urn` ending `@v2`), explicit
version, unknown version 404, no-version 422, parquet 422 **with the real reason**,
concurrency cap 429, missing `dataset.dataset.export` 403, **cross-tenant dataset id
404 and cross-tenant export id 404**, completion recording url/rows/expiry + event,
failure recorded, completion idempotent. One test drives the **real**
`QueryServiceExportRunner` end to end through the app and asserts the SQL
query-service received was `SELECT * FROM {{dataset('Claims', version=1)}}`.
`tests/integration/test_dataset_exports_pg.py` (**3**) repeats the round trip against
real Postgres + the shipped RLS policy through the non-superuser `dataset_rt` role,
including a raw-SQL check that `dataset_exports` is invisible without the tenant GUC
and to tenant B. `POST /datasets/{id}/exports` also added to the existing
cross-tenant matrix in `test_isolation_authz.py`.

`make test-unit` **301 passed** (was 270); `make lint` clean;
`make test-integration` **22 passed** (was 19).

### inc3 — D3: cross-service search as a stateless fan-out — DONE

The Design above put a `search_entries` projection table inside `bff-graphql`,
fed by Kafka consumers. **That is not what was built, and it should not be** —
see C4. This increment builds the redesign the earlier deferral recommended: a
stateless `search()` root field that fans out to the services that own the data,
after giving the three services that had no text search one.

The shape of the decision, stated plainly: a projection buys freshness you have
to maintain and an authorization model you have to reimplement, in exchange for
one round trip you were going to make anyway. Five of the eight entity kinds
already had, or trivially gained, a real server-side search in their own
service. Fanning out to them costs one call per kind, keeps freshness at the
source, and leaves every authorization decision with the service that already
makes it. There is no index to fall behind and no delete event to miss — which
is exactly why AC-6 and AC-7 stopped meaning anything.

**Downstream first — the three services that could not be searched at all.**

- **`chart-service` — `GET /dashboards?q=`.** `handleListDashboards` read only
  `workspace_id/limit/cursor/filter[module|archived|tag]`; there was no way to
  find a dashboard by name. `ListDashboards`' seven positional parameters became
  `domain.DashboardListFilter`, and the statement gained
  `(name ILIKE $n ESCAPE '\' OR description ILIKE $n ESCAPE '\')` reusing inc1's
  `LikePattern`, so a term containing `%` or `_` matches literally. Still inside
  `withTenant`, so **RLS** is what scopes it. This is the direct fix for the
  palette's `first: 50` + client-side filter.
- **`experiment-service` — `GET /experiments?q=`, `GET /experiments/list_archived?q=`,
  `GET /models?q=`.** The service had no `q` of any kind. `SqlExperimentRepo.list`
  and `SqlModelRepo.list_models` gained an `ILIKE … ESCAPE` over name +
  description, composed with the existing workspace/stage/id filters and the
  existing cursor page; `app/utils.like_contains` escapes the metacharacters, and
  `MemoryState`'s `_text_match` mirrors it so the unit tier tests the same
  semantics.
- **`agent-runtime` — `GET /decision-models?q=&limit=&cursor=`.** This route
  returned **every** decision table for the tenant, unfiltered and unpaged — the
  reason the palette fetched the lot and matched names in the browser. It now
  takes `q` (a real `ILIKE … ESCAPE` over `name` and `dataset_urn`) and a genuine
  **keyset** page: the sort key is `(name ASC, version DESC)`, so the cursor
  predicate is that tuple comparison written out —
  `name > :n OR (name = :n AND version < :v)`. New `app/store/paging.py` holds
  the cursor codec (a malformed cursor is a 422, not a 500) and the LIKE helper.

**Then the BFF — `src/resolvers/search.ts`, and nothing else stateful.**

`search(q, types, workspaceId, first)` settles one leg per requested type, each
leg being exactly ONE call to the owning service using that service's own text
search, with the caller's JWT forwarded verbatim:

| type | owning call |
|---|---|
| `DATASET` | dataset-service `GET /datasets?q=` (Postgres FTS, `ts_rank`) |
| `DASHBOARD` | chart-service `GET /dashboards?q=` (**new above**) |
| `CHART` | chart-service `GET /charts?q=` (**this BRD's inc1**) |
| `PIPELINE` | pipeline-orchestrator `GET /pipelines?filter[name]=` (a real ILIKE) |
| `EXPERIMENT` | experiment-service `GET /experiments?q=` (**new above**) |
| `MODEL` | experiment-service `GET /models?q=` (**new above**) |
| `CASE` | case-service `GET /cases?q=` (OpenSearch) |
| `DECISION_MODEL` | agent-runtime `GET /decision-models?q=` (**new above**) |

Three properties are deliberate rather than incidental:

- **The BFF still decides nothing.** A leg whose owner answers 403 is reported
  `denied: true` with zero hits; the query still succeeds and the other legs
  still answer. That is the downstream's verdict, *observed* — not a permission
  check reimplemented in the BFF (BFF-FR-003). AC-8 is therefore true by
  construction rather than by client-side discipline.
- **Failures are reported, never swallowed.** A leg whose owner is down comes
  back with its stable error code (`SERVICE_UNAVAILABLE`, …), so a caller can
  distinguish "no matches" from "you may not read this" from "that service is
  down". `DASHBOARD`/`CHART` without a `workspaceId` report
  `error: "WORKSPACE_REQUIRED"` rather than failing the whole query —
  `chart.*` grants are workspace-scoped (C2), so those two legs genuinely cannot
  be answered workspace-agnostically.
- **No eslint ban was touched.** `pg`, `kafkajs` and `ioredis` remain banned;
  `deploy/services.yaml` still says `db: ~, migrate: false`; the service still
  has no migration, no SQL and no stateful fixture.

Also wired in the BFF, all of it passthrough: **`chartSearch(...)`** — inc1's
`GET /charts` finally reachable from the graph (one client method, one root
field, one resolver, one mapper `mapChartSearchHit`); `q` on `dashboards`,
`experiments` and `models`; and `decisionModels` became a real
`DecisionModelConnection` now that its downstream pages. `ChartSearchHit` is a
flat type, **not** a `Chart` — `Chart.data` resolves per chart, so a list of
search hits would have turned it into one downstream call per row (BFF-FR-030).
It carries `dashboardId` instead, which is the actionable answer anyway.

**`ui-web` — the ⌘K palette is one query.** `CommandPalette.tsx` replaces its
three documents (`DATASETS` + `DASHBOARDS{first:50}` + `DECISION_MODELS`, the
last two filtered in the browser) with a single `search()` call. `SEARCH_KINDS`
binds each entity kind to the capability that unlocks it and the route a hit
opens, so the palette asks only for kinds the viewer plausibly holds — a UX
filter over the top of the real, downstream decision, never in place of it. The
palette now reaches charts, cases, pipelines, experiments and models, which it
never could before; a chart hit opens the dashboard it lives on, which is the
question D2's search exists to answer.

**Test.**

- `chart-service` `internal/api/dashboardsearch_test.go` (**8**) — 60 dashboards
  where the target sorts last: the unfiltered first page of 50 provably does not
  contain it and `q=denial` returns exactly it (the palette defect at the service
  tier); description match; case-insensitivity; `%` matching literally; `q`
  composed with `filter[module|tag|archived]`; `limit=1` cursor paging with no
  repeats; **cross-tenant search returns an empty page**; another workspace of the
  same tenant is never returned; `chart.dashboard.read` denied → 403.
  `test/integration/dashboardsearch_test.go` (**2 funcs / 5 subtests**) repeats the
  load-bearing ones against **real Postgres** through the shipped non-owner
  `chart_app` role, proving the ESCAPE clause and that **RLS**, not application
  filtering, is what hides tenant A's dashboards from tenant B.
- `experiment-service` `tests/unit/test_text_search.py` (**11**) — `like_contains`
  escaping; name and description matching; case-insensitivity; `%` and `_`
  literal; cursor paging over the `q` result set; `q` on the archived list;
  **tenant isolation**; composition with `filter[workspace_id]` and `filter[id]`;
  the model registry leg. `tests/integration/test_text_search.py` (**3**) against
  real Postgres + FORCE RLS.
- `agent-runtime` `tests/unit/test_decision_model_search.py` (**10**) — the LIKE
  and cursor helpers; `q` over name and `dataset_urn`; case-insensitivity; `%`
  literal; keyset paging that terminates with no row repeated; 60 tables where the
  target sorts last and `q` still finds it; a bad cursor is **422 not 500**;
  **tenant isolation**.
- `bff-graphql` `tests/unit/search.test.ts` (**18**) — the real resolvers through
  Apollo against a double that speaks each owning service's *actual* query
  contract, so a leg that stopped forwarding `q` fails here. Every kind reached in
  one query with exactly one downstream call per type; `q` forwarded under each
  service's own parameter name (`q` / `filter[name]`); `types` narrows the fan-out
  so an unrequested service is never called; `first` caps each leg; an empty term
  calls nothing; JWT forwarded on every leg. **AC-8:** 403 on three legs → those
  three `denied`, no hits of a denied type reach the caller, the rest unaffected;
  all-denied is an empty *success*, not an error; a broken service reports
  `SERVICE_UNAVAILABLE` rather than a silent "no matches"; `WORKSPACE_REQUIRED`
  without a workspace. **AC-9:** 51 dashboards, the match ranked last, one call
  carrying `q`, the 51st returned. Plus `chartSearch` mapping + filter forwarding
  + its 403, `decisionModels` paging, `experiments`/`models` `q`, and
  cross-tenant checks that hit URNs are built from the **caller's** tenant claim
  and that two tenants' searches share no state.
- `ui-web` `CommandPalette.test.tsx` (**9**, 4 new) — **AC-9 directly**: against a
  server double holding 51 dashboards where only the last matches, the palette
  finds it, issues **exactly one** query for that term, and never emits the three
  legacy documents; a chart hit routes to its dashboard; **AC-8**: a viewer
  holding only `dataset.dataset.list` + `case.case.read` requests exactly
  `["CASE","DATASET"]` and no dashboard option is rendered.

Measured on this branch: chart-service `make test-unit` green + `make lint`
**0 issues** (integration green against real Postgres); experiment-service
`make test-unit` **98 passed** (was 87) + `make lint` clean, integration `q`
suite **3 passed**; agent-runtime `make test-unit` **419 passed** (was 409) +
`make lint` clean; bff-graphql `tsc --noEmit` clean, `vitest run` **468 passed
in 61 files** (was 450 in 60), `eslint .` clean, SDL snapshot regenerated;
ui-web `tsc --noEmit` clean, `vitest run` **943 passed in 131 files** (was 939).

### Deferred

**D-1 — parquet export.** `POST /datasets/{id}/exports {"format":"parquet"}` is a
**422 with an explicit reason**, not a silent csv fallback and not a locally-written
parquet file. query-service — which owns the export path — answers parquet with
`501 NOT_IMPLEMENTED` (`handlers_executions.go:306`, `TODO(QRY-FR-062): parquet
export via Arrow writer`). Writing a parquet writer in dataset-service would be
exactly the second export machine AC-3 forbids. **The fix belongs in query-service**;
when it lands, `ExportService.ALLOWED_FORMATS` grows by one string and nothing else
changes. AC-1 is therefore met for csv only.

**D-2 — a `pg_trgm` GIN index for chart search.** `ILIKE '%q%'` cannot use a btree
index. No migration was added because `CREATE EXTENSION pg_trgm` requires privileges
the migration owner may not hold in production. Chart counts per workspace are small
enough that this is not yet a problem; it is a known scaling item, not a defect.

**D-3 — the search MCP tool (AC-10). SCOPED OUT, with a specific reason.**

AC-10 asks for the search to be exposed as an MCP read tool returning the same
results as the GraphQL query for the same principal. Checked against the code,
that cannot be built honestly today, and the blocker is one line of tool-plane:

- **tool-plane is the only MCP surface**, and `tools/call` federates to the
  `mcp_backends.internal_url` resolved from the tool's `owner_service`
  (`tool-plane/internal/api/gateway.go:344`).
- The federated request body is `{tool_id, version, args, tenant, obo_sub,
  agent_id}` plus `X-Trace-Id` and the SPIFFE headers. **No `Authorization`
  header is forwarded** (`tool-plane/internal/mcp/backend.go:125-148`). That is
  why every existing backend facade re-authorizes the effective human against
  its OWN OPA sidecar and then reads its OWN database — e.g. fhir-bridge's
  `handlers_facade.go:89-100` evaluating `Subject{ID: obo_sub, Typ: "user"}`.
- `search` has no own database to read. Its only capability is calling eight
  other services, and the only way bff-graphql can call them is by forwarding
  the caller's JWT — which the facade contract does not give it. Serving the
  facade would mean either minting a token in the BFF (a new signing authority
  in a service that holds no keys) or making its own OPA decision (needs
  `ioredis`, which `eslint.config.js` bans, and inverts BFF-FR-003).
- No other service can host it either: the fan-out spans eight domains, and no
  service other than the BFF has clients for more than its own.

A partial tool — one MCP read tool per owning service — would be real code but
would **not** satisfy AC-10 as written: it would return one entity kind, not the
same results as `search()`. Shipping it under this AC would be mislabeling, so
it was not shipped.

**What would unblock it**, concretely and in tool-plane rather than here: have
the gateway forward the verified caller token to the backend (`backend.go`
`once()`), and widen the agent_obo scope model so a read tool's token carries
the downstream actions the tool needs — today `mint_agent_obo` issues
`scopes=[tool_id]` on the proposal-execution path
(`agent-runtime/app/proposals/service.py:412-415`) and OPA's `user_path` for
`typ=agent_obo` requires an exact `scopes` match on the action being checked
(`rbac-service/policy/datacern_authz_input.rego:55-58,96-99`), so a token scoped
`search.query` would be denied for `dataset.dataset.list` even if it were
forwarded. Both are tool-plane/rbac decisions with their own blast radius; they
do not belong at the tail of a discovery BRD.

Meanwhile `search()` is a normal authenticated GraphQL field, so an agent
holding a user JWT can already call it — it is only the governed **MCP**
tool-plane path that is missing.

### AC status

| AC | State |
|----|-------|
| AC-1 | **Met for csv** — the artifact records `version_no` + `version_urn`, and the SQL query-service executes is version-pinned. Parquet deferred to query-service (D-1). |
| AC-2 | **Met** — cross-tenant dataset id and cross-tenant export id both 404, unit + real-RLS integration. |
| AC-3 | **Met** — no artifact store, no signing key, no GC in dataset-service; all three stay in query-service. |
| AC-4 | **Met** — name, description, documentation and dashboard tag, across dashboards, tenant-scoped. Workspace-scoped by necessity (C2). |
| AC-5 | **Met** — cursor-paged on chart id; `chart.chart.read` enforced. |
| AC-6 | **Dropped — no longer applicable.** It asserts the *search projection* contains entries after events are consumed. D3 was built as a stateless fan-out (inc3): there is no projection, no consumer and no entry, by design (C4). Freshness is the owning service's, so the property this AC was protecting — results reflect reality — is met more directly than a projection could. |
| AC-7 | **Dropped — no longer applicable.** Same reason: with no projection there is no entry to remove on a delete event. A deleted entity stops matching because the owning service stops returning it, which is the guarantee AC-7 was a proxy for. |
| AC-8 | **Met** — `search()` reaches only the requested types, and a type whose owning service answers 403 comes back `denied: true` with zero hits while the rest of the query still succeeds. The BFF makes no authorization decision (BFF-FR-003) — it reports the downstream's. Covered in `bff-graphql/tests/unit/search.test.ts` (per-leg denial, all-denied, workspace-required) and in the palette test, where a viewer holding two capabilities requests exactly two types. |
| AC-9 | **Met** — the ⌘K palette issues **one** `search()` query. `ui-web/src/components/shell/CommandPalette.test.tsx` drives a server double holding 51 dashboards where only the last matches: the palette finds it, makes exactly one request for that term, and never emits the three legacy documents. Proven again at the BFF tier and, against real Postgres, at the chart-service tier. |
| AC-10 | **Scoped out** — the MCP read tool. tool-plane forwards **no** `Authorization` header to a backend facade (`internal/mcp/backend.go:125-148`), so a facade must re-authorize `obo_sub` itself and read its own store; `search` has no store and can only call other services with a forwarded JWT it would not receive. Full reasoning, and the two tool-plane/rbac changes that would unblock it, in D-3 above. Not faked, and not shipped as a per-service partial that would not satisfy the AC as written. |
