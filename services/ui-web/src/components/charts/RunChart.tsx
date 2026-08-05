"use client";
import { toLabel } from "@/lib/charts/geometry";
import { EChartsChart } from "./EChartsChart";
import { t } from "@/lib/i18n/messages";

/**
 * BRD 72 inc3 — the `dataClass="run"` chart types (`confusion_matrix`,
 * `roc_curve`, `decision_tree`).
 *
 * These resolve to an `artifact` blob, not to rows: chart-service's
 * `resolveArtifact` fetches `<experiment-service>/api/v1/artifacts?urn=<run urn>`,
 * which now returns `{kind:"run_summary", metrics, confusion_matrix?, roc_auc?}`
 * built from the run mirror.
 *
 * What each type can honestly draw today:
 *
 * * `confusion_matrix` — REAL. The executor logs a flattened `cm_{i}_{j}` matrix
 *   plus a class-labels tag, both mirrored into Postgres, so this renders the
 *   actual matrix with actual class names.
 * * `roc_curve` — REAL as of inc3b. experiment-service reads the run's
 *   `evaluation.json` out of the artifact store and merges the real
 *   `sklearn.metrics.roc_curve` points into the artifact. When the blob is absent
 *   (a run predating it, or a GC'd object) only the mirrored AUC scalar survives,
 *   and we say so rather than drawing an invented curve.
 * * `decision_tree` — REAL as of inc3b, from the same blob, rendered through the
 *   tree builder BRD 72 inc2 already added for `tree_chart`.
 */
interface ConfusionMatrix {
  labels: string[];
  matrix: number[][];
  total?: number;
  /** False when the run carried no class-labels tag: the numbers are real, the
   * NAMES are positional indices. Surfaced, never presented as real labels. */
  labels_available?: boolean;
}

function confusionMatrix(artifact: unknown): ConfusionMatrix | null {
  if (!artifact || typeof artifact !== "object") return null;
  const cm = (artifact as { confusion_matrix?: unknown }).confusion_matrix;
  if (!cm || typeof cm !== "object") return null;
  const { labels, matrix } = cm as { labels?: unknown; matrix?: unknown };
  if (!Array.isArray(labels) || !Array.isArray(matrix)) return null;
  const rows = matrix.filter((r): r is number[] => Array.isArray(r));
  if (rows.length !== labels.length) return null; // a mislabelled matrix is worse than none
  return {
    labels: labels.map(toLabel),
    matrix: rows,
    total: (cm as { total?: number }).total,
    labels_available: (cm as { labels_available?: boolean }).labels_available,
  };
}

export interface RocCurve {
  points: { fpr: number; tpr: number }[];
  positive_label?: string | null;
}

function rocCurve(artifact: unknown): RocCurve | null {
  if (!artifact || typeof artifact !== "object") return null;
  const roc = (artifact as { roc_curve?: unknown }).roc_curve;
  if (!roc || typeof roc !== "object") return null;
  const pts = (roc as { points?: unknown }).points;
  if (!Array.isArray(pts) || pts.length < 2) return null; // two points is not a curve
  const points = pts
    .filter((p): p is { fpr: number; tpr: number } =>
      !!p && typeof p === "object" &&
      Number.isFinite((p as { fpr?: unknown }).fpr) &&
      Number.isFinite((p as { tpr?: unknown }).tpr))
    .map((p) => ({ fpr: p.fpr, tpr: p.tpr }));
  if (points.length < 2) return null;
  return { points, positive_label: (roc as { positive_label?: string }).positive_label };
}

/**
 * The tree payload is `{root, node_count}` with nested `children`; the tree
 * renderer BRD 72 inc2 built consumes the network family's `{nodes, edges}`.
 * Flattening here rather than adding a second tree renderer keeps one code path.
 * Node ids carry the split condition, which is what makes a decision tree
 * readable — "amount ≤ 1.5" not "node 7".
 */
