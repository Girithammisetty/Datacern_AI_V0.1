/**
 * BRD 72 — the heatmap-family and network-family builders.
 *
 * Every fixture here is the shape `services/chart-service/internal/domain/shape.go`
 * actually emits, verified against that file rather than assumed:
 *   FamilyHeatmap → tabular rows `[x, y, value]` (sunburst/sankey/treemap/chord/heatmap)
 *   FamilyNetwork → `{nodes:[{id,value}], edges:[{from,to,value}]}`, rows EMPTY
 */
import { describe, it, expect } from "vitest";
import { toHeatmapModel } from "./geometry";
import {
  buildChordOption, buildNetworkOption, buildSankeyOption, buildSunburstOption,
  buildTreeOption, buildTreemapOption, toForest, toGraphShape, toLinks,
} from "./relational";

const THEME = {
  text: "#000", subtext: "#666", axis: "#ccc", split: "#eee",
  tooltipBg: "#fff", tooltipBorder: "#ddd", surface: "#fff",
};

/** [x, y, value] — the real FamilyHeatmap shape. */
const ROWS: unknown[][] = [
  ["EMEA", "auto", 5],
  ["EMEA", "home", 3],
  ["APAC", "auto", 9],
];
const MODEL = toHeatmapModel(["region", "product", "value"], ROWS);

const series = (opt: Record<string, unknown>) =>
  (opt.series as Record<string, unknown>[])[0];

describe("toLinks", () => {
  it("turns [x, y, value] triples into weighted links", () => {
    expect(toLinks(MODEL)).toEqual([
      { source: "EMEA", target: "auto", value: 5 },
      { source: "EMEA", target: "home", value: 3 },
      { source: "APAC", target: "auto", value: 9 },
    ]);
  });

  it("sums duplicate (x, y) pairs instead of emitting two links", () => {
    const m = toHeatmapModel([], [["a", "b", 2], ["a", "b", 3]]);
    expect(toLinks(m)).toEqual([{ source: "a", target: "b", value: 5 }]);
  });
});

describe("sankey", () => {
  it("emits a sankey series with one link per pair", () => {
    const s = series(buildSankeyOption(MODEL, THEME));
    expect(s.type).toBe("sankey");
    expect((s.links as unknown[]).length).toBe(3);
  });

  it("namespaces the source side so a shared label cannot form a cycle", () => {
    // ECharts throws on a cyclic sankey. `[x, y]` triples can express a→b and
    // b→a, or even a→a, so the two columns must be distinct node sets — which
    // is also what the data means (x is the source dimension, y the target).
    const m = toHeatmapModel([], [["a", "b", 1], ["b", "a", 1]]);
    const s = series(buildSankeyOption(m, THEME));
    const names = (s.data as { name: string }[]).map((n) => n.name);
    const links = s.links as { source: string; target: string }[];
    expect(new Set(names).size).toBe(names.length); // no duplicate node names
    for (const l of links) expect(l.source).not.toBe(l.target);
  });

  it("survives a self-referencing row", () => {
    const m = toHeatmapModel([], [["a", "a", 4]]);
    const s = series(buildSankeyOption(m, THEME));
    const l = (s.links as { source: string; target: string }[])[0];
    expect(l.source).not.toBe(l.target);
  });

  it("drops zero-weight links (a sankey band of width 0 is noise)", () => {
    const m = toHeatmapModel([], [["a", "b", 0], ["a", "c", 4]]);
    expect((series(buildSankeyOption(m, THEME)).links as unknown[]).length).toBe(1);
  });
});

describe("treemap / sunburst hierarchy", () => {
  it("nests y under x and rolls values up to the parent", () => {
    const s = series(buildTreemapOption(MODEL, THEME));
    expect(s.type).toBe("treemap");
    const data = s.data as { name: string; value: number; children: unknown[] }[];
    const emea = data.find((d) => d.name === "EMEA")!;
    expect(emea.value).toBe(8); // 5 + 3
    expect(emea.children).toHaveLength(2);
    expect(data.find((d) => d.name === "APAC")!.value).toBe(9);
  });

  it("sunburst uses the same hierarchy", () => {
    const s = series(buildSunburstOption(MODEL, THEME));
    expect(s.type).toBe("sunburst");
    expect((s.data as unknown[]).length).toBe(2); // EMEA, APAC
  });
});

