/**
 * Memory governance console (BRD 15): governed writes/edits, retrieval tester,
 * RAG corpus admin, and the tenant memory policy (memory-service). Response
 * shapes mirror the real downstream route bodies — see
 * services/memory-service/app/api/routes/{memories,corpora,admin}.py.
 */
import { describe, it, expect } from "vitest";
import { makeApolloServer } from "../../src/server.js";
import { makeTestContext, testConfig } from "../helpers/context.js";
import { mockFetch, type CapturedRequest } from "../helpers/mockFetch.js";

const cfg = testConfig();

const FULL_RECORD = {
  memory_id: "m-1", scope: "workspace", scope_ref: "ws-1", content: "edited content",
  confidence: 0.8, status: "active", tags: ["claims"], retrieval_count: 3, classifier_score: 0.1,
  ttl_expires_at: null, merged_from: [], revalidate_at: null,
};

function memory() {
  return mockFetch((req: CapturedRequest) => {
    if (req.path === "/api/v1/memories" && req.method === "POST") {
      expect(req.body).toMatchObject({
        scope: "user", scope_ref: "u-1", content: "prefers dark mode",
        provenance: { source_type: "admin", user_id: "u-1" }, tags: ["prefs"],
      });
      return { status: 200, body: { data: { memory_id: "m-9", status: "active", merged: false, session: false } } };
    }
    if (req.path === "/api/v1/memories/batch" && req.method === "POST") {
      expect((req.body as any).items).toHaveLength(2);
      return {
        status: 200,
        body: { data: [
          { memory_id: "m-10", status: "active", merged: false },
          { status: "rejected", code: "PII_REJECTED", message: "pii" },
        ] },
      };
    }
    if (req.path === "/api/v1/memories/m-1" && req.method === "PATCH") {
      expect(req.body).toMatchObject({ content: "edited content" });
      return { status: 200, body: { data: FULL_RECORD } };
    }
    if (req.path === "/api/v1/memories/m-1" && req.method === "DELETE") {
      return { status: 204, body: undefined };
    }
    if (req.path === "/api/v1/memories/m-1/unquarantine" && req.method === "POST") {
      expect(req.body).toMatchObject({ reason: "false positive" });
      return { status: 200, body: { data: { ...FULL_RECORD, status: "active" } } };
    }
    if (req.path === "/api/v1/retrieve" && req.method === "POST") {
      expect(req.body).toMatchObject({
        query_text: "claim total", scopes: ["workspace"], scope_refs: { workspace: "ws-1" },
        corpora: ["docs"], top_k: 5, include_debug: false,
      });
      return {
        status: 200,
        body: {
          data: [
            { kind: "memory", content: "the claim total is $4,200", score: 0.912345,
              content_disposition: "untrusted", scope: "workspace", memory_id: "m-1",
              provenance: [{ source_type: "agent_run" }] },
            { kind: "chunk", content: "claims are settled monthly", score: 0.71,
              content_disposition: "untrusted", corpus: "docs", chunk_id: "c-1",
              source_urn: "urn:doc:handbook", snapshot_ver: "2026-08-01" },
          ],
          degraded: false,
        },
      };
    }
    if (req.path === "/api/v1/corpora" && req.method === "POST") {
      expect(req.body).toMatchObject({ corpus_key: "docs", embedding_model_ver: "v2" });
      return {
        status: 201,
        body: { data: { corpus_key: "docs", source: { kind: "api_push" }, chunking: { strategy: "fixed" },
          active_embedding_ver: "v2", refresh: { mode: "streaming" }, anonymization_profile: null, status: "active" } },
      };
    }
    if (req.path === "/api/v1/corpora/docs" && req.method === "PATCH") {
      expect(req.body).toMatchObject({ status: "paused" });
      return {
        status: 200,
        body: { data: { corpus_key: "docs", source: { kind: "api_push" }, chunking: { strategy: "fixed" },
          active_embedding_ver: "v2", refresh: { mode: "streaming" }, anonymization_profile: null, status: "paused" } },
      };
    }
    if (req.path === "/api/v1/corpora/docs/status" && req.method === "GET") {
      return { status: 200, body: { data: { corpus_key: "docs", status: "active", active_embedding_ver: "v2", chunk_count: 128 } } };
    }
    if (req.path === "/api/v1/corpora/docs/rebuild" && req.method === "POST") {
      expect(req.body).toMatchObject({ embedding_model_ver: "v3" });
      return {
        status: 202,
        body: { data: { corpus_key: "docs", active_embedding_ver: "v3", chunks_reembedded: 128, old_chunks_dropped: 128 } },
      };
    }
    if (req.path === "/api/v1/corpora/docs/documents" && req.method === "POST") {
      expect(req.body).toMatchObject({ source_urn: "urn:doc:handbook", content: "claims are settled monthly" });
      return { status: 201, body: { data: { source_urn: "urn:doc:handbook", chunks: 3 } } };
    }
    if (req.path === "/api/v1/policies/self" && req.method === "GET") {
      return {
        status: 200,
        body: { data: { ttl_overrides: { user: "P30D" }, pii_classes: ["email"],
          injection_profile: "standard", corpus_flags: { docs: true } } },
      };
    }
    if (req.path === "/api/v1/policies/self" && req.method === "PUT") {
      expect(req.body).toMatchObject({
        ttl_overrides: { user: "P7D" }, pii_classes: ["email", "phone"],
        injection_profile: "strict", corpus_flags: { docs: false },
      });
      return {
        status: 200,
        body: { data: { ttl_overrides: { user: "P7D" }, pii_classes: ["email", "phone"],
          injection_profile: "strict", corpus_flags: { docs: false } } },
      };
    }
    return { status: 404, body: { error: { code: "NOT_FOUND", message: "x", trace_id: "t" } } };
  });
}

