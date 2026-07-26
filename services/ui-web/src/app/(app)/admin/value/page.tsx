"use client";
import { useState } from "react";
import { ClipboardCheck, Clock, DollarSign, TrendingUp, Users, Download, History } from "lucide-react";
import { PageHeader } from "@/components/shell/PageHeader";
import { AsyncBoundary } from "@/components/primitives/AsyncBoundary";
import { DataTable, type Column } from "@/components/primitives/DataTable";
import { BarChart } from "@/components/charts/BarChart";
import { LineChart } from "@/components/charts/LineChart";
import { Can } from "@/components/authz/Can";
import { Badge, Card, CardHeader, CardTitle, CardContent, Input } from "@/components/ui/primitives";
import { Button } from "@/components/ui/button";
import { FEATURE_GATES } from "@/lib/authz/registry";
import {
  useValueSummary,
  useValueTrend,
  useValueAssumptions,
  useValueAssumptionHistory,
  useUpdateValueAssumptions,
  useValueExports,
  useExportValueReport,
} from "@/lib/graphql/hooks";
import type { ValueAssumptions, ValueExport } from "@/lib/graphql/types";
import { formatUsd, formatLocal, formatNumber } from "@/lib/utils";

/** UTC YYYY-MM for "this month" (matches the API's `period` contract). */
function currentPeriod(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

export default function AdminValuePage() {
  const [period, setPeriod] = useState(currentPeriod());

  return (
    <div>
      <PageHeader
        title="Value & ROI"
        description="Governed decisions, hours saved and cost-per-decision for this tenant — every derived figure discloses the assumption behind it."
        actions={
          <label className="flex items-center gap-2 text-xs">
            <span className="text-muted-foreground">Period</span>
            <Input
              type="month"
              value={period}
              onChange={(e) => e.target.value && setPeriod(e.target.value)}
              aria-label="Reporting period"
              className="h-8 w-36 text-xs"
            />
          </label>
        }
      />

      <SummaryTiles period={period} />

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <DecisionMixCard period={period} />
        <TrendCard />
      </div>

      <div className="mt-4">
        <AdoptionCard period={period} />
      </div>

      <div className="mt-4">
        <AssumptionsPanel />
      </div>

      <div className="mt-4">
        <ExportsCard period={period} />
      </div>
    </div>
  );
}

/* ------- headline tiles ------- */

function SummaryTiles({ period }: { period: string }) {
  const q = useValueSummary(period);
  const s = q.data;
  const base = { isLoading: q.isLoading, isError: q.isError, error: q.error };

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <Tile
        icon={ClipboardCheck}
        label="Governed decisions"
        {...base}
        isEmpty={!s?.decisions}
        emptyHint={s?.provenance.meterGap ?? "No governed-decision data for this period."}
        value={s?.decisions ? formatNumber(s.decisions.total) : null}
      />
      <Tile
        icon={Clock}
        label="Hours saved (est.)"
        {...base}
        isEmpty={!s?.hoursSavedEst}
        emptyHint="Set assumptions below to see hours saved."
        value={s?.hoursSavedEst ? formatNumber(s.hoursSavedEst.value) : null}
        footnote={s?.hoursSavedEst ? `assumption v${s.hoursSavedEst.assumptionVersion}` : undefined}
      />
      <Tile
        icon={DollarSign}
        label="Cost / decision"
        {...base}
        isEmpty={!s?.costPerDecision}
        emptyHint={s?.provenance.meterGap ?? "Not computable this period."}
        value={s?.costPerDecision ? formatUsd(s.costPerDecision.value) : null}
        footnote={s?.costPerDecision ? s.costPerDecision.basis : undefined}
      />
      <Tile
        icon={TrendingUp}
        label="Net value (est.)"
        {...base}
        isEmpty={!s?.netValueEstUsd}
        emptyHint="Set assumptions below to see net value."
        value={s?.netValueEstUsd ? formatUsd(s.netValueEstUsd.value) : null}
        footnote={s?.netValueEstUsd ? `assumption v${s.netValueEstUsd.assumptionVersion}` : undefined}
      />
    </div>
  );
}

