import { describe, it, expect } from "vitest";
import { makeApolloServer } from "../../src/server.js";
import { makeTestContext, testConfig } from "../helpers/context.js";
import { mockFetch, type CapturedRequest } from "../helpers/mockFetch.js";

const cfg = testConfig();

/**
 * BRD 73 — batch jobs (chained ingest → run). The double mirrors
 * pipeline-orchestrator's REAL payloads (app/api/schemas.py batch_job_payload /
 * batch_run_payload / batch_ingestion_payload):
 *  - the runs LIST omits `ingestions` entirely;
 *  - GET /batch-job-runs/{id} carries one `ingestions` row per binding;
 *  - run-now / retry answer 202 with the run under `data`;
 *  - delete answers 204 with no body.
 */
const JOB = {
  id: "bj-1",
  workspace_id: "ws-9",
  name: "Nightly claims",
  pipeline_template_id: "tpl-1",
  pipeline_version_id: "ver-3",
  connection_bindings: [
    { binding_key: "0", connection_id: "conn-a", dataset_urn: "wr:t-42:dataset:dataset/claims", ingestion_params: {} },
    { binding_key: "1", connection_id: "conn-b", dataset_urn: null, ingestion_params: { mode: "full" } },
  ],
  cron: "0 2 * * *",
  timezone: "UTC",
  run_parameters: { label_column: "label" },
  paused: false,
  phase_timeout_seconds: 3600,
  start_at: null,
  end_at: null,
  next_fire_at: "2026-08-06T02:00:00Z",
  last_fire_at: "2026-08-05T02:00:00Z",
  last_run_id: "bjr-1",
  created_by: "u-1",
  created_at: "2026-08-01T00:00:00Z",
  updated_at: "2026-08-05T02:00:00Z",
};

/** A run as the LIST serializes it — note: no `ingestions` key at all. */
const RUN_LIST_ROW = {
  id: "bjr-1",
  batch_job_id: "bj-1",
  batch_key: "bjr-1",
  pipeline_template_id: "tpl-1",
  pipeline_version_id: "ver-3",
  phase: "ingestion",
  status: "running",
  trigger: "schedule",
  pipeline_run_id: null,
  input_dataset_urns: [],
  output_dataset_urns: [],
  error: null,
  phase_deadline_at: "2026-08-05T03:00:00Z",
  retried_from_run_id: null,
  submitted_by: "u-1",
  via_agent: null,
  created_at: "2026-08-05T02:00:00Z",
  started_at: "2026-08-05T02:00:01Z",
  finished_at: null,
};

/** The same run as GET /batch-job-runs/{id} serializes it — WITH the timeline. */
const RUN_DETAIL = {
  ...RUN_LIST_ROW,
  phase: "pipeline",
  status: "succeeded",
  pipeline_run_id: "run-7",
  input_dataset_urns: ["wr:t-42:dataset:version/claims@v12"],
  output_dataset_urns: ["wr:t-42:dataset:dataset/claims_scored"],
  finished_at: "2026-08-05T02:20:00Z",
  ingestions: [
    {
      binding_key: "0",
      ingestion_id: "ing-1",
      status: "completed",
      dataset_urn: "wr:t-42:dataset:dataset/claims",
      iceberg_snapshot_id: "9911",
      dataset_version_urn: "wr:t-42:dataset:version/claims@v12",
      error: null,
      created_at: "2026-08-05T02:00:02Z",
      updated_at: "2026-08-05T02:10:00Z",
    },
    {
      binding_key: "1",
      ingestion_id: "ing-2",
      status: "failed",
      dataset_urn: null,
      iceberg_snapshot_id: null,
      dataset_version_urn: null,
      error: { code: "SOURCE_UNREACHABLE" },
      created_at: "2026-08-05T02:00:02Z",
      updated_at: "2026-08-05T02:05:00Z",
    },
  ],
};

