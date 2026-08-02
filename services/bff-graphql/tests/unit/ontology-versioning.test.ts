import { describe, it, expect } from "vitest";
import { makeApolloServer } from "../../src/server.js";
import { makeTestContext, testConfig } from "../helpers/context.js";
import { mockFetch, type CapturedRequest } from "../helpers/mockFetch.js";

const cfg = testConfig();
const WS = "ws-1";

/** dataset-service (:8304) ontology versioning surface (WS3). */
function downstream() {
  return mockFetch((req: CapturedRequest) => {
    // versions list
    if (req.path === "/api/v1/ontology/entities/vendor/versions" && req.method === "GET") {
      return {
        status: 200,
        body: { data: [
          { entity_key: "vendor", workspace_id: WS, version_no: 2, status: "in_review",
            name: "Supplier", description: "", attributes: [{ name: "tax_id", data_type: "string" }],
            relationships: [], diff: null, submitted_by: "author", approved_by: null,
            decision_note: null, created_at: "2026-08-02T00:00:00Z", decided_at: null },
          { entity_key: "vendor", workspace_id: WS, version_no: 1, status: "published",
            name: "Vendor", description: "A supplier.", attributes: [], relationships: [],
            diff: null, submitted_by: "creator", approved_by: "creator",
            decision_note: "bootstrap (initial version)", created_at: "2026-08-01T00:00:00Z",
            decided_at: "2026-08-01T00:00:00Z" },
        ] },
      };
    }
    // propose
    if (req.path === "/api/v1/ontology/entities/vendor/versions" && req.method === "POST") {
      return {
        status: 201,
        body: { data: {
          entity_key: "vendor", workspace_id: WS, version_no: 2, status: "in_review",
          name: "Supplier", description: "A supplier.", attributes: [{ name: "tax_id" }],
          relationships: [], diff: null, submitted_by: "author", approved_by: null,
          decision_note: null, created_at: "2026-08-02T00:00:00Z", decided_at: null,
        } },
      };
    }
    // approve
    if (req.path === "/api/v1/ontology/entities/vendor/versions/2/approve" && req.method === "POST") {
      return {
        status: 200,
        body: { data: {
          entity_key: "vendor", workspace_id: WS, version_no: 2, status: "published",
          name: "Supplier", description: "A supplier.", attributes: [{ name: "tax_id" }],
          relationships: [], diff: { name_changed: true, attributes: { added: ["tax_id"], removed: [], changed: [] } },
          submitted_by: "author", approved_by: "approver", decision_note: "ok",
          created_at: "2026-08-02T00:00:00Z", decided_at: "2026-08-02T01:00:00Z",
        } },
      };
    }
    // reject
    if (req.path === "/api/v1/ontology/entities/vendor/versions/2/reject" && req.method === "POST") {
      return {
        status: 200,
        body: { data: {
          entity_key: "vendor", workspace_id: WS, version_no: 2, status: "rejected",
          name: "Supplier", description: "", attributes: [], relationships: [], diff: null,
          submitted_by: "author", approved_by: "approver", decision_note: "not now",
          created_at: "2026-08-02T00:00:00Z", decided_at: "2026-08-02T01:00:00Z",
        } },
      };
    }
    return { status: 404, body: { error: { code: "NOT_FOUND", message: req.path } } };
  });
}

describe("ontology versioning resolvers (WS3 four-eyes)", () => {
  it("ontologyVersions lists the history + in-review proposal newest first", async () => {
    const server = makeApolloServer(cfg);
    const { fetchImpl } = downstream();
    const ctx = await makeTestContext(fetchImpl);
    const res = await server.executeOperation(
      { query: `{ ontologyVersions(entityKey:"vendor", workspaceId:"${WS}") {
        versionNo status name submittedBy approvedBy } }` },
      { contextValue: ctx },
    );
    const body = res.body.kind === "single" ? res.body.singleResult : null;
    expect(body?.errors).toBeUndefined();
    const versions = (body?.data?.ontologyVersions as any[]);
    expect(versions.map((v) => v.versionNo)).toEqual([2, 1]);
    expect(versions[0]).toMatchObject({ status: "in_review", name: "Supplier", submittedBy: "author" });
  });

  it("proposeOntologyUpdate forwards only the fields the caller set", async () => {
    const server = makeApolloServer(cfg);
    const { fetchImpl, requests } = downstream();
    const ctx = await makeTestContext(fetchImpl);
    const res = await server.executeOperation(
      { query: `mutation {
        proposeOntologyUpdate(input:{ workspaceId:"${WS}", entityKey:"vendor", name:"Supplier",
          attributes:[{ name:"tax_id", dataType:"string" }] }) { versionNo status }
      }` },
      { contextValue: ctx },
    );
    const body = res.body.kind === "single" ? res.body.singleResult : null;
    expect(body?.errors).toBeUndefined();
    expect(body?.data?.proposeOntologyUpdate).toMatchObject({ versionNo: 2, status: "in_review" });
    const post = requests.find((r) => r.method === "POST" && r.path === "/api/v1/ontology/entities/vendor/versions");
    // name + attributes set; description + relationships omitted (keep live definition).
    expect(post?.body).toEqual({
      workspace_id: WS, name: "Supplier", attributes: [{ name: "tax_id", data_type: "string" }],
    });
  });

  it("approveOntologyUpdate publishes and surfaces the diff", async () => {
    const server = makeApolloServer(cfg);
    const { fetchImpl } = downstream();
    const ctx = await makeTestContext(fetchImpl);
    const res = await server.executeOperation(
      { query: `mutation {
        approveOntologyUpdate(entityKey:"vendor", workspaceId:"${WS}", versionNo:2, note:"ok") {
          status approvedBy diff }
      }` },
      { contextValue: ctx },
    );
    const body = res.body.kind === "single" ? res.body.singleResult : null;
    expect(body?.errors).toBeUndefined();
    const v = body?.data?.approveOntologyUpdate as any;
    expect(v).toMatchObject({ status: "published", approvedBy: "approver" });
    expect(v.diff.attributes.added).toEqual(["tax_id"]);
  });

  it("rejectOntologyUpdate closes the proposal", async () => {
    const server = makeApolloServer(cfg);
    const { fetchImpl } = downstream();
    const ctx = await makeTestContext(fetchImpl);
    const res = await server.executeOperation(
      { query: `mutation {
        rejectOntologyUpdate(entityKey:"vendor", workspaceId:"${WS}", versionNo:2, note:"not now") { status }
      }` },
      { contextValue: ctx },
    );
    const body = res.body.kind === "single" ? res.body.singleResult : null;
    expect(body?.errors).toBeUndefined();
    expect(body?.data?.rejectOntologyUpdate).toMatchObject({ status: "rejected" });
  });
});
