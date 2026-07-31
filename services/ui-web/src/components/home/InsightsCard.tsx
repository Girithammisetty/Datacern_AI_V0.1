"use client";
import Link from "next/link";
import { AlertTriangle, CircleAlert, Info, CheckCircle2 } from "lucide-react";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/primitives";
import { useCaseSearch, useQueueIntelligence } from "@/lib/graphql/hooks";
import { computeCaseInsights, type Insight, type InsightLevel } from "@/lib/insights/cases";

/**
 * "What needs attention" — the answer to the question home did not previously
 * ask (insight-surfacing, slice 1).
 *
 * Three properties this card must keep:
 *
 *  1. It is ADDITIVE. It fetches its own data and, on failure, renders nothing.
 *     The decision queue and approvals cards beside it must never be taken down
 *     by an insight query.
 *  2. Its counts are HONEST ABOUT THEIR BOUNDS — but they are no longer bounded
 *     where a real aggregate exists. case-service now serves
 *     GET /cases/queue-intelligence, a workspace-wide count computed in SQL, so
 *     the two SLA insights report EXACT totals instead of the "at least N"
 *     floors this card shipped with. The floors were correct at the time and
 *     stale afterwards, which is the failure mode of an honesty caveat nobody
 *     revisits: it keeps under-reporting long after the limitation is gone.
 *     Insights with no server-side aggregate (unassigned, stalled, churn) are
 *     STILL floors and still say so — the card mixes exact and bounded counts,
 *     and says which is which per row rather than picking one label for all.
 *  3. Every row states the RULE behind it, so a user can disagree with the
 *     platform rather than just trust it.
 */

const ICON: Record<InsightLevel, typeof AlertTriangle> = {
  critical: CircleAlert,
  warning: AlertTriangle,
  info: Info,
};

const TONE: Record<InsightLevel, string> = {
  critical: "text-destructive",
  warning: "text-amber-600 dark:text-amber-500",
  info: "text-muted-foreground",
};

function InsightRow({ insight, bounded }: { insight: Insight; bounded: boolean }) {
  const Icon = ICON[insight.level];
  return (
    <Link
      href={insight.href}
      className="flex items-start gap-3 rounded-md px-2 py-2 transition-colors hover:bg-accent/50"
    >
      <Icon className={`mt-0.5 size-4 shrink-0 ${TONE[insight.level]}`} aria-hidden />
      <span className="min-w-0">
        <span className="text-sm">
          <span className="font-semibold text-foreground">
            {bounded ? `at least ${insight.count}` : insight.count}
          </span>{" "}
          {insight.label}
          {/* Severity is WHY this outranks a bigger insight below it — showing
              the count without it makes the ordering look arbitrary. */}
          {insight.severeCount > 0 && (
            <span className="text-muted-foreground">
              {" "}· {insight.severeCount} high or critical
            </span>
          )}
        </span>
        <span className="block text-xs text-muted-foreground">{insight.rule}</span>
      </span>
    </Link>
  );
}

export function InsightsCard() {
  // One page of cases is the window. Failure is silent BY DESIGN: this card is
  // additive, and a red error box on the home page for a secondary signal is
  // worse than its absence.
  const q = useCaseSearch({});
  // Exact SLA totals when the aggregate answers; the card degrades to the
  // windowed floors if it does not, rather than dropping the rows.
  const qi = useQueueIntelligence(7);
  if (q.isError) return null;

  const nodes = (q.data?.pages ?? []).flatMap((p) => p.nodes);
  const windowBounded = Boolean(q.data?.pages?.[q.data.pages.length - 1]?.pageInfo?.hasMore);
  const insights = computeCaseInsights(nodes, Date.now());
  const exact = qi.data
    ? { overdue: qi.data.sla.breached, "due-soon": qi.data.sla.dueWithin24h }
    : undefined;

  if (q.isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Needs attention</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">Checking your worklist…</CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">Needs attention</CardTitle>
        {insights.length > 0 && (
          <CardDescription>
            {/* The card can now hold BOTH kinds of count, so the description
                says so rather than claiming one bound for everything. */}
            {exact
              ? windowBounded
                ? `SLA counts are workspace totals; the rest span the ${nodes.length} most recent cases, so those are minimums.`
                : `SLA counts are workspace totals; the rest span all ${nodes.length} of your cases.`
              : windowBounded
                ? `Across the ${nodes.length} most recent cases — more exist, so these are minimums.`
                : `Across all ${nodes.length} of your cases.`}
          </CardDescription>
        )}
      </CardHeader>
      <CardContent className="space-y-1">
        {insights.length === 0 ? (
          // A real answer, not an empty container. "Nothing is wrong" is
          // information; a blank card is a bug the user has to interpret.
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <CheckCircle2 className="size-4 text-emerald-600 dark:text-emerald-500" aria-hidden />
            Nothing needs attention right now.
          </p>
        ) : (
          insights.map((i) => {
            // Per-row, not per-card: an exact SLA total and a floored churn
            // count can sit next to each other, and labelling both the same way
            // would be wrong about one of them.
            const server = exact?.[i.slug as keyof typeof exact];
            return (
              <InsightRow
                key={i.key}
                insight={server === undefined ? i : { ...i, count: server }}
                bounded={server === undefined && windowBounded}
              />
            );
          })
        )}
      </CardContent>
    </Card>
  );
}
