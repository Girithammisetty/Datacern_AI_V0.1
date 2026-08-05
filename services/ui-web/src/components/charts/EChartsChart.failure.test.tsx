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
  // The OTHER branch — ECharts failing in a browser that DOES support canvas —
  // is covered in `tests-e2e/chart-engine-failure.spec.ts`, not here. jsdom has
  // no canvas at all, so this tier can only ever reach the expected-and-silent
  // path asserted below; and mocking `echarts/core`'s `init` to throw surfaces
  // as an unhandled test error rather than reaching the component's catch. The
  // e2e spec runs a real Chromium with `getContext("2d")` patched to return a
  // context missing the methods ECharts needs — how this fails in the wild.
  it("stays silent when the environment genuinely lacks canvas", () => {
    // Default jsdom: the feature gate returns before init, and the fallback
    // renders the same real data. Nothing failed, so nothing is reported.
    render(<EChartsChart kind="bar" columns={COLUMNS} rows={ROWS} fallback={<div>static</div>} />);
    expect(screen.queryByTestId("echarts-init-error")).not.toBeInTheDocument();
    expect(init).not.toHaveBeenCalled();
  });
});
