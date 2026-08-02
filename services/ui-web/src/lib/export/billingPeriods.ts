/**
 * Billing-periods CSV export (BRD 67 slice 3, VMB-FR-023). The B2 monthly close
 * job produces closed billing periods — gross and net-billable totals plus the
 * export/push status behind each invoice — but there was no read path to take
 * that finance-close view off the platform. This flattens the BillingPeriod[]
 * the hub fetches into a file for offline reconciliation or audit hand-off.
 *
 * Built entirely from the rows in hand (useBillingPeriods) — no second
 * round-trip. Push status is written verbatim (pushed / not-configured /
 * failed); a period with no export yet exports the literal "not exported"
 * rather than an implied success, per the repo's no-fabrication rule.
 */
import type { BillingPeriod } from "@/lib/graphql/types";

import { buildCsv } from "./csv";

/** A closed period whose artifacts haven't been recorded yet — not a failure,
 * not a success; the honest state is "not exported". */
export const NOT_EXPORTED = "not exported";

export const BILLING_PERIODS_CSV_HEADER = [
  "Period",
  "Version",
  "Status",
  "Gross (USD)",
  "Net billable (USD)",
  "Rate card",
  "Closed at",
  "Closed by",
  "Push status",
  "Push reference",
];

/** 2dp money string without a currency symbol (CSV cells stay numeric-friendly). */
function money(n: number): string {
  return (Number.isFinite(n) ? n : 0).toFixed(2);
}

/**
 * Build the billing-periods CSV from the rows in hand. Newest-first ordering is
 * preserved from the query. Gross and net-billable are exact measured totals;
 * the push columns disclose the real close-job outcome and never assume one.
 */
export function buildBillingPeriodsCsv(rows: BillingPeriod[]): string {
  const body = rows.map((p) => {
    const exp = p.export ?? null;
    return [
      p.period,
      String(p.version),
      p.status,
      money(p.grossUsd),
      money(p.netBillableUsd),
      p.rateCardId ? `${p.rateCardId} v${p.rateCardVersion}` : "",
      p.closedAt,
      p.closedBy ?? "",
      exp?.pushedStatus ?? NOT_EXPORTED,
      exp?.pushedReference ?? "",
    ];
  });

  return buildCsv({
    leadingComments: [
      "Datacern billing periods — closed monthly periods (finance-close view).",
      `Exported ${rows.length} closed period(s). Push status is verbatim from the close job — "${NOT_EXPORTED}" = artifacts not yet recorded, never an implied success.`,
    ],
    header: BILLING_PERIODS_CSV_HEADER,
    rows: body,
  });
}

/** Stable download filename; period-scoped when a single period was requested. */
export function billingPeriodsFilename(period?: string): string {
  return period ? `billing-periods-${period}.csv` : "billing-periods.csv";
}
