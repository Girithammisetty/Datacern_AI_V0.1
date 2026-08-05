import { test, expect } from "@playwright/test";

/** Same flow journey.spec.ts uses; inlined because it does not export it. */
async function login(page: import("@playwright/test").Page) {
  await page.goto("/login");
  await page.getByLabel("Email").fill("adjuster@acme.com");
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL("**/");
  await expect(page.getByRole("heading", { name: /welcome/i })).toBeVisible();
}

/**
 * BRD 72 / the no-fallback rule — the branch jsdom cannot reach.
 *
 * `EChartsChart` keeps a static fallback for two very different reasons:
 *
 *  - the environment genuinely has no 2D canvas (SSR, jsdom) — EXPECTED, silent
 *  - ECharts failed in an environment that CLAIMED canvas support — a REAL failure
 *
 * The second used to be a bare `catch { return }`, so a broken chart engine
 * rendered as a working dashboard: every card showed a static chart and nothing
 * said why. The unit tier cannot cover it — jsdom has no canvas at all, so it
 * always takes the FIRST path. Hence a real Chromium with a real canvas.
 *
 * The failure is induced the way it actually happens in the wild: a browser that
 * reports canvas support and then hands back a context missing methods ECharts
 * needs (locked-down enterprise builds, GPU blocklists, canvas-fingerprinting
 * blockers). ECharts itself is NOT stubbed — the canvas underneath it is broken
 * and the real library is left to fail on its own.
 */
const BREAK_CANVAS = () => {
  const real = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (kind: string, ...rest: unknown[]) {
    if (kind !== "2d") {
      return (real as unknown as (...a: unknown[]) => unknown).call(this, kind, ...rest);
    }
    // Truthy — so the component's `probe.getContext("2d")` feature gate passes —
    // but missing the text-metric API ECharts calls while initializing.
    return { canvas: this, save() {}, restore() {}, scale() {} } as unknown as CanvasRenderingContext2D;
  } as typeof HTMLCanvasElement.prototype.getContext;
};

test("a chart engine that fails in a canvas-capable browser says so", async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text());
  });

  await page.addInitScript(BREAK_CANVAS);
  await login(page);
  await page.goto("/dashboards/dash-1");

  // The point: the viewer is TOLD the interactive engine failed, instead of being
  // shown a static chart that looks like the product working correctly.
  const alert = page.getByTestId("echarts-init-error").first();
  await expect(alert).toBeVisible();
  await expect(alert).toHaveAttribute("role", "alert");

  // The real diagnostic reaches the console — the banner is a summary, not a
  // substitute for it.
  expect(consoleErrors.some((t) => t.includes("[EChartsChart]"))).toBe(true);

  // Loud, not broken: the chart's real data is still on screen underneath.
  await expect(page.getByText("Claims by severity").first()).toBeVisible();
});

test("a healthy browser renders the chart with no failure banner", async ({ page }) => {
  // The control. Without it, a banner that rendered unconditionally would satisfy
  // the test above and nobody would notice.
  await login(page);
  await page.goto("/dashboards/dash-1");

  await expect(page.getByText("Claims by severity").first()).toBeVisible();
  await expect(page.getByTestId("echarts-host").first()).toBeVisible();
  await expect(page.getByTestId("echarts-init-error")).toHaveCount(0);
});
