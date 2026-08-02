import { describe, it, expect } from "vitest";
import { makeApolloServer } from "../../src/server.js";
import { makeTestContext, testConfig } from "../helpers/context.js";
import { mockFetch, type CapturedRequest } from "../helpers/mockFetch.js";

const cfg = testConfig();

/** query-service + chart-service double for the governance/export surfaces:
 * GET/PUT /limits, POST /sql/dry-run, POST /executions/{id}/export (query) and
 * drilldown / export operations / bundle / link (chart). Paths are disjoint, so
 * one handler serves both downstreams. */
function downstreams() {
  return mockFetch((req: CapturedRequest) => {
    // ---- query-service: tenant limits (QRY-FR-042/044) ----------------------
    if (req.path === "/api/v1/limits" && req.method === "GET") {
      return {
        status: 200,
        body: {
          data: {
            overrides: { max_scan_bytes: 1073741824, concurrent_slots: 4, updated_by: "u-admin" },
            effective_user: { max_scan_bytes: 1073741824, max_runtime_s: 1600, max_result_bytes: 1073741824, max_result_rows: 5000000 },
            effective_agent: { max_scan_bytes: 1073741824, max_runtime_s: 1600, max_result_bytes: 52428800, max_result_rows: 10000 },
            platform_maxima: { max_scan_bytes: 53687091200, max_runtime_s: 1600, max_result_bytes: 1073741824, max_result_rows: 5000000 },
          },
        },
      };
    }
    if (req.path === "/api/v1/limits" && req.method === "PUT") {
      return { status: 200, body: { data: { overrides: req.body } } };
    }
    // ---- query-service: dry-run (QRY-FR-041) --------------------------------
    if (req.path === "/api/v1/sql/dry-run" && req.method === "POST") {
      return {
        status: 200,
        body: {
          data: {
            engine: "duckdb", routing_reason: "small scan", estimated_scan_bytes: 2048,
            estimated_rows: 100, partitions_pruned: "3/8", confidence: "high",
            ceiling_verdict: "ok",
            ceilings: { max_scan_bytes: 53687091200, max_runtime_s: 1600, max_result_bytes: 1073741824, max_result_rows: 5000000 },
            warnings: ["full scan on t"],
          },
        },
      };
    }
    // ---- query-service: result export (QRY-FR-062) --------------------------
    if (req.path === "/api/v1/executions/ex-1/export" && req.method === "POST") {
      return {
        status: 201,
        body: { data: { format: "csv", url: "/api/v1/downloads/tok.sig", expires_at: "2026-08-03T00:00:00Z" } },
      };
    }
    // ---- chart-service: drilldown ({data,page} envelope, CHART-FR-040) ------
    if (req.path === "/api/v1/charts/chart-1/drilldown" && req.method === "POST") {
      return {
        status: 200,
        body: {
          data: { columns: [{ name: "claim_id", type: "VARCHAR" }], rows: [["c-1"], ["c-2"]] },
          page: { next_cursor: "cur-2", has_more: true },
        },
      };
    }
    // ---- chart-service: async export + operation (CHART-FR-041) -------------
    if (req.path === "/api/v1/charts/chart-1/export" && req.method === "POST") {
      return { status: 202, body: { data: { operation_id: "op-9" } } };
    }
    if (req.path === "/api/v1/operations/op-9" && req.method === "GET") {
      return {
        status: 200,
        body: {
          data: {
            id: "op-9", chart_id: "chart-1", kind: "export", format: "csv", status: "completed",
            artifact_url: "/api/v1/exports/t-42/op-9.csv?exp=1&sig=abc",
            artifact_urn: "wr:t-42:chart:operation/op-9",
            expires_at: "2026-08-02T01:00:00Z", created_at: "2026-08-02T00:00:00Z", updated_at: "2026-08-02T00:00:30Z",
          },
        },
      };
    }
    // ---- chart-service: dashboard bundle export/import (CHART-FR-005) -------
    if (req.path === "/api/v1/dashboards/dash-1/export-bundle" && req.method === "POST") {
      return {
        status: 200,
        body: {
          data: {
            dashboard: { name: "Claims", module: "insights", description: "", layout: [], meta: {}, tags: ["q3"] },
            charts: [{ name: "By type", chart_type: "bar_chart", config: { x: "t" }, display_meta: {},
              sources: [{ position: 0, source_type: "query", source_urn: "wr:t-42:query:query/q-1" }] }],
          },
        },
      };
    }
    if (req.path === "/api/v1/dashboards/import" && req.method === "POST") {
      if (Object.keys(req.body.url_mapping ?? {}).length === 0) {
        return { status: 422, body: { error: { code: "UNMAPPED_URN", message: "bundle references URNs not present in url_mapping", trace_id: "t" } } };
      }
      return { status: 201, body: { data: { dashboard_id: "dash-new", charts_created: 1 } } };
    }
    // ---- chart-service: chart links (CHART-FR-015) --------------------------
    if (req.path === "/api/v1/charts/chart-1/link" && req.method === "PUT") {
      return {
        status: 200,
        body: { data: { parent_chart_id: "chart-1", child_chart_id: req.body.child_chart_id,
          link_type: req.body.link_type ?? 1, linked_columns: req.body.linked_columns ?? [] } },
      };
    }
    if (req.path === "/api/v1/charts/chart-1/link" && req.method === "DELETE") {
      return { status: 204 };
    }
    return { status: 404, body: { error: { code: "NOT_FOUND", message: "x", trace_id: "t" } } };
  });
}

