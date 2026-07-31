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
  /** URL token: /cases?insight=<slug> shows exactly these cases. */
  slug: string;
  level: InsightLevel;
  /** How many cases in the window matched. See the honesty contract above. */
  count: number;
  /** What matched, in the user's language. Rendered with `count`. */
  label: string;
  /** The RULE that produced this, shown to the user so they can disagree with
   * it. An insight whose basis is invisible is just an assertion. */
  rule: string;
  /** How many of the matches are HIGH or CRITICAL severity. Ranking uses this
   * so "2 overdue, both critical" outranks "5 overdue, all low" — the count
   * alone is a poor proxy for urgency. */
  severeCount: number;
  /** Worklist link that shows exactly these cases. */
  href: string;
}

/**
 * One insight's definition. The PREDICATE lives here and nowhere else: the
 * home card counts with it and the worklist filters with it, so the list a
 * user lands on provably contains the cases the number counted. Two copies of
 * "what overdue means" would drift, and the first symptom would be a count
 * that does not match the page it links to.
 */
export interface InsightDef {
  key: string;
  slug: string;
  level: InsightLevel;
  rule: string;
  /** Wording for a given count — singular and plural read differently. */
  label: (n: number) => string;
  match: (c: Case, now: number) => boolean;
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

const SEVERE: ReadonlySet<string> = new Set(["HIGH", "CRITICAL"]);

/**
 * The insight registry — the single source of truth for what each insight
 * MEANS. Adding one here makes it appear on home AND makes /cases?insight=<slug>
 * filter by it, with no second definition to keep in step.
 */
export const INSIGHT_DEFS: readonly InsightDef[] = [
  {
    key: "cases.overdue",
    slug: "overdue",
    level: "critical",
    rule: "open case whose due date has passed",
    label: (n) => (n === 1 ? "case is past its due date" : "cases are past their due date"),
    match: (c, now) => {
      const due = at(c.dueDate);
      return isLive(c) && due !== null && due < now;
    },
  },
  {
    key: "cases.dueSoon",
    slug: "due-soon",
    level: "warning",
    rule: `open case due in the next ${DUE_SOON_HOURS} hours`,
    label: (n) => (n === 1 ? "case is due within 24 hours" : "cases are due within 24 hours"),
    match: (c, now) => {
      const due = at(c.dueDate);
      return isLive(c) && due !== null && due >= now && due <= now + DUE_SOON_HOURS * HOUR;
    },
  },
  {
    key: "cases.unassigned",
    slug: "unassigned",
    level: "warning",
    rule: "case still in the unassigned queue",
    label: (n) => (n === 1 ? "case has no owner" : "cases have no owner"),
    match: (c) => isLive(c) && String(c.status) === "UNASSIGNED",
  },
  {
    key: "cases.stalled",
    slug: "stalled",
    level: "info",
    rule: `open case created more than ${STALLED_DAYS} days ago`,
    label: (n) =>
      n === 1 ? "case has been open over 2 weeks" : "cases have been open over 2 weeks",
    match: (c, now) => {
      const created = at(c.createdAt);
      return isLive(c) && created !== null && created < now - STALLED_DAYS * DAY;
    },
  },
  {
    key: "cases.churn",
    slug: "churn",
    level: "info",
    rule: `case reassigned ${CHURN_REASSIGNMENTS} or more times — check routing rules`,
    label: (n) =>
      n === 1 ? "case has been reassigned repeatedly" : "cases have been reassigned repeatedly",
    match: (c) => isLive(c) && (c.reassignCount ?? 0) >= CHURN_REASSIGNMENTS,
  },
];

/** Look up an insight by its URL token. Unknown slugs return undefined so the
 * worklist can ignore a stale or hand-edited link rather than showing nothing. */
export function insightBySlug(slug: string | null | undefined): InsightDef | undefined {
  if (!slug) return undefined;
  return INSIGHT_DEFS.find((d) => d.slug === slug);
}

/** The cases behind an insight, using the SAME predicate that produced its
 * count. This is what makes the deep link evidence rather than a guess. */
export function filterByInsight(cases: Case[], slug: string, now: number): Case[] {
  const def = insightBySlug(slug);
  return def ? cases.filter((c) => def.match(c, now)) : cases;
}

/**
 * Compute the insights for a window of cases.
 *
 * `now` is injected rather than read from the clock so the thresholds are
 * deterministic under test. Insights with a zero count are omitted entirely —
 * "0 cases overdue" is noise, and an empty result is a real answer the UI
 * renders as "nothing needs attention".
 *
 * Ordering is urgency-weighted, not size-weighted: level first, then how many
 * matches are HIGH/CRITICAL severity, then raw count. Two critical overdue
 * cases matter more than five low ones, and sorting by count alone buries them.
 */
export function computeCaseInsights(cases: Case[], now: number): Insight[] {
  return INSIGHT_DEFS.map((def) => {
    const hits = cases.filter((c) => def.match(c, now));
    return {
      key: def.key,
      slug: def.slug,
      level: def.level,
      count: hits.length,
      severeCount: hits.filter((c) => SEVERE.has(String(c.severity ?? ""))).length,
      label: def.label(hits.length),
      rule: def.rule,
      href: `/cases?insight=${def.slug}`,
    };
  })
    .filter((i) => i.count > 0)
    .sort(
      (a, b) =>
        RANK[a.level] - RANK[b.level] ||
        b.severeCount - a.severeCount ||
        b.count - a.count,
    );
}
