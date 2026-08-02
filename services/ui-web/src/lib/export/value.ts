/**
 * ROI / value report CSV export (BRD 69). The value report on /admin/value
 * shows governed decisions, hours saved and cost-per-decision for a period, and
 * every DERIVED figure discloses the assumption behind it. This flattens that
 * summary into a file for the Reports hub's inline download, preserving the same
 * honesty: a figure that needs an assumption the tenant hasn't set exports the
 * literal "not available" (with what's needed), never a fabricated 0.
 *
 * Built from the ValueSummary the hub already fetches — no re-derivation.
 */
import type { ValueSummary, EstimatedValue } from "@/lib/graphql/types";

import { buildCsv } from "./csv";

export const VALUE_CSV_HEADER = ["Metric", "Value", "Basis / assumption"];

/** What an unset assumption exports — never a fabricated number. */
const NOT_AVAILABLE = "not available";
const NEEDS_ASSUMPTION = "needs a minutes-per-decision + loaded-rate assumption";

function money(n: number): string {
  return (Number.isFinite(n) ? n : 0).toFixed(2);
}

/** An estimate → [value, basis]. Null/undefined (assumption unset) is honest,
 * not zero. */
function est(e: EstimatedValue | null | undefined): [string, string] {
  if (!e) return [NOT_AVAILABLE, NEEDS_ASSUMPTION];
  return [money(e.value), `assumption v${e.assumptionVersion}`];
}

/**
 * Build the ROI/value CSV for a period from the summary in hand. Governed
 * decisions and AI cost are always honest (measured, not estimated); the rest
 * disclose their assumption or report unavailability.
 */
export function buildValueReportCsv(summary: ValueSummary, period: string): string {
  const rows: [string, string, string][] = [];

  rows.push(["Governed decisions", String(summary.decisions?.total ?? 0), "measured"]);
  rows.push(["AI cost (USD)", money(summary.aiCostUsd), "measured"]);

  if (summary.costPerDecision) {
    rows.push(["Cost per decision (USD)", money(summary.costPerDecision.value), summary.costPerDecision.basis]);
  } else {
    rows.push(["Cost per decision (USD)", NOT_AVAILABLE, "no priced decisions this period"]);
  }

  const [hs, hsB] = est(summary.hoursSavedEst);
  rows.push(["Hours saved (est)", hs, hsB]);
  const [lv, lvB] = est(summary.laborValueEstUsd);
  rows.push(["Labor value (est USD)", lv, lvB]);
  const [hb, hbB] = est(summary.humanBaselineCostUsd);
  rows.push(["Human baseline cost (est USD)", hb, hbB]);
  const [nv, nvB] = est(summary.netValueEstUsd);
  rows.push(["Net value (est USD)", nv, nvB]);

  rows.push([
    "Ladder savings (USD)",
    summary.ladderSavingsUsd != null ? money(summary.ladderSavingsUsd) : NOT_AVAILABLE,
    summary.ladderSavingsUsd != null ? "measured" : "no distilled-rung traffic",
  ]);

  return buildCsv({
    leadingComments: [
      `Datacern ROI / value report — period ${period}`,
      "Measured figures are exact; estimated figures disclose their assumption version. 'not available' = the assumption isn't set (no default is assumed for you).",
    ],
    header: VALUE_CSV_HEADER,
    rows,
  });
}

/** Period-stamped filename for a value report export. */
export function valueReportFilename(period: string): string {
  return `value-report-${period}.csv`;
}
