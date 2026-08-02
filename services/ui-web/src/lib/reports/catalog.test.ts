import { describe, expect, it } from "vitest";

import type { Gate } from "@/lib/authz/registry";

import {
  REPORT_CATALOG,
  REPORT_DOMAINS,
  visibleReports,
  reportsByDomain,
} from "./catalog";

// A `can` predicate built from an allow-set of capability actions.
function canFrom(actions: string[]): (g: Gate) => boolean {
  const allow = new Set(actions);
  return (g) => g.kind === "capability" && allow.has(g.action);
}

describe("REPORT_CATALOG", () => {
  it("every entry is well-formed and reachable (valid domain, gate, href)", () => {
    expect(REPORT_CATALOG.length).toBeGreaterThan(0);
    const ids = new Set<string>();
    for (const r of REPORT_CATALOG) {
      expect(r.id, `duplicate id ${r.id}`).not.toBe([...ids].find((x) => x === r.id));
      ids.add(r.id);
      expect(REPORT_DOMAINS[r.domain], `unknown domain on ${r.id}`).toBeDefined();
      expect(r.gate.kind).toBe("capability"); // a real capability gate, never ungated
      expect(r.href.startsWith("/"), `${r.id} href must be an in-app route`).toBe(true);
      expect(r.formats.length, `${r.id} has no format`).toBeGreaterThan(0);
      expect(r.title).toBeTruthy();
      expect(r.description).toBeTruthy();
    }
    expect(ids.size).toBe(REPORT_CATALOG.length); // ids unique
  });
});

describe("visibleReports", () => {
  it("hides reports the viewer's capabilities don't reach", () => {
    // Only usage.report.read → just the two financial reports.
    const financialOnly = visibleReports(canFrom(["usage.report.read"]));
    expect(financialOnly.map((r) => r.id).sort()).toEqual(["chargeback", "value-roi"]);
  });

  it("returns nothing for a viewer with no capabilities", () => {
    expect(visibleReports(canFrom([]))).toHaveLength(0);
  });

  it("returns the whole catalog for a fully-capable viewer", () => {
    const all = canFrom(REPORT_CATALOG.map((r) => (r.gate.kind === "capability" ? r.gate.action : "")));
    expect(visibleReports(all)).toHaveLength(REPORT_CATALOG.length);
  });
});

describe("reportsByDomain", () => {
  it("groups in REPORT_DOMAINS order and drops empty domains", () => {
    const groups = reportsByDomain(visibleReports(canFrom(["usage.report.read"])));
    // Only the financial domain has visible reports here.
    expect(groups.map((g) => g.domain)).toEqual(["financial"]);
    expect(groups[0].reports.every((r) => r.domain === "financial")).toBe(true);
  });

  it("preserves the canonical domain order when multiple are present", () => {
    const groups = reportsByDomain(REPORT_CATALOG);
    const order = groups.map((g) => g.domain);
    // financial before governance before operations (REPORT_DOMAINS key order).
    expect(order).toEqual(["financial", "governance", "operations"]);
  });
});
