/**
 * Case streams (realtime-case-streams add-on, slice 4): bff resolvers over
 * ingestion-service /case-streams + the composed create that also registers
 * the case-service trigger and binds it — compensating on failure so a
 * half-composed stream never survives. Entitlement refusals (403 naming the
 * SKU / 503 fail-closed) pass through untouched: the bff must not soften a
 * commercial refusal into a generic error.
 * Mocking is at the fetch boundary; real master envelopes on both sides.
 */
import { describe, it, expect } from "vitest";
import { makeApolloServer } from "../../src/server.js";
import { makeTestContext, testConfig } from "../helpers/context.js";
import { mockFetch, type CapturedRequest } from "../helpers/mockFetch.js";

const cfg = testConfig();
const single = (res: any) => (res.body.kind === "single" ? res.body.singleResult : null);

const STREAM = {
  id: "cs-1",
  workspace_id: "ws-1",
  name: "high-value-orders",
  connection_id: "conn-1",
  schedule_id: "sch-9",
  case_trigger_id: null as string | null,
  status: "active",
  created_by: "u-1",
  created_at: "2026-07-30T04:00:00Z",
  updated_at: "2026-07-30T04:00:00Z",
  schedule: {
    interval_seconds: 300,
    next_fire_at: "2026-07-30T04:05:00Z",
    watermark: { column: "updated_at", current_value: "2026-07-30T03:55:00Z" },
    enabled: true,
  },
};

function services(opts: { triggerFails?: boolean; blocked?: boolean; unavailable?: boolean } = {}) {
  return mockFetch((req: CapturedRequest) => {
    if (req.path === "/api/v1/case-streams" && req.method === "POST") {
      if (opts.blocked) {
        return { status: 403, body: { error: { code: "PERMISSION_DENIED",
          message: "case streams require the realtime-case-streams add-on " +
            "(feature entitlement 'realtime_case_streams'); contact your administrator " +
            "to enable the SKU for this tenant", trace_id: "tr" } } };
      }
      if (opts.unavailable) {
        return { status: 503, body: { error: { code: "ENTITLEMENT_UNAVAILABLE",
          message: "cannot verify the realtime-case-streams entitlement right now; " +
            "refusing to start a stream rather than granting it unchecked", trace_id: "tr" } } };
      }
      return { status: 201, body: { data: { ...STREAM, name: req.body.name } } };
    }
    if (req.path === "/api/v1/case-streams" && req.method === "GET") {
      return { status: 200, body: { data: [STREAM] } };
    }
    if (req.path === "/api/v1/case-streams/cs-1" && req.method === "PATCH") {
      return { status: 200, body: { data: { ...STREAM, case_trigger_id: req.body.case_trigger_id } } };
    }
    if (req.path === "/api/v1/case-streams/cs-1/pause" && req.method === "POST") {
      return { status: 200, body: { data: { ...STREAM, status: "paused",
        schedule: { ...STREAM.schedule, enabled: false } } } };
    }
    if (req.path === "/api/v1/case-streams/cs-1/resume" && req.method === "POST") {
      return { status: 200, body: { data: STREAM } };
    }
    if (req.path === "/api/v1/case-streams/cs-1" && req.method === "DELETE") {
      return { status: 204, body: undefined };
    }
    if (req.path === "/api/v1/case-triggers" && req.method === "POST") {
      if (opts.triggerFails) {
        return { status: 500, body: { error: { code: "INTERNAL", message: "boom", trace_id: "tr" } } };
      }
      return { status: 201, body: { data: {
        id: "trig-7", workspace_id: "ws-1", name: req.body.name, enabled: true,
        dataset_name: req.body.dataset_name, conditions: req.body.conditions ?? [],
        severity: req.body.severity, due_hours: req.body.due_hours,
        projection_fields: req.body.projection_fields ?? [],
        max_cases_per_event: req.body.max_cases_per_event,
        attach_evidence: req.body.attach_evidence ?? false,
      } } };
    }
    return { status: 404, body: { error: { code: "NOT_FOUND", message: "x", trace_id: "t" } } };
  });
}

const CREATE = `mutation($input: CreateCaseStreamInput!) {
  createCaseStream(input: $input) { id name status caseTriggerId schedule urn }
}`;

const BASE_INPUT = {
  name: "high-value-orders",
  connectionId: "conn-1",
  ingestionTemplate: { statement: "SELECT * FROM orders", new_dataset: { name: "orders-stream" } },
  intervalSeconds: 300,
  watermark: { column: "updated_at", valueType: "timestamp", initialValue: "2026-07-01T00:00:00Z" },
};

