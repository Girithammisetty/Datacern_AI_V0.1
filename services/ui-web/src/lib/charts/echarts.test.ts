import { describe, it, expect } from "vitest";
import { buildEChartsOption, buildHeatmapOption, fmtNum, type ChartTheme } from "./echarts";
import { toChartModel, toHeatmapModel } from "./geometry";

const THEME: ChartTheme = {
  text: "#111", subtext: "#666", axis: "#ccc", split: "#eee",
  tooltipBg: "#fff", tooltipBorder: "#ddd", surface: "#fff",
};

const COLS = ["claim_type", "claim_count"];
const ROWS: unknown[][] = [["auto", 9], ["property", 3], ["health", 2]];

function seriesOf(opt: Record<string, unknown>) {
  return opt.series as Array<Record<string, unknown>>;
}

describe("buildEChartsOption", () => {
  it("builds a bar chart with category axis + value axis from shaped rows", () => {
    const opt = buildEChartsOption("bar", "vertical_bar_chart", toChartModel(COLS, ROWS), THEME);
    expect((opt.xAxis as { data: string[] }).data).toEqual(["auto", "property", "health"]);
    expect((opt.yAxis as { type: string }).type).toBe("value");
    expect(seriesOf(opt)[0].type).toBe("bar");
  });

  it("renders scatter_plot as a real scatter series (no longer degraded to bar)", () => {
    const opt = buildEChartsOption("bar", "scatter_plot", toChartModel(COLS, ROWS), THEME);
    expect(seriesOf(opt)[0].type).toBe("scatter");
  });

  it("renders an area chart type with an areaStyle", () => {
    const opt = buildEChartsOption("line", "area_chart", toChartModel(COLS, ROWS), THEME);
    const s = seriesOf(opt)[0];
    expect(s.type).toBe("line");
    expect(s.areaStyle).toBeTruthy();
  });

  it("stacks when the chart type asks for it", () => {
    const long: unknown[][] = [["EMEA", "auto", 5], ["EMEA", "home", 2], ["APAC", "auto", 4]];
    const opt = buildEChartsOption("bar", "vertical_stackedbar_chart", toChartModel(["region", "line", "v"], long), THEME);
    expect(seriesOf(opt).every((s) => s.stack === "total")).toBe(true);
  });

  it("builds a pie with one datum per category; donut sets a ring radius", () => {
    const pie = buildEChartsOption("pie", "pie_chart", toChartModel(COLS, ROWS), THEME);
    const s = seriesOf(pie)[0];
    expect(s.type).toBe("pie");
    expect((s.data as unknown[]).length).toBe(3);
    const donut = buildEChartsOption("pie", "donut_chart", toChartModel(COLS, ROWS), THEME);
    expect(Array.isArray(seriesOf(donut)[0].radius)).toBe(true);
  });

  it("dims non-selected bars when a cross-filter selection is active", () => {
    const opt = buildEChartsOption("bar", "vertical_bar_chart", toChartModel(COLS, ROWS), THEME, { selectedValue: "auto" });
    const data = seriesOf(opt)[0].data as Array<{ itemStyle: { opacity: number } }>;
    expect(data[0].itemStyle.opacity).toBe(1); // auto (selected)
    expect(data[1].itemStyle.opacity).toBeLessThan(1); // property (dimmed)
  });

  it("builds a gauge from the single measure value", () => {
    const opt = buildEChartsOption("gauge", "gauge_chart", toChartModel(["label", "sum_total"], [[117503.15]]), THEME);
    const s = seriesOf(opt)[0];
    expect(s.type).toBe("gauge");
    expect((s.data as Array<{ value: number }>)[0].value).toBeCloseTo(117503.15);
  });

  it("builds a funnel for funnel_chart", () => {
    const opt = buildEChartsOption("bar", "funnel_chart", toChartModel(COLS, ROWS), THEME);
    expect(seriesOf(opt)[0].type).toBe("funnel");
  });
});

describe("buildHeatmapOption", () => {
  it("maps [x,y,value] rows to a heatmap series + visualMap", () => {
    const model = toHeatmapModel(["region", "product", "value"], [["EMEA", "auto", 5], ["APAC", "home", 9]]);
    const opt = buildHeatmapOption(model, THEME);
    expect(seriesOf(opt)[0].type).toBe("heatmap");
    expect(opt.visualMap).toBeTruthy();
    expect((opt.series as Array<{ data: unknown[] }>)[0].data.length).toBe(2);
  });
});

describe("fmtNum", () => {
  it("compacts thousands and millions", () => {
    expect(fmtNum(117503.15)).toBe("117.5k");
    expect(fmtNum(2_400_000)).toBe("2.4M");
    expect(fmtNum(42)).toBe("42");
  });
});
