import { describe, it, expect } from "vitest";
import {
  detectTimeColumnIndex,
  filterChartDataByTimeRange,
  parseTimestamp,
  presetToRange,
  ALL_TIME,
} from "./timeRange";

describe("parseTimestamp", () => {
  it("parses ISO date/datetime strings", () => {
    expect(parseTimestamp("2026-01-15")).toBe(Date.parse("2026-01-15"));
    expect(parseTimestamp("2026-01-15T10:00:00Z")).toBe(Date.parse("2026-01-15T10:00:00Z"));
  });
  it("rejects bare numbers and non-date strings (so measures are not mistaken for time)", () => {
    expect(parseTimestamp(4200)).toBeNull();
    expect(parseTimestamp("West")).toBeNull();
    expect(parseTimestamp("42")).toBeNull();
  });
});

describe("detectTimeColumnIndex", () => {
  it("finds the date-like column", () => {
    const columns = ["day", "revenue"];
    const rows = [
      ["2026-01-01", 100],
      ["2026-01-02", 120],
    ];
    expect(detectTimeColumnIndex(columns, rows)).toBe(0);
  });
  it("returns -1 when there is no time dimension", () => {
    expect(detectTimeColumnIndex(["region", "revenue"], [["West", 100], ["East", 90]])).toBe(-1);
  });
});

describe("filterChartDataByTimeRange", () => {
  const columns = ["day", "revenue"];
  const rows = [
    ["2026-01-01", 100],
    ["2026-01-10", 120],
    ["2026-02-01", 140],
  ];

  it("is a no-op for all-time", () => {
    const out = filterChartDataByTimeRange(columns, rows, ALL_TIME);
    expect(out.rows).toBe(rows);
    expect(out.applicable).toBe(true);
    expect(out.shown).toBe(3);
  });

  it("keeps only points inside a bounded range", () => {
    const range = {
      preset: "custom" as const,
      from: Date.parse("2026-01-05"),
      to: Date.parse("2026-01-31"),
    };
    const out = filterChartDataByTimeRange(columns, rows, range);
    expect(out.shown).toBe(1);
    expect(out.total).toBe(3);
    expect((out.rows as unknown[][])[0][0]).toBe("2026-01-10");
  });

  it("reports not-applicable and passes data through when there is no time column", () => {
    const noTimeCols = ["region", "revenue"];
    const noTimeRows = [["West", 1], ["East", 2]];
    const range = { preset: "custom" as const, from: 0, to: 1 };
    const out = filterChartDataByTimeRange(noTimeCols, noTimeRows, range);
    expect(out.applicable).toBe(false);
    expect(out.rows).toBe(noTimeRows);
    expect(out.shown).toBe(2);
  });
});

describe("presetToRange", () => {
  it("resolves a preset to bounds ending at now", () => {
    const now = Date.parse("2026-08-05T00:00:00Z");
    const r = presetToRange("7d", now);
    expect(r.to).toBe(now);
    expect(r.from).toBe(now - 7 * 24 * 60 * 60 * 1000);
  });
  it("all-time has no bounds", () => {
    expect(presetToRange("all")).toEqual(ALL_TIME);
  });
});
