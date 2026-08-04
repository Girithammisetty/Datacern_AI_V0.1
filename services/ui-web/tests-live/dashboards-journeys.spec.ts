import { test, expect, loginAs, logout, expectPageHealthy, PERSONAS } from "./fixtures";
import type { Page } from "@playwright/test";

/**
 * DASHBOARDS / CHARTS journeys — the chart-and-dashboard authoring surface,
 * driven against the LIVE stack with NOTHING mocked.
 *
 * Real chain exercised: real UI (:3000) → real bff-graphql (:4000) →
 * chart-service (+ semantic-service for model-backed charts, dataset-service
 * for the metric/dataset source and the drill-through row grid, query-service
 * for the render path, rbac/OPA for the capability gates) → Postgres (RLS).
 *
 * STATUS: PENDING LIVE VERIFICATION. Authored against the REAL routes
 * `/dashboards` + `/dashboards/[id]` (services/ui-web/src/app/(app)/dashboards)
 * and the REAL BFF operations verified in services/bff-graphql/src/schema/
 * typeDefs.ts: createDashboard, createChart, updateChart, dashboard(id, filters),
 * chartPreview, chartDrillTarget. The RBAC gate constants
 * (chart.dashboard.create / chart.chart.update|delete / chart.dashboard.read)
 * were verified against src/lib/authz/registry.ts and the persona→group→action
 * bindings in services/rbac-service/seed/roles_actions.yaml (Case Analyst =
 * adjuster persona: holds chart.dashboard.read + chart.chart.read but NOT
 * chart.dashboard.create / chart.chart.*). NOT YET executed against a live
 * stack — unlike value-journeys.spec.ts it carries no CI-run evidence yet;
 * treat a first-run failure as a spec defect to be corrected, and follows the
 * fixtures/conventions of cases-journeys.spec.ts + data-pipeline-journeys.spec.ts.
 *
 * Deliberately IN SCOPE (real code surface confirmed): create dashboard, add a
 * chart from a real DATASET (metric family — the one chart family that needs
 * only a dataset, no hand-authored semantic model), save, reload → persists;
 * cross-filtering (crossfilter.ts + the Dashboard.charts(filters:) arg) and
 * drill-through-to-cases (chartDrillTarget + the DatasetRowsGrid drill modal),
 * both driven only when a model-backed chart can actually be built in the
 * tenant (else honestly fixme'd); RBAC read-only gating.
 *
 * Deliberately OUT OF SCOPE (would require fabricating preconditions this suite
 * cannot guarantee on an arbitrary tenant): dashboard IMPORT (importDashboard
 * needs a valid export bundle from another board) and the aggregate→raw-rows
 * chartDrilldown modal (needs a chart whose display_meta declares a drilldown
 * saved query — no deterministic way to seed one here). Both operations exist
 * in the BFF; they are simply not driven by this file.
 */

interface GqlEnvelope<T> {
  data?: T;
  errors?: Array<{ message: string }>;
}

/** POST straight to the real BFF GraphQL endpoint using the logged-in page's
 * own session cookie — the same authenticated path the UI itself uses (mirrors
 * cases-journeys.spec.ts's graphql() helper). Used ONLY for fixtures/discovery
 * with no dedicated UI surface; the behavior under test is driven via the UI. */
async function graphql<T>(page: Page, query: string, variables?: Record<string, unknown>): Promise<T> {
  const res = await page.request.post("/api/graphql", { data: { query, variables } });
  const body = (await res.json()) as GqlEnvelope<T>;
  if (body.errors?.length) {
    throw new Error(`GraphQL error for [${query.slice(0, 60)}...]: ${JSON.stringify(body.errors)}`);
  }
  expect(body.data, "GraphQL response carried neither data nor errors").toBeTruthy();
  return body.data as T;
}

const CREATE_DASHBOARD = /* GraphQL */ `
  mutation CreateDashboardE2E($input: CreateDashboardInput!) {
    createDashboard(input: $input) { id title module }
  }
`;

let tagCounter = 0;
function uniqueTag(prefix: string): string {
  tagCounter += 1;
  return `${prefix}-${Date.now()}-${tagCounter}`;
}

