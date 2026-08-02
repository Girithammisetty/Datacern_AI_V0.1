import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { renderWithProviders } from "@/test/utils";

let handler: (doc: string, vars: any) => any = () => ({});
vi.mock("@/lib/graphql/client", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/graphql/client")>();
  return { ...actual, graphqlRequest: async (doc: string, vars: any) => handler(doc, vars) };
});

import OntologyPage from "./page";

const meResult = {
  me: { userId: "u", tenantId: "t", type: "user", scopes: [], roles: ["Admin"],
        capabilities: ["*"], capsDegraded: false },
};

function entities() {
  return {
    ontologyEntities: [
      { id: "o-1", entityKey: "vendor", workspaceId: "ws", name: "Vendor", description: "A supplier.",
        attributes: [], relationships: [
          { name: "invoices", target: "invoice", cardinality: "has_many", targetExists: true, targetName: "Invoice" },
          { name: "owner", target: "person", cardinality: "has_one", targetExists: false, targetName: null },
        ] },
      { id: "o-2", entityKey: "invoice", workspaceId: "ws", name: "Invoice", description: "A bill.",
        attributes: [], relationships: [] },
    ],
  };
}

beforeEach(() => {
  handler = (doc) => {
    if (/query Me\b/.test(doc)) return meResult;
    if (doc.includes("query OntologyEntities")) return entities();
    return {};
  };
});

describe("Ontology page — navigable relationships (WS4)", () => {
  it("links a resolvable target to its card and flags a dangling one", async () => {
    renderWithProviders(<OntologyPage />);
    // A resolvable target renders as an anchor to the target type's card.
    const link = await screen.findByRole("link", { name: "Invoice" });
    expect(link).toHaveAttribute("href", "#onto-invoice");
    // A dangling target is flagged, not silently rendered.
    await waitFor(() => expect(screen.getByText("missing type")).toBeInTheDocument());
  });
});
