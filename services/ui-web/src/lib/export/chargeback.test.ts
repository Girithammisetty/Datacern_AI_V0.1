import { describe, expect, it } from "vitest";

import { buildChargebackCsv, chargebackFilename, CHARGEBACK_CSV_HEADER, UNPRICED_MARKER } from "./chargeback";
import type { ChargebackLine } from "@/lib/graphql/types";

function line(over: Partial<ChargebackLine> = {}): ChargebackLine {
  return {
    tenantId: "t-1",
    workspaceId: "ws-7",
    month: "2026-07",
    meterKey: "governed_decision",
    quantity: 842,
    rateCardId: "rc-1",
    pricePerUnitUsd: 0.08,
    usd: 67.36,
    adjustmentsUsd: 0,
    totalUsd: 67.36,
    ...over,
  } as ChargebackLine;
}

describe("buildChargebackCsv", () => {
  it("writes a header, one row per line, and a trailing TOTAL", () => {
    const csv = buildChargebackCsv([line(), line({ meterKey: "api_calls", quantity: 1000, pricePerUnitUsd: 0.002, usd: 2, totalUsd: 2 })], "2026-07");
    const rows = csv.trimEnd().split("\r\n");
    // 2 comment lines + header + 2 data rows + total
    expect(rows[0]).toContain("# Datacern chargeback — period 2026-07");
    expect(rows).toContain(CHARGEBACK_CSV_HEADER.join(","));
    expect(rows.some((r) => r.startsWith("governed_decision,ws-7,842,0.08,67.36,,67.36"))).toBe(true);
    const total = rows.at(-1)!;
    expect(total.startsWith("TOTAL,")).toBe(true);
    expect(total.endsWith("69.36")).toBe(true); // 67.36 + 2
  });

  it("exports UNPRICED (not $0) when a meter has no rate card", () => {
    const csv = buildChargebackCsv([line({ rateCardId: null, pricePerUnitUsd: 0, usd: 0, totalUsd: 0 })], "2026-07");
    expect(csv).toContain(UNPRICED_MARKER);
    expect(csv).not.toContain(",0.00,0.00,,0.00"); // no fabricated priced-zero row
  });

  it("renders a missing workspace as an empty cell and shows adjustments only when non-zero", () => {
    const csv = buildChargebackCsv([line({ workspaceId: null, adjustmentsUsd: -5, totalUsd: 62.36 })], "2026-07");
    const dataRow = csv.trimEnd().split("\r\n").find((r) => r.startsWith("governed_decision,"))!;
    expect(dataRow).toBe("governed_decision,,842,0.08,67.36,-5.00,62.36");
  });

  it("handles an empty report (header + total only)", () => {
    const csv = buildChargebackCsv([], "2026-07");
    const rows = csv.trimEnd().split("\r\n");
    expect(rows.at(-1)).toBe("TOTAL,,,,,,0.00");
  });
});

describe("chargebackFilename", () => {
  it("is period-stamped", () => {
    expect(chargebackFilename("2026-07")).toBe("chargeback-2026-07.csv");
  });
});
