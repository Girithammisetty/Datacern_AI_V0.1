/**
 * BRD 71 (U1) — per-node resources survive the canvas round trip.
 *
 * The load-bearing assertion is the NEGATIVE one: a node the user never touched must
 * serialize with no `resources` key at all. Emitting `{}` or a defaults object would
 * silently convert every existing pipeline from "inherit" to "pinned at 1 CPU / 2 GB",
 * which is a behavior change disguised as a feature.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  hydrateFromDefinition,
  nodeFromStep,
  pruneResources,
  serializeDefinition,
  useCanvasStore,
  type CanvasNode,
} from "./canvas";
import type { PipelineStepType } from "@/lib/graphql/types";

const READ: PipelineStepType = {
  name: "read-from-warehouse",
  displayName: "Read from warehouse",
  category: "io",
  description: null,
  minInputs: 0,
  maxInputs: 0,
  maxOutputs: 1,
  outputs: [{ name: "out", type: "dataframe" }],
  parameters: [{ name: "dataset", type: "string", format: "dataset_ref", required: true }],
} as PipelineStepType;

const DROP: PipelineStepType = {
  name: "drop-columns",
  displayName: "Drop columns",
  category: "data_prep",
  description: null,
  minInputs: 1,
  maxInputs: 1,
  maxOutputs: 1,
  outputs: [{ name: "out", type: "dataframe" }],
  parameters: [{ name: "columns", type: "array", format: "columns", required: true }],
} as PipelineStepType;

function pair(): { nodes: CanvasNode[]; edges: never[] } {
  const r = nodeFromStep(READ, { x: 0, y: 0 });
  r.values.dataset = "wr:t:dataset:dataset/d";
  const d = nodeFromStep(DROP, { x: 200, y: 0 });
  d.values.columns = JSON.stringify(["pii"]);
  return { nodes: [r, d], edges: [] };
}

describe("pruneResources", () => {
  it("returns undefined for empty, missing and all-blank inputs", () => {
    expect(pruneResources(undefined)).toBeUndefined();
    expect(pruneResources({})).toBeUndefined();
    expect(pruneResources({ cpus: Number.NaN })).toBeUndefined();
  });

  it("keeps only finite numbers", () => {
    expect(pruneResources({ cpus: 4, ram_gb: Number.NaN, timeout_minutes: 60 })).toEqual({
      cpus: 4,
      timeout_minutes: 60,
    });
  });
});

describe("serializeDefinition — resources", () => {
  it("omits `resources` entirely for an untouched node (AC-6)", () => {
    const { nodes, edges } = pair();
    const { definition } = serializeDefinition(nodes, edges);
    for (const n of definition.nodes ?? []) {
      expect(Object.hasOwn(n as object, "resources")).toBe(false);
    }
  });

  it("emits `resources` only on the node that set them", () => {
    const { nodes, edges } = pair();
    nodes[0].resources = { cpus: 4, ram_gb: 16 };
    const { definition } = serializeDefinition(nodes, edges);
    const [read, drop] = definition.nodes ?? [];
    expect((read as { resources?: unknown }).resources).toEqual({ cpus: 4, ram_gb: 16 });
    expect(Object.hasOwn(drop as object, "resources")).toBe(false);
  });

  it("a partial override stays partial — unset fields keep inheriting", () => {
    const { nodes, edges } = pair();
    nodes[1].resources = { ram_gb: 8 };
    const { definition } = serializeDefinition(nodes, edges);
    expect((definition.nodes?.[1] as { resources?: unknown }).resources).toEqual({ ram_gb: 8 });
  });
});

describe("round trip (AC-5)", () => {
  it("explicit resources survive serialize → hydrate unchanged", () => {
    const { nodes, edges } = pair();
    nodes[0].resources = { cpus: 2, ram_gb: 8, timeout_minutes: 45 };
    const { definition } = serializeDefinition(nodes, edges);
    const back = hydrateFromDefinition(definition, [READ, DROP]);
    expect(back.nodes[0].resources).toEqual({ cpus: 2, ram_gb: 8, timeout_minutes: 45 });
  });

  it("absent resources stay absent after hydrate", () => {
    const { nodes, edges } = pair();
    const { definition } = serializeDefinition(nodes, edges);
    const back = hydrateFromDefinition(definition, [READ, DROP]);
    expect(back.nodes[0].resources).toBeUndefined();
    expect(back.nodes[1].resources).toBeUndefined();
  });

  it("a legacy definition with no resources hydrates cleanly", () => {
    const legacy = {
      nodes: [{ alias: "read_0", component: "read-from-warehouse", parameters: {}, outputs: [] }],
      edges: [],
    };
    const back = hydrateFromDefinition(legacy, [READ]);
    expect(back.nodes[0].resources).toBeUndefined();
  });
});

describe("store: setResource", () => {
  beforeEach(() => useCanvasStore.getState().reset());

  it("sets a field, then clears it back to inherit", () => {
    const { nodes } = pair();
    useCanvasStore.getState().load(nodes, []);
    const id = nodes[0].id;

    useCanvasStore.getState().setResource(id, "ram_gb", 16);
    expect(useCanvasStore.getState().nodes[0].resources).toEqual({ ram_gb: 16 });

    // Clearing the last field must drop the object, not leave `{}` behind —
    // otherwise serialize would emit an empty override and pin the node.
    useCanvasStore.getState().setResource(id, "ram_gb", undefined);
    expect(useCanvasStore.getState().nodes[0].resources).toBeUndefined();
  });

  it("clearing one field of several keeps the rest", () => {
    const { nodes } = pair();
    useCanvasStore.getState().load(nodes, []);
    const id = nodes[0].id;
    useCanvasStore.getState().setResource(id, "cpus", 4);
    useCanvasStore.getState().setResource(id, "ram_gb", 16);
    useCanvasStore.getState().setResource(id, "cpus", undefined);
    expect(useCanvasStore.getState().nodes[0].resources).toEqual({ ram_gb: 16 });
  });

  it("aliasOf maps a node id to the alias the backend keys effective resources by", () => {
    const { nodes } = pair();
    useCanvasStore.getState().load(nodes, []);
    expect(useCanvasStore.getState().aliasOf(nodes[0].id)).toBe("read_from_warehouse_0");
    expect(useCanvasStore.getState().aliasOf(nodes[1].id)).toBe("drop_columns_0");
  });

  it("effectiveResources starts null and resets to null on load", () => {
    expect(useCanvasStore.getState().effectiveResources).toBeNull();
    useCanvasStore.getState().setEffectiveResources({ read_from_warehouse_0: { cpus: 4 } });
    expect(useCanvasStore.getState().effectiveResources).not.toBeNull();
    useCanvasStore.getState().load(pair().nodes, []);
    expect(useCanvasStore.getState().effectiveResources).toBeNull();
  });
});
