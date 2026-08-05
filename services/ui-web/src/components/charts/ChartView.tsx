"use client";
import { BarChart } from "./BarChart";
import { LineChart } from "./LineChart";
import { PieChart } from "./PieChart";
import { GridChart } from "./GridChart";
import { HeatmapChart } from "./HeatmapChart";
import { GaugeChart } from "./GaugeChart";
import { WordCloudChart } from "./WordCloudChart";
import { NetworkChart } from "./NetworkChart";
import { UnsupportedChart } from "./UnsupportedChart";
import { MetricChart } from "./MetricChart";
import { RunChart } from "./RunChart";
import { EChartsChart } from "./EChartsChart";

/**
 * The single dispatch point for rendering shaped chart data as a real chart.
 * `chartType` wins when it maps to a known renderer; otherwise we fall back to
 * the family, then to a bar chart. Empty/loading/error are handled by the
 * caller's AsyncBoundary — this component only renders data it is given.
 *
 * BRD 72 made this dispatch honest. Previously 30 catalogued chart types
 * resolved onto 9 renderers: whisker/combination/histogram/waterfall/geo_map
 * silently drew a BAR chart, sunburst/sankey/tree_map/chord drew a DATA TABLE,
 * and the whole network family drew an empty state. Each of those presented one
 * visualization as another, which is worse than saying nothing.
 *
 * The three data shapes chart-service emits (`internal/domain/shape.go`) now map
 * to renderers that respect them:
 *
 *   axis / y_only  → rows [category, …measures]  → bar, line, pie, gauge,
 *                    scatter, bubble, boxplot, combination, histogram,
 *                    waterfall, funnel, word cloud
 *   heatmap        → rows [x, y, value]          → heatmap, sankey, treemap,
 *                    sunburst, chord
 *   network        → graph {nodes, edges}        → network (force graph), tree
 *   metric         → artifact blob              → metric card
 *   grid           → rows passthrough            → data table
 *
 * `geo_map_chart` is the one declared gap: its data resolves fine but a map
 * needs GeoJSON basemaps this deployment does not bundle, so it renders a named
 * unsupported state rather than a bar chart wearing a map's label.
 */
export function ChartView({
  chartType,
  family,
  columns,
  rows,
  graph,
  artifact,
  title,
  desc,
  onSelect,
  selectedValue,
}: {
  chartType?: string | null;
  family?: string | null;
  columns: unknown;
  rows: unknown;
  /** `{nodes, edges}` for the network family. chart-service's Shape() sets
   * `graph` and leaves `rows` EMPTY for network_chart / network_graph_chart /
   * tree_chart / decision_tree_chart, so this — not rows — is their data. */
  graph?: unknown;
  /** Resolved artifact blob for the metric/parameter family (chart-service
   * ShapedResult.artifact) — passed through to MetricChart. */
  artifact?: unknown;
  title?: string;
  desc?: string;
  /** Cross-filter: called with the clicked category when this chart is a
   * selectable source (bar / pie / grid). Omit to render non-interactive. */
  onSelect?: (value: string) => void;
  /** The currently-selected category for this chart (highlights the mark). */
  selectedValue?: string | null;
}) {
  const kind = resolveKind(chartType, family);
  // Visual families (bar / line / pie / heatmap / gauge) render through the
  // interactive ECharts engine, which progressively enhances the bespoke SVG
  // renderer passed as `fallback` (kept for SSR + jsdom/tests + canvas-less
  // environments). Grid / metric / network / wordcloud stay on their bespoke
  // renderers — a real data table, a KPI card, an honest gap, and a
  // dependency-free word cloud respectively.
  switch (kind) {
    case "pie":
      return (
        <EChartsChart kind="pie" chartType={chartType} columns={columns} rows={rows} title={title} desc={desc}
          onSelect={onSelect} selectedValue={selectedValue}
          fallback={<PieChart columns={columns} rows={rows} title={title} desc={desc} onSelect={onSelect} selectedValue={selectedValue} />} />
      );
    case "line":
      return (
        <EChartsChart kind="line" chartType={chartType} columns={columns} rows={rows} title={title} desc={desc}
          fallback={<LineChart columns={columns} rows={rows} title={title} desc={desc} />} />
      );
    case "heatmap":
      return (
        <EChartsChart kind="heatmap" chartType={chartType} columns={columns} rows={rows} title={title} desc={desc}
          fallback={<HeatmapChart columns={columns} rows={rows} title={title} desc={desc} />} />
      );
    case "gauge":
      return (
        <EChartsChart kind="gauge" chartType={chartType} columns={columns} rows={rows} title={title} desc={desc}
          fallback={<GaugeChart columns={columns} rows={rows} title={title} desc={desc} />} />
      );
    case "boxplot":
    case "waterfall":
    case "combination":
    case "histogram":
      // Axis family — same rows, correct option. No bespoke SVG renderer exists
      // for these, so the grid keeps the data readable pre-hydration.
      return (
        <EChartsChart kind="bar" chartType={chartType} columns={columns} rows={rows} title={title} desc={desc}
          fallback={<GridChart columns={columns} rows={rows} title={title} />} />
      );
    case "sankey":
    case "treemap":
    case "sunburst":
    case "chord":
      return (
        <EChartsChart kind={kind} chartType={chartType} columns={columns} rows={rows} title={title} desc={desc}
          fallback={<GridChart columns={columns} rows={rows} title={title} />} />
      );
    case "network":
    case "tree":
      return (
        <EChartsChart kind={kind} chartType={chartType} columns={columns} rows={rows} graph={graph}
          title={title} desc={desc}
          fallback={<NetworkChart columns={columns} rows={rows} graph={graph} title={title} />} />
      );
    case "unsupported":
      return <UnsupportedChart chartType={chartType} title={title} />;
    case "grid":
      return <GridChart columns={columns} rows={rows} title={title} onSelect={onSelect} selectedValue={selectedValue} />;
    case "wordcloud":
      return <WordCloudChart columns={columns} rows={rows} title={title} />;
    case "run":
      return <RunChart chartType={chartType} artifact={artifact} title={title} />;
    case "metric":
      return <MetricChart columns={columns} rows={rows} artifact={artifact} title={title} />;
    default:
      return (
        <EChartsChart kind="bar" chartType={chartType} columns={columns} rows={rows} title={title} desc={desc}
          onSelect={onSelect} selectedValue={selectedValue}
          fallback={<BarChart columns={columns} rows={rows} title={title} desc={desc} onSelect={onSelect} selectedValue={selectedValue} />} />
      );
  }
}

