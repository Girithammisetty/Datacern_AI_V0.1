# BRD 72 — Chart renderer completeness

**Status:** OPEN — 2026-08-04 · part of the [V1 parity wave-2 index](71_v1_parity_wave2_index.md)
**Owner:** platform · **Services:** `ui-web` (+ `agent-runtime` for the proposal side)
**Gaps closed:** V1c (distinct renderers for the 30 catalogued types), V2c (run charts)

---

## Analysis

`chart-service` is at full parity with V1 on the **API**: `domain.Catalog()` serves all
30 chart types with per-type JSON Schemas, the same three data classes V1 has
(`dataset` / `run` / `query`), tags, the insights / case_management / inspector modules,
archive+restore, export/import bundles, drilldown, cross-filter, chart links,
documentation, and CSV/PNG export — with server-side aggregation **on by default**
(V1 gates it behind `SERVER_AGGREGATION_ENABLED`).

The loss is entirely in `ui-web`. `ChartView.tsx` resolves all 30 types onto **nine**
renderers, and `EChartsChart.tsx:17` declares:

```ts
type Kind = "bar" | "line" | "pie" | "heatmap" | "gauge";
```

The resulting collapse (`ChartView.tsx:110`, `EXACT_KIND`):

| Catalogued type | Renders as | Should be |
|---|---|---|
| `scatter_plot` | bar | scatter |
| `bubble_chart` | bar | scatter with a size channel |
| `whisker_chart` | bar | boxplot |
| `combination_chart` | bar | bar + line, dual axis |
| `histogram_chart` | bar | binned bar (own axis semantics) |
| `waterfall_chart` | bar | waterfall (running total) |
| `funnel_chart` | bar | funnel |
| `geo_map_chart` | bar | map (or an honest gap — see below) |
| `sunburst_chart` | **data table** | sunburst |
| `sankey_chart` | **data table** | sankey |
| `tree_map_chart` | **data table** | treemap |
| `chord_chart` | **data table** | chord |
| `tree_chart` | generic network | tree |
| `decision_tree_chart` | generic network | tree with split labels |
| `roc_curve` | **nothing** (falls to bar) | ROC line + diagonal + AUC |
| `confusion_matrix` | **nothing** (falls to bar) | labelled matrix |
| `decision_tree` (run) | **nothing** (falls to bar) | tree |

The three run charts appear only in a comment — `MetricChart.tsx:7` says
`dataClass="run" roc_curve/confusion_matrix/decision_tree if ever previewed`. They are
the charts a model-evaluation dashboard is made of, and they are the ones with no
renderer at all.

**ECharts already supports** scatter, boxplot, funnel, sankey, treemap, sunburst, graph,
tree, and custom series natively. The constraint is the `Kind` union and the absence of
per-type option builders, not the library — so this is bounded, mechanical work with a
large visible payoff, and it needs no backend change.

`geo_map_chart` is the one honest exception: a real map needs GeoJSON basemaps that are
not currently bundled. Ship it as a **declared gap** with a clear empty state naming what
is missing, rather than a bar chart pretending to be a map.

---

## Design

### 1. Widen the engine wrapper

`EChartsChart.tsx`: `Kind` becomes the full renderer set, and the monolithic option
builder splits into `src/lib/charts/options/<kind>.ts` — one pure
`(columns, rows, config) => EChartsOption` per kind, unit-testable without a DOM. Each
reads the **shaped result** chart-service already returns (`ShapedResult`), so no new
data contract.

### 2. Per-family option builders

- **axis family** — `scatter`, `bubble` (size channel from the third measure),
  `boxplot` (five-number summary computed from the shaped rows), `combination`
  (series-typed from the chart config's per-series `type`, dual y-axis),
  `histogram` (bin edges from config or Freedman–Diaconis), `waterfall`
  (running total via ECharts' stacked-invisible-base idiom), `funnel`.
- **hierarchy family** — `sunburst`, `treemap`, `tree` from the `children` node shape
  the catalog already declares; `decision_tree_chart` is `tree` plus split-condition
  edge labels.
- **relational family** — `sankey` and `chord` from the `nodes`/`links` shape.
- **run family** (new `RunChart.tsx`) — `roc_curve` (line + y=x reference + AUC
  annotation), `confusion_matrix` (labelled heatmap with counts, row/col totals),
  `decision_tree` (reuses the tree builder over the run artifact).

### 3. Wire-up

`EXACT_KIND` maps each of the 30 types to its true renderer; the substring fallback in
`resolveKind` stays as the last resort for unknown types. `geo_map_chart` maps to a new
`unsupported` kind rendering a named empty state.

### 4. Agent

The insight/chart-proposal path currently has no reason to propose a sankey or a
waterfall because neither renders. Once they do, extend the chart proposal prompt +
schema to the full type set, with the type choice grounded in the shaped result's
family (a flow question → sankey; a part-to-whole over a hierarchy → sunburst).

### Increment plan

- **inc1** — engine widening + axis-family builders (scatter/bubble/boxplot/combination/
  histogram/waterfall/funnel) + tests.
- **inc2** — hierarchy + relational builders (sunburst/treemap/tree/sankey/chord) + tests.
- **inc3** — run charts (ROC / confusion matrix / decision tree) + tests.
- **inc4** — agent proposal over the full type set; `geo_map_chart` declared gap.

## Acceptance criteria

| AC | Statement |
|----|-----------|
| AC-1 | Every one of the 30 catalogued types resolves to a renderer that is **not** a silent bar-chart fallback (or, for `geo_map_chart`, to a named unsupported state). |
| AC-2 | `scatter_plot`, `bubble_chart`, `whisker_chart` produce ECharts options with series types `scatter`/`scatter`/`boxplot` respectively. |
| AC-3 | `sunburst`/`treemap`/`sankey`/`chord`/`tree` render as their own series type, not as a data table. |
| AC-4 | `combination_chart` emits per-series types from the chart config and a second y-axis when configured. |
| AC-5 | `waterfall_chart` totals equal the cumulative sum of its deltas. |
| AC-6 | `roc_curve` renders the curve, the y=x reference and the AUC value from the run artifact. |
| AC-7 | `confusion_matrix` renders an N×N labelled matrix whose cell values sum to the run's sample count. |
| AC-8 | Option builders are pure and unit-tested without a DOM; `ChartView` keeps its SSR-safe fallback path. |
| AC-9 | Cross-filter (`onSelect`) keeps working on every selectable family it works on today. |
| AC-10 | The chart-proposal agent can propose any renderable type, grounded in the shaped family. |

## Implement & Test log

_(pending)_
