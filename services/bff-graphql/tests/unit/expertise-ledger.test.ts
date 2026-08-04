/**
 * Expertise Ledger (agent-runtime GET /expertise-ledger). The tenant-facing
 * rollup that proves the platform is learning from THIS tenant's own
 * decisions. The downstream route is authN-only (verified bearer JWT, tenant
 * RLS) — the BFF forwards the JWT and adds no authz of its own (mirrors
 * learningLoop). These tests drive the real Apollo server + resolver + mapper
 * fan-out through the mocked HTTP layer, asserting the snake->camel mapping
 * and — critically — that a null agreementRate is PRESERVED, never coerced to
 * 0, and that by_status.edited_approved maps to byStatus.editedApproved.
 */
import { describe, it, expect } from "vitest";
import { makeApolloServer } from "../../src/server.js";
import { makeTestContext, testConfig } from "../helpers/context.js";
import { mockFetch, type CapturedRequest, type Handler } from "../helpers/mockFetch.js";

const cfg = testConfig();
const CLAIMS = { sub: "u-1", tenant_id: "t-42", typ: "user", scopes: ["*"], workspace_id: "ws-1" };

async function run(handler: Handler, query: string, variables: Record<string, unknown> = {}) {
  const server = makeApolloServer(cfg);
  const { fetchImpl, requests } = mockFetch(handler);
  const ctx = await makeTestContext(fetchImpl, CLAIMS);
  const res = await server.executeOperation({ query, variables }, { contextValue: ctx });
  const body = res.body.kind === "single" ? res.body.singleResult : null;
  return { body, requests };
}

/** The full envelope from the task spec — a populated, "healthy" ledger. */
const LEDGER = {
  decisions: {
    window_days: 90,
    captured_in_window: 6,
    captured_all_time: 6,
    corrections_in_window: 3,
    by_status: {
      pending: 1, approved: 3, rejected: 1, edited_approved: 2,
      expired: 0, superseded: 0, cancelled: 0,
    },
  },
  agreement: {
    labeled_decisions: 12,
    agreement_rate: 0.91,
    scored: 44,
    by_decision_type: [
      { key: "case.apply_disposition", total: 44, correct: 40, incorrect: 4, unknown: 0, effectiveness_rate: 0.9 },
    ],
  },
  corpus: {
    dataset_versions: 2,
    example_rows: 100,
    consent_verified_versions: 2,
    latest: {
      dataset_id: "ds-9", agent_key: "case-triage", version: 2, row_count: 60,
      checksum: "sha256:abc", created_at: "2026-07-30T00:00:00Z",
    },
  },
  owned_model: {
    has_owned_model: false,
    adapter_count: 0,
    promoted: null,
    latest_training: {
      job_id: "job-1", archetype: "case-triage",
      base_model: "meta-llama/Llama-3.2-3B-Instruct", status: "failed",
      error: { reason: "gpu_trainer_not_configured" },
    },
  },
};

/** The "cold start" envelope: nothing comparable scored yet (agreement_rate
 * null), empty corpus, no owned model, no training. Nulls must survive. */
const LEDGER_EMPTY = {
  decisions: {
    window_days: 30,
    captured_in_window: 0,
    captured_all_time: 0,
    corrections_in_window: 0,
    by_status: {
      pending: 0, approved: 0, rejected: 0, edited_approved: 0,
      expired: 0, superseded: 0, cancelled: 0,
    },
  },
  agreement: {
    labeled_decisions: 0,
    agreement_rate: null, // nothing comparable yet — MUST NOT become 0
    scored: 0,
    by_decision_type: [
      { key: "case.apply_disposition", total: 0, correct: 0, incorrect: 0, unknown: 0, effectiveness_rate: null },
    ],
  },
  corpus: {
    dataset_versions: 0,
    example_rows: 0,
    consent_verified_versions: 0,
    latest: null,
  },
  owned_model: {
    has_owned_model: false,
    adapter_count: 0,
    promoted: null,
    latest_training: null,
  },
};

function handlerFor(payload: unknown): Handler {
  return (req: CapturedRequest) => {
    if (req.path === "/api/v1/expertise-ledger" && req.method === "GET") {
      return { body: { data: payload } };
    }
    return { status: 404, body: { error: { code: "NOT_FOUND", message: "x", trace_id: "t" } } };
  };
}

