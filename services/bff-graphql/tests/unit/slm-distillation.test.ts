/**
 * BRD 14 §6.5: SLM distillation cockpit (agent-runtime M1-M4). Response shapes
 * mirror the real downstream route bodies — see services/agent-runtime/app/api/
 * routes/transcripts.py (_view), sft.py (_ds_view + NDJSON examples export) and
 * training.py (_job_view/_adapter_view). The routes are authN-only downstream
 * (verified bearer JWT, tenant RLS) — the BFF forwards the JWT and adds no
 * authz of its own.
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

const DATASET = {
  dataset_id: "ds-1", agent_key: "case-triage", version: 3, status: "ready",
  row_count: 42, source_count: 40,
  curation_params: { min_decisions: 1 }, checksum: "sha256:abc",
  consent_verified: true, created_by: "u-1", created_at: "2026-07-30T00:00:00Z",
};

const JOB_FAILED = {
  job_id: "job-1", archetype: "case-triage", sft_dataset_id: "ds-1",
  base_model: "meta-llama/Llama-3.2-3B-Instruct", status: "failed", params: {},
  mlflow_run_ref: null, adapter_id: null,
  error: { reason: "gpu_trainer_not_configured", detail: "no GPU trainer backend is wired" },
  created_by: "u-1", created_at: "2026-07-31T00:00:00Z", finished_at: "2026-07-31T00:00:05Z",
};

const ADAPTER = {
  adapter_id: "ad-1", training_job_id: "job-2", archetype: "case-triage",
  base_model: "meta-llama/Llama-3.2-3B-Instruct", adapter_uri: "s3://adapters/ad-1",
  checksum: "sha256:def", model_alias: "slm-case-triage", promotion_status: "candidate",
  eval_result_ref: null, target_rung_alias: null, created_at: "2026-08-01T00:00:00Z",
};

const NDJSON =
  JSON.stringify({ messages: [{ role: "user", content: "triage this" }, { role: "assistant", content: "corrected gold answer" }] }) +
  "\n" +
  JSON.stringify({ messages: [{ role: "user", content: "and this" }, { role: "assistant", content: "second gold" }] }) +
  "\n";

function baseHandler(overrides: Partial<Record<string, Handler>> = {}): Handler {
  return (req: CapturedRequest) => {
    for (const o of Object.values(overrides)) {
      const r = o?.(req);
      if (r) return r as any;
    }
    if (req.path === "/api/v1/sft-datasets" && req.method === "GET") {
      return { body: { data: [DATASET], page: { next_cursor: null, has_more: false } } };
    }
    if (req.path === "/api/v1/sft-datasets" && req.method === "POST") {
      return { status: 201, body: { data: { ...DATASET, dataset_id: "ds-2", version: 4 } } };
    }
    if (req.path === "/api/v1/sft-datasets/ds-1" && req.method === "GET") {
      return { body: { data: DATASET } };
    }
    if (req.path === "/api/v1/sft-datasets/ds-1/examples" && req.method === "GET") {
      return { text: NDJSON, headers: { "content-type": "application/x-ndjson" } };
    }
    if (req.path === "/api/v1/transcripts/tr-1" && req.method === "GET") {
      return {
        body: {
          data: {
            transcript_id: "tr-1", run_id: "run-9", session_id: "s-1",
            agent_key: "case-triage", agent_version: 2, principal_type: "user",
            obo_sub: null, inputs: { case_id: "c-1" }, grounding: [],
            final_text: "model answer", proposed_action: null, proposal_id: "p-1",
            model: "gpt-x", usage: { input_tokens: 10 }, consent: { training: true },
            decision: "edited", corrected_output: { text: "human-fixed answer" },
            decided_by: "u-2", decided_at: "2026-07-29T00:00:00Z",
            created_at: "2026-07-28T00:00:00Z",
          },
        },
      };
    }
    if (req.path === "/api/v1/training-jobs" && req.method === "GET") {
      return { body: { data: [JOB_FAILED], page: { next_cursor: null, has_more: false } } };
    }
    if (req.path === "/api/v1/training-jobs" && req.method === "POST") {
      return { status: 201, body: { data: JOB_FAILED } };
    }
    if (req.path === "/api/v1/training-jobs/job-1" && req.method === "GET") {
      return { body: { data: JOB_FAILED } };
    }
    if (req.path === "/api/v1/slm-adapters" && req.method === "GET") {
      return { body: { data: [ADAPTER], page: { next_cursor: null, has_more: false } } };
    }
    if (req.path === "/api/v1/slm-adapters/ad-1" && req.method === "GET") {
      return { body: { data: ADAPTER } };
    }
    if (req.path === "/api/v1/slm-adapters/ad-1/promote" && req.method === "POST") {
      return {
        body: {
          data: {
            ...ADAPTER, promotion_status: "promoted",
            eval_result_ref: "gate-7", target_rung_alias: "slm-case-triage",
          },
        },
      };
    }
    if (req.path === "/api/v1/slm-adapters/ad-1/demote" && req.method === "POST") {
      return { body: { data: { ...ADAPTER, promotion_status: "demoted" } } };
    }
    return { status: 404, body: { error: { code: "NOT_FOUND", message: "x", trace_id: "t" } } };
  };
}

describe("sftDatasets / sftDataset / sftDatasetExamples (M2)", () => {
  it("lists + reads a dataset with the full _ds_view shape", async () => {
    const { body, requests } = await run(
      baseHandler(),
      /* GraphQL */ `
        query {
          sftDatasets(agentKey: "case-triage") { datasetId agentKey version rowCount consentVerified checksum }
          sftDataset(id: "ds-1") { datasetId version status curationParams createdBy }
        }
      `,
    );
    expect(body?.errors).toBeUndefined();
    const data = body?.data as any;
    expect(data.sftDatasets).toEqual([
      { datasetId: "ds-1", agentKey: "case-triage", version: 3, rowCount: 42, consentVerified: true, checksum: "sha256:abc" },
    ]);
    expect(data.sftDataset).toMatchObject({
      datasetId: "ds-1", version: 3, status: "ready",
      curationParams: { min_decisions: 1 }, createdBy: "u-1",
    });
    // filter[agent_key] is forwarded verbatim.
    const list = requests.find((r) => r.path === "/api/v1/sft-datasets" && r.method === "GET");
    expect(list?.search.get("filter[agent_key]")).toBe("case-triage");
  });

  it("parses the NDJSON examples export line-wise into gold chat rows", async () => {
    const { body, requests } = await run(
      baseHandler(),
      /* GraphQL */ `query { sftDatasetExamples(id: "ds-1", limit: 2) { messages } }`,
    );
    expect(body?.errors).toBeUndefined();
    const rows = (body?.data as any).sftDatasetExamples as any[];
    expect(rows).toHaveLength(2);
    expect(rows[0].messages).toEqual([
      { role: "user", content: "triage this" },
      { role: "assistant", content: "corrected gold answer" },
    ]);
    const req = requests.find((r) => r.path === "/api/v1/sft-datasets/ds-1/examples");
    expect(req?.search.get("limit")).toBe("2");
  });

  it("createSftDataset posts {agent_key, params} and returns the new version", async () => {
    const { body, requests } = await run(
      baseHandler(),
      /* GraphQL */ `
        mutation {
          createSftDataset(input: { agentKey: "case-triage", params: { only_decided: true } }, idempotencyKey: "ik-1") {
            datasetId version
          }
        }
      `,
    );
    expect(body?.errors).toBeUndefined();
    expect((body?.data as any).createSftDataset).toEqual({ datasetId: "ds-2", version: 4 });
    const post = requests.find((r) => r.path === "/api/v1/sft-datasets" && r.method === "POST");
    expect(post?.body).toEqual({ agent_key: "case-triage", params: { only_decided: true } });
    expect(post?.headers["idempotency-key"]).toBe("ik-1");
  });
});

