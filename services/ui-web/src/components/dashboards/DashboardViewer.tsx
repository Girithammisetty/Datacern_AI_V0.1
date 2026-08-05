"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Briefcase, FileDown, Plus, Trash2, X } from "lucide-react";
import * as Dialog from "@radix-ui/react-dialog";
import { PageHeader } from "@/components/shell/PageHeader";
import { AsyncBoundary } from "@/components/primitives/AsyncBoundary";
import { ConfirmDialog } from "@/components/primitives/ConfirmDialog";
import { Can } from "@/components/authz/Can";
import { Badge } from "@/components/ui/primitives";
import { Button } from "@/components/ui/button";
import { ChartEditor } from "@/components/charts/ChartEditor";
import { DatasetRowsGrid } from "@/components/data/DatasetRowsGrid";
import { ChartCard } from "./ChartCard";
import { DashboardControls } from "./DashboardControls";
import { FEATURE_GATES, cap } from "@/lib/authz/registry";
import {
  useDashboard,
  useDeleteChart,
  useDeleteDashboard,
  useArchiveDashboard,
  useChartDrillTarget,
  useChartDrilldown,
  useExportDashboardBundle,
} from "@/lib/graphql/hooks";
import { useSession } from "@/lib/session/SessionContext";
import type { Chart } from "@/lib/graphql/types";
import {
  crossFilterField,
  selectedValueFor,
  toggleCrossFilter,
  toFilterVars,
  type CrossFilter,
} from "@/lib/charts/crossfilter";
import {
  readDashboardUrlState,
  writeDashboardUrlState,
  type DashboardUrlState,
} from "@/lib/dashboards/urlState";
import type { TimeRange } from "@/lib/dashboards/timeRange";
import { refreshMs, useRefreshInterval } from "@/lib/dashboards/autoRefresh";
import { isFullscreenActive, toggleFullscreen } from "@/lib/dashboards/fullscreen";
import { pushRecent } from "@/lib/dashboards/favorites";
import { t } from "@/lib/i18n/messages";

/**
 * The rich dashboard viewer. Extends the original board (cross-filter chips,
 * drill-through, chart authoring) with the "just look at it" affordances:
 * a URL-persisted global time-range + cross-filter set (so a filtered view is a
 * copyable link), auto-refresh with a last-updated stamp, a fullscreen TV mode,
 * and per-chart maximize. See the sibling lib/dashboards/* modules for the honest
 * boundaries (time-range is a client-side post-filter, not a server re-query).
 */
