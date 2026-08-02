"use client";
import { use, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Briefcase, FileDown, Pencil, Plus, Table2, Trash2, X } from "lucide-react";
import * as Dialog from "@radix-ui/react-dialog";
import { PageHeader } from "@/components/shell/PageHeader";
import { AsyncBoundary } from "@/components/primitives/AsyncBoundary";
import { ProvenanceBadge } from "@/components/primitives/ProvenanceBadge";
import { ConfirmDialog } from "@/components/primitives/ConfirmDialog";
import { Can } from "@/components/authz/Can";
import { Card, CardContent, CardHeader, CardTitle, Badge } from "@/components/ui/primitives";
import { Button } from "@/components/ui/button";
import { ChartView } from "@/components/charts/ChartView";
import { ChartEditor } from "@/components/charts/ChartEditor";
import { ChartExportButton } from "@/components/charts/ChartExportButton";
import { DatasetRowsGrid } from "@/components/data/DatasetRowsGrid";
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
import type { Chart } from "@/lib/graphql/types";
import {
  type CrossFilter,
  crossFilterField,
  selectedValueFor,
  toggleCrossFilter,
  toFilterVars,
} from "@/lib/charts/crossfilter";
import { t } from "@/lib/i18n/messages";

export default function DashboardDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const [filters, setFilters] = useState<CrossFilter[]>([]);
  const query = useDashboard(id, toFilterVars(filters));
  const dash = query.data?.dashboard;

  // origin chart id -> display name, for labelling the active-filter chips.
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

  // Drill-through → create cases: an active chart selection (cross-filter) is
  // resolved to its backing dataset + column, then the proven dataset-rows grid
  // opens pre-filtered to that segment so the manager can open cases from the
  // real underlying records (anchored to dataset_urn + row_pk, dashboard-tagged).
  // value=null → drill the whole grid (all records) rather than one clicked
  // segment, so a manager can browse the grid and bulk-select without a filter.
  const [drill, setDrill] = useState<{ chartId: string; field: string; value: string | null } | null>(null);
  const drillQ = useChartDrillTarget(drill?.chartId ?? null, drill?.field ?? null, {
    enabled: !!drill,
  });
  const drillTarget = drillQ.data?.chartDrillTarget ?? null;

  // Aggregate → raw-rows drilldown (chart-service POST /charts/{id}/drilldown,
  // CHART-FR-040): available on charts whose display_meta declares a drilldown
  // saved query; the clicked dimension/value arrives as a bind predicate.
  const [rowsDrill, setRowsDrill] = useState<{ chartId: string; name: string; dimension: string; value: string } | null>(null);
  const rowsDrillQ = useChartDrilldown(
    rowsDrill?.chartId ?? null,
    rowsDrill ? { dimension: rowsDrill.dimension, value: rowsDrill.value, limit: 50 } : null,
  );

  // Dashboard portability: download the export bundle as a JSON file (plain
  // JSON via GraphQL — no proxy needed, unlike the CSV artifact downloads).
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
          <>
            <PageHeader
              title={dash.title}
              actions={
                <>
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

            {filters.length > 0 && (
              <div className="mb-3 flex flex-wrap items-center gap-2" aria-label={t("dashboards.activeFilters")}>
                <span className="text-xs text-muted-foreground">{t("dashboards.filteredBy")}</span>
                {filters.map((f) => (
                  <button
                    key={`${f.origin}:${f.field}`}
                    type="button"
                    onClick={() => setFilters((cur) => cur.filter((x) => x.origin !== f.origin))}
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
                {/* Drill the FIRST active selection into its real records and open
                    cases from them (increment 1: one predicate at a time). */}
                <Can gate={cap("case.case.create")}>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-6 px-2 text-xs"
                    onClick={() =>
                      setDrill({ chartId: filters[0].origin, field: filters[0].field, value: filters[0].value })
                    }
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
              <div className="grid gap-4 lg:grid-cols-2">
                {dash.charts.map((chart) => {
                  // A chart is a cross-filter source when we can resolve the
                  // group-by dimension its clicks should filter on.
                  const field = crossFilterField(chart.config, chart.data?.columns);
                  const onSelect = field
                    ? (value: string) => setFilters((cur) => toggleCrossFilter(cur, chart.id, field, value))
                    : undefined;
                  // Aggregate → raw-rows drilldown is available when the chart's
                  // display_meta declares a drilldown saved query AND a segment
                  // is selected (the clicked value becomes the bind predicate).
                  const drilldownConfigured = Boolean(
                    (chart.displayMeta as { drilldown?: { query_urn?: string } } | null)?.drilldown?.query_urn,
                  );
                  const selected = selectedValueFor(filters, chart.id);
                  return (
                    <Card key={chart.id}>
                      <CardHeader className="flex-row items-start justify-between gap-2 space-y-0">
                        <div className="space-y-1">
                          <CardTitle className="text-sm">{chart.name ?? chart.urn}</CardTitle>
                          {chart.chartType && <Badge variant="outline">{chart.chartType}</Badge>}
                        </div>
                        <div className="flex items-center gap-2">
                          {/* AC-4: provenance badge on AI-generated charts. */}
                          <ProvenanceBadge provenance={chart.provenance} />
                          {drilldownConfigured && field && (
                            <Button
                              variant="ghost"
                              size="icon"
                              aria-label={`Drill into ${chart.name ?? chart.id}`}
                              title={selected != null ? "View underlying rows for the selection" : "Select a segment first to drill into its rows"}
                              disabled={selected == null}
                              onClick={() =>
                                selected != null &&
                                setRowsDrill({ chartId: chart.id, name: chart.name ?? chart.id, dimension: field, value: selected })
                              }
                            >
                              <Table2 />
                            </Button>
                          )}
                          <ChartExportButton chartId={chart.id} />
                          {/* A manager consuming a grid can bulk-create cases from
                              its records directly — no chart-click required. */}
                          {field && (chart.chartType === "grid_chart" || chart.chartType === "pivot_table_chart") && (
                            <Can gate={cap("case.case.create")}>
                              <Button
                                variant="ghost"
                                size="icon"
                                aria-label={t("dashboards.createCasesFromGrid")}
                                title={t("dashboards.createCasesFromGrid")}
                                onClick={() => setDrill({ chartId: chart.id, field, value: null })}
                              >
                                <Briefcase />
                              </Button>
                            </Can>
                          )}
                          <Can gate={FEATURE_GATES.editChart}>
                            <Button
                              variant="ghost"
                              size="icon"
                              aria-label={t("dashboards.editChart")}
                              onClick={() => {
                                setEditChart(chart);
                                setEditing(true);
                              }}
                            >
                              <Pencil />
                            </Button>
                          </Can>
                          <Can gate={FEATURE_GATES.deleteChart}>
                            <Button
                              variant="ghost"
                              size="icon"
                              aria-label={t("dashboards.deleteChart")}
                              onClick={() => setToDelete(chart)}
                            >
                              <Trash2 className="text-destructive" />
                            </Button>
                          </Can>
                        </div>
                      </CardHeader>
                      <CardContent>
                        <ChartView
                          chartType={chart.chartType}
                          columns={chart.data?.columns}
                          rows={chart.data?.rows}
                          artifact={chart.data?.artifact}
                          title={chart.name ?? undefined}
                          onSelect={onSelect}
                          selectedValue={selectedValueFor(filters, chart.id)}
                        />
                      </CardContent>
                    </Card>
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

            {/* Aggregate → raw-rows drilldown modal (chart-service
                POST /charts/{id}/drilldown): the clicked segment's dimension/
                value arrives as a bind predicate over the chart's drilldown
                saved query; first page capped at 50 rows. */}
            <Dialog.Root open={!!rowsDrill} onOpenChange={(o) => !o && setRowsDrill(null)}>
              <Dialog.Portal>
                <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40" />
                <Dialog.Content className="fixed left-1/2 top-1/2 z-50 max-h-[85vh] w-[min(900px,94vw)] -translate-x-1/2 -translate-y-1/2 overflow-auto rounded-lg border bg-background p-5 shadow-lg">
                  <div className="mb-3 flex items-start justify-between gap-2">
                    <div>
                      <Dialog.Title className="text-lg font-semibold">Underlying rows</Dialog.Title>
                      {rowsDrill && (
                        <Dialog.Description className="text-sm text-muted-foreground">
                          {rowsDrill.name} · {rowsDrill.dimension}:{" "}
                          <span className="font-medium">{rowsDrill.value}</span>
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
                    <p className="py-8 text-center text-sm text-destructive">
                      {(rowsDrillQ.error as Error).message}
                    </p>
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

            {/* Drill-through → create cases modal. Resolves the selected chart
                to its backing dataset, then hosts the proven dataset-rows grid
                pre-filtered to the clicked segment; cases carry dashboard_urn. */}
            <Dialog.Root open={!!drill} onOpenChange={(o) => !o && setDrill(null)}>
              <Dialog.Portal>
                <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40" />
                <Dialog.Content className="fixed left-1/2 top-1/2 z-50 max-h-[85vh] w-[min(1000px,94vw)] -translate-x-1/2 -translate-y-1/2 overflow-auto rounded-lg border bg-background p-5 shadow-lg">
                  <div className="mb-3 flex items-start justify-between gap-2">
                    <div>
                      <Dialog.Title className="text-lg font-semibold">
                        {t("dashboards.createCasesTitle")}
                      </Dialog.Title>
                      {drill && (
                        <Dialog.Description className="text-sm text-muted-foreground">
                          {drill.value != null ? (
                            <>
                              {(chartNames.get(drill.chartId) ?? drill.field)}:{" "}
                              <span className="font-medium">{drill.value}</span>
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
                    <p className="py-8 text-center text-sm text-muted-foreground">
                      {t("dashboards.createCasesNotDrillable")}
                    </p>
                  ) : (
                    <DatasetRowsGrid
                      datasetId={drillTarget.datasetId}
                      datasetUrn={drillTarget.datasetUrn}
                      dashboardUrn={dash.urn}
                      initialFilters={
                        drill?.value != null
                          ? [{ col: drillTarget.column, op: "eq", value: drill.value }]
                          : []
                      }
                    />
                  )}
                </Dialog.Content>
              </Dialog.Portal>
            </Dialog.Root>
          </>
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
              <th key={c} className="whitespace-nowrap px-3 py-2 font-medium">{c}</th>
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