function treeGraph(artifact: unknown): { nodes: { id: string }[]; edges: { from: string; to: string }[] } | null {
  const tree = (artifact as { tree?: unknown } | undefined)?.tree;
  if (!tree || typeof tree !== "object") return null;
  const root = (tree as { root?: unknown }).root;
  if (!root || typeof root !== "object") return null;

  const nodes: { id: string }[] = [];
  const edges: { from: string; to: string }[] = [];
  const label = (n: Record<string, unknown>): string =>
    n.leaf
      ? `${toLabel(n.prediction ?? "?")} (n=${toLabel(n.samples ?? 0)})`
      : `${toLabel(n.feature ?? "?")} ≤ ${toLabel(n.threshold ?? "?")}`;
  let seq = 0;
  const walk = (n: Record<string, unknown>, parent: string | null) => {
    // Sibling splits can share a condition, so ids are made unique by sequence
    // while the DISPLAY text stays the condition.
    const id = `${label(n)} #${seq++}`;
    nodes.push({ id });
    if (parent) edges.push({ from: parent, to: id });
    const kids = Array.isArray(n.children) ? n.children : [];
    for (const k of kids) if (k && typeof k === "object") walk(k as Record<string, unknown>, id);
  };
  walk(root as Record<string, unknown>, null);
  return nodes.length ? { nodes, edges } : null;
}

/** The nested `{root}` payload, for the pre-hydration outline. */
function treeRoot(artifact: unknown): Record<string, unknown> | null {
  const tree = (artifact as { tree?: unknown } | undefined)?.tree;
  const root = tree && typeof tree === "object" ? (tree as { root?: unknown }).root : null;
  return root && typeof root === "object" ? (root as Record<string, unknown>) : null;
}

/** Text outline of the decision tree — the SSR/jsdom fallback behind the real
 * ECharts tree. Real data, no canvas required. */
export function TreeOutline({ node, depth = 0 }: { node: Record<string, unknown>; depth?: number }) {
  const kids = Array.isArray(node.children) ? node.children : [];
  const text = node.leaf
    ? `${toLabel(node.prediction ?? "?")} (n=${toLabel(node.samples ?? 0)})`
    : `${toLabel(node.feature ?? "?")} ≤ ${toLabel(node.threshold ?? "?")}`;
  return (
    <ul className={depth === 0 ? "max-h-64 overflow-y-auto text-xs" : "ml-4 border-l pl-2 text-xs"}>
      <li>
        <span className="font-mono">{text}</span>
        {kids.map((k, i) =>
          k && typeof k === "object" ? (
            <TreeOutline key={i} node={k as Record<string, unknown>} depth={depth + 1} />
          ) : null,
        )}
      </li>
    </ul>
  );
}

export function RocCurveChart({
  curve,
  auc,
  title,
}: {
  curve: RocCurve;
  auc?: number;
  title?: string;
}) {
  // Two series: the curve, and the y=x chance line. Without the reference line a
  // ROC plot cannot be read — "better than chance" is the entire question.
  const rows = curve.points.map((p) => [p.fpr, p.tpr, p.fpr]);
  const label = curve.positive_label ? ` (positive: ${curve.positive_label})` : "";
  return (
    <div data-testid="roc-curve">
      <EChartsChart
        kind="line"
        chartType="roc_curve_line"
        columns={["fpr", "tpr", "chance"]}
        rows={rows}
        title={title}
        desc={
          typeof auc === "number"
            ? `${t("charts.run.aucLabel")} ${auc.toFixed(3)}${label}`
            : undefined
        }
        fallback={
          <p className="py-6 text-center text-xs text-muted-foreground" role="status">
            {typeof auc === "number" ? `${t("charts.run.aucLabel")} ${auc.toFixed(3)}` : ""}
          </p>
        }
      />
      {typeof auc === "number" && (
        <p className="text-center text-xs text-muted-foreground">
          {t("charts.run.aucLabel")} <span className="font-mono">{auc.toFixed(3)}</span>
          {label}
        </p>
      )}
    </div>
  );
}