describe("query governance (limits + dry-run + result export, JWT passthrough)", () => {
  it("queryLimits maps overrides + effective ceilings + platform maxima (snake→camel)", async () => {
    const server = makeApolloServer(cfg);
    const { fetchImpl, requests } = downstreams();
    const ctx = await makeTestContext(fetchImpl);
    const res = await server.executeOperation(
      { query: `{ queryLimits {
          overrides { maxScanBytes concurrentSlots updatedBy warehousePrimary }
          effectiveUser { maxScanBytes maxRuntimeS }
          effectiveAgent { maxResultRows }
          platformMaxima { maxScanBytes }
        } }` },
      { contextValue: ctx },
    );
    const body = res.body.kind === "single" ? res.body.singleResult : null;
    expect(body?.errors).toBeUndefined();
    const limits = (body?.data as any).queryLimits;
    expect(limits.overrides).toMatchObject({ maxScanBytes: 1073741824, concurrentSlots: 4, updatedBy: "u-admin", warehousePrimary: null });
    expect(limits.effectiveUser).toMatchObject({ maxScanBytes: 1073741824, maxRuntimeS: 1600 });
    expect(limits.effectiveAgent.maxResultRows).toBe(10000);
    expect(limits.platformMaxima.maxScanBytes).toBe(53687091200);
    expect(requests[0]?.headers["authorization"]).toMatch(/^Bearer /);
  });

  it("setQueryLimits PUTs the snake-case override body then re-reads the effective view", async () => {
    const server = makeApolloServer(cfg);
    const { fetchImpl, requests } = downstreams();
    const ctx = await makeTestContext(fetchImpl);
    const res = await server.executeOperation(
      { query: `mutation($input: QueryLimitsInput!) {
          setQueryLimits(input: $input) { overrides { concurrentSlots } effectiveUser { maxScanBytes } }
        }`,
        variables: { input: { maxScanBytes: 1073741824, concurrentSlots: 4, warehousePrimary: true } } },
      { contextValue: ctx },
    );
    const body = res.body.kind === "single" ? res.body.singleResult : null;
    expect(body?.errors).toBeUndefined();
    const put = requests.find((r) => r.method === "PUT" && r.path === "/api/v1/limits");
    expect(put?.body).toMatchObject({ max_scan_bytes: 1073741824, concurrent_slots: 4, warehouse_primary: true });
    // The effective view comes from the follow-up GET, not the PUT echo.
    const get = requests.find((r) => r.method === "GET" && r.path === "/api/v1/limits");
    expect(get).toBeTruthy();
    expect((body?.data as any).setQueryLimits.effectiveUser.maxScanBytes).toBe(1073741824);
  });

  it("dryRunSql maps the plan estimate + ceiling verdict without executing", async () => {
    const server = makeApolloServer(cfg);
    const { fetchImpl, requests } = downstreams();
    const ctx = await makeTestContext(fetchImpl);
    const res = await server.executeOperation(
      { query: `mutation($input: RunSqlInput!) {
          dryRunSql(input: $input) {
            engine routingReason estimatedScanBytes estimatedRows partitionsPruned
            confidence ceilingVerdict ceilings { maxScanBytes } warnings
          }
        }`,
        variables: { input: { sql: "SELECT * FROM {{dataset('claims')}}", limit: 100 } } },
      { contextValue: ctx },
    );
    const body = res.body.kind === "single" ? res.body.singleResult : null;
    expect(body?.errors).toBeUndefined();
    expect((body?.data as any).dryRunSql).toMatchObject({
      engine: "duckdb", routingReason: "small scan", estimatedScanBytes: 2048, estimatedRows: 100,
      partitionsPruned: "3/8", confidence: "high", ceilingVerdict: "ok",
      warnings: ["full scan on t"],
    });
    const post = requests.find((r) => r.path === "/api/v1/sql/dry-run");
    expect(post?.body).toMatchObject({ sql: "SELECT * FROM {{dataset('claims')}}", limit: 100 });
  });

  it("exportQueryExecution passes the service-relative signed path through as downloadPath", async () => {
    const server = makeApolloServer(cfg);
    const { fetchImpl, requests } = downstreams();
    const ctx = await makeTestContext(fetchImpl);
    const res = await server.executeOperation(
      { query: `mutation { exportQueryExecution(id: "ex-1") { format downloadPath expiresAt } }` },
      { contextValue: ctx },
    );
    const body = res.body.kind === "single" ? res.body.singleResult : null;
    expect(body?.errors).toBeUndefined();
    expect((body?.data as any).exportQueryExecution).toEqual({
      format: "csv", downloadPath: "/api/v1/downloads/tok.sig", expiresAt: "2026-08-03T00:00:00Z",
    });
    const post = requests.find((r) => r.path === "/api/v1/executions/ex-1/export");
    expect(post?.body).toEqual({ format: "csv" });
  });
});

