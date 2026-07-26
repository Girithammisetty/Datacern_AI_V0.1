/**
 * BRD 68 slice 1: Agent Control Tower fleet aggregation
 * (docs/initiatives/agent-control-tower.md). Response shapes mirror the real
 * downstream route bodies — see services/agent-runtime/app/api/routes/
 * registry.py (_definition_view/_version_view/_tenant_config_view,
 * kill-switches), services/eval-service/app/api/routes/{runs,gates}.py, and
 * usage-service's GET /reports/usage (group_by=agent).
 */
import { describe, it, expect } from "vitest";
import { makeApolloServer } from "../../src/server.js";
import { makeTestContext, testConfig } from "../helpers/context.js";
import { mockFetch, type CapturedRequest, type Handler } from "../helpers/mockFetch.js";

const cfg = testConfig();
const ADMIN_CLAIMS = { sub: "u-1", tenant_id: "t-42", typ: "user", scopes: ["*"], workspace_id: "ws-1" };

async function run(handler: Handler, query: string, variables: Record<string, unknown> = {}) {
  const server = makeApolloServer(cfg);
  const { fetchImpl, requests } = mockFetch(handler);
  const ctx = await makeTestContext(fetchImpl, ADMIN_CLAIMS);
  const res = await server.executeOperation({ query, variables }, { contextValue: ctx });
  const body = res.body.kind === "single" ? res.body.singleResult : null;
  return { body, requests };
}

const FLEET_QUERY = /* GraphQL */ `
  query AgentFleet($periodFrom: String, $periodTo: String) {
    agentFleet(periodFrom: $periodFrom, periodTo: $periodTo) {
      key kind display lifecycle
      activeVersion { id graphDigest rollout }
      guardrails { dataScope tokenBudget piiEgress ruleOfTwo }
      toolset
      evalGate { status lastRunAt suiteKey unavailable }
      killSwitch { state updatedAt actor }
      spend { periodUsd trend7dPct unavailable }
      decisions { proposed approved edited rejected period unavailable }
      lastIncidentAt
      external { allowListScope sdkPrincipal autoExecute }
      liveUpdates { hubUrl topics }
    }
  }
`;

const SUMMARY_QUERY = /* GraphQL */ `
  query AgentFleetSummary($periodFrom: String, $periodTo: String) {
    agentFleetSummary(periodFrom: $periodFrom, periodTo: $periodTo) {
      totalByKind activeCount killedCount quarantinedCount periodSpendUsd periodDecisions
    }
  }
`;

const PERIOD_FROM = "2026-06-25";
const PERIOD_TO = "2026-07-25";

const DEFINITIONS = [
  { agent_key: "case-triage", display_name: "Case Triage", owner_team: "platform-ai", status: "published", latest_published_version: 1 },
  { agent_key: "acme-custom-1", display_name: "Acme Custom", owner_team: "tenant:t-42", status: "published", latest_published_version: 1 },
  { agent_key: "partner-ext", display_name: "Partner External", owner_team: "platform-ai", status: "published", latest_published_version: 1 },
];

const VERSIONS: Record<string, unknown[]> = {
  "case-triage": [{ agent_key: "case-triage", version: 1, status: "published", graph_ref: "case_triage_graph", graph_digest: "sha256:aaa", toolset: ["tool.read_case"], model_config: {} }],
  "acme-custom-1": [{ agent_key: "acme-custom-1", version: 1, status: "published", graph_ref: "custom_graph", graph_digest: "sha256:bbb", toolset: [{ tool_id: "tool.custom_propose" }], model_config: {} }],
  "partner-ext": [{ agent_key: "partner-ext", version: 1, status: "published", graph_ref: "external", graph_digest: "sha256:ccc", toolset: ["tool.partner_call"], model_config: {} }],
};

const TENANT_CONFIGS: Record<string, unknown> = {
  "case-triage": { agent_key: "case-triage", configured: false, enabled: true, pinned_version: null, self_approval: false, guardrail_policy: {} },
  "acme-custom-1": {
    agent_key: "acme-custom-1", configured: true, enabled: true, pinned_version: 2, self_approval: false,
    guardrail_policy: { data_scope: { workspaces: ["ws-1"] }, budget: { max_tokens_per_session: 5000 }, pii: { block_pii_egress: true } },
  },
  "partner-ext": { agent_key: "partner-ext", configured: false, enabled: true, pinned_version: null, self_approval: false, guardrail_policy: {} },
};

