import { test, expect, loginAs, logout, expectPageHealthy, PERSONAS } from "./fixtures";

/**
 * SMOKE: prove the live stack renders real data across every major module.
 *
 * Each route below is owned by a different downstream service, so a green run
 * asserts the whole chain (UI → BFF → that service → Postgres/warehouse) is up
 * and composing correctly for a real seeded persona. Assertions are structural
 * (page shell + header render, no error boundary, no auth bounce) — deep
 * data-shape assertions live in the journey + per-module specs.
 */

// route → the primary service it exercises (for readable failure labels).
const MODULE_ROUTES: Array<{ path: string; service: string }> = [
  { path: "/cases", service: "case-service" },
  { path: "/inbox", service: "agent-runtime (proposals)" },
  { path: "/copilot", service: "agent-runtime (copilot)" },
  { path: "/data/ingestions", service: "ingestion-service" },
  { path: "/data/connections", service: "ingestion-service (connections)" },
  { path: "/data/pipelines", service: "pipeline-orchestrator" },
  { path: "/data/pipelines/runs", service: "pipeline-orchestrator (runs)" },
  { path: "/data/pipelines/schedules", service: "pipeline-orchestrator (schedules)" },
  { path: "/data/queries", service: "query-service" },
  { path: "/data/semantic-models", service: "semantic-service" },
  { path: "/dashboards", service: "chart-service" },
  { path: "/ml/eval", service: "eval-service" },
  { path: "/admin/users", service: "identity-service" },
  { path: "/admin/roles", service: "rbac-service (roles)" },
  // BRD 59 WS1: the unified Customization hub — composes 9 already-fetched
  // queries (packs, agents, decisions, semantic models, roles, ontology,
  // labels, embed, IdP) into one status-card grid, no new backend calls.
  { path: "/admin/customization", service: "customization hub (composition-only)" },
  // BRD 68 slice 1: Control Tower fleet table + tiles, additive above the
  // pre-existing kill-switch/catalog cards on this route (docs/initiatives/
  // agent-control-tower.md). Aggregates agent-runtime + eval-service +
  // usage-service through bff-graphql's new agentFleet/agentFleetSummary.
  { path: "/admin/agents", service: "agent-runtime + eval-service + usage-service (fleet aggregation)" },
  { path: "/admin/groups", service: "rbac-service (groups)" },
  { path: "/admin/workspaces", service: "rbac-service (workspaces)" },
  { path: "/admin/teams", service: "rbac-service (teams)" },
  { path: "/admin/audit", service: "audit-service" },
  { path: "/admin/usage", service: "usage-service" },
  { path: "/admin/memory", service: "memory-service" },
  { path: "/admin/notifications", service: "notification-service" },
  // ---- 2026-08-05 sweep completion. A cross-layer wiring audit
  // (tools/wiring/audit_ui_wiring.py) found 50 of 91 routes untouched by ANY
  // e2e spec. Every static-path tenant route joins the sweep here so each page
  // is at least proven to compose against the real BFF. The tenant Admin
  // persona bypasses action checks via the projection admin flag
  // (rbac seed, RBC-FR-041), so capability gates cannot false-fail this list.
  // Still excluded, deliberately: dynamic [id]/[slug] routes (need per-run
  // fixture ids — belongs in their module specs) and /embed/* (needs an embed
  // token, not a login session).
  { path: "/admin", service: "admin hub (composition)" },
  { path: "/admin/api", service: "bff-graphql (API explorer / introspection)" },
  { path: "/admin/archive", service: "archive (composition)" },
  { path: "/admin/audit/export", service: "audit-service (export)" },
  { path: "/admin/service-accounts", service: "identity-service (service accounts)" },
  { path: "/admin/tenant", service: "identity-service (tenant profile)" },
  { path: "/admin/writebacks", service: "writeback approvals" },
  { path: "/copilot/runs", service: "agent-runtime (runs)" },
  { path: "/dashboards/reports", service: "notification-service (report subscriptions)" },
  { path: "/data", service: "dataset-service" },
  { path: "/data/entity-resolution", service: "dataset-service (entity resolution)" },
  { path: "/data/ontology", service: "dataset-service (ontology)" },
  { path: "/data/upload", service: "ingestion-service (uploads)" },
  { path: "/data/connections/new", service: "ingestion-service (connector catalog)" },
  { path: "/data/semantic-models/new", service: "semantic-service (model builder)" },
  { path: "/help", service: "help center (authed shell)" },
  { path: "/help/pack", service: "help center (pack guide)" },
  { path: "/ml", service: "experiment-service" },
  { path: "/ml/archetypes", service: "experiment-service (archetypes)" },
  { path: "/ml/distillation", service: "agent-runtime (SLM distillation cockpit)" },
  { path: "/ml/eval/canaries", service: "eval-service (canaries)" },
  { path: "/ml/eval/cases", service: "eval-service (cases)" },
  { path: "/ml/eval/datasets", service: "eval-service (datasets)" },
  { path: "/ml/eval/runs", service: "eval-service (runs)" },
  { path: "/ml/eval/scorers", service: "eval-service (scorers)" },
  { path: "/ml/eval/trends", service: "eval-service (trends)" },
  { path: "/ml/inference", service: "inference-service" },
  { path: "/ml/models", service: "inference-service (model registry)" },
  { path: "/notifications", service: "notification-service (inbox)" },
  { path: "/packs", service: "pack-service" },
];