function orch() {
  return mockFetch((req: CapturedRequest) => {
    if (req.path === "/api/v1/batch-jobs" && req.method === "GET") {
      return { status: 200, body: { data: [JOB], page: { next_cursor: "c2", has_more: true } } };
    }
    if (req.path === "/api/v1/batch-jobs" && req.method === "POST") {
      return {
        status: 201,
        body: {
          data: {
            ...JOB,
            id: "bj-new",
            workspace_id: req.body.workspace_id,
            name: req.body.name,
            connection_bindings: req.body.connection_bindings,
          },
        },
      };
    }
    if (req.path === "/api/v1/batch-jobs/bj-1" && req.method === "GET") {
      return { status: 200, body: { data: JOB } };
    }
    if (req.path === "/api/v1/batch-jobs/bj-1" && req.method === "PATCH") {
      return { status: 200, body: { data: { ...JOB, ...(req.body.name ? { name: req.body.name } : {}), cron: req.body.cron ?? null } } };
    }
    if (req.path === "/api/v1/batch-jobs/bj-1" && req.method === "DELETE") {
      return { status: 204, body: null };
    }
    if (req.path === "/api/v1/batch-jobs/bj-1/pause" && req.method === "POST") {
      return { status: 200, body: { data: { ...JOB, paused: true, next_fire_at: null } } };
    }
    if (req.path === "/api/v1/batch-jobs/bj-1/resume" && req.method === "POST") {
      return { status: 200, body: { data: { ...JOB, paused: false } } };
    }
    if (req.path === "/api/v1/batch-jobs/bj-1/run-now" && req.method === "POST") {
      return {
        status: 202,
        body: { data: { ...RUN_LIST_ROW, id: "bjr-9", batch_key: "bjr-9", phase: "trigger", status: "pending", trigger: "manual" } },
      };
    }
    if (req.path === "/api/v1/batch-jobs/bj-1/runs" && req.method === "GET") {
      return { status: 200, body: { data: [RUN_LIST_ROW], page: { next_cursor: null, has_more: false } } };
    }
    if (req.path === "/api/v1/batch-job-runs/bjr-1" && req.method === "GET") {
      return { status: 200, body: { data: RUN_DETAIL } };
    }
    if (req.path === "/api/v1/batch-job-runs/bjr-1/retry" && req.method === "POST") {
      // Retry resumes from the phase the run failed in — a NEW run pointing back.
      return {
        status: 202,
        body: { data: { ...RUN_LIST_ROW, id: "bjr-2", batch_key: "bjr-2", phase: "ingestion", status: "running", trigger: "retry", retried_from_run_id: "bjr-1" } },
      };
    }
    if (req.path === "/api/v1/batch-job-runs/bjr-1/terminate" && req.method === "PUT") {
      return { status: 200, body: { data: { ...RUN_LIST_ROW, status: "cancelled", finished_at: "2026-08-05T02:30:00Z" } } };
    }
    return { status: 404, body: { error: { code: "NOT_FOUND", message: "x", trace_id: "t" } } };
  });
}

const JOB_FIELDS = `
  id urn name workspaceId pipelineTemplateId pipelineVersionId connectionBindings
  cron timezone runParameters paused phaseTimeoutSeconds startAt endAt
  nextFireAt lastFireAt lastRunId createdBy createdAt updatedAt
`;

const RUN_FIELDS = `
  id urn batchJobId batchKey pipelineTemplateId pipelineVersionId phase status trigger
  pipelineRunId inputDatasetUrns outputDatasetUrns error phaseDeadlineAt
  retriedFromRunId submittedBy createdAt startedAt finishedAt
  ingestions { bindingKey ingestionId status datasetUrn icebergSnapshotId datasetVersionUrn error createdAt updatedAt }
`;

async function run(query: string, variables?: Record<string, unknown>, claims?: Record<string, unknown>) {
  const server = makeApolloServer(cfg);
  const { fetchImpl, requests } = orch();
  const ctx = await makeTestContext(
    fetchImpl,
    claims ?? { sub: "u-1", tenant_id: "t-42", typ: "user", scopes: ["*"], workspace_id: "ws-9" },
  );
  const res = await server.executeOperation({ query, variables }, { contextValue: ctx });
  const body = res.body.kind === "single" ? res.body.singleResult : null;
  return { body, requests };
}

