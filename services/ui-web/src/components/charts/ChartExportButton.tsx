"use client";
import { useState } from "react";
import { Download } from "lucide-react";
import { Badge } from "@/components/ui/primitives";
import { Button } from "@/components/ui/button";
import { Can } from "@/components/authz/Can";
import { FEATURE_GATES } from "@/lib/authz/registry";
import { useExportChart, useChartExportOperation } from "@/lib/graphql/hooks";
import { useToasts } from "@/stores/ui";
import { GraphQLRequestError } from "@/lib/graphql/client";

/**
 * Async CSV export for one chart (chart-service POST /charts/{id}/export,
 * CHART-FR-041). Same idiom as CaseExportButton: kick off the real export
 * operation, poll chartExportOperation every 2s while pending/running, then
 * link the artifact through the authed same-origin proxy
 * /api/chart-export/{operationId} (the operation lookup needs the Bearer JWT a
 * plain <a href> cannot carry; the artifact link points at a service host).
 */
export function ChartExportButton({ chartId }: { chartId: string }) {
  const push = useToasts((s) => s.push);
  const exportChart = useExportChart();
  const [operationId, setOperationId] = useState<string | null>(null);
  const operation = useChartExportOperation(operationId, {
    refetchInterval: (q) => {
      const s = q.state.data?.status;
      return s === "pending" || s === "running" ? 2000 : false;
    },
  });
  // The mutation result is the operation's real initial state; the poll takes
  // over from there. Prefer the freshest read.
  const op = operation.data ?? exportChart.data ?? null;
  const busy = op?.status === "pending" || op?.status === "running";

  const run = () =>
    exportChart.mutate(
      { id: chartId, format: "csv" },
      {
        onSuccess: (r) => setOperationId(r.id),
        onError: (err) => {
          const g = err instanceof GraphQLRequestError ? err : null;
          push({
            title: "Chart export failed to start",
            description: g?.message ?? String(err),
            traceId: g?.traceId,
            variant: "error",
          });
        },
      },
    );

  return (
    <Can gate={FEATURE_GATES.exportChart}>
      <span className="flex items-center gap-1">
        <Button
          variant="ghost"
          size="icon"
          aria-label="Export chart CSV"
          title="Export chart CSV"
          disabled={exportChart.isPending || busy}
          onClick={run}
        >
          <Download />
        </Button>
        {op && busy && <Badge variant="warning">{op.status}</Badge>}
        {op?.status === "completed" && (
          <a
            href={`/api/chart-export/${op.id}`}
            className="flex items-center gap-1 text-xs text-primary hover:underline"
          >
            <Download className="size-3" aria-hidden /> CSV
          </a>
        )}
        {op?.status === "failed" && (
          <span className="text-xs text-destructive" title={op.error ?? undefined}>
            failed
          </span>
        )}
      </span>
    </Can>
  );
}
