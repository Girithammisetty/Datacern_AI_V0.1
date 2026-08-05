import { describe, it, expect } from "vitest";
import { makeApolloServer } from "../../src/server.js";
import { makeTestContext, testConfig } from "../helpers/context.js";
import { mockFetch, type CapturedRequest, type MockResponse } from "../helpers/mockFetch.js";

/**
 * BRD 74 D3 — the cross-service `search` fan-out, plus the `chartSearch` root
 * field that finally exposes D2's GET /charts.
 *
 * These tests drive the REAL resolvers through Apollo against a boundary
 * double that speaks each owning service's ACTUAL query contract, so a leg
 * that stopped forwarding `q` (and started returning an unfiltered page the
 * caller would have to filter itself) fails here.
 */

const cfg = testConfig();

/** Every entity kind, as the SDL orders them. */
const ALL_TYPES = [
  "DATASET", "DASHBOARD", "CHART", "PIPELINE",
  "EXPERIMENT", "MODEL", "CASE", "DECISION_MODEL",
];

const SEARCH_Q = `
  query S($q: String!, $types: [SearchEntityType!], $ws: ID, $first: Int) {
    search(q: $q, types: $types, workspaceId: $ws, first: $first) {
      q
      types { type denied error hits { key id title subtitle } }
      hits { key id type title subtitle urn workspaceId }
    }
  }
`;

interface DownstreamOpts {
  /** Types whose owning service answers 403 for this caller. */
  denied?: string[];
  /** Types whose owning service is down (transport-level 503). */
  broken?: string[];
  /** How many dashboards exist in the workspace (only the matching one has
   * "denial" in its name — see the 51st-dashboard test). */
  dashboardCount?: number;
}

const forbidden: MockResponse = {
  status: 403,
  body: { error: { code: "PERMISSION_DENIED", message: "nope", trace_id: "t" } },
};

/**
 * One double standing in for all eight owning services. Each branch honours
 * the query parameter the real service actually reads, and returns a hit only
 * when the term matches — so "the BFF forwarded q" and "the BFF did not filter
 * locally" are both observable.
 */
