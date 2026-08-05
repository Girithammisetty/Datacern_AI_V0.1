/**
 * BRD 74 AC-10 — the `search.query` MCP backend facade.
 *
 * The acceptance criterion is an EQUALITY: the MCP tool must return the same
 * results as the GraphQL query for the same principal. So the central test here
 * drives both surfaces against the SAME downstream double with the SAME token
 * and deep-compares them; if the facade ever diverges (a leg dropped, a
 * different limit, a swallowed denial) it fails.
 *
 * The rest are the isolation tests: the facade must add no authority. It is off
 * unless its peer allowlist is configured, it refuses a peer that is not on it,
 * it refuses a call with no forwarded caller token, and it refuses to answer for
 * a tenant or a human the forwarded token does not represent.
 */
import { describe, it, expect } from "vitest";
import { makeApolloServer } from "../../src/server.js";
import {
  handleInternalFacade,
  isInternalFacadePath,
  parseSearchArgs,
  SEARCH_TOOL_ID,
} from "../../src/internal/mcpFacade.js";
import { fakeJwt, makeTestContext, testConfig } from "../helpers/context.js";
import { mockFetch, type CapturedRequest, type MockResponse } from "../helpers/mockFetch.js";

const cfg = testConfig();
const PEER = "spiffe://datacern/ns/prod/sa/mcp-gateway";
const facadeEnv = { BFF_FACADE_ALLOWED_SPIFFE: PEER } as unknown as NodeJS.ProcessEnv;

const OBO_USER = "u-1";
const TENANT = "t-42";

/** The token tool-plane forwards: an agent_obo token narrowed to search.query
 * plus the downstream actions the tool DECLARED (tool-plane refuses anything
 * broader before it ever reaches this facade). */
function delegatedToken(overrides: Record<string, unknown> = {}): string {
  return fakeJwt({
    sub: "agent:search@v1",
    tenant_id: TENANT,
    typ: "agent_obo",
    agent_id: "search",
    agent_version: "1",
    obo_sub: OBO_USER,
    scopes: [
      "search.query",
      "dataset.dataset.list",
      "chart.dashboard.list",
      "chart.chart.list",
      "pipeline.template.list",
      "experiment.experiment.list",
      "experiment.model.list",
      "case.case.list",
      "ai.decision_model.list",
    ],
    ...overrides,
  });
}

interface DownstreamOpts {
  denied?: string[];
}

/** One double for all eight owning services, honouring each service's real
 * query parameter — the same contract search.test.ts asserts. */
function downstream(opts: DownstreamOpts = {}) {
  const denied = new Set(opts.denied ?? []);
  const page = (data: unknown[]): MockResponse => ({
    status: 200,
    body: { data, page: { has_more: false } },
  });
  const forbidden: MockResponse = {
    status: 403,
    body: { error: { code: "PERMISSION_DENIED", message: "nope", trace_id: "t" } },
  };
  const gate = (type: string) => (denied.has(type) ? forbidden : undefined);
  const hasTerm = (q: string | null, hay: string) =>
    !!q && hay.toLowerCase().includes(q.toLowerCase());

  return mockFetch((req: CapturedRequest) => {
    const q = req.search.get("q");
    if (req.path === "/api/v1/datasets") {
      return gate("DATASET") ?? page(hasTerm(q, "denial rate dataset")
        ? [{ id: "ds-1", name: "denial rate dataset", description: "claims", workspace_id: "ws-9" }] : []);
    }
    if (req.path === "/api/v1/dashboards") {
      return gate("DASHBOARD") ?? page(hasTerm(q, "Denial rate review")
        ? [{ id: "dash-51", name: "Denial rate review", module: "insights", workspace_id: "ws-9" }] : []);
    }
    if (req.path === "/api/v1/charts") {
      return gate("CHART") ?? page(hasTerm(q, "denial rate by payer")
        ? [{ id: "c-1", name: "Denial rate by payer", dashboard_id: "dash-2", dashboard_name: "Finance" }] : []);
    }
    if (req.path === "/api/v1/pipelines") {
      return gate("PIPELINE") ?? page(hasTerm(req.search.get("filter[name]"), "denial ingest")
        ? [{ id: "pl-1", name: "denial ingest", pipeline_type: "data_prep", workspace_id: "ws-9" }] : []);
    }
    if (req.path === "/api/v1/experiments") {
      return gate("EXPERIMENT") ?? page(hasTerm(q, "denial classifier")
        ? [{ id: "exp-1", name: "denial classifier", description: "xgb" }] : []);
    }
    if (req.path === "/api/v1/models") {
      return gate("MODEL") ?? page(hasTerm(q, "denial_rate_v1")
        ? [{ id: "m-1", name: "denial_rate_v1", model_type: "classification" }] : []);
    }
    if (req.path === "/api/v1/cases") {
      return gate("CASE") ?? page(hasTerm(q, "denial dispute")
        ? [{ id: "case-1", title: "denial dispute", status: "in_progress", workspace_id: "ws-9" }] : []);
    }
    if (req.path === "/api/v1/decision-models") {
      return gate("DECISION_MODEL") ?? page(hasTerm(q, "denial table")
        ? [{ id: "dm-1", name: "denial table", version: 2, status: "published", workspace_id: "ws-9", rules: [] }] : []);
    }
    return { status: 404, body: { error: { code: "NOT_FOUND", message: "x", trace_id: "t" } } };
  });
}

