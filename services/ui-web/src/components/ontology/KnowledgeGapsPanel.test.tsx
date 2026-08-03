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
import { useToasts } from "@/stores/ui";
import type { OntologyEntity } from "@/lib/graphql/operations";

const ENTITIES: OntologyEntity[] = [
  { id: "o-1", entityKey: "claim", workspaceId: "ws-1", name: "Claim",
    description: "A claim.", versionNo: 1, createdAt: null,
    attributes: [
      { name: "status", dataType: "string", required: true, enumValues: ["open", "paid"] },
    ],
    relationships: [] },
];

const PROPOSE_OK = {
  proposeOntologyUpdate: { entityKey: "claim", workspaceId: "ws-1",
    versionNo: 2, status: "in_review", name: "Claim", description: "",
    attributes: [], relationships: [], diff: null, submittedBy: "u",
    approvedBy: null, decisionNote: null, createdAt: null, decidedAt: null },
};

const meResult = {
  me: { userId: "u", tenantId: "t", type: "user", scopes: [], roles: ["Admin"],
        capabilities: ["*"], capsDegraded: false },
};

function gap(over: Record<string, unknown> = {}) {
  return {
    transcriptId: "tr-1", runId: "run-1", agentKey: "case-triage", agentVersion: 2,
    missingKnowledge: "the policy exclusion for cosmetic claims",
    knowledgeRelevance: "irrelevant", adoption: "reject",
    decidedBy: "analyst-1", decidedAt: "2026-08-01T00:00:00Z",
    gapStatus: null, gapDecidedBy: null, gapDecidedAt: null, ...over,
  };
}