function downstream(opts: DownstreamOpts = {}) {
  const denied = new Set(opts.denied ?? []);
  const broken = new Set(opts.broken ?? []);
  const page = (data: unknown[]): MockResponse => ({ status: 200, body: { data, page: { has_more: false } } });
  const gate = (type: string): MockResponse | undefined => {
    if (denied.has(type)) return forbidden;
    if (broken.has(type)) return { status: 503, body: { error: { code: "SERVICE_UNAVAILABLE", message: "down", trace_id: "t" } } };
    return undefined;
  };
  const hasTerm = (q: string | null, hay: string) =>
    !!q && hay.toLowerCase().includes(q.toLowerCase());

  return mockFetch((req: CapturedRequest) => {
    const q = req.search.get("q");

    // dataset-service GET /datasets?q= (Postgres FTS).
    if (req.path === "/api/v1/datasets" && req.method === "GET") {
      return gate("DATASET") ?? page(hasTerm(q, "denial rate dataset")
        ? [{ id: "ds-1", name: "denial rate dataset", description: "claims", workspace_id: "ws-9" }] : []);
    }

    // chart-service GET /dashboards?q= (BRD 74 D3).
    if (req.path === "/api/v1/dashboards" && req.method === "GET") {
      const g = gate("DASHBOARD");
      if (g) return g;
      const total = opts.dashboardCount ?? 1;
      const all = [
        ...Array.from({ length: total - 1 }, (_, i) => ({
          id: `dash-${i}`, name: `Ops board ${i}`, module: "insights", workspace_id: "ws-9",
        })),
        { id: "dash-51", name: "Denial rate review", module: "insights", workspace_id: "ws-9" },
      ];
      // The real service filters server-side; anything else is the defect.
      const matched = q ? all.filter((d) => hasTerm(q, d.name)) : all;
      const limit = Number(req.search.get("limit") ?? "50");
      return page(matched.slice(0, limit));
    }

    // chart-service GET /charts (BRD 74 D2 chart search).
    if (req.path === "/api/v1/charts" && req.method === "GET") {
      return gate("CHART") ?? page(hasTerm(q, "denial rate by payer")
        ? [{ id: "c-1", name: "Denial rate by payer", chart_type: "vertical_bar_chart",
             description: "monthly", dashboard_id: "dash-2", dashboard_name: "Finance",
             dashboard_module: "insights", dashboard_tags: ["finance"] }] : []);
    }

    // pipeline-orchestrator GET /pipelines?filter[name]= (a real ILIKE).
    if (req.path === "/api/v1/pipelines" && req.method === "GET") {
      const name = req.search.get("filter[name]");
      return gate("PIPELINE") ?? page(hasTerm(name, "denial ingest")
        ? [{ id: "pl-1", name: "denial ingest", pipeline_type: "data_prep", workspace_id: "ws-9" }] : []);
    }

    // experiment-service GET /experiments?q= (BRD 74 D3).
    if (req.path === "/api/v1/experiments" && req.method === "GET") {
      return gate("EXPERIMENT") ?? page(hasTerm(q, "denial classifier")
        ? [{ id: "exp-1", name: "denial classifier", description: "xgb" }] : []);
    }

    // experiment-service GET /models?q= (BRD 74 D3).
    if (req.path === "/api/v1/models" && req.method === "GET") {
      return gate("MODEL") ?? page(hasTerm(q, "denial_rate_v1")
        ? [{ id: "m-1", name: "denial_rate_v1", model_type: "classification" }] : []);
    }

    // case-service GET /cases?q= (OpenSearch).
    if (req.path === "/api/v1/cases" && req.method === "GET") {
      return gate("CASE") ?? page(hasTerm(q, "denial dispute")
        ? [{ id: "case-1", title: "denial dispute", status: "in_progress", workspace_id: "ws-9" }] : []);
    }

    // agent-runtime GET /decision-models?q= (BRD 74 D3).
    if (req.path === "/api/v1/decision-models" && req.method === "GET") {
      return gate("DECISION_MODEL") ?? page(hasTerm(q, "denial table")
        ? [{ id: "dm-1", name: "denial table", version: 2, status: "published",
             workspace_id: "ws-9", rules: [] }] : []);
    }

    return { status: 404, body: { error: { code: "NOT_FOUND", message: "x", trace_id: "t" } } };
  });
}

async function runSearch(
  variables: Record<string, unknown>,
  opts: DownstreamOpts = {},
  claims?: Record<string, unknown>,
) {
  const server = makeApolloServer(cfg);
  const { fetchImpl, requests } = downstream(opts);
  const ctx = await makeTestContext(fetchImpl, claims);
  const res = await server.executeOperation({ query: SEARCH_Q, variables }, { contextValue: ctx });
  const body = res.body.kind === "single" ? res.body.singleResult : null;
  expect(body?.errors, JSON.stringify(body?.errors)).toBeUndefined();
  return { search: (body?.data as any).search, requests };
}

const byType = (search: any, type: string) =>
  search.types.find((t: any) => t.type === type);

