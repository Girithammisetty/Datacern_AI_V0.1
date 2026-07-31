/**
 * Case insights — "what should I care about first?", computed from data the
 * platform already serves (insight-surfacing, slice 1).
 *
 * A PURE function over a window of cases. No fetching, no clock, no i18n: the
 * caller passes `now` so behaviour is exactly testable, and the renderer owns
 * presentation. That keeps every threshold decision in one auditable place.
 *
 * Deliberately NOT an LLM call. These are arithmetic questions ("is dueDate in
 * the past?") that are exactly correct in a few lines and would gain latency,
 * cost, non-determinism and a hallucination surface from a model. The analytics
 * agent earns its keep on open-ended questions, not on comparisons.
 *
 * HONESTY CONTRACT — read before changing a count:
 * case-service exposes no aggregate (its only read route is GET /cases) and the
 * bff's CaseConnection has no totalCount — only pageInfo.hasMore. So these
 * counts are computed over a BOUNDED WINDOW of cases, and when that window is
 * incomplete every count is a FLOOR, not a total. `InsightWindow.bounded`
 * carries that fact to the UI so it can say "at least N" rather than implying a
 * tenant-wide number it cannot know. Removing that flag would turn this from a
 * measurement into a guess.
 */
import type { Case } from "@/lib/graphql/types";

export type InsightLevel = "critical" | "warning" | "info";

export interface Insight {
  /** Stable id — used as a React key and as the analytics/telemetry name. */
  key: string;
  level: InsightLevel;
  /** How many cases in the window matched. See the honesty contract above. */
  count: number;
  /** What matched, in the user's language. Rendered with `count`. */
  label: string;
  /** The RULE that produced this, shown to the user so they can disagree with
   * it. An insight whose basis is invisible is just an assertion. */
  rule: string;
  /** Worklist link that shows exactly these cases (refined in slice 2). */
  href: string;
}

export interface InsightWindow {
  /** How many cases were actually examined. */
  examined: number;
  /** True when more cases exist beyond the window — counts are then floors. */
  bounded: boolean;
}

/** Statuses that still represent work. RESOLVED/CLOSED are done and must never
 * appear in an "attention" surface — an overdue CLOSED case is not a problem. */
const LIVE: ReadonlySet<string> = new Set(["DRAFT", "UNASSIGNED", "IN_PROGRESS"]);

const DUE_SOON_HOURS = 24;
const STALLED_DAYS = 14;
/** Three hand-offs is where routing stops looking like normal load balancing
 * and starts looking like the assignment rules being wrong. */
const CHURN_REASSIGNMENTS = 3;

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function isLive(c: Case): boolean {
  return LIVE.has(String(c.status ?? ""));
}

/** Parse an ISO timestamp, returning null for absent or unparseable values —
 * a case with no due date is not overdue, and a malformed one must not be
 * silently treated as epoch (which would make everything overdue). */
function at(value: string | null | undefined): number | null {
  if (!value) return null;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : t;
}

const RANK: Record<InsightLevel, number> = { critical: 0, warning: 1, info: 2 };

/**
 * Compute the insights for a window of cases.
 *
 * `now` is injected rather than read from the clock so the thresholds are
 * deterministic under test. Insights with a zero count are omitted entirely —
 * "0 cases overdue" is noise, and an empty result is a real answer the UI
 * renders as "nothing needs attention".
 */
export function computeCaseInsights(cases: Case[], now: number): Insight[] {
  const live = cases.filter(isLive);

  const overdue = live.filter((c) => {
    const due = at(c.dueDate);
    return due !== null && due < now;
  });

  const dueSoon = live.filter((c) => {
    const due = at(c.dueDate);
    return due !== null && due >= now && due <= now + DUE_SOON_HOURS * HOUR;
  });

  const unassigned = live.filter((c) => String(c.status) === "UNASSIGNED");

  const stalled = live.filter((c) => {
    const created = at(c.createdAt);
    return created !== null && created < now - STALLED_DAYS * DAY;
  });

  const churning = live.filter((c) => (c.reassignCount ?? 0) >= CHURN_REASSIGNMENTS);

  const all: Insight[] = [
    {
      key: "cases.overdue",
      level: "critical",
      count: overdue.length,
      label: overdue.length === 1 ? "case is past its due date" : "cases are past their due date",
      rule: "open case whose due date has passed",
      href: "/cases?insight=overdue",
    },
    {
      key: "cases.dueSoon",
      level: "warning",
      count: dueSoon.length,
      label: dueSoon.length === 1 ? "case is due within 24 hours" : "cases are due within 24 hours",
      rule: `open case due in the next ${DUE_SOON_HOURS} hours`,
      href: "/cases?insight=due-soon",
    },
    {
      key: "cases.unassigned",
      level: "warning",
      count: unassigned.length,
      label: unassigned.length === 1 ? "case has no owner" : "cases have no owner",
      rule: "case still in the unassigned queue",
      href: "/cases?insight=unassigned",
    },
    {
      key: "cases.stalled",
      level: "info",
      count: stalled.length,
      label: stalled.length === 1 ? "case has been open over 2 weeks" : "cases have been open over 2 weeks",
      rule: `open case created more than ${STALLED_DAYS} days ago`,
      href: "/cases?insight=stalled",
    },
    {
      key: "cases.churn",
      level: "info",
      count: churning.length,
      label: churning.length === 1 ? "case has been reassigned repeatedly" : "cases have been reassigned repeatedly",
      rule: `case reassigned ${CHURN_REASSIGNMENTS} or more times — check routing rules`,
      href: "/cases?insight=churn",
    },
  ];

  return all
    .filter((i) => i.count > 0)
    .sort((a, b) => (RANK[a.level] - RANK[b.level]) || (b.count - a.count));
}