const ADMIN_CLAIMS = { sub: "u-1", tenant_id: "t-42", typ: "user", scopes: ["*"], workspace_id: "ws-1" };

async function run(query: string, variables: Record<string, unknown> = {}) {
  const server = makeApolloServer(cfg);
  const { fetchImpl, requests } = memory();
  const ctx = await makeTestContext(fetchImpl, ADMIN_CLAIMS);
  const res = await server.executeOperation({ query, variables }, { contextValue: ctx });
  const body = res.body.kind === "single" ? res.body.singleResult : null;
  return { body, requests };
}

describe("memory governance: writes", () => {
  it("writeMemory POSTs the snake_case body and maps the WriteResult", async () => {
    const { body } = await run(
      `mutation {
        writeMemory(input: {
          scope: "user", scopeRef: "u-1", content: "prefers dark mode",
          provenance: { sourceType: "admin", userId: "u-1" }, tags: ["prefs"]
        }) { memoryId status merged session }
      }`,
    );
    expect(body?.errors).toBeUndefined();
    expect((body?.data as any).writeMemory).toMatchObject({
      memoryId: "m-9", status: "active", merged: false, session: false,
    });
  });

  it("writeMemoryBatch returns per-item results including rejections", async () => {
    const { body } = await run(
      `mutation {
        writeMemoryBatch(items: [
          { scope: "user", scopeRef: "u-1", content: "a", provenance: { sourceType: "admin" } },
          { scope: "user", scopeRef: "u-1", content: "b", provenance: { sourceType: "admin" } }
        ]) { memoryId status code message }
      }`,
    );
    expect(body?.errors).toBeUndefined();
    const rows = (body?.data as any).writeMemoryBatch;
    expect(rows[0]).toMatchObject({ memoryId: "m-10", status: "active" });
    expect(rows[1]).toMatchObject({ status: "rejected", code: "PII_REJECTED", message: "pii" });
  });

  it("updateMemory PATCHes content and returns the full record", async () => {
    const { body } = await run(
      `mutation { updateMemory(id: "m-1", content: "edited content") { id content status mergedFrom } }`,
    );
    expect(body?.errors).toBeUndefined();
    expect((body?.data as any).updateMemory).toMatchObject({ id: "m-1", content: "edited content", status: "active" });
  });

  it("deleteMemory DELETEs (204) and resolves true", async () => {
    const { body, requests } = await run(`mutation { deleteMemory(id: "m-1") }`);
    expect(body?.errors).toBeUndefined();
    expect((body?.data as any).deleteMemory).toBe(true);
    expect(requests.some((r) => r.method === "DELETE" && r.path === "/api/v1/memories/m-1")).toBe(true);
  });

  it("unquarantineMemory POSTs the required reason", async () => {
    const { body, requests } = await run(
      `mutation { unquarantineMemory(id: "m-1", reason: "false positive") { id status } }`,
    );
    expect(body?.errors).toBeUndefined();
    expect((body?.data as any).unquarantineMemory).toMatchObject({ id: "m-1", status: "active" });
    expect(requests.some((r) => r.path === "/api/v1/memories/m-1/unquarantine")).toBe(true);
  });
});

