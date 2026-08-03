import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

  it("Export JSON-LD downloads the service's document verbatim", async () => {
    const JSONLD = {
      "@context": { owl: "http://www.w3.org/2002/07/owl#" },
      "@graph": [{ "@id": "urn:datacern:ontology:ws", "@type": "owl:Ontology" }],
    };
    handler = (doc, vars) => {
      if (/query Me\b/.test(doc)) return meResult;
      if (doc.includes("query OntologyEntities")) return entities();
      if (doc.includes("query OntologyJsonLd")) {
        expect(vars).toEqual({ workspaceId: "ws" });
        return { ontologyJsonLd: JSONLD };
      }
      return {};
    };
    // jsdom has no createObjectURL — patch just the two methods (replacing the
    // whole URL global would break `new URL(...)` elsewhere) and capture the
    // blob the page asks to wrap.
    let captured: Blob | null = null;
    // A hash-shaped fake URL: jsdom can't navigate to blob: URLs, but treats a
    // hash change as a no-op, so the anchor click stays silent.
    (URL as any).createObjectURL = (b: Blob) => { captured = b; return "#blob-fake"; };
    (URL as any).revokeObjectURL = () => {};

    const user = userEvent.setup();
    renderWithProviders(<OntologyPage />);
    await user.click(await screen.findByRole("button", { name: /export json-ld/i }));

    await waitFor(() => expect(captured).not.toBeNull());
    expect(captured!.type).toBe("application/ld+json");
    // jsdom's Blob has no .text() — read it the DOM way.
    const text = await new Promise<string>((resolve) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result));
      fr.readAsText(captured!);
    });
    expect(JSON.parse(text)).toEqual(JSONLD);
  });
});
