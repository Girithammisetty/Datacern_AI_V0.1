/**
 * Value & ROI reporting (BRD 69). Response shapes mirror the real downstream
 * route bodies — see services/usage-service/internal/api/handlers_value.go
 * and internal/domain/value.go's EstimatedValue MarshalJSON null-guarantee.
 * The load-bearing assertion in this file is null-propagation (ROI-NFR-004):
 * a Tier-0/gap-shaped summary must not turn a JSON `null` into a fabricated
 * `0` anywhere in the resolver chain.
 */
import { describe, it, expect } from "vitest";
import { makeApolloServer } from "../../src/server.js";
import { makeTestContext, testConfig } from "../helpers/context.js";
import { mockFetch, type CapturedRequest } from "../helpers/mockFetch.js";

const cfg = testConfig();
const ADMIN_CLAIMS = { sub: "u-1", tenant_id: "t-42", typ: "user", scopes: ["*"], workspace_id: "ws-1" };

// Full-tier summary body (assumptions set, by_kind populated) — the AC-1 shape.
const POPULATED_SUMMARY = {
  data: {
    period: "2026-07",
    workspace_id: null,
    decisions: {
      total: 12340,
      by_decision: { approved: 11800, edited: 420, rejected: 120 },
      by_kind: { claims_disposition: 12340 },
      by_agent: { "claims-copilot": 12340 },
      by_pack: { "insurance-claims-payer": 12340 },
    },
    hours_saved_est: { value: 4113.3, assumption_version: 1 },
    labor_value_est_usd: { value: 740400.0, assumption_version: 1 },
    ai_cost_usd: 812.44,
    cost_per_decision: { value: 0.0658, basis: "blended" },
    human_baseline_cost_usd: { value: 740400.0, assumption_version: 1 },
    net_value_est_usd: { value: 739587.56, assumption_version: 1 },
    ladder_savings_usd: null,
    adoption: { active_users: 84, by_workspace: { "ws-7": 40, "ws-9": 44 } },
    provenance: { rollup_version: "usage_monthly@2026-07-finalized", assumption_version: 1, meter_gap: null },
  },
};

// Tier-0/gap-shaped summary (assumptions unset, current repo state) — every
// *_est field, decisions and cost_per_decision must round-trip as GraphQL
// null, not 0 / {} / undefined-coerced-to-zero.
const GAP_SUMMARY = {
  data: {
    period: "2026-01",
    workspace_id: null,
    decisions: null,
    hours_saved_est: null,
    labor_value_est_usd: null,
    ai_cost_usd: 0,
    cost_per_decision: null,
    human_baseline_cost_usd: null,
    net_value_est_usd: null,
    ladder_savings_usd: null,
    adoption: { active_users: 0, by_workspace: {} },
    provenance: {
      rollup_version: "usage_monthly@2026-01-open",
      assumption_version: null,
      meter_gap: "governed_decision meter not emitted yet (BRD 67 VMB-FR-001)",
    },
  },
};

