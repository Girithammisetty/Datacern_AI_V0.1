/**
 * BRD 72 — the axis-family types that were silently drawing a BAR CHART.
 *
 * All of these are `FamilyAxis` in chart-service, so the rows were already the
 * right shape; only the option was wrong. Each test asserts the property that
 * makes the type *that* type — a boxplot's five-number summary, a waterfall's
 * running total, a combination's second axis, a histogram's zero gap — rather
 * than just "some option came back".
 */
import { describe, it, expect } from "vitest";
import { toChartModel } from "./geometry";
import { buildEChartsOption, fiveNumberSummary } from "./echarts";

const THEME = {
  text: "#000", subtext: "#666", axis: "#ccc", split: "#eee",
  tooltipBg: "#fff", tooltipBorder: "#ddd", surface: "#fff",
};

const build = (chartType: string, columns: unknown, rows: unknown) =>
  buildEChartsOption("bar", chartType, toChartModel(columns, rows), THEME, {});

const seriesOf = (opt: Record<string, unknown>) => opt.series as Record<string, unknown>[];

describe("fiveNumberSummary", () => {
  it("returns [min, Q1, median, Q3, max] in ECharts' boxplot order", () => {
    expect(fiveNumberSummary([1, 2, 3, 4, 5])).toEqual([1, 2, 3, 4, 5]);
  });

  it("interpolates quartiles between samples", () => {
    expect(fiveNumberSummary([1, 2, 3, 4])).toEqual([1, 1.75, 2.5, 3.25, 4]);
  });

  it("is order-independent", () => {
    expect(fiveNumberSummary([5, 1, 3])).toEqual(fiveNumberSummary([1, 3, 5]));
  });

  it("handles an empty set without NaN", () => {
    expect(fiveNumberSummary([])).toEqual([0, 0, 0, 0, 0]);
  });
});

describe("whisker_chart → boxplot", () => {
  // The distribution per category is the set of SERIES values there — the shape
  // a whisker chart with a `dataseries` split produces.
  const opt = build(
    "whisker_chart",
    ["region", "q1", "q2", "q3"],
    [["EMEA", 10, 20, 30], ["APAC", 5, 5, 5]],
  );

  it("emits a boxplot series, not a bar series", () => {
    expect(seriesOf(opt)[0].type).toBe("boxplot");
  });

  it("summarises each category's series values", () => {
    const data = seriesOf(opt)[0].data as number[][];
    expect(data[0][0]).toBe(10); // min
    expect(data[0][2]).toBe(20); // median
    expect(data[0][4]).toBe(30); // max
  });

  it("degenerates to a point when there is no distribution to summarise", () => {
    // A whisker chart configured without a split has one value per category.
    // Collapsing to a point is the honest rendering, not a defect.
    const single = build("whisker_chart", ["region", "v"], [["EMEA", 7]]);
    expect((seriesOf(single)[0].data as number[][])[0]).toEqual([7, 7, 7, 7, 7]);
  });
});

describe("waterfall_chart", () => {
  const opt = build(
    "waterfall_chart",
    ["step", "delta"],
    [["open", 100], ["wins", 40], ["losses", -30], ["close", 10]],
  );
  const [base, up, down] = seriesOf(opt);

  it("stacks a transparent base under the visible bars", () => {
    expect(base.stack).toBe("wf");
    expect((base.itemStyle as { color: string }).color).toBe("transparent");
    expect(base.silent).toBe(true);
  });

  it("carries the running total in the base, so bars start where the last one ended", () => {
    // A NEGATIVE step's base sits at the LOWER end (total + delta) so the bar
    // spans downward from the previous total: after +100 +40 the total is 140,
    // so the -30 step's base is 110 and its bar rises from 110 to 140.
    expect(base.data as number[]).toEqual([0, 100, 110, 110]);
  });

  it("separates rises from falls so direction is visible", () => {
    expect(up.data as unknown[]).toEqual([100, 40, "-", 10]);
    expect(down.data as unknown[]).toEqual(["-", "-", 30, "-"]);
  });

  it("the final running total equals the sum of the deltas", () => {
    const b = base.data as number[];
    const u = up.data as (number | string)[];
    const last = typeof u[3] === "number" ? u[3] : 0;
    expect(b[3] + last).toBe(120); // 100 + 40 - 30 + 10
  });
});

