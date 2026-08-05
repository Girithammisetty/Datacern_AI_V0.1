import { describe, it, expect } from "vitest";
import {
  readCrossFilters,
  readDashboardUrlState,
  readTimeRange,
  serializeTimeRange,
  writeDashboardUrlState,
} from "./urlState";
import type { CrossFilter } from "@/lib/charts/crossfilter";

const NOW = Date.parse("2026-08-05T00:00:00Z");

describe("cross-filter URL round-trip", () => {
  it("round-trips a set of cross-filters through the URL", () => {
    const filters: CrossFilter[] = [
      { origin: "chartA", field: "region", value: "West", op: "eq" },
      { origin: "chartB", field: "carrier", value: "Acme Co", op: "eq" },
    ];
    const params = writeDashboardUrlState(new URLSearchParams(), { filters, range: { preset: "all", from: null, to: null } });
    // Serialize to a string and re-parse — this is what a shared link does.
    const reparsed = new URLSearchParams(params.toString());
    expect(readCrossFilters(reparsed)).toEqual(filters);
  });

  it("survives delimiter/reserved characters in values", () => {
    const filters: CrossFilter[] = [{ origin: "c1", field: "path", value: "a|b&c=d", op: "eq" }];
    const params = writeDashboardUrlState(new URLSearchParams(), { filters, range: { preset: "all", from: null, to: null } });
    const reparsed = new URLSearchParams(params.toString());
    expect(readCrossFilters(reparsed)).toEqual(filters);
  });

  it("preserves unrelated params and replaces cf on rewrite", () => {
    const base = new URLSearchParams("tab=charts&cf=old%7Cx%7Cy");
    const params = writeDashboardUrlState(base, {
      filters: [{ origin: "c1", field: "f", value: "v", op: "eq" }],
      range: { preset: "all", from: null, to: null },
    });
    expect(params.get("tab")).toBe("charts");
    expect(params.getAll("cf")).toHaveLength(1);
    expect(readCrossFilters(params)[0]).toEqual({ origin: "c1", field: "f", value: "v", op: "eq" });
  });
});

describe("time-range URL round-trip", () => {
  it("stores a preset id and re-resolves it against now", () => {
    const range = { preset: "7d" as const, from: NOW - 999, to: NOW };
    expect(serializeTimeRange(range)).toBe("7d");
    const back = readTimeRange(new URLSearchParams("range=7d"), NOW);
    expect(back.preset).toBe("7d");
    expect(back.to).toBe(NOW);
    expect(back.from).toBe(NOW - 7 * 24 * 60 * 60 * 1000);
  });

  it("round-trips explicit custom bounds", () => {
    const from = Date.parse("2026-01-01T00:00:00Z");
    const to = Date.parse("2026-02-01T00:00:00Z");
    const serialized = serializeTimeRange({ preset: "custom", from, to });
    expect(serialized).toMatch(/^custom:/);
    const back = readTimeRange(new URLSearchParams(`range=${serialized}`), NOW);
    expect(back.preset).toBe("custom");
    expect(back.from).toBe(from);
    expect(back.to).toBe(to);
  });

  it("all-time serializes to null (no range param) and reads back as all-time", () => {
    expect(serializeTimeRange({ preset: "all", from: null, to: null })).toBeNull();
    expect(readTimeRange(new URLSearchParams(""), NOW)).toEqual({ preset: "all", from: null, to: null });
  });

  it("ignores an unknown range value rather than throwing", () => {
    expect(readTimeRange(new URLSearchParams("range=bogus"), NOW).preset).toBe("all");
  });
});

describe("readDashboardUrlState", () => {
  it("reads filters and range together", () => {
    const params = new URLSearchParams();
    params.append("cf", "c1|region|West");
    params.set("range", "30d");
    const state = readDashboardUrlState(params, NOW);
    expect(state.filters).toEqual([{ origin: "c1", field: "region", value: "West", op: "eq" }]);
    expect(state.range.preset).toBe("30d");
  });
});
