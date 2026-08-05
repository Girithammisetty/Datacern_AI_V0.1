"use client";
import { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Briefcase, Expand, Pencil, Table2, Trash2, X } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, Badge } from "@/components/ui/primitives";
import { Button } from "@/components/ui/button";
import { Can } from "@/components/authz/Can";
import { ProvenanceBadge } from "@/components/primitives/ProvenanceBadge";
import { ChartView } from "@/components/charts/ChartView";
import { ChartExportButton } from "@/components/charts/ChartExportButton";
import { FEATURE_GATES, cap } from "@/lib/authz/registry";
import { filterChartDataByTimeRange, isBoundedRange, type TimeRange } from "@/lib/dashboards/timeRange";
import type { Chart } from "@/lib/graphql/types";
import { t } from "@/lib/i18n/messages";

/**
 * One dashboard chart, with the rich-viewer additions layered over the existing
 * cross-filter / drilldown / authoring affordances:
 *   - the global time-range is applied here as an honest client-side post-filter
 *     over the points the chart already returned (a footer states how many of
 *     how many points are in range; a no-time-dimension chart says the range
 *     doesn't apply), and
 *   - a maximize button opens the same chart (same cross-filter selection) large
 *     in a modal; Esc / close returns.
 */
export function ChartCard({
  chart,
  field,
  selected,
  onSelect,
  range,
  onRowsDrill,
  onGridCases,
  onEdit,
  onDelete,
}: {
  chart: Chart;
  field: string | null;
  selected: string | null;
  onSelect?: (value: string) => void;
  range: TimeRange;
  onRowsDrill: (dimension: string, value: string) => void;
  onGridCases: (field: string) => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const [maximized, setMaximized] = useState(false);

  const drilldownConfigured = Boolean(
    (chart.displayMeta as { drilldown?: { query_urn?: string } } | null)?.drilldown?.query_urn,
  );
  const isGrid = chart.chartType === "grid_chart" || chart.chartType === "pivot_table_chart";

  const filtered = filterChartDataByTimeRange(chart.data?.columns, chart.data?.rows, range);
  const bounded = isBoundedRange(range);
  const title = chart.name ?? chart.urn;

  const chartEl = (
    <ChartView
      chartType={chart.chartType}
      columns={filtered.columns}
      rows={filtered.rows}
      graph={chart.data?.graph}
      artifact={chart.data?.artifact}
      title={chart.name ?? undefined}
      onSelect={onSelect}
      selectedValue={selected}
    />
  );

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-2 space-y-0">
        <div className="space-y-1">
          <CardTitle className="text-sm">{title}</CardTitle>
          {chart.chartType && <Badge variant="outline">{chart.chartType}</Badge>}
        </div>
        <div className="flex items-center gap-2">
          <ProvenanceBadge provenance={chart.provenance} />
          {drilldownConfigured && field && (
            <Button
              variant="ghost"
              size="icon"
              aria-label={`Drill into ${title}`}
              title={
                selected != null
                  ? "View underlying rows for the selection"
                  : "Select a segment first to drill into its rows"
              }
              disabled={selected == null}
              onClick={() => selected != null && onRowsDrill(field, selected)}
            >
              <Table2 />
            </Button>
          )}
          <ChartExportButton chartId={chart.id} />
          {field && isGrid && (
            <Can gate={cap("case.case.create")}>
              <Button
                variant="ghost"
                size="icon"
                aria-label={t("dashboards.createCasesFromGrid")}
                title={t("dashboards.createCasesFromGrid")}
                onClick={() => onGridCases(field)}
              >
                <Briefcase />
              </Button>
            </Can>
          )}
          <Button
            variant="ghost"
            size="icon"
            aria-label={t("dashboards.maximize")}
            title={t("dashboards.maximize")}
            onClick={() => setMaximized(true)}
          >
            <Expand />
          </Button>
          <Can gate={FEATURE_GATES.editChart}>
            <Button variant="ghost" size="icon" aria-label={t("dashboards.editChart")} onClick={onEdit}>
              <Pencil />
            </Button>
          </Can>
          <Can gate={FEATURE_GATES.deleteChart}>
            <Button variant="ghost" size="icon" aria-label={t("dashboards.deleteChart")} onClick={onDelete}>
              <Trash2 className="text-destructive" />
            </Button>
          </Can>
        </div>
      </CardHeader>
      <CardContent>
        {chartEl}
        {bounded && filtered.applicable && (
          <p className="mt-2 text-xs text-muted-foreground">
            {t("dashboards.timeRange.filteredPoints", { shown: filtered.shown, total: filtered.total })}
          </p>
        )}
        {bounded && !filtered.applicable && (
          <p className="mt-2 text-xs text-muted-foreground">{t("dashboards.timeRange.noTimeDimension")}</p>
        )}
      </CardContent>

      <Dialog.Root open={maximized} onOpenChange={setMaximized}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40" />
          <Dialog.Content className="fixed left-1/2 top-1/2 z-50 flex max-h-[92vh] w-[min(1200px,96vw)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-auto rounded-lg border bg-background p-5 shadow-lg">
            <div className="mb-3 flex items-start justify-between gap-2">
              <div>
                <Dialog.Title className="text-lg font-semibold">{title}</Dialog.Title>
                {chart.chartType && (
                  <Dialog.Description className="text-sm text-muted-foreground">
                    {chart.chartType}
                  </Dialog.Description>
                )}
              </div>
              <Dialog.Close asChild>
                <Button variant="ghost" size="icon" aria-label={t("dashboards.closeMaximized")}>
                  <X />
                </Button>
              </Dialog.Close>
            </div>
            <div className="min-h-[60vh] flex-1">{chartEl}</div>
            {bounded && filtered.applicable && (
              <p className="mt-2 text-xs text-muted-foreground">
                {t("dashboards.timeRange.filteredPoints", { shown: filtered.shown, total: filtered.total })}
              </p>
            )}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </Card>
  );
}
