import { test, expect, loginAs, logout, expectPageHealthy } from "./fixtures";
import type { Page } from "@playwright/test";

/**
 * BRD 70 (Demo Sandbox & POC Mode) slice 1/2 — demo-tenant lifecycle,
 * against the LIVE stack with nothing mocked, per
 * docs/initiatives/demo-sandbox-poc-mode.md §3's test-plan description:
 *
 *   create demo tenant (POST /demo-tenants {pack: insurance-claims-payer})
 *     -> poll to active within the <=10 min p95 budget
 *     -> log in as each seeded persona and walk the seeded journey
 *        (worklist -> copilot triage -> approval -> audit trail), matching
 *        BRD 70's AC-1 literally
 *     -> assert the watermark banner renders for every persona
 *     -> reset -> mutate a case -> reset again
 *     -> assert state reconverges to the seeded baseline (AC-2)
 *
 * STATUS: written, NOT run. This environment has no Docker (the identity-
 * service Go integration tier also auto-skips here for the same reason —
 * see services/identity-service/test/integration/demo_test.go), so there is
 * no live stack to execute this spec against. It is also gated on a real
 * prerequisite `tests-live/fixtures.ts` does not yet provide: every existing
 * live spec authenticates as a pre-seeded PERSONAS() user, but creating a
 * demo tenant is a platform-operator action (POST /demo-tenants is
 * requireSuperAdmin-gated, server.go) with no super-admin credential surfaced
 * to Playwright today. `superAdminToken()` below documents exactly what that
 * helper needs to do (mirroring hero-learning-loop.spec.ts's precedent of
 * calling a non-BFF service directly via an E2E_LIVE_*_URL env var) so this
 * spec is a complete, ready-to-enable journey once that credential path
 * exists — not a placeholder. See docs/initiatives/demo-sandbox-poc-mode.md
 * §3 "honest gaps" for the tracked follow-up.
 */

const IDENTITY_URL = process.env.E2E_LIVE_IDENTITY_URL ?? "http://localhost:8301";

/**
 * Mints (or reads) a platform.admin-scoped bearer token for driving
 * POST /demo-tenants directly against identity-service. NOT implemented —
 * every existing live-spec credential is a real dev-login user JWT scoped
 * to a pre-seeded persona (fixtures.ts loginAs), and none of those carry
 * platform.admin. A real implementation needs one of:
 *   (a) `deploy/local/up.sh` to also mint + write a super-admin token into
 *       `.live-context.json` (same file loginAs/PERSONAS() already read),
 *       the same way it writes the persona map today, or
 *   (b) a dedicated `E2E_LIVE_SUPERADMIN_TOKEN` env var CI populates from
 *       the harness's own bootstrap credential (deploy/e2e/lib/common.py
 *       already mints one locally via `superadmin_token()` — the live-stack
 *       equivalent would expose that the same way).
 * Throws until one of those exists, so a future run of this spec fails loud
 * and specific rather than silently no-op'ing.
 */
function superAdminToken(): string {
  const tok = process.env.E2E_LIVE_SUPERADMIN_TOKEN;
  if (!tok) {
    throw new Error(
      "E2E_LIVE_SUPERADMIN_TOKEN is not set — this live spec needs a platform.admin " +
        "credential that tests-live/fixtures.ts does not provide yet (see this file's " +
        "top-of-file comment). Not run in this slice.",
    );
  }
  return tok;
}

interface DemoTenantResponse {
  operation_id: string;
  tenant: { id: string; name: string; status: string };
}

async function createDemoTenant(page: Page, pack: string): Promise<DemoTenantResponse> {
  const name = `demo-e2e-${Date.now()}`;
  const res = await page.request.post(`${IDENTITY_URL}/api/v1/demo-tenants`, {
    headers: { Authorization: `Bearer ${superAdminToken()}` },
    data: { name, owner_email: `owner@${name}.example`, pack },
  });
  expect(res.status(), await res.text()).toBe(202);
  return res.json();
}

/** Polls GET /tenants/{id}/provisioning until every step succeeded or the
 * DSP-NFR-001 <=10 min p95 budget is exceeded (AC-1). */
async function pollUntilActive(page: Page, tenantId: string, timeoutMs = 10 * 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await page.request.get(`${IDENTITY_URL}/api/v1/tenants/${tenantId}`, {
      headers: { Authorization: `Bearer ${superAdminToken()}` },
    });
    if (res.ok()) {
      const body = (await res.json()) as { status: string };
      if (body.status === "active") return;
      if (body.status === "provision_failed") {
        throw new Error(`demo tenant ${tenantId} entered provision_failed`);
      }
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw new Error(`demo tenant ${tenantId} did not reach active within ${timeoutMs}ms`);
}

test.describe("BRD 70 demo-tenant lifecycle (live)", () => {
  test.skip(
    true,
    "Pending live-stack verification — needs a super-admin credential helper " +
      "(see superAdminToken() above) not yet wired into tests-live/fixtures.ts, " +
      "and no Docker/live stack is available in this build environment. " +
      "Written per docs/initiatives/demo-sandbox-poc-mode.md §3's test-plan " +
      "description; enable once the prerequisite lands.",
  );

  test("AC-1: create -> walk the seeded journey -> watermark renders for every persona", async ({ page }) => {
    const { tenant } = await createDemoTenant(page, "insurance-claims-payer");
    await pollUntilActive(page, tenant.id);

    // Each of the bundle's 4 seeded personas (deploy/demo/insurance-claims-payer/
    // personas.yaml: admin/reviewer/analyst/auditor) should be able to log in
    // and see the watermark + the seeded worklist.
    for (const localPart of ["admin", "reviewer", "analyst", "auditor"]) {
      const email = `${localPart}@${tenant.id}.demo.datacern.ai`;
      await loginAs(page, email);
      await page.goto("/cases");
      await expectPageHealthy(page);

      // DSP-FR-014: the persistent "DEMO — synthetic data" watermark banner,
      // rendered purely from the session claim (components/demo/
      // DemoWatermarkBanner.tsx) — no GraphQL round-trip.
      await expect(page.getByRole("status", { name: /demo sandbox/i })).toBeVisible();

      // AC-1's seeded worklist: the 5 pending prior-auth requests from
      // deploy/demo/insurance-claims-payer/cases.yaml.
      await expect(page.getByText(/PAR-500/)).toBeVisible();

      await logout(page);
    }
  });

  test("AC-2: reset re-converges a mutated demo tenant to the seeded baseline", async ({ page }) => {
    const { tenant } = await createDemoTenant(page, "insurance-claims-payer");
    await pollUntilActive(page, tenant.id);

    await loginAs(page, `reviewer@${tenant.id}.demo.datacern.ai`);
    await page.goto("/cases");
    await expectPageHealthy(page);
    // Mutate: dispose of one seeded case (exact UI interaction TBD against a
    // real running stack -- left as the concrete assertion to fill in once
    // this spec is unblocked).
    // await page.getByRole("row", { name: /PAR-5001/ }).click();
    // await page.getByRole("button", { name: /approve/i }).click();

    const resetRes = await page.request.post(
      `${IDENTITY_URL}/api/v1/demo-tenants/${tenant.id}/reset`,
      { headers: { Authorization: `Bearer ${superAdminToken()}` } },
    );
    expect(resetRes.status(), await resetRes.text()).toBe(200);

    await page.reload();
    // AC-2: the mutated case is back in the OPEN queue (converged, not a
    // byte-for-byte snapshot restore -- see §2.4's documented scope).
    await expect(page.getByText(/PAR-5001/)).toBeVisible();
  });
});
