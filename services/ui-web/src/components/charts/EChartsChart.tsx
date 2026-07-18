"use client";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import * as echarts from "echarts/core";
import { BarChart, LineChart, PieChart, ScatterChart, HeatmapChart as EHeatmap, GaugeChart, FunnelChart } from "echarts/charts";
import { GridComponent, TooltipComponent, LegendComponent, DataZoomComponent, VisualMapComponent } from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import { LegacyGridContainLabel } from "echarts/features";
import { toChartModel, toHeatmapModel } from "@/lib/charts/geometry";
import { buildEChartsOption, buildHeatmapOption, type ChartTheme, type EChartsOption } from "@/lib/charts/echarts";

echarts.use([
  BarChart, LineChart, PieChart, ScatterChart, EHeatmap, GaugeChart, FunnelChart,
  GridComponent, TooltipComponent, LegendComponent, DataZoomComponent, VisualMapComponent,
  CanvasRenderer, LegacyGridContainLabel,
]);

type Kind = "bar" | "line" | "pie" | "heatmap" | "gauge";

/** Read a `--token` HSL triplet ("222 47% 11%") off the element and wrap it as a
 * usable CSS color; ECharts can't consume `currentColor`, so we resolve concrete
 * theme colors here and re-resolve when the viewer toggles theme. */
function hsl(el: Element, name: string, alpha?: number): string {
  const raw = getComputedStyle(el).getPropertyValue(name).trim();
  if (!raw) return alpha != null ? `rgba(120,120,120,${alpha})` : "#888";
  return alpha != null ? `hsl(${raw} / ${alpha})` : `hsl(${raw})`;
}
function resolveTheme(el: Element): ChartTheme {
  return {
    text: hsl(el, "--foreground"),
    subtext: hsl(el, "--muted-foreground"),
    axis: hsl(el, "--border"),
    split: hsl(el, "--border", 0.55),
    tooltipBg: hsl(el, "--card"),
    tooltipBorder: hsl(el, "--border"),
    surface: hsl(el, "--card"),
  };
}

/**
 * Interactive ECharts renderer behind the ChartView contract. Real tooltips,
 * legend, zoom, and animation; theme-aware in light + dark; cross-filter clicks
 * emit the clicked category and the active selection dims the rest (matching the
 * bespoke SVG renderers). Falls back to the SVG renderer (`fallback`) whenever
 * ECharts can't initialize — SSR, jsdom/tests, or a canvas-less environment —
 * so a chart is never blank and the existing renderer tests keep passing.
 */
export function EChartsChart({
  kind,
  chartType,
  columns,
  rows,
  title,
  desc,
  onSelect,
  selectedValue,
  height = 264,
  fallback,
}: {
  kind: Kind;
  chartType?: string | null;
  columns: unknown;
  rows: unknown;
  title?: string;
  desc?: string;
  onSelect?: (value: string) => void;
  selectedValue?: string | null;
  height?: number;
  fallback: ReactNode;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<echarts.ECharts | null>(null);
  const [ready, setReady] = useState(false);
  const [themeTick, setThemeTick] = useState(0);
  const reduceMotion = useRef(false);
  // The click handler is bound once, but `onSelect` becomes defined only after
  // the dashboard's data loads (its cross-filter field is derived from the
  // columns). Route clicks through a ref so the handler always calls the
  // current `onSelect` (or no-ops when the chart isn't a cross-filter source).
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;

  // Serialize the data inputs so the option only rebuilds when they truly change.
  const dataKey = useMemo(() => JSON.stringify({ columns, rows }), [columns, rows]);
  const hasSelect = !!onSelect; // stable boolean (only flips once, when data loads)

  const option: EChartsOption | null = useMemo(() => {
    const el = hostRef.current;
    if (!el) return null;
    const theme = resolveTheme(el);
    const opt =
      kind === "heatmap"
        ? buildHeatmapOption(toHeatmapModel(columns, rows), theme)
        : buildEChartsOption(kind, chartType, toChartModel(columns, rows), theme, {
            selectedValue,
            selectable: hasSelect,
          });
    if (reduceMotion.current) (opt as { animation?: boolean }).animation = false;
    return opt;
    // themeTick forces a re-resolve on theme toggle; dataKey covers columns/rows.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataKey, kind, chartType, selectedValue, hasSelect, themeTick, ready]);

  // Init once.
  useEffect(() => {
    const el = hostRef.current;
    if (!el || typeof window === "undefined") return;
    // Feature-gate on the APIs ECharts needs. jsdom (tests) and SSR lack a real
    // 2D canvas context and/or ResizeObserver — bail so the SVG fallback stays.
    const probe = document.createElement("canvas");
    if (typeof ResizeObserver === "undefined" || !probe.getContext || !probe.getContext("2d")) return;
    reduceMotion.current = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    let chart: echarts.ECharts | null = null;
    try {
      chart = echarts.init(el, undefined, { renderer: "canvas" });
    } catch {
      return; // canvas-less env → keep the SVG fallback
    }
    chartRef.current = chart;
    setReady(true);

    chart.on("click", (p: { name?: string }) => {
      if (p?.name != null) onSelectRef.current?.(String(p.name));
    });

    const ro = new ResizeObserver(() => chartRef.current?.resize());
    ro.observe(el);

    // Re-resolve colors when the app theme flips (data-theme attr) or the OS
    // scheme changes.
    const mo = new MutationObserver(() => setThemeTick((n) => n + 1));
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "class"] });
    const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
    const onScheme = () => setThemeTick((n) => n + 1);
    mq?.addEventListener?.("change", onScheme);

    return () => {
      ro.disconnect();
      mo.disconnect();
      mq?.removeEventListener?.("change", onScheme);
      chart?.dispose();
      chartRef.current = null;
    };
    // Init is intentionally once; onSelect identity changes are rare and handled
    // by the caller memoizing it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Push option updates.
  useEffect(() => {
    if (chartRef.current && option) {
      chartRef.current.setOption(option, { notMerge: true });
    }
  }, [option]);

  return (
    <div className="relative w-full" style={{ height }} data-testid="echarts-host">
      <div ref={hostRef} className="h-full w-full" role="img" aria-label={desc ? `${title ?? "Chart"} — ${desc}` : (title ?? "Chart")} />
      {!ready && <div className="absolute inset-0 overflow-hidden">{fallback}</div>}
    </div>
  );
}
