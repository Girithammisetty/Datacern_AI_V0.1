/**
 * Usage billing depth (BRD 67): meter catalog, chargeback, reconciliation
 * acknowledge and billing adjustments. Response shapes mirror the real
 * downstream route bodies — see services/usage-service/internal/api/
 * handlers_meters.go, handlers_reports.go and handlers_recon.go.
 */
import { describe, it, expect } from "vitest";
import { makeApolloServer } from "../../src/server.js";
import { makeTestContext, testConfig } from "../helpers/context.js";
import { mockFetch, type CapturedRequest } from "../helpers/mockFetch.js";

const cfg = testConfig();

const RECON_ROWS = [
  { id: "r-1", month: "2026-06", provider: "aws", status: "variance",
    report_uri: "s3://recon/2026-06.json", created_at: "2026-07-01T00:00:00Z" },
  { id: "r-2", month: "2026-05", provider: "aws", status: "matched",
    report_uri: "s3://recon/2026-05.json", created_at: "2026-06-01T00:00:00Z" },
];

function usage() {
  let acked = false;
  return mockFetch((req: CapturedRequest) => {
    if (req.path === "/api/v1/meters" && req.method === "GET") {
      return {
        status: 200,
        body: {
          data: [
            { meter_key: "api_calls", unit: "count", aggregation: "sum",
              description: "Edge API requests completed",
              dimensions: ["tenant_id", "workspace_id"], deprecated: false },
            { meter_key: "storage_gb_month", unit: "gb_month", aggregation: "time_weighted_avg",
              description: "Time-weighted storage in GB-months",
              dimensions: ["tenant_id"], deprecated: false },
          ],
          page: { has_more: false },
        },
      };
    }
    if (req.path === "/api/v1/reports/chargeback" && req.method === "GET") {
      const month = req.search.get("month");
      if (month === "2026-06") {
        // AC-9: chargeback blocked while reconciliation variance is unresolved.
        return {
          status: 409,
          body: { error: { code: "CONFLICT", message: "chargeback blocked",
            details: { reason: "reconciliation_variance" }, trace_id: "t" } },
        };
      }
      return {
        status: 200,
        body: {
          data: [
            { tenant_id: "t-42", workspace_id: "ws-1", month, meter_key: "api_calls",
              quantity: 1000, rate_card_id: "rc-1", price_per_unit_usd: 0.001,
              usd: 1, adjustments_usd: -0.25, total_usd: 0.75 },
            { tenant_id: "t-42", workspace_id: null, month, meter_key: "pipeline_minutes",
              quantity: 12, rate_card_id: "", price_per_unit_usd: 0,
              usd: 0, adjustments_usd: 0, total_usd: 0 },
          ],
          page: { has_more: false },
        },
      };
    }
    if (req.path === "/api/v1/billing/periods" && req.method === "GET") {
      const period = req.search.get("period");
      const all = [
        { id: "bp-1", tenant_id: "t-42", period: "2026-06", version: 1,
          rate_card_id: "rc-1", rate_card_version: 3, gross_usd: 1200.5, net_billable_usd: 1150.25,
          status: "exported", closed_at: "2026-07-01T00:00:00Z", closed_by: "u-close",
          export: { jsonl_key: "s3://bill/2026-06.jsonl", jsonl_sha256: "aa", csv_key: "s3://bill/2026-06.csv",
            csv_sha256: "bb", pushed_status: "pushed", pushed_reference: "in_123", pushed_at: "2026-07-01T01:00:00Z",
            created_at: "2026-07-01T00:30:00Z" } },
        { id: "bp-2", tenant_id: "t-42", period: "2026-05", version: 1,
          rate_card_id: "", rate_card_version: 2, gross_usd: 0, net_billable_usd: 0,
          status: "closed", closed_at: "2026-06-01T00:00:00Z", closed_by: "",
          export: null },
      ];
      const rows = period ? all.filter((r) => r.period === period) : all;
      return { status: 200, body: { data: rows, page: { has_more: false } } };
    }
    if (req.path === "/api/v1/reconciliations" && req.method === "GET") {
      const rows = acked
        ? RECON_ROWS.map((r) => (r.id === "r-1" ? { ...r, status: "acknowledged" } : r))
        : RECON_ROWS;
      return { status: 200, body: { data: rows, page: { has_more: false } } };
    }
    if (req.path === "/api/v1/reconciliations/r-1/acknowledge" && req.method === "POST") {
      acked = true;
      return { status: 200, body: { data: { id: "r-1", status: "acknowledged" } } };
    }
    if (req.path === "/api/v1/adjustments" && req.method === "POST") {
      const body = req.body as Record<string, unknown>;
      if (body.month === "2026-08") {
        // BR-5: month must be finalized.
        return {
          status: 409,
          body: { error: { code: "CONFLICT", message: "month is not finalized",
            details: { reason: "month_open" }, trace_id: "t" } },
        };
      }
      return {
        status: 201,
        body: { data: { id: "adj-1", month: body.month, meter_key: body.meter_key,
          quantity_delta: body.quantity_delta, usd_delta: body.usd_delta, reason: body.reason } },
      };
    }
    return { status: 404, body: { error: { code: "NOT_FOUND", message: "x", trace_id: "t" } } };
  });
}