describe("search: cross-service fan-out (BRD 74 D3)", () => {
  it("reaches every entity kind in ONE query, one downstream call per type", async () => {
    const { search, requests } = await runSearch({ q: "denial", ws: "ws-9" });

    expect(search.types.map((t: any) => t.type)).toEqual(ALL_TYPES);
    expect(search.hits.map((h: any) => h.type)).toEqual(ALL_TYPES); // one hit each
    // Exactly one downstream request per requested type — no N+1 hydration.
    expect(requests.length).toBe(ALL_TYPES.length);

    expect(search.hits.find((h: any) => h.type === "DATASET")).toMatchObject({
      key: "DATASET:ds-1", id: "ds-1", title: "denial rate dataset",
      urn: "wr:t-42:dataset:dataset/ds-1", workspaceId: "ws-9",
    });
    // A chart hit carries the dashboard that answers "where is it?".
    expect(search.hits.find((h: any) => h.type === "CHART")).toMatchObject({
      title: "Denial rate by payer", subtitle: "Finance",
    });
    expect(search.hits.find((h: any) => h.type === "DECISION_MODEL")).toMatchObject({
      title: "denial table", subtitle: "v2 · published",
    });
  });

  it("forwards q to every owning service using that service's own parameter", async () => {
    const { requests } = await runSearch({ q: "denial", ws: "ws-9" });
    const paramFor = (path: string) => {
      const r = requests.find((x) => x.path === path)!;
      return r.search.get("q") ?? r.search.get("filter[name]");
    };
    for (const path of [
      "/api/v1/datasets", "/api/v1/dashboards", "/api/v1/charts", "/api/v1/pipelines",
      "/api/v1/experiments", "/api/v1/models", "/api/v1/cases", "/api/v1/decision-models",
    ]) {
      expect(paramFor(path), `${path} did not receive the search term`).toBe("denial");
    }
  });

  it("`types` narrows the fan-out — an unrequested service is never called", async () => {
    const { search, requests } = await runSearch({ q: "denial", ws: "ws-9", types: ["DATASET", "CASE"] });
    expect(search.types.map((t: any) => t.type)).toEqual(["DATASET", "CASE"]);
    expect(requests.map((r) => r.path).sort()).toEqual(["/api/v1/cases", "/api/v1/datasets"]);
  });

  it("`first` caps EACH leg and is passed downstream as the limit", async () => {
    const { requests } = await runSearch({ q: "denial", ws: "ws-9", types: ["DATASET"], first: 3 });
    expect(requests[0]!.search.get("limit")).toBe("3");
  });

  it("an empty term calls nothing and reports every leg empty", async () => {
    const { search, requests } = await runSearch({ q: "   ", ws: "ws-9" });
    expect(requests).toEqual([]);
    expect(search.hits).toEqual([]);
    expect(search.types.every((t: any) => t.hits.length === 0 && !t.denied && t.error === null)).toBe(true);
  });

  it("forwards the caller's JWT verbatim on every leg (the BFF decides nothing)", async () => {
    const { requests } = await runSearch({ q: "denial", ws: "ws-9" });
    expect(requests.length).toBeGreaterThan(0);
    for (const r of requests) expect(r.headers["authorization"]).toMatch(/^Bearer /);
  });
});

describe("AC-8: search returns only entity types the caller's capabilities allow", () => {
  it("a 403 from an owning service drops that type — denied, no hits, query still succeeds", async () => {
    const { search } = await runSearch(
      { q: "denial", ws: "ws-9" },
      { denied: ["CHART", "CASE", "DECISION_MODEL"] },
    );

    for (const t of ["CHART", "CASE", "DECISION_MODEL"]) {
      expect(byType(search, t)).toMatchObject({ denied: true, error: null, hits: [] });
    }
    // No hit of a denied type reaches the caller.
    expect(search.hits.some((h: any) => ["CHART", "CASE", "DECISION_MODEL"].includes(h.type))).toBe(false);
    // The allowed types are unaffected.
    expect(search.hits.map((h: any) => h.type)).toEqual(
      ["DATASET", "DASHBOARD", "PIPELINE", "EXPERIMENT", "MODEL"],
    );
    expect(byType(search, "DATASET")).toMatchObject({ denied: false, error: null });
  });

  it("denial of every type yields an empty, successful result — not an error", async () => {
    const { search } = await runSearch({ q: "denial", ws: "ws-9" }, { denied: ALL_TYPES });
    expect(search.hits).toEqual([]);
    expect(search.types.every((t: any) => t.denied)).toBe(true);
  });

  it("a broken service is reported as an error, never silently as 'no matches'", async () => {
    const { search } = await runSearch({ q: "denial", ws: "ws-9" }, { broken: ["CASE"] });
    expect(byType(search, "CASE")).toMatchObject({ denied: false, error: "SERVICE_UNAVAILABLE", hits: [] });
    // and the rest of the fan-out still answers.
    expect(byType(search, "DATASET").hits).toHaveLength(1);
  });

  it("workspace-scoped types report WORKSPACE_REQUIRED instead of failing the query", async () => {
    const { search, requests } = await runSearch({ q: "denial" });
    for (const t of ["DASHBOARD", "CHART"]) {
      expect(byType(search, t)).toMatchObject({ denied: false, error: "WORKSPACE_REQUIRED", hits: [] });
    }
    // chart-service is not called at all without a workspace.
    expect(requests.some((r) => r.path === "/api/v1/dashboards" || r.path === "/api/v1/charts")).toBe(false);
    expect(byType(search, "DATASET").hits).toHaveLength(1);
  });
});

