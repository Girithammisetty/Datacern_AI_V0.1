import { test, expect, loginAs, logout, expectPageHealthy, PERSONAS } from "./fixtures";
import type { Page } from "@playwright/test";

/**
 * DECISION TABLES journeys (BRD 54) — the governed `/decisions` surface,
 * driven against the LIVE stack with NOTHING mocked.
 *
 * Real chain exercised: real UI (:3000) → real bff-graphql (:4000) →
 * case-service (decision-tables domain, app/domain/decisions.py) + the
 * proposal/four-eyes governance path (rbac/OPA for the capability gates) →
 * Postgres (RLS).
 *
 * STATUS: PENDING LIVE VERIFICATION. The `/decisions` UI surface DOES exist
 * (services/ui-web/src/app/(app)/decisions/page.tsx) and the governed decision
 * operations were all verified in services/bff-graphql/src/schema/typeDefs.ts:
 * decisionModels, createDecisionModel, approveDecisionModel,
 * evaluateDecisionModel (the `decisionTableEvaluate`-style op — a single-case
 * dry-run returning {matched, ruleIndex, outcome, dryRun}), and
 * batchEvaluateDecisionModel (propose:true → mints one governed four-eyes
 * proposal per matched case). Because the surface + ops are real, a real spec
 * is authored (not a whole-file fixme). Persona governance rights were verified
 * against services/rbac-service/seed/roles_actions.yaml: Admin holds "*";
 * Use case Admin (part of the datascientist persona's groups) holds
 * case.disposition.create + case.disposition.approve, so it is the DISTINCT
 * second principal the four-eyes rule (author != approver) requires. NOT YET
 * executed against a live stack; treat a first-run failure as a spec defect.
 * Follows the fixtures/conventions of cases-journeys.spec.ts +
 * data-pipeline-journeys.spec.ts (guarded fixme when a genuine precondition —
 * no seeded disposition codes, or no dataset with rows for a fixture case — is
 * absent, rather than a fabricated pass).
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

let tagCounter = 0;
function uniqueTag(prefix: string): string {
  tagCounter += 1;
  return `${prefix}-${Date.now()}-${tagCounter}`;
}

const DISPOSITIONS_Q = /* GraphQL */ `
  query DispositionsE2E { dispositions { code active } }
`;
const DATASETS_Q = /* GraphQL */ `
  query DatasetsForDecisionsE2E($first: Int) { datasets(first: $first) { nodes { id urn name } } }
`;
const DATASET_ROWS_Q = /* GraphQL */ `
  query DatasetRowsForDecisionsE2E($datasetId: ID!, $offset: Int, $limit: Int) {
    datasetRows(datasetId: $datasetId, offset: $offset, limit: $limit) { columns rows total }
  }
`;
const CREATE_CASES_M = /* GraphQL */ `
  mutation CreateCasesForDecisionsE2E($input: CreateCasesInput!) {
    createCases(input: $input) { created { id } deduplicated { id } }
  }
`;

const FOURTEEN_DAYS_MS = 14 * 86_400_000;

/** Create one fixture case from a real dataset row so the single-case dry-run
 * evaluation has a concrete case id to run against. Returns null when the
 * tenant has no dataset with browsable rows (caller annotates + skips only that
 * sub-step; the batch-propose path needs no specific case). */
async function tryCreateFixtureCase(page: Page, tag: string): Promise<string | null> {
  const { datasets } = await graphql<{ datasets: { nodes: { id: string; urn: string; name: string }[] } }>(
    page,
    DATASETS_Q,
    { first: 25 },
  );
  for (const d of datasets.nodes.slice(0, 20)) {
    const { datasetRows } = await graphql<{ datasetRows: { columns: string[]; rows: (string | null)[][]; total: number } }>(
      page,
      DATASET_ROWS_Q,
      { datasetId: d.id, offset: 0, limit: 1 },
    );
    if (datasetRows.total <= 0 || !datasetRows.rows[0]) continue;
    const cells = datasetRows.rows[0];
    const due = new Date(Date.now() + FOURTEEN_DAYS_MS).toISOString().slice(0, 10);
    const { createCases } = await graphql<{
      createCases: { created: { id: string }[]; deduplicated: { id: string }[] };
    }>(page, CREATE_CASES_M, {
      input: {
        datasetUrn: d.urn,
        dueDate: `${due}T23:59:59Z`,
        severity: "medium",
        description: `decision-eval fixture ${tag}`,
        rows: [
          {
            rowPk: `${String(cells[0] ?? "")}::dec-${tag}`,
            displayProjection: datasetRows.columns.map((key, i) => ({ key, value: cells[i] ?? "" })),
          },
        ],
      },
    });
    return createCases.created[0]?.id ?? createCases.deduplicated[0]?.id ?? null;
  }
  return null;
}

