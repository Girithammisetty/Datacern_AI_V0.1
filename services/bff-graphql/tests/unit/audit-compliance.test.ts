/**
 * Audit compliance packs + chain-integrity verify. Response shapes mirror the
 * real downstream route bodies (NO envelope wrapper, unlike most other
 * audit-service/usage-service routes) — see
 * services/audit-service/internal/api/handlers.go.
 */
import { describe, it, expect } from "vitest";
import { makeApolloServer } from "../../src/server.js";
import { makeTestContext, testConfig } from "../helpers/context.js";
import { mockFetch, type CapturedRequest } from "../helpers/mockFetch.js";

const cfg = testConfig();

function audit() {
  return mockFetch((req: CapturedRequest) => {
    if (req.path === "/api/v1/audit/verify" && req.method === "POST") {
      expect(req.body).toMatchObject({ date: "2026-07-01" });
      return {
        status: 200,
        body: { valid: true, events_checked: 128, chain_head: "abc123", manifest_match: true, sealed: true },
      };
    }
    if (req.path === "/api/v1/compliance/soc2-pack" && req.method === "POST") {
      expect(req.body).toMatchObject({ from: "2026-06-01T00:00:00Z", to: "2026-07-01T00:00:00Z" });
      return { status: 202, body: { operation_id: "op-1", status: "running" } };
    }
    if (req.path === "/api/v1/compliance/ai-decision-log" && req.method === "POST") {
      return { status: 202, body: { operation_id: "op-2", status: "running" } };
    }
    if (req.path === "/api/v1/operations/op-1" && req.method === "GET") {
      return { status: 200, body: { operation_id: "op-1", status: "succeeded", result_url: "https://example/pack.zip" } };
    }
    // agent-activity: {data,page} like search, but never paginated (capped 200).
    if (req.path === "/api/v1/audit/agent-activity" && req.method === "GET") {
      return {
        status: 200,
        body: {
          data: [
            { event_id: "ev-7", event_type: "proposal.approved", tenant_id: "t-42",
              actor: { type: "user", id: "u-9" }, via_agent: { agent_id: "triage-bot", version: "3" },
              resource_urn: "wr:t-42:agent:proposal/p-1", action: "agent.proposal.approve",
              occurred_at: "2026-07-10T10:00:00Z", ingested_at: "2026-07-10T10:00:01Z",
              trace_id: "tr-7", payload_digest: "sha256:abc", body_withheld: true,
              chain_seq: 41, chain_hash: "h41" },
          ],
          page: { has_more: false, next_cursor: null },
        },
      };
    }
    // single event: {event, chain_date, chain_seq, sealed} — NO envelope.
    if (req.path === "/api/v1/audit/events/ev-7" && req.method === "GET") {
      return {
        status: 200,
        body: {
          event: { event_id: "ev-7", event_type: "proposal.approved", tenant_id: "t-42",
            actor: { type: "user", id: "u-9" }, via_agent: { agent_id: "triage-bot", version: "3" },
            resource_urn: "wr:t-42:agent:proposal/p-1", action: "agent.proposal.approve",
            occurred_at: "2026-07-10T10:00:00Z", ingested_at: "2026-07-10T10:00:01Z",
            trace_id: "tr-7", payload_digest: "sha256:abc", body_withheld: false,
            payload: { outcome: "approved" }, chain_seq: 41, chain_hash: "h41" },
          chain_date: "2026-07-10", chain_seq: 41, sealed: true,
        },
      };
    }
    // sealed WORM batches: {data,page}, page always has_more:false.
    if (req.path === "/api/v1/exports" && req.method === "GET") {
      return {
        status: 200,
        body: {
          data: [
            { date: "2026-07-10", revision: 1, uri: "s3://worm/t-42/2026-07-10/manifest.json",
              manifest_sha256: "deadbeef", chain_head: "h99", row_count: 1234,
              sealed_at: "2026-07-11T00:05:00Z", download_url: "https://example/manifest?sig=x" },
          ],
          page: { has_more: false, next_cursor: null },
        },
      };
    }
    return { status: 404, body: { error: { code: "NOT_FOUND", message: "x", trace_id: "t" } } };
  });
}

const ADMIN_CLAIMS = { sub: "u-1", tenant_id: "t-42", typ: "user", scopes: ["*"], workspace_id: "ws-1" };

async function run(query: string, variables: Record<string, unknown> = {}) {
  const server = makeApolloServer(cfg);
  const { fetchImpl, requests } = audit();
  const ctx = await makeTestContext(fetchImpl, ADMIN_CLAIMS);
  const res = await server.executeOperation({ query, variables }, { contextValue: ctx });
  const body = res.body.kind === "single" ? res.body.singleResult : null;
  return { body, requests };
}

describe("audit: chain-integrity verify", () => {
  it("verifyChainIntegrity posts the date and maps the real result", async () => {
    const { body } = await run(
      `mutation { verifyChainIntegrity(date: "2026-07-01") { valid eventsChecked chainHead manifestMatch sealed firstMismatchSeq } }`,
    );
    expect(body?.errors).toBeUndefined();
    expect((body?.data as any).verifyChainIntegrity).toMatchObject({
      valid: true, eventsChecked: 128, chainHead: "abc123", manifestMatch: true, sealed: true, firstMismatchSeq: null,
    });
  });
});

