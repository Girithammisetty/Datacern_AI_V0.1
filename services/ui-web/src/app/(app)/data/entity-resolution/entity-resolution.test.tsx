import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "@/test/utils";

/**
 * Entity Resolution steward surface (BRD 56). Verifies the request wiring for the
 * three read paths (datasets → runs → candidates) and the four-eyes propose-merge
 * mutation, plus the "a different user approves in the inbox" affordance that
 * enforces (in the UI) that the steward does not self-approve.
 */
let handler: (doc: string, vars: any) => any = () => ({});
const requests: { doc: string; vars: any }[] = [];
vi.mock("@/lib/graphql/client", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/graphql/client")>();
  return {
    ...actual,
    graphqlRequest: async (doc: string, vars: any) => {
      requests.push({ doc, vars });
      return handler(doc, vars);
    },
  };
});

import EntityResolutionPage from "./page";

const meResult = {
  me: { userId: "u", tenantId: "t-42", type: "user", scopes: [],
        roles: ["Admin"], capabilities: ["*"], capsDegraded: false },
};

function run(overrides: Record<string, unknown> = {}) {
  return {
    runId: "run-1234abcd", datasetId: "ds-1", configId: "cfg-1", entityType: "claimant",
    recordCount: 14, resolvedEntityCount: 12, mergedClusterCount: 1, reviewCandidateCount: 1,
    status: "completed", createdBy: "steward", createdAt: "2026-07-17T00:00:00Z", ...overrides,
  };
}
function candidate(overrides: Record<string, unknown> = {}) {
  return {
    id: "cand-1", runId: "run-1234abcd", datasetId: "ds-1", entityType: "claimant",
    leftPk: "CLM-1001", rightPk: "CLM-1002", score: 0.943, evidence: { policy_no: "P-9" },
    status: "pending", proposalId: null, decidedBy: null, decidedAt: null,
    createdAt: "2026-07-17T00:00:00Z", ...overrides,
  };
}

function baseHandler(doc: string): any {
  // NB: check the more specific ops first — "query Me" is a prefix of
  // "query MergeCandidates", so match it last / precisely.
  if (doc.includes("query MergeCandidates")) return { mergeCandidates: [candidate()] };
  if (/query Me\b/.test(doc) && !doc.includes("MergeCandidates")) return meResult;
  if (doc.includes("query Datasets")) {
    return { datasets: { nodes: [{ id: "ds-1", urn: "wr:t:dataset/ds-1", name: "auto_claims",
      description: null, status: "ready", tags: [], rowCount: 14, createdAt: null }],
      pageInfo: { nextCursor: null, hasMore: false } } };
  }
  if (doc.includes("query DatasetSchema")) {
    return { datasetSchema: [
      { name: "claim_id", type: "string", nullable: false, tags: [], inferred: false },
      { name: "policy_no", type: "string", nullable: true, tags: [], inferred: false },
      { name: "amount", type: "double", nullable: true, tags: [], inferred: false },
    ] };
  }
  if (doc.includes("query ResolutionRuns")) return { resolutionRuns: [run()] };
  return {};
}

beforeEach(() => {
  requests.length = 0;
  handler = baseHandler;
});

async function selectDataset() {
  const user = userEvent.setup();
  renderWithProviders(<EntityResolutionPage />);
  const select = await screen.findByLabelText("Dataset");
  // The dataset list loads async; wait for its option before selecting.
  await screen.findByRole("option", { name: "auto_claims" });
  await user.selectOptions(select, "ds-1");
  return user;
}

describe("EntityResolutionPage (BRD 56 steward surface)", () => {
  it("loads runs for the selected dataset and renders the run summary", async () => {
    await selectDataset();
    await waitFor(() => {
      const call = requests.find((r) => r.doc.includes("query ResolutionRuns"));
      expect(call?.vars.datasetId).toBe("ds-1");
    });
    expect(await screen.findByTestId("er-run-card")).toBeInTheDocument();
    expect(screen.getByText(/14 records → 12 entities/)).toBeInTheDocument();
  });

  it("shows a below-auto merge candidate in the review tab", async () => {
    await selectDataset();
    const card = await screen.findByTestId("er-run-card");
    expect(await within(card).findByTestId("er-candidate")).toBeInTheDocument();
    expect(within(card).getByText("CLM-1001")).toBeInTheDocument();
    expect(within(card).getByText(/score 0.943/)).toBeInTheDocument();
  });

  it("opens a four-eyes proposal and surfaces the 'approve in the inbox' affordance", async () => {
    handler = (doc: string, vars: any) => {
      if (doc.includes("mutation ProposeEntityMerge")) {
        // The caller-gate + four-eyes live server-side; the UI just opens the proposal.
        expect(vars.input.candidateId).toBe("cand-1");
        return { proposeEntityMerge: { proposalId: "prop-9999zzzz", status: "pending", executed: false, runId: "run-1234abcd" } };
      }
      return baseHandler(doc);
    };
    const user = await selectDataset();
    const card = await screen.findByTestId("er-run-card");
    await within(card).findByTestId("er-candidate");
    await user.click(within(card).getByRole("button", { name: /Propose merge/i }));

    expect(await within(card).findByTestId("er-proposed")).toBeInTheDocument();
    const inboxLink = within(card).getByRole("link", { name: /approves it in the inbox/i });
    expect(inboxLink).toHaveAttribute("href", "/inbox");
    expect(requests.some((r) => r.doc.includes("mutation ProposeEntityMerge"))).toBe(true);
  });

  it("browses the resolved-entity view with merged-cluster lineage", async () => {
    handler = (doc: string) => {
      if (doc.includes("query ResolutionRunDetail")) {
        return { resolutionRun: { ...run(), clusters: [
          { resolvedEntityId: "ent:claimant:CLM-1001", memberCount: 3, confidence: 1.0, method: "deterministic",
            members: [
              { memberPk: "CLM-1001", method: "deterministic", evidence: null },
              { memberPk: "CLM-1002", method: "deterministic", evidence: null },
              { memberPk: "CLM-1003", method: "deterministic", evidence: null },
            ] },
        ] } };
      }
      return baseHandler(doc);
    };
    const user = await selectDataset();
    const card = await screen.findByTestId("er-run-card");
    await user.click(within(card).getByRole("button", { name: /Resolved entities/i }));
    const cluster = await within(card).findByTestId("er-cluster");
    expect(within(cluster).getByText("merged ×3")).toBeInTheDocument();
  });

  it("shows the empty state when the dataset has no runs yet", async () => {
    handler = (doc: string) => {
      if (doc.includes("query ResolutionRuns")) return { resolutionRuns: [] };
      return baseHandler(doc);
    };
    await selectDataset();
    expect(await screen.findByText(/No resolution runs yet/i)).toBeInTheDocument();
  });
});