describe("chord", () => {
  it("renders as a circular graph — ECharts has no chord series type", () => {
    const s = series(buildChordOption(MODEL, THEME));
    expect(s.type).toBe("graph");
    expect(s.layout).toBe("circular");
  });

  it("shares ONE node namespace, unlike sankey", () => {
    // A chord diagram shows flow between members of the same set, so "auto" as
    // a source and as a target must be the same node.
    const m = toHeatmapModel([], [["a", "b", 1], ["b", "a", 2]]);
    const s = series(buildChordOption(m, THEME));
    expect((s.data as unknown[]).length).toBe(2);
  });

  it("scales edge width and node size by weight", () => {
    const edges = series(buildChordOption(MODEL, THEME)).edges as {
      value: number; lineStyle: { width: number };
    }[];
    const heavy = edges.find((e) => e.value === 9)!;
    const light = edges.find((e) => e.value === 3)!;
    expect(heavy.lineStyle.width).toBeGreaterThan(light.lineStyle.width);
  });
});

// ---------------------------------------------------------------------------
// Network family
// ---------------------------------------------------------------------------

const GRAPH = {
  nodes: [{ id: "root", value: 10 }, { id: "a" }, { id: "b" }, { id: "c" }],
  edges: [
    { from: "root", to: "a", value: 3 },
    { from: "root", to: "b", value: 4 },
    { from: "a", to: "c", value: 1 },
  ],
};

describe("toGraphShape", () => {
  it("accepts the {nodes, edges} object chart-service emits", () => {
    expect(toGraphShape(GRAPH)).not.toBeNull();
  });

  it("returns null for absent / empty / non-object input so the caller keeps its fallback", () => {
    expect(toGraphShape(undefined)).toBeNull();
    expect(toGraphShape(null)).toBeNull();
    expect(toGraphShape("nope")).toBeNull();
    expect(toGraphShape({ nodes: [], edges: [] })).toBeNull();
  });
});

describe("network (force graph)", () => {
  it("emits a graph series with every node and edge", () => {
    const s = series(buildNetworkOption(GRAPH, THEME));
    expect(s.type).toBe("graph");
    expect(s.layout).toBe("force");
    expect((s.data as unknown[]).length).toBe(4);
    expect((s.edges as unknown[]).length).toBe(3);
  });

  it("sizes nodes by degree so hubs read as hubs", () => {
    const data = series(buildNetworkOption(GRAPH, THEME)).data as {
      name: string; symbolSize: number;
    }[];
    const root = data.find((d) => d.name === "root")!; // degree 2
    const c = data.find((d) => d.name === "c")!; // degree 1
    expect(root.symbolSize).toBeGreaterThan(c.symbolSize);
  });
});

describe("tree", () => {
  it("roots the forest at the node that is never a target", () => {
    const forest = toForest(GRAPH);
    expect(forest).toHaveLength(1);
    expect(forest[0].name).toBe("root");
    expect(forest[0].children.map((c) => c.name)).toEqual(["a", "b"]);
    expect(forest[0].children[0].children[0].name).toBe("c");
  });

  it("carries the node's own value when the edge has none", () => {
    expect(toForest(GRAPH)[0].value).toBe(10);
  });

  it("terminates on a cycle instead of recursing forever", () => {
    // Arbitrary query output can produce a→b→a. A tree renderer that a user's
    // SQL can drive into infinite recursion is not a renderer.
    const cyclic = { nodes: [{ id: "a" }, { id: "b" }], edges: [{ from: "a", to: "b" }, { from: "b", to: "a" }] };
    const forest = toForest(cyclic);
    expect(forest.length).toBeGreaterThan(0);
    expect(JSON.stringify(forest).length).toBeLessThan(2000);
  });

  it("wraps a multi-root forest so no component is silently dropped", () => {
    // ECharts' tree series takes ONE root.
    const two = { nodes: [], edges: [{ from: "r1", to: "a" }, { from: "r2", to: "b" }] };
    expect(toForest(two)).toHaveLength(2);
    const data = series(buildTreeOption(two, THEME)).data as { children: unknown[] }[];
    expect(data).toHaveLength(1);
    expect(data[0].children).toHaveLength(2);
  });

  it("does not wrap a single-root tree", () => {
    const data = series(buildTreeOption(GRAPH, THEME)).data as { name: string }[];
    expect(data).toHaveLength(1);
    expect(data[0].name).toBe("root");
  });
});
