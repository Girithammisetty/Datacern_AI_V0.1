/**
 * Pure ECharts option builder (BRD 07 / Wave-0 viz). Maps the normalized
 * ChartModel / HeatmapModel (the same shapes the bespoke SVG renderers consume)
 * into an ECharts `option`. Kept dependency-free and side-effect-free so it is
 * unit-testable without a DOM — the component (EChartsChart) owns init/resize/
 * theme-observing; this module only shapes the option.
 *
 * The resolved `kind` (bar|line|pie|heatmap|gauge) picks the family; `chartType`
 * refines it for real fidelity the old renderers lacked — scatter/bubble no
 * longer degrade to bars, area/stacked/donut/funnel render as themselves.
 */
import { CHART_PALETTE, type ChartModel, type HeatmapModel } from "./geometry";

/** Concrete colors resolved from the app's CSS theme tokens at render time, so
 * ECharts (which cannot read `currentColor`) stays theme-aware in light + dark. */
export interface ChartTheme {
  text: string;
  subtext: string;
  axis: string;
  split: string;
  tooltipBg: string;
  tooltipBorder: string;
  surface: string;
}

/** A loose ECharts option type — the real one is enormous; we only set a subset. */
export type EChartsOption = Record<string, unknown>;

type Kind = "bar" | "line" | "pie" | "heatmap" | "gauge";

const AXIS_LABEL = (t: ChartTheme) => ({ color: t.subtext, fontSize: 11, hideOverlap: true });

function tooltip(t: ChartTheme, trigger: "axis" | "item") {
  return {
    trigger,
    backgroundColor: t.tooltipBg,
    borderColor: t.tooltipBorder,
    borderWidth: 1,
    textStyle: { color: t.text, fontSize: 12 },
    axisPointer: { type: trigger === "axis" ? "shadow" : "none" },
    extraCssText: "border-radius:8px;box-shadow:0 8px 28px -12px rgba(0,0,0,.35);",
  };
}

function legend(t: ChartTheme, show: boolean) {
  return show
    ? { show: true, type: "scroll", bottom: 0, textStyle: { color: t.subtext, fontSize: 11 }, itemWidth: 12, itemHeight: 12, icon: "roundRect" }
    : { show: false };
}

/** Dim categories that aren't the cross-filter selection (matches the SVG
 * renderers' "selected stays lit, others fade" behavior). */
function selOpacity(cat: string, selected?: string | null): number {
  if (selected == null) return 1;
  return String(cat) === String(selected) ? 1 : 0.28;
}

/**
 * Build the ECharts option for an axis / pie / gauge chart from a ChartModel.
 * `onSelectable` toggles the pointer cursor + emphasis affordance for cross-filter.
 */