describe("combination_chart", () => {
  const opt = build(
    "combination_chart",
    ["month", "claims", "denial_rate"],
    [["Jan", 900, 0.12], ["Feb", 1100, 0.09]],
  );

  it("renders the first measure as bars and the rest as lines", () => {
    const s = seriesOf(opt);
    expect(s[0].type).toBe("bar");
    expect(s[1].type).toBe("line");
  });

  it("puts the second measure on a SECOND axis — the point of the type", () => {
    // A count and a rate on one shared scale is unreadable, which is exactly
    // why the bar fallback was wrong here.
    expect(Array.isArray(opt.yAxis)).toBe(true);
    expect((opt.yAxis as unknown[]).length).toBe(2);
    expect(seriesOf(opt)[1].yAxisIndex).toBe(1);
  });

  it("uses a single axis when there is only one measure", () => {
    const one = build("combination_chart", ["month", "claims"], [["Jan", 900]]);
    expect(Array.isArray(one.yAxis)).toBe(false);
    expect(seriesOf(one)[0].yAxisIndex).toBe(0);
  });
});

describe("histogram_chart", () => {
  const opt = build("histogram_chart", ["bucket", "n"], [["0-10", 4], ["10-20", 9]]);

  it("removes the gap between bars — bins are contiguous, categories are not", () => {
    expect(seriesOf(opt)[0].barCategoryGap).toBe("0%");
    expect(seriesOf(opt)[0].barGap).toBe("0%");
  });

  it("still renders as bars over the bin labels", () => {
    expect(seriesOf(opt)[0].type).toBe("bar");
    expect((opt.xAxis as { data: string[] }).data).toEqual(["0-10", "10-20"]);
  });
});

describe("bubble_chart size channel", () => {
  it("uses the second measure as the radius, and does not draw it as its own series", () => {
    const opt = build(
      "bubble_chart",
      ["region", "revenue", "headcount"],
      [["EMEA", 100, 5], ["APAC", 200, 50]],
    );
    const s = seriesOf(opt);
    expect(s).toHaveLength(1); // the size measure is consumed, not plotted
    expect(s[0].type).toBe("scatter");
    expect(typeof s[0].symbolSize).toBe("function");
    const size = s[0].symbolSize as (v: unknown, p: { dataIndex: number }) => number;
    expect(size(null, { dataIndex: 1 })).toBeGreaterThan(size(null, { dataIndex: 0 }));
  });

  it("degrades to a fixed-size scatter with only one measure rather than inventing a dimension", () => {
    const opt = build("bubble_chart", ["region", "revenue"], [["EMEA", 100]]);
    expect(seriesOf(opt)[0].symbolSize).toBe(10);
  });

  it("scatter_plot is unaffected — it has no size channel", () => {
    const opt = build("scatter_plot", ["region", "a", "b"], [["EMEA", 1, 2]]);
    expect(seriesOf(opt)).toHaveLength(2);
    expect(seriesOf(opt)[0].symbolSize).toBe(10);
  });
});

describe("types that legitimately keep the existing paths", () => {
  it("funnel_chart still renders as a funnel", () => {
    const opt = build("funnel_chart", ["stage", "n"], [["lead", 10], ["won", 2]]);
    expect(seriesOf(opt)[0].type).toBe("funnel");
  });

  it("vertical_stackedbar_chart still stacks", () => {
    const opt = build("vertical_stackedbar_chart", ["m", "a", "b"], [["Jan", 1, 2]]);
    expect(seriesOf(opt)[0].stack).toBe("total");
  });

  it("a plain bar chart is untouched by the new branches", () => {
    const opt = build("vertical_bar_chart", ["m", "a"], [["Jan", 1]]);
    expect(seriesOf(opt)[0].type).toBe("bar");
    expect(seriesOf(opt)[0].barCategoryGap).toBeUndefined();
  });
});
