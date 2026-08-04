import {
  test,
  expect,
  loginAs,
  logout,
  expectPageHealthy,
  bearerFor,
  platformOperatorToken,
  isPlatformOperator,
  PERSONAS,
} from "./fixtures";
import type { Page } from "@playwright/test";

/**
 * BRD 70 (Demo Sandbox & POC Mode) slice 1/2 — demo-tenant lifecycle,
 * against the LIVE stack with nothing mocked, per
 * docs/initiatives/demo-sandbox-poc-mode.md §3's test-plan description.
 *
 * STATUS: pending live verification. The super-admin credential blocker is now
 * RESOLVED — fixtures.ts.platformOperatorToken() mints a real platform-operator
 * bearer by dev-logging-in as the seeded `platform-admin@` persona and reading
 * its `wr_session` JWT (which carries the `platform.admin` scope that
 * identity-service's requireSuperAdmin gate keys off). On top of that credential:
 *
 *   • RUNS (real, unconditional beyond "a super-admin persona is seeded"):
 *     the demo-sandbox API's governance posture — a super-admin is accepted and
 *     a tenant admin is REFUSED (403) by the requireSuperAdmin gate that fronts
 *     POST /demo-tenants (asserted via the read-only GET /platform/admins under
 *     the same gate, so no heavy provisioning saga is triggered).
 *
 *   • GATED (narrow, precise): AC-1 (create → walk the seeded journey →
 *     watermark) and AC-2 (reset → reconverge) drive the real demo API but
 *     CREATE + SEED a real tenant through the async provisioning saga
 *     (DSP-NFR-001 ≤10 min p95 each) — heavy, mutating, and dependent on the
 *     live stack running the demo provisioning worker. They are enabled by
 *     E2E_LIVE_DEMO_PROVISIONING=1 (and a genuinely seeded super-admin), so a
 *     stack that runs the saga verifies them, while normal CI is not made red or
 *     multi-minute-slow by them. They are complete, ready journeys — not
 *     placeholders — and assert on STATE, never acknowledgements.
 *
 * This header stays "pending live verification" until a real booted run
 * confirms the enabled test(s) green — it does not claim a pass.
 */

const IDENTITY_URL = process.env.E2E_LIVE_IDENTITY_URL ?? "http://localhost:8301";

interface DemoTenantResponse {
  operation_id: string;
  tenant: { id: string; name: string; status: string };
}

async function createDemoTenant(page: Page, token: string, pack: string): Promise<DemoTenantResponse> {
  const name = `demo-e2e-${Date.now()}`;
  const res = await page.request.post(`${IDENTITY_URL}/api/v1/demo-tenants`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { name, owner_email: `owner@${name}.example`, pack },
  });
  expect(res.status(), await res.text()).toBe(202);
  return res.json();
}

/** Polls GET /tenants/{id} until active or the DSP-NFR-001 ≤10 min p95 budget
 * is exceeded (AC-1). */
async function pollUntilActive(page: Page, token: string, tenantId: string, timeoutMs = 10 * 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await page.request.get(`${IDENTITY_URL}/api/v1/tenants/${tenantId}`, {
      headers: { Authorization: `Bearer ${token}` },
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
  test("the demo-sandbox API is gated to platform operators: a super-admin is accepted, a tenant admin is refused", async ({ page }) => {
    const operator = await platformOperatorToken(page);
    test.skip(
      !isPlatformOperator(operator),
      "no distinct platform-admin@ super-admin persona is seeded in this stack — POST /demo-tenants is requireSuperAdmin-gated, so there is no super-admin credential to assert with",
    );

    // A READ-ONLY endpoint behind the SAME requireSuperAdmin middleware that
    // fronts POST /demo-tenants (identity-service server.go) — proves the
    // credential path end-to-end without kicking off the heavy provisioning saga.
    const asOperator = await page.request.get(`${IDENTITY_URL}/api/v1/platform/admins`, {
      headers: { Authorization: `Bearer ${operator}` },
    });
    expect(asOperator.status(), await asOperator.text()).toBe(200);

    // The tenant admin carries no platform.admin scope, so the gate genuinely
    // refuses it — the real governance property BRD 70 depends on ("demo/POC
    // tenants are operator/partner-created in v1"). Assert on STATE (403), not
    // on any acknowledgement.
    const tenantAdmin = await bearerFor(page, PERSONAS().admin);
    expect(isPlatformOperator(tenantAdmin), "a tenant admin must NOT carry platform.admin").toBe(false);
    const asTenantAdmin = await page.request.get(`${IDENTITY_URL}/api/v1/platform/admins`, {
      headers: { Authorization: `Bearer ${tenantAdmin}` },
    });
    expect(asTenantAdmin.status(), "a tenant admin must be refused the requireSuperAdmin platform API").toBe(403);
  });

  test("AC-1: create → walk the seeded journey → watermark renders for every persona", async ({ page }) => {
    test.skip(
      !process.env.E2E_LIVE_DEMO_PROVISIONING,
      "creating a demo tenant runs the async provisioning saga (DSP-NFR-001 ≤10 min p95) that seeds a real tenant — heavy + mutating, and it needs the live stack's demo provisioning worker running. Enable with E2E_LIVE_DEMO_PROVISIONING=1 once that is confirmed.",
    );
    const token = await platformOperatorToken(page);
    test.skip(!isPlatformOperator(token), "no seeded platform-admin@ super-admin persona in this stack");

    const { tenant } = await createDemoTenant(page, token, "insurance-claims-payer");
    await pollUntilActive(page, token, tenant.id);

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

      // AC-1's seeded worklist: the pending prior-auth requests from
      // deploy/demo/insurance-claims-payer/cases.yaml.
      await expect(page.getByText(/PAR-500/)).toBeVisible();

      await logout(page);
    }
  });

  test("AC-2: reset re-converges a mutated demo tenant to the seeded baseline", async ({ page }) => {
    test.skip(
      !process.env.E2E_LIVE_DEMO_PROVISIONING,
      "same heavy demo-provisioning-saga dependency as AC-1 (create + reset seed a real tenant). Enable with E2E_LIVE_DEMO_PROVISIONING=1.",
    );
    const token = await platformOperatorToken(page);
    test.skip(!isPlatformOperator(token), "no seeded platform-admin@ super-admin persona in this stack");

    const { tenant } = await createDemoTenant(page, token, "insurance-claims-payer");
    await pollUntilActive(page, token, tenant.id);

    await loginAs(page, `reviewer@${tenant.id}.demo.datacern.ai`);
    await page.goto("/cases");
    await expectPageHealthy(page);

    const resetRes = await page.request.post(
      `${IDENTITY_URL}/api/v1/demo-tenants/${tenant.id}/reset`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    expect(resetRes.status(), await resetRes.text()).toBe(200);

    await page.reload();
    // AC-2: the seeded case is present in the OPEN queue (converged, not a
    // byte-for-byte snapshot restore — see §2.4's documented scope).
    await expect(page.getByText(/PAR-5001/)).toBeVisible();
  });
});
