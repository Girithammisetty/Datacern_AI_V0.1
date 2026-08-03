import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "@/test/utils";

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

import { KnowledgeGapsPanel } from "./KnowledgeGapsPanel";
import type { OntologyEntity } from "@/lib/graphql/operations";

const ENTITIES: OntologyEntity[] = [
  { id: "o-1", entityKey: "claim", workspaceId: "ws-1", name: "Claim",
    description: "A claim.", versionNo: 1, createdAt: null, attributes: [], relationships: [] },
];

const meResult = {
  me: { userId: "u", tenantId: "t", type: "user", scopes: [], roles: ["Admin"],
        capabilities: ["*"], capsDegraded: false },
};

function gap(over: Record<string, unknown> = {}) {
  return {
    transcriptId: "tr-1", runId: "run-1", agentKey: "case-triage", agentVersion: 2,
    missingKnowledge: "the policy exclusion for cosmetic claims",
    knowledgeRelevance: "irrelevant", adoption: "reject",
    decidedBy: "analyst-1", decidedAt: "2026-08-01T00:00:00Z", ...over,
  };
}

beforeEach(() => {
  requests.length = 0;
  handler = (doc) => {
    if (/query Me\b/.test(doc)) return meResult;
    if (doc.includes("query KnowledgeGaps")) return { knowledgeGaps: [gap()] };
    return {};
  };
});

describe("KnowledgeGapsPanel (WS5 steward loop)", () => {
  it("lists gaps with provenance and hides entirely when there are none", async () => {
    const { unmount } = renderWithProviders(<KnowledgeGapsPanel entities={ENTITIES} />);
    expect(await screen.findByText(/policy exclusion for cosmetic claims/)).toBeInTheDocument();
    expect(screen.getByText(/case-triage v2/)).toBeInTheDocument();
    unmount();

    handler = (doc) => {
      if (/query Me\b/.test(doc)) return meResult;
      if (doc.includes("query KnowledgeGaps")) return { knowledgeGaps: [] };
      return {};
    };
    renderWithProviders(<KnowledgeGapsPanel entities={ENTITIES} />);
    await waitFor(() =>
      expect(requests.filter((r) => r.doc.includes("query KnowledgeGaps")).length).toBeGreaterThan(1),
    );
    expect(screen.queryByTestId("knowledge-gaps-panel")).not.toBeInTheDocument();
  });

  it("turns a gap into a governed ontology proposal carrying the gap note", async () => {
    handler = (doc) => {
      if (/query Me\b/.test(doc)) return meResult;
      if (doc.includes("query KnowledgeGaps")) return { knowledgeGaps: [gap()] };
      if (doc.includes("mutation ProposeOntologyUpdate")) {
        return { proposeOntologyUpdate: { entityKey: "claim", workspaceId: "ws-1",
          versionNo: 2, status: "in_review", name: "Claim", description: "",
          attributes: [], relationships: [], diff: null, submittedBy: "u",
          approvedBy: null, decisionNote: null, createdAt: null, decidedAt: null } };
      }
      return {};
    };
    const user = userEvent.setup();
    renderWithProviders(<KnowledgeGapsPanel entities={ENTITIES} />);
    await screen.findByText(/policy exclusion/);

    // The decide controls appear once capabilities resolve.
    await user.selectOptions(await screen.findByLabelText(/Target type for gap tr-1/), "claim");
    await user.click(screen.getByRole("button", { name: /propose update/i }));

    await waitFor(() =>
      expect(requests.some((r) => r.doc.includes("mutation ProposeOntologyUpdate"))).toBe(true),
    );
    const call = requests.find((r) => r.doc.includes("mutation ProposeOntologyUpdate"));
    expect(call?.vars.input).toMatchObject({ workspaceId: "ws-1", entityKey: "claim" });
    // The gap lands as a knowledge note appended to the live description.
    expect(call?.vars.input.description).toContain("A claim.");
    expect(call?.vars.input.description).toContain("Knowledge gap (case-triage, analyst-1)");
    expect(call?.vars.input.description).toContain("policy exclusion for cosmetic claims");
  });
});
