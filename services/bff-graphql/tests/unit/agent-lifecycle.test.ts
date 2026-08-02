/**
 * Agent lifecycle controls (BRD 14/68 Control Tower management side):
 * register definition, create immutable version, rollouts (start/promote/
 * rollback + list), retrain watches (list/create/delete). Response shapes
 * mirror the real downstream routes — see
 * services/agent-runtime/app/api/routes/registry.py.
 */
import { describe, it, expect } from "vitest";
import { makeApolloServer } from "../../src/server.js";
import { makeTestContext, testConfig } from "../helpers/context.js";
import { mockFetch, type CapturedRequest } from "../helpers/mockFetch.js";

const cfg = testConfig();

const WATCH_ROW = {
  id: "w-1", model_urn: "urn:dc:model:fraud-scorer:3", watched_agent_key: "case-triage",
  workspace_id: "ws-1", cadence_seconds: 86400, correction_window_hours: 168,
  drift_threshold: 0.3, min_corrections: 20, enabled: true,
  last_checked_at: "2026-08-01T00:00:00Z", last_signal: { ratio: 0.1 }, created_by: "u-1",
};

function lifecycleRoutes() {
  return mockFetch((req: CapturedRequest) => {
    if (req.path === "/api/v1/registry/rollouts" && req.method === "GET") {
      return {
        status: 200,
        body: {
          data: [
            { rollout_id: "r-1", agent_key: "case-triage", cell: "dev", mode: "canary",
              candidate_version: 3, baseline_version: 2, pct: 10, tenant_filter: {}, status: "active" },
          ],
        },
      };
    }
    if (req.path === "/api/v1/registry/rollouts" && req.method === "POST") {
      return { status: 200, body: { data: { rollout_id: "r-new", status: "active" } } };
    }
    if (req.path === "/api/v1/registry/rollouts/r-1/promote" && req.method === "POST") {
      return { status: 200, body: { data: { rollout_id: "r-1", status: "promoted" } } };
    }
    if (req.path === "/api/v1/registry/rollouts/r-1/rollback" && req.method === "POST") {
      return { status: 200, body: { data: { rollout_id: "r-1", status: "rolled_back" } } };
    }
    if (req.path === "/api/v1/registry/agents" && req.method === "POST") {
      return { status: 200, body: { data: { agent_key: "case-triage", status: "draft" } } };
    }
    if (req.path === "/api/v1/registry/agents/case-triage/versions" && req.method === "POST") {
      return { status: 200, body: { data: { agent_key: "case-triage", version: 4, status: "draft" } } };
    }
    if (req.path === "/api/v1/registry/retrain-watches" && req.method === "GET") {
      return { status: 200, body: { data: [WATCH_ROW] } };
    }
    if (req.path === "/api/v1/registry/retrain-watches" && req.method === "POST") {
      return { status: 200, body: { data: WATCH_ROW } };
    }
    if (req.path === "/api/v1/registry/retrain-watches/w-1" && req.method === "DELETE") {
      return { status: 200, body: { data: { id: "w-1", deleted: true } } };
    }
    return { status: 404, body: { error: { code: "NOT_FOUND", message: "x", trace_id: "t" } } };
  });
}

const ADMIN_CLAIMS = { sub: "u-1", tenant_id: "t-42", typ: "user", scopes: ["*"], workspace_id: "ws-1" };

async function run(query: string, variables: Record<string, unknown> = {}) {
  const server = makeApolloServer(cfg);
  const { fetchImpl, requests } = lifecycleRoutes();
  const ctx = await makeTestContext(fetchImpl, ADMIN_CLAIMS);
  const res = await server.executeOperation({ query, variables }, { contextValue: ctx });
  const body = res.body.kind === "single" ? res.body.singleResult : null;
  return { body, requests };
}

describe("agent rollouts (agent-runtime registry)", () => {
  it("lists rollout records with candidate-vs-baseline and forwards the filters", async () => {
    const { body, requests } = await run(
      `{ agentRollouts(agentKey: "case-triage", status: "active") { rolloutId agentKey cell mode candidateVersion baselineVersion pct status } }`,
    );
    expect(body?.errors).toBeUndefined();
    expect((body?.data as any).agentRollouts[0]).toMatchObject({
      rolloutId: "r-1", agentKey: "case-triage", cell: "dev", mode: "canary",
      candidateVersion: 3, baselineVersion: 2, pct: 10, status: "active",
    });
    const get = requests.find((r) => r.method === "GET" && r.path === "/api/v1/registry/rollouts");
    expect(get?.search.get("agent_key")).toBe("case-triage");
    expect(get?.search.get("status")).toBe("active");
  });

  it("startAgentRollout POSTs the snake_case body and returns the thin result", async () => {
    const { body, requests } = await run(
      `mutation { startAgentRollout(input: { agentKey: "case-triage", mode: "canary", candidateVersion: 3, baselineVersion: 2, pct: 10 }) { rolloutId status } }`,
    );
    expect(body?.errors).toBeUndefined();
    const post = requests.find((r) => r.method === "POST" && r.path === "/api/v1/registry/rollouts");
    expect(post?.body).toMatchObject({
      agent_key: "case-triage", mode: "canary", candidate_version: 3, baseline_version: 2, pct: 10,
    });
    expect((body?.data as any).startAgentRollout).toMatchObject({ rolloutId: "r-new", status: "active" });
  });

  it("promoteAgentRollout / rollbackAgentRollout hit the id-scoped routes", async () => {
    const promote = await run(`mutation { promoteAgentRollout(rolloutId: "r-1") { rolloutId status } }`);
    expect(promote.body?.errors).toBeUndefined();
    expect((promote.body?.data as any).promoteAgentRollout).toMatchObject({ rolloutId: "r-1", status: "promoted" });
    expect(promote.requests.some((r) => r.method === "POST" && r.path === "/api/v1/registry/rollouts/r-1/promote")).toBe(true);

    const rollback = await run(`mutation { rollbackAgentRollout(rolloutId: "r-1") { rolloutId status } }`);
    expect(rollback.body?.errors).toBeUndefined();
    expect((rollback.body?.data as any).rollbackAgentRollout).toMatchObject({ rolloutId: "r-1", status: "rolled_back" });
    expect(rollback.requests.some((r) => r.method === "POST" && r.path === "/api/v1/registry/rollouts/r-1/rollback")).toBe(true);
  });
});

