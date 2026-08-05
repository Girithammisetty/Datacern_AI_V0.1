"use client";
import { useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  ArrowDown, ArrowUp, Briefcase, ChevronDown, ChevronUp, ChevronsUpDown, ExternalLink,
  Settings, X,
} from "lucide-react";
import { PageHeader } from "@/components/shell/PageHeader";
import { DataTable, type Column } from "@/components/primitives/DataTable";
import { AsyncBoundary } from "@/components/primitives/AsyncBoundary";
import { StatusChip } from "@/components/primitives/StatusChip";
import { Input } from "@/components/ui/primitives";
import { Button } from "@/components/ui/button";
import { useAssignableUsers, useCaseSearch } from "@/lib/graphql/hooks";
import { filterByInsight, insightBySlug, isLiveCase } from "@/lib/insights/cases";
import {
  readViewParams, slaAtRisk, sortCases, viewParamsToSearch,
  type CaseSortKey, type CaseViewParams,
} from "@/lib/cases/views";
import { useHubTopics } from "@/lib/realtime/useHubTopics";
import { useSession } from "@/lib/session/SessionContext";
import { useSelection, useToasts } from "@/stores/ui";
import { BulkAssignBar } from "@/components/cases/BulkAssignBar";
import { CaseViewsBar } from "@/components/cases/CaseViewsBar";
import { CaseWorkPane } from "@/components/cases/CaseWorkPane";
import { ShortcutsCheatsheet } from "@/components/cases/ShortcutsCheatsheet";
import { useWorkbenchShortcuts } from "@/components/cases/useWorkbenchShortcuts";
import { CaseTitleCell } from "@/components/cases/projection";
import { CaseExportButton } from "@/components/cases/CaseExportButton";
import { QueueIntelligencePanel } from "@/components/cases/QueueIntelligencePanel";
import { useCapabilities } from "@/lib/authz/useCapabilities";
import { FEATURE_GATES } from "@/lib/authz/registry";
import type { CaseTransitionKind } from "@/components/cases/CaseActionsBar";
import type { Case } from "@/lib/graphql/types";
import { formatLocal } from "@/lib/utils";
import { t } from "@/lib/i18n/messages";

const STATUSES = ["", "DRAFT", "UNASSIGNED", "IN_PROGRESS", "RESOLVED", "CLOSED"];
const SEVERITIES = ["", "LOW", "MEDIUM", "HIGH", "CRITICAL"];
/** Debounce for the search box — one router.replace per pause, not per key. */
const SEARCH_DEBOUNCE_MS = 300;

/**
 * The Case Workbench (master-detail worklist). The URL is the source of truth
 * for every filter/sort (UI-FR-043) — saved views just rewrite it — and the
 * right-hand pane opens a case IN PLACE (?c=<id>, no route change), with
 * prev/next stepping and auto-advance after a resolve/close, so working a
 * queue costs clicks, not navigations. /cases/<id> deep links still work.
 */
