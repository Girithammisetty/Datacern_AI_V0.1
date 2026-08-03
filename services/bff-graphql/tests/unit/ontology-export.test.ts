import { describe, it, expect } from "vitest";
import { makeApolloServer } from "../../src/server.js";
import { makeTestContext, testConfig } from "../helpers/context.js";
import { mockFetch, type CapturedRequest } from "../helpers/mockFetch.js";

const cfg = testConfig();

/** A miniature but structurally real JSON-LD document, as dataset-service
 * serves it (the whole body IS the document — no {data} envelope). */
const JSONLD = {
  "@context": { owl: "http://www.w3.org/2002/07/owl#" },
  "@graph": [
    { "@id": "urn:datacern:ontology:ws-1", "@type": "owl:Ontology" },
    { "@id": "urn:datacern:ontology:ws-1:type:vendor", "@type": "owl:Class",
      "rdfs:label": "Vendor", "owl:versionInfo": "v3" },
  ],
};

function downstream() {
  return mockFetch((req: CapturedRequest) => {
    if (req.path === "/api/v1/ontology/export" && req.method === "GET") {
      if (req.search.get("filter[workspace_id]") !== "ws-1") {
        return { status: 422, body: { error: { code: "VALIDATION", message: "workspace required" } } };
      }
      return { status: 200, body: JSONLD };
    }
    return { status: 404, body: { error: { code: "NOT_FOUND", message: req.path } } };
  });
}

describe("ontology OWL/JSON-LD export (WS4 interop leg)", () => {
  it("passes the JSON-LD document through verbatim", async () => {
    const server = makeApolloServer(cfg);
    const { fetchImpl } = downstream();
    const ctx = await makeTestContext(fetchImpl);
    const res = await server.executeOperation(
      { query: `{ ontologyJsonLd(workspaceId: "ws-1") }` },
      { contextValue: ctx },
    );
    const body = res.body.kind === "single" ? res.body.singleResult : null;
    expect(body?.errors).toBeUndefined();
    // Verbatim pass-through — reshaping would make the export lie.
    expect(body?.data?.ontologyJsonLd).toEqual(JSONLD);
  });

  it("surfaces a downstream failure instead of fabricating a document", async () => {
    const server = makeApolloServer(cfg);
    const { fetchImpl } = mockFetch(() => ({
      status: 503, body: { error: { code: "UNAVAILABLE", message: "dataset-service down" } },
    }));
    const ctx = await makeTestContext(fetchImpl);
    const res = await server.executeOperation(
      { query: `{ ontologyJsonLd(workspaceId: "ws-1") }` },
      { contextValue: ctx },
    );
    const body = res.body.kind === "single" ? res.body.singleResult : null;
    expect(body?.errors?.[0]?.message).toContain("dataset-service down");
    expect(body?.data).toBeFalsy();
  });
});