describe("case streams (realtime-case-streams add-on)", () => {
  it("createCaseStream maps camel input to the snake CaseStreamCreate body and surfaces the cursor", async () => {
    const server = makeApolloServer(cfg);
    const { fetchImpl, requests } = services();
    const ctx = await makeTestContext(fetchImpl);
    const res = await server.executeOperation(
      { query: CREATE, variables: { input: BASE_INPUT } },
      { contextValue: ctx },
    );
    const body = single(res);
    expect(body?.errors).toBeUndefined();
    expect((body?.data as any).createCaseStream).toMatchObject({
      id: "cs-1", name: "high-value-orders", status: "active",
      urn: "wr:t-42:ingestion:case_stream/cs-1",
    });
    // The live cursor reaches the UI: how far the stream has read.
    expect((body?.data as any).createCaseStream.schedule.watermark.current_value)
      .toBe("2026-07-30T03:55:00Z");
    const post = requests.find((r) => r.path === "/api/v1/case-streams" && r.method === "POST");
    expect(post?.body).toMatchObject({
      name: "high-value-orders", connection_id: "conn-1", interval_seconds: 300,
      watermark: { column: "updated_at", value_type: "timestamp",
        initial_value: "2026-07-01T00:00:00Z" },
    });
  });

  it("composed create registers the trigger against the stream's dataset and binds it", async () => {
    const server = makeApolloServer(cfg);
    const { fetchImpl, requests } = services();
    const ctx = await makeTestContext(fetchImpl);
    const res = await server.executeOperation(
      { query: CREATE, variables: { input: { ...BASE_INPUT, trigger: {
        conditions: [{ col: "amount", op: "gt", value: "10000" }],
        severity: "high", attachEvidence: true,
      } } } },
      { contextValue: ctx },
    );
    const body = single(res);
    expect(body?.errors).toBeUndefined();
    expect((body?.data as any).createCaseStream.caseTriggerId).toBe("trig-7");

    const trig = requests.find((r) => r.path === "/api/v1/case-triggers" && r.method === "POST");
    // Watches the SAME dataset the stream writes; trigger name defaults to the
    // stream name; evidence capture requested.
    expect(trig?.body).toMatchObject({
      name: "high-value-orders", dataset_name: "orders-stream",
      severity: "high", attach_evidence: true,
      conditions: [{ col: "amount", op: "gt", value: "10000" }],
    });
    const bind = requests.find((r) => r.path === "/api/v1/case-streams/cs-1" && r.method === "PATCH");
    expect(bind?.body).toMatchObject({ case_trigger_id: "trig-7" });
  });

  it("compensates when the trigger cannot be created: the stream is deleted and the error surfaces", async () => {
    const server = makeApolloServer(cfg);
    const { fetchImpl, requests } = services({ triggerFails: true });
    const ctx = await makeTestContext(fetchImpl);
    const res = await server.executeOperation(
      { query: CREATE, variables: { input: { ...BASE_INPUT, trigger: { attachEvidence: true } } } },
      { contextValue: ctx },
    );
    const body = single(res);
    expect(body?.errors?.length).toBe(1);
    // Never a half-composed stream: the freshly created stream was deleted again.
    const del = requests.find((r) => r.path === "/api/v1/case-streams/cs-1" && r.method === "DELETE");
    expect(del).toBeTruthy();
  });

  it("passes the entitlement 403 through with the SKU still named", async () => {
    const server = makeApolloServer(cfg);
    const { fetchImpl } = services({ blocked: true });
    const ctx = await makeTestContext(fetchImpl);
    const res = await server.executeOperation(
      { query: CREATE, variables: { input: BASE_INPUT } },
      { contextValue: ctx },
    );
    const err = single(res)?.errors?.[0];
    expect(err?.extensions?.code).toBe("PERMISSION_DENIED");
    expect(err?.message).toContain("realtime_case_streams");
  });

  it("passes the fail-closed 503 through as ENTITLEMENT_UNAVAILABLE", async () => {
    const server = makeApolloServer(cfg);
    const { fetchImpl } = services({ unavailable: true });
    const ctx = await makeTestContext(fetchImpl);
    const res = await server.executeOperation(
      { query: CREATE, variables: { input: BASE_INPUT } },
      { contextValue: ctx },
    );
    expect(single(res)?.errors?.[0]?.extensions?.code).toBe("ENTITLEMENT_UNAVAILABLE");
  });

  it("caseStreams lists with the workspace filter forwarded; pause reflects the disabled schedule", async () => {
    const server = makeApolloServer(cfg);
    const { fetchImpl, requests } = services();
    const ctx = await makeTestContext(fetchImpl);

    const list = await server.executeOperation(
      { query: `query { caseStreams(workspaceId: "ws-1") { id status } }` },
      { contextValue: ctx },
    );
    expect((single(list)?.data as any).caseStreams).toEqual([{ id: "cs-1", status: "active" }]);
    const get = requests.find((r) => r.path === "/api/v1/case-streams" && r.method === "GET");
    expect(get?.search.get("workspace_id")).toBe("ws-1");

    const paused = await server.executeOperation(
      { query: `mutation { pauseCaseStream(id: "cs-1") { status schedule } }` },
      { contextValue: ctx },
    );
    const data = (single(paused)?.data as any).pauseCaseStream;
    expect(data.status).toBe("paused");
    expect(data.schedule.enabled).toBe(false);
  });
});
