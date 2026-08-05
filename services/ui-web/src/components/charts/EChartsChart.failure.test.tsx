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
  // NOT COVERED BY A TEST — and here is exactly why, so the next person does not
  // repeat the three attempts this took.
  //
  // The branch: ECharts fails in a browser that DOES support canvas. The code is
  // there (`EChartsChart.tsx` wraps both `echarts.init` and `setOption`, logs the
  // real error, and sets `initError`); what is missing is a way to execute it.
  //
  //  1. jsdom has no canvas at all, so it always takes the OTHER branch — the
  //     expected, silent one asserted below. It can never reach this one.
  //  2. Mocking `echarts/core`'s `init` to throw does make it throw, but the
  //     exception surfaces as an unhandled test error rather than reaching the
  //     component's catch (a vitest/React-19 effect-boundary interaction, not a
  //     defect in the code under test).
  //  3. Playwright is the right tool — a real Chromium with a real canvas, with
  //     `getContext("2d")` patched to return a context missing the methods
  //     ECharts needs, which is how this fails in the wild (locked-down
  //     enterprise builds, GPU blocklists, fingerprinting blockers). It was
  //     written and run. It fails at a HARNESS limitation, not at the assertion:
  //     neither `/dashboards/[id]` nor `/embed/dashboard/[id]` renders a chart
  //     under `tests-e2e/`. The contract server serves chart data but is missing
  //     routes the app shell needs (`/api/v1/tenants/self` errors on every load),
  //     and the embed route requires a short-lived embed token from middleware.
  //     Covering this needs contract-server work first — a bigger change than the
  //     test, and not one to smuggle in here.
  //
  // Recorded rather than deleted quietly, and rather than left as a red test:
  // an unverified branch that everyone knows about is fine; one that looks
  // covered is not.
  it("stays silent when the environment genuinely lacks canvas", () => {
    // Default jsdom: the feature gate returns before init, and the fallback
    // renders the same real data. Nothing failed, so nothing is reported.
    render(<EChartsChart kind="bar" columns={COLUMNS} rows={ROWS} fallback={<div>static</div>} />);
    expect(screen.queryByTestId("echarts-init-error")).not.toBeInTheDocument();
    expect(init).not.toHaveBeenCalled();
  });
});