function usage(opts: { summary?: any; assumptions?: any } = {}) {
  return mockFetch((req: CapturedRequest) => {
    if (req.path === "/api/v1/value/summary" && req.method === "GET") {
      return { status: 200, body: opts.summary ?? POPULATED_SUMMARY };
    }
    if (req.path === "/api/v1/value/assumptions" && req.method === "GET") {
      return { status: 200, body: opts.assumptions !== undefined ? opts.assumptions : { data: null } };
    }
    if (req.path === "/api/v1/value/assumptions" && req.method === "PUT") {
      return {
        status: 200,
        body: {
          data: {
            id: "va-1", version: 1, minutes_per_decision: req.body.minutes_per_decision,
            loaded_hourly_rate_usd: req.body.loaded_hourly_rate_usd, effective_from: "2026-07-25",
            status: "active", created_by: "u-1", created_at: "2026-07-25T00:00:00Z",
          },
        },
      };
    }
    if (req.path === "/api/v1/value/assumptions/history" && req.method === "GET") {
      return {
        status: 200,
        body: {
          data: [
            { id: "va-1", version: 1, minutes_per_decision: { claims_disposition: 20 }, loaded_hourly_rate_usd: 150,
              effective_from: "2026-01-01", status: "superseded", created_by: "u-1", created_at: "2026-01-01T00:00:00Z" },
            { id: "va-2", version: 2, minutes_per_decision: { claims_disposition: 25 }, loaded_hourly_rate_usd: 180,
              effective_from: "2026-07-01", status: "active", created_by: "u-2", created_at: "2026-07-01T00:00:00Z" },
          ],
          page: { has_more: false },
        },
      };
    }
    if (req.path === "/api/v1/value/trend" && req.method === "GET") {
      return {
        status: 200,
        body: {
          data: {
            metric: "cost_per_decision", granularity: "month",
            points: [
              { period: "2026-02", value: 0.091, basis: "blended", rollup_version: "usage_monthly@2026-02-finalized", distilled_rung_share: null },
              { period: "2026-07", value: 0.0658, basis: "attributed", rollup_version: "usage_monthly@2026-07-finalized", distilled_rung_share: 0.42 },
            ],
          },
        },
      };
    }
    if (req.path === "/api/v1/value-reports" && req.method === "GET") {
      return { status: 200, body: { data: [], page: { has_more: false } } };
    }
    if (req.path === "/api/v1/value-reports" && req.method === "POST") {
      return {
        status: 201,
        body: {
          data: {
            id: "ve-1", period: req.body.period, version: 1,
            json_url: "https://example/report.json", json_sha256: "abc123",
            csv_url: "https://example/report.csv", csv_sha256: "def456",
            assumption_version: 1, created_at: "2026-08-01T00:00:00Z",
          },
        },
      };
    }
    return { status: 404, body: { error: { code: "NOT_FOUND", message: "x", trace_id: "t" } } };
  });
}

async function run(query: string, variables: Record<string, unknown> = {}, opts: { summary?: any; assumptions?: any } = {}) {
  const server = makeApolloServer(cfg);
  const { fetchImpl, requests } = usage(opts);
  const ctx = await makeTestContext(fetchImpl, ADMIN_CLAIMS);
  const res = await server.executeOperation({ query, variables }, { contextValue: ctx });
  const body = res.body.kind === "single" ? res.body.singleResult : null;
  return { body, requests };
}

describe("value & ROI reporting: valueSummary", () => {
  it("maps a fully-populated summary field-for-field", async () => {
    const { body, requests } = await run(`
      query($period: String!) {
        valueSummary(period: $period) {
          period
          decisions { total byDecision byKind byAgent byPack }
          hoursSavedEst { value assumptionVersion }
          laborValueEstUsd { value assumptionVersion }
          aiCostUsd
          costPerDecision { value basis }
          humanBaselineCostUsd { value assumptionVersion }
          netValueEstUsd { value assumptionVersion }
          ladderSavingsUsd
          adoption { activeUsers byWorkspace }
          provenance { rollupVersion assumptionVersion meterGap }
        }
      }`, { period: "2026-07" });
    expect(body?.errors).toBeUndefined();
    const s = (body?.data as any).valueSummary;
    expect(s.decisions.total).toBe(12340);
    expect(s.hoursSavedEst).toEqual({ value: 4113.3, assumptionVersion: 1 });
    expect(s.laborValueEstUsd).toEqual({ value: 740400, assumptionVersion: 1 });
    expect(s.costPerDecision).toEqual({ value: 0.0658, basis: "blended" });
    expect(s.ladderSavingsUsd).toBeNull();
    expect(s.provenance.assumptionVersion).toBe(1);

    const get = requests.find((r) => r.method === "GET" && r.path === "/api/v1/value/summary");
    expect(get?.search.get("period")).toBe("2026-07");
  });

  it("never turns a Tier-0/gap null into 0, {} or an error — ROI-NFR-004", async () => {
    const { body } = await run(`
      query($period: String!) {
        valueSummary(period: $period) {
          decisions { total }
          hoursSavedEst { value }
          laborValueEstUsd { value }
          costPerDecision { value }
          humanBaselineCostUsd { value }
          netValueEstUsd { value }
          ladderSavingsUsd
          provenance { assumptionVersion meterGap }
        }
      }`, { period: "2026-01" }, { summary: GAP_SUMMARY });
    expect(body?.errors).toBeUndefined();
    const s = (body?.data as any).valueSummary;
    expect(s.decisions).toBeNull();
    expect(s.hoursSavedEst).toBeNull();
    expect(s.laborValueEstUsd).toBeNull();
    expect(s.costPerDecision).toBeNull();
    expect(s.humanBaselineCostUsd).toBeNull();
    expect(s.netValueEstUsd).toBeNull();
    expect(s.ladderSavingsUsd).toBeNull();
    expect(s.provenance.assumptionVersion).toBeNull();
    expect(s.provenance.meterGap).toContain("governed_decision meter not emitted yet");
  });

  it("passes workspaceId through as a query param", async () => {
    const { requests } = await run(`query($p: String!, $w: String) { valueSummary(period: $p, workspaceId: $w) { period } }`,
      { p: "2026-07", w: "ws-7" });
    const get = requests.find((r) => r.method === "GET" && r.path === "/api/v1/value/summary");
    expect(get?.search.get("workspace_id")).toBe("ws-7");
  });
});

