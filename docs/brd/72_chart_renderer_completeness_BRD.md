# BRD 72 — Chart renderer completeness

**Status:** inc1–inc2 DONE (unit-verified) — 2026-08-05 · part of the [V1 parity wave-2 index](71_v1_parity_wave2_index.md)
**Owner:** platform · **Services:** `ui-web` (+ `pipeline-orchestrator` / `experiment-service` for inc3)
**Gaps closed:** V1c (distinct renderers for the catalogued types) · V2c (run charts) — **inc3 open, see below**

---

## Analysis

`chart-service` is at full parity with V1 on the **API**: `domain.Catalog()` serves all
30 chart types with per-type JSON Schemas, the same three data classes V1 has
(`dataset` / `run` / `query`), tags, the insights / case_management / inspector modules,
archive+restore, export/import bundles, drilldown, cross-filter, chart links,
documentation, and CSV/PNG export — with server-side aggregation **on by default**
(V1 gates it behind `SERVER_AGGREGATION_ENABLED`).

The loss was in `ui-web`: `ChartView` resolved all 30 types onto **nine** renderers, and
`EChartsChart` declared `type Kind = "bar" | "line" | "pie" | "heatmap" | "gauge"`.

### What the data actually looks like

The first draft of this BRD assumed the shapes. Reading
`services/chart-service/internal/domain/shape.go` corrected **three** of its premises,
each of which would have produced wrong work:

| Draft assumption | Reality |
|---|---|
| sunburst / sankey / treemap / chord are **hierarchies** with a `children` shape | They are **`FamilyHeatmap`** — tabular `[x, y, value]` triples, the same shape `heatmap_chart` gets. A triple set is a weighted edge list, which is exactly what all four need. |
| tree / decision_tree render as a "generic network" | The whole network family renders **nothing**. `Shape()` sets `Graph` and leaves `Columns: []` / `Rows` unset for `FamilyNetwork`, and `ui-web` never selected `graph` — so `NetworkChart` always saw zero rows and drew its empty state. |
| scatter / bubble / funnel degrade to bars | They **do not**. `buildEChartsOption` already refined them by `chartType` (`isScatter`, `ct === "funnel_chart"`). Bubble was missing only its **size channel**. |

### The real collapse

| Catalogued type | Rendered as | Cause |
|---|---|---|
| `whisker_chart` | bar | no boxplot builder |
| `combination_chart` | bar | no dual-axis builder |
| `histogram_chart` | bar | no contiguous-bin option |
| `waterfall_chart` | bar | no running-total option |
| `geo_map_chart` | bar | no basemap — genuinely unavailable |
| `sunburst` / `sankey` / `tree_map` / `chord` | **data table** | routed to the grid renderer |
| `network` / `network_graph` / `tree` / `decision_tree` | **empty state** | `graph` never selected in ui-web |
| `roc_curve` / `confusion_matrix` / `decision_tree` (run) | bar | absent from `EXACT_KIND` entirely |
| `bubble_chart` | scatter, fixed radius | size channel missing |

Presenting one visualization under another's label is worse than rendering nothing: a
waterfall drawn as a bar chart is a **wrong answer** delivered confidently.

### inc3 — the run charts are a backend gap, not a renderer gap

Tracing the run-chart path end to end found that no renderer could have worked:

1. `chart-service`'s `HTTPArtifacts.FetchArtifact` sends run URNs to
   `experimentURL + "/api/v1/artifacts?urn="`. **`experiment-service` has no such
   endpoint** — it exposes `/runs/{id}/artifacts` and `/runs/{id}/artifacts/url` only.
   The call 404s and surfaces as `EUpstream`. (`dataset-service` *does* have
   `GET /artifacts?urn=`, which is why the dataset metric chart works.)
2. Of the three run charts, only one has data to draw at all. The executor
   (`pipeline-orchestrator/app/executor/local.py`) logs a **flattened confusion matrix**
   as `cm_{i}_{j}` metrics (when `n_classes <= 10`) and a scalar `roc_auc`. There are
   **no ROC curve points** (`fpr`/`tpr`) and **no decision-tree structure** anywhere.

