import { test, expect, loginAs, PERSONAS, expectPageHealthy } from "./fixtures";

/**
 * ============================ PENDING LIVE VERIFICATION ============================
 * Expertise Ledger journey (governed-decision flywheel) against the LIVE stack
 * with NOTHING mocked: real UI (:3000) -> real bff-graphql (:4000) ->
 * agent-runtime aggregation -> Postgres (RLS).
 *
 * This spec has NOT yet been executed against a live stack from this workstation
 * (no `pnpm e2e:live` run recorded here). It is written against the real
 * /ml/expertise page and the real `expertiseLedger` BFF query, following the
 * fixtures/conventions of ml-journeys.spec.ts + value-journeys.spec.ts. If a
 * live run shows it skipping/failing for a subtler reason, THIS header is the
 * defect to chase.
 *
 * The whole point of this surface is that it never lies, so the assertions are
 * STRUCTURAL, not value-pinned: real tenant data varies run to run, and an
 * empty tenant (no governed decisions captured) is a legitimate, expected state
 * that must render an honest empty message rather than a wall of zeros. The
 * agreement figure must ALWAYS read as either a real percentage or the explicit
 * "Not enough data yet" copy — never "NaN" or "undefined".
 * ==================================================================================
 */

test.describe("Expertise Ledger (governed-decision flywheel)", () => {
  test("admin (ai.agent.read) opens /ml/expertise: page is healthy and every state is honest @expertise-ledger", async ({
    page,
  }) => {
    test.setTimeout(60_000);
    const { admin } = PERSONAS();
    await loginAs(page, admin);

    await page.goto("/ml/expertise");
    await expectPageHealthy(page, { notRedirectedFrom: "/ml/expertise" });

    // The page title always renders (PageHeader), proving the shell + the
    // expertiseLedger data-load header mounted rather than a 500 boundary.
    await expect(page.getByRole("heading", { name: "Expertise Ledger" }).first()).toBeVisible();

    // Two legitimate terminal states: an EMPTY tenant (no governed decisions
    // captured) shows the honest empty message; a tenant WITH decisions shows
    // the four hero tiles. Assert exactly one of them resolved -- never a blank
    // page, never a zero-wall masquerading as data.
    const emptyState = page.getByText(/No governed decisions captured yet/i);
    const decisionsTile = page.getByText("Governed decisions captured");
    await expect(emptyState.or(decisionsTile).first()).toBeVisible({ timeout: 20_000 });

    const isEmpty = await emptyState.isVisible().catch(() => false);
    if (isEmpty) {
      test.info().annotations.push({
        type: "note",
        description: "Tenant has zero governed decisions captured -- honest empty state rendered (expected for a fresh tenant).",
      });
    } else {
      // Hero tiles render with real, non-fabricated structure.
      await expect(page.getByText("Governed decisions captured")).toBeVisible();
      await expect(page.getByText("Expert corrections")).toBeVisible();
      await expect(page.getByText("Model agreement")).toBeVisible();
      await expect(page.getByText("Training corpus")).toBeVisible();

      // The agreement figure must read as EITHER a percentage OR the explicit
      // honest state -- never a coerced 0 that implies the model disagrees with
      // every expert, and never a broken NaN/undefined.
      const agreementLabel = page.getByText("Model agreement");
      await expect(agreementLabel).toBeVisible();
      const percentSomewhere = page.getByText(/\d+%/);
      const notEnough = page.getByText(/Not enough data yet/i);
      await expect(percentSomewhere.or(notEnough).first()).toBeVisible();

      // The model-you-own card is always present with an honest state (either
      // "Owned" with promoted detail, or "No trained model yet"). Match the
      // card's HEADING, not bare text: the page's intro paragraph contains the
      // same phrase, so getByText resolves to two nodes and fails strict mode
      // against a perfectly healthy page.
      await expect(page.getByRole("heading", { name: "The model you own" })).toBeVisible();
    }

    // Whatever state resolved, the rendered page must never leak a broken
    // number formatting -- the honesty invariant, asserted globally.
    const body = await page.locator("body").innerText();
    expect(body).not.toMatch(/NaN/);
    expect(body).not.toMatch(/undefined/);
  });
});