function baseHandler(overrides: Partial<Record<string, Handler>> = {}): Handler {
  return (req: CapturedRequest) => {
    if (overrides.registry && req.path === "/api/v1/registry/agents" && req.method === "GET") {
      const r = overrides.registry(req);
      if (r) return r;
    }
    if (req.path === "/api/v1/registry/agents" && req.method === "GET") {
      return { body: { data: DEFINITIONS } };
    }
    if (req.path === "/api/v1/registry/kill-switches" && req.method === "GET") {
      return {
        body: {
          data: [
            { kill_id: "k-1", scope: "agent_version_tenant", agent_key: "acme-custom-1", version: null, tenant_id: "t-42", active: true, reason: "INC-9", set_by: "user:u-9", created_at: "2026-07-20T00:00:00Z" },
          ],
        },
      };
    }
    const versionsMatch = req.path.match(/^\/api\/v1\/registry\/agents\/([^/]+)\/versions$/);
    if (versionsMatch && req.method === "GET") {
      const key = versionsMatch[1] ?? "";
      return { body: { data: VERSIONS[key] ?? [] } };
    }
    const tenantConfigMatch = req.path.match(/^\/api\/v1\/registry\/tenants\/self\/agents\/([^/]+)$/);
    if (tenantConfigMatch && req.method === "GET") {
      if (overrides.tenantConfig) {
        const r = overrides.tenantConfig(req);
        if (r) return r;
      }
      const key = tenantConfigMatch[1] ?? "";
      return { body: { data: TENANT_CONFIGS[key] ?? { agent_key: key, configured: false, enabled: true, self_approval: false, guardrail_policy: {} } } };
    }
    if (req.path === "/api/v1/runs" && req.method === "GET") {
      if (overrides.evalRuns) {
        const r = overrides.evalRuns(req);
        if (r) return r;
      }
      const agentKey = req.search.get("agent_key");
      if (agentKey === "case-triage") {
        return { body: { data: [{ id: "run-1", agent_key: "case-triage", candidate: { content_digest: "sha256:aaa" }, status: "succeeded", trigger: "manual", totals: {}, cost_usd: 0, cost_cap_usd: 0, suite_pins: {}, started_by: "u-1", created_at: "2026-07-24T00:00:00Z" }] } };
      }
      return { body: { data: [] } }; // never run yet: real absence.
    }
    if (req.path === "/api/v1/gates" && req.method === "GET") {
      if (overrides.evalGates) {
        const r = overrides.evalGates(req);
        if (r) return r;
      }
      if (req.search.get("agent_key") === "case-triage" && req.search.get("content_digest") === "sha256:aaa") {
        return { body: { data: [{ id: "g-1", gate_run_id: "gr-1", run_id: "run-1", agent_key: "case-triage", content_digest: "sha256:aaa", suite_id: "suite-core", suite_version: 1, dataset_version: 1, gate_passed: true, verdicts: [], failed_cases_sample: [], created_at: "2026-07-24T00:05:00Z" }] } };
      }
      return { body: { data: [] } };
    }
    if (req.path === "/api/v1/reports/usage" && req.method === "GET") {
      if (overrides.usage) {
        const r = overrides.usage(req);
        if (r) return r;
      }
      const from = req.search.get("from");
      if (from === PERIOD_FROM) {
        return { body: { data: [
          { agent_id: "case-triage", meter_key: "llm_input_tokens", quantity: 100, usd: 12.5 },
          { agent_id: "acme-custom-1", meter_key: "llm_input_tokens", quantity: 40, usd: 3.0 },
        ] } };
      }
      // prior-period call (any other `from`).
      return { body: { data: [
        { agent_id: "case-triage", meter_key: "llm_input_tokens", quantity: 80, usd: 10.0 },
      ] } };
    }
    return { status: 404, body: { error: { code: "NOT_FOUND", message: "x", trace_id: "t" } } };
  };
}

describe("agentFleet: happy path (AC-1)", () => {
  it("lists platform/custom/external rows with correct kind + degradation-free field groups", async () => {
    const { body, requests } = await run(baseHandler(), FLEET_QUERY, { periodFrom: PERIOD_FROM, periodTo: PERIOD_TO });
    expect(body?.errors).toBeUndefined();
    const rows = (body?.data as any).agentFleet as any[];
    expect(rows).toHaveLength(3);

    const byKey = Object.fromEntries(rows.map((r) => [r.key, r]));
    expect(byKey["case-triage"]).toMatchObject({
      kind: "PLATFORM",
      lifecycle: "ACTIVE",
      activeVersion: { id: 1, graphDigest: "sha256:aaa", rollout: "UNKNOWN" },
      toolset: ["tool.read_case"],
      evalGate: { status: "PASS", suiteKey: "suite-core", unavailable: false },
      killSwitch: { state: "active" },
      spend: { periodUsd: 12.5, unavailable: false },
      decisions: { unavailable: true, proposed: null },
      external: null,
    });
    // Trend: current 12.5 vs prior 10.0 -> +25%.
    expect(byKey["case-triage"].spend.trend7dPct).toBeCloseTo(25, 5);

    expect(byKey["acme-custom-1"]).toMatchObject({
      kind: "CUSTOM",
      lifecycle: "KILLED", // active kill switch row
      activeVersion: { rollout: "PINNED" }, // tenant config pinned_version=2
      guardrails: { tokenBudget: 5000, piiEgress: "blocked" },
      killSwitch: { state: "killed", actor: "user:u-9" },
      evalGate: { status: "NONE", unavailable: false }, // never run
    });

    expect(byKey["partner-ext"]).toMatchObject({
      kind: "EXTERNAL",
      spend: { periodUsd: 0, unavailable: false }, // real zero (never appeared in the report), never fabricated as "unavailable"
      external: { autoExecute: "denied", sdkPrincipal: "partner-ext" },
    });

    // Dataloader batching (ACT-NFR-001): fleet spend fetched ONCE per period,
    // not once per agent — 2 calls total (current + prior), not 2*3=6.
    const usageCalls = requests.filter((r) => r.path === "/api/v1/reports/usage");
    expect(usageCalls).toHaveLength(2);
  });
});