describe("agent definition + version lifecycle", () => {
  it("registerAgentDefinition POSTs /registry/agents with snake_case fields", async () => {
    const { body, requests } = await run(
      `mutation { registerAgentDefinition(input: { agentKey: "case-triage", displayName: "Case Triage", description: "d", ownerTeam: "platform-ai", defaultWriteMode: "proposal" }) { agentKey status } }`,
    );
    expect(body?.errors).toBeUndefined();
    const post = requests.find((r) => r.method === "POST" && r.path === "/api/v1/registry/agents");
    expect(post?.body).toMatchObject({
      agent_key: "case-triage", display_name: "Case Triage", description: "d",
      owner_team: "platform-ai", default_write_mode: "proposal",
    });
    expect((body?.data as any).registerAgentDefinition).toMatchObject({ agentKey: "case-triage", status: "draft" });
  });

  it("createAgentVersion POSTs the immutable draft version body", async () => {
    const { body, requests } = await run(
      `mutation { createAgentVersion(agentKey: "case-triage", input: { version: 4, graphRef: "case_triage.v4", evalGateResultId: "g-9" }) { agentKey version status } }`,
    );
    expect(body?.errors).toBeUndefined();
    const post = requests.find((r) => r.method === "POST" && r.path === "/api/v1/registry/agents/case-triage/versions");
    expect(post?.body).toMatchObject({ version: 4, graph_ref: "case_triage.v4", eval_gate_result_id: "g-9" });
    expect((body?.data as any).createAgentVersion).toMatchObject({ agentKey: "case-triage", version: 4, status: "draft" });
  });
});

describe("retrain watches (BRD 52 inc3 drift thresholds)", () => {
  it("lists the caller-tenant's watches with the full view", async () => {
    const { body } = await run(
      `{ retrainWatches { id modelUrn watchedAgentKey workspaceId cadenceSeconds correctionWindowHours driftThreshold minCorrections enabled lastCheckedAt lastSignal createdBy } }`,
    );
    expect(body?.errors).toBeUndefined();
    expect((body?.data as any).retrainWatches[0]).toMatchObject({
      id: "w-1", modelUrn: "urn:dc:model:fraud-scorer:3", watchedAgentKey: "case-triage",
      workspaceId: "ws-1", cadenceSeconds: 86400, correctionWindowHours: 168,
      driftThreshold: 0.3, minCorrections: 20, enabled: true,
      lastCheckedAt: "2026-08-01T00:00:00Z", lastSignal: { ratio: 0.1 }, createdBy: "u-1",
    });
  });

  it("createRetrainWatch POSTs the snake_case body and returns the stored row", async () => {
    const { body, requests } = await run(
      `mutation { createRetrainWatch(input: { modelUrn: "urn:dc:model:fraud-scorer:3", watchedAgentKey: "case-triage", driftThreshold: 0.3, minCorrections: 20 }) { id modelUrn watchedAgentKey driftThreshold enabled } }`,
    );
    expect(body?.errors).toBeUndefined();
    const post = requests.find((r) => r.method === "POST" && r.path === "/api/v1/registry/retrain-watches");
    expect(post?.body).toMatchObject({
      model_urn: "urn:dc:model:fraud-scorer:3", watched_agent_key: "case-triage",
      drift_threshold: 0.3, min_corrections: 20,
    });
    expect((body?.data as any).createRetrainWatch).toMatchObject({
      id: "w-1", modelUrn: "urn:dc:model:fraud-scorer:3", watchedAgentKey: "case-triage",
      driftThreshold: 0.3, enabled: true,
    });
  });

  it("deleteRetrainWatch DELETEs by id and returns {id, deleted}", async () => {
    const { body, requests } = await run(
      `mutation { deleteRetrainWatch(id: "w-1") { id deleted } }`,
    );
    expect(body?.errors).toBeUndefined();
    expect((body?.data as any).deleteRetrainWatch).toMatchObject({ id: "w-1", deleted: true });
    expect(requests.some((r) => r.method === "DELETE" && r.path === "/api/v1/registry/retrain-watches/w-1")).toBe(true);
  });
});