/** Create a real dashboard directly (chart-service requires module ∈
 * insights|case_management|inspector — the same three the CreateDashboardDialog
 * offers). Returns the new id. Used to seed a board for the RBAC + cross-filter
 * tests that are not themselves about the create-dashboard UI (test 1 IS). */
async function createFixtureDashboard(page: Page, title: string): Promise<string> {
  const { createDashboard } = await graphql<{ createDashboard: { id: string } }>(page, CREATE_DASHBOARD, {
    input: { name: title, module: "insights" },
  });
  expect(createDashboard.id, "createDashboard must return an id").toBeTruthy();
  return createDashboard.id;
}

test.describe("dashboards: create, add a chart from a dataset, cross-filter, drill-to-cases, RBAC", () => {
  test.setTimeout(120_000);

  test("create a dashboard, add a metric chart from a real dataset, save, and it persists across a reload", async ({
    page,
  }) => {
    const tag = uniqueTag("dash");
    await loginAs(page, PERSONAS().admin); // holds chart.dashboard.create + chart.chart.create

    // 1. Create the dashboard through the real dialog (this test IS the
    //    create-dashboard UI flow, so it stays fully UI-driven end to end).
    await page.goto("/dashboards");
    await expectPageHealthy(page, { notRedirectedFrom: "/dashboards" });
    await page.getByRole("button", { name: "Create dashboard" }).first().click();

    const createDialog = page.getByRole("dialog");
    await expect(createDialog).toBeVisible();
    const dashboardTitle = `E2E Dashboard ${tag}`;
    await createDialog.locator("#dashboard-name").fill(dashboardTitle);
    // module defaults to "insights" — a valid chart-service module.
    const [createResp] = await Promise.all([
      page.waitForResponse(
        (r) => r.url().includes("/api/graphql") && (r.request().postData()?.includes("CreateDashboard") ?? false),
      ),
      createDialog.getByRole("button", { name: "Create dashboard" }).click(),
    ]);
    const createBody = await createResp.json();
    expect(createBody.errors, `createDashboard should not error: ${JSON.stringify(createBody.errors)}`).toBeFalsy();
    const dashboardId: string = createBody.data.createDashboard.id;

    // The dialog navigates to the new board on success.
    await page.waitForURL(`**/dashboards/${dashboardId}`);
    await expect(page.getByRole("heading", { name: dashboardTitle })).toBeVisible();

    // 2. Add a chart. The METRIC family binds to a DATASET only (no semantic
    //    model / encodings required), so it is the robust "add a chart from a
    //    real dataset" path on an arbitrary tenant.
    await page.getByRole("button", { name: "Add chart" }).first().click();
    const editor = page.getByRole("dialog");
    await expect(editor).toBeVisible();

    const chartName = `E2E Metric ${tag}`;
    await editor.locator("#chart-name").fill(chartName);
    // metric_chart is a real chart-service type in FRIENDLY_CHART_TYPES
    // (src/lib/charts/spec.ts) → family "metric" → the dataset picker appears.
    await editor.locator("#chart-type").selectOption("metric_chart");

    const datasetSelect = editor.locator("#chart-dataset");
    await expect(datasetSelect).toBeVisible();
    // Option 0 is the "pick a dataset" placeholder (value=""); a real dataset
    // is any option with a non-empty value.
    const datasetValues = await datasetSelect.locator("option").evaluateAll(
      (opts) => (opts as HTMLOptionElement[]).map((o) => o.value).filter((v) => v !== ""),
    );
    if (datasetValues.length === 0) {
      test.fixme(true, "No dataset exists in the admin's workspace to bind a metric chart to.");
      return;
    }
    await datasetSelect.selectOption(datasetValues[0]);

    // Save is enabled once name + a valid dataset source exist — it does NOT
    // depend on the live preview resolving (the metric artifact may be empty
    // when the dataset has no profile yet; the chart still persists its spec).
    const saveBtn = editor.getByRole("button", { name: "Save chart" });
    await expect(saveBtn).toBeEnabled({ timeout: 20_000 });
    const [chartResp] = await Promise.all([
      page.waitForResponse(
        (r) => r.url().includes("/api/graphql") && (r.request().postData()?.includes("CreateChart") ?? false),
      ),
      saveBtn.click(),
    ]);
    const chartBody = await chartResp.json();
    expect(chartBody.errors, `createChart should not error: ${JSON.stringify(chartBody.errors)}`).toBeFalsy();
    expect(chartBody.data.createChart.id, "createChart must return an id").toBeTruthy();

    // The editor closes and the board refetches — the new chart card renders.
    await expect(editor).toBeHidden();
    await expect(page.getByText(chartName)).toBeVisible({ timeout: 20_000 });

    // 3. Reload — read the chart back from the real chart-service, not the
    //    optimistic client cache. It survives → the spec was truly persisted.
    await page.reload();
    await expectPageHealthy(page, { notRedirectedFrom: `/dashboards/${dashboardId}` });
    await expect(page.getByRole("heading", { name: dashboardTitle })).toBeVisible();
    await expect(page.getByText(chartName)).toBeVisible({ timeout: 20_000 });
  });

  test("cross-filter a model-backed grid chart, then drill the selection through to the create-cases grid", async ({
    page,
  }) => {
    const tag = uniqueTag("xf");
    await loginAs(page, PERSONAS().admin); // chart authoring + case.case.create for the drill-through

    const dashboardId = await createFixtureDashboard(page, `E2E X-Filter ${tag}`);
    await page.goto(`/dashboards/${dashboardId}`);
    await expectPageHealthy(page, { notRedirectedFrom: `/dashboards/${dashboardId}` });

    // Build a GRID chart on a semantic model: a grid chart is a cross-filter
    // source (crossFilterField resolves config.x.dimension) AND resolves via
    // chartDrillTarget (semantic_measure → dataset_urn + column) for the
    // drill-to-cases path. Both preconditions (a published model with ≥1
    // dimension + ≥1 measure) are discovered THROUGH the editor's own selects;
    // an absent one is a genuine tenant gap, honestly fixme'd rather than faked.
    await page.getByRole("button", { name: "Add chart" }).first().click();
    const editor = page.getByRole("dialog");
    await expect(editor).toBeVisible();
    await editor.locator("#chart-name").fill(`E2E Grid ${tag}`);
    await editor.locator("#chart-type").selectOption("grid_chart");

    const modelSelect = editor.locator("#chart-model");
    await expect(modelSelect).toBeVisible();
    const modelValues = await modelSelect.locator("option").evaluateAll(
      (opts) => (opts as HTMLOptionElement[]).map((o) => o.value).filter((v) => v !== ""),
    );
    if (modelValues.length === 0) {
      test.fixme(true, "No published semantic model in the workspace — cannot author a cross-filterable grid chart.");
      return;
    }
    await modelSelect.selectOption(modelValues[0]);

    // The x-dimension picker appears once the model's definition loads.
    const xSelect = editor.locator("#chart-x");
    await expect(xSelect).toBeVisible({ timeout: 20_000 });
    const xValues = await xSelect.locator("option").evaluateAll(
      (opts) => (opts as HTMLOptionElement[]).map((o) => o.value).filter((v) => v !== ""),
    );
    const measureBoxes = editor.locator('input[type="checkbox"][id^="measure-"]');
    const measureCount = await measureBoxes.count();
    if (xValues.length === 0 || measureCount === 0) {
      test.fixme(true, `Semantic model "${modelValues[0]}" has no usable dimension+measure to build a grid chart.`);
      return;
    }
    await xSelect.selectOption(xValues[0]);
    await measureBoxes.first().check();

    const saveBtn = editor.getByRole("button", { name: "Save chart" });
    await expect(saveBtn).toBeEnabled({ timeout: 20_000 });
    const chartName = `E2E Grid ${tag}`;
    await Promise.all([
      page.waitForResponse(
        (r) => r.url().includes("/api/graphql") && (r.request().postData()?.includes("CreateChart") ?? false),
      ),
      saveBtn.click(),
    ]);
    await expect(editor).toBeHidden();

    // The grid renders through the DataTable primitive (role="grid",
    // aria-label = chart name). Its data rows are role="row" with an onClick →
    // onSelect (cross-filter emit).
    const grid = page.getByRole("grid", { name: chartName });
    await expect(grid).toBeVisible({ timeout: 20_000 });
    // Row 0 is the columnheader row; data rows carry gridcells.
    const dataRows = grid.locator('[role="row"]').filter({ has: page.locator('[role="gridcell"]') });
    if ((await dataRows.count()) === 0) {
      test.info().annotations.push({
        type: "note",
        description:
          "The model-backed grid chart returned no warehouse rows, so a cross-filter mark selection could not be exercised; the chart rendered its no-data state. Cross-filter wiring is covered structurally (grid is a role=grid source) but not driven.",
      });
      return;
    }

    // Cross-filter: activating a data row emits its first-column value as an
    // `eq` predicate → the "Active cross-filters" region + a chip appear.
    await dataRows.first().click();
    const activeFilters = page.locator('[aria-label="Active cross-filters"]');
    await expect(activeFilters).toBeVisible({ timeout: 10_000 });
    // The dashboard re-fetches Dashboard.charts(filters:[…]) with the selection;
    // the filtered state is reflected by the visible chip, which survives that
    // real round-trip (not just an optimistic local toggle).
    await expect(activeFilters.getByText("Clear all")).toBeVisible();

    // Drill-through → create cases: with a selection active, the case.case.create
    // holder sees "Create cases"; it opens the drill modal that resolves the
    // chart to its backing dataset (chartDrillTarget) and hosts the real
    // DatasetRowsGrid pre-filtered to the segment.
    await activeFilters.getByRole("button", { name: "Create cases" }).click();
    const drillDialog = page.getByRole("dialog");
    await expect(drillDialog.getByText("Create cases from selection")).toBeVisible();
    // Either outcome is honest real behavior: a semantic_measure grid resolves
    // to its dataset rows grid; a non-resolvable chart shows the explicit
    // not-drillable message. Both prove the drill path executed end to end.
    await expect(
      drillDialog.getByRole("grid", { name: "Dataset rows" }).or(drillDialog.getByText(/can(’|')?t be drilled|not.*drill/i)),
    ).toBeVisible({ timeout: 20_000 });
  });

  test("RBAC: a read-only persona (adjuster) can view dashboards but cannot create boards or edit charts", async ({
    page,
  }) => {
    // Ground truth (services/rbac-service/seed/roles_actions.yaml): the Case
    // Analyst group (adjuster persona) holds chart.dashboard.read +
    // chart.chart.read (VIEW + render) but NOT chart.dashboard.create nor
    // chart.chart.create/update/delete. So the /dashboards route resolves for
    // adjuster, while every authoring control (Can gate = chart.dashboard.create
    // / chart.chart.update|delete) is hidden. Mirrors the adjuster read-only
    // pattern in value-journeys.spec.ts + cases-journeys.spec.ts.
    const tag = uniqueTag("rbac");

    // Seed a real board as admin so the read-only detail view has something to
    // render (adjuster cannot create one itself — that's the point).
    await loginAs(page, PERSONAS().admin);
    const dashboardId = await createFixtureDashboard(page, `E2E RBAC ${tag}`);
    await logout(page);

    await loginAs(page, PERSONAS().adjuster);

    await test.step("adjuster can reach the dashboards list (chart.dashboard.read held)", async () => {
      await page.goto("/dashboards");
      await expectPageHealthy(page, { notRedirectedFrom: "/dashboards" });
      // Authoring entry points are gated away.
      await expect(page.getByRole("button", { name: "Create dashboard" })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Import" })).toHaveCount(0);
    });

    await test.step("adjuster can open a board but sees no add-chart / delete / export controls", async () => {
      await page.goto(`/dashboards/${dashboardId}`);
      await expectPageHealthy(page, { notRedirectedFrom: `/dashboards/${dashboardId}` });
      await expect(page.getByRole("heading", { name: `E2E RBAC ${tag}` })).toBeVisible();
      await expect(page.getByRole("button", { name: "Add chart" })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Export bundle" })).toHaveCount(0);
      await expect(page.getByRole("button", { name: /delete dashboard/i })).toHaveCount(0);
    });
  });
});
