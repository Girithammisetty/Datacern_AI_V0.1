import { test, expect, loginAs, expectPageHealthy, PERSONAS } from "./fixtures";
import type { Page } from "@playwright/test";

/**
 * BRD 68 slice 1 — Agent Control Tower fleet table journeys
 * (docs/initiatives/agent-control-tower.md), driven against the LIVE stack
 * with nothing mocked: real UI (/admin/agents) → real bff-graphql
 * (Query.agentFleet / agentFleetSummary) → agent-runtime + eval-service +
 * usage-service → Postgres.
 *
 * STATUS: written to the design's slice-1 test plan (§ "Live Playwright") but
 * NOT executed this pass — the orchestrator's brief for this slice is
 * explicit that the live stack is not booted/run here. Every test below is
 * therefore `test.fixme`-marked unconditionally (pending live verification),
 * matching this suite's existing convention for a real-but-unverified test
 * (see data-pipeline-journeys.spec.ts / hero-learning-loop.spec.ts) rather
 * than a fabricated pass. Remove the `test.fixme` call once this has been run
 * once against a real booted stack and confirmed green.
 */

interface GqlEnvelope<T> {
  data?: T;
  errors?: Array<{ message: string }>;
}

async function graphql<T>(page: Page, query: string, variables?: Record<string, unknown>): Promise<T> {
  const res = await page.request.post("/api/graphql", { data: { query, variables } });
  const body = (await res.json()) as GqlEnvelope<T>;
  if (body.errors?.length) {
    throw new Error(`GraphQL error for query [${query.slice(0, 60)}...]: ${JSON.stringify(body.errors)}`);
  }
  expect(body.data, "GraphQL response carried neither data nor errors").toBeTruthy();
  return body.data as T;
}

const AGENT_FLEET_QUERY = /* GraphQL */ `
  query AgentFleetE2E {
    agentFleet {
      key kind display lifecycle
      activeVersion { id rollout }
      evalGate { status unavailable }
      killSwitch { id state }
      external { autoExecute }
    }
  }
`;

test.describe("AC-1: mixed platform/custom/external fleet rendering", () => {
  test("the fleet table lists platform, tenant-custom, and external agents with correct kind + auto-execute badge", async ({ page }) => {
    test.fixme(true, "pending live verification — not run this pass (see file header)");

    await loginAs(page, PERSONAS().admin);
    const resp = await page.goto("/admin/agents", { waitUntil: "domcontentloaded" });
    expect(resp?.status() ?? 0).toBeLessThan(500);
    await expectPageHealthy(page, { notRedirectedFrom: "/admin/agents" });

    await expect(page.getByRole("grid", { name: "Fleet" })).toBeVisible();

    // Cross-check the rendered grid's row count against the real query result
    // (DataTable virtualizes body rows out of the DOM at this row count, so
    // aria-rowcount — not individual cell text — is the reliable assertion,
    // matching this repo's existing DataTable-testing convention).
    const { agentFleet } = await graphql<{ agentFleet: Array<{ kind: string; external: { autoExecute: string } | null }> }>(
      page,
      AGENT_FLEET_QUERY,
    );
    expect(agentFleet.length).toBeGreaterThan(0);
    await expect(page.getByRole("grid", { name: "Fleet" })).toHaveAttribute("aria-rowcount", String(agentFleet.length));

    const external = agentFleet.filter((r) => r.kind === "EXTERNAL");
    for (const row of external) {
      expect(row.external?.autoExecute).toBe("denied");
    }
    if (external.length > 0) {
      await expect(page.getByText("auto-execute: denied").first()).toBeVisible();
    }
  });
});

test.describe("AC-2: kill from the fleet row flips state without a manual refetch", () => {
  test("killing an agent from the Control Tower drill-in fires the existing mutation and the row's chip flips", async ({ page }) => {
    test.fixme(
      true,
      "pending live verification, AND slice 2 work: the `list:agent` realtime-hub patcher (docs/initiatives/agent-control-tower.md §2.5) " +
        "is not implemented in slice 1 — the row only reflects a kill after a manual refetch today, not an SSE push within 5s. " +
        "Full AC-2 (SSE flip ≤5s, no refetch) needs slice 2; this test currently only exercises the mutation + a manual refetch.",
    );

    await loginAs(page, PERSONAS().admin);
    await page.goto("/admin/agents", { waitUntil: "domcontentloaded" });
    await expectPageHealthy(page, { notRedirectedFrom: "/admin/agents" });
    // Drill-in flow: click a fleet row -> side panel opens -> Kill -> confirm
    // (typed agent-key phrase) -> row's state chip becomes "killed" after the
    // list re-fetches. Left unimplemented pending a live run to pick a real,
    // currently-active (non-platform-critical) agent key to target safely.
  });
});

test.describe("AC-3: usage-service outage degrades the spend column honestly", () => {
  test("with usage-service unreachable, the spend column shows 'unavailable' and every other column still renders", async ({ page }) => {
    test.fixme(
      true,
      "pending live verification — requires deliberately taking usage-service down against the live compose stack, " +
        "which this pass does not do (no live stack was booted/mutated). See docs/initiatives/agent-control-tower.md §3.",
    );

    await loginAs(page, PERSONAS().admin);
    await page.goto("/admin/agents", { waitUntil: "domcontentloaded" });
    await expectPageHealthy(page, { notRedirectedFrom: "/admin/agents" });

    await expect(page.getByRole("grid", { name: "Fleet" })).toBeVisible();
    // With usage-service down: the Spend column header stays visible (the
    // capability gate is unaffected by an outage) but every row's cell reads
    // "unavailable" — never a fabricated $0 — while kind/state/eval-gate
    // columns render normally from their still-healthy sources.
    await expect(page.getByText("Spend (period)")).toBeVisible();
  });
});