test.describe("decision tables: author → four-eyes approve → dry-run evaluate → batch propose", () => {
  test.setTimeout(180_000);

  test("a governed decision table is authored, four-eyes-approved by a second user, then evaluates a case (advisory) and mints proposals on propose", async ({
    page,
  }) => {
    const tag = uniqueTag("dec");
    await loginAs(page, PERSONAS().admin); // holds case.disposition.create (author) + case.case.create (fixture case)

    // Precondition: at least one ACTIVE disposition code must be seeded — a
    // rule's outcome references a disposition code, so with none the table
    // cannot be authored at all. Honest fixme rather than a fabricated pass.
    const { dispositions } = await graphql<{ dispositions: { code: string | null; active: boolean }[] }>(
      page,
      DISPOSITIONS_Q,
    );
    const codes = dispositions.filter((d) => d.active && d.code).map((d) => d.code as string);
    if (codes.length === 0) {
      test.fixme(true, "No active disposition codes seeded in the tenant — a decision table's outcome cannot be set.");
      return;
    }
    const outcomeCode = codes[0];

    // A concrete case for the single-case dry-run (best-effort; the batch path
    // below needs no specific case).
    const fixtureCaseId = await tryCreateFixtureCase(page, tag);

    // 1. Author a draft table through the real UI. The single default rule is
    //    left with a blank column, so the form submits it as an empty condition
    //    list — an "(always)" rule that matches any case deterministically.
    await page.goto("/decisions");
    await expectPageHealthy(page, { notRedirectedFrom: "/decisions" });
    await page.getByRole("button", { name: "New decision table" }).click();

    const form = page.getByTestId("decision-model-form");
    await expect(form).toBeVisible();
    const tableName = `E2E Decision ${tag}`;
    await form.locator("#dm-name").fill(tableName);
    // exact:true — the form also has a "default disposition" select; a loose
    // match would be a Playwright strict-mode violation (2 matches).
    await form.getByLabel("disposition", { exact: true }).selectOption(outcomeCode);
    const [createResp] = await Promise.all([
      page.waitForResponse(
        (r) => r.url().includes("/api/graphql") && (r.request().postData()?.includes("mutation CreateDecisionModel(") ?? false),
      ),
      form.getByRole("button", { name: "Create draft" }).click(),
    ]);
    // ASSERT THE MUTATION, not just that a response arrived. This spec used to
    // discard the body, so a rejected create surfaced 20s later as "the card
    // never appeared" — a symptom that reads like a rendering bug and says
    // nothing about the cause. The list is invalidated on success
    // (useCreateDecisionModel), so if the mutation succeeded the card must
    // follow; failing here first keeps the two apart.
    const createBody = await createResp.json();
    expect(
      createBody.errors,
      `createDecisionModel should not error: ${JSON.stringify(createBody.errors)}`,
    ).toBeFalsy();
    expect(createBody.data?.createDecisionModel?.id, "createDecisionModel must return an id").toBeTruthy();

    const card = page.getByTestId("decision-model-card").filter({ hasText: tableName });
    await expect(card).toBeVisible({ timeout: 20_000 });

    // 2. Four-eyes gate: the AUTHOR cannot approve their own table — the
    //    "Approve & publish" control is present but disabled.
    const authorApprove = card.getByRole("button", { name: /approve & publish/i });
    await expect(authorApprove).toBeVisible();
    await expect(authorApprove).toBeDisabled();

    // 3. A DISTINCT user (datascientist ⊇ Use case Admin: holds
    //    case.disposition.create + .approve) approves and publishes it.
    await logout(page);
    await loginAs(page, PERSONAS().datascientist);
    await page.goto("/decisions");
    await expectPageHealthy(page, { notRedirectedFrom: "/decisions" });
    const approverCard = page.getByTestId("decision-model-card").filter({ hasText: tableName });
    await expect(approverCard).toBeVisible({ timeout: 20_000 });
    const approveBtn = approverCard.getByRole("button", { name: /approve & publish/i });
    await expect(approveBtn).toBeEnabled();
    const [approveResp] = await Promise.all([
      page.waitForResponse(
        (r) => r.url().includes("/api/graphql") && (r.request().postData()?.includes("mutation ApproveDecisionModel(") ?? false),
      ),
      approveBtn.click(),
    ]);
    const approveBody = await approveResp.json();
    expect(approveBody.errors, `approveDecisionModel should not error: ${JSON.stringify(approveBody.errors)}`).toBeFalsy();
    expect(approveBody.data.approveDecisionModel.status).toBe("published");

    // 4. Back as admin, evaluate the PUBLISHED table. A published table unlocks
    //    the run controls (Preview/Propose/Test are published-gated, not
    //    canGovern-gated).
    await logout(page);
    await loginAs(page, PERSONAS().admin);
    await page.goto("/decisions");
    await expectPageHealthy(page, { notRedirectedFrom: "/decisions" });
    const publishedCard = page.getByTestId("decision-model-card").filter({ hasText: tableName });
    await expect(publishedCard).toBeVisible({ timeout: 20_000 });

    if (fixtureCaseId) {
      await test.step("single-case DRY-RUN evaluation returns a decision, records nothing (advisory)", async () => {
        await publishedCard.getByRole("button", { name: "Test against a case" }).click();
        const tester = publishedCard.getByTestId("single-case-tester");
        await expect(tester).toBeVisible();
        await tester.getByLabel("Case id").fill(fixtureCaseId);
        const [evalResp] = await Promise.all([
          page.waitForResponse(
            (r) => r.url().includes("/api/graphql") && (r.request().postData()?.includes("mutation EvaluateDecisionModel(") ?? false),
          ),
          tester.getByRole("button", { name: "Dry-run" }).click(),
        ]);
        const evalBody = await evalResp.json();
        expect(evalBody.errors, `evaluateDecisionModel should not error: ${JSON.stringify(evalBody.errors)}`).toBeFalsy();
        const ev = evalBody.data.evaluateDecisionModel;
        // The returned decision is advisory: a dry run records/changes nothing.
        expect(ev.dryRun, "single-case evaluation must be a dry run (no side effect)").toBe(true);
        expect(typeof ev.matched, "evaluation must report a matched boolean").toBe("boolean");
        // The UI renders the real evaluation outcome (either a fired rule with
        // its outcome, or an explicit no-match) — both prove a governed,
        // side-effect-free evaluation actually ran and rendered.
        await expect(
          tester
            .getByText(/nothing was proposed or changed/i)
            .or(tester.getByText(/no rule matched/i)),
        ).toBeVisible({ timeout: 15_000 });
      });
    } else {
      test.info().annotations.push({
        type: "note",
        description:
          "No dataset with browsable rows was available to mint a fixture case, so the single-case dry-run sub-step was skipped; the batch-propose sub-step below still exercises the governed evaluation path.",
      });
    }

    await test.step("batch PROPOSE mints one governed four-eyes proposal per matched case (the recorded advisory decision)", async () => {
      const [batchResp] = await Promise.all([
        page.waitForResponse(
          (r) => r.url().includes("/api/graphql") && (r.request().postData()?.includes("mutation BatchEvaluate(") ?? false),
        ),
        publishedCard.getByRole("button", { name: "Propose for matches" }).click(),
      ]);
      const batchBody = await batchResp.json();
      expect(batchBody.errors, `batchEvaluateDecisionModel should not error: ${JSON.stringify(batchBody.errors)}`).toBeFalsy();
      const result = batchBody.data.batchEvaluateDecisionModel;
      // proposed:true is the governance assertion — the run went through the
      // real four-eyes proposal path, not a bare preview.
      expect(result.proposed, "propose run must report proposed=true").toBe(true);
      const s = result.summary;
      // When any case matched, exactly that many advisory proposals were minted.
      if (s.matched > 0) {
        expect(s.proposalsCreated, "one proposal per matched case").toBe(s.matched);
      }
      // The results panel reflects the real (not optimistic) proposed run.
      await expect(publishedCard.getByText(/Proposed:/)).toBeVisible({ timeout: 15_000 });
    });
  });
});
