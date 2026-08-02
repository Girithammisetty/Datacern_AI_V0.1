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

import { OntologyVersionPanel } from "./OntologyVersionPanel";
import type { OntologyEntity } from "@/lib/graphql/operations";

const ENTITY: OntologyEntity = {
  id: "o-1", entityKey: "vendor", workspaceId: "ws-1", name: "Vendor",
  description: "A supplier.", versionNo: 1, createdAt: null, attributes: [], relationships: [],
};

const meResult = {
  me: { userId: "u", tenantId: "t", type: "user", scopes: [], roles: ["Admin"],
        capabilities: ["*"], capsDegraded: false },
};

function version(over: Record<string, unknown> = {}) {
  return {
    entityKey: "vendor", workspaceId: "ws-1", versionNo: 2, status: "in_review",
    name: "Supplier", description: "", attributes: [], relationships: [], diff: null,
    submittedBy: "author", approvedBy: null, decisionNote: null,
    createdAt: "2026-08-02T00:00:00Z", decidedAt: null, ...over,
  };
}

function base(doc: string): any {
  if (/query Me\b/.test(doc)) return meResult;
  if (doc.includes("query OntologyVersions")) {
    return { ontologyVersions: [
      version(),
      version({ versionNo: 1, status: "published", name: "Vendor", submittedBy: "creator", approvedBy: "creator" }),
    ] };
  }
  return {};
}

beforeEach(() => {
  requests.length = 0;
  handler = base;
});

describe("OntologyVersionPanel (WS3 review queue)", () => {
  it("loads history on expand and shows the in-review proposal with decide controls", async () => {
    renderWithProviders(<OntologyVersionPanel entity={ENTITY} />);
    // Versions are NOT fetched until the panel is expanded.
    expect(requests.some((r) => r.doc.includes("query OntologyVersions"))).toBe(false);

    await userEvent.click(screen.getByRole("button", { name: /history & review/i }));

    await waitFor(() => expect(screen.getByText("v2")).toBeInTheDocument());
    // Both the toggle badge ("1 in review") and the row status badge show it.
    expect(screen.getAllByText(/in review/i).length).toBeGreaterThan(0);
    // The in-review row exposes Approve/Reject; the published row does not.
    expect(screen.getByRole("button", { name: /approve/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /reject/i })).toBeInTheDocument();
  });

  it("approves the in-review version with the right variables", async () => {
    handler = (doc) => {
      if (doc.includes("mutation ApproveOntologyUpdate")) {
        return { approveOntologyUpdate: version({ status: "published", approvedBy: "me" }) };
      }
      return base(doc);
    };
    renderWithProviders(<OntologyVersionPanel entity={ENTITY} />);
    await userEvent.click(screen.getByRole("button", { name: /history & review/i }));
    await waitFor(() => expect(screen.getByText("v2")).toBeInTheDocument());

    await userEvent.click(screen.getByRole("button", { name: /approve/i }));
    await waitFor(() =>
      expect(requests.some((r) => r.doc.includes("mutation ApproveOntologyUpdate"))).toBe(true),
    );
    const call = requests.find((r) => r.doc.includes("mutation ApproveOntologyUpdate"));
    expect(call?.vars).toMatchObject({ entityKey: "vendor", workspaceId: "ws-1", versionNo: 2 });
  });

  it("proposes an update carrying the edited fields", async () => {
    handler = (doc) => {
      if (doc.includes("mutation ProposeOntologyUpdate")) {
        return { proposeOntologyUpdate: version() };
      }
      return base(doc);
    };
    renderWithProviders(<OntologyVersionPanel entity={ENTITY} />);
    await userEvent.click(screen.getByRole("button", { name: /history & review/i }));
    await userEvent.click(screen.getByRole("button", { name: /propose update/i }));

    const name = screen.getByLabelText("Name");
    await userEvent.clear(name);
    await userEvent.type(name, "Supplier");
    await userEvent.click(screen.getByRole("button", { name: /submit proposal/i }));

    await waitFor(() =>
      expect(requests.some((r) => r.doc.includes("mutation ProposeOntologyUpdate"))).toBe(true),
    );
    const call = requests.find((r) => r.doc.includes("mutation ProposeOntologyUpdate"));
    expect(call?.vars.input).toMatchObject({ entityKey: "vendor", workspaceId: "ws-1", name: "Supplier" });
  });
});
