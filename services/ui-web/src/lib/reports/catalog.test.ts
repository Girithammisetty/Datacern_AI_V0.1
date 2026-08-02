import { describe, expect, it } from "vitest";

import { reportsByDomain, REPORT_DOMAINS, type ReportDefinition } from "./catalog";

function report(over: Partial<ReportDefinition> = {}): ReportDefinition {
  return {
    id: "r", title: "R", description: "d", domain: "operations",
    formats: ["csv"], cadence: "on_demand", href: "/x", schedulable: false, note: null,
    ...over,
  };
}

describe("reportsByDomain", () => {
  it("groups in REPORT_DOMAINS order and drops empty domains", () => {
    const groups = reportsByDomain([
      report({ id: "a", domain: "operations" }),
      report({ id: "b", domain: "financial" }),
    ]);
    // financial before operations (REPORT_DOMAINS key order); governance dropped (empty).
    expect(groups.map((g) => g.domain)).toEqual(["financial", "operations"]);
    expect(groups[0].reports.map((r) => r.id)).toEqual(["b"]);
  });

  it("preserves the canonical domain order across all three", () => {
    const groups = reportsByDomain([
      report({ id: "op", domain: "operations" }),
      report({ id: "gov", domain: "governance" }),
      report({ id: "fin", domain: "financial" }),
    ]);
    expect(groups.map((g) => g.domain)).toEqual(["financial", "governance", "operations"]);
  });

  it("returns nothing for an empty catalog", () => {
    expect(reportsByDomain([])).toHaveLength(0);
  });

  it("every domain key has a label + blurb for the header", () => {
    for (const key of Object.keys(REPORT_DOMAINS) as (keyof typeof REPORT_DOMAINS)[]) {
      expect(REPORT_DOMAINS[key].label).toBeTruthy();
      expect(REPORT_DOMAINS[key].blurb).toBeTruthy();
    }
  });
});
