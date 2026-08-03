import { describe, it, expect } from "vitest";
import { makeApolloServer } from "../../src/server.js";
import { makeTestContext, testConfig } from "../helpers/context.js";
import { mockFetch } from "../helpers/mockFetch.js";

const cfg = testConfig();
const single = (res: any) => (res.body.kind === "single" ? res.body.singleResult : null);

describe("CaseEvidence.entityKey (Knowledge Spine WS5)", () => {
  it("passes the uploader's tag through and stays null when untagged", async () => {
    const server = makeApolloServer(cfg);
    const { fetchImpl } = mockFetch((req) => {
      if (req.path === "/api/v1/cases/case-1") {
        return { status: 200, body: { id: "case-1", case_number: 7, status: "in_progress" } };
      }
      if (req.path === "/api/v1/cases/case-1/evidence") {
        return { status: 200, body: { data: [
          { id: "e-1", case_id: "case-1", filename: "loss-run.pdf",
            content_type: "application/pdf", size_bytes: 100, entity_key: "policy" },
          { id: "e-2", case_id: "case-1", filename: "note.txt",
            content_type: "text/plain", size_bytes: 10 },
        ] } };
      }
      return { status: 404, body: { error: { code: "NOT_FOUND", message: "x", trace_id: "t" } } };
    });
    const ctx = await makeTestContext(fetchImpl);
    const body = single(
      await server.executeOperation(
        { query: `{ case(id:"case-1") { evidence { id entityKey } } }` },
        { contextValue: ctx },
      ),
    );
    expect(body?.errors).toBeUndefined();
    expect(body?.data?.case?.evidence).toEqual([
      { id: "e-1", entityKey: "policy" },
      { id: "e-2", entityKey: null }, // untagged stays honestly null — never guessed
    ]);
  });
});
