import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "@/test/utils";
import { GraphQLRequestError } from "@/lib/graphql/client";

/** Route graphqlRequest by operation name to a per-test handler. A handler may
 * throw a real GraphQLRequestError so the failure surfaces exactly as a live
 * downstream error would (AsyncBoundary reads its code/message/traceId). */
let handler: (doc: string, vars: any) => any = () => ({});
const requests: { doc: string; vars: any }[] = [];
vi.mock("@/lib/graphql/client", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/graphql/client")>();
  return {
    ...actual,
    graphqlRequest: (doc: string, vars: any) => {
      requests.push({ doc, vars });
      try {
        return Promise.resolve(handler(doc, vars));
      } catch (e) {
        return Promise.reject(e);
      }
    },
  };
});

/** A downstream failure as the BFF really reports it. */
function downstream(message: string, code = "SERVICE_UNAVAILABLE"): never {
  throw new GraphQLRequestError([{ message, extensions: { code, traceId: "trace-1" } }], 503);
}

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }), usePathname: () => "/data/pipelines/batch-jobs" }));

import BatchJobsPage from "./page";

const meResult = {
  me: { userId: "u", tenantId: "t-42", type: "user", scopes: [], roles: ["Admin"], capabilities: ["*"], capsDegraded: false },
};

const JOBS = {
  batchJobs: {
    nodes: [
      {
        id: "bj-1", urn: "wr:t-42:pipeline:batch-job/bj-1", name: "Nightly claims", workspaceId: "ws-1",
        pipelineTemplateId: "tpl-1", pipelineVersionId: "ver-3",
        connectionBindings: [{ binding_key: "0", connection_id: "conn-a" }, { binding_key: "1", connection_id: "conn-b" }],
        cron: "0 2 * * *", timezone: "UTC", runParameters: {}, paused: false, phaseTimeoutSeconds: 3600,
        startAt: null, endAt: null, nextFireAt: "2026-08-06T02:00:00Z", lastFireAt: "2026-08-05T02:00:00Z",
        lastRunId: "bjr-1", createdBy: "u-1", createdAt: "2026-08-01T00:00:00Z", updatedAt: "2026-08-05T02:00:00Z",
      },
      {
        id: "bj-2", urn: "wr:t-42:pipeline:batch-job/bj-2", name: "Weekly AML", workspaceId: "ws-1",
        pipelineTemplateId: "tpl-2", pipelineVersionId: null, connectionBindings: [{ binding_key: "0", connection_id: "conn-c" }],
        cron: null, timezone: "UTC", runParameters: {}, paused: true, phaseTimeoutSeconds: null,
        startAt: null, endAt: null, nextFireAt: null, lastFireAt: null, lastRunId: null,
        createdBy: "u-1", createdAt: "2026-08-01T00:00:00Z", updatedAt: "2026-08-01T00:00:00Z",
      },
    ],
    pageInfo: { nextCursor: null, hasMore: false },
  },
};

/** A run as the LIST serializes it — the backend omits `ingestions` there. */
const RUN_ROW = {
  id: "bjr-1", urn: "wr:t-42:pipeline:batch-job-run/bjr-1", batchJobId: "bj-1", batchKey: "bjr-1",
  pipelineTemplateId: "tpl-1", pipelineVersionId: "ver-3",
  phase: "ingestion", status: "failed", trigger: "schedule", pipelineRunId: null,
  inputDatasetUrns: [], outputDatasetUrns: [],
  error: { code: "BATCH_INGESTION_FAILED", phase: "ingestion" },
  phaseDeadlineAt: "2026-08-05T03:00:00Z", retriedFromRunId: null, submittedBy: "u-1",
  createdAt: "2026-08-05T02:00:00Z", startedAt: "2026-08-05T02:00:01Z", finishedAt: "2026-08-05T02:05:00Z",
};

const RUNS = { batchJobRuns: { nodes: [RUN_ROW], pageInfo: { nextCursor: null, hasMore: false } } };