function Tile({
  icon: Icon,
  label,
  isLoading,
  isError,
  error,
  isEmpty,
  emptyHint,
  value,
  footnote,
}: {
  icon: typeof ClipboardCheck;
  label: string;
  isLoading: boolean;
  isError: boolean;
  error: unknown;
  isEmpty: boolean;
  emptyHint?: string;
  value: string | null;
  footnote?: string;
}) {
  return (
    <Card>
      <CardHeader className="flex-row items-center gap-2 space-y-0">
        <Icon className="size-4 text-muted-foreground" aria-hidden />
        <CardTitle className="text-sm">{label}</CardTitle>
      </CardHeader>
      <CardContent>
        <AsyncBoundary
          isLoading={isLoading}
          isError={isError}
          error={error}
          isEmpty={isEmpty}
          emptyTitle="Not set"
          emptyHint={emptyHint}
        >
          <p className="text-3xl font-bold">{value}</p>
          {footnote && <p className="mt-1 text-xs text-muted-foreground">{footnote}</p>}
        </AsyncBoundary>
      </CardContent>
    </Card>
  );
}

/* ------- decision mix + tenure trend ------- */

function DecisionMixCard({ period }: { period: string }) {
  const q = useValueSummary(period);
  const byDecision = (q.data?.decisions?.byDecision as Record<string, number> | undefined) ?? {};
  const rows = Object.entries(byDecision).map(([k, v]) => [k, v]);

  return (
    <Card>
      <CardHeader><CardTitle className="text-sm">Decision mix</CardTitle></CardHeader>
      <CardContent>
        <AsyncBoundary
          isLoading={q.isLoading}
          isError={q.isError}
          error={q.error}
          isEmpty={!q.data?.decisions || rows.length === 0}
          emptyTitle="No decision breakdown yet."
          emptyHint={q.data?.provenance.meterGap ?? undefined}
        >
          <BarChart columns={["decision", "count"]} rows={rows} title="Decisions by outcome" />
        </AsyncBoundary>
      </CardContent>
    </Card>
  );
}

function TrendCard() {
  const q = useValueTrend("cost_per_decision");
  const points = q.data?.points ?? [];
  const rows = points.map((p) => [p.period, p.value ?? 0]);
  const lastAnnotated = [...points].reverse().find((p) => p.distilledRungShare != null);

  return (
    <Card>
      <CardHeader><CardTitle className="text-sm">Cost per decision — tenure trend</CardTitle></CardHeader>
      <CardContent>
        <AsyncBoundary
          isLoading={q.isLoading}
          isError={q.isError}
          error={q.error}
          isEmpty={points.every((p) => p.value == null)}
          emptyTitle="No trend data yet."
        >
          <LineChart columns={["period", "cost_per_decision"]} rows={rows} title="Cost per decision by month" />
          {lastAnnotated?.distilledRungShare != null ? (
            <p className="mt-2 text-xs text-muted-foreground">
              {Math.round(lastAnnotated.distilledRungShare * 100)}% of calls served by a distilled rung as of{" "}
              {lastAnnotated.period}.
            </p>
          ) : (
            <p className="mt-2 text-xs text-muted-foreground">
              Distilled-rung share not available yet (ai-gateway rung dimension not wired to usage-service).
            </p>
          )}
        </AsyncBoundary>
      </CardContent>
    </Card>
  );
}

/* ------- adoption ------- */