So a ROC-curve or decision-tree renderer built today would have nothing real to draw.
Rather than fabricate curve points, inc3 is scoped as backend-first (below), and the
three run types are routed to the metric renderer meanwhile — off the bar fallback,
showing the real metrics that do exist.

---

## Design

### 1. Widen the engine wrapper (`EChartsChart`)

`Kind` becomes the full renderer set, and option construction moves into a pure
`buildOption(kind, chartType, columns, rows, graph, theme, opts)` that makes the
family→shape mapping legible in one place. It returns `null` for a network chart with no
graph, so the caller keeps its fallback instead of rendering an empty canvas.

### 2. Heatmap-family builders (`src/lib/charts/relational.ts`)

`toLinks` turns `[x, y, value]` into weighted links (summing duplicate pairs), and each
type is a projection of that:

- **sankey** — ECharts throws on a cyclic sankey, and `[x, y]` triples can express `a→a`
  or `a→b` alongside `b→a`. The two columns are **namespaced into distinct node sets**,
  which is also what the data means: x is the source dimension, y the target.
- **treemap / sunburst** — two-level hierarchy, values rolled up to the parent.
- **chord** — ECharts has no `chord` series; a chord diagram *is* a `graph` in circular
  layout with weight-proportional edges. Unlike sankey both sides share **one** node
  namespace, because showing flow within a single set is the point of the type.

### 3. Network-family builders

- **network** — force graph, nodes sized by degree.
- **tree** — `toForest` roots at any node that is never a target. Arbitrary query output
  can contain cycles, so the walk carries a `seen` set: a tree renderer a user's SQL can
  drive into infinite recursion is not a renderer. A multi-root forest is wrapped so no
  component is silently dropped (ECharts' `tree` takes one root).
- **The actual fix** is threading `graph` through `ui-web`: the GraphQL selections
  (`CHART_FIELDS`, `CHART_PREVIEW`), `ChartData`/`ChartShapedData`, `ChartCard`,
  `ChartEditor`, the embed page, `ChartView` and `NetworkChart`. `bff-graphql` already
  exposed the field.

### 4. Axis-family builders (`src/lib/charts/echarts.ts`)

- **boxplot** — Tukey five-number summary; the distribution per category is the set of
  series values there, which is what a whisker chart with a `dataseries` split produces.
  Without a split each box degenerates to a point — the honest rendering of a whisker
  chart configured without a distribution, not a defect to paper over.
- **waterfall** — running total via the invisible-base idiom; rises and falls colored
  apart, which is the entire point of the type.
- **combination** — first measure as bars, the rest as lines on a **second axis**. A
  count and a rate on one shared scale is unreadable — precisely why the bar fallback
  was wrong here.
- **histogram** — contiguous bins (zero category gap).
- **bubble** — the second measure drives the radius; with one measure it degrades to a
  fixed-size scatter rather than inventing a dimension.

### 5. `geo_map_chart` — declared, not faked

Its data resolves fine; a map needs GeoJSON basemaps that are not bundled and cannot be
fetched at render time under the deployment's CSP. `UnsupportedChart` names the gap.

### inc3 plan (open)

1. `experiment-service`: add `GET /api/v1/artifacts?urn=` mirroring dataset-service's,
   resolving a run URN to its metric artifact from the existing Postgres run mirror
   (`cm_{i}_{j}` → a real matrix; `roc_auc`; params/metrics for a parameter chart).
2. `pipeline-orchestrator`: log real ROC curve points (`sklearn.metrics.roc_curve` →
   fpr/tpr arrays) and, for tree models, the tree structure — as MLflow artifacts, so
   the data a ROC/decision-tree chart needs exists before a renderer claims to draw it.
3. `ui-web`: `RunChart` — ROC curve with the y=x reference and AUC, labelled confusion
   matrix, decision tree via the existing tree builder.

---

## Acceptance criteria

| AC | Statement | State |
|----|-----------|-------|
| AC-1 | Every catalogued type resolves to a renderer that is **not** a silent bar-chart fallback (or, for `geo_map_chart`, to a named unsupported state). | ✅ |
| AC-2 | `whisker_chart` emits a `boxplot` series with a correct five-number summary. | ✅ |
| AC-3 | `sunburst`/`treemap`/`sankey`/`chord` render as their own series type, not as a data table. | ✅ |
| AC-4 | `combination_chart` puts the second measure on a second y-axis; a single measure keeps one axis. | ✅ |
| AC-5 | `waterfall_chart`'s bases carry the running total and the final total equals the sum of the deltas. | ✅ |
| AC-6 | A sankey built from `[x, y, value]` triples can never form a cycle (self-edge or `a→b`+`b→a`). | ✅ |
| AC-7 | The network family renders from `graph`; `graph` is selected in every ui-web chart-data query. | ✅ |
| AC-8 | `toForest` terminates on a cycle and preserves every root of a multi-root forest. | ✅ |
| AC-9 | `bubble_chart` uses the second measure as the radius and does not plot it as its own series. | ✅ |
| AC-10 | Option builders are pure and unit-tested without a DOM; `ChartView` keeps its SSR-safe fallback. | ✅ |
| AC-11 | `roc_curve` renders the curve, the y=x reference and the AUC from the run artifact. | ⛔ inc3 |
| AC-12 | `confusion_matrix` renders an N×N labelled matrix whose cells sum to the run's sample count. | ⛔ inc3 |
| AC-13 | The chart-proposal agent can propose any renderable type, grounded in the shaped family. | ⛔ inc4 |

## Implement & Test log

### inc1 — axis-family builders — DONE

`echarts.ts`: `buildBoxplotOption` (+ exported `fiveNumberSummary`),
`buildWaterfallOption`, `buildCombinationOption`, `buildHistogramOption`, and the bubble
size channel (the size series is **consumed as the radius**, not plotted as its own
series). `buildEChartsOption` dispatches to them by `chartType` before the bar path.

**Test:** `src/lib/charts/axis-types.test.ts` (22) — quartile interpolation and
order-independence; boxplot degenerating to a point without a split; waterfall base
values, rise/fall separation and total reconciliation; combination's second axis (and
its absence with one measure); histogram's zero gap; bubble radius monotonic in the size
measure and untouched `scatter_plot`; plus regression cover that funnel, stacked bar and
plain bar are unaffected.

