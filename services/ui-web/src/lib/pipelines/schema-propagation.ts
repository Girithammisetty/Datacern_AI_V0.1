/**
 * BRD 71 (U2) — DAG schema propagation for the no-code builder.
 *
 * A column picker three steps downstream of a `select-columns` must offer the columns
 * that will exist *there*, not the ones the source dataset started with. Without this,
 * every choice after a projection, rename or join is made against a stale list and
 * fails later at validate or run time — the failure is real either way, only the
 * feedback is late.
 *
 * This is the Datacern equivalent of V1's per-component `component.js`
 * `process_header(header[, header2], component_parameters) -> string[]`, collapsed into
 * one registry so the semantics live next to each other and are testable as a unit.
 *
 * The semantics are ported from the **executor** (`app/executor/operators.py`), which
 * is authoritative — not from V1's JS, which is wrong in at least one place
 * (`drop_columns/component.js` inverts its filter and *keeps* the dropped columns).
 *
 * Pure and framework-free: no React, no network, no store. Unknown components pass
 * their first input through unchanged, which is V1's own default and keeps a partially
 * catalogued DAG usable.
 */
import type { CanvasEdge, CanvasNode } from "./canvas";
import { collect } from "./form";

/** Computes a step's OUTPUT column list from its ordered INPUT column lists. */
export type HeaderFn = (inputs: string[][], params: Record<string, unknown>) => string[];

const first = (inputs: string[][]): string[] => inputs[0] ?? [];

const asStrings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

const uniq = (cols: string[]): string[] => Array.from(new Set(cols));

const strParam = (v: unknown, fallback: string): string =>
  typeof v === "string" && v ? v : fallback;

/** `on` / `by` accept a string or a list in the executor; normalize both. */
const keyColumns = (params: Record<string, unknown>, names: string[] = ["on"]): string[] => {
  for (const n of names) {
    const v = params[n];
    if (typeof v === "string" && v) return [v];
    const arr = asStrings(v);
    if (arr.length) return arr;
  }
  return [];
};

/**
 * Row-shaping operators (filter/sample/sort/dedup/outlier removal/scaling in place)
 * are pass-through by construction and deliberately have no entry below — the default
 * already does the right thing for them, and listing them would be noise that rots.
 */
