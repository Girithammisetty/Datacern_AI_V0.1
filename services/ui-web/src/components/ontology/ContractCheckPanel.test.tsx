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

import { ContractCheckPanel } from "./ContractCheckPanel";
import type { OntologyEntity } from "@/lib/graphql/operations";

const ENTITY: OntologyEntity = {
  id: "o-1", entityKey: "vendor", workspaceId: "ws-1", name: "Vendor",
  description: "A supplier.", versionNo: 1, createdAt: null,
  attributes: [
    { name: "vendor_id", dataType: "string", required: true, enumValues: [] },
    { name: "status", dataType: "string", required: false, enumValues: ["active", "inactive"] },
  ],
  relationships: [],
};

let capabilities: string[] = ["*"];

function base(doc: string): any {
  if (/query Me\b/.test(doc)) {
    return { me: { userId: "u", tenantId: "t", type: "user", scopes: [], roles: ["Admin"],
                   capabilities, capsDegraded: false } };
  }
  if (doc.includes("query Datasets")) {
    return { datasets: {
      nodes: [{ id: "ds-1", urn: "wr:t:dataset:dataset/ds-1", name: "Vendors", description: "",
                status: "ready", tags: [], rowCount: 10, createdAt: "" }],
      pageInfo: { nextCursor: null, hasMore: false },
    } };
  }
  if (doc.includes("query DatasetSchema")) {
    // Uppercase on purpose: "Match by name" must match case-insensitively.
    return { datasetSchema: [
      { name: "VENDOR_ID", type: "string", nullable: false, tags: [], inferred: false },
      { name: "status", type: "string", nullable: true, tags: [], inferred: false },
    ] };
  }
  return {};
}

async function openPanel(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("button", { name: /data contract/i }));
  const ds = await screen.findByLabelText("Check against dataset");
  await waitFor(() => expect(ds.querySelectorAll("option").length).toBeGreaterThan(1));
  await user.selectOptions(ds, "ds-1");
  await screen.findByLabelText("Map attribute vendor_id");
}

beforeEach(() => {
  requests.length = 0;
  capabilities = ["*"];
  handler = base;
});

describe("ContractCheckPanel (WS4 data-contract runner)", () => {
  it("renders nothing for a type with no attributes, or without dataset read", async () => {
    const { unmount } = renderWithProviders(
      <ContractCheckPanel entity={{ ...ENTITY, attributes: [] }} />,
    );
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /data contract/i })).not.toBeInTheDocument(),
    );
    unmount();

    capabilities = ["dataset.ontology.read"]; // can see the page, cannot read rows
    renderWithProviders(<ContractCheckPanel entity={ENTITY} />);
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /data contract/i })).not.toBeInTheDocument(),
    );
  });

  it("maps attributes to real columns, matching by name case-insensitively", async () => {
    const user = userEvent.setup();
    renderWithProviders(<ContractCheckPanel entity={ENTITY} />);
    await openPanel(user);

    await user.click(screen.getByRole("button", { name: "Match by name" }));
    expect(screen.getByLabelText("Map attribute vendor_id")).toHaveValue("VENDOR_ID");
    expect(screen.getByLabelText("Map attribute status")).toHaveValue("status");
  });

  it("runs the check with the map and reports a clean pass honestly", async () => {
    handler = (doc, vars) => {
      if (doc.includes("mutation CheckOntologyContract")) {
        expect(vars.input).toMatchObject({
          workspaceId: "ws-1", entityKey: "vendor", datasetId: "ds-1",
          attributeMap: { vendor_id: "VENDOR_ID", status: "status" },
        });
        return { checkOntologyContract: {
          entityKey: "vendor", datasetId: "ds-1", checkedRows: 1200,
          checkedAttributes: ["vendor_id", "status"], violations: [], passed: true,
        } };
      }
      return base(doc);
    };
    const user = userEvent.setup();
    renderWithProviders(<ContractCheckPanel entity={ENTITY} />);
    await openPanel(user);
    await user.click(screen.getByRole("button", { name: "Match by name" }));

    await user.click(screen.getByRole("button", { name: /run check/i }));
    const passed = await screen.findByTestId("contract-passed");
    expect(passed.textContent).toContain("1,200 rows");
    expect(passed.textContent).toContain("2 mapped attributes");
  });

  it("renders violations with the engine's vocabulary, counts and examples", async () => {
    handler = (doc) => {
      if (doc.includes("mutation CheckOntologyContract")) {
        return { checkOntologyContract: {
          entityKey: "vendor", datasetId: "ds-1", checkedRows: 500,
          checkedAttributes: ["status"], passed: false,
          violations: [
            { attribute: "vendor_id", kind: "required_unmapped", column: null, count: null, examples: [] },
            { attribute: "status", kind: "value_not_in_enum", column: "status", count: 7,
              examples: ["ARCHIVED", "unknown"] },
          ],
        } };
      }
      return base(doc);
    };
    const user = userEvent.setup();
    renderWithProviders(<ContractCheckPanel entity={ENTITY} />);
    await openPanel(user);

    // Run with no map at all — the engine itself reports the unmapped required
    // attribute; the UI never pre-blocks or pre-judges.
    await user.click(screen.getByRole("button", { name: /run check/i }));
    const box = await screen.findByTestId("contract-violations");
    expect(box.textContent).toContain("2 violations in 500 rows");
    expect(box.textContent).toContain("required, but not mapped to any column");
    expect(box.textContent).toContain("values outside the allowed set (7)");
    expect(box.textContent).toContain("ARCHIVED");
  });

  it("surfaces a check failure verbatim instead of faking a result", async () => {
    handler = (doc) => {
      if (doc.includes("mutation CheckOntologyContract")) {
        throw new Error("dataset ds-1 has no readable rows");
      }
      return base(doc);
    };
    const user = userEvent.setup();
    renderWithProviders(<ContractCheckPanel entity={ENTITY} />);
    await openPanel(user);

    await user.click(screen.getByRole("button", { name: /run check/i }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("dataset ds-1 has no readable rows");
    expect(screen.queryByTestId("contract-passed")).not.toBeInTheDocument();
  });
});
