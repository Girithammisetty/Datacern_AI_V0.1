"use client";
import { useMemo } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Briefcase, Settings } from "lucide-react";
import { PageHeader } from "@/components/shell/PageHeader";
import { DataTable, type Column } from "@/components/primitives/DataTable";
import { AsyncBoundary } from "@/components/primitives/AsyncBoundary";
import { StatusChip } from "@/components/primitives/StatusChip";
import { Input } from "@/components/ui/primitives";
import { Button } from "@/components/ui/button";
import { useCaseSearch } from "@/lib/graphql/hooks";
import { filterByInsight, insightBySlug } from "@/lib/insights/cases";
import { useHubTopics } from "@/lib/realtime/useHubTopics";
import { useSelection } from "@/stores/ui";
import { BulkAssignBar } from "@/components/cases/BulkAssignBar";
import { CaseTitleCell } from "@/components/cases/projection";
import { CaseExportButton } from "@/components/cases/CaseExportButton";
import { useCapabilities } from "@/lib/authz/useCapabilities";
import { FEATURE_GATES } from "@/lib/authz/registry";
import type { Case } from "@/lib/graphql/types";
import { formatLocal } from "@/lib/utils";
import { t } from "@/lib/i18n/messages";

const STATUSES = ["", "DRAFT", "UNASSIGNED", "IN_PROGRESS", "RESOLVED", "CLOSED"];
const SEVERITIES = ["", "LOW", "MEDIUM", "HIGH", "CRITICAL"];

