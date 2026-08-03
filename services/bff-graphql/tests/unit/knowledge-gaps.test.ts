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

describe("knowledge-gap triage (WS5 handled/dismissed)", () => {
  it("passes includeDecided through and surfaces triage state", async () => {
    const server = makeApolloServer(cfg);
    const { fetchImpl, requests } = mockFetch((req: CapturedRequest) => {
      if (req.path === "/api/v1/knowledge-gaps" && req.method === "GET") {
        return {
          status: 200,
          body: { data: [{
            transcript_id: "tr-1", run_id: "run-1", agent_key: "case-triage",
            agent_version: 2, missing_knowledge: "x",
            gap_status: "dismissed", gap_decided_by: "steward-1",
            gap_decided_at: "2026-08-03T00:00:00Z",
          }], page: { next_cursor: null, has_more: false } },
        };
      }
      return { status: 404, body: { error: { code: "NOT_FOUND", message: req.path } } };
    });
    const ctx = await makeTestContext(fetchImpl);
    const res = await server.executeOperation(
      { query: `{ knowledgeGaps(includeDecided: true) { transcriptId gapStatus gapDecidedBy } }` },
      { contextValue: ctx },
    );
    const body = res.body.kind === "single" ? res.body.singleResult : null;
    expect(body?.errors).toBeUndefined();
    expect((body?.data?.knowledgeGaps as any[])[0]).toMatchObject({
      transcriptId: "tr-1", gapStatus: "dismissed", gapDecidedBy: "steward-1",
    });
    const call = requests.find((r) => r.path === "/api/v1/knowledge-gaps");
    expect(call?.search.get("include_decided")).toBe("true");
  });

  it("decideKnowledgeGap posts the triage and surfaces a no-such-gap 404 honestly", async () => {
    const server = makeApolloServer(cfg);
    const { fetchImpl, requests } = mockFetch((req: CapturedRequest) => {
      if (req.path === "/api/v1/knowledge-gaps/tr-1/decision" && req.method === "POST") {
        return { status: 200, body: { data: {
          transcript_id: "tr-1", status: "handled",
          decided_by: "steward-1", decided_at: "2026-08-03T00:00:00Z",
        } } };
      }
      return { status: 404, body: { error: { code: "NOT_FOUND", message: "no knowledge gap for that transcript" } } };
    });
    const ctx = await makeTestContext(fetchImpl);

    const ok = await server.executeOperation(
      { query: `mutation { decideKnowledgeGap(transcriptId: "tr-1", status: "handled") {
        transcriptId status decidedBy } }` },
      { contextValue: ctx },
    );
    const okBody = ok.body.kind === "single" ? ok.body.singleResult : null;
    expect(okBody?.errors).toBeUndefined();
    expect(okBody?.data?.decideKnowledgeGap).toMatchObject({
      transcriptId: "tr-1", status: "handled", decidedBy: "steward-1",
    });
    const post = requests.find((r) => r.method === "POST");
    expect(post?.body).toEqual({ status: "handled" });

    const miss = await server.executeOperation(
      { query: `mutation { decideKnowledgeGap(transcriptId: "tr-nope", status: "handled") { status } }` },
      { contextValue: ctx },
    );
    const missBody = miss.body.kind === "single" ? miss.body.singleResult : null;
    expect(missBody?.errors?.[0]?.message).toContain("no knowledge gap");
  });
});