export const HEADER_FNS: Record<string, HeaderFn> = {
  "select-columns": (inputs, params) => {
    const cols = asStrings(params.columns);
    if (!cols.length) return first(inputs);
    if (params.exclude) {
      const drop = new Set(cols);
      return first(inputs).filter((c) => !drop.has(c));
    }
    return cols;
  },

  "drop-columns": (inputs, params) => {
    const drop = new Set(asStrings(params.columns));
    if (!drop.size) return first(inputs);
    return first(inputs).filter((c) => !drop.has(c));
  },

  "rename-columns": (inputs, params) => {
    const mapping = (params.mapping ?? params.rename) as Record<string, unknown> | undefined;
    if (!mapping || typeof mapping !== "object") return first(inputs);
    return first(inputs).map((c) => {
      const to = mapping[c];
      return typeof to === "string" && to ? to : c;
    });
  },

  /**
   * `left.merge(right, on=…, suffixes=("", "_r"))` — the executor pins the suffixes,
   * so an overlapping non-key column keeps its name on the LEFT and gains `_r` on the
   * right. (Not pandas' `_x`/`_y` defaults; getting this wrong is exactly the kind of
   * silent mismatch this module exists to prevent.)
   */
  "join-data": (inputs, params) => {
    const left = inputs[0] ?? [];
    const right = inputs[1] ?? [];
    const on = keyColumns(params);
    if (!on.length && !(params.left_on && params.right_on)) return left;
    const onSet = new Set(on);
    // With left_on/right_on the right key is a distinct column and is retained.
    const rightRest = right.filter((c) => !onSet.has(c));
    const leftSet = new Set(left);
    return [...left, ...rightRest.map((c) => (leftSet.has(c) ? `${c}_r` : c))];
  },

  /** Reduce over N inputs; no key = horizontal concat (columns side by side). */
  "merge-data": (inputs, params) => {
    const on = keyColumns(params);
    return inputs.reduce((acc, next) => {
      if (!acc.length) return next;
      if (!on.length) return [...acc, ...next]; // axis=1 concat keeps duplicates
      const onSet = new Set(on);
      const accSet = new Set(acc);
      const rest = next.filter((c) => !onSet.has(c));
      return [...acc, ...rest.map((c) => (accSet.has(c) ? `${c}_r` : c))];
    }, [] as string[]);
  },

  /** Row-wise concat: the union of every input's columns, first-seen order. */
  union: (inputs) => uniq(inputs.flat()),

  /**
   * `groupby(keys).agg(aggs).reset_index()` → keys + one column per aggregated
   * measure. With `join_with_original` the result is merged back onto the input, so
   * every original column survives and colliding measures gain `_agg`.
   */
  "group-by": (inputs, params) => {
    const by = keyColumns(params, ["by", "group_columns"]);
    const aggSpec = params.aggregations ?? params.agg;
    const measures =
      aggSpec && typeof aggSpec === "object" && !Array.isArray(aggSpec)
        ? Object.keys(aggSpec as Record<string, unknown>)
        : [];
    if (!by.length || !measures.length) return first(inputs);
    if (params.join_with_original) {
      const orig = first(inputs);
      const origSet = new Set(orig);
      return [...orig, ...measures.map((m) => (origSet.has(m) ? `${m}_agg` : m))];
    }
    return uniq([...by, ...measures]);
  },

  "add-guid-column": (inputs, params) =>
    uniq([...first(inputs), strParam(params.column, "_row_guid_")]),

  "linear-combination": (inputs, params) =>
    uniq([...first(inputs), strParam(params.output_column, "linear_combination")]),

  "python-expression": (inputs, params) =>
    uniq([...first(inputs), strParam(params.output_column, "expr_result")]),

  "quantization": (inputs, params) => {
    const col = strParam(params.column, "");
    if (!col) return first(inputs);
    return uniq([...first(inputs), strParam(params.output_column, `${col}_bin`)]);
  },

  /**
   * PCA drops the decomposed columns and appends `pc_1..pc_n` (or keeps them with
   * `keep_original`). n defaults to `min(2, |cols|)` and is clamped to |cols| — the
   * same clamp the executor applies, so the names match.
   */
  pca: (inputs, params) => {
    const cols = asStrings(params.columns);
    // No explicit column list = every numeric column, which the builder cannot know.
    if (!cols.length) return first(inputs);
    const requested = Number(params.n_components);
    const n = Math.max(
      1,
      Math.min(Number.isFinite(requested) ? requested : Math.min(2, cols.length), cols.length),
    );
    const generated = Array.from({ length: n }, (_, i) => `pc_${i + 1}`);
    if (params.keep_original) return uniq([...first(inputs), ...generated]);
    const dropped = new Set(cols);
    return uniq([...first(inputs).filter((c) => !dropped.has(c)), ...generated]);
  },

  /**
   * `get_dummies(columns=…)` replaces each encoded column with one column per
   * DISTINCT VALUE — names the builder cannot know without the data. V1's own
   * `component.js` gives up here too and returns the header unchanged. We do the one
   * thing that IS knowable: the encoded source columns are gone. Inventing `cat_a` /
   * `cat_b` names that may not exist would be worse than under-reporting.
   */
  "one-hot-encoder": (inputs, params) => {
    const cols = new Set(asStrings(params.columns));
    if (!cols.size) return first(inputs);
    return first(inputs).filter((c) => !cols.has(c));
  },

  /** `melt(id_vars=…)` → id_vars plus the var/value pair. */
  "wide-to-long-converter": (inputs, params) => {
    const ids = keyColumns(params, ["id_vars", "index"]);
    if (!ids.length) return first(inputs);
    return [...ids, strParam(params.var_name, "variable"), strParam(params.value_name, "value")];
  },

  /**
   * `pivot_table` turns the VALUES of the pivot column into column NAMES, so like
   * one-hot the result is data-dependent. Only the index column(s) are knowable —
   * returning just those is honest and still useful (index columns are what a
   * downstream join or group-by needs).
   */
  "long-to-wide-converter": (inputs, params) => {
    const index = keyColumns(params, ["index"]);
    return index.length ? index : first(inputs);
  },

  /** Both split outputs carry the input's columns. */
  "split-data": (inputs) => first(inputs),
  "clone-input": (inputs) => first(inputs),
  "model-input": (inputs) => first(inputs),
  "data-profiler": (inputs) => first(inputs),
};