describe("AC-9: a dashboard ranked below the first 50 is findable", () => {
  it("search asks chart-service to filter, so dashboard #51 comes back", async () => {
    const { search, requests } = await runSearch(
      { q: "denial", ws: "ws-9", types: ["DASHBOARD"], first: 10 },
      { dashboardCount: 51 },
    );

    // The one call carries `q`; the BFF never fetches a page to filter itself.
    expect(requests).toHaveLength(1);
    expect(requests[0]!.search.get("q")).toBe("denial");

    expect(search.hits).toHaveLength(1);
    expect(search.hits[0]).toMatchObject({
      type: "DASHBOARD", id: "dash-51", title: "Denial rate review",
      urn: "wr:t-42:chart:dashboard/dash-51",
    });
  });

  it("the plain dashboards(q:) field forwards q too", async () => {
    const server = makeApolloServer(cfg);
    const { fetchImpl, requests } = downstream({ dashboardCount: 51 });
    const ctx = await makeTestContext(fetchImpl);
    const res = await server.executeOperation(
      { query: `query($ws: ID!, $q: String) { dashboards(workspaceId: $ws, q: $q, first: 10) { nodes { id title } } }`,
        variables: { ws: "ws-9", q: "denial" } },
      { contextValue: ctx },
    );
    const body = res.body.kind === "single" ? res.body.singleResult : null;
    expect(body?.errors).toBeUndefined();
    expect(requests[0]!.search.get("q")).toBe("denial");
    expect((body?.data as any).dashboards.nodes).toEqual([{ id: "dash-51", title: "Denial rate review" }]);
  });
});

describe("chartSearch: BRD 74 D2's GET /charts, wired into the graph", () => {
  it("maps a hit with its parent-dashboard context and forwards every filter", async () => {
    const server = makeApolloServer(cfg);
    const { fetchImpl, requests } = downstream();
    const ctx = await makeTestContext(fetchImpl);
    const res = await server.executeOperation(
      { query: `query($ws: ID!) {
          chartSearch(workspaceId: $ws, q: "denial", module: "insights", tag: "finance",
                      dashboardId: "dash-2", includeArchived: true, first: 5) {
            nodes { id urn name chartType description dashboardId dashboardName dashboardModule dashboardTags }
            pageInfo { hasMore }
          }
        }`,
        variables: { ws: "ws-9" } },
      { contextValue: ctx },
    );
    const body = res.body.kind === "single" ? res.body.singleResult : null;
    expect(body?.errors).toBeUndefined();
    expect((body?.data as any).chartSearch.nodes).toEqual([{
      id: "c-1", urn: "wr:t-42:chart:chart/c-1", name: "Denial rate by payer",
      chartType: "vertical_bar_chart", description: "monthly",
      dashboardId: "dash-2", dashboardName: "Finance", dashboardModule: "insights",
      dashboardTags: ["finance"],
    }]);

    const s = requests[0]!.search;
    expect(Object.fromEntries(s.entries())).toMatchObject({
      workspace_id: "ws-9", q: "denial", module: "insights", tag: "finance",
      dashboard_id: "dash-2", include_archived: "true", limit: "5",
    });
  });

  it("a downstream 403 surfaces as PERMISSION_DENIED (the BFF invents no verdict)", async () => {
    const server = makeApolloServer(cfg);
    const { fetchImpl } = downstream({ denied: ["CHART"] });
    const ctx = await makeTestContext(fetchImpl);
    const res = await server.executeOperation(
      { query: `{ chartSearch(workspaceId: "ws-9", q: "denial") { nodes { id } } }` },
      { contextValue: ctx },
    );
    const body = res.body.kind === "single" ? res.body.singleResult : null;
    expect(body?.errors?.[0]?.extensions?.code).toBe("PERMISSION_DENIED");
  });
});

