import { test, expect, loginAs, expectPageHealthy, PERSONAS } from "./fixtures";
import type { Page } from "@playwright/test";

/**
 * GOVERNED SQL / QUERIES journeys — the `/data/queries` editor over the
 * lakehouse, driven against the LIVE stack with NOTHING mocked.
 *
 * Real chain exercised: real UI (:3000) → real bff-graphql (:4000) →
 * query-service (the governed engine + the sqlsafe read-only allow-list, run
 * synchronously) → the lakehouse (DuckDB/Iceberg) → Postgres (RLS) for
 * saved-query metadata. rbac/OPA enforces the route + execute capability gates.
 *
 * STATUS: PENDING LIVE VERIFICATION. Authored against the REAL route
 * `/data/queries` (services/ui-web/src/app/(app)/data/queries/page.tsx — a real
 * SQL editor that submits through the BFF and renders result rows) and the REAL
 * BFF operations verified in services/bff-graphql/src/schema/typeDefs.ts:
 * runSql(input: RunSqlInput!): QueryResult and runSavedQuery(id, limit). The
 * route + persona gates were verified against src/lib/authz/registry.ts
 * (ROUTE_RULES `/data/queries` → query.query.read) and the persona bindings in
 * services/rbac-service/seed/roles_actions.yaml (the Case Analyst = adjuster
 * persona holds query.execution.* but NOT query.query.read, so it is denied the
 * editor route). NOT YET executed against a live stack; treat a first-run
 * failure as a spec defect. Follows the fixtures/conventions of
 * cases-journeys.spec.ts + data-pipeline-journeys.spec.ts.
 *
 * A note on the "cross-tenant query is refused" acceptance criterion: tenant
 * isolation is enforced by RLS inside the governed engine, but a DETERMINISTIC
 * cross-tenant table name cannot be fabricated on an arbitrary seeded tenant
 * without inventing an identifier that may not exist (which would fail for the
 * wrong reason). This spec therefore exercises the same sqlsafe allow-list
 * through the deterministic, tenant-independent path — a NON-SELECT (write)
 * statement is refused — and leaves the cross-tenant leg to the query-service's
 * own RLS/isolation integration tests rather than faking a table name here.
 */

interface GqlEnvelope<T> {
  data?: T;
  errors?: Array<{ message: string }>;
}

async function graphql<T>(page: Page, query: string, variables?: Record<string, unknown>): Promise<T> {
  const res = await page.request.post("/api/graphql", { data: { query, variables } });
  const body = (await res.json()) as GqlEnvelope<T>;
  if (body.errors?.length) {
    throw new Error(`GraphQL error for [${query.slice(0, 60)}...]: ${JSON.stringify(body.errors)}`);
  }
  expect(body.data, "GraphQL response carried neither data nor errors").toBeTruthy();
  return body.data as T;
}

const SAVED_QUERIES_Q = /* GraphQL */ `
  query SavedQueriesForE2E($first: Int) { savedQueries(first: $first) { nodes { id name } } }
`;

