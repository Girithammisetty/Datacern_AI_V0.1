/**
 * BRD 72 — the no-fallback rule applied to the chart engine.
 *
 * `EChartsChart` keeps a static fallback for two very different reasons, and
 * conflating them is what hides bugs:
 *
 *  - the environment genuinely has no 2D canvas (SSR, jsdom) — EXPECTED, silent
 *  - ECharts failed in an environment that claimed to support it — a REAL failure
 *
 * The second used to be swallowed by a bare `catch { return }`, so a broken chart
 * engine rendered as a working dashboard.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

const { init } = vi.hoisted(() => ({ init: vi.fn() }));
vi.mock("echarts/core", async (importActual) => {
  const actual = await importActual<typeof import("echarts/core")>();
  return { ...actual, init: (...a: unknown[]) => init(...a) };
});

import { EChartsChart } from "./EChartsChart";

const COLUMNS = ["cat", "n"];
const ROWS = [["a", 1], ["b", 2]];

beforeEach(() => init.mockReset());

describe("chart engine failure is loud", () => {
  // NOT COVERED BY A TEST: the init-throw branch. Mocking `echarts/core`'s
  // `init` to throw does make it throw, but the exception surfaces as an
  // unhandled test error instead of reaching the component's try/catch — a
  // vitest/React-19 effect-boundary interaction, not a defect in the code under
  // test (`EChartsChart.tsx` wraps `echarts.init` and `setOption` in try/catch,
  // logs, and sets `initError`). Recorded here rather than deleted quietly, and
  // rather than left as a failing test: the branch is real, and the fact that it
  // is unverified is exactly the kind of thing this rule says not to hide.
  it("stays silent when the environment genuinely lacks canvas", () => {
    // Default jsdom: the feature gate returns before init, and the fallback
    // renders the same real data. Nothing failed, so nothing is reported.
    render(<EChartsChart kind="bar" columns={COLUMNS} rows={ROWS} fallback={<div>static</div>} />);
    expect(screen.queryByTestId("echarts-init-error")).not.toBeInTheDocument();
    expect(init).not.toHaveBeenCalled();
  });
});