describe("chart drilldown / export / portability / links (chart-service passthrough)", () => {
  it("chartDrilldown posts the clicked bind predicate and maps the {data,page} envelope", async () => {
    const server = makeApolloServer(cfg);
    const { fetchImpl, requests } = downstreams();
    const ctx = await makeTestContext(fetchImpl);
    const res = await server.executeOperation(
      { query: `query($input: ChartDrilldownInput!) {
          chartDrilldown(chartId: "chart-1", input: $input) { columns rows nextCursor hasMore }
        }`,
        variables: { input: { dimension: "claim_type", value: "auto", limit: 50,
          filters: [{ field: "region", op: "eq", value: "west" }] } } },
      { contextValue: ctx },
    );
    const body = res.body.kind === "single" ? res.body.singleResult : null;
    expect(body?.errors).toBeUndefined();
    const dd = (body?.data as any).chartDrilldown;
    expect(dd.rows).toEqual([["c-1"], ["c-2"]]);
    expect(dd).toMatchObject({ nextCursor: "cur-2", hasMore: true });
    const post = requests.find((r) => r.path === "/api/v1/charts/chart-1/drilldown");
    expect(post?.body).toMatchObject({
      clicked: { dimension: "claim_type", value: "auto" },
      filters: [{ field: "region", op: "eq", value: "west" }],
      limit: 50,
    });
  });

  it("exportChart starts the async export then re-reads the operation's real state", async () => {
    const server = makeApolloServer(cfg);
    const { fetchImpl, requests } = downstreams();
    const ctx = await makeTestContext(fetchImpl);
    const res = await server.executeOperation(
      { query: `mutation { exportChart(id: "chart-1", format: "csv") { id status format artifactUrl } }` },
      { contextValue: ctx },
    );
    const body = res.body.kind === "single" ? res.body.singleResult : null;
    expect(body?.errors).toBeUndefined();
    expect((body?.data as any).exportChart).toMatchObject({
      id: "op-9", status: "completed", format: "csv",
      artifactUrl: "/api/v1/exports/t-42/op-9.csv?exp=1&sig=abc",
    });
    expect(requests.find((r) => r.path === "/api/v1/charts/chart-1/export")?.body).toMatchObject({ format: "csv" });
    expect(requests.some((r) => r.method === "GET" && r.path === "/api/v1/operations/op-9")).toBe(true);
  });

  it("chartExportOperation polls the operation by id", async () => {
    const server = makeApolloServer(cfg);
    const { fetchImpl } = downstreams();
    const ctx = await makeTestContext(fetchImpl);
    const res = await server.executeOperation(
      { query: `{ chartExportOperation(id: "op-9") { id status expiresAt } }` },
      { contextValue: ctx },
    );
    const body = res.body.kind === "single" ? res.body.singleResult : null;
    expect(body?.errors).toBeUndefined();
    expect((body?.data as any).chartExportOperation).toMatchObject({ id: "op-9", status: "completed" });
  });

  it("exportDashboardBundle returns the raw portable bundle JSON", async () => {
    const server = makeApolloServer(cfg);
    const { fetchImpl } = downstreams();
    const ctx = await makeTestContext(fetchImpl);
    const res = await server.executeOperation(
      { query: `mutation { exportDashboardBundle(id: "dash-1") }` },
      { contextValue: ctx },
    );
    const body = res.body.kind === "single" ? res.body.singleResult : null;
    expect(body?.errors).toBeUndefined();
    const bundle = (body?.data as any).exportDashboardBundle;
    expect(bundle.dashboard.name).toBe("Claims");
    expect(bundle.charts).toHaveLength(1);
    expect(bundle.charts[0].sources[0].source_urn).toBe("wr:t-42:query:query/q-1");
  });

  it("importDashboard sources workspace_id from the JWT claim and forwards url_mapping", async () => {
    const server = makeApolloServer(cfg);
    const { fetchImpl, requests } = downstreams();
    const ctx = await makeTestContext(fetchImpl, { sub: "u-1", tenant_id: "t-42", typ: "user", scopes: ["*"], workspace_id: "ws-9" });
    const res = await server.executeOperation(
      { query: `mutation($bundle: JSON!, $mapping: JSON) {
          importDashboard(bundle: $bundle, urnMapping: $mapping, idempotencyKey: "idem-i1") { dashboardId chartsCreated }
        }`,
        variables: {
          bundle: { dashboard: { name: "Claims" }, charts: [] },
          mapping: { "wr:t-42:query:query/q-1": "wr:t-42:query:query/q-9" },
        } },
      { contextValue: ctx },
    );
    const body = res.body.kind === "single" ? res.body.singleResult : null;
    expect(body?.errors).toBeUndefined();
    expect((body?.data as any).importDashboard).toEqual({ dashboardId: "dash-new", chartsCreated: 1 });
    const post = requests.find((r) => r.path === "/api/v1/dashboards/import");
    expect(post?.body.workspace_id).toBe("ws-9");
    expect(post?.body.url_mapping).toEqual({ "wr:t-42:query:query/q-1": "wr:t-42:query:query/q-9" });
    expect(post?.headers["idempotency-key"]).toBe("idem-i1");
  });

  it("importDashboard fails closed (VALIDATION_FAILED) without a workspace claim", async () => {
    const server = makeApolloServer(cfg);
    const { fetchImpl, requests } = downstreams();
    const ctx = await makeTestContext(fetchImpl, { sub: "u-1", tenant_id: "t-42", typ: "user", scopes: ["*"] });
    const res = await server.executeOperation(
      { query: `mutation($bundle: JSON!) { importDashboard(bundle: $bundle) { dashboardId } }`,
        variables: { bundle: { dashboard: { name: "x" }, charts: [] } } },
      { contextValue: ctx },
    );
    const body = res.body.kind === "single" ? res.body.singleResult : null;
    expect(body?.errors?.[0]?.extensions?.code).toBe("VALIDATION_FAILED");
    expect(requests.some((r) => r.path === "/api/v1/dashboards/import")).toBe(false);
  });

  it("setChartLink PUTs the snake link body; deleteChartLink DELETEs with the child in the body", async () => {
    const server = makeApolloServer(cfg);
    const { fetchImpl, requests } = downstreams();
    const ctx = await makeTestContext(fetchImpl);
    const res = await server.executeOperation(
      { query: `mutation($input: ChartLinkInput!) {
          setChartLink(chartId: "chart-1", input: $input) { parentChartId childChartId linkType linkedColumns }
        }`,
        variables: { input: { childChartId: "chart-2", linkType: 0,
          linkedColumns: [{ parentCol: "claim_type", childCol: "type" }] } } },
      { contextValue: ctx },
    );
    const body = res.body.kind === "single" ? res.body.singleResult : null;
    expect(body?.errors).toBeUndefined();
    expect((body?.data as any).setChartLink).toMatchObject({
      parentChartId: "chart-1", childChartId: "chart-2", linkType: 0,
    });
    const put = requests.find((r) => r.method === "PUT" && r.path === "/api/v1/charts/chart-1/link");
    expect(put?.body).toEqual({
      child_chart_id: "chart-2", link_type: 0,
      linked_columns: [{ parent_col: "claim_type", child_col: "type" }],
    });

    const del = await server.executeOperation(
      { query: `mutation { deleteChartLink(chartId: "chart-1", childChartId: "chart-2") }` },
      { contextValue: ctx },
    );
    const delBody = del.body.kind === "single" ? del.body.singleResult : null;
    expect(delBody?.errors).toBeUndefined();
    expect((delBody?.data as any).deleteChartLink).toBe(true);
    const delReq = requests.find((r) => r.method === "DELETE" && r.path === "/api/v1/charts/chart-1/link");
    expect(delReq?.body).toEqual({ child_chart_id: "chart-2" });
  });
});
