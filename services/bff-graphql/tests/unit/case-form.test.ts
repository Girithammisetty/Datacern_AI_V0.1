/**
 * Schema-driven case forms (customer UI templating, slice 2).
 *
 * Two things are pinned here. First, `caseForm` exposes case-service's
 * GET /cases/form model — platform defaults plus the workspace's applicable
 * custom-field defs (already purpose-filtered server-side), shaped uniformly so
 * a renderer treats defaults and custom fields the same way.
 *
 * Second, the gap this slice closed: `CreateCasesInput` had NO customFields, so
 * the UI could not submit values for the very fields the form model advertises
 * — the catalog was configurable but unusable. The create test asserts the
 * values reach case-service's body, and that its 422 for an undeclared field
 * surfaces verbatim (the server, not the form, is the authority on what a case
 * may carry).
 * Mocking is at the fetch boundary; real master envelopes on both sides.
 */
import { describe, it, expect } from "vitest";
import { makeApolloServer } from "../../src/server.js";
import { makeTestContext, testConfig } from "../helpers/context.js";
import { mockFetch, type CapturedRequest } from "../helpers/mockFetch.js";

const cfg = testConfig();
const single = (res: any) => (res.body.kind === "single" ? res.body.singleResult : null);

const FORM_MODEL = {
  mode: "create",
  defaults: [
    { name: "assignee", data_type: "string", required: true },
    { name: "due_date", data_type: "date", required: true },
    { name: "description", data_type: "text", required: false },
    { name: "severity", data_type: "enum", required: false },
  ],
  custom_fields: [
    {
      name: "siu_referral",
      data_type: "enum",
      field_meta: { label: "SIU referral", options: ["yes", "no"], help: "Route to SIU?" },
      custom: true,
      query_scoped: false,
    },
    { name: "adjuster_notes", data_type: "text", field_meta: {}, custom: true, query_scoped: true },
  ],
};

function caseService(opts: { unknownField?: boolean } = {}) {
  return mockFetch((req: CapturedRequest) => {
    if (req.path === "/api/v1/cases/form" && req.method === "GET") {
      return { status: 200, body: { data: { ...FORM_MODEL, mode: req.search.get("mode") ?? "create" } } };
    }
    if (req.path === "/api/v1/cases" && req.method === "POST") {
      if (opts.unknownField) {
        return { status: 422, body: { error: { code: "VALIDATION_FAILED",
          message: "unknown custom field: not_declared", trace_id: "tr" } } };
      }
      return { status: 201, body: { data: {
        created: [{ id: "c-1", case_number: 7, status: "unassigned" }],
        deduplicated: [],
      } } };
    }
    return { status: 404, body: { error: { code: "NOT_FOUND", message: "x", trace_id: "t" } } };
  });
}

const FORM_Q = `query($mode: String) {
  caseForm(mode: $mode) {
    mode
    defaults { name dataType required custom }
    customFields { name dataType custom queryScoped fieldMeta }
  }
}`;

const CREATE = `mutation($input: CreateCasesInput!) {
  createCases(input: $input) { created { id caseNumber } }
}`;

const BASE_INPUT = {
  datasetUrn: "wr:t-42:dataset:dataset/ds-1",
  dueDate: "2026-12-01T00:00:00Z",
  severity: "high",
  rows: [{ rowPk: "row-9", displayProjection: [{ key: "claimant", value: "Ada" }] }],
};

describe("schema-driven case forms", () => {
  it("caseForm returns defaults + custom fields with their layout metadata", async () => {
    const server = makeApolloServer(cfg);
    const { fetchImpl, requests } = caseService();
    const ctx = await makeTestContext(fetchImpl);

    const res = await server.executeOperation(
      { query: FORM_Q, variables: { mode: "create" } },
      { contextValue: ctx },
    );
    const body = single(res);
    expect(body?.errors).toBeUndefined();
    const form = (body?.data as any).caseForm;

    expect(form.mode).toBe("create");
    expect(form.defaults.map((f: any) => f.name)).toEqual([
      "assignee", "due_date", "description", "severity",
    ]);
    // A custom field carries the layout hints a renderer needs — the UI never
    // hard-codes labels/options for a tenant's own fields.
    const siu = form.customFields.find((f: any) => f.name === "siu_referral");
    expect(siu).toMatchObject({ dataType: "enum", custom: true, queryScoped: false });
    expect(siu.fieldMeta).toMatchObject({ label: "SIU referral", options: ["yes", "no"] });
    // query-scoped fields are flagged, so a form bound to one saved query can
    // show only what applies to it.
    expect(form.customFields.find((f: any) => f.name === "adjuster_notes").queryScoped).toBe(true);

    expect(requests.find((r) => r.path === "/api/v1/cases/form")?.search.get("mode")).toBe("create");
  });

  it("forwards the requested mode (update forms differ from create forms)", async () => {
    const server = makeApolloServer(cfg);
    const { fetchImpl, requests } = caseService();
    const ctx = await makeTestContext(fetchImpl);
    await server.executeOperation(
      { query: FORM_Q, variables: { mode: "update" } },
      { contextValue: ctx },
    );
    expect(requests.find((r) => r.path === "/api/v1/cases/form")?.search.get("mode")).toBe("update");
  });

  it("createCases carries customFields to case-service (the gap this slice closed)", async () => {
    const server = makeApolloServer(cfg);
    const { fetchImpl, requests } = caseService();
    const ctx = await makeTestContext(fetchImpl);

    const res = await server.executeOperation(
      { query: CREATE, variables: { input: {
        ...BASE_INPUT,
        customFields: { siu_referral: "yes", adjuster_notes: "second submission" },
      } } },
      { contextValue: ctx },
    );
    expect(single(res)?.errors).toBeUndefined();

    const post = requests.find((r) => r.path === "/api/v1/cases" && r.method === "POST");
    expect(post?.body.custom_fields).toEqual({
      siu_referral: "yes", adjuster_notes: "second submission",
    });
  });

  it("omits custom_fields entirely when the form declares none", async () => {
    const server = makeApolloServer(cfg);
    const { fetchImpl, requests } = caseService();
    const ctx = await makeTestContext(fetchImpl);
    await server.executeOperation({ query: CREATE, variables: { input: BASE_INPUT } },
      { contextValue: ctx });
    const post = requests.find((r) => r.path === "/api/v1/cases" && r.method === "POST");
    expect(post?.body.custom_fields).toBeUndefined();
  });

  it("surfaces case-service's 422 for an undeclared field verbatim", async () => {
    const server = makeApolloServer(cfg);
    const { fetchImpl } = caseService({ unknownField: true });
    const ctx = await makeTestContext(fetchImpl);

    const res = await server.executeOperation(
      { query: CREATE, variables: { input: { ...BASE_INPUT,
        customFields: { not_declared: "x" } } } },
      { contextValue: ctx },
    );
    const err = single(res)?.errors?.[0];
    // The SERVER is the authority on what a case may carry — a form that
    // renders a field the catalog does not declare fails loudly here.
    expect(err?.extensions?.code).toBe("VALIDATION_FAILED");
    expect(err?.message).toContain("unknown custom field");
  });
});