function AdoptionCard({ period }: { period: string }) {
  const q = useValueSummary(period);
  const byWorkspace = (q.data?.adoption?.byWorkspace as Record<string, number> | undefined) ?? {};
  const rows = Object.entries(byWorkspace).map(([workspaceId, activeUsers]) => ({ workspaceId, activeUsers }));

  const columns: Column<{ workspaceId: string; activeUsers: number }>[] = [
    { id: "workspace", header: "Workspace", cell: (r) => <span className="font-mono text-xs">{r.workspaceId}</span> },
    { id: "users", header: "Active users", width: 120, cell: (r) => r.activeUsers },
  ];

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <CardTitle className="flex items-center gap-2 text-sm"><Users className="size-4" aria-hidden />Adoption by workspace</CardTitle>
        <span className="text-xs text-muted-foreground">
          {q.data ? `${formatNumber(q.data.adoption.activeUsers)} active users tenant-wide` : ""}
        </span>
      </CardHeader>
      <CardContent>
        <AsyncBoundary
          isLoading={q.isLoading}
          isError={q.isError}
          error={q.error}
          isEmpty={rows.length === 0}
          emptyTitle="No adoption data yet."
        >
          <DataTable ariaLabel="Adoption by workspace" rows={rows} columns={columns} rowId={(r) => r.workspaceId} />
        </AsyncBoundary>
      </CardContent>
    </Card>
  );
}

/* ------- assumptions ------- */

function parseMinutesText(text: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const pair of text.split(",")) {
    const [k, v] = pair.split("=").map((s) => s.trim());
    if (k && v && !Number.isNaN(Number(v)) && Number(v) > 0) out[k] = Number(v);
  }
  return out;
}

function minutesToText(m: Record<string, number> | undefined): string {
  if (!m) return "";
  return Object.entries(m).map(([k, v]) => `${k}=${v}`).join(", ");
}

function AssumptionsPanel() {
  const assumptionsQ = useValueAssumptions();
  const historyQ = useValueAssumptionHistory();
  const update = useUpdateValueAssumptions();
  const current = assumptionsQ.data;

  const [editing, setEditing] = useState(false);
  const [minutesText, setMinutesText] = useState("");
  const [rateText, setRateText] = useState("");

  const startEditing = () => {
    setMinutesText(minutesToText(current?.minutesPerDecision as Record<string, number> | undefined));
    setRateText(current ? String(current.loadedHourlyRateUsd) : "");
    setEditing(true);
  };

  const historyColumns: Column<ValueAssumptions>[] = [
    { id: "version", header: "Version", width: 90, cell: (a) => <span className="font-medium">v{a.version}</span> },
    { id: "status", header: "Status", width: 110, cell: (a) => <Badge variant={a.status === "active" ? "success" : "secondary"}>{a.status}</Badge> },
    { id: "rate", header: "Rate/hr", width: 100, cell: (a) => formatUsd(a.loadedHourlyRateUsd) },
    { id: "minutes", header: "Minutes per decision kind", cell: (a) => <span className="font-mono text-xs">{minutesToText(a.minutesPerDecision as Record<string, number>)}</span> },
    { id: "by", header: "Edited by", width: 140, cell: (a) => a.createdBy },
    { id: "at", header: "Effective", width: 170, cell: (a) => formatLocal(a.createdAt) },
  ];

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <CardTitle className="flex items-center gap-2 text-sm"><History className="size-4" aria-hidden />Value assumptions</CardTitle>
        <Can gate={FEATURE_GATES.manageValueAssumptions}>
          <Button size="sm" variant="outline" onClick={() => (editing ? setEditing(false) : startEditing())}>
            {editing ? "Cancel" : current ? "Edit" : "Set assumptions"}
          </Button>
        </Can>
      </CardHeader>
      <CardContent className="space-y-4">
        <AsyncBoundary
          isLoading={assumptionsQ.isLoading}
          isError={assumptionsQ.isError}
          error={assumptionsQ.error}
          isEmpty={!current && !editing}
          emptyTitle="No assumptions set."
          emptyHint="Governed-decision counts and cost are honest without assumptions — hours-saved and net-value figures need a minutes-per-decision estimate and a loaded hourly rate to compute. No default is ever assumed for you."
        >
          {current && !editing && (
            <p className="text-sm">
              v{current.version} · {formatUsd(current.loadedHourlyRateUsd)}/hr ·{" "}
              <span className="font-mono text-xs">{minutesToText(current.minutesPerDecision as Record<string, number>)}</span>
            </p>
          )}
        </AsyncBoundary>

        <Can gate={FEATURE_GATES.manageValueAssumptions}>
          {editing && (
            <form
              className="flex flex-wrap items-end gap-2 rounded-md border bg-muted/30 p-3"
              onSubmit={(e) => {
                e.preventDefault();
                const minutesPerDecision = parseMinutesText(minutesText);
                const loadedHourlyRateUsd = Number(rateText);
                if (loadedHourlyRateUsd > 0 && Object.keys(minutesPerDecision).length > 0) {
                  update.mutate(
                    { minutesPerDecision, loadedHourlyRateUsd },
                    { onSuccess: () => setEditing(false) },
                  );
                }
              }}
            >
              <label className="flex flex-col gap-1 text-xs">
                <span className="text-muted-foreground">Loaded hourly rate (USD)</span>
                <Input
                  type="number" min="0" step="0.01" value={rateText}
                  onChange={(e) => setRateText(e.target.value)}
                  aria-label="Loaded hourly rate USD" className="h-8 w-32 text-xs"
                />
              </label>
              <label className="flex flex-col gap-1 text-xs">
                <span className="text-muted-foreground">Minutes per decision kind (kind=minutes, comma-separated)</span>
                <Input
                  value={minutesText} onChange={(e) => setMinutesText(e.target.value)}
                  aria-label="Minutes per decision kind" className="h-8 w-80 text-xs"
                />
              </label>
              <Button type="submit" size="sm" disabled={update.isPending}>Save</Button>
              {update.error && <p className="w-full text-xs text-destructive">{update.error.message}</p>}
            </form>
          )}
        </Can>

        <div>
          <p className="mb-1 text-xs font-medium text-muted-foreground">Edit history</p>
          <AsyncBoundary
            isLoading={historyQ.isLoading}
            isError={historyQ.isError}
            error={historyQ.error}
            isEmpty={(historyQ.data ?? []).length === 0}
            emptyTitle="No edit history yet."
          >
            <DataTable
              ariaLabel="Assumption edit history"
              rows={historyQ.data ?? []}
              columns={historyColumns}
              rowId={(a) => a.id}
            />
          </AsyncBoundary>
        </div>
      </CardContent>
    </Card>
  );
}