describe("BRD 73 batch jobs — reads", () => {
  it("lists batch jobs cursor-paginated, with bindings passed through and a batch-job URN", async () => {
    const { body, requests } = await run(`{ batchJobs(first: 10) { nodes { ${JOB_FIELDS} } pageInfo { nextCursor hasMore } } }`);
    expect(body?.errors).toBeUndefined();
    const list = (body?.data as any).batchJobs;
    expect(list.pageInfo).toEqual({ nextCursor: "c2", hasMore: true });
    const j = list.nodes[0];
    expect(j.id).toBe("bj-1");
    expect(j.urn).toBe("wr:t-42:pipeline:batch-job/bj-1");
    expect(j.paused).toBe(false);
    expect(j.phaseTimeoutSeconds).toBe(3600);
    expect(j.pipelineVersionId).toBe("ver-3");
    // Bindings are V1's `connections` JSON, forwarded verbatim.
    expect(j.connectionBindings).toEqual(JOB.connection_bindings);
    const get = requests.find((r) => r.path === "/api/v1/batch-jobs" && r.method === "GET");
    expect(get?.search.get("limit")).toBe("10");
    expect(get?.headers["authorization"]).toMatch(/^Bearer /);
  });

  it("reads one batch job, and answers null (not an error) for an unknown id", async () => {
    const ok = await run(`{ batchJob(id: "bj-1") { id name cron } }`);
    expect(ok.body?.errors).toBeUndefined();
    expect((ok.body?.data as any).batchJob).toMatchObject({ id: "bj-1", name: "Nightly claims", cron: "0 2 * * *" });

    const missing = await run(`{ batchJob(id: "nope") { id } }`);
    expect(missing.body?.errors).toBeUndefined();
    expect((missing.body?.data as any).batchJob).toBeNull();
  });

  it("the runs LIST leaves `ingestions` NULL — the backend omits the key there, and null must not collapse to []", async () => {
    const { body } = await run(`{ batchJobRuns(batchJobId: "bj-1", first: 10) { nodes { ${RUN_FIELDS} } pageInfo { nextCursor hasMore } } }`);
    expect(body?.errors).toBeUndefined();
    const r = (body?.data as any).batchJobRuns.nodes[0];
    expect(r.id).toBe("bjr-1");
    expect(r.urn).toBe("wr:t-42:pipeline:batch-job-run/bjr-1");
    expect(r.phase).toBe("ingestion");
    expect(r.status).toBe("running");
    expect(r.trigger).toBe("schedule");
    expect(r.pipelineRunId).toBeNull();
    // "not loaded" — NOT "this run fired no ingestions".
    expect(r.ingestions).toBeNull();
  });

  it("the single-run read carries the per-binding phase timeline with its version pins", async () => {
    const { body } = await run(`{ batchJobRun(id: "bjr-1") { ${RUN_FIELDS} } }`);
    expect(body?.errors).toBeUndefined();
    const r = (body?.data as any).batchJobRun;
    expect(r.phase).toBe("pipeline");
    expect(r.status).toBe("succeeded");
    expect(r.pipelineRunId).toBe("run-7");
    // AC-3: the run records the exact dataset VERSION urn it was pinned to.
    expect(r.inputDatasetUrns).toEqual(["wr:t-42:dataset:version/claims@v12"]);
    expect(r.outputDatasetUrns).toEqual(["wr:t-42:dataset:dataset/claims_scored"]);
    expect(r.ingestions).toHaveLength(2);
    expect(r.ingestions[0]).toMatchObject({
      bindingKey: "0",
      ingestionId: "ing-1",
      status: "completed",
      icebergSnapshotId: "9911",
      datasetVersionUrn: "wr:t-42:dataset:version/claims@v12",
    });
    // A failed binding keeps its phase-scoped error and has no version pin.
    expect(r.ingestions[1]).toMatchObject({ bindingKey: "1", status: "failed", datasetVersionUrn: null });
    expect(r.ingestions[1].error).toEqual({ code: "SOURCE_UNREACHABLE" });
  });

  it("a downstream failure on the jobs list SURFACES as an error — never an empty list", async () => {
    const server = makeApolloServer(cfg);
    const { fetchImpl } = mockFetch(() => ({
      status: 503,
      body: { error: { code: "UNAVAILABLE", message: "orchestrator down", trace_id: "t" } },
    }));
    const ctx = await makeTestContext(fetchImpl);
    const res = await server.executeOperation({ query: `{ batchJobs(first: 10) { nodes { id } } }` }, { contextValue: ctx });
    const body = res.body.kind === "single" ? res.body.singleResult : null;
    expect(body?.errors, "a 503 must not be swallowed into an empty jobs list").toBeDefined();
    expect(body?.errors?.[0]?.extensions?.code).toBe("SERVICE_UNAVAILABLE");
    expect(body?.data?.batchJobs ?? null).toBeNull();
  });
});

