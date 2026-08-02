import { describe, expect, it } from "vitest";

import { buildBillingPeriodsCsv, billingPeriodsFilename, BILLING_PERIODS_CSV_HEADER } from "./billingPeriods";
import type { BillingPeriod } from "@/lib/graphql/types";

function period(over: Partial<BillingPeriod> = {}): BillingPeriod {
  return {
    id: "bp-1",
    urn: "urn:datacern:usage:billing-period:bp-1",
    period: "2026-06",
    version: 1,
    rateCardId: "rc-1",
    rateCardVersion: 3,
    grossUsd: 1200.5,
    netBillableUsd: 1150.25,
    status: "exported",
    closedAt: "2026-07-01T00:00:00Z",
    closedBy: "u-close",
    export: {
      csvKey: "s3://bill/2026-06.csv",
      csvSha256: "bb",
      jsonlKey: "s3://bill/2026-06.jsonl",
      jsonlSha256: "aa",
      pushedStatus: "pushed",
      pushedReference: "in_123",
      pushedAt: "2026-07-01T01:00:00Z",
      createdAt: "2026-07-01T00:30:00Z",
    },
    ...over,
  };
}

function rows(csv: string): string[] {
  return csv.trimEnd().split("\r\n");
}

describe("buildBillingPeriodsCsv", () => {
  it("emits measured totals with header, disclosure comments and verbatim push status", () => {
    const r = rows(buildBillingPeriodsCsv([period()]));
    expect(r[0]).toContain("# Datacern billing periods");
    expect(r).toContain(BILLING_PERIODS_CSV_HEADER.join(","));
    expect(r).toContain("2026-06,1,exported,1200.50,1150.25,rc-1 v3,2026-07-01T00:00:00Z,u-close,pushed,in_123");
  });

  it("exports 'not exported' (not a blank success) for a closed period with no export yet", () => {
    const csv = buildBillingPeriodsCsv([
      period({ id: "bp-2", period: "2026-05", status: "closed", rateCardId: null, closedBy: null, export: null, grossUsd: 0, netBillableUsd: 0 }),
    ]);
    // Empty rate card -> blank cell; no export -> "not exported"; measured 0 stays 0.00.
    expect(csv).toContain("2026-05,1,closed,0.00,0.00,,2026-07-01T00:00:00Z,,not exported,");
  });

  it("preserves newest-first row order from the query", () => {
    const csv = buildBillingPeriodsCsv([period({ period: "2026-06" }), period({ id: "bp-2", period: "2026-05" })]);
    const body = rows(csv).filter((l) => l.startsWith("2026-"));
    expect(body[0].startsWith("2026-06")).toBe(true);
    expect(body[1].startsWith("2026-05")).toBe(true);
  });

  it("filename is period-scoped only when a single period is requested", () => {
    expect(billingPeriodsFilename()).toBe("billing-periods.csv");
    expect(billingPeriodsFilename("2026-06")).toBe("billing-periods-2026-06.csv");
  });
});
