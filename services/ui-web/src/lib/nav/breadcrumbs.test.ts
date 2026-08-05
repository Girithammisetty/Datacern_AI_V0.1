import { describe, it, expect } from "vitest";
import {
  crumbsFor,
  hasTrail,
  backTargetFor,
  humanizeSegment,
  truncateId,
  isDynamicSegment,
  looksLikeId,
  type Crumb,
} from "./breadcrumbs";

const labels = (crumbs: Crumb[]) => crumbs.map((c) => c.label);
const hrefs = (crumbs: Crumb[]) => crumbs.map((c) => c.href);
const CASE_UUID = "3f9a1c22-1111-2222-3333-444455556666";

describe("humanizeSegment", () => {
  it("title-cases a plain segment", () => {
    expect(humanizeSegment("runs")).toBe("Runs");
  });

  it("turns dashes into spaces without shouting the rest", () => {
    expect(humanizeSegment("semantic-models")).toBe("Semantic models");
    expect(humanizeSegment("service_accounts")).toBe("Service accounts");
  });
});

describe("truncateId", () => {
  it("leaves short ids alone", () => {
    expect(truncateId("e-99")).toBe("e-99");
    expect(truncateId("abc123")).toBe("abc123");
  });

  it("never shows a full uuid", () => {
    expect(truncateId(CASE_UUID)).toBe("3f9a1c22…");
    expect(truncateId(CASE_UUID)).not.toContain(CASE_UUID);
  });
});

describe("isDynamicSegment / looksLikeId", () => {
  it("recognizes the app's static route segments", () => {
    for (const segment of ["runs", "eval", "semantic-models", "events", "ai-gateway"]) {
      expect(isDynamicSegment(segment)).toBe(false);
      expect(looksLikeId(segment)).toBe(false);
    }
  });

  it("treats unknown final segments as record ids", () => {
    expect(isDynamicSegment(CASE_UUID)).toBe(true);
    expect(looksLikeId(CASE_UUID)).toBe(true);
    expect(looksLikeId("e-99")).toBe(true);
  });
});