const FULL_QUERY = /* GraphQL */ `
  query ($w: Int) {
    expertiseLedger(windowDays: $w) {
      decisions {
        windowDays capturedInWindow capturedAllTime correctionsInWindow
        byStatus { pending approved rejected editedApproved expired superseded cancelled }
      }
      agreement {
        labeledDecisions agreementRate scored
        byDecisionType { key total correct incorrect unknown effectivenessRate }
      }
      corpus {
        datasetVersions exampleRows consentVerifiedVersions
        latest { datasetId agentKey version rowCount checksum createdAt }
      }
      ownedModel {
        hasOwnedModel adapterCount
        promoted { adapterId archetype baseModel checksum modelAlias }
        latestTraining { jobId archetype baseModel status error }
      }
    }
  }
`;

describe("expertiseLedger — snake->camel fan-out over agent-runtime", () => {
  it("maps the full populated envelope camelCase, verbatim", async () => {
    const { body, requests } = await run(handlerFor(LEDGER), FULL_QUERY, { w: 90 });
    expect(body?.errors).toBeUndefined();
    const led = (body?.data as any).expertiseLedger;

    expect(led.decisions).toEqual({
      windowDays: 90,
      capturedInWindow: 6,
      capturedAllTime: 6,
      correctionsInWindow: 3,
      byStatus: {
        pending: 1, approved: 3, rejected: 1, editedApproved: 2,
        expired: 0, superseded: 0, cancelled: 0,
      },
    });
    // by_status.edited_approved -> byStatus.editedApproved specifically.
    expect(led.decisions.byStatus.editedApproved).toBe(2);

    expect(led.agreement).toEqual({
      labeledDecisions: 12,
      agreementRate: 0.91,
      scored: 44,
      byDecisionType: [
        { key: "case.apply_disposition", total: 44, correct: 40, incorrect: 4, unknown: 0, effectivenessRate: 0.9 },
      ],
    });

    expect(led.corpus).toEqual({
      datasetVersions: 2,
      exampleRows: 100,
      consentVerifiedVersions: 2,
      latest: {
        datasetId: "ds-9", agentKey: "case-triage", version: 2, rowCount: 60,
        checksum: "sha256:abc", createdAt: "2026-07-30T00:00:00Z",
      },
    });

    expect(led.ownedModel).toEqual({
      hasOwnedModel: false,
      adapterCount: 0,
      promoted: null,
      // The honest failure reason passes through VERBATIM as JSON.
      latestTraining: {
        jobId: "job-1", archetype: "case-triage",
        baseModel: "meta-llama/Llama-3.2-3B-Instruct", status: "failed",
        error: { reason: "gpu_trainer_not_configured" },
      },
    });

    // window_days is forwarded to agent-runtime.
    const req = requests.find((r) => r.path === "/api/v1/expertise-ledger");
    expect(req?.search.get("window_days")).toBe("90");
  });

  it("preserves a null agreementRate (nothing comparable) — NEVER coerces to 0", async () => {
    const { body } = await run(handlerFor(LEDGER_EMPTY), FULL_QUERY, { w: 30 });
    expect(body?.errors).toBeUndefined();
    const led = (body?.data as any).expertiseLedger;

    expect(led.agreement.agreementRate).toBeNull();
    expect(led.agreement.agreementRate).not.toBe(0);
    // Per-group effectiveness null also survives.
    expect(led.agreement.byDecisionType[0].effectivenessRate).toBeNull();
    // Optional nested objects null through, not fabricated.
    expect(led.corpus.latest).toBeNull();
    expect(led.ownedModel.promoted).toBeNull();
    expect(led.ownedModel.latestTraining).toBeNull();
    expect(led.decisions.byStatus.editedApproved).toBe(0);
  });

  it("defaults windowDays to 90 when the client omits it", async () => {
    const { body, requests } = await run(
      handlerFor(LEDGER),
      /* GraphQL */ `query { expertiseLedger { decisions { windowDays } } }`,
    );
    expect(body?.errors).toBeUndefined();
    // The schema default (90) is applied and forwarded downstream.
    const req = requests.find((r) => r.path === "/api/v1/expertise-ledger");
    expect(req?.search.get("window_days")).toBe("90");
  });
});