type RenderKind =
  | "bar" | "line" | "pie" | "grid" | "heatmap" | "gauge" | "wordcloud" | "metric"
  // BRD 72: types that previously collapsed onto bar / grid / a generic network.
  | "boxplot" | "waterfall" | "combination" | "histogram"
  | "sankey" | "treemap" | "sunburst" | "chord" | "network" | "tree" | "run"
  // geo_map_chart needs GeoJSON basemaps that are not bundled — declared, not faked.
  | "unsupported";

/** Exact chart-type-name → renderer kind, covering every type FRIENDLY_CHART_TYPES
 * offers (services/ui-web/src/lib/charts/spec.ts). Checked before the substring
 * fallback below so e.g. "scatter_plot" (no "bar"/"line"/"pie" substring) still
 * resolves deterministically instead of falling through to family/default. */
const EXACT_KIND: Record<string, RenderKind> = {
  // axis family — these four genuinely render through the bar/scatter/funnel
  // path, which buildEChartsOption refines by chartType.
  vertical_bar_chart: "bar",
  vertical_stackedbar_chart: "bar",
  scatter_plot: "bar",
  bubble_chart: "bar",
  funnel_chart: "bar",
  line_chart: "line",
  // axis family — BRD 72: these drew a BAR CHART under another type's label.
  whisker_chart: "boxplot",
  combination_chart: "combination",
  histogram_chart: "histogram",
  waterfall_chart: "waterfall",
  // Data resolves; the map visual needs GeoJSON basemaps this deployment does
  // not bundle. Declared, not faked.
  geo_map_chart: "unsupported",
  // y_only family
  pie_chart: "pie",
  gauge_chart: "gauge",
  word_cloud_chart: "wordcloud",
  // grid family
  grid_chart: "grid",
  pivot_table_chart: "grid",
  // heatmap family ([x, y, value] triples) — BRD 72: these four rendered as a
  // DATA TABLE. The triples are a weighted edge list, so each of these is a
  // real projection of the same data.
  heatmap_chart: "heatmap",
  sunburst_chart: "sunburst",
  sankey_chart: "sankey",
  tree_map_chart: "treemap",
  chord_chart: "chord",
  // network family ({nodes, edges}) — BRD 72: all four rendered an empty state
  // because ui-web never selected `graph`. Hierarchies are trees, not
  // undifferentiated graphs.
  network_chart: "network",
  network_graph_chart: "network",
  tree_chart: "tree",
  decision_tree_chart: "tree",
  // metric family (artifact, not rows)
  metric_chart: "metric",
  parameter_chart: "metric",
  // dataClass="run" — BRD 72 inc3. These resolve to a run artifact from
  // experiment-service GET /artifacts?urn=, not to rows.
  roc_curve: "run",
  confusion_matrix: "run",
  decision_tree: "run",
};

/** Resolve chartType (preferred) then family to a renderer kind. */
export function resolveKind(chartType?: string | null, family?: string | null): RenderKind {
  const t = (chartType ?? "").toLowerCase();
  if (t && EXACT_KIND[t]) return EXACT_KIND[t];
  if (t.includes("grid") || t.includes("pivot")) return "grid";
  if (t.includes("pie") || t.includes("donut")) return "pie";
  if (t.includes("line") || t.includes("area")) return "line";
  if (t.includes("bar")) return "bar";

  switch ((family ?? "").toLowerCase()) {
    case "grid":
      return "grid";
    case "y_only":
      return "pie";
    case "heatmap":
      // BRD 72: the heatmap FAMILY is [x, y, value] triples, which a heatmap
      // renders directly. It was falling back to a data table.
      return "heatmap";
    case "network":
      return "network";
    case "metric":
      return "metric";
    case "axis":
      return "bar";
    default:
      return "bar";
  }
}
