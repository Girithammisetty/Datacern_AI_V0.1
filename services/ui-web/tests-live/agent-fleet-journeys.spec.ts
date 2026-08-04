import { test, expect, loginAs, expectPageHealthy, PERSONAS } from "./fixtures";
import type { Page } from "@playwright/test";

/**
 * BRD 68 slice 1 — Agent Control Tower fleet table journeys
 * (docs/initiatives/agent-control-tower.md), driven against the LIVE stack
 * with nothing mocked: real UI (/admin/agents) → real bff-graphql
 * (Query.agentFleet / agentFleetSummary) → agent-runtime + eval-service +
 * usage-service → Postgres.
 *
 * STATUS: pending live verification. These specs are written against the real
 * /admin/agents Control Tower fleet page and the real bff-graphql
 * agentFleet/agentFleetSummary operations, and they RUN under `pnpm e2e:live`:
 * AC-1 (fleet rendering vs the real query), the AC-2 drill-in (side panel +
 * phrase-gated kill affordance), and the AC-3 decisions-degradation test all
 * execute. They have NOT been run in THIS environment (no booted stack here),
 * so this header stays "pending live verification" until a real run confirms
 * them green — it does not claim a pass.
 *
 * Two narrowly-scoped `test.fixme`s remain, each for behavior that genuinely
 * is not runnable yet — never a fabricated pass:
 *   • AC-2 tail (kill EXECUTES and the row's state chip flips without a manual
 *     refetch): the `list:agent` realtime-hub patcher is slice-2 work
 *     (docs/initiatives/agent-control-tower.md §2.5), AND executing a real kill
 *     mutates the shared, serial live stack destructively (retries would leave
 *     an agent killed for every subsequent spec), so it is not driven here.
 *   • AC-3 tail (usage-service outage → spend column reads "unavailable"):
 *     needs deliberately taking usage-service down against the live compose
 *     stack, which a Playwright spec cannot do without breaking the serial
 *     suite. The permanent, always-observable degradation (the Decisions
 *     column) IS asserted as a real test in its place.
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

interface FleetRow {
  key: string;
  kind: string;
  display: string;
  lifecycle: string;
  activeVersion: { id: number; rollout: string };
  evalGate: { status: string; unavailable: boolean };
  killSwitch: { id: string | null; state: string };
  external: { autoExecute: string } | null;
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
  test("the fleet table lists the live agents with the correct kind + auto-execute badge, and its row count matches the real query", async ({ page }) => {
    await loginAs(page, PERSONAS().admin);
    const resp = await page.goto("/admin/agents", { waitUntil: "domcontentloaded" });
    expect(resp?.status() ?? 0).toBeLessThan(500);
    await expectPageHealthy(page, { notRedirectedFrom: "/admin/agents" });

    const grid = page.getByRole("grid", { name: "Fleet" });
    await expect(grid).toBeVisible();

    // Cross-check the rendered grid against the real query result. DataTable
    // virtualizes body rows, so aria-rowcount (not individual cell text) is the
    // reliable count assertion — matching this repo's DataTable-testing
    // convention (see AgentFleetTable.test.tsx's header comment).
    const { agentFleet } = await graphql<{ agentFleet: FleetRow[] }>(page, AGENT_FLEET_QUERY);
    expect(agentFleet.length, "live fleet must expose at least one agent").toBeGreaterThan(0);
    await expect(grid).toHaveAttribute("aria-rowcount", String(agentFleet.length));

    // The seeded platform always ships platform agents; custom/external are
    // tenant-dependent, so only assert those when the real query returns them.
    const kinds = new Set(agentFleet.map((r) => r.kind));
    expect(kinds.has("PLATFORM"), "the seeded fleet always includes platform agents").toBe(true);

    // BRD 60: external agents never auto-execute — the query answers "denied"
    // and the row renders the honest badge. Assert on STATE (the query field)
    // for every external agent, and on the DOM badge when any are present.
    const external = agentFleet.filter((r) => r.kind === "EXTERNAL");
    for (const row of external) {
      expect(row.external?.autoExecute, `external agent ${row.key} must report auto-execute denied`).toBe("denied");
    }
    if (external.length > 0) {
      await expect(page.getByText("auto-execute: denied").first()).toBeVisible();
    }
  });
});

test.describe("AC-2: drill into a fleet row and reach the (phrase-gated) kill affordance", () => {
  test("clicking a fleet row opens the agent's detail panel with its real key/version and a four-eyes typed-phrase kill gate", async ({ page }) => {
    await loginAs(page, PERSONAS().admin); // Admin holds ai.agent.admin → the kill affordance renders

    await page.goto("/admin/agents", { waitUntil: "domcontentloaded" });
    await expectPageHealthy(page, { notRedirectedFrom: "/admin/agents" });

    const grid = page.getByRole("grid", { name: "Fleet" });
    await expect(grid).toBeVisible();

    // Pick a REAL, currently-active agent from the live fleet to drill into
    // (killing is never confirmed below, so this is non-destructive).
    const { agentFleet } = await graphql<{ agentFleet: FleetRow[] }>(page, AGENT_FLEET_QUERY);
    const target = agentFleet.find((r) => r.lifecycle === "ACTIVE") ?? agentFleet[0];
    expect(target, "live fleet must expose at least one agent to drill into").toBeTruthy();

    // Drill-in: activate the agent's row → the master-detail side panel opens.
    // The panel renders the agent's real key + active version straight from the
    // same query (state, not an acknowledgement); its Close button exists ONLY
    // while a row is selected, so its appearance proves the panel opened.
    await grid.getByRole("row").filter({ hasText: target.key }).first().click();
    await expect(page.getByRole("button", { name: "Close" })).toBeVisible();
    await expect(page.getByText(new RegExp(`${escapeRegExp(target.key)}\\s*·\\s*v${target.activeVersion.id}\\b`)).first()).toBeVisible();

    // The kill affordance (createAgentKillSwitch = ai.agent.admin) is present
    // for an active agent. Opening it demands the typed agent-key phrase before
    // the destructive confirm enables — the real irreversible-action gate.
    const killButton = page.getByRole("button", { name: "Kill", exact: true });
    await expect(killButton).toBeVisible();
    await killButton.click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(new RegExp(`Type\\s+${escapeRegExp(target.key)}\\s+to confirm`))).toBeVisible();

    const confirm = dialog.getByRole("button", { name: "Kill", exact: true });
    await expect(confirm, "the destructive confirm must stay disabled until the exact key is typed").toBeDisabled();
    await dialog.getByRole("textbox").fill(target.key);
    await expect(confirm, "the confirm enables once the exact key phrase is typed").toBeEnabled();

    // Deliberately CANCEL — this spec proves the drill-in + governance gate
    // without mutating the shared serial live stack (the actual kill + row-flip
    // is the scoped test.fixme below).
    await dialog.getByRole("button", { name: /cancel/i }).click();
    await expect(dialog).toBeHidden();
  });

  test.fixme(
    "killing an agent from the row flips its state chip within 5s with no manual refetch (SSE)",
    async ({ page }) => {
      // Not runnable yet — two independent reasons, neither a mocking excuse:
      //  1. The `list:agent` realtime-hub patcher that pushes the state flip
      //     without a refetch is slice-2 work (docs/initiatives/agent-control-
      //     tower.md §2.5); slice 1 only reflects a kill after a manual refetch,
      //     so the ≤5s no-refetch assertion has nothing real to observe.
      //  2. Executing a real kill mutates the SHARED, serial (workers:1) live
      //     stack destructively — and with retries:2 a mid-test failure would
      //     leave a platform agent killed for every subsequent spec. Enabling
      //     this safely needs slice 2 plus a disposable, non-platform-critical
      //     agent to target and a guaranteed lift-on-teardown.
      await loginAs(page, PERSONAS().admin);
      await page.goto("/admin/agents", { waitUntil: "domcontentloaded" });
    },
  );
});

test.describe("AC-3: degraded field groups render honestly, never a fabricated zero", () => {
  test("the Decisions column shows the honest 'unavailable' marker (permanent slice-1 gap) for the live fleet", async ({ page }) => {
    await loginAs(page, PERSONAS().admin);
    await page.goto("/admin/agents", { waitUntil: "domcontentloaded" });
    await expectPageHealthy(page, { notRedirectedFrom: "/admin/agents" });

    const grid = page.getByRole("grid", { name: "Fleet" });
    await expect(grid).toBeVisible();

    // Decisions has no agent-runtime aggregate in slice 1 (docs/initiatives/
    // agent-control-tower.md §2.6), so every row's Decisions cell renders
    // "unavailable" — the exact honest-degradation rule AC-3 is about, on the
    // field that is observably degraded WITHOUT inducing an outage. The column
    // header stays visible (the capability gate is unaffected).
    await expect(grid.getByText("Decisions", { exact: true })).toBeVisible();
    await expect(grid.getByText("unavailable").first()).toBeVisible();

    // Cross-check against the real query: at least one row exists to degrade.
    const { agentFleet } = await graphql<{ agentFleet: FleetRow[] }>(page, AGENT_FLEET_QUERY);
    expect(agentFleet.length, "live fleet must expose at least one agent").toBeGreaterThan(0);
  });

  test.fixme(
    "with usage-service unreachable, the spend column reads 'unavailable' and every other column still renders",
    async ({ page }) => {
      // Not runnable here: this asserts the SPEND column's degradation, which
      // only appears when usage-service is actually down. Inducing that outage
      // means stopping a compose service mid-suite — impossible for a Playwright
      // spec, and it would break the serial (workers:1) live suite for every
      // other test. See docs/initiatives/agent-control-tower.md §3. The
      // always-observable degradation (Decisions) is covered by the real test
      // above instead.
      await loginAs(page, PERSONAS().admin);
      await page.goto("/admin/agents", { waitUntil: "domcontentloaded" });
    },
  );
});

/** Escape a dynamic string for safe embedding in a RegExp (agent keys can
 * carry `.`/`-`). */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
