"use client";
import { toLabel } from "@/lib/charts/geometry";
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
 * * `roc_curve` — the AUC scalar is mirrored; the CURVE POINTS live in the run's
 *   `evaluation.json` artifact, which the mirror does not carry. We show the AUC
 *   and say the curve needs the artifact, rather than drawing an invented curve.
 * * `decision_tree` — same: the tree structure is in `evaluation.json`.
 *
 * When the artifact-blob leg lands (BRD 72 inc3b) both fall through to real
 * renderers with no change to this component's contract.
 */
interface ConfusionMatrix {
  labels: string[];
  matrix: number[][];
  total?: number;
}

function confusionMatrix(artifact: unknown): ConfusionMatrix | null {
  if (!artifact || typeof artifact !== "object") return null;
  const cm = (artifact as { confusion_matrix?: unknown }).confusion_matrix;
  if (!cm || typeof cm !== "object") return null;
  const { labels, matrix } = cm as { labels?: unknown; matrix?: unknown };
  if (!Array.isArray(labels) || !Array.isArray(matrix)) return null;
  const rows = matrix.filter((r): r is number[] => Array.isArray(r));
  if (rows.length !== labels.length) return null; // a mislabelled matrix is worse than none
  return { labels: labels.map(toLabel), matrix: rows, total: (cm as { total?: number }).total };
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

  return (
    <div role="status" className="py-6 text-center text-xs text-muted-foreground">
      <p>{t("charts.run.treePending")}</p>
    </div>
  );
}