const ADMIN_CLAIMS = { sub: "u-1", tenant_id: "t-42", typ: "user", scopes: ["*"], workspace_id: "ws-1" };

async function run(query: string, variables: Record<string, unknown> = {}) {
  const server = makeApolloServer(cfg);
  const { fetchImpl, requests } = usage();
  const ctx = await makeTestContext(fetchImpl, ADMIN_CLAIMS);
  const res = await server.executeOperation({ query, variables }, { contextValue: ctx });
  const body = res.body.kind === "single" ? res.body.singleResult : null;
  return { body, requests };
}

describe("usage: meter catalog", () => {
  it("lists the seeded meters with units and aggregations", async () => {
    const { body } = await run(`{ usageMeters { meterKey unit aggregation description dimensions deprecated } }`);
    expect(body?.errors).toBeUndefined();
    const meters = (body?.data as any).usageMeters;
    expect(meters).toHaveLength(2);
    expect(meters[0]).toMatchObject({ meterKey: "api_calls", unit: "count", aggregation: "sum", deprecated: false });
    expect(meters[1].aggregation).toBe("time_weighted_avg");
  });
});

describe("usage: chargeback report", () => {
  it("passes month through and maps priced lines (empty rate_card_id -> null)", async () => {
    const { body, requests } = await run(
      `query($m: String!) { chargebackReport(month: $m) {
        tenantId workspaceId month meterKey quantity rateCardId pricePerUnitUsd usd adjustmentsUsd totalUsd
      } }`,
      { m: "2026-05" },
    );
    expect(body?.errors).toBeUndefined();
    const lines = (body?.data as any).chargebackReport;
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({
      workspaceId: "ws-1", month: "2026-05", meterKey: "api_calls",
      rateCardId: "rc-1", usd: 1, adjustmentsUsd: -0.25, totalUsd: 0.75,
    });
    expect(lines[1].rateCardId).toBeNull();
    const get = requests.find((r) => r.method === "GET" && r.path === "/api/v1/reports/chargeback");
    expect(get?.search.get("month")).toBe("2026-05");
  });

  it("surfaces the reconciliation-variance 409 verbatim as CONFLICT (AC-9)", async () => {
    const { body } = await run(
      `query($m: String!) { chargebackReport(month: $m) { meterKey } }`,
      { m: "2026-06" },
    );
    expect(body?.errors?.[0]?.extensions?.code).toBe("CONFLICT");
    expect((body?.errors?.[0]?.extensions as any)?.details).toEqual({ reason: "reconciliation_variance" });
  });
});

