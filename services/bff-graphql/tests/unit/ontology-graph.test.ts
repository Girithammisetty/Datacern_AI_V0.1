import { describe, it, expect } from "vitest";
import { makeApolloServer } from "../../src/server.js";
import { makeTestContext, testConfig } from "../helpers/context.js";
import { mockFetch, type CapturedRequest } from "../helpers/mockFetch.js";

const cfg = testConfig();

/** dataset-service ontology entities with a resolvable + a dangling relationship. */
function downstream() {
  return mockFetch((req: CapturedRequest) => {
    if (req.path === "/api/v1/ontology/entities" && req.method === "GET") {
      return {
        status: 200,
        body: { data: [
          { id: "o-1", entity_key: "vendor", workspace_id: "ws-1", name: "Vendor",
            description: "A supplier.", attributes: [],
            relationships: [
              { name: "invoices", target: "invoice", cardinality: "has_many" },   // resolves
              { name: "owner", target: "person", cardinality: "has_one" },          // dangling
            ] },
          { id: "o-2", entity_key: "invoice", workspace_id: "ws-1", name: "Invoice",
            description: "A bill.", attributes: [], relationships: [] },
        ] },
      };
    }
    return { status: 404, body: { error: { code: "NOT_FOUND", message: req.path } } };
  });
}

describe("ontology graph navigability (WS4)", () => {
  it("resolves relationship targets to real types and flags dangling ones", async () => {
    const server = makeApolloServer(cfg);
    const { fetchImpl } = downstream();
    const ctx = await makeTestContext(fetchImpl);
    const res = await server.executeOperation(
      { query: `{ ontologyEntities(workspaceId:"ws-1") {
        entityKey relationships { name target targetExists targetName } } }` },
      { contextValue: ctx },
    );
    const body = res.body.kind === "single" ? res.body.singleResult : null;
    expect(body?.errors).toBeUndefined();
    const vendor = (body?.data?.ontologyEntities as any[]).find((e) => e.entityKey === "vendor");
    const [invoices, owner] = vendor.relationships;
    // invoice is a declared type -> navigable, carries its display name.
    expect(invoices).toMatchObject({ target: "invoice", targetExists: true, targetName: "Invoice" });
    // person was never declared -> flagged dangling, no name.
    expect(owner).toMatchObject({ target: "person", targetExists: false, targetName: null });
  });
});
