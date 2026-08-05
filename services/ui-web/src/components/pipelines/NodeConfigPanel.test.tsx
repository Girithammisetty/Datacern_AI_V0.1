import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "@/test/utils";

/** graphqlRequest routed by operation name (repo convention). */
let handler: (doc: string, vars: any) => any = () => ({});
vi.mock("@/lib/graphql/client", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/graphql/client")>();
  return {
    ...actual,
    graphqlRequest: (doc: string, vars: any) => Promise.resolve(handler(doc, vars)),
  };
});

import { NodeConfigPanel } from "./NodeConfigPanel";
import { nodeFromStep, useCanvasStore, type CanvasNode } from "@/lib/pipelines/canvas";
import type { PipelineStepType } from "@/lib/graphql/types";

const READ = {
  name: "read-from-warehouse", displayName: "Read from warehouse", category: "io",
  description: null, minInputs: 0, maxInputs: 0, maxOutputs: 1,
  outputs: [{ name: "out", type: "dataframe" }],
  parameters: [{ name: "dataset", type: "string", format: "dataset_ref", required: true }],
} as unknown as PipelineStepType;

const SELECT = {
  name: "select-columns", displayName: "Select columns", category: "data_prep",
  description: null, minInputs: 1, maxInputs: 1, maxOutputs: 1,
  outputs: [{ name: "out", type: "dataframe" }],
  parameters: [{ name: "columns", type: "array", format: "columns", itemFormat: "column", required: true }],
} as unknown as PipelineStepType;

const SORT = {
  name: "sort-data", displayName: "Sort data", category: "data_prep",
  description: null, minInputs: 1, maxInputs: 1, maxOutputs: 1,
  outputs: [{ name: "out", type: "dataframe" }],
  parameters: [{ name: "by", type: "array", format: "columns", itemFormat: "column", required: true }],
} as unknown as PipelineStepType;

const POLICY = {
  pipelineResourcePolicy: {
    defaults: { cpus: 1, ram_gb: 2, timeout_minutes: 30 },
    floor: { cpus: 1, ram_gb: 2, timeout_minutes: 5 },
    ceiling: { cpus: 7, ram_gb: 24, timeout_minutes: 480 },
  },
};

const SCHEMA = {
  datasetSchema: [
    { name: "id", type: "string", nullable: true, tags: [], inferred: false },
    { name: "amount", type: "double", nullable: true, tags: [], inferred: false },
    { name: "pii", type: "string", nullable: true, tags: [], inferred: false },
  ],
};

const DATASETS = { datasets: { nodes: [], pageInfo: { nextCursor: null, hasMore: false } } };

/** Build read -> select(id, amount) -> sort and select `sort` in the store. */
function buildChain(): { read: CanvasNode; sel: CanvasNode; sort: CanvasNode } {
  const read = nodeFromStep(READ, { x: 0, y: 0 });
  read.values.dataset = "wr:t:dataset:dataset/d";
  const sel = nodeFromStep(SELECT, { x: 200, y: 0 });
  sel.values.columns = JSON.stringify(["id", "amount"]);
  const sort = nodeFromStep(SORT, { x: 400, y: 0 });
  const edges = [
    { id: "e1", from: { nodeId: read.id, port: "out", type: "dataframe" }, to: { nodeId: sel.id, port: "in0" } },
    { id: "e2", from: { nodeId: sel.id, port: "out", type: "dataframe" }, to: { nodeId: sort.id, port: "in0" } },
  ];
  useCanvasStore.getState().load([read, sel, sort], edges);
  return { read, sel, sort };
}

beforeEach(() => {
  useCanvasStore.getState().reset();
  handler = (doc: string) => {
    if (doc.includes("query PipelineResourcePolicy")) return POLICY;
    if (doc.includes("query DatasetSchema")) return SCHEMA;
    if (doc.includes("query Datasets")) return DATASETS;
    return {};
  };
});