/** The same run as the single-run read serializes it — WITH the timeline. */
const RUN_DETAIL = {
  batchJobRun: {
    ...RUN_ROW,
    inputDatasetUrns: ["wr:t-42:dataset:version/claims@v12"],
    outputDatasetUrns: [],
    ingestions: [
      {
        bindingKey: "0", ingestionId: "ing-1", status: "completed",
        datasetUrn: "wr:t-42:dataset:dataset/claims", icebergSnapshotId: "9911",
        datasetVersionUrn: "wr:t-42:dataset:version/claims@v12", error: null,
        createdAt: "2026-08-05T02:00:02Z", updatedAt: "2026-08-05T02:03:00Z",
      },
      {
        bindingKey: "1", ingestionId: "ing-2", status: "failed",
        datasetUrn: null, icebergSnapshotId: null, datasetVersionUrn: null,
        error: { code: "SOURCE_UNREACHABLE" },
        createdAt: "2026-08-05T02:00:02Z", updatedAt: "2026-08-05T02:04:00Z",
      },
    ],
  },
};

const TEMPLATES = {
  pipelineTemplates: {
    nodes: [
      { id: "tpl-1", urn: "wr:t-42:pipeline:template/tpl-1", name: "Claims scoring", pipelineType: "inference",
        activeVersionId: "ver-3", validationStatus: "valid", isSystem: false, archived: false,
        createdBy: null, createdAt: "2026-07-10T00:00:00Z", updatedAt: "2026-07-10T00:00:00Z" },
    ],
    pageInfo: { nextCursor: null, hasMore: false },
  },
};

const CONNECTIONS = {
  connections: {
    nodes: [{ id: "conn-a", urn: "wr:t-42:ingestion:connection/conn-a", name: "Claims SFTP", connectorType: "sftp" }],
    pageInfo: { nextCursor: null, hasMore: false },
  },
};

/** Default handler: everything resolves. Tests override per case. */
function defaultHandler(doc: string): any {
  if (doc.includes("query Me")) return meResult;
  if (doc.includes("query BatchJobRuns")) return RUNS;
  if (doc.includes("query BatchJobRun(")) return RUN_DETAIL;
  if (doc.includes("query BatchJobs")) return JOBS;
  if (doc.includes("query PipelineTemplates")) return TEMPLATES;
  if (doc.includes("query Connections")) return CONNECTIONS;
  return {};
}

beforeEach(() => {
  requests.length = 0;
  handler = defaultHandler;
});

