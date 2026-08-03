import { describe, it, expect } from "vitest";
import { makeApolloServer } from "../../src/server.js";
import { makeTestContext, testConfig } from "../helpers/context.js";
import { mockFetch, type CapturedRequest } from "../helpers/mockFetch.js";

const cfg = testConfig();

/** dataset-service WS4 contract surface. */
function downstream() {
  return mockFetch((req: CapturedRequest) => {
    if (req.path === "/api/v1/ontology/entities" && req.method === "GET") {
      return {
        status: 200,
        body: { data: [
          { id: "o-1", entity_key: "vendor", workspace_id: "ws-1", name: "Vendor",
            description: "", relationships: [],
            attributes: [
              { name: "status", data_type: "string", required: true,
                enum: ["active", "dormant"] },
              { name: "nickname", data_type: "string" },
            ] },
        ] },
      };
    }
    if (req.path === "/api/v1/ontology/entities/vendor/contract-check" && req.method === "POST") {
      return {
        status: 200,
        body: { data: {
          entity_key: "vendor", dataset_id: "ds-1", checked_rows: 5,
          checked_attributes: ["status"],
          violations: [
            { attribute: "status", kind: "value_not_in_enum", column: "status",
              count: 1, examples: ["ACTIVE!!"] },
          ],
          passed: false,
        } },
      };
    }
    return { status: 404, body: { error: { code: "NOT_FOUND", message: req.path } } };
  });
}

describe("ontology data contracts (WS4)", () => {
  it("surfaces attribute constraints (required + enumValues) on the type", async () => {
    const server = makeApolloServer(cfg);
    const { fetchImpl } = downstream();
    const ctx = await makeTestContext(fetchImpl);
    const res = await server.executeOperation(
      { query: `{ ontologyEntities(workspaceId:"ws-1") {
        entityKey attributes { name required enumValues } } }` },
      { contextValue: ctx },
    );
    const body = res.body.kind === "single" ? res.body.singleResult : null;
    expect(body?.errors).toBeUndefined();
    const attrs = (body?.data?.ontologyEntities as any[])[0].attributes;
    expect(attrs[0]).toMatchObject({ name: "status", required: true, enumValues: ["active", "dormant"] });
    // Absent constraints map to honest defaults, never invented ones.
    expect(attrs[1]).toMatchObject({ name: "nickname", required: false, enumValues: [] });
  });

  it("checkOntologyContract threads the map through and maps violations back", async () => {
    const server = makeApolloServer(cfg);
    const { fetchImpl, requests } = downstream();
    const ctx = await makeTestContext(fetchImpl);
    const res = await server.executeOperation(
      { query: `mutation {
        checkOntologyContract(input: { workspaceId:"ws-1", entityKey:"vendor", datasetId:"ds-1",
          attributeMap: { status: "status" }, rowLimit: 500 }) {
          entityKey datasetId checkedRows checkedAttributes passed
          violations { attribute kind column count examples }
        }
      }` },
      { contextValue: ctx },
    );
    const body = res.body.kind === "single" ? res.body.singleResult : null;
    expect(body?.errors).toBeUndefined();
    const out = body?.data?.checkOntologyContract as any;
    expect(out).toMatchObject({ entityKey: "vendor", datasetId: "ds-1", checkedRows: 5, passed: false });
    expect(out.violations[0]).toMatchObject({
      attribute: "status", kind: "value_not_in_enum", column: "status", count: 1, examples: ["ACTIVE!!"],
    });
    const post = requests.find((r) => r.method === "POST" && r.path.endsWith("/contract-check"));
    expect(post?.body).toMatchObject({
      workspace_id: "ws-1", dataset_id: "ds-1", attribute_map: { status: "status" }, row_limit: 500,
    });
  });
});
