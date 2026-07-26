"use client";
import { useMemo, useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { ArrowUpDown, Download, ShieldCheck, X } from "lucide-react";
import { DataTable, type Column } from "@/components/primitives/DataTable";
import { AsyncBoundary } from "@/components/primitives/AsyncBoundary";
import { ConfirmDialog } from "@/components/primitives/ConfirmDialog";
import { Can } from "@/components/authz/Can";
import { Badge, Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/primitives";
import { Button } from "@/components/ui/button";
import { FEATURE_GATES } from "@/lib/authz/registry";
import { useCapabilities } from "@/lib/authz/useCapabilities";
import {
  useAgentFleet, useAgentFleetSummary, useCreateAgentKillSwitch, useDeleteAgentKillSwitch,
} from "@/lib/graphql/hooks";
import type { AgentFleetRow, AgentFleetLifecycle, EvalGateStatusValue } from "@/lib/graphql/types";
import { agentInventoryFilename, buildAgentInventoryCsv } from "@/lib/export/agentInventory";
import { downloadCsv } from "@/lib/export/csv";
import { t } from "@/lib/i18n/messages";
import { formatLocal, cn } from "@/lib/utils";

const LIFECYCLE_VARIANT: Record<AgentFleetLifecycle, "success" | "destructive" | "warning" | "secondary"> = {
  ACTIVE: "success",
  KILLED: "destructive",
  QUARANTINED: "warning",
  DEPRECATED: "secondary",
};

const EVAL_VARIANT: Record<EvalGateStatusValue, "success" | "destructive" | "warning" | "secondary"> = {
  PASS: "success",
  FAIL: "destructive",
  STALE: "warning",
  NONE: "secondary",
};

const KIND_VARIANT: Record<string, "outline" | "secondary" | "ai"> = {
  PLATFORM: "outline",
  CUSTOM: "secondary",
  EXTERNAL: "ai",
};

function formatUsd(n?: number | null): string {
  if (n == null) return "—";
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * ACT-FR-011 header tiles: totals by kind/state + period spend/decisions.
 * Spend/decisions render the design's "unavailable" state rather than a
 * fabricated 0 whenever their source is degraded or not yet built
 * (decisions has no agent-runtime aggregate route in slice 1 — always
 * unavailable; see docs/initiatives/agent-control-tower.md §2.6/§3).
 */
export function AgentFleetTiles() {
  const { can } = useCapabilities();
  const canSpend = can(FEATURE_GATES.viewAgentFleetSpend);
  const summary = useAgentFleetSummary();
  const s = summary.data;

  return (
    <Card>
      <CardContent className="grid grid-cols-2 gap-4 pt-4 sm:grid-cols-3 lg:grid-cols-5">
        <Tile label={t("fleet.tile.totalAgents")} value={s ? String(s.activeCount + s.killedCount + s.quarantinedCount) : undefined} loading={summary.isLoading} />
        <Tile label={t("fleet.tile.active")} value={s ? String(s.activeCount) : undefined} loading={summary.isLoading} />
        <Tile label={t("fleet.tile.killed")} value={s ? String(s.killedCount) : undefined} loading={summary.isLoading} />
        <Tile
          label={t("fleet.tile.periodSpend")}
          value={!canSpend ? undefined : s && s.periodSpendUsd != null ? formatUsd(s.periodSpendUsd) : undefined}
          unavailable={canSpend && !!s && s.periodSpendUsd == null}
          loading={summary.isLoading}
          hidden={!canSpend}
        />
        <Tile
          label={t("fleet.tile.periodDecisions")}
          value={undefined}
          unavailable={!!s}
          loading={summary.isLoading}
        />
      </CardContent>
    </Card>
  );
}

function Tile({
  label, value, loading, unavailable, hidden,
}: {
  label: string; value?: string; loading?: boolean; unavailable?: boolean; hidden?: boolean;
}) {
  if (hidden) return null;
  return (
    <div>
      <p className="text-2xl font-bold tabular-nums">
        {loading ? "…" : unavailable ? <span className="text-base font-medium text-muted-foreground">{t("fleet.unavailable")}</span> : (value ?? "—")}
      </p>
      <p className="text-xs text-muted-foreground">{label}</p>
    </div>
  );
}

type SortKey = "state" | "spend" | "decisions" | null;

/**
 * ACT-FR-010 Control Tower fleet table: every agent that can act in this
 * tenant (platform/tenant-custom/external) with lifecycle, guardrails, eval
 * gate, spend, in one sortable table. Degraded field groups (evalGate.
 * unavailable, spend.unavailable, decisions.unavailable) render an honest
 * "unavailable" marker, never a fabricated zero.
 *
 * BRD 68 slice 3: the "Export inventory (CSV)" control builds the AI-system
 * inventory export (EU AI Act Art. 11/Annex IV use case) straight from the
 * rows already fetched here — no second network round-trip — via
 * lib/export/agentInventory.ts. Same unavailable-marker honesty rule applies
 * to the export as to this table.
 */
export function AgentFleetTable() {
  const { can } = useCapabilities();
  const canSpend = can(FEATURE_GATES.viewAgentFleetSpend);
  const query = useAgentFleet({}, canSpend);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>(null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  const sorted = useMemo(() => sortFleetRows(query.data ?? [], sortKey, sortDir), [query.data, sortKey, sortDir]);
  const selected = sorted.find((r) => r.key === selectedKey) ?? null;

  const exportInventory = () => {
    const rows = query.data ?? [];
    if (rows.length === 0) return;
    const csv = buildAgentInventoryCsv(rows, { includeSpend: canSpend });
    downloadCsv(agentInventoryFilename(rows), csv);
  };

  const toggleSort = (key: Exclude<SortKey, null>) => {
    if (sortKey === key) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortKey(key); setSortDir("desc"); }
  };

  const sortHeader = (label: string, key: Exclude<SortKey, null>) => (
    <button
      type="button"
      className="inline-flex items-center gap-1 hover:text-foreground"
      onClick={() => toggleSort(key)}
      aria-label={`Sort by ${label}`}
    >
      {label}
      <ArrowUpDown className={cn("size-3", sortKey === key && "text-foreground")} aria-hidden />
    </button>
  );

  const columns: Column<AgentFleetRow>[] = [
    {
      id: "agent", header: t("fleet.column.agent"),
      cell: (r) => (
        <div className="flex flex-col">
          <span className="font-medium">{r.display}</span>
          <span className="font-mono text-[11px] text-muted-foreground">{r.key}</span>
        </div>
      ),
    },
    {
      id: "kind", header: t("fleet.column.kind"), width: 110,
      cell: (r) => (
        <div className="flex flex-col gap-1">
          <Badge variant={KIND_VARIANT[r.kind] ?? "outline"}>{r.kind.toLowerCase()}</Badge>
          {r.external && <Badge variant="destructive" className="w-fit">{t("fleet.external.badge")}</Badge>}
        </div>
      ),
    },
    {
      id: "state", header: sortHeader(t("fleet.column.state"), "state"), width: 110,
      cell: (r) => <Badge variant={LIFECYCLE_VARIANT[r.lifecycle]}>{r.lifecycle.toLowerCase()}</Badge>,
    },
    {
      id: "version", header: t("fleet.column.version"), width: 130,
      cell: (r) => (
        <span className="text-xs">
          v{r.activeVersion.id}
          {r.activeVersion.rollout !== "UNKNOWN" && <span className="ml-1 text-muted-foreground">({r.activeVersion.rollout.toLowerCase()})</span>}
        </span>
      ),
    },
    {
      id: "guardrails", header: t("fleet.column.guardrails"), width: 110,
      cell: (r) => <GuardrailPopover row={r} />,
    },
    {
      id: "evalGate", header: t("fleet.column.evalGate"), width: 110,
      cell: (r) =>
        r.evalGate.unavailable ? (
          <span className="text-xs text-muted-foreground">{t("fleet.unavailable")}</span>
        ) : (
          <Badge variant={EVAL_VARIANT[r.evalGate.status]}>{r.evalGate.status.toLowerCase()}</Badge>
        ),
    },
    ...(canSpend
      ? [{
          id: "spend", header: sortHeader(t("fleet.column.spend"), "spend"), width: 130,
          cell: (r: AgentFleetRow) =>
            !r.spend || r.spend.unavailable ? (
              <span className="text-xs text-muted-foreground">{t("fleet.unavailable")}</span>
            ) : (
              <span className="tabular-nums">{formatUsd(r.spend.periodUsd)}</span>
            ),
        } as Column<AgentFleetRow>]
      : []),
    {
      id: "decisions", header: sortHeader(t("fleet.column.decisions"), "decisions"), width: 110,
      cell: () => <span className="text-xs text-muted-foreground">{t("fleet.unavailable")}</span>,
    },
  ];

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between space-y-0">
        <div>
          <CardTitle className="text-sm">{t("fleet.title")}</CardTitle>
          <CardDescription>{t("fleet.subtitle")}</CardDescription>
        </div>
        <Can gate={FEATURE_GATES.viewAgentFleet}>
          <Button
            size="sm" variant="outline" disabled={sorted.length === 0}
            onClick={exportInventory} aria-label={t("fleet.export.button")}
          >
            <Download className="mr-1.5 size-3.5" aria-hidden />
            {t("fleet.export.button")}
          </Button>
        </Can>
      </CardHeader>
      <CardContent>
        <div className="grid gap-3 xl:grid-cols-[1fr_360px]">
          <AsyncBoundary
            isLoading={query.isLoading} isError={query.isError} error={query.error}
            isEmpty={sorted.length === 0} emptyTitle={t("fleet.empty")} onRetry={() => query.refetch()}
          >
            <DataTable
              ariaLabel={t("fleet.title")}
              rows={sorted}
              columns={columns}
              rowId={(r) => r.key}
              onRowActivate={(r) => setSelectedKey(r.key)}
            />
          </AsyncBoundary>
          <AgentFleetDetail row={selected} onClose={() => setSelectedKey(null)} />
        </div>
      </CardContent>
    </Card>
  );
}

function sortFleetRows(rows: AgentFleetRow[], key: SortKey, dir: "asc" | "desc"): AgentFleetRow[] {
  if (!key) return rows;
  const mul = dir === "asc" ? 1 : -1;
  const valueOf = (r: AgentFleetRow): number | string => {
    if (key === "state") return r.lifecycle;
    if (key === "spend") return r.spend?.unavailable ? -1 : (r.spend?.periodUsd ?? -1);
    return 0; // decisions: always unavailable in slice 1 — nothing real to sort by.
  };
  return [...rows].sort((a, b) => {
    const va = valueOf(a);
    const vb = valueOf(b);
    if (typeof va === "string" || typeof vb === "string") return mul * String(va).localeCompare(String(vb));
    return mul * ((va as number) - (vb as number));
  });
}

/** Guardrail summary popover (ACT-FR-010) — Radix Popover composition
 * matching the only existing precedent, ProvenanceBadge.tsx. */
function GuardrailPopover({ row }: { row: AgentFleetRow }) {
  const g = row.guardrails;
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button
          type="button"
          className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium hover:bg-accent focus-visible:outline-none"
          aria-label={`Guardrails for ${row.display}`}
        >
          <ShieldCheck className="size-3" aria-hidden />
          {t("fleet.column.guardrails")}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content sideOffset={6} className="z-50 w-72 rounded-md border bg-card p-3 text-card-foreground shadow-md">
          <dl className="space-y-1 text-xs">
            <GuardrailRow label={t("fleet.guardrails.dataScope")} value={g.dataScope ? JSON.stringify(g.dataScope) : "—"} />
            <GuardrailRow label={t("fleet.guardrails.tokenBudget")} value={g.tokenBudget != null ? String(g.tokenBudget) : "—"} />
            <GuardrailRow label={t("fleet.guardrails.piiEgress")} value={g.piiEgress ?? "—"} />
            <GuardrailRow label={t("fleet.guardrails.ruleOfTwo")} value={g.ruleOfTwo ? "on" : "off"} />
          </dl>
          <Popover.Arrow className="fill-border" />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function GuardrailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="max-w-[65%] truncate text-right font-medium">{value}</dd>
    </div>
  );
}

/** Master-detail side panel (drill-in) — reuses the existing convention
 * (KillSwitchDetail / AgentCatalogCard's AgentDetail, page.tsx) rather than a
 * new /admin/agents/[key] route (no such route exists today, and a side
 * panel is strictly less net-new surface for slice 1). Kill/lift reuse the
 * exact existing mutations + authz (no new write path, ACT-NFR-003). */
function AgentFleetDetail({ row, onClose }: { row: AgentFleetRow | null; onClose: () => void }) {
  const create = useCreateAgentKillSwitch();
  const del = useDeleteAgentKillSwitch();
  const [confirmingKill, setConfirmingKill] = useState(false);

  if (!row) {
    return (
      <Card className="h-fit">
        <CardContent className="flex flex-col items-center gap-2 py-6 text-center text-sm text-muted-foreground">
          <ShieldCheck className="size-6" aria-hidden />
          <p>Select an agent to see its full guardrail + eval detail.</p>
        </CardContent>
      </Card>
    );
  }

  const killed = row.lifecycle === "KILLED";

  return (
    <Card className="h-fit">
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <CardTitle className="text-sm">{row.display}</CardTitle>
        <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close"><X className="size-4" /></Button>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        <p className="text-xs text-muted-foreground">
          {row.key} · v{row.activeVersion.id}
          {row.activeVersion.graphDigest && <> · <span className="font-mono">{row.activeVersion.graphDigest.slice(0, 12)}…</span></>}
        </p>
        <p className="text-xs">
          Toolset: {row.toolset.length ? row.toolset.join(", ") : <span className="text-muted-foreground">none</span>}
        </p>
        {row.evalGate.lastRunAt && (
          <p className="text-xs text-muted-foreground">Last eval run: {formatLocal(row.evalGate.lastRunAt)}</p>
        )}
        {row.killSwitch.state === "killed" && (
          <p className="text-xs text-destructive">
            Killed{row.killSwitch.actor ? ` by ${row.killSwitch.actor}` : ""}{row.killSwitch.updatedAt ? ` · ${formatLocal(row.killSwitch.updatedAt)}` : ""}
          </p>
        )}
        {killed ? (
          <Can gate={FEATURE_GATES.liftAgentKillSwitch}>
            <Button size="sm" variant="outline" disabled={del.isPending} onClick={() => setConfirmingKill(true)}>
              {t("killSwitch.lift")}
            </Button>
          </Can>
        ) : (
          <Can gate={FEATURE_GATES.createAgentKillSwitch}>
            <Button size="sm" variant="destructive" disabled={create.isPending} onClick={() => setConfirmingKill(true)}>
              {t("fleet.kill")}
            </Button>
          </Can>
        )}
      </CardContent>

      <ConfirmDialog
        open={confirmingKill}
        onOpenChange={setConfirmingKill}
        title={killed ? t("killSwitch.confirmLift.title") : t("killSwitch.confirmCreate.title")}
        description={killed ? t("killSwitch.confirmLift.description") : t("killSwitch.confirmCreate.description")}
        confirmLabel={killed ? t("killSwitch.lift") : t("fleet.kill")}
        confirmPhrase={killed ? undefined : row.key}
        destructive
        onConfirm={() => {
          setConfirmingKill(false);
          if (killed && row.killSwitch.id) {
            del.mutate(row.killSwitch.id);
          } else if (!killed) {
            create.mutate({ agentKey: row.key, reason: "Killed from Control Tower fleet table" });
          }
        }}
      />
    </Card>
  );
}