function fakeReq(method: string, headers: Record<string, string>) {
  return { method, headers } as any;
}

function fakeRes() {
  return {
    statusCode: 0,
    body: "",
    writeHead(status: number) {
      this.statusCode = status;
    },
    end(b?: string) {
      this.body = b ?? "";
    },
    json(): any {
      return this.body ? JSON.parse(this.body) : null;
    },
  };
}

interface CallOpts {
  headers?: Record<string, string>;
  body?: unknown;
  env?: NodeJS.ProcessEnv;
  downstreamOpts?: DownstreamOpts;
}

async function callFacade(opts: CallOpts = {}) {
  const { fetchImpl, requests } = downstream(opts.downstreamOpts);
  const res = fakeRes();
  const headers: Record<string, string> = {
    "x-spiffe-id": PEER,
    authorization: `Bearer ${delegatedToken()}`,
    ...(opts.headers ?? {}),
  };
  for (const k of Object.keys(headers)) if (headers[k] === "") delete headers[k];
  const body = JSON.stringify(
    opts.body ?? {
      tool_id: SEARCH_TOOL_ID,
      version: "1.0.0",
      args: { q: "denial", workspace_id: "ws-9" },
      tenant: TENANT,
      obo_sub: OBO_USER,
      agent_id: "search",
    },
  );
  await handleInternalFacade(fakeReq("POST", headers), res as any, body, {
    cfg,
    jwks: undefined,
    fetchImpl,
    env: opts.env ?? facadeEnv,
  });
  return { res, requests };
}

const SEARCH_Q = `
  query S($q: String!, $types: [SearchEntityType!], $ws: ID, $first: Int) {
    search(q: $q, types: $types, workspaceId: $ws, first: $first) {
      q
      types { type denied error hits { key id type title subtitle urn workspaceId parentId } }
      hits { key id type title subtitle urn workspaceId parentId }
    }
  }
`;

/** The GraphQL surface, run with the SAME token against the SAME double. */
async function runGraphQL(
  variables: Record<string, unknown>,
  downstreamOpts: DownstreamOpts = {},
) {
  const server = makeApolloServer(cfg);
  const { fetchImpl } = downstream(downstreamOpts);
  const ctx = await makeTestContext(fetchImpl, JSON.parse(
    Buffer.from(delegatedToken().split(".")[1]!, "base64url").toString("utf8"),
  ));
  const out = await server.executeOperation({ query: SEARCH_Q, variables }, { contextValue: ctx });
  const single = out.body.kind === "single" ? out.body.singleResult : null;
  expect(single?.errors, JSON.stringify(single?.errors)).toBeUndefined();
  return (single?.data as any).search;
}

