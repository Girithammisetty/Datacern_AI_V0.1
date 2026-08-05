/**
 * BRD 72 — pure ECharts option builders for the chart types that were rendering
 * as something else.
 *
 * Two groups, split by the shape chart-service actually emits (verified against
 * `services/chart-service/internal/domain/shape.go`, not assumed):
 *
 * * **heatmap family** — `sunburst_chart`, `sankey_chart`, `tree_map_chart`,
 *   `chord_chart` and `heatmap_chart` all resolve as tabular `[x, y, value]`
 *   triples (`tabularColumns` → `FamilyHeatmap`). They were routed to the GRID
 *   renderer, i.e. shown as a data table. The triples are exactly a weighted
 *   edge list, so each of these is a real projection of the same data.
 * * **network family** — `network_chart`, `network_graph_chart`, `tree_chart`,
 *   `decision_tree_chart` resolve to a `{nodes, edges}` GRAPH object
 *   (`shapeNetwork`), never to rows. `Shape()` sets `Columns: []` and never
 *   sets `Rows` for this family, so a renderer reading `rows` sees nothing —
 *   which is why all four showed an empty state.
 *
 * Framework-free and side-effect-free, like `echarts.ts`: the component owns
 * init/resize/theme, these functions only shape the option.
 */
import { CHART_PALETTE, toLabel, toNumber, type HeatmapModel } from "./geometry";
import { fmtNum, type ChartTheme, type EChartsOption } from "./echarts";

/** A weighted edge, the common currency of every builder in this module. */
export interface Link {
  source: string;
  target: string;
  value: number;
}

/** The `{nodes, edges}` object chart-service's `shapeNetwork` emits. */
export interface GraphShape {
  nodes: { id: unknown; value?: unknown }[];
  edges: { from: unknown; to: unknown; value?: unknown }[];
}

const baseOf = (theme: ChartTheme) => ({
  color: [...CHART_PALETTE],
  textStyle: { color: theme.text },
  animationDuration: 480,
  animationEasing: "cubicOut",
});

function tooltipOf(theme: ChartTheme) {
  return {
    trigger: "item",
    backgroundColor: theme.tooltipBg,
    borderColor: theme.tooltipBorder,
    borderWidth: 1,
    textStyle: { color: theme.text, fontSize: 12 },
    extraCssText: "border-radius:8px;box-shadow:0 8px 28px -12px rgba(0,0,0,.35);",
  };
}

/** `[x, y, value]` triples → weighted links, summing duplicate pairs. */
export function toLinks(model: HeatmapModel): Link[] {
  const acc = new Map<string, Link>();
  for (const c of model.cells) {
    const source = model.xCategories[c.xi];
    const target = model.yCategories[c.yi];
    if (source == null || target == null) continue;
    const key = JSON.stringify([source, target]);
    const prev = acc.get(key);
    if (prev) prev.value += c.value;
    else acc.set(key, { source, target, value: c.value });
  }
  return [...acc.values()];
}

/**
 * Sankey needs an ACYCLIC link set — ECharts throws on a cycle, and `[x, y]`
 * triples carry no guarantee of one (a self-edge `a→a`, or `a→b` alongside
 * `b→a`, are both expressible). Rather than let the chart crash, disambiguate
 * the two sides into distinct node namespaces, which is also what the data
 * means: column x is the source dimension and column y the target dimension,
 * so "auto" as a source and "auto" as a target are different nodes.
 */
export function buildSankeyOption(model: HeatmapModel, theme: ChartTheme): EChartsOption {
  const links = toLinks(model).filter((l) => l.value > 0);
  const SRC = "← ";
  const nodes = [
    ...model.xCategories.map((n) => ({ name: SRC + n })),
    ...model.yCategories.map((n) => ({ name: n })),
  ];
  return {
    ...baseOf(theme),
    tooltip: {
      ...tooltipOf(theme),
      trigger: "item",
      formatter: (p: { dataType?: string; name?: string; value?: number }) =>
        p.dataType === "edge"
          ? `${String(p.name ?? "").replace(SRC, "")}: <b>${fmtNum(Number(p.value ?? 0))}</b>`
          : String(p.name ?? "").replace(SRC, ""),
    },
    series: [
      {
        type: "sankey",
        left: 8,
        right: 8,
        top: 12,
        bottom: 12,
        emphasis: { focus: "adjacency" },
        nodeAlign: "justify",
        label: { color: theme.text, fontSize: 11, formatter: (p: { name: string }) => p.name.replace(SRC, "") },
        lineStyle: { color: "gradient", opacity: 0.35, curveness: 0.5 },
        data: nodes,
        links: links.map((l) => ({ source: SRC + l.source, target: l.target, value: l.value })),
      },
    ],
  };
}