describe("crumbsFor", () => {
  it("renders no trail at all on the home route", () => {
    expect(crumbsFor("/")).toEqual([]);
    expect(crumbsFor("")).toEqual([]);
    expect(hasTrail(crumbsFor("/"))).toBe(false);
  });

  it("resolves a deep route: /ml/eval/runs/{id}", () => {
    const crumbs = crumbsFor("/ml/eval/runs/abc123");
    expect(labels(crumbs)).toEqual(["Home", "Machine Learning", "ML", "Eval", "Runs", "abc123"]);
    expect(hrefs(crumbs)).toEqual(["/", undefined, "/ml", "/ml/eval", "/ml/eval/runs", undefined]);
    expect(hasTrail(crumbs)).toBe(true);
  });

  it("resolves a 2-level route under a nav item: /data/pipelines/runs", () => {
    const crumbs = crumbsFor("/data/pipelines/runs");
    // Pipelines lives under /data but belongs to the sidebar's ML section, so
    // the trail says exactly what the sidebar says.
    expect(labels(crumbs)).toEqual([
      "Home",
      "Data",
      "Datasets",
      "Machine Learning",
      "Pipelines",
      "Runs",
    ]);
    // The last crumb is the current page: plain text, never a link.
    expect(crumbs[crumbs.length - 1]).toMatchObject({ label: "Runs", current: true });
    expect(crumbs[crumbs.length - 1].href).toBeUndefined();
    expect(hasTrail(crumbs)).toBe(true);
  });

  it("uses the sidebar wording for a route that is itself a nav item", () => {
    const crumbs = crumbsFor("/dashboards");
    expect(labels(crumbs)).toEqual(["Home", "Insights", "Dashboards"]);
    // Top-level destination: Home is the only link, so nothing renders.
    expect(hasTrail(crumbs)).toBe(false);
  });

  it("keeps a nested nav item under its own parent page", () => {
    // /data/semantic-models is a nav item, but /data is a real page above it —
    // so the trail links it rather than jumping straight from Home.
    const crumbs = crumbsFor("/data/semantic-models");
    expect(labels(crumbs)).toEqual(["Home", "Data", "Datasets", "Semantic Models"]);
    expect(hrefs(crumbs)).toEqual(["/", undefined, "/data", undefined]);
    expect(hasTrail(crumbs)).toBe(true);
  });

  it("inserts a non-link group crumb before the first item of a section", () => {
    const crumbs = crumbsFor("/cases");
    expect(labels(crumbs)).toEqual(["Home", "Casework", "Cases"]);
    const group = crumbs[1];
    expect(group.href).toBeUndefined();
    expect(group.key).toBe("group:casework");
    expect(hasTrail(crumbs)).toBe(false);
  });

  it("emits a section's group crumb only once", () => {
    const crumbs = crumbsFor("/ml/eval/trends");
    expect(labels(crumbs).filter((l) => l === "Machine Learning")).toHaveLength(1);
  });

  it("renders an unmatched intermediate segment as text, not a dead link", () => {
    // /ml/experiments has no page of its own (only [id] and new), so it must
    // never be linked.
    const crumbs = crumbsFor("/ml/experiments/new");
    expect(labels(crumbs)).toEqual(["Home", "Machine Learning", "ML", "Experiments", "New"]);
    const experiments = crumbs.find((c) => c.label === "Experiments");
    expect(experiments?.href).toBeUndefined();
  });

  it("links an unmatched intermediate that is a known listing route", () => {
    const crumbs = crumbsFor("/admin/audit/events/e-99");
    expect(labels(crumbs)).toEqual(["Home", "Admin", "Audit", "Events", "e-99"]);
    expect(crumbs.find((c) => c.label === "Audit")?.href).toBe("/admin/audit");
    // …but /admin/audit/events has no page, so it stays plain text.
    expect(crumbs.find((c) => c.label === "Events")?.href).toBeUndefined();
  });

  it("prefers the page's human label over the raw id on a detail route", () => {
    const crumbs = crumbsFor(`/cases/${CASE_UUID}`, { currentLabel: "Duplicate invoice — ACME" });
    expect(labels(crumbs)).toEqual(["Home", "Casework", "Cases", "Duplicate invoice — ACME"]);
    expect(labels(crumbs).join(" ")).not.toContain(CASE_UUID);
  });

  it("falls back to a truncated id, never the raw uuid", () => {
    const crumbs = crumbsFor(`/cases/${CASE_UUID}`);
    expect(crumbs[crumbs.length - 1].label).toBe("3f9a1c22…");
  });

  it("ignores a trailing slash and any query string", () => {
    expect(labels(crumbsFor("/ml/eval/runs/"))).toEqual(labels(crumbsFor("/ml/eval/runs")));
    expect(labels(crumbsFor("/ml/eval/runs?status=failed"))).toEqual(labels(crumbsFor("/ml/eval/runs")));
  });

  it("carries the nav item's gate on ancestor links so the renderer can gate them", () => {
    const crumbs = crumbsFor("/ml/eval/runs/abc123");
    expect(crumbs.find((c) => c.href === "/ml/eval")?.gate).toEqual({
      kind: "capability",
      action: "eval.run.read",
    });
    // Non-nav listing crumbs borrow the route guard's gate.
    expect(crumbs.find((c) => c.href === "/ml/eval/runs")?.gate).toEqual({
      kind: "capability",
      action: "eval.run.read",
    });
  });
});

describe("backTargetFor", () => {
  it("points a record page at its nearest linkable ancestor", () => {
    const path = "/ml/eval/runs/abc123";
    expect(backTargetFor(path, crumbsFor(path))).toMatchObject({
      label: "Runs",
      href: "/ml/eval/runs",
    });
  });

  it("skips the current crumb and any dead intermediate", () => {
    const path = "/admin/audit/events/e-99";
    expect(backTargetFor(path, crumbsFor(path))).toMatchObject({
      label: "Audit",
      href: "/admin/audit",
    });
  });

  it("returns nothing for a static listing route", () => {
    const path = "/data/pipelines/runs";
    expect(backTargetFor(path, crumbsFor(path))).toBeUndefined();
  });

  it("returns nothing when the only ancestor is Home", () => {
    const path = "/cases";
    expect(backTargetFor(path, crumbsFor(path))).toBeUndefined();
  });
});