/** Components that produce a frame from nothing — the propagation roots. */
const READ_COMPONENTS = new Set(["read-from-warehouse", "batch-read-from-warehouse"]);

/** Kahn topological order over node ids. Cycles are appended so callers see every node. */
function topoOrder(ids: string[], edges: Array<[string, string]>): string[] {
  const indeg = new Map(ids.map((id) => [id, 0]));
  const adj = new Map<string, string[]>();
  for (const [a, b] of edges) {
    if (!indeg.has(a) || !indeg.has(b)) continue;
    adj.set(a, [...(adj.get(a) ?? []), b]);
    indeg.set(b, (indeg.get(b) ?? 0) + 1);
  }
  const queue = ids.filter((id) => indeg.get(id) === 0);
  const order: string[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    order.push(id);
    for (const next of adj.get(id) ?? []) {
      const d = (indeg.get(next) ?? 0) - 1;
      indeg.set(next, d);
      if (d === 0) queue.push(next);
    }
  }
  for (const id of ids) if (!order.includes(id)) order.push(id);
  return order;
}

/**
 * The column list each node's step will actually SEE — i.e. the union of its inbound
 * ports' outputs. Read nodes see `sourceColumns`.
 *
 * Returns a map keyed by node id. A node whose inputs are unknown (disconnected, or
 * downstream of a data-dependent step like one-hot) maps to an empty list, and the
 * widget layer falls back to free text — the same degradation it already has when no
 * dataset is chosen.
 */
export interface PropagationResult {
  /** Node id -> the columns that node's own form should offer. */
  seen: Map<string, string[]>;
  /** Node id -> why propagation failed there. Empty when everything worked. */
  errors: Map<string, string>;
}

export function propagateSchema(
  nodes: CanvasNode[],
  edges: CanvasEdge[],
  sourceColumns: string[],
): PropagationResult {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const incoming = new Map<string, CanvasEdge[]>();
  const topoEdges: Array<[string, string]> = [];
  for (const e of edges) {
    if (!byId.has(e.from.nodeId) || !byId.has(e.to.nodeId)) continue;
    incoming.set(e.to.nodeId, [...(incoming.get(e.to.nodeId) ?? []), e]);
    topoEdges.push([e.from.nodeId, e.to.nodeId]);
  }

  /** Output columns per node id (all ports share one list — split/clone fan out equal). */
  const outputs = new Map<string, string[]>();
  /** Input columns per node id — what that node's OWN form should offer. */
  const seen = new Map<string, string[]>();
  const errors = new Map<string, string>();

  for (const id of topoOrder([...byId.keys()], topoEdges)) {
    const node = byId.get(id)!;
    if (READ_COMPONENTS.has(node.component)) {
      seen.set(id, sourceColumns);
      outputs.set(id, sourceColumns);
      continue;
    }
    // Inbound edges in authoring order, so join-data sees left=[0], right=[1] —
    // the same ordering rule the executor uses.
    const ins = (incoming.get(id) ?? []).map((e) => outputs.get(e.from.nodeId) ?? []);
    seen.set(id, ins[0] ?? []);

    const fn = HEADER_FNS[node.component];
    if (!fn) {
      outputs.set(id, ins[0] ?? []);
      continue;
    }
    // Resolve the node's params exactly as save-time does, so the propagated schema
    // reflects the values that will actually be submitted (not the raw form text).
    const { parameters } = collect(node.params, node.values);
    try {
      outputs.set(id, fn(ins, parameters));
    } catch (err) {
      // `parameters` has already been through collect(), so a throw here is a BUG
      // in the header function, not bad user input. Swallowing it degraded the
      // step to "columns unchanged" — which looks exactly like a correct
      // pass-through operator, so a broken header function could ship unnoticed
      // and quietly feed every downstream picker the wrong column list.
      //
      // Tests fail loudly. The app keeps the picker usable (an unusable form
      // helps nobody) but records the failure so the UI can show it.
      if (process.env.NODE_ENV === "test") throw err;
      console.error(`[propagateSchema] ${node.component} header function threw`, err);
      errors.set(id, err instanceof Error ? err.message : String(err));
      outputs.set(id, ins[0] ?? []);
    }
  }
  return { seen, errors };
}
