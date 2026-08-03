import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "@/test/utils";

let handler: (doc: string) => any = () => ({});
vi.mock("@/lib/graphql/client", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/graphql/client")>();
  return { ...actual, graphqlRequest: async (doc: string) => handler(doc) };
});

import ApiExplorerPage from "./page";

const STRING = { kind: "SCALAR", name: "String", ofType: null };
const CASE_LIST = {
  kind: "NON_NULL", name: null,
  ofType: { kind: "LIST", name: null, ofType: { kind: "NON_NULL", name: null, ofType: { kind: "OBJECT", name: "CaseView", ofType: null } } },
};

function schema() {
  return {
    __schema: {
      queryType: { fields: [
        { name: "caseSearch", description: "Search the worklist.", args: [{ name: "q", type: STRING }], type: CASE_LIST },
        { name: "reportCatalog", description: "Every report the viewer can reach.", args: [], type: CASE_LIST },
      ] },
      mutationType: { fields: [
        { name: "assignCase", description: "Assign a case to a user.",
          args: [{ name: "caseId", type: { kind: "NON_NULL", name: null, ofType: { kind: "SCALAR", name: "ID", ofType: null } } }],
          type: CASE_LIST },
      ] },
    },
  };
}

beforeEach(() => {
  handler = (doc) => {
    if (doc.includes("query ApiSchema")) return schema();
    return {};
  };
});

describe("API explorer (technical fast lane)", () => {
  it("lists live queries + mutations with signatures and filters by search", async () => {
    const user = userEvent.setup();
    renderWithProviders(<ApiExplorerPage />);

    expect(await screen.findByTestId("op-caseSearch")).toBeInTheDocument();
    expect(screen.getByTestId("op-assignCase")).toBeInTheDocument();
    expect(screen.getByText("Search the worklist.")).toBeInTheDocument();
    // Signature renders the wrapped return type.
    expect(screen.getByTestId("op-caseSearch").textContent).toContain("[CaseView!]!");

    await user.type(screen.getByLabelText("Search operations"), "report");
    expect(screen.getByTestId("op-reportCatalog")).toBeInTheDocument();
    expect(screen.queryByTestId("op-caseSearch")).not.toBeInTheDocument();
  });

  it("copies a ready-to-paste skeleton with typed variables", async () => {
    // userEvent.setup() installs a working clipboard stub in jsdom — read it
    // back rather than fighting the getter-only navigator.clipboard.
    const user = userEvent.setup();
    renderWithProviders(<ApiExplorerPage />);
    await screen.findByTestId("op-caseSearch");

    await user.click(screen.getByRole("button", { name: "Copy caseSearch skeleton" }));
    await waitFor(async () => {
      const text = await navigator.clipboard.readText();
      expect(text).toContain("query CaseSearch($q: String)");
      expect(text).toContain("caseSearch(q: $q) {");
    });
  });

  it("says so honestly when introspection is disabled", async () => {
    handler = () => {
      throw new Error("introspection disabled");
    };
    renderWithProviders(<ApiExplorerPage />);
    expect(
      await screen.findByText(/Introspection is disabled on this deployment/),
    ).toBeInTheDocument();
    expect(screen.getByText(/schema\.graphql/)).toBeInTheDocument();
  });
});