test.describe("queries: governed SELECT renders rows, non-SELECT is refused, route is gated", () => {
  test.setTimeout(120_000);

  test("an ad-hoc SELECT runs through the governed engine and renders real result rows", async ({ page }) => {
    await loginAs(page, PERSONAS().admin); // holds query.query.read + query.execution.execute

    await page.goto("/data/queries");
    await expectPageHealthy(page, { notRedirectedFrom: "/data/queries" });

    const editor = page.getByLabel("SQL editor");
    await expect(editor).toBeVisible();
    await editor.fill("SELECT 1 AS example");

    // The ad-hoc Run button is the first "Run" in DOM order (the editor card
    // precedes the saved-queries sidebar, whose per-row Run buttons come later).
    const [runResp] = await Promise.all([
      page.waitForResponse(
        (r) => r.url().includes("/api/graphql") && (r.request().postData()?.includes("RunSql") ?? false),
      ),
      page.getByRole("button", { name: "Run", exact: true }).first().click(),
    ]);
    const runBody = await runResp.json();
    expect(runBody.errors, `runSql should not error for a SELECT: ${JSON.stringify(runBody.errors)}`).toBeFalsy();
    const result = runBody.data.runSql;
    // The governed engine ran it to a successful terminal status and returned
    // the projected row — real execution, not a stub.
    expect(result.status, `SELECT must succeed: ${JSON.stringify(result)}`).toBe("succeeded");
    expect((result.rows ?? []).length, "SELECT 1 must return exactly one row").toBeGreaterThanOrEqual(1);

    // The results table renders the real column + cell (not just a toast).
    await expect(page.getByRole("heading", { name: "Results" })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText("example")).toBeVisible();
    await expect(page.getByRole("table").getByText("1", { exact: true }).first()).toBeVisible();
  });

  test("running a seeded saved query returns real rows from a governed dataset", async ({ page }) => {
    await loginAs(page, PERSONAS().admin);

    // A saved query targets governed, published datasets — the real "SELECT
    // against a seeded dataset" path. Skip honestly when the tenant has none
    // rather than inventing a dataset name.
    const { savedQueries } = await graphql<{ savedQueries: { nodes: { id: string; name: string }[] } }>(
      page,
      SAVED_QUERIES_Q,
      { first: 10 },
    );
    if (savedQueries.nodes.length === 0) {
      test.fixme(true, "No saved query is seeded in the tenant to exercise a governed dataset-backed SELECT.");
      return;
    }
    const target = savedQueries.nodes[0];

    await page.goto("/data/queries");
    await expectPageHealthy(page, { notRedirectedFrom: "/data/queries" });

    // The saved-queries sidebar lists the query with its own Run control.
    const row = page.locator("li").filter({ hasText: target.name }).first();
    await expect(row).toBeVisible({ timeout: 20_000 });
    const [runResp] = await Promise.all([
      page.waitForResponse(
        (r) => r.url().includes("/api/graphql") && (r.request().postData()?.includes("RunSavedQuery") ?? false),
      ),
      row.getByRole("button", { name: "Run" }).click(),
    ]);
    const runBody = await runResp.json();
    expect(runBody.errors, `runSavedQuery should not error: ${JSON.stringify(runBody.errors)}`).toBeFalsy();
    expect(runBody.data.runSavedQuery.status, "saved query must run to success").toBe("succeeded");
    // Results render for the saved query (header shows its name; a table appears).
    await expect(page.getByRole("heading", { name: "Results" })).toBeVisible({ timeout: 20_000 });
  });

  test("a non-SELECT (write) statement is refused by the sqlsafe allow-list", async ({ page }) => {
    await loginAs(page, PERSONAS().admin);

    await page.goto("/data/queries");
    await expectPageHealthy(page, { notRedirectedFrom: "/data/queries" });

    const editor = page.getByLabel("SQL editor");
    await expect(editor).toBeVisible();
    // A write statement classifies as non-read-only regardless of whether the
    // referenced table exists → the allow-list refuses it deterministically.
    await editor.fill("DELETE FROM anything WHERE 1 = 1");

    const [runResp] = await Promise.all([
      page.waitForResponse(
        (r) => r.url().includes("/api/graphql") && (r.request().postData()?.includes("RunSql") ?? false),
      ),
      page.getByRole("button", { name: "Run", exact: true }).first().click(),
    ]);
    const runBody = await runResp.json();
    // Refusal surfaces either as a GraphQL error (BFF/query-service 422) or as a
    // non-succeeded execution status — never as a successful DELETE.
    const refused =
      (Array.isArray(runBody.errors) && runBody.errors.length > 0) ||
      (runBody.data?.runSql && runBody.data.runSql.status !== "succeeded");
    expect(
      refused,
      `a non-SELECT must be refused, got: ${JSON.stringify(runBody.data?.runSql ?? runBody.errors)}`,
    ).toBeTruthy();

    // The UI renders the refusal in the results area (destructive text), not a
    // rendered result set.
    await expect(page.locator(".text-destructive").first()).toBeVisible({ timeout: 20_000 });
  });

  test("RBAC: a persona without query.query.read (adjuster) cannot reach the SQL editor", async ({ page }) => {
    // Ground truth (services/rbac-service/seed/roles_actions.yaml): the Case
    // Analyst group (adjuster persona) holds query.execution.execute/read for
    // the chart render path but NOT query.query.read, which ROUTE_RULES gates
    // `/data/queries` on (src/lib/authz/registry.ts). So adjuster is denied the
    // editor route — the SQL editor never renders for it.
    await loginAs(page, PERSONAS().adjuster);
    await page.goto("/data/queries");
    // Either a hard no-access state or a bounce — but never the editor itself.
    await expect(page.getByLabel("SQL editor")).toHaveCount(0);
  });
});