beforeEach(() => {
  requests.length = 0;
  useToasts.setState({ toasts: [] });
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
      if (doc.includes("mutation ProposeOntologyUpdate")) return PROPOSE_OK;
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
    // The note shape never touches the attribute list.
    expect(call?.vars.input.attributes).toBeUndefined();
  });

  it("proposes a new attribute, re-sending existing attributes with constraints intact", async () => {
    handler = (doc) => {
      if (/query Me\b/.test(doc)) return meResult;
      if (doc.includes("query KnowledgeGaps")) return { knowledgeGaps: [gap()] };
      if (doc.includes("mutation ProposeOntologyUpdate")) return PROPOSE_OK;
      return {};
    };
    const user = userEvent.setup();
    renderWithProviders(<KnowledgeGapsPanel entities={ENTITIES} />);
    await screen.findByText(/policy exclusion/);

    await user.selectOptions(await screen.findByLabelText(/Proposal shape for gap tr-1/), "attribute");
    await user.selectOptions(screen.getByLabelText(/Target type for gap tr-1/), "claim");
    await user.type(screen.getByLabelText(/Attribute name for gap tr-1/), "exclusion_code");
    await user.selectOptions(screen.getByLabelText(/Attribute data type for gap tr-1/), "string");
    await user.click(screen.getByRole("button", { name: /propose update/i }));

    const call = await waitFor(() => {
      const c = requests.find((r) => r.doc.includes("mutation ProposeOntologyUpdate"));
      expect(c).toBeTruthy();
      return c!;
    });
    // Overlay semantics replace the list — the existing attribute must ride
    // along byte-for-byte (constraints included) so the diff is exactly +1.
    expect(call.vars.input.attributes).toEqual([
      { name: "status", dataType: "string", required: true, enumValues: ["open", "paid"] },
      { name: "exclusion_code", dataType: "string" },
    ]);
    expect(call.vars.input.description).toContain("Knowledge gap");
  });

  it("rejects a malformed attribute name client-side without calling the API", async () => {
    const user = userEvent.setup();
    renderWithProviders(<KnowledgeGapsPanel entities={ENTITIES} />);
    await screen.findByText(/policy exclusion/);

    await user.selectOptions(await screen.findByLabelText(/Proposal shape for gap tr-1/), "attribute");
    await user.selectOptions(screen.getByLabelText(/Target type for gap tr-1/), "claim");
    await user.type(screen.getByLabelText(/Attribute name for gap tr-1/), "Not A Slug");
    await user.click(screen.getByRole("button", { name: /propose update/i }));

    // Toasts render in the app shell's ToastHost — assert the store directly.
    await waitFor(() =>
      expect(useToasts.getState().toasts.some((t) => /lowercase slug/.test(t.title))).toBe(true),
    );
    expect(requests.some((r) => r.doc.includes("mutation ProposeOntologyUpdate"))).toBe(false);
  });

  it("acting on a gap marks it handled — only after the proposal succeeded", async () => {
    handler = (doc) => {
      if (/query Me\b/.test(doc)) return meResult;
      if (doc.includes("query KnowledgeGaps")) return { knowledgeGaps: [gap()] };
      if (doc.includes("mutation ProposeOntologyUpdate")) return PROPOSE_OK;
      if (doc.includes("mutation DecideKnowledgeGap")) {
        return { decideKnowledgeGap: { transcriptId: "tr-1", status: "handled", decidedBy: "u" } };
      }
      return {};
    };
    const user = userEvent.setup();
    renderWithProviders(<KnowledgeGapsPanel entities={ENTITIES} />);
    await screen.findByText(/policy exclusion/);

    await user.selectOptions(await screen.findByLabelText(/Target type for gap tr-1/), "claim");
    await user.click(screen.getByRole("button", { name: /propose update/i }));

    const decideCall = await waitFor(() => {
      const c = requests.find((r) => r.doc.includes("mutation DecideKnowledgeGap"));
      expect(c).toBeTruthy();
      return c!;
    });
    expect(decideCall.vars).toEqual({ transcriptId: "tr-1", status: "handled" });
    // The propose ran FIRST — handled is a fact, not an intent.
    const proposeIdx = requests.findIndex((r) => r.doc.includes("mutation ProposeOntologyUpdate"));
    const decideIdx = requests.findIndex((r) => r.doc.includes("mutation DecideKnowledgeGap"));
    expect(proposeIdx).toBeGreaterThanOrEqual(0);
    expect(decideIdx).toBeGreaterThan(proposeIdx);
  });

  it("Dismiss triages a gap without proposing anything", async () => {
    handler = (doc) => {
      if (/query Me\b/.test(doc)) return meResult;
      if (doc.includes("query KnowledgeGaps")) return { knowledgeGaps: [gap()] };
      if (doc.includes("mutation DecideKnowledgeGap")) {
        return { decideKnowledgeGap: { transcriptId: "tr-1", status: "dismissed", decidedBy: "u" } };
      }
      return {};
    };
    const user = userEvent.setup();
    renderWithProviders(<KnowledgeGapsPanel entities={ENTITIES} />);
    await screen.findByText(/policy exclusion/);

    await user.click(await screen.findByRole("button", { name: /Dismiss gap tr-1/ }));
    await waitFor(() => {
      const c = requests.find((r) => r.doc.includes("mutation DecideKnowledgeGap"));
      expect(c?.vars).toEqual({ transcriptId: "tr-1", status: "dismissed" });
    });
    expect(requests.some((r) => r.doc.includes("mutation ProposeOntologyUpdate"))).toBe(false);
  });

  it("Show resolved lists triaged gaps read-only with their state", async () => {
    handler = (doc, vars) => {
      if (/query Me\b/.test(doc)) return meResult;
      if (doc.includes("query KnowledgeGaps")) {
        // Open view: empty. Resolved view: one dismissed gap.
        if (vars?.includeDecided) {
          return { knowledgeGaps: [gap({ gapStatus: "dismissed", gapDecidedBy: "steward-1" })] };
        }
        return { knowledgeGaps: [gap()] };
      }
      return {};
    };
    const user = userEvent.setup();
    renderWithProviders(<KnowledgeGapsPanel entities={ENTITIES} />);
    await screen.findByText(/policy exclusion/);

    await user.click(screen.getByRole("button", { name: /show resolved/i }));
    expect(await screen.findByText(/dismissed by steward-1/)).toBeInTheDocument();
    // Triaged rows are history — no shape controls, no dismiss.
    expect(screen.queryByLabelText(/Proposal shape for gap tr-1/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Dismiss gap tr-1/ })).not.toBeInTheDocument();
  });

  it("creates a new type seeded from the gap — created, never claimed as proposed", async () => {
    handler = (doc) => {
      if (/query Me\b/.test(doc)) return meResult;
      if (doc.includes("query KnowledgeGaps")) return { knowledgeGaps: [gap()] };
      if (doc.includes("mutation CreateOntologyEntity")) {
        return { createOntologyEntity: { id: "o-9", entityKey: "payer", name: "Payer" } };
      }
      return {};
    };
    const user = userEvent.setup();
    renderWithProviders(<KnowledgeGapsPanel entities={ENTITIES} />);
    await screen.findByText(/policy exclusion/);

    await user.selectOptions(await screen.findByLabelText(/Proposal shape for gap tr-1/), "newtype");
    await user.type(screen.getByLabelText(/New type key for gap tr-1/), "payer");
    await user.type(screen.getByLabelText(/New type name for gap tr-1/), "Payer");
    await user.click(screen.getByRole("button", { name: /create type/i }));

    const call = await waitFor(() => {
      const c = requests.find((r) => r.doc.includes("mutation CreateOntologyEntity"));
      expect(c).toBeTruthy();
      return c!;
    });
    expect(call.vars.input).toMatchObject({ workspaceId: "ws-1", entityKey: "payer", name: "Payer" });
    expect(call.vars.input.description).toContain("Knowledge gap (case-triage, analyst-1)");
    // Honest wording: creation is immediate, not a four-eyes proposal.
    await waitFor(() =>
      expect(useToasts.getState().toasts.some(
        (t) => /Creation is immediate/.test(t.description ?? ""),
      )).toBe(true),
    );
  });
});