describe("transcript detail (M1)", () => {
  it("returns the full corrected-output row verbatim", async () => {
    const { body } = await run(
      baseHandler(),
      /* GraphQL */ `
        query {
          transcript(id: "tr-1") {
            transcriptId agentKey agentVersion decision correctedOutput finalText decidedBy consent
          }
        }
      `,
    );
    expect(body?.errors).toBeUndefined();
    expect((body?.data as any).transcript).toEqual({
      transcriptId: "tr-1", agentKey: "case-triage", agentVersion: "2",
      decision: "edited", correctedOutput: { text: "human-fixed answer" },
      finalText: "model answer", decidedBy: "u-2", consent: { training: true },
    });
  });

  it("a 404 (incl. cross-tenant masking) resolves to null, not an error", async () => {
    const { body } = await run(
      baseHandler(),
      /* GraphQL */ `query { transcript(id: "tr-nope") { transcriptId } }`,
    );
    expect(body?.errors).toBeUndefined();
    expect((body?.data as any).transcript).toBeNull();
  });
});

describe("training jobs (M3) — the honest failure reason", () => {
  it("submitTrainingJob returns the FAILED job with error.reason gpu_trainer_not_configured VERBATIM", async () => {
    const { body, requests } = await run(
      baseHandler(),
      /* GraphQL */ `
        mutation {
          submitTrainingJob(input: {
            agentKey: "case-triage", sftDatasetId: "ds-1",
            baseModel: "meta-llama/Llama-3.2-3B-Instruct"
          }) { jobId status error adapterId }
        }
      `,
    );
    expect(body?.errors).toBeUndefined();
    const job = (body?.data as any).submitTrainingJob;
    expect(job.status).toBe("failed");
    // The reason passes through untouched — never softened or reworded.
    expect(job.error).toEqual({
      reason: "gpu_trainer_not_configured",
      detail: "no GPU trainer backend is wired",
    });
    expect(job.adapterId).toBeNull(); // no fabricated adapter on failure
    const post = requests.find((r) => r.path === "/api/v1/training-jobs" && r.method === "POST");
    expect(post?.body).toEqual({
      agent_key: "case-triage", sft_dataset_id: "ds-1",
      base_model: "meta-llama/Llama-3.2-3B-Instruct",
    });
  });

  it("trainingJobs list + trainingJob detail carry the verbatim error too", async () => {
    const { body } = await run(
      baseHandler(),
      /* GraphQL */ `
        query {
          trainingJobs { jobId status }
          trainingJob(id: "job-1") { jobId sftDatasetId baseModel error finishedAt }
        }
      `,
    );
    expect(body?.errors).toBeUndefined();
    const data = body?.data as any;
    expect(data.trainingJobs).toEqual([{ jobId: "job-1", status: "failed" }]);
    expect(data.trainingJob).toMatchObject({
      jobId: "job-1", sftDatasetId: "ds-1",
      baseModel: "meta-llama/Llama-3.2-3B-Instruct",
      error: { reason: "gpu_trainer_not_configured", detail: "no GPU trainer backend is wired" },
    });
  });
});