describe("audit: dual-attribution agent activity", () => {
  it("passes agent_id/obo_user_id and maps the flattened rows", async () => {
    const { body, requests } = await run(
      `{ auditAgentActivity(agentId: "triage-bot", oboUserId: "u-9", includeAutonomous: true) {
          nodes { eventId viaAgentId viaAgentVersion actorType actorId action }
          pageInfo { hasMore nextCursor }
        } }`,
    );
    expect(body?.errors).toBeUndefined();
    const conn: any = (body?.data as any).auditAgentActivity;
    expect(conn.nodes[0]).toMatchObject({
      eventId: "ev-7", viaAgentId: "triage-bot", viaAgentVersion: "3",
      actorType: "user", actorId: "u-9", action: "agent.proposal.approve",
    });
    expect(conn.pageInfo).toEqual({ hasMore: false, nextCursor: null });
    const q = requests[0]?.search;
    expect(requests[0]?.path).toBe("/api/v1/audit/agent-activity");
    expect(q?.get("agent_id")).toBe("triage-bot");
    expect(q?.get("obo_user_id")).toBe("u-9");
    expect(q?.get("include_autonomous")).toBe("true");
  });
});

describe("audit: single event by id", () => {
  it("returns the event with its chain position + sealed flag", async () => {
    const { body } = await run(
      `{ auditEvent(id: "ev-7") { event { eventId payload chainHash } chainDate chainSeq sealed } }`,
    );
    expect(body?.errors).toBeUndefined();
    expect((body?.data as any).auditEvent).toMatchObject({
      event: { eventId: "ev-7", payload: { outcome: "approved" }, chainHash: "h41" },
      chainDate: "2026-07-10", chainSeq: 41, sealed: true,
    });
  });

  it("resolves null on 404 (cross-tenant and nonexistent are indistinguishable)", async () => {
    const { body } = await run(`{ auditEvent(id: "ev-missing") { chainDate } }`);
    expect(body?.errors).toBeUndefined();
    expect((body?.data as any).auditEvent).toBeNull();
  });
});

describe("audit: sealed WORM export batches", () => {
  it("lists batches with the presigned manifest link", async () => {
    const { body, requests } = await run(
      `{ auditExports(date: "2026-07-10") { date revision uri manifestSha256 chainHead rowCount sealedAt downloadUrl } }`,
    );
    expect(body?.errors).toBeUndefined();
    expect((body?.data as any).auditExports[0]).toMatchObject({
      date: "2026-07-10", revision: 1, uri: "s3://worm/t-42/2026-07-10/manifest.json",
      manifestSha256: "deadbeef", chainHead: "h99", rowCount: 1234,
      sealedAt: "2026-07-11T00:05:00Z", downloadUrl: "https://example/manifest?sig=x",
    });
    expect(requests[0]?.search?.get("date")).toBe("2026-07-10");
  });
});

describe("audit: raw export descriptor", () => {
  it("builds the same-origin proxy path without calling downstream", async () => {
    const { body, requests } = await run(
      `{ auditExportFile(from: "2026-07-01T00:00:00Z", to: "2026-07-11T00:00:00Z", eventType: "agent_run", format: NDJSON) {
          downloadPath format from to
        } }`,
    );
    expect(body?.errors).toBeUndefined();
    const f: any = (body?.data as any).auditExportFile;
    expect(f.format).toBe("NDJSON");
    expect(f.downloadPath).toMatch(/^\/api\/audit-export\?/);
    const qs = new URLSearchParams(f.downloadPath.split("?")[1]);
    expect(qs.get("from")).toBe("2026-07-01T00:00:00Z");
    expect(qs.get("to")).toBe("2026-07-11T00:00:00Z");
    expect(qs.get("event_type")).toBe("agent_run");
    expect(qs.get("format")).toBe("ndjson");
    // Descriptor only — the file itself must never traverse the BFF.
    expect(requests).toHaveLength(0);
  });

  it("rejects a window over the downstream's 92-day max", async () => {
    const { body } = await run(
      `{ auditExportFile(from: "2026-01-01T00:00:00Z", to: "2026-07-11T00:00:00Z") { downloadPath } }`,
    );
    expect(body?.errors?.[0]?.message).toMatch(/92 days/);
  });
});

describe("audit: compliance packs", () => {
  it("generateSoc2Pack POSTs the real RFC3339 range and returns the async job", async () => {
    const { body } = await run(
      `mutation($f:DateTime!,$t:DateTime!){ generateSoc2Pack(from: $f, to: $t) { operationId status resultUrl } }`,
      { f: "2026-06-01T00:00:00Z", t: "2026-07-01T00:00:00Z" },
    );
    expect(body?.errors).toBeUndefined();
    expect((body?.data as any).generateSoc2Pack).toMatchObject({ operationId: "op-1", status: "running", resultUrl: null });
  });

  it("complianceOperation polls the real job and surfaces the download link once succeeded", async () => {
    const { body } = await run(`{ complianceOperation(id: "op-1") { operationId status resultUrl } }`);
    expect(body?.errors).toBeUndefined();
    expect((body?.data as any).complianceOperation).toMatchObject({
      operationId: "op-1", status: "succeeded", resultUrl: "https://example/pack.zip",
    });
  });
});