/**
 * Cross-tenant PLATFORM-OPERATOR surfaces. These sit under /admin but are gated
 * by `platformGate`, NOT the per-tenant Admin role (lib/authz/registry.ts
 * ROUTE_RULES: "need the platform gate — NOT the per-tenant Admin role").
 *
 * They lived in MODULE_ROUTES above and were driven by the TENANT admin, who is
 * correctly denied — so the guard rendered NoAccess, no heading existed, and the
 * spec failed. That stale expectation predates the Platform Admin split and is
 * the reason the live suite sat red: a test asserting the opposite of the
 * intended governance rule.
 */
const PLATFORM_ROUTES = [
  { path: "/admin/tools", service: "tool-registry" },
  { path: "/admin/ai-gateway/providers", service: "ai-gateway" },
  // 2026-08-05 sweep completion (see MODULE_ROUTES note). Each entry gets BOTH
  // sides asserted: renders for a platform admin, denied to a tenant admin.
  { path: "/admin/tenants", service: "identity-service (tenant lifecycle)" },
  { path: "/admin/ai-gateway", service: "ai-gateway (hub)" },
  { path: "/admin/ai-gateway/budgets", service: "ai-gateway (budgets)" },
  { path: "/admin/ai-gateway/guardrails", service: "ai-gateway (guardrails)" },
  { path: "/admin/ai-gateway/keys", service: "ai-gateway (virtual keys)" },
  { path: "/admin/ai-gateway/ladders", service: "ai-gateway (model ladders)" },
];

/** Public marketing/demo pages — no session, so no expectPageHealthy (that
 * helper asserts the authed app shell). The page must serve (<500) and render
 * a heading rather than Next's error overlay. */
const PUBLIC_ROUTES = [
  { path: "/welcome", service: "marketing home" },
  { path: "/welcome/walkthrough", service: "demo walkthrough" },
  { path: "/pricing", service: "pricing + cost calculator" },
  { path: "/live-demo", service: "live-demo signup" },
];

test.describe("smoke: live stack renders across all modules", () => {
  test("admin persona authenticates through the real auth path", async ({ page }) => {
    await loginAs(page, PERSONAS().admin);
    // loginAs already asserts the Welcome home; also confirm the tenant chrome.
    await expect(page.getByRole("heading", { name: /welcome/i })).toBeVisible();
  });

  for (const { path, service } of MODULE_ROUTES) {
    test(`renders ${path}  [${service}]`, async ({ page }) => {
      await loginAs(page, PERSONAS().admin);
      const resp = await page.goto(path, { waitUntil: "domcontentloaded" });
      // The Next route itself must not 5xx.
      expect(resp?.status() ?? 0, `${path} document status`).toBeLessThan(500);
      await expectPageHealthy(page, { notRedirectedFrom: path });
    });
  }
});

test.describe("smoke: platform-operator surfaces", () => {
  for (const { path, service } of PLATFORM_ROUTES) {
    test(`renders ${path} for a PLATFORM admin  [${service}]`, async ({ page }) => {
      await loginAs(page, PERSONAS().platformAdmin);
      const resp = await page.goto(path, { waitUntil: "domcontentloaded" });
      expect(resp?.status() ?? 0, `${path} document status`).toBeLessThan(500);
      await expectPageHealthy(page, { notRedirectedFrom: path });
    });

    // The governance property that actually matters, and the one the old spec
    // had inverted: a TENANT admin must be refused a cross-tenant surface.
    test(`denies ${path} to a TENANT admin  [${service}]`, async ({ page }) => {
      await loginAs(page, PERSONAS().admin);
      await page.goto(path, { waitUntil: "domcontentloaded" });
      await expect(page.getByTestId("no-access")).toBeVisible();
    });
  }
});

test.describe("smoke: public pages serve without a session", () => {
  for (const { path, service } of PUBLIC_ROUTES) {
    test(`renders ${path} unauthenticated  [${service}]`, async ({ page }) => {
      await logout(page);
      const resp = await page.goto(path, { waitUntil: "domcontentloaded" });
      expect(resp?.status() ?? 0, `${path} document status`).toBeLessThan(500);
      // Not bounced to login (these are public by design), and real content
      // rendered rather than an error boundary.
      expect(page.url()).not.toContain("/login");
      await expect(page.getByRole("heading").first()).toBeVisible();
    });
  }
});

test.describe("smoke: auth posture", () => {
  test("fail-closed: unauthenticated access to a protected route redirects to /login", async ({ page }) => {
    await logout(page);
    await page.goto("/cases");
    await page.waitForURL("**/login**");
    await expect(page.getByRole("button", { name: /sign in/i })).toBeVisible();
  });

  test("a non-admin seeded persona (adjuster) can authenticate and reach home", async ({ page }) => {
    // Proves differentiated personas work end-to-end (not just the super-scoped admin).
    await loginAs(page, PERSONAS().adjuster);
    await expect(page.getByRole("heading", { name: /welcome/i })).toBeVisible();
    // Their day-job surface loads.
    await page.goto("/cases");
    await expectPageHealthy(page, { notRedirectedFrom: "/cases" });
  });

  // BRD 59 WS1: the first live spec asserting a persona is HIDDEN from an
  // admin-only route/card, not just that a lesser persona can still reach
  // their own pages. The route guard (RouteGuard.tsx) renders a non-leaking
  // NoAccess state in place of the page rather than redirecting — same URL,
  // no page data ever reaches the client.
  test("a non-admin persona (adjuster) is denied the Customization hub, not shown it", async ({ page }) => {
    await loginAs(page, PERSONAS().adjuster);
    await page.goto("/admin/customization", { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("no-access")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Customization" })).not.toBeVisible();
  });
});