describe("slm adapters (M4) — eval-gated promotion + rollback", () => {
  it("lists + reads adapters and promotes with the eval-gate evidence recorded", async () => {
    const { body, requests } = await run(
      baseHandler(),
      /* GraphQL */ `
        mutation {
          promoteSlmAdapter(id: "ad-1", evalResultRef: "gate-7") {
            adapterId promotionStatus evalResultRef targetRungAlias
          }
        }
      `,
    );
    expect(body?.errors).toBeUndefined();
    expect((body?.data as any).promoteSlmAdapter).toEqual({
      adapterId: "ad-1", promotionStatus: "promoted",
      evalResultRef: "gate-7", targetRungAlias: "slm-case-triage",
    });
    const post = requests.find((r) => r.path === "/api/v1/slm-adapters/ad-1/promote");
    expect(post?.body).toEqual({ eval_result_ref: "gate-7" });
  });

  it("demoteSlmAdapter rolls back; a downstream 409 (not promotable) surfaces as an error", async () => {
    const ok = await run(
      baseHandler(),
      /* GraphQL */ `mutation { demoteSlmAdapter(id: "ad-1") { adapterId promotionStatus } }`,
    );
    expect(ok.body?.errors).toBeUndefined();
    expect((ok.body?.data as any).demoteSlmAdapter).toEqual({ adapterId: "ad-1", promotionStatus: "demoted" });

    const conflict = await run(
      baseHandler({
        promote: (req) =>
          req.path === "/api/v1/slm-adapters/ad-1/promote"
            ? { status: 409, body: { error: { code: "CONFLICT", message: "adapter is demoted, not promotable", trace_id: "t" } } }
            : (undefined as any),
      }),
      /* GraphQL */ `mutation { promoteSlmAdapter(id: "ad-1") { adapterId } }`,
    );
    expect(conflict.body?.errors?.[0]?.message).toContain("adapter is demoted, not promotable");
  });

  it("adapter queries return the _adapter_view shape", async () => {
    const { body } = await run(
      baseHandler(),
      /* GraphQL */ `
        query {
          slmAdapters(archetype: "case-triage") { adapterId promotionStatus modelAlias }
          slmAdapter(id: "ad-1") { adapterId trainingJobId adapterUri baseModel }
        }
      `,
    );
    expect(body?.errors).toBeUndefined();
    const data = body?.data as any;
    expect(data.slmAdapters).toEqual([
      { adapterId: "ad-1", promotionStatus: "candidate", modelAlias: "slm-case-triage" },
    ]);
    expect(data.slmAdapter).toMatchObject({
      adapterId: "ad-1", trainingJobId: "job-2", adapterUri: "s3://adapters/ad-1",
    });
  });
});
