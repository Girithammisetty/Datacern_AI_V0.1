"use client";
import { useMemo } from "react";
import Link from "next/link";
import { Database, FlaskConical, BarChart3, Briefcase, Shield, Bot, Inbox, ScrollText, RefreshCw } from "lucide-react";
import { PageHeader } from "@/components/shell/PageHeader";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/primitives";
import { CostPanel } from "@/components/usage/CostPanel";
import { useMe, useProposalsInbox, useCaseSearch, useLearningLoop } from "@/lib/graphql/hooks";
import { useSession } from "@/lib/session/SessionContext";
import { useCapabilities } from "@/lib/authz/useCapabilities";
import { cap, role, ADMIN_ROLE, type Gate } from "@/lib/authz/registry";
import { CaseTitleCell, summarizeProjection } from "@/components/cases/projection";
import { t, type MessageKey } from "@/lib/i18n/messages";

/** Home tiles mirror the nav gates: only the areas the persona can reach show. */
const TILES: { href: string; icon: typeof Database; label: MessageKey; desc: string; gate: Gate }[] = [
  { href: "/data", icon: Database, label: "nav.data", desc: "Connections, ingestions, datasets", gate: cap("dataset.dataset.list") },
  { href: "/ml", icon: FlaskConical, label: "nav.ml", desc: "Experiments, runs, models", gate: cap("experiment.experiment.read") },
  { href: "/dashboards", icon: BarChart3, label: "nav.dashboards", desc: "Charts & dashboards", gate: cap("chart.dashboard.read") },
  { href: "/cases", icon: Briefcase, label: "nav.cases", desc: "Decision worklist", gate: cap("case.case.read") },
  { href: "/inbox", icon: Inbox, label: "nav.inbox", desc: "Agent proposals", gate: cap("ai.proposal.read") },
  { href: "/admin", icon: Shield, label: "nav.admin", desc: "Users, RBAC, budgets", gate: role(ADMIN_ROLE) },
];

/**
 * Persona-led home (decision-intelligence UX, not BI UX): the page leads with
 * the surface each persona DECIDES on, derived from live rbac capabilities —
 * the same rails that gate the nav, so packs' custom roles shape this without
 * any UI configuration.
 *   - decision-makers (disposition.create) land on their deadline-ranked queue
 *   - approvers (disposition.approve / bulk.approve) land on four-eyes work
 *   - auditors (audit.log.read without case writes) land on evidence surfaces
 *   - builders/admins keep the area tiles as the primary surface
 */
export default function HomePage() {
  const session = useSession();
  const { can } = useCapabilities();
  const canSeeInbox = can(cap("ai.proposal.read"));
  const canSeeCost = can(cap("usage.report.read"));
  const canWorkCases = can(cap("case.disposition.create"));
  const isApprover = can(cap("case.disposition.approve")) || can(cap("case.bulk.approve"));
  const isAuditor = can(cap("audit.log.read")) && !can(cap("case.case.update"));

  const { data: me } = useMe();
  const tenantLabel = me?.me.tenantName || session.tenantId;
  const workspaceLabel = me?.me.workspaceName || session.workspaceId;
  const roleLabel = me?.me.roles?.[0];

  const inbox = useProposalsInbox({ status: "PENDING" }, { enabled: canSeeInbox });
  const pending = inbox.data?.pages.reduce((n, p) => n + p.nodes.length, 0) ?? 0;

  const tiles = TILES.filter((tile) => can(tile.gate));
  const leadWithQueue = canWorkCases || isApprover;

  return (
    <div>
      <PageHeader
        title={roleLabel ? `Welcome, ${roleLabel}` : "Welcome"}
        description={`${tenantLabel} · ${workspaceLabel}`}
      />

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="min-w-0 space-y-4">
          {leadWithQueue && <DecisionQueueCard />}
          {isAuditor && <AuditorCard />}
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {tiles.map(({ href, icon: Icon, label, desc }) => (
              <Link key={href} href={href}>
                <Card className="h-full transition-colors hover:bg-accent/50">
                  <CardHeader>
                    <Icon className="size-5 text-primary" aria-hidden />
                    <CardTitle className="text-base">{t(label)}</CardTitle>
                  </CardHeader>
                  <CardContent className="text-sm text-muted-foreground">{desc}</CardContent>
                </Card>
              </Link>
            ))}
          </div>
        </div>

        <div className="space-y-4">
          {canSeeInbox && (
            <Card className={isApprover ? "border-ai/40" : undefined}>
              <CardHeader className="flex-row items-center gap-2">
                <Bot className="size-4 text-ai" aria-hidden />
                <CardTitle className="text-sm">
                  {isApprover ? "Awaiting your approval" : "Pending approvals"}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-3xl font-bold">{pending}</p>
                <Link href="/inbox" className="text-sm text-primary hover:underline">
                  Open approval inbox →
                </Link>
              </CardContent>
            </Card>
          )}
          {canSeeInbox && <LearningLoopCard />}
          {canSeeCost && <CostPanel workspaceId={session.workspaceId} />}
        </div>
      </div>
    </div>
  );
}