export function DashboardViewer({ id }: { id: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { userId, tenantId } = useSession();

  // Shareable state lives in the URL: cross-filter predicates + the time-range.
  const urlState = useMemo(
    () => readDashboardUrlState(new URLSearchParams(searchParams.toString())),
    [searchParams],
  );
  const filters = urlState.filters;
  const range = urlState.range;

  const updateUrl = useCallback(
    (next: Partial<DashboardUrlState>) => {
      const base = new URLSearchParams(searchParams.toString());
      const merged: DashboardUrlState = {
        filters: next.filters ?? filters,
        range: next.range ?? range,
      };
      const params = writeDashboardUrlState(base, merged);
      const qs = params.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [searchParams, filters, range, pathname, router],
  );

  const setFilters = useCallback((nextFilters: CrossFilter[]) => updateUrl({ filters: nextFilters }), [updateUrl]);
  const setRange = useCallback((nextRange: TimeRange) => updateUrl({ range: nextRange }), [updateUrl]);

  // Auto-refresh: persisted per dashboard; feeds react-query's refetchInterval.
  const { interval, setInterval: setRefreshInterval } = useRefreshInterval(id);
  const query = useDashboard(id, toFilterVars(filters), { refetchInterval: refreshMs(interval) });
  const dash = query.data?.dashboard;

  // Recently-viewed MRU (personal, localStorage) — record once the board loads.
  useEffect(() => {
    if (dash) pushRecent(tenantId, userId, { id, title: dash.title });
  }, [dash, tenantId, userId, id]);

  // Fullscreen ("TV mode"): request on the board container, track native state.
  const containerRef = useRef<HTMLDivElement>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  useEffect(() => {
    const onChange = () => setIsFullscreen(isFullscreenActive());
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);
  const onToggleFullscreen = useCallback(() => toggleFullscreen(containerRef.current), []);

  const chartNames = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of dash?.charts ?? []) m.set(c.id, c.name ?? c.urn);
    return m;
  }, [dash]);

  const [editing, setEditing] = useState(false);
  const [editChart, setEditChart] = useState<Chart | null>(null);
  const [toDelete, setToDelete] = useState<Chart | null>(null);
  const deleteMutation = useDeleteChart(id);
  const [confirmDeleteDash, setConfirmDeleteDash] = useState(false);
  const [confirmArchiveDash, setConfirmArchiveDash] = useState(false);
  const deleteDashboard = useDeleteDashboard();
  const archiveDashboard = useArchiveDashboard();

  const [drill, setDrill] = useState<{ chartId: string; field: string; value: string | null } | null>(null);
  const drillQ = useChartDrillTarget(drill?.chartId ?? null, drill?.field ?? null, { enabled: !!drill });
  const drillTarget = drillQ.data?.chartDrillTarget ?? null;

  const [rowsDrill, setRowsDrill] = useState<{ chartId: string; name: string; dimension: string; value: string } | null>(null);
  const rowsDrillQ = useChartDrilldown(
    rowsDrill?.chartId ?? null,
    rowsDrill ? { dimension: rowsDrill.dimension, value: rowsDrill.value, limit: 50 } : null,
  );

  const exportBundle = useExportDashboardBundle();
  const downloadBundle = () =>
    exportBundle.mutate(id, {
      onSuccess: (bundle) => {
        const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `dashboard-${id}.bundle.json`;
        a.click();
        URL.revokeObjectURL(url);
      },
    });

  const controls = dash ? (
    <DashboardControls
      range={range}
      onRangeChange={setRange}
      interval={interval}
      onIntervalChange={setRefreshInterval}
      onRefresh={() => query.refetch()}
      lastUpdated={query.dataUpdatedAt || null}
      isFetching={query.isFetching}
      isFullscreen={isFullscreen}
      onToggleFullscreen={onToggleFullscreen}
    />
  ) : null;

  return (
    <div>
      <AsyncBoundary
        isLoading={query.isLoading}
        isError={query.isError}
        error={query.error}
        isEmpty={!query.isLoading && !dash}
        emptyTitle={t("dashboards.notFound")}
        onRetry={() => query.refetch()}
      >
        {dash && (
          <div ref={containerRef} className={isFullscreen ? "fixed inset-0 z-40 overflow-auto bg-background p-6" : undefined}>
            {isFullscreen ? (
              <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                <h1 className="text-lg font-semibold tracking-tight">{dash.title}</h1>
                {controls}
              </div>
            ) : (
              <PageHeader
                title={dash.title}
                actions={
                  <>
                    {controls}
                    {dash.module && <Badge variant="secondary">{dash.module}</Badge>}
                    <Can gate={FEATURE_GATES.createDashboard}>
                      <Button
                        onClick={() => {
                          setEditChart(null);
                          setEditing(true);
                        }}
                      >
                        <Plus /> {t("dashboards.addChart")}
                      </Button>
                    </Can>
                    <Can gate={FEATURE_GATES.exportDashboardBundle}>
                      <Button variant="outline" onClick={downloadBundle} disabled={exportBundle.isPending}>
                        <FileDown /> {exportBundle.isPending ? "Exporting…" : "Export bundle"}
                      </Button>
                    </Can>
                    {!dash.archived && (
                      <Can gate={FEATURE_GATES.archiveDashboard}>
                        <Button variant="outline" onClick={() => setConfirmArchiveDash(true)}>
                          {t("dashboards.archive")}
                        </Button>
                      </Can>
                    )}
                    <Can gate={FEATURE_GATES.deleteDashboard}>
                      <Button variant="outline" onClick={() => setConfirmDeleteDash(true)}>
                        <Trash2 className="text-destructive" /> {t("dashboards.deleteDashboard")}
                      </Button>
                    </Can>
                  </>
                }
              />
            )}

            {filters.length > 0 && (
              <div className="mb-3 flex flex-wrap items-center gap-2" aria-label={t("dashboards.activeFilters")}>
                <span className="text-xs text-muted-foreground">{t("dashboards.filteredBy")}</span>
                {filters.map((f) => (
                  <button
                    key={`${f.origin}:${f.field}`}
                    type="button"
                    onClick={() => setFilters(filters.filter((x) => x.origin !== f.origin))}
                    className="inline-flex items-center gap-1 rounded-full border bg-accent/40 px-2.5 py-0.5 text-xs hover:bg-accent"
                  >
                    <span className="text-muted-foreground">{chartNames.get(f.origin) ?? f.field}:</span>
                    <span className="font-medium">{f.value}</span>
                    <X className="size-3" aria-hidden />
                    <span className="sr-only">{t("dashboards.removeFilter")}</span>
                  </button>
                ))}
                <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={() => setFilters([])}>
                  {t("dashboards.clearFilters")}
                </Button>
                <Can gate={cap("case.case.create")}>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-6 px-2 text-xs"
                    onClick={() => setDrill({ chartId: filters[0].origin, field: filters[0].field, value: filters[0].value })}
                  >
                    <Briefcase className="size-3" /> {t("dashboards.createCasesFromSelection")}
                  </Button>
                </Can>
              </div>
            )}

            {dash.charts.length === 0 ? (
              <div className="rounded-lg border border-dashed p-10 text-center">
                <p className="text-sm text-muted-foreground">{t("dashboards.noCharts")}</p>
                <Can gate={FEATURE_GATES.createDashboard}>
                  <Button
                    className="mt-3"
                    onClick={() => {
                      setEditChart(null);
                      setEditing(true);
                    }}
                  >
                    <Plus /> {t("dashboards.addChart")}
                  </Button>
                </Can>
              </div>
            ) : (
              <div className={`grid gap-4 lg:grid-cols-2${isFullscreen ? " xl:grid-cols-3" : ""}`}>
                {dash.charts.map((chart) => {
                  const field = crossFilterField(chart.config, chart.data?.columns);
                  const onSelect = field
                    ? (value: string) => setFilters(toggleCrossFilter(filters, chart.id, field, value))
                    : undefined;
                  return (
                    <ChartCard
                      key={chart.id}
                      chart={chart}
                      field={field}
                      selected={selectedValueFor(filters, chart.id)}
                      onSelect={onSelect}
                      range={range}
                      onRowsDrill={(dimension, value) =>
                        setRowsDrill({ chartId: chart.id, name: chart.name ?? chart.id, dimension, value })
                      }
                      onGridCases={(f) => setDrill({ chartId: chart.id, field: f, value: null })}
                      onEdit={() => {
                        setEditChart(chart);
                        setEditing(true);
                      }}
                      onDelete={() => setToDelete(chart)}
                    />
                  );
                })}
              </div>
            )}

            <ChartEditor
              dashboardId={id}
              open={editing}
              editChart={editChart}
              onOpenChange={(o) => {
                setEditing(o);
                if (!o) setEditChart(null);
              }}
              onSaved={() => query.refetch()}
            />

            <ConfirmDialog
              open={!!toDelete}
              onOpenChange={(o) => !o && setToDelete(null)}
              title={t("dashboards.deleteChart")}
              description={t("dashboards.deleteChartConfirm", { name: toDelete?.name ?? toDelete?.urn ?? "" })}
              confirmLabel={t("dashboards.deleteChart")}
              destructive
              onConfirm={() => {
                if (toDelete) deleteMutation.mutate(toDelete.id, { onSettled: () => setToDelete(null) });
              }}
            />

            <ConfirmDialog
              open={confirmArchiveDash}
              onOpenChange={setConfirmArchiveDash}
              title={t("dashboards.archive")}
              description={t("dashboards.archiveConfirm", { name: dash.title })}
              confirmLabel={t("dashboards.archive")}
              destructive
              onConfirm={() => {
                if (archiveDashboard.isPending) return;
                archiveDashboard.mutate(id, {
                  onSuccess: () => {
                    setConfirmArchiveDash(false);
                    router.push("/dashboards");
                  },
                });
              }}
            />

            <ConfirmDialog
              open={confirmDeleteDash}
              onOpenChange={setConfirmDeleteDash}
              title={t("dashboards.deleteDashboard")}
              description={t("dashboards.deleteDashboardConfirm", { name: dash.title })}
              confirmLabel={t("dashboards.deleteDashboard")}
              destructive
              onConfirm={() => {
                if (deleteDashboard.isPending) return;
                deleteDashboard.mutate(id, {
                  onSuccess: () => {
                    setConfirmDeleteDash(false);
                    router.push("/dashboards");
                  },
                });
              }}
            />

            <Dialog.Root open={!!rowsDrill} onOpenChange={(o) => !o && setRowsDrill(null)}>
              <Dialog.Portal>
                <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40" />
                <Dialog.Content className="fixed left-1/2 top-1/2 z-50 max-h-[85vh] w-[min(900px,94vw)] -translate-x-1/2 -translate-y-1/2 overflow-auto rounded-lg border bg-background p-5 shadow-lg">
                  <div className="mb-3 flex items-start justify-between gap-2">
                    <div>
                      <Dialog.Title className="text-lg font-semibold">Underlying rows</Dialog.Title>
                      {rowsDrill && (
                        <Dialog.Description className="text-sm text-muted-foreground">
                          {rowsDrill.name} · {rowsDrill.dimension}: <span className="font-medium">{rowsDrill.value}</span>
                        </Dialog.Description>
                      )}
                    </div>
                    <Dialog.Close asChild>
                      <Button variant="ghost" size="icon" aria-label="Close drilldown">
                        <X />
                      </Button>
                    </Dialog.Close>
                  </div>
                  {rowsDrillQ.isFetching && !rowsDrillQ.data ? (
                    <p className="py-8 text-center text-sm text-muted-foreground">{t("state.loading")}</p>
                  ) : rowsDrillQ.isError ? (
                    <p className="py-8 text-center text-sm text-destructive">{(rowsDrillQ.error as Error).message}</p>
                  ) : (
                    <DrilldownRowsTable
                      columns={rowsDrillQ.data?.columns}
                      rows={rowsDrillQ.data?.rows}
                      hasMore={rowsDrillQ.data?.hasMore ?? false}
                    />
                  )}
                </Dialog.Content>
              </Dialog.Portal>
            </Dialog.Root>

            <Dialog.Root open={!!drill} onOpenChange={(o) => !o && setDrill(null)}>
              <Dialog.Portal>
                <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40" />
                <Dialog.Content className="fixed left-1/2 top-1/2 z-50 max-h-[85vh] w-[min(1000px,94vw)] -translate-x-1/2 -translate-y-1/2 overflow-auto rounded-lg border bg-background p-5 shadow-lg">
                  <div className="mb-3 flex items-start justify-between gap-2">
                    <div>
                      <Dialog.Title className="text-lg font-semibold">{t("dashboards.createCasesTitle")}</Dialog.Title>
                      {drill && (
                        <Dialog.Description className="text-sm text-muted-foreground">
                          {drill.value != null ? (
                            <>
                              {chartNames.get(drill.chartId) ?? drill.field}: <span className="font-medium">{drill.value}</span>
                            </>
                          ) : (
                            <span className="font-medium">{chartNames.get(drill.chartId) ?? t("dashboards.allRecords")}</span>
                          )}
                        </Dialog.Description>
                      )}
                    </div>
                    <Dialog.Close asChild>
                      <Button variant="ghost" size="icon" aria-label={t("dashboards.createCasesClose")}>
                        <X />
                      </Button>
                    </Dialog.Close>
                  </div>
                  {drillQ.isFetching && !drillTarget ? (
                    <p className="py-8 text-center text-sm text-muted-foreground">{t("state.loading")}</p>
                  ) : !drillTarget ? (
                    <p className="py-8 text-center text-sm text-muted-foreground">{t("dashboards.createCasesNotDrillable")}</p>
                  ) : (
                    <DatasetRowsGrid
                      datasetId={drillTarget.datasetId}
                      datasetUrn={drillTarget.datasetUrn}
                      dashboardUrn={dash.urn}
                      initialFilters={
                        drill?.value != null ? [{ col: drillTarget.column, op: "eq", value: drill.value }] : []
                      }
                    />
                  )}
                </Dialog.Content>
              </Dialog.Portal>
            </Dialog.Root>
          </div>
        )}
      </AsyncBoundary>
    </div>
  );
}