/** Two-level hierarchy: each distinct x is a parent, its y values the children. */
export function toHierarchy(model: HeatmapModel): { name: string; value: number; children: { name: string; value: number }[] }[] {
  const parents = new Map<string, { name: string; value: number; children: { name: string; value: number }[] }>();
  for (const l of toLinks(model)) {
    let p = parents.get(l.source);
    if (!p) {
      p = { name: l.source, value: 0, children: [] };
      parents.set(l.source, p);
    }
    p.children.push({ name: l.target, value: l.value });
    p.value += l.value;
  }
  return [...parents.values()];
}

export function buildTreemapOption(model: HeatmapModel, theme: ChartTheme): EChartsOption {
  return {
    ...baseOf(theme),
    tooltip: {
      ...tooltipOf(theme),
      formatter: (p: { name?: string; value?: number }) =>
        `${p.name ?? ""}: <b>${fmtNum(Number(p.value ?? 0))}</b>`,
    },
    series: [
      {
        type: "treemap",
        roam: false,
        nodeClick: false,
        breadcrumb: { show: false },
        label: { color: "#fff", fontSize: 11 },
        upperLabel: { show: true, height: 18, color: theme.text, fontSize: 11 },
        itemStyle: { borderColor: theme.surface, borderWidth: 1, gapWidth: 1 },
        levels: [{ itemStyle: { borderWidth: 0, gapWidth: 2 } }, { itemStyle: { gapWidth: 1 } }],
        data: toHierarchy(model),
      },
    ],
  };
}

export function buildSunburstOption(model: HeatmapModel, theme: ChartTheme): EChartsOption {
  return {
    ...baseOf(theme),
    tooltip: {
      ...tooltipOf(theme),
      formatter: (p: { name?: string; value?: number }) =>
        `${p.name ?? ""}: <b>${fmtNum(Number(p.value ?? 0))}</b>`,
    },
    series: [
      {
        type: "sunburst",
        radius: [16, "88%"],
        center: ["50%", "50%"],
        sort: undefined,
        emphasis: { focus: "ancestor" },
        label: { color: theme.text, fontSize: 10, minAngle: 12 },
        itemStyle: { borderColor: theme.surface, borderWidth: 1 },
        data: toHierarchy(model),
      },
    ],
  };
}

/**
 * ECharts has no `chord` series type; a chord diagram is a `graph` in circular
 * layout with edge widths proportional to weight — which is what this builds.
 * Unlike sankey both sides share ONE node namespace here, because a chord
 * diagram's whole point is showing flow between members of the same set.
 */