describe("agentFleet: per-column degradation (ACT-FR-001/ACT-NFR-004, AC-3)", () => {
  it("a failing eval-service source degrades ONLY evalGate; siblings stay intact", async () => {
    const handler = baseHandler({
      evalRuns: () => ({ status: 500, body: { error: { code: "INTERNAL", message: "boom", trace_id: "t" } } }),
    });
    const { body } = await run(handler, FLEET_QUERY, { periodFrom: PERIOD_FROM, periodTo: PERIOD_TO });
    expect(body?.errors).toBeUndefined();
    const rows = (body?.data as any).agentFleet as any[];
    const caseTriage = rows.find((r) => r.key === "case-triage");
    expect(caseTriage.evalGate).toEqual({ status: "NONE", lastRunAt: null, suiteKey: null, unavailable: true });
    // Everything else on the row is untouched by the eval outage.
    expect(caseTriage.kind).toBe("PLATFORM");
    expect(caseTriage.spend).toMatchObject({ periodUsd: 12.5, unavailable: false });
    expect(caseTriage.guardrails.ruleOfTwo).toBe(true);
  });

  it("a failing usage-service source degrades ONLY spend (never a fabricated zero); siblings stay intact", async () => {
    const handler = baseHandler({
      usage: () => ({ status: 503, body: { error: { code: "INTERNAL", message: "down", trace_id: "t" } } }),
    });
    const { body } = await run(handler, FLEET_QUERY, { periodFrom: PERIOD_FROM, periodTo: PERIOD_TO });
    expect(body?.errors).toBeUndefined();
    const rows = (body?.data as any).agentFleet as any[];
    const caseTriage = rows.find((r) => r.key === "case-triage");
    expect(caseTriage.spend).toEqual({ periodUsd: null, trend7dPct: null, unavailable: true });
    expect(caseTriage.evalGate.status).toBe("PASS");
    expect(caseTriage.decisions.unavailable).toBe(true); // pre-existing, permanent gap — not caused by this outage
  });

  it("decisions is always unavailable in slice 1 (no agent-runtime aggregate route — documented gap)", async () => {
    const { body } = await run(baseHandler(), FLEET_QUERY, { periodFrom: PERIOD_FROM, periodTo: PERIOD_TO });
    const rows = (body?.data as any).agentFleet as any[];
    for (const row of rows) {
      expect(row.decisions).toMatchObject({ unavailable: true, proposed: null, approved: null, edited: null, rejected: null });
    }
  });
});

describe("agentFleet: authz (ACT-FR-002, AC-5)", () => {
  it("a downstream 403 on the base registry call surfaces as PERMISSION_DENIED for the whole query", async () => {
    const handler = baseHandler({
      registry: () => ({ status: 403, body: { error: { code: "PERMISSION_DENIED", message: "ai.agent.read required", trace_id: "t" } } }),
    });
    const { body } = await run(handler, FLEET_QUERY, { periodFrom: PERIOD_FROM, periodTo: PERIOD_TO });
    expect(body?.errors?.[0]?.extensions?.code).toBe("PERMISSION_DENIED");
    expect((body?.data as any)?.agentFleet ?? null).toBeNull();
  });
});

describe("agentFleetSummary (ACT-FR-011)", () => {
  it("aggregates totals by kind/lifecycle and sums available spend", async () => {
    const { body } = await run(baseHandler(), SUMMARY_QUERY, { periodFrom: PERIOD_FROM, periodTo: PERIOD_TO });
    expect(body?.errors).toBeUndefined();
    const summary = (body?.data as any).agentFleetSummary;
    expect(summary.totalByKind).toMatchObject({ platform: 1, custom: 1, external: 1 });
    expect(summary.activeCount).toBe(2); // case-triage + partner-ext
    expect(summary.killedCount).toBe(1); // acme-custom-1
    expect(summary.periodSpendUsd).toBeCloseTo(15.5, 5); // 12.5 + 3.0 + 0
    expect(summary.periodDecisions).toBeNull(); // no aggregate source in slice 1
  });

  it("nulls periodSpendUsd (never a partial-sum fabrication) when usage-service is down", async () => {
    const handler = baseHandler({
      usage: () => ({ status: 500, body: { error: { code: "INTERNAL", message: "down", trace_id: "t" } } }),
    });
    const { body } = await run(handler, SUMMARY_QUERY, { periodFrom: PERIOD_FROM, periodTo: PERIOD_TO });
    expect(body?.errors).toBeUndefined();
    expect((body?.data as any).agentFleetSummary.periodSpendUsd).toBeNull();
  });
});