export default function CasesPage() {
  const router = useRouter();
  const params = useSearchParams();
  const session = useSession();
  const q = params.get("q") ?? "";
  const status = params.get("status") ?? "";
  const severity = params.get("severity") ?? "";
  const assignee = params.get("assignee") ?? "";
  const view = readViewParams(new URLSearchParams(params.toString()));
  const sort = view.sort;
  const dir = view.dir ?? "asc";
  const live = !!view.live;
  const sla = !!view.sla;

  // URL is source of truth for shareable view state (UI-FR-043). Reads the
  // LIVE location rather than the useSearchParams snapshot so the pane's
  // history.replaceState-managed ?c= param survives filter changes.
  const setParams = (patch: Record<string, string>) => {
    const next = new URLSearchParams(
      typeof window === "undefined" ? params.toString() : window.location.search,
    );
    for (const [key, value] of Object.entries(patch)) {
      if (value) next.set(key, value);
      else next.delete(key);
    }
    router.replace(`/cases?${next.toString()}`);
  };
  const setParam = (key: string, value: string) => setParams({ [key]: value });

  // Debounced search — the input is uncontrolled; the URL updates per pause.
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onSearchChange = (value: string) => {
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => setParam("q", value), SEARCH_DEBOUNCE_MS);
  };

  // assignee=me makes "My open cases" links portable between users; the real
  // filter value the server sees is always a concrete user id.
  const assigneeResolved = assignee === "me" ? session.userId : assignee;
  const filter = useMemo(
    () => ({
      status: status || undefined,
      severity: severity || undefined,
      assignee: assigneeResolved || undefined,
    }),
    [status, severity, assigneeResolved],
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
  // whole tenant was searched. ?live=1 / ?sla=1 (the built-in views) narrow
  // the same way, with the same predicates the insights/queue panel use.
  const insight = insightBySlug(params.get("insight"));
  const rows = useMemo(() => {
    const now = Date.now();
    let out = insight ? filterByInsight(loaded, insight.slug, now) : loaded;
    if (live) out = out.filter(isLiveCase);
    if (sla) out = out.filter((c) => slaAtRisk(c, now));
    // Client-side sort over the loaded window: caseSearch has no sort arg, so
    // this must never pretend to be a global order (hint rendered below).
    if (sort) out = sortCases(out, sort, dir);
    return out;
  }, [loaded, insight, live, sla, sort, dir]);
  const signature = `${q}|${status}|${severity}|${assignee}|${insight?.slug ?? ""}|${live ? "1" : ""}|${sla ? "1" : ""}`;
  const selection = useSelection();
  if (selection.signature !== signature) selection.setSignature(signature);

  // ---- work pane (?c=<id>) — local state + history.replaceState, so opening
  // a case never triggers a Next navigation or a list refetch. ----
  const [activeId, setActiveId] = useState<string | null>(() => params.get("c"));
  const push = useToasts((s) => s.push);
  const [announce, setAnnounce] = useState("");
  // Keyboard-first workbench: refs let / focus search and Enter focus the pane;
  // r/e/a click the pane's real (state-machine-gated) lifecycle buttons.
  const paneRef = useRef<HTMLElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [helpOpen, setHelpOpen] = useState(false);

  const syncCaseParam = (id: string | null) => {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    if (id) url.searchParams.set("c", id);
    else url.searchParams.delete("c");
    window.history.replaceState(null, "", url);
  };
  const openCase = (id: string | null) => {
    setActiveId(id);
    syncCaseParam(id);
  };

  const activeIndex = activeId ? rows.findIndex((c) => c.id === activeId) : -1;
  const step = (delta: number) => {
    const next = rows[activeIndex + delta];
    if (next) openCase(next.id);
  };

  // Page-scoped shortcuts (mounted only with this page — no ⌘K collision, no
  // firing while typing or inside a dialog). r/e/a drive the pane by clicking
  // its real buttons, so a hidden/illegal transition simply has no button to
  // click rather than a fabricated action.
  const clickPaneButton = (names: string[]) => {
    const pane = paneRef.current;
    if (!pane) return;
    const btn = Array.from(pane.querySelectorAll("button")).find((b) =>
      names.includes((b.textContent ?? "").trim()),
    );
    btn?.click();
  };
  useWorkbenchShortcuts({
    onNext: () => (activeId ? step(1) : rows[0] ? openCase(rows[0].id) : undefined),
    onPrev: () => (activeId ? step(-1) : rows[0] ? openCase(rows[0].id) : undefined),
    onFocusPane: () => paneRef.current?.querySelector<HTMLElement>("button, a, [tabindex]")?.focus(),
    onFocusSearch: () => searchRef.current?.focus(),
    onResolve: () => clickPaneButton(["Resolve"]),
    onEscalate: () => clickPaneButton(["Escalate"]),
    onAssign: () => clickPaneButton(["Assign", "Reassign"]),
    onHelp: () => setHelpOpen(true),
  });

  /** Auto-advance: after the pane resolves/closes a case, select the next one
   * in the CURRENT filtered order (no navigation, no manual re-pick). */
  const onAfterTransition = (kind: CaseTransitionKind) => {
    if (kind !== "resolve" && kind !== "close") return;
    const idx = activeId ? rows.findIndex((c) => c.id === activeId) : -1;
    const next = rows[idx + 1] ?? (idx > 0 ? rows[idx - 1] : null);
    if (next && next.id !== activeId) {
      openCase(next.id);
      push({ title: "Advanced to next case", variant: "default" });
      setAnnounce(`Advanced to next case${next.caseNumber != null ? ` #${next.caseNumber}` : ""}`);
    } else {
      setAnnounce("No more cases in this view");
    }
  };

  const applyView = (p: CaseViewParams) => {
    const search = viewParamsToSearch(p);
    // A view REPLACES the filter state wholesale (it is the whole point of a
    // view); the open pane, if any, is carried along.
    router.replace(`/cases?${search}${activeId ? `${search ? "&" : ""}c=${activeId}` : ""}`);
  };

  // Cases settings (dispositions / case fields / SLA) — visible to anyone who
  // can manage at least one of those surfaces; the pages re-gate per action.
  const { can } = useCapabilities();
  const canSeeSettings =
    can(FEATURE_GATES.manageDispositions) ||
    can(FEATURE_GATES.updateDisposition) ||
    can(FEATURE_GATES.manageCaseFields) ||
    can(FEATURE_GATES.manageSlaPolicy);

  // Member-safe user directory for the assignee facet (same query the assign
  // dialogs use, so the cache is shared).
  const usersQuery = useAssignableUsers();
  const users = useMemo(() => usersQuery.data?.pages.flatMap((p) => p.nodes) ?? [], [usersQuery.data]);

  // Sortable column headers: asc → desc → clear, DatasetRowsGrid's pattern.
  const toggleSort = (key: CaseSortKey) => {
    if (sort !== key) setParams({ sort: key, dir: "asc" });
    else if (dir === "asc") setParams({ sort: key, dir: "desc" });
    else setParams({ sort: "", dir: "" });
  };
  const sortHeader = (label: string, key: CaseSortKey) => (
    <button
      type="button"
      onClick={() => toggleSort(key)}
      className="flex items-center gap-1 font-medium hover:text-foreground"
      title={`Sort by ${label}`}
      aria-label={`Sort by ${label}`}
    >
      {label}
      {sort === key ? (
        dir === "asc" ? <ArrowUp className="size-3" aria-hidden /> : <ArrowDown className="size-3" aria-hidden />
      ) : (
        <ChevronsUpDown className="size-3 opacity-40" aria-hidden />
      )}
    </button>
  );

  const paneOpen = !!activeId;
  const columns: Column<Case>[] = paneOpen
    ? [
        // Narrower set while the pane is open — the pane carries the rest.
        { id: "num", header: t("cases.number"), width: 80, cell: (c) => <span className="font-mono">#{c.caseNumber ?? "—"}</span> },
        { id: "title", header: "Title", cell: (c) => <CaseTitleCell c={c} /> },
        { id: "severity", header: sortHeader(t("cases.severity"), "severity"), width: 100, cell: (c) => <StatusChip status={c.severity} /> },
        { id: "due", header: sortHeader(t("cases.due"), "due"), width: 130, cell: (c) => formatLocal(c.dueDate) },
      ]
    : [
        { id: "num", header: t("cases.number"), width: 90, cell: (c) => <span className="font-mono">#{c.caseNumber ?? "—"}</span> },
        { id: "title", header: "Title", cell: (c) => <CaseTitleCell c={c} /> },
        { id: "severity", header: sortHeader(t("cases.severity"), "severity"), width: 110, cell: (c) => <StatusChip status={c.severity} /> },
        { id: "status", header: sortHeader(t("cases.status"), "status"), width: 130, cell: (c) => <StatusChip status={c.status} live /> },
        { id: "assignee", header: t("cases.assignee"), width: 160, cell: (c) => c.assignee?.fullName ?? c.assignee?.email ?? "—" },
        { id: "due", header: sortHeader(t("cases.due"), "due"), width: 150, cell: (c) => formatLocal(c.dueDate) },
      ];

  const anyFilter = q || status || severity || assignee || sort || live || sla || insight;

  return (
    <div>
      <PageHeader
        title={t("cases.title")}
        description="Your team's work queue — every open case, ranked and searchable."
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

      {/* Auto-advance announcements for screen readers (visual toast above). */}
      <p aria-live="polite" role="status" className="sr-only">
        {announce}
      </p>

      {/* Queue health above the list: an approver's first question is "what is
          about to breach", not "which case is row 1". Gated on the same
          case.case.read the list already requires, so it needs no extra check —
          a caller who can see this page can see the aggregate over it. Hidden
          while the work pane is open — that mode is heads-down case work. */}
      {!paneOpen && (
        <div className="mb-4">
          <QueueIntelligencePanel />
        </div>
      )}

      <CaseViewsBar
        current={{
          q: q || undefined,
          status: status || undefined,
          severity: severity || undefined,
          assignee: assignee || undefined,
          sort,
          dir: sort ? dir : undefined,
          live: live || undefined,
          sla: sla || undefined,
          insight: insight?.slug,
        }}
        onApply={applyView}
      />

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Input
          ref={searchRef}
          placeholder="Search cases…"
          defaultValue={q}
          onChange={(e) => onSearchChange(e.target.value)}
          className="max-w-xs"
          aria-label="Search cases"
        />
        <Facet label="Status" value={status} options={STATUSES} onChange={(v) => setParam("status", v)} />
        <Facet label="Severity" value={severity} options={SEVERITIES} onChange={(v) => setParam("severity", v)} />
        <label className="flex items-center gap-1 text-sm">
          <span className="text-muted-foreground">Assignee</span>
          <select
            value={assignee}
            onChange={(e) => setParam("assignee", e.target.value)}
            className="h-9 rounded-md border border-input bg-background px-2 text-sm"
            aria-label="Filter by assignee"
          >
            <option value="">all</option>
            <option value="me">me</option>
            {users
              .filter((u) => u.id !== session.userId)
              .map((u) => (
                <option key={u.id} value={u.id}>
                  {u.fullName || u.email}
                </option>
              ))}
          </select>
        </label>
        <Button
          size="sm"
          variant={assignee === "me" ? "secondary" : "ghost"}
          aria-pressed={assignee === "me"}
          onClick={() => setParam("assignee", assignee === "me" ? "" : "me")}
        >
          Assigned to me
        </Button>
        {anyFilter && (
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

      {/* live/sla are client-side narrowings over the loaded window (CaseFilter
          cannot express them server-side) — same honesty as the insight banner. */}
      {(live || sla) && (
        <div
          role="status"
          className="mb-3 flex flex-wrap items-center gap-2 rounded-md border border-dashed bg-muted/30 px-3 py-2 text-sm"
        >
          <span className="font-medium text-foreground">Narrowed to:</span>
          <span className="text-muted-foreground">
            {[live && "open (non-terminal) cases", sla && "SLA at risk — overdue or due within 24h"]
              .filter(Boolean)
              .join(" · ")}
          </span>
          <span className="text-xs text-muted-foreground">
            {`(${rows.length} of the ${loaded.length} loaded${
              query.hasNextPage ? " — load more to widen the search" : ""
            })`}
          </span>
          <button
            type="button"
            onClick={() => setParams({ live: "", sla: "" })}
            className="ml-auto text-xs text-primary hover:underline"
          >
            Remove narrowing
          </button>
        </div>
      )}

      {sort && query.hasNextPage && (
        <p className="mb-2 text-xs text-muted-foreground" role="note">
          Sorted within the {rows.length} loaded results only — load more to widen the order.
        </p>
      )}

      <div className={paneOpen ? "grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]" : undefined}>
        <div className="min-w-0">
          <BulkAssignBar caseCount={rows.length} cases={rows} />

          <AsyncBoundary
            isLoading={query.isLoading}
            isError={query.isError}
            error={query.error}
            isEmpty={rows.length === 0}
            emptyTitle={insight || live || sla ? "No loaded cases match this view" : "No cases match these filters"}
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
              activeRowId={activeId ?? undefined}
              hasMore={query.hasNextPage}
              isFetchingMore={query.isFetchingNextPage}
              onLoadMore={() => query.fetchNextPage()}
              onRowActivate={(c) => openCase(c.id)}
              emptyState={
                <div className="flex flex-col items-center gap-2 p-10 text-muted-foreground">
                  <Briefcase className="size-8" />
                  <p>No cases</p>
                </div>
              }
            />
          </AsyncBoundary>
        </div>

        {paneOpen && activeId && (
          <aside
            ref={paneRef}
            aria-label="Case work pane"
            className="min-w-0 xl:sticky xl:top-4 xl:max-h-[calc(100vh-6rem)] xl:overflow-auto"
          >
            <div className="mb-2 flex items-center gap-1.5 text-sm">
              <span className="text-xs tabular-nums text-muted-foreground" data-testid="pane-position">
                {activeIndex >= 0 ? `${activeIndex + 1} of ${rows.length}` : "not in current view"}
              </span>
              <Button
                size="sm"
                variant="outline"
                className="h-7 px-2"
                disabled={activeIndex <= 0}
                onClick={() => step(-1)}
                aria-label="Previous case"
              >
                <ChevronUp className="size-3.5" aria-hidden />
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-7 px-2"
                disabled={activeIndex < 0 || activeIndex >= rows.length - 1}
                onClick={() => step(1)}
                aria-label="Next case"
              >
                <ChevronDown className="size-3.5" aria-hidden />
              </Button>
              <Button asChild size="sm" variant="ghost" className="ml-auto h-7">
                <Link href={`/cases/${activeId}`}>
                  <ExternalLink className="mr-1 size-3.5" aria-hidden />
                  Open full page
                </Link>
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 px-2"
                onClick={() => openCase(null)}
                aria-label="Close pane"
              >
                <X className="size-3.5" aria-hidden />
              </Button>
            </div>
            <CaseWorkPane caseId={activeId} onAfterTransition={onAfterTransition} />
          </aside>
        )}
      </div>

      {/* Subtle, honest affordance for the keyboard-first flow. */}
      <button
        type="button"
        onClick={() => setHelpOpen(true)}
        className="mt-3 text-xs text-muted-foreground hover:text-foreground"
      >
        {t("cases.workbench.shortcutsHint")}
      </button>
      <ShortcutsCheatsheet open={helpOpen} onOpenChange={setHelpOpen} />
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