/** Blue scale by share of the row — the standard confusion-matrix reading. */
function cellStyle(value: number, rowTotal: number): React.CSSProperties {
  const share = rowTotal > 0 ? value / rowTotal : 0;
  return {
    backgroundColor: `hsl(211 90% ${92 - share * 46}%)`,
    color: share > 0.55 ? "white" : undefined,
  };
}

export function ConfusionMatrixChart({
  data,
  title,
}: {
  data: ConfusionMatrix;
  title?: string;
}) {
  const { labels, matrix } = data;
  return (
    <div className="overflow-x-auto" data-testid="confusion-matrix">
      <table className="text-xs" aria-label={title ?? "Confusion matrix"}>
        <caption className="sr-only">
          {t("charts.run.confusionCaption", { total: String(data.total ?? "") })}
        </caption>
        <thead>
          <tr>
            <th scope="col" className="px-2 py-1 text-right font-normal text-muted-foreground">
              {t("charts.run.actualVsPredicted")}
            </th>
            {labels.map((l) => (
              <th key={l} scope="col" className="px-2 py-1 font-medium">
                {l}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {matrix.map((row, i) => {
            const rowTotal = row.reduce((a, b) => a + b, 0);
            return (
              <tr key={labels[i] ?? i}>
                <th scope="row" className="px-2 py-1 text-right font-medium">
                  {labels[i]}
                </th>
                {row.map((v, j) => (
                  <td
                    key={j}
                    className="px-3 py-1 text-center font-mono tabular-nums"
                    style={cellStyle(v, rowTotal)}
                    // The diagonal is correct predictions; everything else is an
                    // error, and which KIND of error matters (a false negative on
                    // a fraud model is not the same as a false positive).
                    title={`${labels[i]} → ${labels[j]}: ${v}`}
                  >
                    {v}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
      {data.labels_available === false && (
        <p className="mt-1 text-[11px] text-muted-foreground" role="note">
          {t("charts.run.labelsUnavailable")}
        </p>
      )}
    </div>
  );
}

export function RunChart({
  chartType,
  artifact,
  title,
}: {
  chartType?: string | null;
  artifact?: unknown;
  title?: string;
}) {
  const cm = confusionMatrix(artifact);
  const type = (chartType ?? "").toLowerCase();

  if (type === "confusion_matrix") {
    if (cm) return <ConfusionMatrixChart data={cm} title={title} />;
    return (
      <div role="status" className="py-6 text-center text-xs text-muted-foreground">
        <p>{t("charts.run.noConfusionMatrix")}</p>
      </div>
    );
  }

  const auc = (artifact as { roc_auc?: number } | undefined)?.roc_auc;
  if (type === "roc_curve") {
    const curve = rocCurve(artifact);
    if (curve) {
      return <RocCurveChart curve={curve} auc={auc} title={title} />;
    }
    return (
      <div role="status" className="flex flex-col items-center justify-center gap-1 py-6 text-center">
        {typeof auc === "number" ? (
          <>
            <p className="font-mono text-2xl">{auc.toFixed(3)}</p>
            <p className="text-xs text-muted-foreground">{t("charts.run.aucLabel")}</p>
          </>
        ) : null}
        <p className="text-[11px] text-muted-foreground">{t("charts.run.curvePending")}</p>
      </div>
    );
  }

  const graph = treeGraph(artifact);
  if (graph) {
    // Reuse the tree renderer BRD 72 inc2 built for `tree_chart` — a decision
    // tree IS a tree, and a second tree renderer would be a second thing to fix.
    return (
      <EChartsChart
        kind="tree"
        chartType="decision_tree"
        columns={[]}
        rows={[]}
        graph={graph}
        title={title}
        // NOT the "unavailable" message: we HAVE the tree here, and jsdom/SSR
        // hit this path. Claiming it is missing while holding it is exactly the
        // kind of confident-wrong output this BRD exists to remove.
        fallback={<TreeOutline node={treeRoot(artifact)!} />}
      />
    );
  }
  return (
    <div role="status" className="py-6 text-center text-xs text-muted-foreground">
      <p>{t("charts.run.treePending")}</p>
    </div>
  );
}