describe("BRD 71 U1 — resource parameters in the config drawer", () => {
  it("renders the Resource Parameters group with the served floor and ceiling (AC-7)", async () => {
    const { read } = buildChain();
    useCanvasStore.getState().selectNode(read.id);
    renderWithProviders(<NodeConfigPanel />);

    await waitFor(() => expect(screen.getByTestId("resource-fields")).toBeTruthy());
    const ram = screen.getByLabelText("RAM (GB)") as HTMLInputElement;
    await waitFor(() => expect(ram.min).toBe("2"));
    expect(ram.max).toBe("24");
    expect(ram.value).toBe(""); // untouched = inherit, NOT a pre-filled default
  });

  it("shows the inherited effective value as placeholder, not as a value (AC-7)", async () => {
    const { sort } = buildChain();
    useCanvasStore.getState().setEffectiveResources({
      sort_data_0: { cpus: 4, ram_gb: 16, timeout_minutes: 120 },
    });
    useCanvasStore.getState().selectNode(sort.id);
    renderWithProviders(<NodeConfigPanel />);

    const ram = (await screen.findByLabelText("RAM (GB)")) as HTMLInputElement;
    await waitFor(() => expect(ram.placeholder).toBe("Inherited: 16"));
    expect(ram.value).toBe("");
  });

  it("typing a value stores it; clearing it returns the node to inherit", async () => {
    const { read } = buildChain();
    useCanvasStore.getState().selectNode(read.id);
    renderWithProviders(<NodeConfigPanel />);
    const user = userEvent.setup();

    const cpus = (await screen.findByLabelText("CPU cores")) as HTMLInputElement;
    await user.clear(cpus);
    await user.type(cpus, "4");
    await waitFor(() =>
      expect(useCanvasStore.getState().nodes.find((n) => n.id === read.id)?.resources).toEqual({ cpus: 4 }),
    );

    await user.clear(cpus);
    await waitFor(() =>
      expect(useCanvasStore.getState().nodes.find((n) => n.id === read.id)?.resources).toBeUndefined(),
    );
  });

  it("clamps a typed value above the tenant ceiling", async () => {
    const { read } = buildChain();
    useCanvasStore.getState().selectNode(read.id);
    renderWithProviders(<NodeConfigPanel />);
    const user = userEvent.setup();

    const ram = (await screen.findByLabelText("RAM (GB)")) as HTMLInputElement;
    await waitFor(() => expect(ram.max).toBe("24"));
    await user.type(ram, "99");
    await waitFor(() =>
      expect(useCanvasStore.getState().nodes.find((n) => n.id === read.id)?.resources?.ram_gb).toBe(24),
    );
  });
});

describe("BRD 71 U2 — column widgets bind to the propagated schema (AC-9)", () => {
  it("a node after select-columns offers only the selected columns", async () => {
    const { sort } = buildChain();
    useCanvasStore.getState().selectNode(sort.id);
    renderWithProviders(<NodeConfigPanel />);

    // The `by` widget is data-aware: its options come from the propagated schema.
    await waitFor(() => expect(screen.getByTestId("node-config-panel")).toBeTruthy());
    await waitFor(() => {
      const options = Array.from(document.querySelectorAll("option")).map((o) => o.value);
      expect(options).toContain("amount");
    });
    const options = Array.from(document.querySelectorAll("option")).map((o) => o.value);
    // `pii` exists on the source dataset but was projected away upstream — offering
    // it is exactly the defect U2 fixes.
    expect(options).not.toContain("pii");
  });

  it("the projecting node itself still sees its own input columns", async () => {
    const { sel } = buildChain();
    useCanvasStore.getState().selectNode(sel.id);
    renderWithProviders(<NodeConfigPanel />);

    await waitFor(() => {
      const options = Array.from(document.querySelectorAll("option")).map((o) => o.value);
      expect(options).toContain("pii");
    });
  });
});