describe("Batch jobs page — jobs list", () => {
  // DataTable is windowed (useVirtualizer) and jsdom has no layout, so row
  // CONTENT never materializes — the repo convention is to assert on the grid's
  // logical aria-rowcount and on request variables instead of row text.
  it("lists the tenant's real batch jobs in the grid", async () => {
    renderWithProviders(<BatchJobsPage />);
    await waitFor(() => {
      expect(screen.getByRole("grid", { name: "Batch jobs" })).toHaveAttribute("aria-rowcount", "2");
    });
    expect(requests.some((r) => r.doc.includes("query BatchJobs"))).toBe(true);
  });

  it("renders the EMPTY state — not an error — when the tenant has no batch jobs", async () => {
    handler = (doc) =>
      doc.includes("query BatchJobs") ? { batchJobs: { nodes: [], pageInfo: { nextCursor: null, hasMore: false } } } : defaultHandler(doc);
    renderWithProviders(<BatchJobsPage />);
    expect(await screen.findByText("No batch jobs yet")).toBeInTheDocument();
    // The two states must not be confusable: no error panel here.
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("renders an ERROR state — not an empty list — when the batch jobs query FAILS", async () => {
    handler = (doc) => {
      if (doc.includes("query BatchJobs")) downstream("orchestrator down");
      return defaultHandler(doc);
    };
    renderWithProviders(<BatchJobsPage />);
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText(/orchestrator down/i)).toBeInTheDocument();
    // A failed load must NEVER masquerade as "you have no batch jobs".
    expect(screen.queryByText("No batch jobs yet")).toBeNull();
    expect(screen.queryByRole("grid", { name: "Batch jobs" })).toBeNull();
  });
});

describe("Batch jobs page — runs and the phase timeline", () => {
  it("shows a picked job's runs and fetches them scoped to that job", async () => {
    const user = userEvent.setup();
    renderWithProviders(<BatchJobsPage />);
    await user.selectOptions(await screen.findByLabelText("Batch job"), "bj-1");

    expect(await screen.findByTestId("batch-run-bjr-1")).toBeInTheDocument();
    const call = requests.find((r) => r.doc.includes("query BatchJobRuns"));
    expect(call?.vars?.batchJobId).toBe("bj-1");
  });

  it("renders the trigger → ingestion → pipeline timeline with each phase's state and the per-binding outcomes", async () => {
    const user = userEvent.setup();
    renderWithProviders(<BatchJobsPage />);
    await user.selectOptions(await screen.findByLabelText("Batch job"), "bj-1");

    const runRow = await screen.findByTestId("batch-run-bjr-1");
    await user.click(within(runRow).getByRole("button", { expanded: false }));

    const timeline = await screen.findByTestId("batch-run-timeline");
    // The run failed IN `ingestion`: trigger cleared, ingestion failed, and the
    // pipeline phase was never reached — that ordering is the whole point of the
    // aggregate, so it is asserted phase by phase.
    expect(within(screen.getByTestId("batch-phase-trigger")).getByText("succeeded")).toBeInTheDocument();
    expect(within(screen.getByTestId("batch-phase-ingestion")).getByText("failed")).toBeInTheDocument();
    expect(within(screen.getByTestId("batch-phase-pipeline")).getByText("not reached")).toBeInTheDocument();

    // Per-binding ingestion outcomes: one landed with its version pin, one failed.
    const landed = within(timeline).getByTestId("batch-binding-0");
    expect(within(landed).getByText("completed")).toBeInTheDocument();
    expect(within(landed).getByText("wr:t-42:dataset:version/claims@v12")).toBeInTheDocument();
    expect(within(landed).getByText("9911")).toBeInTheDocument();
    const broken = within(timeline).getByTestId("batch-binding-1");
    expect(within(broken).getByText("failed")).toBeInTheDocument();
    expect(within(broken).getByText(/SOURCE_UNREACHABLE/)).toBeInTheDocument();

    // The dataset URNs the run recorded.
    expect(
      within(screen.getByTestId("batch-run-inputs")).getByText("wr:t-42:dataset:version/claims@v12"),
    ).toBeInTheDocument();
    expect(within(screen.getByTestId("batch-run-outputs")).getByText("None recorded.")).toBeInTheDocument();

    // The phase-scoped failure the backend recorded on the run itself.
    expect(within(screen.getByTestId("batch-run-error")).getByText(/BATCH_INGESTION_FAILED/)).toBeInTheDocument();

    // The timeline comes from the SINGLE-run read; the list query cannot serve it.
    expect(requests.some((r) => r.doc.includes("query BatchJobRun(") && r.vars?.id === "bjr-1")).toBe(true);
  });

  it("surfaces an ERROR — not an empty timeline — when the single-run read FAILS", async () => {
    const user = userEvent.setup();
    handler = (doc) => {
      if (doc.includes("query BatchJobRun(")) downstream("run detail unavailable");
      return defaultHandler(doc);
    };
    renderWithProviders(<BatchJobsPage />);
    await user.selectOptions(await screen.findByLabelText("Batch job"), "bj-1");
    const runRow = await screen.findByTestId("batch-run-bjr-1");
    await user.click(within(runRow).getByRole("button", { expanded: false }));

    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText(/run detail unavailable/i)).toBeInTheDocument();
    // No half-rendered timeline claiming the run has no phases or bindings.
    expect(screen.queryByTestId("batch-run-timeline")).toBeNull();
  });

  it("distinguishes 'this job has never run' from 'we could not load its runs'", async () => {
    const user = userEvent.setup();
    handler = (doc) =>
      doc.includes("query BatchJobRuns")
        ? { batchJobRuns: { nodes: [], pageInfo: { nextCursor: null, hasMore: false } } }
        : defaultHandler(doc);
    const empty = renderWithProviders(<BatchJobsPage />);
    await user.selectOptions(await screen.findByLabelText("Batch job"), "bj-1");
    expect(await screen.findByText("This batch job has not run yet")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
    empty.unmount();

    requests.length = 0;
    handler = (doc) => {
      if (doc.includes("query BatchJobRuns")) downstream("runs unavailable");
      return defaultHandler(doc);
    };
    renderWithProviders(<BatchJobsPage />);
    await user.selectOptions(await screen.findByLabelText("Batch job"), "bj-1");
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText(/runs unavailable/i)).toBeInTheDocument();
    expect(screen.queryByText("This batch job has not run yet")).toBeNull();
  });

  it("retries a FAILED run through the real mutation (retry resumes from the failed phase server-side)", async () => {
    const user = userEvent.setup();
    handler = (doc) =>
      doc.includes("mutation RetryBatchJobRun")
        ? { retryBatchJobRun: { ...RUN_ROW, id: "bjr-2", batchKey: "bjr-2", status: "running", trigger: "retry", retriedFromRunId: "bjr-1" } }
        : defaultHandler(doc);
    renderWithProviders(<BatchJobsPage />);
    await user.selectOptions(await screen.findByLabelText("Batch job"), "bj-1");
    const runRow = await screen.findByTestId("batch-run-bjr-1");
    await user.click(within(runRow).getByRole("button", { name: "Retry" }));

    await waitFor(() => {
      const call = requests.find((r) => r.doc.includes("mutation RetryBatchJobRun"));
      expect(call?.vars?.id).toBe("bjr-1");
    });
    expect(await screen.findByTestId("notice-banner")).toHaveTextContent("Retrying from the phase that failed.");
  });
});

