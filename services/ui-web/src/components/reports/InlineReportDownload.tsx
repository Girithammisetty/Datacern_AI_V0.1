"use client";
/**
 * Reports hub — slice 2: hub-native inline run + download
 * (docs/initiatives/reports-hub.md). For the reports whose data the client can
 * fetch AND whose CSV builder already exists, the hub runs the report and
 * downloads it in place instead of only deep-linking to its owning page.
 *
 * On-demand, not eager: the fetch fires on the download click (via
 * queryClient.fetchQuery), so opening the hub never pulls report data the user
 * didn't ask for. Only chargeback and agent-inventory have inline runners in
 * this slice — every other catalog entry keeps its "Open report →" deep link.
 */
import { useState } from "react";
import { Download, Loader2 } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import { graphqlRequest, GraphQLRequestError } from "@/lib/graphql/client";
import * as ops from "@/lib/graphql/operations";
import { qk } from "@/lib/graphql/keys";
import { useToasts } from "@/stores/ui";
import { downloadCsv } from "@/lib/export/csv";
import { buildChargebackCsv, chargebackFilename } from "@/lib/export/chargeback";
import { buildAgentInventoryCsv, agentInventoryFilename } from "@/lib/export/agentInventory";
import type { ChargebackLine, AgentFleetRow } from "@/lib/graphql/types";

/** Previous calendar month (UTC) — chargeback is only served for finalized
 * months, so the current month is never useful (mirrors admin/usage). */
function prevMonth(): string {
  const now = new Date();
  const p = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  return `${p.getUTCFullYear()}-${String(p.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** Shared error/empty toasting for a one-shot download. */
function useDownloadToast() {
  const push = useToasts((s) => s.push);
  return {
    empty: (what: string) => push({ title: `Nothing to download`, description: what, variant: "default" }),
    failed: (err: unknown) => {
      const g = err instanceof GraphQLRequestError ? err : null;
      push({ title: "Download failed", description: g?.message ?? String(err), traceId: g?.traceId, variant: "error" });
    },
  };
}

function InlineChargebackDownload() {
  const qc = useQueryClient();
  const toast = useDownloadToast();
  const [month, setMonth] = useState(prevMonth());
  const [busy, setBusy] = useState(false);

  const run = async () => {
    setBusy(true);
    try {
      const rows = await qc.fetchQuery<ChargebackLine[]>({
        queryKey: qk.chargebackReport(month),
        queryFn: () =>
          graphqlRequest<ops.ChargebackReportResult>(ops.CHARGEBACK_REPORT, { month }).then((r) => r.chargebackReport),
      });
      if (!rows || rows.length === 0) {
        toast.empty(`No chargeback lines for ${month} (finalized months with usage only).`);
        return;
      }
      downloadCsv(chargebackFilename(month), buildChargebackCsv(rows, month));
    } catch (e) {
      toast.failed(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex items-center gap-2">
      <input
        type="month"
        value={month}
        onChange={(e) => e.target.value && setMonth(e.target.value)}
        aria-label="Chargeback month"
        className="h-8 w-32 rounded-md border border-border/70 bg-background px-2 text-xs tabular-nums outline-none focus:ring-2 focus:ring-primary/40"
      />
      <Button variant="outline" size="sm" className="h-8 flex-1" disabled={busy} onClick={run}>
        {busy ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Download className="size-3.5" aria-hidden />}
        Download CSV
      </Button>
    </div>
  );
}

function InlineAgentInventoryDownload() {
  const qc = useQueryClient();
  const toast = useDownloadToast();
  const [busy, setBusy] = useState(false);

  const run = async () => {
    setBusy(true);
    try {
      // Inventory without spend — the hub export is the system-inventory view;
      // the spend-inclusive export lives on the Control Tower page behind its
      // own capability gate.
      const rows = await qc.fetchQuery<AgentFleetRow[]>({
        queryKey: qk.agentFleet({ includeSpend: false }),
        queryFn: () => graphqlRequest<ops.AgentFleetResult>(ops.AGENT_FLEET, {}).then((r) => r.agentFleet),
      });
      if (!rows || rows.length === 0) {
        toast.empty("No agents registered for this tenant yet.");
        return;
      }
      downloadCsv(agentInventoryFilename(rows), buildAgentInventoryCsv(rows, { includeSpend: false }));
    } catch (e) {
      toast.failed(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Button variant="outline" size="sm" className="h-8 w-full" disabled={busy} onClick={run}>
      {busy ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Download className="size-3.5" aria-hidden />}
      Download CSV
    </Button>
  );
}

/** Report ids that support hub-native inline run + download, mapped to the
 * control that runs them. A report not listed here keeps its deep link. */
export const INLINE_RUNNERS: Record<string, React.ComponentType> = {
  chargeback: InlineChargebackDownload,
  "agent-inventory": InlineAgentInventoryDownload,
};

/** True when a report can be run + downloaded inline from the hub. */
export function hasInlineRunner(reportId: string): boolean {
  return reportId in INLINE_RUNNERS;
}