/** Render a drilldown page: columns are query-service exec columns
 * ({name,type} objects or bare strings); rows are positional cell arrays. */
function DrilldownRowsTable({
  columns,
  rows,
  hasMore,
}: {
  columns?: unknown;
  rows?: unknown;
  hasMore: boolean;
}) {
  const cols = (Array.isArray(columns) ? columns : []).map((c) =>
    typeof c === "string" ? c : String((c as { name?: unknown })?.name ?? ""),
  );
  const rowList = (Array.isArray(rows) ? rows : []) as unknown[][];
  if (cols.length === 0 && rowList.length === 0) {
    return <p className="py-8 text-center text-sm text-muted-foreground">No rows behind this segment.</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-sm" aria-label="Drilldown rows">
        <thead>
          <tr className="border-b bg-muted/40 text-left">
            {cols.map((c) => (
              <th key={c} className="whitespace-nowrap px-3 py-2 font-medium">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rowList.map((row, i) => (
            <tr key={i} className="border-b last:border-0">
              {cols.map((c, j) => {
                const v = Array.isArray(row) ? row[j] : (row as Record<string, unknown>)[c];
                return (
                  <td key={c} className="whitespace-nowrap px-3 py-1.5 font-mono text-xs tabular-nums">
                    {v == null ? "∅" : typeof v === "object" ? JSON.stringify(v) : String(v)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      {hasMore && (
        <p className="border-t px-3 py-2 text-xs text-muted-foreground">
          Showing the first page; more rows exist behind this segment.
        </p>
      )}
    </div>
  );
}
