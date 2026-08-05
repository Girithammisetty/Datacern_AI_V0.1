/**
 * BRD 71 (U2) — DAG schema propagation.
 *
 * Every expectation here is the column list the EXECUTOR
 * (`pipeline-orchestrator/app/executor/operators.py`) actually produces. That is the
 * contract: a picker offering something the executor will not produce is the bug this
 * module exists to fix, so the tests are written against the executor's semantics
 * rather than against the propagation code's own idea of them.
 */
import { describe, it, expect } from "vitest";
import { propagateSchema, HEADER_FNS } from "./schema-propagation";
import type { CanvasEdge, CanvasNode } from "./canvas";
import type { PipelineStepParam } from "@/lib/graphql/types";

const SRC = ["id", "amount", "cat", "pii"];

const param = (name: string, type = "array", format?: string): PipelineStepParam => ({
  name,
  type,
  format,
  required: false,
} as PipelineStepParam);

let seq = 0;
function node(component: string, values: Record<string, string | boolean> = {}, params: PipelineStepParam[] = []): CanvasNode {
  return {
    id: `n${++seq}`,
    component,
    displayName: component,
    category: "data_prep",
    x: 0,
    y: 0,
    inputs: [{ name: "in0", type: "dataframe" }, { name: "in1", type: "dataframe" }],
    outputs: [{ name: "out", type: "dataframe" }],
    minInputs: 0,
    maxInputs: 2,
    maxOutputs: 1,
    params,
    values,
  };
}

function edge(from: CanvasNode, to: CanvasNode, port = "in0"): CanvasEdge {
  return {
    id: `${from.id}->${to.id}.${port}`,
    from: { nodeId: from.id, port: "out", type: "dataframe" },
    to: { nodeId: to.id, port },
  };
}

/** What THIS node's own form should offer. */
function seenBy(nodes: CanvasNode[], edges: CanvasEdge[], target: CanvasNode): string[] {
  return propagateSchema(nodes, edges, SRC).get(target.id) ?? [];
}

describe("propagateSchema — the core defect", () => {
  it("a step after select-columns sees the SELECTED columns, not the source dataset", () => {
    const read = node("read-from-warehouse");
    const sel = node("select-columns", { columns: JSON.stringify(["id", "amount"]) }, [
      param("columns", "array", "columns"),
    ]);
    const next = node("filter-data");
    const nodes = [read, sel, next];
    const edges = [edge(read, sel), edge(sel, next)];

    expect(seenBy(nodes, edges, sel)).toEqual(SRC); // the projection's own form sees its input
    expect(seenBy(nodes, edges, next)).toEqual(["id", "amount"]);
    expect(seenBy(nodes, edges, next)).not.toContain("pii");
  });

  it("a step after rename-columns sees the NEW names", () => {
    const read = node("read-from-warehouse");
    const ren = node("rename-columns", { mapping: JSON.stringify({ amount: "total" }) }, [
      param("mapping", "object"),
    ]);
    const next = node("sort-data");
    const edges = [edge(read, ren), edge(ren, next)];
    expect(seenBy([read, ren, next], edges, next)).toEqual(["id", "total", "cat", "pii"]);
  });

  it("propagates through a chain of three transforms", () => {
    const read = node("read-from-warehouse");
    const drop = node("drop-columns", { columns: JSON.stringify(["pii"]) }, [
      param("columns", "array", "columns"),
    ]);
    const guid = node("add-guid-column", { column: "row_id" }, [param("column", "string")]);
    const last = node("sort-data");
    const nodes = [read, drop, guid, last];
    const edges = [edge(read, drop), edge(drop, guid), edge(guid, last)];
    expect(seenBy(nodes, edges, last)).toEqual(["id", "amount", "cat", "row_id"]);
  });

  it("a disconnected node reports no columns rather than the source's", () => {
    const read = node("read-from-warehouse");
    const orphan = node("filter-data");
    expect(seenBy([read, orphan], [], orphan)).toEqual([]);
  });

  it("an unknown component passes its input through unchanged", () => {
    const read = node("read-from-warehouse");
    const weird = node("some-future-operator");
    const next = node("sort-data");
    const edges = [edge(read, weird), edge(weird, next)];
    expect(seenBy([read, weird, next], edges, next)).toEqual(SRC);
  });

  it("a half-typed param never breaks the picker", () => {
    const read = node("read-from-warehouse");
    // `columns` holds unparseable JSON — collect() drops it, propagation falls back.
    const sel = node("select-columns", { columns: "[not json" }, [param("columns", "array", "columns")]);
    const next = node("sort-data");
    const edges = [edge(read, sel), edge(sel, next)];
    expect(() => seenBy([read, sel, next], edges, next)).not.toThrow();
    expect(seenBy([read, sel, next], edges, next)).toEqual(SRC);
  });
});