describe("Batch jobs page — create", () => {
  it("creates a batch job with real camel variables (pipeline + one binding per picked connection)", async () => {
    const user = userEvent.setup();
    handler = (doc) =>
      doc.includes("mutation CreateBatchJob") ? { createBatchJob: JOBS.batchJobs.nodes[0] } : defaultHandler(doc);
    renderWithProviders(<BatchJobsPage />);

    await user.click(await screen.findByRole("button", { name: /new batch job/i }));
    await user.type(await screen.findByLabelText("Name"), "Nightly claims");
    await user.selectOptions(screen.getByLabelText("Pipeline"), "tpl-1");
    await user.selectOptions(screen.getByLabelText("Sources 1"), "conn-a");
    await user.type(screen.getByLabelText("Cron expression"), "0 2 * * *");
    await user.click(screen.getByRole("button", { name: /^create batch job$/i }));

    await waitFor(() => {
      const call = requests.find((r) => r.doc.includes("mutation CreateBatchJob"));
      expect(call?.vars?.input).toMatchObject({
        name: "Nightly claims",
        pipelineTemplateId: "tpl-1",
        connectionBindings: [{ connectionId: "conn-a" }],
        cron: "0 2 * * *",
        timezone: "UTC",
      });
    });
  });

  it("refuses to submit a job with no source binding — the backend requires at least one", async () => {
    const user = userEvent.setup();
    renderWithProviders(<BatchJobsPage />);
    await user.click(await screen.findByRole("button", { name: /new batch job/i }));
    await user.type(await screen.findByLabelText("Name"), "No sources");
    await user.selectOptions(screen.getByLabelText("Pipeline"), "tpl-1");
    await user.click(screen.getByRole("button", { name: /^create batch job$/i }));

    expect(await screen.findByText("Bind at least one source connection.")).toBeInTheDocument();
    expect(requests.some((r) => r.doc.includes("mutation CreateBatchJob"))).toBe(false);
  });
});