describe("usage: billing periods", () => {
  it("lists closed periods newest-first with totals, status and export/push detail", async () => {
    const { body, requests } = await run(
      `{ billingPeriods {
        id period version rateCardId rateCardVersion grossUsd netBillableUsd status closedAt closedBy
        export { csvKey csvSha256 pushedStatus pushedReference pushedAt createdAt }
      } }`,
    );
    expect(body?.errors).toBeUndefined();
    const rows = (body?.data as any).billingPeriods;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      id: "bp-1", period: "2026-06", grossUsd: 1200.5, netBillableUsd: 1150.25, status: "exported",
      closedBy: "u-close",
    });
    // Push status surfaced verbatim, not inferred.
    expect(rows[0].export).toMatchObject({ csvKey: "s3://bill/2026-06.csv", pushedStatus: "pushed", pushedReference: "in_123" });
    // A closed-but-not-yet-exported period: empty rate card -> null, export null.
    expect(rows[1]).toMatchObject({ id: "bp-2", period: "2026-05", rateCardId: null, closedBy: null });
    expect(rows[1].export).toBeNull();
    // No period filter -> no query param.
    const get = requests.find((r) => r.method === "GET" && r.path === "/api/v1/billing/periods");
    expect(get?.search.get("period")).toBeNull();
  });

  it("passes period + first through to the downstream query", async () => {
    const { body, requests } = await run(
      `query($p: String, $n: Int) { billingPeriods(period: $p, first: $n) { id period } }`,
      { p: "2026-06", n: 10 },
    );
    expect(body?.errors).toBeUndefined();
    const rows = (body?.data as any).billingPeriods;
    expect(rows).toHaveLength(1);
    expect(rows[0].period).toBe("2026-06");
    const get = requests.find((r) => r.method === "GET" && r.path === "/api/v1/billing/periods");
    expect(get?.search.get("period")).toBe("2026-06");
    expect(get?.search.get("limit")).toBe("10");
  });
});

describe("usage: reconciliations + adjustments", () => {
  it("lists reconciliations with status and report uri", async () => {
    const { body } = await run(`{ reconciliations { id month provider status reportUri createdAt } }`);
    expect(body?.errors).toBeUndefined();
    const rows = (body?.data as any).reconciliations;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ id: "r-1", month: "2026-06", status: "variance", reportUri: "s3://recon/2026-06.json" });
  });

  it("acknowledgeReconciliation POSTs the id and re-reads the full row", async () => {
    const { body, requests } = await run(
      `mutation { acknowledgeReconciliation(id: "r-1") { id month status provider } }`,
    );
    expect(body?.errors).toBeUndefined();
    expect((body?.data as any).acknowledgeReconciliation).toMatchObject({
      id: "r-1", month: "2026-06", status: "acknowledged", provider: "aws",
    });
    expect(requests.some((r) => r.method === "POST" && r.path === "/api/v1/reconciliations/r-1/acknowledge")).toBe(true);
  });

  it("createUsageAdjustment POSTs the snake_case body and maps the 201 echo", async () => {
    const { body, requests } = await run(
      `mutation($input: CreateUsageAdjustmentInput!) {
        createUsageAdjustment(input: $input) { id meterKey month quantityDelta usdDelta reason }
      }`,
      { input: { meterKey: "api_calls", month: "2026-06", quantityDelta: -100, usdDelta: -0.1, reason: "double count" } },
    );
    expect(body?.errors).toBeUndefined();
    expect((body?.data as any).createUsageAdjustment).toMatchObject({
      id: "adj-1", meterKey: "api_calls", month: "2026-06", quantityDelta: -100, usdDelta: -0.1, reason: "double count",
    });
    const post = requests.find((r) => r.method === "POST" && r.path === "/api/v1/adjustments");
    expect(post?.body).toEqual({
      meter_key: "api_calls", month: "2026-06", quantity_delta: -100, usd_delta: -0.1, reason: "double count",
    });
  });

  it("surfaces the open-month 409 verbatim as CONFLICT (BR-5)", async () => {
    const { body } = await run(
      `mutation($input: CreateUsageAdjustmentInput!) { createUsageAdjustment(input: $input) { id } }`,
      { input: { meterKey: "api_calls", month: "2026-08", quantityDelta: 0, usdDelta: -1, reason: "credit" } },
    );
    expect(body?.errors?.[0]?.extensions?.code).toBe("CONFLICT");
    expect((body?.errors?.[0]?.extensions as any)?.details).toEqual({ reason: "month_open" });
  });
});