describe("value & ROI reporting: valueTrend", () => {
  it("maps trend points including a null distilledRungShare", async () => {
    const { body } = await run(`{ valueTrend(metric: "cost_per_decision") { metric points { period value basis distilledRungShare } } }`);
    expect(body?.errors).toBeUndefined();
    const t = (body?.data as any).valueTrend;
    expect(t.points).toHaveLength(2);
    expect(t.points[0].distilledRungShare).toBeNull();
    expect(t.points[1].distilledRungShare).toBe(0.42);
  });
});

describe("value & ROI reporting: assumptions", () => {
  it("valueAssumptions returns null when the tenant has never set any", async () => {
    const { body } = await run(`{ valueAssumptions { id version } }`, {}, { assumptions: { data: null } });
    expect(body?.errors).toBeUndefined();
    expect((body?.data as any).valueAssumptions).toBeNull();
  });

  it("updateValueAssumptions PUTs the input and returns the new version", async () => {
    const { body, requests } = await run(`
      mutation($input: UpdateValueAssumptionsInput!) {
        updateValueAssumptions(input: $input) { version loadedHourlyRateUsd minutesPerDecision }
      }`, { input: { minutesPerDecision: { claims_disposition: 20 }, loadedHourlyRateUsd: 180 } });
    expect(body?.errors).toBeUndefined();
    const a = (body?.data as any).updateValueAssumptions;
    expect(a).toMatchObject({ version: 1, loadedHourlyRateUsd: 180 });
    const put = requests.find((r) => r.method === "PUT" && r.path === "/api/v1/value/assumptions");
    expect(put?.body).toEqual({ minutes_per_decision: { claims_disposition: 20 }, loaded_hourly_rate_usd: 180 });
  });

  it("valueAssumptionHistory returns versions in order with status", async () => {
    const { body } = await run(`{ valueAssumptionHistory { version status createdBy } }`);
    expect(body?.errors).toBeUndefined();
    const h = (body?.data as any).valueAssumptionHistory;
    expect(h).toEqual([
      { version: 1, status: "superseded", createdBy: "u-1" },
      { version: 2, status: "active", createdBy: "u-2" },
    ]);
  });
});

describe("value & ROI reporting: exports", () => {
  it("exportValueReport POSTs the period and returns checksums", async () => {
    const { body, requests } = await run(`
      mutation($period: String!) {
        exportValueReport(period: $period) { period version jsonSha256 csvSha256 }
      }`, { period: "2026-07" });
    expect(body?.errors).toBeUndefined();
    expect((body?.data as any).exportValueReport).toMatchObject({
      period: "2026-07", version: 1, jsonSha256: "abc123", csvSha256: "def456",
    });
    const post = requests.find((r) => r.method === "POST" && r.path === "/api/v1/value-reports");
    expect(post?.body).toMatchObject({ period: "2026-07" });
  });

  it("valueExports lists exports for a period", async () => {
    const { body, requests } = await run(`query($p: String) { valueExports(period: $p) { id } }`, { p: "2026-07" });
    expect(body?.errors).toBeUndefined();
    expect((body?.data as any).valueExports).toEqual([]);
    const get = requests.find((r) => r.method === "GET" && r.path === "/api/v1/value-reports");
    expect(get?.search.get("period")).toBe("2026-07");
  });
});
