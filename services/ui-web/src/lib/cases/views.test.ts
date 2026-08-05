import { describe, it, expect, beforeEach } from "vitest";
import type { Case } from "@/lib/graphql/types";
import {
  BUILTIN_CASE_VIEWS,
  CASE_VIEWS_STORAGE_KEY,
  loadSavedViews,
  persistSavedViews,
  readViewParams,
  slaAtRisk,
  sortCases,
  viewParamsEqual,
  viewParamsToSearch,
} from "./views";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.parse("2026-08-05T12:00:00Z");
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

const mk = (over: Partial<Case>): Case =>
  ({ id: "x", urn: "u", proposals: [], status: "IN_PROGRESS", ...over }) as Case;

describe("view params URL round-trip", () => {
  it("round-trips every field and drops empties", () => {
    const p = readViewParams(new URLSearchParams("q=dup&status=IN_PROGRESS&assignee=me&sort=due&dir=desc&live=1"));
    expect(p).toMatchObject({ q: "dup", status: "IN_PROGRESS", assignee: "me", sort: "due", dir: "desc", live: true });
    expect(p.sla).toBeUndefined();
    const search = viewParamsToSearch(p);
    expect(readViewParams(new URLSearchParams(search))).toEqual(p);
  });

  it("rejects an unknown sort key instead of sorting by nothing", () => {
    const p = readViewParams(new URLSearchParams("sort=updated&dir=desc"));
    expect(p.sort).toBeUndefined();
    expect(p.dir).toBeUndefined();
  });

  it("equality is structural, not insertion-ordered", () => {
    expect(
      viewParamsEqual(
        readViewParams(new URLSearchParams("severity=HIGH&q=a")),
        readViewParams(new URLSearchParams("q=a&severity=HIGH")),
      ),
    ).toBe(true);
    expect(viewParamsEqual({ q: "a" }, { q: "b" })).toBe(false);
  });
});

describe("built-in views", () => {
  it("ships exactly the three promised presets as plain param bundles", () => {
    expect(BUILTIN_CASE_VIEWS.map((v) => v.key)).toEqual(["mine", "sla", "unassigned"]);
    expect(BUILTIN_CASE_VIEWS[0].params).toEqual({ assignee: "me", live: true });
    expect(BUILTIN_CASE_VIEWS[2].params).toEqual({ status: "UNASSIGNED" });
  });
});

describe("slaAtRisk — the insights lib's own predicates, unioned", () => {
  it("matches overdue and due-soon open cases, not healthy or terminal ones", () => {
    expect(slaAtRisk(mk({ dueDate: iso(-DAY) }), NOW)).toBe(true); // overdue
    expect(slaAtRisk(mk({ dueDate: iso(2 * HOUR) }), NOW)).toBe(true); // due soon
    expect(slaAtRisk(mk({ dueDate: iso(3 * DAY) }), NOW)).toBe(false); // healthy
    expect(slaAtRisk(mk({ dueDate: iso(-DAY), status: "CLOSED" }), NOW)).toBe(false); // done
    expect(slaAtRisk(mk({ dueDate: null }), NOW)).toBe(false); // no clock
  });
});

describe("sortCases — client-side over the loaded window", () => {
  const rows = [
    mk({ id: "a", dueDate: iso(2 * DAY), severity: "LOW", status: "RESOLVED" }),
    mk({ id: "b", dueDate: null, severity: "CRITICAL", status: "DRAFT" }),
    mk({ id: "c", dueDate: iso(-DAY), severity: "MEDIUM", status: "IN_PROGRESS" }),
  ];

  it("sorts by due date with absent values last in BOTH directions", () => {
    expect(sortCases(rows, "due", "asc").map((c) => c.id)).toEqual(["c", "a", "b"]);
    expect(sortCases(rows, "due", "desc").map((c) => c.id)).toEqual(["a", "c", "b"]);
  });

  it("sorts severity by rank, not alphabetically", () => {
    expect(sortCases(rows, "severity", "desc").map((c) => c.id)).toEqual(["b", "c", "a"]);
  });

  it("sorts status by lifecycle order and does not mutate the input", () => {
    const before = rows.map((c) => c.id);
    expect(sortCases(rows, "status", "asc").map((c) => c.id)).toEqual(["b", "c", "a"]);
    expect(rows.map((c) => c.id)).toEqual(before);
  });
});

describe("saved-view persistence (datacern.cases.views.v1)", () => {
  beforeEach(() => window.localStorage.removeItem(CASE_VIEWS_STORAGE_KEY));

  it("persists per-user under the versioned key and survives a reload", () => {
    persistSavedViews("u-1", [{ id: "v1", name: "Mine", params: { q: "dup" } }]);
    persistSavedViews("u-2", [{ id: "v2", name: "Theirs", params: { severity: "HIGH" } }]);
    expect(loadSavedViews("u-1")).toEqual([{ id: "v1", name: "Mine", params: { q: "dup" } }]);
    expect(loadSavedViews("u-2").map((v) => v.name)).toEqual(["Theirs"]);
    expect(loadSavedViews("u-3")).toEqual([]);
    expect(window.localStorage.getItem(CASE_VIEWS_STORAGE_KEY)).toContain("u-1");
  });

  it("tolerates corrupted storage instead of crashing the worklist", () => {
    window.localStorage.setItem(CASE_VIEWS_STORAGE_KEY, "{not json");
    expect(loadSavedViews("u-1")).toEqual([]);
  });
});