describe("BRD 73 batch jobs — mutations", () => {
  it("createBatchJob sources workspace_id from the JWT and maps camel bindings to the snake body", async () => {
    const { body, requests } = await run(
      `mutation($i: CreateBatchJobInput!) { createBatchJob(input: $i) { id name workspaceId connectionBindings } }`,
      {
        i: {
          name: "Nightly claims",
          pipelineTemplateId: "tpl-1",
          pipelineVersionId: "ver-3",
          connectionBindings: [
            { connectionId: "conn-a", bindingKey: "0", datasetUrn: "wr:t-42:dataset:dataset/claims" },
            { connectionId: "conn-b", ingestionParams: { mode: "full" } },
          ],
          cron: "0 2 * * *",
          timezone: "UTC",
          phaseTimeoutSeconds: 3600,
        },
      },
    );
    expect(body?.errors).toBeUndefined();
    const post = requests.find((r) => r.path === "/api/v1/batch-jobs" && r.method === "POST");
    expect(post?.body.workspace_id).toBe("ws-9");
    expect(post?.body.pipeline_template_id).toBe("tpl-1");
    expect(post?.body.pipeline_version_id).toBe("ver-3");
    expect(post?.body.phase_timeout_seconds).toBe(3600);
    expect(post?.body.connection_bindings).toEqual([
      { connection_id: "conn-a", binding_key: "0", dataset_urn: "wr:t-42:dataset:dataset/claims", workspace_id: null, ingestion_params: {} },
      { connection_id: "conn-b", binding_key: null, dataset_urn: null, workspace_id: null, ingestion_params: { mode: "full" } },
    ]);
    expect((body?.data as any).createBatchJob.id).toBe("bj-new");
  });

  it("createBatchJob fails CLOSED when the caller's token carries no workspace", async () => {
    const { body, requests } = await run(
      `mutation($i: CreateBatchJobInput!) { createBatchJob(input: $i) { id } }`,
      { i: { name: "x", pipelineTemplateId: "tpl-1", connectionBindings: [{ connectionId: "conn-a" }] } },
      { sub: "u-1", tenant_id: "t-42", typ: "user", scopes: ["*"] },
    );
    expect(body?.errors?.[0]?.extensions?.code).toBe("VALIDATION_FAILED");
    // And nothing was sent downstream — no job misfiled under an empty workspace.
    expect(requests.filter((r) => r.method === "POST")).toHaveLength(0);
  });

  it("updateBatchJob sends ONLY the supplied keys (the backend PATCH is exclude_unset)", async () => {
    const { body, requests } = await run(
      `mutation($i: UpdateBatchJobInput!) { updateBatchJob(id: "bj-1", input: $i) { id name } }`,
      { i: { name: "Renamed" } },
    );
    expect(body?.errors).toBeUndefined();
    const patch = requests.find((r) => r.method === "PATCH");
    expect(Object.keys(patch?.body ?? {})).toEqual(["name"]);
    expect(patch?.body.name).toBe("Renamed");
  });

  it("updateBatchJob forwards an EXPLICIT null cron as a clear, not as 'leave alone'", async () => {
    const { body, requests } = await run(
      `mutation($i: UpdateBatchJobInput!) { updateBatchJob(id: "bj-1", input: $i) { id cron } }`,
      { i: { cron: null } },
    );
    expect(body?.errors).toBeUndefined();
    const patch = requests.find((r) => r.method === "PATCH");
    expect(patch?.body).toEqual({ cron: null });
    expect((body?.data as any).updateBatchJob.cron).toBeNull();
  });

  it("pause / resume flip `paused` and clear the next fire", async () => {
    const paused = await run(`mutation { pauseBatchJob(id: "bj-1") { id paused nextFireAt } }`);
    expect(paused.body?.errors).toBeUndefined();
    expect((paused.body?.data as any).pauseBatchJob).toMatchObject({ paused: true, nextFireAt: null });

    const resumed = await run(`mutation { resumeBatchJob(id: "bj-1") { id paused } }`);
    expect((resumed.body?.data as any).resumeBatchJob.paused).toBe(false);
  });

  it("runBatchJobNow returns the newly created RUN in the trigger phase", async () => {
    const { body } = await run(`mutation { runBatchJobNow(id: "bj-1") { id phase status trigger ingestions { bindingKey } } }`);
    expect(body?.errors).toBeUndefined();
    expect((body?.data as any).runBatchJobNow).toMatchObject({
      id: "bjr-9", phase: "trigger", status: "pending", trigger: "manual", ingestions: null,
    });
  });

  it("retryBatchJobRun returns the NEW run resuming at the failed phase, pointing back at the original", async () => {
    const { body } = await run(`mutation { retryBatchJobRun(id: "bjr-1") { id phase status trigger retriedFromRunId } }`);
    expect(body?.errors).toBeUndefined();
    // Resumes at `ingestion`, NOT at `trigger` — re-running trigger would double-ingest (AC-6).
    expect((body?.data as any).retryBatchJobRun).toMatchObject({
      id: "bjr-2", phase: "ingestion", trigger: "retry", retriedFromRunId: "bjr-1",
    });
  });

  it("terminateBatchJobRun cancels an active run", async () => {
    const { body } = await run(`mutation { terminateBatchJobRun(id: "bjr-1") { id status finishedAt } }`);
    expect(body?.errors).toBeUndefined();
    expect((body?.data as any).terminateBatchJobRun.status).toBe("cancelled");
  });

  it("deleteBatchJob DELETEs and answers true on the 204", async () => {
    const { body, requests } = await run(`mutation { deleteBatchJob(id: "bj-1") }`);
    expect(body?.errors).toBeUndefined();
    expect((body?.data as any).deleteBatchJob).toBe(true);
    expect(requests.some((r) => r.method === "DELETE" && r.path === "/api/v1/batch-jobs/bj-1")).toBe(true);
  });
});
