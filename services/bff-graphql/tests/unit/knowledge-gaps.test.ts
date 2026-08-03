import { describe, it, expect } from "vitest";
import { makeApolloServer } from "../../src/server.js";
import { makeTestContext, testConfig } from "../helpers/context.js";
import { mockFetch, type CapturedRequest } from "../helpers/mockFetch.js";

const cfg = testConfig();

/** agent-runtime WS5 steward-queue surface. */
function downstream() {
  return mockFetch((req: CapturedRequest) => {
    if (req.path === "/api/v1/knowledge-gaps" && req.method === "GET") {
      return {
        status: 200,
        body: { data: [{
          transcript_id: "tr-1", run_id: "run-1", agent_key: "case-triage",
          agent_version: 2, missing_knowledge: "the policy exclusion for cosmetic claims",
          knowledge_relevance: "irrelevant", adoption: "reject",
          decided_by: "analyst-1", decided_at: "2026-08-01T00:00:00Z",
        }], page: { next_cursor: null, has_more: false } },
      };
    }
    return { status: 404, body: { error: { code: "NOT_FOUND", message: req.path } } };
  });
}

describe("knowledge gaps (Knowledge Spine WS5)", () => {
  it("lists the missing-knowledge steward queue with provenance", async () => {
    const server = makeApolloServer(cfg);
    const { fetchImpl, requests } = downstream();
    const ctx = await makeTestContext(fetchImpl);
    const res = await server.executeOperation(
      { query: `{ knowledgeGaps(limit: 25) {
        transcriptId runId agentKey agentVersion missingKnowledge
        knowledgeRelevance adoption decidedBy decidedAt } }` },
      { contextValue: ctx },
    );
    const body = res.body.kind === "single" ? res.body.singleResult : null;
    expect(body?.errors).toBeUndefined();
    expect((body?.data?.knowledgeGaps as any[])[0]).toMatchObject({
      transcriptId: "tr-1", agentKey: "case-triage",
      missingKnowledge: "the policy exclusion for cosmetic claims",
      knowledgeRelevance: "irrelevant", adoption: "reject", decidedBy: "analyst-1",
    });
    const get = requests.find((r) => r.path === "/api/v1/knowledge-gaps");
    expect(get?.search.get("limit")).toBe("25");
  });
});