export function buildEChartsOption(
  kind: Kind,
  chartType: string | null | undefined,
  model: ChartModel,
  theme: ChartTheme,
  opts: { selectedValue?: string | null; selectable?: boolean } = {},
): EChartsOption {
  const ct = (chartType ?? "").toLowerCase();
  const { categories, series } = model;
  const multi = series.length > 1;
  const palette = [...CHART_PALETTE];
  const base = { color: palette, textStyle: { color: theme.text }, animationDuration: 480, animationEasing: "cubicOut" };

  // ---- pie / donut / funnel -------------------------------------------------
  if (kind === "pie") {
    const s0 = series[0] ?? { name: "", values: [] };
    const isDonut = ct.includes("donut");
    const data = categories.map((c, i) => ({
      name: c,
      value: s0.values[i] ?? 0,
      itemStyle: { opacity: selOpacity(c, opts.selectedValue) },
    }));
    return {
      ...base,
      tooltip: tooltip(theme, "item"),
      legend: { ...legend(theme, categories.length <= 12), left: "center" },
      series: [
        {
          type: "pie",
          radius: isDonut ? ["46%", "72%"] : "68%",
          center: ["50%", "46%"],
          data,
          label: { color: theme.subtext, fontSize: 11 },
          labelLine: { lineStyle: { color: theme.split } },
          emphasis: { focus: "self", scaleSize: 6 },
          selectedMode: false,
        },
      ],
    };
  }

  if (ct === "funnel_chart") {
    const s0 = series[0] ?? { name: "", values: [] };
    const data = categories.map((c, i) => ({ name: c, value: s0.values[i] ?? 0 }));
    return {
      ...base,
      tooltip: tooltip(theme, "item"),
      legend: legend(theme, categories.length <= 12),
      series: [{ type: "funnel", left: "8%", right: "8%", top: 10, bottom: 30, gap: 2, data, label: { color: theme.text, fontSize: 11 }, labelLine: { show: false } }],
    };
  }

  // ---- gauge ----------------------------------------------------------------
  if (kind === "gauge") {
    const value = series[0]?.values[0] ?? 0;
    const label = series[0]?.name ?? "";
    return {
      ...base,
      tooltip: { show: false },
      series: [
        {
          type: "gauge",
          startAngle: 210,
          endAngle: -30,
          min: 0,
          max: niceMax(value),
          progress: { show: true, width: 14, itemStyle: { color: palette[0] } },
          axisLine: { lineStyle: { width: 14, color: [[1, theme.split]] } },
          axisTick: { show: false },
          splitLine: { length: 10, lineStyle: { color: theme.axis } },
          axisLabel: { color: theme.subtext, fontSize: 10, distance: 14 },
          pointer: { show: false },
          anchor: { show: false },
          title: { offsetCenter: [0, "26%"], color: theme.subtext, fontSize: 12 },
          detail: { valueAnimation: true, offsetCenter: [0, "-8%"], color: theme.text, fontSize: 26, fontWeight: 700, formatter: (v: number) => fmtNum(v) },
          data: [{ value, name: label }],
        },
      ],
    };
  }

  // ---- heatmap (from a ChartModel is not ideal; use buildHeatmapOption) ------
  // ---- bar / line / scatter / area / stacked --------------------------------
  const isScatter = ct.includes("scatter") || ct.includes("bubble");
  const isArea = ct.includes("area");
  const isStacked = ct.includes("stack");
  const rotate = categories.length > 8 ? 32 : 0;

  const echSeries = series.map((s, si) => {
    if (isScatter) {
      return {
        name: s.name,
        type: "scatter",
        symbolSize: 10,
        data: s.values.map((v, i) => [categories[i], v]),
        itemStyle: { color: palette[si % palette.length], opacity: 0.85 },
        emphasis: { focus: "series" },
      };
    }
    if (kind === "line") {
      return {
        name: s.name,
        type: "line",
        smooth: true,
        showSymbol: categories.length <= 24,
        symbolSize: 6,
        lineStyle: { width: 2.5 },
        stack: isStacked ? "total" : undefined,
        areaStyle: isArea ? { opacity: 0.16 } : undefined,
        data: s.values,
        emphasis: { focus: "series" },
      };
    }
    // bar (default)
    return {
      name: s.name,
      type: "bar",
      stack: isStacked ? "total" : undefined,
      barMaxWidth: 34,
      itemStyle: {
        color: palette[si % palette.length],
        borderRadius: isStacked ? 0 : [3, 3, 0, 0],
      },
      data: s.values.map((v, i) => ({
        value: v,
        itemStyle: { opacity: selOpacity(categories[i], opts.selectedValue) },
      })),
      emphasis: { focus: "series" },
      cursor: opts.selectable ? "pointer" : "default",
    };
  });

  const manyCats = categories.length > 14;
  return {
    ...base,
    tooltip: tooltip(theme, isScatter ? "item" : "axis"),
    legend: { ...legend(theme, multi), top: 0 },
    grid: { left: 8, right: 12, top: multi ? 30 : 12, bottom: manyCats ? 46 : 30, containLabel: true },
    xAxis: {
      type: "category",
      data: categories,
      axisLine: { lineStyle: { color: theme.axis } },
      axisTick: { show: false },
      axisLabel: { ...AXIS_LABEL(theme), rotate },
    },
    yAxis: {
      type: "value",
      axisLine: { show: false },
      axisTick: { show: false },
      splitLine: { lineStyle: { color: theme.split, type: "dashed" } },
      axisLabel: { ...AXIS_LABEL(theme), formatter: (v: number) => fmtNum(v) },
    },
    dataZoom: manyCats
      ? [{ type: "inside", filterMode: "none" }, { type: "slider", height: 14, bottom: 24, borderColor: theme.split, fillerColor: "transparent", handleStyle: { color: palette[0] }, textStyle: { color: theme.subtext, fontSize: 9 } }]
      : undefined,
    series: echSeries,
  };
}

/** Build the option for a real ECharts heatmap from the HeatmapModel. */
export function buildHeatmapOption(model: HeatmapModel, theme: ChartTheme): EChartsOption {
  const data = model.cells.map((c) => [c.xi, c.yi, c.value]);
  return {
    textStyle: { color: theme.text },
    tooltip: {
      ...tooltip(theme, "item"),
      formatter: (p: { value: [number, number, number] }) =>
        `${model.xCategories[p.value[0]]} · ${model.yCategories[p.value[1]]}: <b>${fmtNum(p.value[2])}</b>`,
    },
    grid: { left: 8, right: 12, top: 10, bottom: 46, containLabel: true },
    xAxis: { type: "category", data: model.xCategories, splitArea: { show: true }, axisLine: { lineStyle: { color: theme.axis } }, axisLabel: { ...AXIS_LABEL(theme), rotate: model.xCategories.length > 8 ? 32 : 0 } },
    yAxis: { type: "category", data: model.yCategories, splitArea: { show: true }, axisLine: { lineStyle: { color: theme.axis } }, axisLabel: AXIS_LABEL(theme) },
    visualMap: {
      min: 0,
      max: model.max || 1,
      calculable: true,
      orient: "horizontal",
      left: "center",
      bottom: 4,
      itemHeight: 90,
      textStyle: { color: theme.subtext, fontSize: 10 },
      inRange: { color: ["hsl(211 90% 92%)", "hsl(211 90% 62%)", "hsl(211 90% 36%)"] },
    },
    series: [{ type: "heatmap", data, emphasis: { itemStyle: { borderColor: theme.text, borderWidth: 1 } }, itemStyle: { borderColor: theme.surface, borderWidth: 1 } }],
  };
}

/** Compact number formatting for axes/labels (mirrors the SVG renderers). */
export function fmtNum(v: number): string {
  const a = Math.abs(v);
  if (a >= 1_000_000) return `${trim(v / 1_000_000)}M`;
  if (a >= 1_000) return `${trim(v / 1_000)}k`;
  return Number.isInteger(v) ? String(v) : trim(v);
}
function trim(v: number): string {
  return (Math.round(v * 10) / 10).toString();
}
/** Round a max up to a "nice" gauge ceiling so the arc isn't pinned. */
function niceMax(v: number): number {
  if (v <= 0) return 100;
  const mag = Math.pow(10, Math.floor(Math.log10(v)));
  return Math.ceil(v / mag) * mag;
}