export function buildChordOption(model: HeatmapModel, theme: ChartTheme): EChartsOption {
  const links = toLinks(model).filter((l) => l.value > 0);
  const names = new Set<string>();
  for (const l of links) {
    names.add(l.source);
    names.add(l.target);
  }
  const weight = new Map<string, number>();
  for (const l of links) {
    weight.set(l.source, (weight.get(l.source) ?? 0) + l.value);
    weight.set(l.target, (weight.get(l.target) ?? 0) + l.value);
  }
  const maxW = Math.max(1, ...weight.values());
  const maxLink = Math.max(1, ...links.map((l) => l.value));
  const palette = [...CHART_PALETTE];
  return {
    ...baseOf(theme),
    tooltip: {
      ...tooltipOf(theme),
      formatter: (p: { dataType?: string; name?: string; value?: number }) =>
        p.dataType === "edge"
          ? `${String(p.name ?? "").replace(">", " → ")}: <b>${fmtNum(Number(p.value ?? 0))}</b>`
          : String(p.name ?? ""),
    },
    series: [
      {
        type: "graph",
        layout: "circular",
        circular: { rotateLabel: true },
        roam: false,
        label: { show: true, position: "right", color: theme.text, fontSize: 11 },
        lineStyle: { color: "source", curveness: 0.3, opacity: 0.4 },
        emphasis: { focus: "adjacency", lineStyle: { opacity: 0.9 } },
        data: [...names].map((name, i) => ({
          name,
          symbolSize: 8 + ((weight.get(name) ?? 0) / maxW) * 26,
          itemStyle: { color: palette[i % palette.length] },
        })),
        edges: links.map((l) => ({
          source: l.source,
          target: l.target,
          value: l.value,
          lineStyle: { width: 1 + (l.value / maxLink) * 7 },
        })),
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Network family — from the {nodes, edges} graph object
// ---------------------------------------------------------------------------

/** Narrow an unknown `data.graph` blob to the shape `shapeNetwork` emits. */
export function toGraphShape(graph: unknown): GraphShape | null {
  if (!graph || typeof graph !== "object") return null;
  const g = graph as { nodes?: unknown; edges?: unknown };
  const nodes = Array.isArray(g.nodes) ? (g.nodes as GraphShape["nodes"]) : [];
  const edges = Array.isArray(g.edges) ? (g.edges as GraphShape["edges"]) : [];
  if (!nodes.length && !edges.length) return null;
  return { nodes, edges };
}

export function buildNetworkOption(graph: GraphShape, theme: ChartTheme): EChartsOption {
  const palette = [...CHART_PALETTE];
  const degree = new Map<string, number>();
  const bump = (k: string) => degree.set(k, (degree.get(k) ?? 0) + 1);
  for (const e of graph.edges) {
    bump(toLabel(e.from));
    bump(toLabel(e.to));
  }
  const maxDeg = Math.max(1, ...degree.values());
  return {
    ...baseOf(theme),
    tooltip: tooltipOf(theme),
    series: [
      {
        type: "graph",
        layout: "force",
        force: { repulsion: 140, edgeLength: [40, 120], gravity: 0.08 },
        roam: true,
        draggable: true,
        label: { show: true, position: "right", color: theme.text, fontSize: 11 },
        edgeSymbol: ["none", "arrow"],
        edgeSymbolSize: 7,
        emphasis: { focus: "adjacency" },
        lineStyle: { color: theme.split, opacity: 0.7, curveness: 0.08, width: 1.2 },
        data: graph.nodes.map((n, i) => {
          const name = toLabel(n.id);
          return {
            name,
            value: n.value == null ? undefined : toNumber(n.value),
            symbolSize: 10 + ((degree.get(name) ?? 0) / maxDeg) * 22,
            itemStyle: { color: palette[i % palette.length] },
          };
        }),
        edges: graph.edges.map((e) => ({
          source: toLabel(e.from),
          target: toLabel(e.to),
          value: e.value == null ? undefined : toNumber(e.value),
        })),
      },
    ],
  };
}

export interface TreeNode {
  name: string;
  value?: number;
  children: TreeNode[];
}

/**
 * Build a rooted forest from the edge list. `shapeNetwork` emits parent→child
 * edges, so a root is any node that is never a target. Cycles and re-parented
 * nodes are possible in arbitrary query output, so a `seen` set bounds the walk
 * — a tree renderer that can be driven into infinite recursion by a user's SQL
 * is not a renderer.
 */
export function toForest(graph: GraphShape): TreeNode[] {
  const children = new Map<string, { name: string; value?: number }[]>();
  const targets = new Set<string>();
  const known = new Set<string>(graph.nodes.map((n) => toLabel(n.id)));
  const nodeValue = new Map<string, number | undefined>(
    graph.nodes.map((n) => [toLabel(n.id), n.value == null ? undefined : toNumber(n.value)]),
  );
  for (const e of graph.edges) {
    const from = toLabel(e.from);
    const to = toLabel(e.to);
    known.add(from);
    known.add(to);
    targets.add(to);
    children.set(from, [
      ...(children.get(from) ?? []),
      { name: to, value: e.value == null ? undefined : toNumber(e.value) },
    ]);
  }
  const build = (name: string, value: number | undefined, seen: Set<string>): TreeNode => {
    const kids = seen.has(name) ? [] : (children.get(name) ?? []);
    const next = new Set(seen).add(name);
    return {
      name,
      value: value ?? nodeValue.get(name),
      children: kids.map((k) => build(k.name, k.value, next)),
    };
  };
  const roots = [...known].filter((n) => !targets.has(n));
  // Every node is a target (a pure cycle): fall back to the first node so the
  // chart still renders something true rather than nothing.
  const seeds = roots.length ? roots : known.size ? [[...known][0]] : [];
  return seeds.map((r) => build(r, undefined, new Set()));
}

export function buildTreeOption(graph: GraphShape, theme: ChartTheme): EChartsOption {
  const forest = toForest(graph);
  // ECharts' tree series takes ONE root; wrap a multi-root forest so every
  // component is visible instead of silently dropping all but the first.
  const data = forest.length === 1 ? forest : [{ name: "", children: forest }];
  return {
    ...baseOf(theme),
    tooltip: tooltipOf(theme),
    series: [
      {
        type: "tree",
        data,
        left: 24,
        right: 72,
        top: 16,
        bottom: 16,
        symbolSize: 8,
        orient: "LR",
        expandAndCollapse: true,
        initialTreeDepth: 3,
        label: { position: "left", verticalAlign: "middle", align: "right", color: theme.text, fontSize: 11 },
        leaves: { label: { position: "right", verticalAlign: "middle", align: "left" } },
        lineStyle: { color: theme.split, width: 1.2 },
        emphasis: { focus: "descendant" },
      },
    ],
  };
}
