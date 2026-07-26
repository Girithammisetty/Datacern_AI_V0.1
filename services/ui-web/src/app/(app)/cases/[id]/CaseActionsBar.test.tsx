import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "@/test/utils";
import type { Case } from "@/lib/graphql/types";
import { CaseActionsBar } from "./page";

let handler: (doc: string, vars: unknown) => unknown = () => ({});
vi.mock("@/lib/graphql/client", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/graphql/client")>();
  return { ...actual, graphqlRequest: async (doc: string, vars: unknown) => handler(doc, vars) };
});

const pushed: { title: string; description?: string; variant?: string }[] = [];
vi.mock("@/stores/ui", async (importActual) => {
  const actual = await importActual<typeof import("@/stores/ui")>();
  return {
    ...actual,
    useToasts: (selector: (s: { push: (t: (typeof pushed)[number]) => void }) => unknown) =>
      selector({ push: (t) => pushed.push(t) }),
  };
});

const emptyPage = { nodes: [], pageInfo: { nextCursor: null, hasMore: false } };
const viewerWith = (capabilities: string[]) => ({
  me: {
    userId: "u",
    tenantId: "t-42",
    type: "user",
    scopes: [],
    roles: [],
    capabilities,
    capsDegraded: false,
  },
});

function stubGraphql(capabilities: string[]) {
  handler = (doc: string) => {
    if (doc.includes("query Me")) return viewerWith(capabilities);
    if (doc.includes("query AssignableUsers")) return { assignableUsers: emptyPage };
    if (doc.includes("query Dispositions")) return { dispositions: [] };
    if (doc.includes("query Connections")) return { connections: emptyPage };
    return {};
  };
}

const openCase: Case = {
  id: "case-9",
  urn: "wr:t-42:case:case/case-9",
  status: "IN_PROGRESS",
  proposals: [],
};

const fetchMock = vi.fn();

beforeEach(() => {
  pushed.length = 0;
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  stubGraphql(["*"]);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const clickTriage = async () => {
  const user = userEvent.setup();
  const btn = await screen.findByRole("button", { name: "Draft recommendation" });
  await user.click(btn);
};

describe("Draft recommendation — the only UI path to the case-triage agent", () => {
  it("posts to the case's triage route and reports that a human must still approve", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ mode: "inline", proposalId: "prop-1", proposalStatus: "PENDING" }),
    });
    renderWithProviders(<CaseActionsBar c={openCase} />);
    await clickTriage();

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledWith("/api/cases/case-9/triage", { method: "POST" });
    // The toast must not claim the disposition was applied — it wasn't. The run
    // produced a PENDING proposal and a second person decides it.
    await waitFor(() =>
      expect(pushed).toEqual([
        {
          title: "Recommendation drafted",
          description: "Review it in the approvals inbox — a second person must approve.",
          variant: "success",
        },
      ]),
    );
  });

  it("tells the user the agent is still working when the run went to Temporal", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ mode: "temporal", runId: "run-2" }),
    });
    renderWithProviders(<CaseActionsBar c={openCase} />);
    await clickTriage();

    await waitFor(() => expect(pushed).toHaveLength(1));
    expect(pushed[0].description).toMatch(/will appear on this case shortly/);
  });

  it("surfaces the server's real authorization message instead of a generic failure", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 403,
      json: async () => ({ error: "You do not have permission to triage this case." }),
    });
    renderWithProviders(<CaseActionsBar c={openCase} />);
    await clickTriage();

    await waitFor(() =>
      expect(pushed).toEqual([
        {
          title: "Could not draft a recommendation",
          description: "You do not have permission to triage this case.",
          variant: "error",
        },
      ]),
    );
  });

  it("does not offer the action to a viewer without case.case.update", async () => {
    // Same capability agent-runtime re-checks before creating the proposal, so
    // a viewer is never shown a button whose run would be refused. The viewer
    // DOES hold case.case.assign, so "Unassign" rendering proves capabilities
    // loaded — without that anchor this assertion would pass vacuously against
    // the pre-load fail-safe empty set.
    stubGraphql(["case.case.assign"]);
    renderWithProviders(<CaseActionsBar c={openCase} />);
    await screen.findByRole("button", { name: "Unassign" });
    expect(screen.queryByRole("button", { name: "Draft recommendation" })).toBeNull();
  });

  it("is absent on a closed case — the whole action bar is", () => {
    renderWithProviders(<CaseActionsBar c={{ ...openCase, status: "CLOSED" }} />);
    expect(screen.queryByRole("button", { name: "Draft recommendation" })).toBeNull();
  });
});