describe("decisionModels: now paged and searchable downstream", () => {
  it("forwards q + limit and returns a connection", async () => {
    const server = makeApolloServer(cfg);
    const { fetchImpl, requests } = downstream();
    const ctx = await makeTestContext(fetchImpl);
    const res = await server.executeOperation(
      { query: `{ decisionModels(q: "denial", first: 5) { nodes { id name version } pageInfo { hasMore } } }` },
      { contextValue: ctx },
    );
    const body = res.body.kind === "single" ? res.body.singleResult : null;
    expect(body?.errors).toBeUndefined();
    expect(requests[0]!.search.get("q")).toBe("denial");
    expect(requests[0]!.search.get("limit")).toBe("5");
    expect((body?.data as any).decisionModels.nodes).toEqual([
      { id: "dm-1", name: "denial table", version: 2 },
    ]);
  });
});

describe("experiments / models: q reaches experiment-service", () => {
  it("both list fields forward q", async () => {
    const server = makeApolloServer(cfg);
    const { fetchImpl, requests } = downstream();
    const ctx = await makeTestContext(fetchImpl);
    const res = await server.executeOperation(
      { query: `{
          experiments(q: "denial", first: 5) { nodes { id name } }
          models(q: "denial", first: 5) { nodes { id name } }
        }` },
      { contextValue: ctx },
    );
    const body = res.body.kind === "single" ? res.body.singleResult : null;
    expect(body?.errors).toBeUndefined();
    expect(requests.find((r) => r.path === "/api/v1/experiments")!.search.get("q")).toBe("denial");
    expect(requests.find((r) => r.path === "/api/v1/models")!.search.get("q")).toBe("denial");
    expect((body?.data as any).experiments.nodes).toEqual([{ id: "exp-1", name: "denial classifier" }]);
    expect((body?.data as any).models.nodes).toEqual([{ id: "m-1", name: "denial_rate_v1" }]);
  });
});

describe("cross-tenant isolation stays where it is enforced", () => {
  it("hit URNs are built from the CALLER's tenant claim, never a downstream echo", async () => {
    const { search } = await runSearch(
      { q: "denial", ws: "ws-9", types: ["DATASET", "CASE"] },
      {},
      { sub: "u-2", tenant_id: "tenant-b", typ: "user", scopes: ["*"] },
    );
    for (const h of search.hits) expect(h.urn).toMatch(/^wr:tenant-b:/);
  });

  it("every leg is a fresh, JWT-forwarded downstream call — there is no shared cache to leak across tenants", async () => {
    const a = await runSearch({ q: "denial", ws: "ws-9", types: ["DATASET"] }, {},
      { sub: "u-1", tenant_id: "t-a", typ: "user", scopes: ["*"] });
    const b = await runSearch({ q: "denial", ws: "ws-9", types: ["DATASET"] }, {},
      { sub: "u-2", tenant_id: "t-b", typ: "user", scopes: ["*"] });
    expect(a.requests).toHaveLength(1);
    expect(b.requests).toHaveLength(1);
    expect(a.requests[0]!.headers["authorization"]).not.toBe(b.requests[0]!.headers["authorization"]);
    expect(a.search.hits[0].urn).toBe("wr:t-a:dataset:dataset/ds-1");
    expect(b.search.hits[0].urn).toBe("wr:t-b:dataset:dataset/ds-1");
  });
});