describe("AC-10: the MCP tool returns the same results as the GraphQL query", () => {
  it("routes only its own path", () => {
    expect(isInternalFacadePath("/internal/v1/mcp/invoke")).toBe(true);
    expect(isInternalFacadePath("/graphql")).toBe(false);
    expect(isInternalFacadePath("/internal/v1/mcp")).toBe(false);
  });

  it("returns every entity kind, byte-identical to search() for the same principal", async () => {
    const { res } = await callFacade();
    expect(res.statusCode).toBe(200);
    const output = res.json().output;

    const viaGraphQL = await runGraphQL({ q: "denial", ws: "ws-9" });
    expect(output).toEqual(viaGraphQL);

    // And it really is the whole fan-out, not one entity kind (the partial this
    // AC explicitly refuses).
    expect(output.types.map((t: any) => t.type)).toEqual([
      "DATASET", "DASHBOARD", "CHART", "PIPELINE",
      "EXPERIMENT", "MODEL", "CASE", "DECISION_MODEL",
    ]);
    expect(output.hits).toHaveLength(8);
  });

  it("stays identical when a leg is denied — denial is reported, never hidden", async () => {
    const denied = { denied: ["CHART", "CASE"] };
    const { res } = await callFacade({ downstreamOpts: denied });
    const output = res.json().output;
    expect(output).toEqual(await runGraphQL({ q: "denial", ws: "ws-9" }, denied));

    for (const t of ["CHART", "CASE"]) {
      expect(output.types.find((x: any) => x.type === t)).toMatchObject({ denied: true, hits: [] });
    }
    expect(output.hits.some((h: any) => ["CHART", "CASE"].includes(h.type))).toBe(false);
  });

  it("honours types and first exactly as the resolver does", async () => {
    const { res, requests } = await callFacade({
      body: {
        tool_id: SEARCH_TOOL_ID,
        args: { q: "denial", workspace_id: "ws-9", types: ["DATASET", "CASE"], first: 3 },
        tenant: TENANT,
        obo_sub: OBO_USER,
      },
    });
    const output = res.json().output;
    expect(output).toEqual(
      await runGraphQL({ q: "denial", ws: "ws-9", types: ["DATASET", "CASE"], first: 3 }),
    );
    expect(requests.map((r) => r.path).sort()).toEqual(["/api/v1/cases", "/api/v1/datasets"]);
    expect(requests[0]!.search.get("limit")).toBe("3");
  });

  it("forwards the caller's own token to every leg — the BFF mints nothing", async () => {
    const { requests } = await callFacade();
    expect(requests.length).toBe(8);
    const expected = `Bearer ${delegatedToken()}`;
    for (const r of requests) expect(r.headers["authorization"]).toBe(expected);
  });

  it("an empty term calls nothing and reports every leg empty, not an error", async () => {
    const { res, requests } = await callFacade({
      body: { tool_id: SEARCH_TOOL_ID, args: { q: "   " }, tenant: TENANT, obo_sub: OBO_USER },
    });
    expect(res.statusCode).toBe(200);
    expect(requests).toHaveLength(0);
    expect(res.json().output.hits).toEqual([]);
  });
});

