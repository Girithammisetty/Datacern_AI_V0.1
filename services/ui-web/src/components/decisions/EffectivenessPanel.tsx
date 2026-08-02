"use client";
import { useState } from "react";
import { AsyncBoundary } from "@/components/primitives/AsyncBoundary";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/primitives";
import { useDecisionEffectiveness } from "@/lib/graphql/hooks";
import type { DecisionEffectivenessGroup } from "@/lib/graphql/types";

/**
 * Decision-effectiveness KPIs (BRD 55): decided-vs-realized agreement per
 * decision type or producer, from realized-outcome labels recorded against
 * decided proposals. Correlational only (BR-3) — the rate says how often the
 * decided outcome matched what actually happened, not why.
 */
export function EffectivenessPanel() {
  const [by, setBy] = useState<"DECISION_TYPE" | "PRODUCER">("DECISION_TYPE");
  const query = useDecisionEffectiveness(by);
  const data = query.data;

  return (
    <Card className="mt-6">
      <CardHeader className="flex flex-row items-start justify-between gap-2">
        <div>
          <CardTitle>Decision effectiveness</CardTitle>
          <CardDescription>
            How often decided outcomes matched the realized outcome, from
            {" "}{data?.labeledDecisions ?? 0} labeled decision{(data?.labeledDecisions ?? 0) === 1 ? "" : "s"}.
          </CardDescription>
        </div>
        <div className="flex gap-1" role="group" aria-label="Group by">
          <Button size="sm" variant={by === "DECISION_TYPE" ? "default" : "outline"}
            onClick={() => setBy("DECISION_TYPE")}>By decision type</Button>
          <Button size="sm" variant={by === "PRODUCER" ? "default" : "outline"}
            onClick={() => setBy("PRODUCER")}>By producer</Button>
        </div>
      </CardHeader>
      <CardContent>
        <AsyncBoundary
          isLoading={query.isLoading}
          isError={query.isError}
          error={query.error}
          isEmpty={!query.isLoading && (data?.groups.length ?? 0) === 0}
          emptyTitle="No outcomes recorded yet — record a realized outcome on a decided proposal to start measuring."
          onRetry={() => query.refetch()}
        >
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-muted-foreground">
                <th className="py-1 pr-2 font-medium">{by === "PRODUCER" ? "Producer" : "Decision type"}</th>
                <th className="py-1 pr-2 font-medium text-right">Labeled</th>
                <th className="py-1 pr-2 font-medium text-right">Correct</th>
                <th className="py-1 pr-2 font-medium text-right">Incorrect</th>
                <th className="py-1 pr-2 font-medium text-right">Unknown</th>
                <th className="py-1 font-medium text-right">Effectiveness</th>
              </tr>
            </thead>
            <tbody>
              {(data?.groups ?? []).map((g: DecisionEffectivenessGroup) => (
                <tr key={g.key} className="border-t border-border">
                  <td className="py-1.5 pr-2 font-mono text-xs">{g.key}</td>
                  <td className="py-1.5 pr-2 text-right tabular-nums">{g.total}</td>
                  <td className="py-1.5 pr-2 text-right tabular-nums">{g.correct}</td>
                  <td className="py-1.5 pr-2 text-right tabular-nums">{g.incorrect}</td>
                  <td className="py-1.5 pr-2 text-right tabular-nums">{g.unknown}</td>
                  <td className="py-1.5 text-right tabular-nums">
                    {/* null = nothing comparable yet — say so, never show 0% */}
                    {g.effectivenessRate == null ? "—" : `${Math.round(g.effectivenessRate * 100)}%`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </AsyncBoundary>
      </CardContent>
    </Card>
  );
}
