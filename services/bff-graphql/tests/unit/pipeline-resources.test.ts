import { describe, it, expect } from "vitest";
import { makeApolloServer } from "../../src/server.js";
import { makeTestContext, testConfig } from "../helpers/context.js";
import { mockFetch, type CapturedRequest } from "../helpers/mockFetch.js";

const cfg = testConfig();

/** BRD 71 (U1) — the builder's resource surface: the served policy and the
 *  effective per-node envelope the validation report now carries. */
function orch(overrides: { ceiling?: Record<string, number> } = {}) {
  return mockFetch((req: CapturedRequest) => {
    if (req.path === "/api/v1/resource-policy" && req.method === "GET") {
      return {
        status: 200,
        body: {
          data: {
            defaults: { cpus: 1, ram_gb: 2, timeout_minutes: 30 },
            floor: { cpus: 1, ram_gb: 2, timeout_minutes: 5 },
            ceiling: overrides.ceiling ?? { cpus: 7, ram_gb: 24, timeout_minutes: 480 },
          },
        },
      };
    }
    if (req.path === "/api/v1/pipelines/validate" && req.method === "POST") {
      return {
        status: 200,
        body: {
          data: {
            status: "valid",
            items: [],
            effective_resources: {
              r: { cpus: 4, ram_gb: 16, timeout_minutes: 120 },
              d1: { cpus: 4, ram_gb: 16, timeout_minutes: 120 },
            },
          },
        },
      };
    }
    return { status: 404, body: { error: { code: "NOT_FOUND", message: "x", trace_id: "t" } } };
  });
}

const POLICY = `query { pipelineResourcePolicy { defaults floor ceiling } }`;
const VALIDATE = `mutation($d: JSON!) {
  validatePipeline(definition: $d, pipelineType: "data_prep") {
    valid issues { code } effectiveResources
  }
}`;

describe("BRD 71 U1 — pipeline resource policy + effective resources", () => {
  it("serves defaults, floor and ceiling from the orchestrator", async () => {
    const server = makeApolloServer(cfg);
    const { fetchImpl } = orch();
    const ctx = await makeTestContext(fetchImpl);
    const res = await server.executeOperation({ query: POLICY }, { contextValue: ctx });
    const body = res.body as { kind: string; singleResult: { data?: any; errors?: any } };
    expect(body.singleResult.errors).toBeUndefined();
    const p = body.singleResult.data.pipelineResourcePolicy;
    expect(p.defaults).toEqual({ cpus: 1, ram_gb: 2, timeout_minutes: 30 });
    expect(p.floor).toEqual({ cpus: 1, ram_gb: 2, timeout_minutes: 5 });
    expect(p.ceiling).toEqual({ cpus: 7, ram_gb: 24, timeout_minutes: 480 });
  });

  it("passes the TENANT ceiling through unchanged — the BFF must not substitute a platform default", async () => {
    const server = makeApolloServer(cfg);
    const { fetchImpl } = orch({ ceiling: { cpus: 2, ram_gb: 8, timeout_minutes: 60 } });
    const ctx = await makeTestContext(fetchImpl);
    const res = await server.executeOperation({ query: POLICY }, { contextValue: ctx });
    const body = res.body as { kind: string; singleResult: { data?: any } };
    expect(body.singleResult.data.pipelineResourcePolicy.ceiling.ram_gb).toBe(8);
  });

  it("surfaces effectiveResources from the validation report, including inherited nodes", async () => {
    const server = makeApolloServer(cfg);
    const { fetchImpl } = orch();
    const ctx = await makeTestContext(fetchImpl);
    const res = await server.executeOperation(
      { query: VALIDATE, variables: { d: { nodes: [], edges: [] } } },
      { contextValue: ctx },
    );
    const body = res.body as { kind: string; singleResult: { data?: any; errors?: any } };
    expect(body.singleResult.errors).toBeUndefined();
    const v = body.singleResult.data.validatePipeline;
    expect(v.valid).toBe(true);
    // d1 declares nothing and inherits r's envelope — the case the builder needs to show.
    expect(v.effectiveResources.d1).toEqual({ cpus: 4, ram_gb: 16, timeout_minutes: 120 });
  });

  it("returns null effectiveResources when the report omits them, not an empty object", async () => {
    // An invalid definition short-circuits resolution upstream; "not computed" must
    // stay distinguishable from "every node at defaults".
    const server = makeApolloServer(cfg);
    const { fetchImpl } = mockFetch((req: CapturedRequest) =>
      req.path === "/api/v1/pipelines/validate"
        ? { status: 422, body: { data: { status: "draft", items: [{ code: "EMPTY_DAG", problem: "no nodes" }] } } }
        : { status: 404, body: { error: { code: "NOT_FOUND", message: "x", trace_id: "t" } } },
    );
    const ctx = await makeTestContext(fetchImpl);
    const res = await server.executeOperation(
      { query: VALIDATE, variables: { d: { nodes: [], edges: [] } } },
      { contextValue: ctx },
    );
    const body = res.body as { kind: string; singleResult: { data?: any } };
    const v = body.singleResult.data.validatePipeline;
    expect(v.valid).toBe(false);
    expect(v.effectiveResources).toBeNull();
  });
});