describe("AC-10 isolation: the facade adds no authority", () => {
  it("is DISABLED when its peer allowlist is unconfigured — fail closed", async () => {
    const { res, requests } = await callFacade({ env: {} as NodeJS.ProcessEnv });
    expect(res.statusCode).toBe(403);
    expect(res.json().output.error).toMatch(/BFF_FACADE_ALLOWED_SPIFFE/);
    expect(requests).toHaveLength(0);
  });

  it("refuses a peer identity that is not on the allowlist", async () => {
    for (const spiffe of ["", "spiffe://datacern/ns/prod/sa/attacker"]) {
      const { res, requests } = await callFacade({ headers: { "x-spiffe-id": spiffe || "none" } });
      expect(res.statusCode).toBe(403);
      expect(requests).toHaveLength(0);
    }
  });

  it("accepts the identity under the platform's other header name", async () => {
    const { res } = await callFacade({
      headers: { "x-spiffe-id": "none", "x-client-spiffe-id": PEER },
    });
    // x-spiffe-id wins when present, so this must still be refused...
    expect(res.statusCode).toBe(403);

    const ok = await callFacade({ headers: { "x-spiffe-id": "", "x-client-spiffe-id": PEER } });
    expect(ok.res.statusCode).toBe(200);
  });

  it("refuses a call with NO forwarded caller token — never an empty result", async () => {
    const { res, requests } = await callFacade({ headers: { authorization: "" } });
    expect(res.statusCode).toBe(403);
    expect(res.json().output.error).toMatch(/no caller token/);
    // Critically: this is an ERROR, not a 200 with zero hits.
    expect(res.json().output.hits).toBeUndefined();
    expect(requests).toHaveLength(0);
  });

  it("refuses an unreadable caller token", async () => {
    const { res, requests } = await callFacade({ headers: { authorization: "Bearer not-a-jwt" } });
    expect(res.statusCode).toBe(403);
    expect(requests).toHaveLength(0);
  });

  it("cross-tenant: a tenant that is not the token's answers 404, never 403", async () => {
    const { res, requests } = await callFacade({
      body: { tool_id: SEARCH_TOOL_ID, args: { q: "denial" }, tenant: "t-99", obo_sub: OBO_USER },
    });
    // 404, not 403 — a 403 confirms the other tenant exists (MASTER-FR-003).
    expect(res.statusCode).toBe(404);
    expect(requests).toHaveLength(0);
  });

  it("refuses to act for a human the forwarded token does not represent", async () => {
    const { res, requests } = await callFacade({
      body: { tool_id: SEARCH_TOOL_ID, args: { q: "denial" }, tenant: TENANT, obo_sub: "u-victim" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().output.error).toMatch(/obo_sub/);
    expect(requests).toHaveLength(0);
  });

  it("serves only search.query — any other tool_id is a 404", async () => {
    for (const toolID of ["case.assign", "search", "", undefined]) {
      const { res, requests } = await callFacade({
        body: { tool_id: toolID, args: { q: "denial" }, tenant: TENANT, obo_sub: OBO_USER },
      });
      expect(res.statusCode).toBe(404);
      expect(requests).toHaveLength(0);
    }
  });

  it("refuses anything but POST", async () => {
    const res = fakeRes();
    const { fetchImpl } = downstream();
    await handleInternalFacade(fakeReq("GET", { "x-spiffe-id": PEER }), res as any, "", {
      cfg, jwks: undefined, fetchImpl, env: facadeEnv,
    });
    expect(res.statusCode).toBe(405);
  });
});

describe("AC-10 argument validation: bad input is a 422, never a silent empty result", () => {
  it("rejects a malformed body", async () => {
    const res = fakeRes();
    const { fetchImpl } = downstream();
    await handleInternalFacade(
      fakeReq("POST", { "x-spiffe-id": PEER, authorization: `Bearer ${delegatedToken()}` }),
      res as any,
      "{not json",
      { cfg, jwks: undefined, fetchImpl, env: facadeEnv },
    );
    expect(res.statusCode).toBe(400);
  });

  it("rejects bad args with a reason", async () => {
    const bad: Array<[unknown, RegExp]> = [
      [{ q: 1 }, /args\.q/],
      [{ q: "x", types: "DATASET" }, /args\.types/],
      [{ q: "x", types: ["NOPE"] }, /unknown entity type/],
      [{ q: "x", workspace_id: 5 }, /workspace_id/],
      [{ q: "x", first: 1.5 }, /first/],
      ["not-an-object", /args must be an object/],
    ];
    for (const [args, re] of bad) {
      const { res, requests } = await callFacade({
        body: { tool_id: SEARCH_TOOL_ID, args, tenant: TENANT, obo_sub: OBO_USER },
      });
      expect(res.statusCode, JSON.stringify(args)).toBe(422);
      expect(res.json().output.error).toMatch(re);
      expect(requests).toHaveLength(0);
    }
  });

  it("parseSearchArgs accepts the documented shape", () => {
    const ok = parseSearchArgs({ q: "x", types: ["CASE"], workspace_id: "ws-1", first: 5 });
    expect(ok).toEqual({ args: { q: "x", types: ["CASE"], workspaceId: "ws-1", first: 5 } });
    expect(parseSearchArgs({ q: "x" })).toEqual({
      args: { q: "x", types: null, workspaceId: null, first: null },
    });
  });
});