/**
 * The loop, made visible: what this tenant's human decisions have taught the
 * system (agent-runtime M1 transcript corpus -> M2 curated SFT datasets).
 * Every number is a real count from the governed corpus — when the loop
 * hasn't spun yet the card says so instead of showing invented progress.
 */
function LearningLoopCard() {
  const q = useLearningLoop();
  const s = q.data;
  const fmt = (n: number, capped: boolean) => (capped && n >= 200 ? "200+" : String(n));
  return (
    <Card>
      <CardHeader className="flex-row items-center gap-2">
        <RefreshCw className="size-4 text-ai" aria-hidden />
        <CardTitle className="text-sm">Learning loop</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        {q.isLoading && <p className="text-muted-foreground">Loading…</p>}
        {q.isError && <p className="text-muted-foreground">Loop stats unavailable.</p>}
        {s && (
          <>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <p className="text-2xl font-bold tabular-nums">{fmt(s.transcriptsCaptured, s.capped)}</p>
                <p className="text-xs text-muted-foreground">decisions captured</p>
              </div>
              <div>
                <p className="text-2xl font-bold tabular-nums">{fmt(s.correctionsCaptured, s.capped)}</p>
                <p className="text-xs text-muted-foreground">human corrections</p>
              </div>
            </div>
            {s.datasetCount > 0 ? (
              <p className="text-xs text-muted-foreground">
                Latest training set: v{s.latestDatasetVersion} ({s.latestDatasetExamples} gold examples
                {s.latestDatasetAgentKey ? ` · ${s.latestDatasetAgentKey}` : ""})
              </p>
            ) : (
              <p className="text-xs text-muted-foreground">
                Corrections you record become training data for the next model version.
              </p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * The decision-maker's landing surface: their open work, tightest regulatory
 * clock first (projection deadline, then due date) — a queue, never a report.
 */
function DecisionQueueCard() {
  const query = useCaseSearch({});
  const top = useMemo(() => {
    const rows = query.data?.pages.flatMap((p) => p.nodes) ?? [];
    return rows
      .filter((c) => c.status !== "RESOLVED" && c.status !== "CLOSED")
      .sort((a, b) => {
        const da = summarizeProjection(a.displayProjection)?.deadlineDays ?? Infinity;
        const db = summarizeProjection(b.displayProjection)?.deadlineDays ?? Infinity;
        if (da !== db) return da - db;
        return (a.dueDate ?? "").localeCompare(b.dueDate ?? "");
      })
      .slice(0, 5);
  }, [query.data]);

  return (
    <Card>
      <CardHeader className="flex-row items-center gap-2">
        <Briefcase className="size-4 text-primary" aria-hidden />
        <CardTitle className="text-sm">Your queue — tightest clocks first</CardTitle>
        <Link href="/cases" className="ml-auto text-sm text-primary hover:underline">
          Full worklist →
        </Link>
      </CardHeader>
      <CardContent>
        {query.isLoading && <p className="text-sm text-muted-foreground">Loading queue…</p>}
        {!query.isLoading && top.length === 0 && (
          <p className="text-sm text-muted-foreground">No open work — the queue is clear.</p>
        )}
        <ul className="divide-y overflow-hidden">
          {top.map((c) => (
            <li key={c.id} className="min-w-0">
              <Link
                href={`/cases/${c.id}`}
                className="block min-w-0 overflow-hidden rounded-md px-1 py-1.5 hover:bg-accent/50"
              >
                <CaseTitleCell c={c} />
              </Link>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

/** The auditor's landing surface: evidence chains, not worklists. */
function AuditorCard() {
  return (
    <Card>
      <CardHeader className="flex-row items-center gap-2">
        <ScrollText className="size-4 text-primary" aria-hidden />
        <CardTitle className="text-sm">Evidence &amp; audit</CardTitle>
      </CardHeader>
      <CardContent className="space-y-1 text-sm">
        <p className="text-muted-foreground">
          Every decision on this platform carries its provenance — reviewer, model, data version, timestamp.
        </p>
        <div className="flex flex-wrap gap-3 pt-1">
          <Link href="/admin/audit" className="text-primary hover:underline">Audit log →</Link>
          <Link href="/cases" className="text-primary hover:underline">Decided cases →</Link>
          <Link href="/dashboards" className="text-primary hover:underline">Program KPIs →</Link>
        </div>
      </CardContent>
    </Card>
  );
}