### inc2 — heatmap + network families, and the `graph` data path — DONE

`src/lib/charts/relational.ts` (new): `toLinks`, `buildSankeyOption`, `toHierarchy`,
`buildTreemapOption`, `buildSunburstOption`, `buildChordOption`, `toGraphShape`,
`buildNetworkOption`, `toForest`, `buildTreeOption`.
`ChartView`: `EXACT_KIND` remapped to true renderers, `RenderKind` widened, the
heatmap **family** fallback fixed (it returned `grid`), and the three run types routed
to `metric`. `UnsupportedChart` added for `geo_map_chart`.
`graph` threaded through `operations.ts`, `types.ts`, `ChartCard`, `ChartEditor`, the
embed page, `ChartView` and `NetworkChart`.

**Test:** `src/lib/charts/relational.test.ts` (20) — link dedup; sankey acyclicity under
`a→b`+`b→a` and a self-edge; zero-weight links dropped; treemap/sunburst roll-up; chord
as a circular graph sharing one namespace, with weight-scaled edges; `toGraphShape`
returning null for absent/empty input so the caller keeps its fallback; degree-sized
network nodes; forest rooting, value inheritance, cycle termination, and multi-root
wrapping. `renderers.test.tsx` updated (+4 cases) from the old collapse to the corrected
contract.

**Suite:** ui-web **921 passed** (130 files, +45), `tsc` clean, no new lint warnings.

### Fixed in review

`toLinks` keyed its dedup map with a literal NUL separator, which made git classify
`relational.ts` as **binary** — no diff, no review, no blame. Replaced with
`JSON.stringify([source, target])`: equally unambiguous, stays text.

_inc3 (run charts, backend-first) and inc4 (agent) remain — see the inc3 plan above._
