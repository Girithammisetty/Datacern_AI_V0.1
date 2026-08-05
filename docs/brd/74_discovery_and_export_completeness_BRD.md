# BRD 74 — Discovery & export completeness

**Status:** OPEN — 2026-08-04 · part of the [V1 parity wave-2 index](71_v1_parity_wave2_index.md)
**Owner:** platform · **Services:** `dataset-service` · `chart-service` · `bff-graphql` · `ui-web`
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
un-answerable without opening dashboards one at a time. Charts already carry `tags` and
`documentation` — the searchable material exists and is unqueryable.

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

### Increment plan

- **inc1** — D2 (chart search: smallest, self-contained).
- **inc2** — D1 (dataset export via query-service delegation).
- **inc3** — D3 (projection + consumers + GraphQL + palette + MCP tool).

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

## Implement & Test log

_(pending)_
