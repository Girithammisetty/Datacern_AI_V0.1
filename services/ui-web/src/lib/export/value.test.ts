import { describe, expect, it } from "vitest";

import { buildValueReportCsv, valueReportFilename, VALUE_CSV_HEADER } from "./value";
import type { ValueSummary } from "@/lib/graphql/types";

function summary(over: Partial<ValueSummary> = {}): ValueSummary {
  return {
    period: "2026-07",
    workspaceId: null,
    decisions: { total: 842, byDecision: {}, byKind: {}, byAgent: {}, byPack: {} },
    hoursSavedEst: { value: 120, assumptionVersion: 3 },
    laborValueEstUsd: { value: 9000, assumptionVersion: 3 },
    aiCostUsd: 1234.56,
    costPerDecision: { value: 1.47, basis: "blended" },
    humanBaselineCostUsd: { value: 15000, assumptionVersion: 3 },
    netValueEstUsd: { value: 7765.44, assumptionVersion: 3 },
    ladderSavingsUsd: 42,
    adoption: {} as ValueSummary["adoption"],
    provenance: {} as ValueSummary["provenance"],
    ...over,
  };
}

function rows(csv: string): string[] {
  return csv.trimEnd().split("\r\n");
}

describe("buildValueReportCsv", () => {
  it("emits measured + estimated metrics with the header and disclosure comments", () => {
    const r = rows(buildValueReportCsv(summary(), "2026-07"));
    expect(r[0]).toContain("# Datacern ROI / value report — period 2026-07");
    expect(r).toContain(VALUE_CSV_HEADER.join(","));
    expect(r).toContain("Governed decisions,842,measured");
    expect(r).toContain("AI cost (USD),1234.56,measured");
    expect(r).toContain("Cost per decision (USD),1.47,blended");
    expect(r).toContain("Hours saved (est),120.00,assumption v3");
    expect(r).toContain("Net value (est USD),7765.44,assumption v3");
    expect(r).toContain("Ladder savings (USD),42.00,measured");
  });

  it("exports 'not available' (not 0) for estimates whose assumption is unset", () => {
    const csv = buildValueReportCsv(
      summary({ hoursSavedEst: null, laborValueEstUsd: null, netValueEstUsd: null, humanBaselineCostUsd: null }),
      "2026-07",
    );
    expect(csv).toContain("Hours saved (est),not available,needs a minutes-per-decision + loaded-rate assumption");
    expect(csv).toContain("Net value (est USD),not available,");
    // Measured figures are still exact even when estimates are unavailable.
    expect(csv).toContain("Governed decisions,842,measured");
  });

  it("handles no priced decisions + no distilled traffic honestly", () => {
    const csv = buildValueReportCsv(summary({ costPerDecision: null, ladderSavingsUsd: null }), "2026-07");
    expect(csv).toContain("Cost per decision (USD),not available,no priced decisions this period");
    expect(csv).toContain("Ladder savings (USD),not available,no distilled-rung traffic");
  });

  it("filename is period-stamped", () => {
    expect(valueReportFilename("2026-07")).toBe("value-report-2026-07.csv");
  });
});
