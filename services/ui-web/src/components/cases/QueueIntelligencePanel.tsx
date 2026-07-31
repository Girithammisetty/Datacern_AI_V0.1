"use client";
/**
 * Approver queue intelligence (roadmap item 4).
 *
 * The approver's standing questions, answered without them running a query:
 * how old is the backlog, what breaches next, how much is clearing, and how
 * long does a decision take. Every figure is a real aggregate case-service
 * computed over the caller's OWN workspace — nothing here is sampled,
 * extrapolated or estimated.
 *
 * Two presentation rules the data forces, both about not lying by omission:
 *
 *  - A NULL percentile renders as "no data", never as 0. `null` means nothing
 *    resolved in the window; showing 0s would tell an approver decisions are
 *    instant, which is the opposite of the truth it is reporting.
 *  - The sample size is always visible next to the percentiles, because a p90
 *    over three cases is a coincidence, not a trend, and the reader is the only
 *    one who can judge that.
 */
import { AlertTriangle, Clock, Timer, TrendingUp } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, Badge } from "@/components/ui/primitives";
import { AsyncBoundary } from "@/components/primitives/AsyncBoundary";
import { useQueueIntelligence } from "@/lib/graphql/hooks";
import { cn } from "@/lib/utils";

/** Seconds → a duration an approver reads at a glance. Returns null for null so
 * "no data" stays distinguishable from "0s" at every layer. */
export function humanDuration(seconds: number | null | undefined): string | null {
  if (seconds === null || seconds === undefined) return null;
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const mins = seconds / 60;
  if (mins < 60) return `${Math.round(mins)}m`;
  const hours = mins / 60;
  if (hours < 48) return `${hours.toFixed(hours < 10 ? 1 : 0)}h`;
  return `${(hours / 24).toFixed(1)}d`;
}

const AGING_LABELS: Record<string, string> = {
  under_24h: "< 24h",
  "1_to_3d": "1–3d",
  "3_to_7d": "3–7d",
  over_7d: "> 7d",
};

function Stat({ label, value, hint, tone }: {
  label: string;
  value: string;
  hint?: string;
  tone?: "danger" | "warn";
}) {
  return (
    <div className="rounded-md border p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={cn("mt-1 text-2xl font-semibold tabular-nums",
        tone === "danger" && "text-destructive",
        tone === "warn" && "text-[hsl(var(--warning))]")}>{value}</p>
      {hint && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

export function QueueIntelligencePanel({ days = 7 }: { days?: number }) {
  const q = useQueueIntelligence(days);
  const d = q.data;

  return (
    <Card data-testid="queue-intelligence">
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <CardTitle className="flex items-center gap-2 text-base">
          <TrendingUp className="size-4" aria-hidden />
          Queue health
        </CardTitle>
        {d && (
          // Stamp the age: this is polled, so a reader deserves to know how
          // fresh "breached" actually is rather than assuming it is live.
          <span className="text-xs text-muted-foreground" data-testid="qi-generated-at">
            last {d.windowDays}d · as of{" "}
            {new Date(d.generatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
          </span>
        )}
      </CardHeader>
      <CardContent>
        <AsyncBoundary
          isLoading={q.isLoading}
          isError={q.isError}
          error={q.error}
          isEmpty={false}
        >
          {d && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <Stat
                  label="Open"
                  value={String(d.open.total)}
                  hint={`${d.open.unassigned} unassigned · ${d.open.inProgress} in progress`}
                />
                <Stat
                  label="SLA breached"
                  value={String(d.sla.breached)}
                  hint="past due, still open"
                  tone={d.sla.breached > 0 ? "danger" : undefined}
                />
                <Stat
                  label="Due within 24h"
                  value={String(d.sla.dueWithin24h)}
                  hint="still savable"
                  tone={d.sla.dueWithin24h > 0 ? "warn" : undefined}
                />
                <Stat
                  label="Resolved"
                  value={String(d.throughput.resolved)}
                  hint={`${d.throughput.opened} opened · ${d.throughput.closed} closed`}
                />
              </div>

              <div>
                <p className="mb-2 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                  <Clock className="size-3.5" aria-hidden /> Age of open cases
                </p>
                <div className="flex gap-2" data-testid="qi-aging">
                  {d.aging.map((b) => (
                    <div key={b.label} className="flex-1 rounded-md bg-muted/50 p-2 text-center">
                      <p className="text-lg font-semibold tabular-nums">{b.count}</p>
                      <p className="text-xs text-muted-foreground">
                        {AGING_LABELS[b.label] ?? b.label}
                      </p>
                    </div>
                  ))}
                </div>
              </div>

              <div className="flex items-center gap-3 rounded-md border p-3">
                <Timer className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                <div className="min-w-0 flex-1">
                  <p className="text-xs text-muted-foreground">Time to decision</p>
                  <p className="mt-0.5 text-sm" data-testid="qi-latency">
                    {d.latency.sample === 0 ? (
                      // NOT "0s". Nothing resolved in the window, and a zero
                      // here would read as instant decisions.
                      <span className="text-muted-foreground">
                        No cases resolved in the last {d.windowDays} days
                      </span>
                    ) : (
                      <>
                        <span className="font-semibold tabular-nums">
                          {humanDuration(d.latency.p50Seconds) ?? "—"}
                        </span>{" "}
                        median
                        <span className="text-muted-foreground">
                          {" · "}
                          {humanDuration(d.latency.p90Seconds) ?? "—"} at p90
                        </span>
                      </>
                    )}
                  </p>
                </div>
                {d.latency.sample > 0 && (
                  // Sample size is not a footnote — it is what tells the reader
                  // whether the percentile above means anything.
                  <Badge variant={d.latency.sample < 5 ? "outline" : "secondary"}
                         data-testid="qi-sample">
                    {d.latency.sample < 5 && (
                      <AlertTriangle className="mr-1 size-3" aria-hidden />
                    )}
                    n={d.latency.sample}
                  </Badge>
                )}
              </div>
            </div>
          )}
        </AsyncBoundary>
      </CardContent>
    </Card>
  );
}
