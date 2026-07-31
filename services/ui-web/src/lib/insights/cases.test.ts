/**
 * The insight thresholds, pinned.
 *
 * This surface tells a user what to worry about, so a wrong count is worse
 * than no count: it either invents urgency or hides real work. Every test here
 * exists because getting it wrong is plausible — a CLOSED case that is
 * technically past its due date, a missing due date read as epoch, a boundary
 * exactly on the threshold.
 */
import { describe, it, expect } from "vitest";
import { computeCaseInsights, filterByInsight, insightBySlug, INSIGHT_DEFS } from "./cases";
import type { Case } from "@/lib/graphql/types";

const NOW = Date.parse("2026-07-31T12:00:00Z");
const HOUR = 3600_000;
const DAY = 24 * HOUR;

function mkCase(over: Partial<Case> = {}): Case {
  return {
    id: `c-${Math.random().toString(36).slice(2, 8)}`,
    urn: "wr:t:case:case/x",
    status: "IN_PROGRESS",
    createdAt: new Date(NOW - DAY).toISOString(),
    ...over,
  } as Case;
}

const by = (out: ReturnType<typeof computeCaseInsights>, key: string) =>
  out.find((i) => i.key === key);

describe("computeCaseInsights", () => {
  it("returns nothing when there is nothing to worry about", () => {
    const healthy = [
      mkCase({ dueDate: new Date(NOW + 5 * DAY).toISOString() }),
      mkCase({ dueDate: new Date(NOW + 9 * DAY).toISOString() }),
    ];
    // An empty result is a REAL answer the UI renders as "nothing needs
    // attention" — never zero-count filler rows.
    expect(computeCaseInsights(healthy, NOW)).toEqual([]);
  });

  it("counts overdue cases and states the rule that produced the count", () => {
    const out = computeCaseInsights(
      [
        mkCase({ dueDate: new Date(NOW - HOUR).toISOString() }),
        mkCase({ dueDate: new Date(NOW - 3 * DAY).toISOString() }),
        mkCase({ dueDate: new Date(NOW + DAY).toISOString() }),
      ],
      NOW,
    );
    const overdue = by(out, "cases.overdue");
    expect(overdue?.count).toBe(2);
    expect(overdue?.level).toBe("critical");
    // the user must be able to disagree with the basis, not just the number
    expect(overdue?.rule).toMatch(/due date has passed/);
  });

  it("does NOT treat resolved or closed work as overdue", () => {
    // The single most damaging false positive: a finished case whose due date
    // happens to be in the past is not a problem, and surfacing it teaches
    // users to ignore the whole card.
    const done = [
      mkCase({ status: "RESOLVED", dueDate: new Date(NOW - 5 * DAY).toISOString() }),
      mkCase({ status: "CLOSED", dueDate: new Date(NOW - 9 * DAY).toISOString() }),
    ];
    expect(computeCaseInsights(done, NOW)).toEqual([]);
  });

  it("treats a missing or malformed due date as 'not overdue', never as epoch", () => {
    // Date.parse(undefined) is NaN and Number(undefined)||0 would be 1970 —
    // either mistake marks every dateless case overdue.
    const out = computeCaseInsights(
      [
        mkCase({ dueDate: null }),
        mkCase({ dueDate: undefined }),
        mkCase({ dueDate: "not-a-date" }),
      ],
      NOW,
    );
    expect(by(out, "cases.overdue")).toBeUndefined();
    expect(by(out, "cases.dueSoon")).toBeUndefined();
  });

  it("separates due-soon from overdue at the boundary", () => {
    const out = computeCaseInsights(
      [
        mkCase({ dueDate: new Date(NOW).toISOString() }),            // exactly now → due soon
        mkCase({ dueDate: new Date(NOW + 23 * HOUR).toISOString() }), // inside window
        mkCase({ dueDate: new Date(NOW + 25 * HOUR).toISOString() }), // outside window
        mkCase({ dueDate: new Date(NOW - 1).toISOString() }),         // 1ms past → overdue
      ],
      NOW,
    );
    expect(by(out, "cases.dueSoon")?.count).toBe(2);
    expect(by(out, "cases.overdue")?.count).toBe(1);
  });

  it("flags unassigned work and long-stalled work", () => {
    const out = computeCaseInsights(
      [
        mkCase({ status: "UNASSIGNED" }),
        mkCase({ status: "UNASSIGNED" }),
        mkCase({ createdAt: new Date(NOW - 20 * DAY).toISOString() }),
        mkCase({ createdAt: new Date(NOW - 13 * DAY).toISOString() }), // under the 14d line
      ],
      NOW,
    );
    expect(by(out, "cases.unassigned")?.count).toBe(2);
    expect(by(out, "cases.stalled")?.count).toBe(1);
  });

  it("flags routing churn from reassignCount", () => {
    const out = computeCaseInsights(
      [
        mkCase({ reassignCount: 3 }),
        mkCase({ reassignCount: 7 }),
        mkCase({ reassignCount: 2 }),   // under the line
        mkCase({ reassignCount: undefined }),
      ],
      NOW,
    );
    const churn = by(out, "cases.churn");
    expect(churn?.count).toBe(2);
    expect(churn?.rule).toMatch(/routing rules/);
  });

  it("orders by urgency first, then by size", () => {
    const out = computeCaseInsights(
      [
        mkCase({ status: "UNASSIGNED" }),
        mkCase({ status: "UNASSIGNED" }),
        mkCase({ status: "UNASSIGNED" }),
        mkCase({ dueDate: new Date(NOW - HOUR).toISOString() }),
        mkCase({ createdAt: new Date(NOW - 30 * DAY).toISOString() }),
      ],
      NOW,
    );
    // 1 critical outranks 3 warnings; info comes last regardless of count.
    expect(out.map((i) => i.key)).toEqual([
      "cases.overdue",
      "cases.unassigned",
      "cases.stalled",
    ]);
  });

  it("uses singular wording for a count of one", () => {
    const out = computeCaseInsights([mkCase({ status: "UNASSIGNED" })], NOW);
    expect(by(out, "cases.unassigned")?.label).toBe("case has no owner");
  });

  // ---- slice 2: ranking + the deep link that proves the number -------------

  it("ranks by severity within a level, not by raw count", () => {
    // 1 CRITICAL overdue must outrank 4 LOW overdue-adjacent warnings, and
    // within warnings the one carrying severe cases comes first. Sorting by
    // count alone buries the cases that actually matter.
    const out = computeCaseInsights(
      [
        mkCase({ status: "UNASSIGNED", severity: "LOW" }),
        mkCase({ status: "UNASSIGNED", severity: "LOW" }),
        mkCase({ status: "UNASSIGNED", severity: "LOW" }),
        mkCase({ severity: "CRITICAL", dueDate: new Date(NOW + 2 * HOUR).toISOString() }),
      ],
      NOW,
    );
    expect(out.map((i) => i.key)).toEqual(["cases.dueSoon", "cases.unassigned"]);
    expect(by(out, "cases.dueSoon")?.severeCount).toBe(1);
    expect(by(out, "cases.unassigned")?.severeCount).toBe(0);
  });

  it("counts HIGH and CRITICAL as severe, nothing else", () => {
    const out = computeCaseInsights(
      [
        mkCase({ status: "UNASSIGNED", severity: "CRITICAL" }),
        mkCase({ status: "UNASSIGNED", severity: "HIGH" }),
        mkCase({ status: "UNASSIGNED", severity: "MEDIUM" }),
        mkCase({ status: "UNASSIGNED", severity: null }),
      ],
      NOW,
    );
    const u = by(out, "cases.unassigned");
    expect(u?.count).toBe(4);
    expect(u?.severeCount).toBe(2);
  });

  it("every insight's href resolves back to its own definition", () => {
    // A link whose slug nothing recognises would silently show the unfiltered
    // list — the number would then link to 'evidence' that is not evidence.
    for (const def of INSIGHT_DEFS) {
      expect(insightBySlug(def.slug)).toBe(def);
    }
    const out = computeCaseInsights([mkCase({ status: "UNASSIGNED" })], NOW);
    for (const i of out) {
      expect(i.href).toBe(`/cases?insight=${i.slug}`);
      expect(insightBySlug(i.slug)).toBeDefined();
    }
  });

  it("filterByInsight returns EXACTLY the cases the count counted", () => {
    // The whole point of slice 2: one predicate, so the list and the number
    // cannot disagree.
    const cases = [
      mkCase({ dueDate: new Date(NOW - HOUR).toISOString() }),
      mkCase({ dueDate: new Date(NOW - 3 * DAY).toISOString() }),
      mkCase({ dueDate: new Date(NOW + DAY).toISOString() }),
      mkCase({ status: "CLOSED", dueDate: new Date(NOW - 9 * DAY).toISOString() }),
    ];
    const out = computeCaseInsights(cases, NOW);
    for (const i of out) {
      expect(filterByInsight(cases, i.slug, NOW)).toHaveLength(i.count);
    }
  });

  it("an unknown slug narrows nothing rather than hiding everything", () => {
    // A stale bookmark or hand-edited URL must degrade to the full list, not
    // to an empty page that reads as "you have no work".
    const cases = [mkCase({ status: "UNASSIGNED" }), mkCase()];
    expect(insightBySlug("not-a-real-insight")).toBeUndefined();
    expect(filterByInsight(cases, "not-a-real-insight", NOW)).toHaveLength(2);
  });
});