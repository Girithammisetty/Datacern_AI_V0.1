/**
 * Chargeback report CSV export (BRD 67 billing depth). The Chargeback card on
 * /admin/usage renders priced monthly rollups per meter but had no way to take
 * them off the screen — finance-ops needs the month's showback as a file to
 * reconcile against a billing system or attach to an internal cost review.
 *
 * Built entirely from the ChargebackLine[] the card already holds
 * (useChargebackReport) — no second network round-trip — mirroring
 * lib/export/agentInventory.ts. Columns match the table 1:1 so the file is
 * exactly what the user sees; an unpriced meter (no rate card) exports the
 * literal UNPRICED marker rather than a fabricated $0, per the repo's
 * no-fabrication rule.
 */
import type { ChargebackLine } from "@/lib/graphql/types";

import { buildCsv } from "./csv";

/** A meter with no rate card resolved: price is genuinely absent, not zero. */
export const UNPRICED_MARKER = "UNPRICED";

export const CHARGEBACK_CSV_HEADER = [
  "Meter",
  "Workspace",
  "Quantity",
  "Price per unit (USD)",
  "Usage (USD)",
  "Adjustments (USD)",
  "Total (USD)",
];

function num(n: number): string {
  return Number.isFinite(n) ? String(n) : "0";
}

/** 2dp money string without a currency symbol (CSV cells stay numeric-friendly). */
function money(n: number): string {
  return (Number.isFinite(n) ? n : 0).toFixed(2);
}

/**
 * Build the chargeback CSV for a period from the rows in hand. `period` is the
 * YYYY-MM the report was run for; it becomes a disclosure comment and the total
 * is appended as a trailing summary row so the file stands alone.
 */
export function buildChargebackCsv(rows: ChargebackLine[], period: string): string {
  const body = rows.map((l) => [
    l.meterKey,
    l.workspaceId ?? "",
    num(l.quantity),
    l.rateCardId ? money(l.pricePerUnitUsd) : UNPRICED_MARKER,
    money(l.usd),
    l.adjustmentsUsd !== 0 ? money(l.adjustmentsUsd) : "",
    money(l.totalUsd),
  ]);

  const total = rows.reduce((sum, l) => sum + l.totalUsd, 0);
  // Trailing total row (blank meter/workspace/quantity cells so it reads as a summary).
  body.push(["TOTAL", "", "", "", "", "", money(total)]);

  return buildCsv({
    leadingComments: [
      `Datacern chargeback — period ${period}`,
      "Priced monthly rollups per meter. UNPRICED = no rate card resolved (not $0).",
    ],
    header: CHARGEBACK_CSV_HEADER,
    rows: body,
  });
}

/** Stable download filename for a period's chargeback export. */
export function chargebackFilename(period: string): string {
  return `chargeback-${period}.csv`;
}