/* ------- exports ------- */

function ExportsCard({ period }: { period: string }) {
  const query = useValueExports(period);
  const exportReport = useExportValueReport();
  const rows = query.data ?? [];

  const columns: Column<ValueExport>[] = [
    { id: "version", header: "Version", width: 90, cell: (e) => <span className="font-medium">v{e.version}</span> },
    { id: "assumption", header: "Assumption", width: 110, cell: (e) => (e.assumptionVersion ? `v${e.assumptionVersion}` : "—") },
    {
      id: "json", header: "JSON", width: 90,
      cell: (e) => e.jsonUrl ? <a className="text-primary hover:underline" href={e.jsonUrl}>download</a> : <span className="text-muted-foreground">—</span>,
    },
    {
      id: "csv", header: "CSV", width: 90,
      cell: (e) => e.csvUrl ? <a className="text-primary hover:underline" href={e.csvUrl}>download</a> : <span className="text-muted-foreground">—</span>,
    },
    { id: "at", header: "Generated", width: 170, cell: (e) => formatLocal(e.createdAt) },
  ];

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <CardTitle className="flex items-center gap-2 text-sm"><Download className="size-4" aria-hidden />Board-ready exports</CardTitle>
        <Button
          size="sm"
          disabled={exportReport.isPending}
          onClick={() => exportReport.mutate({ period })}
        >
          {exportReport.isPending ? "Generating…" : "Export this period"}
        </Button>
      </CardHeader>
      <CardContent>
        {exportReport.error && <p className="mb-2 text-xs text-destructive">{exportReport.error.message}</p>}
        <AsyncBoundary
          isLoading={query.isLoading}
          isError={query.isError}
          error={query.error}
          isEmpty={rows.length === 0}
          emptyTitle="No exports generated yet for this period."
          emptyHint="Exports disclose the assumptions used and are checksummed (value-report.v1)."
        >
          <DataTable ariaLabel="Value report exports" rows={rows} columns={columns} rowId={(e) => e.id} />
        </AsyncBoundary>
      </CardContent>
    </Card>
  );
}