export default function CasesPage() {
  const router = useRouter();
  const params = useSearchParams();
  const q = params.get("q") ?? "";
  const status = params.get("status") ?? "";
  const severity = params.get("severity") ?? "";

  // URL is source of truth for shareable view state (UI-FR-043).
  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(params.toString());
    if (value) next.set(key, value);
    else next.delete(key);
    router.replace(`/cases?${next.toString()}`);
  };

  const filter = useMemo(
    () => ({ status: status || undefined, severity: severity || undefined }),
    [status, severity],
  );
  const query = useCaseSearch({ q: q || undefined, filter });
  // Task #80 adds the "all cases in my tenant" broadcast the task-#78 comment
  // here said didn't exist: the hub fans every case.* event to list:case and
  // the casePatcher patches the visible rows' status/severity in place (a case
  // for a workspace not in this cache is simply a no-op — no cross-workspace
  // row is inserted).
  useHubTopics(["list:case"]);

  const loaded = useMemo(() => query.data?.pages.flatMap((p) => p.nodes) ?? [], [query.data]);

  // ?insight=<slug> narrows the list with the SAME predicate that produced the
  // count on home (lib/insights/cases.ts), so the page a user lands on is the
  // evidence for the number they clicked. It is applied CLIENT-SIDE because
  // CaseFilter has only {status, severity, assignee} — case-service can neither
  // filter on dueDate nor on reassignCount — and therefore narrows only the
  // pages already loaded. The banner below says so rather than implying the
  // whole tenant was searched.
  const insight = insightBySlug(params.get("insight"));
  const rows = useMemo(
    () => (insight ? filterByInsight(loaded, insight.slug, Date.now()) : loaded),
    [loaded, insight],
  );
  const signature = `${q}|${status}|${severity}|${insight?.slug ?? ""}`;
  const selection = useSelection();
  if (selection.signature !== signature) selection.setSignature(signature);

  // Cases settings (dispositions / case fields / SLA) — visible to anyone who
  // can manage at least one of those surfaces; the pages re-gate per action.
  const { can } = useCapabilities();
  const canSeeSettings =
    can(FEATURE_GATES.manageDispositions) ||
    can(FEATURE_GATES.updateDisposition) ||
    can(FEATURE_GATES.manageCaseFields) ||
    can(FEATURE_GATES.manageSlaPolicy);

  const columns: Column<Case>[] = [
    { id: "num", header: t("cases.number"), width: 90, cell: (c) => <span className="font-mono">#{c.caseNumber ?? "—"}</span> },
    { id: "title", header: "Title", cell: (c) => <CaseTitleCell c={c} /> },
    { id: "severity", header: t("cases.severity"), width: 110, cell: (c) => <StatusChip status={c.severity} /> },
    { id: "status", header: t("cases.status"), width: 130, cell: (c) => <StatusChip status={c.status} live /> },
    { id: "assignee", header: t("cases.assignee"), width: 160, cell: (c) => c.assignee?.fullName ?? c.assignee?.email ?? "—" },
    { id: "due", header: t("cases.due"), width: 150, cell: (c) => formatLocal(c.dueDate) },
  ];

  return (
    <div>
      <PageHeader
        title={t("cases.title")}
        description="Every open decision, ranked and searchable."
        actions={
          <div className="flex items-center gap-2">
            <CaseExportButton status={status || undefined} />
            {canSeeSettings && (
              <Button asChild size="sm" variant="ghost">
                <Link href="/cases/settings">
                  <Settings className="mr-1 size-3.5" aria-hidden />
                  Settings
                </Link>
              </Button>
            )}
          </div>
        }
      />

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Input
          placeholder="Search cases…"
          defaultValue={q}
          onChange={(e) => setParam("q", e.target.value)}
          className="max-w-xs"
          aria-label="Search cases"
        />
        <Facet label="Status" value={status} options={STATUSES} onChange={(v) => setParam("status", v)} />
        <Facet label="Severity" value={severity} options={SEVERITIES} onChange={(v) => setParam("severity", v)} />
        {(q || status || severity || insight) && (
          <Button variant="ghost" size="sm" onClick={() => router.replace("/cases")}>
            Clear
          </Button>
        )}
      </div>

      {insight && (
        <div
          role="status"
          className="mb-3 flex flex-wrap items-center gap-2 rounded-md border border-dashed bg-muted/30 px-3 py-2 text-sm"
        >
          <span className="font-medium text-foreground">Showing:</span>
          <span className="text-muted-foreground">{insight.rule}</span>
          {/* One text node on purpose: JSX interpolation would split this
              across elements, which makes it unreadable to a screen reader as
              a single phrase and unassertable as one string. */}
          <span className="text-xs text-muted-foreground">
            {`(${rows.length} of the ${loaded.length} loaded${
              query.hasNextPage ? " — load more to widen the search" : ""
            })`}
          </span>
          <button
            type="button"
            onClick={() => setParam("insight", "")}
            className="ml-auto text-xs text-primary hover:underline"
          >
            Show all cases
          </button>
        </div>
      )}

      <BulkAssignBar caseCount={rows.length} />

      <AsyncBoundary
        isLoading={query.isLoading}
        isError={query.isError}
        error={query.error}
        isEmpty={rows.length === 0}
        emptyTitle={insight ? "No loaded cases match this insight" : "No cases match these filters"}
        onRetry={() => query.refetch()}
      >
        <DataTable
          ariaLabel="Cases"
          rows={rows}
          columns={columns}
          rowId={(c) => c.id}
          selectable
          selectedIds={selection.ids}
          onToggle={selection.toggle}
          hasMore={query.hasNextPage}
          isFetchingMore={query.isFetchingNextPage}
          onLoadMore={() => query.fetchNextPage()}
          onRowActivate={(c) => router.push(`/cases/${c.id}`)}
          emptyState={
            <div className="flex flex-col items-center gap-2 p-10 text-muted-foreground">
              <Briefcase className="size-8" />
              <p>No cases</p>
            </div>
          }
        />
      </AsyncBoundary>
    </div>
  );
}

function Facet({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: string[];
  onChange: (v: string) => void;
}) {
  return (
    <label className="flex items-center gap-1 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-9 rounded-md border border-input bg-background px-2 text-sm"
      >
        {options.map((o) => (
          <option key={o} value={o}>
            {o ? o.replaceAll("_", " ").toLowerCase() : "all"}
          </option>
        ))}
      </select>
    </label>
  );
}