describe("HEADER_FNS — per-operator semantics, matched to the executor", () => {
  it("select-columns keeps the listed columns in the listed order", () => {
    expect(HEADER_FNS["select-columns"]([SRC], { columns: ["amount", "id"] })).toEqual([
      "amount",
      "id",
    ]);
  });

  it("select-columns with exclude inverts, preserving FRAME order", () => {
    expect(HEADER_FNS["select-columns"]([SRC], { columns: ["amount"], exclude: true })).toEqual([
      "id",
      "cat",
      "pii",
    ]);
  });

  it("drop-columns removes the listed columns and ignores unknown ones", () => {
    expect(HEADER_FNS["drop-columns"]([SRC], { columns: ["pii", "nope"] })).toEqual([
      "id",
      "amount",
      "cat",
    ]);
  });

  it("join-data suffixes the RIGHT side with _r — the executor pins suffixes=('', '_r')", () => {
    const left = ["id", "amount"];
    const right = ["id", "amount", "score"];
    // Not pandas' _x/_y defaults: left keeps its name, right collides to amount_r.
    expect(HEADER_FNS["join-data"]([left, right], { on: "id" })).toEqual([
      "id",
      "amount",
      "amount_r",
      "score",
    ]);
  });

  it("join-data with no key returns the left side rather than guessing", () => {
    expect(HEADER_FNS["join-data"]([["id"], ["x"]], {})).toEqual(["id"]);
  });

  it("merge-data with no key concatenates horizontally", () => {
    expect(HEADER_FNS["merge-data"]([["a"], ["b"], ["c"]], {})).toEqual(["a", "b", "c"]);
  });

  it("merge-data reduces over N inputs on a key", () => {
    expect(HEADER_FNS["merge-data"]([["id", "a"], ["id", "b"], ["id", "a"]], { on: "id" })).toEqual([
      "id",
      "a",
      "b",
      "a_r",
    ]);
  });

  it("union is the first-seen union of every input", () => {
    expect(HEADER_FNS["union"]([["a", "b"], ["b", "c"]], {})).toEqual(["a", "b", "c"]);
  });

  it("group-by collapses to keys + aggregated measures", () => {
    expect(HEADER_FNS["group-by"]([SRC], { by: ["cat"], aggregations: { amount: "sum" } })).toEqual([
      "cat",
      "amount",
    ]);
  });

  it("group-by with join_with_original keeps every original column and suffixes collisions", () => {
    expect(
      HEADER_FNS["group-by"]([SRC], {
        by: ["cat"],
        aggregations: { amount: "sum" },
        join_with_original: true,
      }),
    ).toEqual([...SRC, "amount_agg"]);
  });

  it("pca drops the decomposed columns and appends pc_1..pc_n", () => {
    expect(HEADER_FNS["pca"]([SRC], { columns: ["id", "amount"], n_components: 2 })).toEqual([
      "cat",
      "pii",
      "pc_1",
      "pc_2",
    ]);
  });

  it("pca with keep_original appends without dropping", () => {
    expect(
      HEADER_FNS["pca"]([SRC], { columns: ["id", "amount"], n_components: 1, keep_original: true }),
    ).toEqual([...SRC, "pc_1"]);
  });

  it("pca clamps n_components to the number of input columns, like the executor", () => {
    expect(HEADER_FNS["pca"]([SRC], { columns: ["id"], n_components: 9 })).toEqual([
      "amount",
      "cat",
      "pii",
      "pc_1",
    ]);
  });

  it("one-hot removes the encoded columns and does not invent value-derived names", () => {
    const out = HEADER_FNS["one-hot-encoder"]([SRC], { columns: ["cat"] });
    expect(out).toEqual(["id", "amount", "pii"]);
    expect(out.some((c) => c.startsWith("cat_"))).toBe(false);
  });

  it("wide-to-long returns id_vars plus the var/value pair", () => {
    expect(HEADER_FNS["wide-to-long-converter"]([SRC], { id_vars: ["id"] })).toEqual([
      "id",
      "variable",
      "value",
    ]);
  });

  it("long-to-wide reports only the index — the other names come from the data", () => {
    expect(HEADER_FNS["long-to-wide-converter"]([SRC], { index: "id" })).toEqual(["id"]);
  });

  it("quantization appends the executor's default <col>_bin name", () => {
    expect(HEADER_FNS["quantization"]([SRC], { column: "amount" })).toEqual([...SRC, "amount_bin"]);
  });

  it("python-expression and linear-combination use the executor's default output names", () => {
    expect(HEADER_FNS["python-expression"]([SRC], {})).toEqual([...SRC, "expr_result"]);
    expect(HEADER_FNS["linear-combination"]([SRC], {})).toEqual([...SRC, "linear_combination"]);
  });

  it("add-guid-column uses the executor's default column name", () => {
    expect(HEADER_FNS["add-guid-column"]([SRC], {})).toEqual([...SRC, "_row_guid_"]);
  });

  it("split-data outputs carry the input's columns", () => {
    expect(HEADER_FNS["split-data"]([SRC], { split_size: 0.8 })).toEqual(SRC);
  });
});