describe("memory governance: retrieval tester", () => {
  it("memoryRetrievalTest POSTs /retrieve and maps memory + chunk hits with the degraded flag", async () => {
    const { body } = await run(
      `{
        memoryRetrievalTest(input: {
          queryText: "claim total", scopes: ["workspace"],
          scopeRefs: { workspace: "ws-1" }, corpora: ["docs"], topK: 5
        }) {
          degraded
          hits { kind content score contentDisposition scope memoryId corpus chunkId sourceUrn snapshotVer }
        }
      }`,
    );
    expect(body?.errors).toBeUndefined();
    const r = (body?.data as any).memoryRetrievalTest;
    expect(r.degraded).toBe(false);
    expect(r.hits[0]).toMatchObject({
      kind: "memory", score: 0.912345, contentDisposition: "untrusted",
      scope: "workspace", memoryId: "m-1", corpus: null,
    });
    expect(r.hits[1]).toMatchObject({
      kind: "chunk", corpus: "docs", chunkId: "c-1", sourceUrn: "urn:doc:handbook",
      snapshotVer: "2026-08-01", scope: null,
    });
  });
});

describe("memory governance: corpora", () => {
  it("registerCorpus POSTs /corpora and maps the corpus view", async () => {
    const { body } = await run(
      `mutation {
        registerCorpus(input: { corpusKey: "docs", embeddingModelVer: "v2" }) {
          corpusKey activeEmbeddingVer status source
        }
      }`,
    );
    expect(body?.errors).toBeUndefined();
    expect((body?.data as any).registerCorpus).toMatchObject({
      corpusKey: "docs", activeEmbeddingVer: "v2", status: "active", source: { kind: "api_push" },
    });
  });

  it("updateCorpus PATCHes status", async () => {
    const { body } = await run(
      `mutation { updateCorpus(corpusKey: "docs", patch: { status: "paused" }) { corpusKey status } }`,
    );
    expect(body?.errors).toBeUndefined();
    expect((body?.data as any).updateCorpus).toMatchObject({ corpusKey: "docs", status: "paused" });
  });

  it("corpusStatus reads chunk count + active embedding version", async () => {
    const { body } = await run(
      `{ corpusStatus(corpusKey: "docs") { corpusKey status activeEmbeddingVer chunkCount } }`,
    );
    expect(body?.errors).toBeUndefined();
    expect((body?.data as any).corpusStatus).toMatchObject({
      corpusKey: "docs", status: "active", activeEmbeddingVer: "v2", chunkCount: 128,
    });
  });

  it("corpusStatus is null on downstream 404", async () => {
    const { body } = await run(`{ corpusStatus(corpusKey: "missing") { corpusKey } }`);
    expect(body?.errors).toBeUndefined();
    expect((body?.data as any).corpusStatus).toBeNull();
  });

  it("rebuildCorpus POSTs the new embedding version and maps the report", async () => {
    const { body } = await run(
      `mutation {
        rebuildCorpus(corpusKey: "docs", embeddingModelVer: "v3") {
          corpusKey activeEmbeddingVer chunksReembedded oldChunksDropped
        }
      }`,
    );
    expect(body?.errors).toBeUndefined();
    expect((body?.data as any).rebuildCorpus).toMatchObject({
      corpusKey: "docs", activeEmbeddingVer: "v3", chunksReembedded: 128, oldChunksDropped: 128,
    });
  });

  it("pushCorpusDocument POSTs the doc and returns the chunk count", async () => {
    const { body } = await run(
      `mutation {
        pushCorpusDocument(sourceUrn: "urn:doc:handbook", content: "claims are settled monthly") {
          sourceUrn chunks
        }
      }`,
    );
    expect(body?.errors).toBeUndefined();
    expect((body?.data as any).pushCorpusDocument).toMatchObject({ sourceUrn: "urn:doc:handbook", chunks: 3 });
  });
});

describe("memory governance: tenant policy", () => {
  it("memoryPolicy reads GET /policies/self", async () => {
    const { body } = await run(
      `{ memoryPolicy { ttlOverrides piiClasses injectionProfile corpusFlags } }`,
    );
    expect(body?.errors).toBeUndefined();
    expect((body?.data as any).memoryPolicy).toMatchObject({
      ttlOverrides: { user: "P30D" }, piiClasses: ["email"],
      injectionProfile: "standard", corpusFlags: { docs: true },
    });
  });

  it("setMemoryPolicy PUTs the full document and echoes the stored policy", async () => {
    const { body } = await run(
      `mutation {
        setMemoryPolicy(input: {
          ttlOverrides: { user: "P7D" }, piiClasses: ["email", "phone"],
          injectionProfile: "strict", corpusFlags: { docs: false }
        }) { ttlOverrides piiClasses injectionProfile corpusFlags }
      }`,
    );
    expect(body?.errors).toBeUndefined();
    expect((body?.data as any).setMemoryPolicy).toMatchObject({
      ttlOverrides: { user: "P7D" }, piiClasses: ["email", "phone"],
      injectionProfile: "strict", corpusFlags: { docs: false },
    });
  });
});
