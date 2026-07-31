/**
 * AI field drafting (schema-driven forms, slice 3).
 *
 * The governed contract: drafting SUGGESTS and writes nothing, runs through
 * ai-gateway on the caller's tenant (virtual key as bearer + caller JWT as
 * X-Datacern-JWT, so budgets/guardrails/metering apply), and refuses to invent.
 * These tests pin the parts that protect a human about to sign the result:
 * a value outside the field catalog is discarded, a value that cannot be
 * coerced to the declared type is dropped and reported unfilled, and an
 * unconfigured deployment says so instead of returning an empty draft that
 * reads like "the AI found nothing".
 * Mocking is at the fetch boundary; real master envelopes on both sides.
 */
import { describe, it, expect } from "vitest";
import { makeApolloServer } from "../../src/server.js";
import { makeTestContext, testConfig } from "../helpers/context.js";
import { mockFetch, type CapturedRequest } from "../helpers/mockFetch.js";

const cfg = testConfig({ aiVirtualKey: "vk-secret", aiDraftModel: "datacern-auto" });
const single = (res: any) => (res.body.kind === "single" ? res.body.singleResult : null);

/** The resolver reads the gateway key off the REQUEST context's config, not the
 * server's — so the test context has to carry the same config the server was
 * built with, or every draft would fail "unconfigured" for the wrong reason. */
const ctxWith = (fetchImpl: typeof fetch, c = cfg) => makeTestContext(fetchImpl, undefined, c);

const FIELDS = [
  { name: "siu_referral", data_type: "enum", required: true, custom: true,
    field_meta: { label: "SIU referral", options: ["yes", "no"] } },
  { name: "exposure", data_type: "integer", custom: true, field_meta: { label: "Exposure" } },
  { name: "summary", data_type: "text", custom: true, field_meta: {} },
];

function services(assistant: string) {
  return mockFetch((req: CapturedRequest) => {
    if (req.path === "/api/v1/cases/form" && req.method === "GET") {
      return { status: 200, body: { data: { mode: "create", defaults: [], custom_fields: FIELDS } } };
    }
    if (req.path === "/api/v1/cases/c-1" && req.method === "GET") {
      return { status: 200, body: { data: {
        id: "c-1", description: "Duplicate invoice suspected",
        display_projection: { invoice_no: "INV-5540", amount: "9000" },
      } } };
    }
    if (req.path === "/api/v1/cases/c-1/evidence" && req.method === "GET") {
      return { status: 200, body: { data: [{ id: "e-1", filename: "intake_snapshot.json" }] } };
    }
    if (req.path === "/v1/chat/completions" && req.method === "POST") {
      return { status: 200, body: {
        model: "llama3.2", choices: [{ message: { content: assistant } }],
        usage: { prompt_tokens: 120, completion_tokens: 40 },
      } };
    }
    return { status: 404, body: { error: { code: "NOT_FOUND", message: "x", trace_id: "t" } } };
  });
}

const DRAFT = `mutation($input: DraftCaseFieldsInput!) {
  draftCaseFields(input: $input) {
    fields { name value confidence sourceRef }
    unfilled
    model
    evidenceUsed
  }
}`;

describe("draftCaseFields", () => {
  it("drafts typed values from the case's context and marks their source", async () => {
    const server = makeApolloServer(cfg);
    const { fetchImpl, requests } = services(JSON.stringify({
      fields: [
        { name: "siu_referral", value: "yes", confidence: 0.82, source_ref: "case row" },
        { name: "exposure", value: "9,000", confidence: 0.7, source_ref: "amount" },
      ],
    }));
    const ctx = await ctxWith(fetchImpl);

    const res = await server.executeOperation(
      { query: DRAFT, variables: { input: { caseId: "c-1" } } },
      { contextValue: ctx },
    );
    const body = single(res);
    expect(body?.errors).toBeUndefined();
    const d = (body?.data as any).draftCaseFields;

    // "9,000" for an integer field is coerced to a NUMBER — a typed catalog
    // must not receive a formatted string.
    expect(d.fields).toEqual([
      { name: "siu_referral", value: "yes", confidence: 0.82, sourceRef: "case row" },
      { name: "exposure", value: 9000, confidence: 0.7, sourceRef: "amount" },
    ]);
    // the field the model declined is reported, not silently missing
    expect(d.unfilled).toEqual(["summary"]);
    expect(d.model).toBe("llama3.2");
    expect(d.evidenceUsed).toContain("intake_snapshot.json");

    // The gateway call carries the DATA-plane auth contract: virtual key as the
    // bearer, the caller's JWT alongside it, so the spend lands on the caller's
    // tenant and guardrails apply.
    const call = requests.find((r) => r.path === "/v1/chat/completions");
    expect(call?.headers?.authorization).toBe("Bearer vk-secret");
    expect(call?.headers?.["x-datacern-jwt"]).toBeTruthy();
    expect(call?.body.temperature).toBe(0);
  });

  it("discards a suggestion for a field the workspace never declared", async () => {
    const server = makeApolloServer(cfg);
    const { fetchImpl } = services(JSON.stringify({
      fields: [
        { name: "siu_referral", value: "no" },
        { name: "secret_backdoor", value: "oops" }, // not in the catalog
      ],
    }));
    const ctx = await ctxWith(fetchImpl);
    const res = await server.executeOperation(
      { query: DRAFT, variables: { input: { caseId: "c-1" } } }, { contextValue: ctx });
    const d = (single(res)?.data as any).draftCaseFields;
    expect(d.fields.map((f: any) => f.name)).toEqual(["siu_referral"]);
  });

  it("drops values that do not fit the declared type instead of passing them through", async () => {
    const server = makeApolloServer(cfg);
    const { fetchImpl } = services(JSON.stringify({
      fields: [
        { name: "exposure", value: "not a number" },
        { name: "siu_referral", value: "maybe" }, // not one of the enum options
      ],
    }));
    const ctx = await ctxWith(fetchImpl);
    const res = await server.executeOperation(
      { query: DRAFT, variables: { input: { caseId: "c-1" } } }, { contextValue: ctx });
    const d = (single(res)?.data as any).draftCaseFields;
    expect(d.fields).toEqual([]);
    expect(d.unfilled.sort()).toEqual(["exposure", "siu_referral", "summary"]);
  });

  it("parses a fenced JSON reply (models wrap output often enough to matter)", async () => {
    const server = makeApolloServer(cfg);
    const { fetchImpl } = services(
      'Here you go:\n```json\n{"fields":[{"name":"summary","value":"Duplicate of INV-5540"}]}\n```',
    );
    const ctx = await ctxWith(fetchImpl);
    const res = await server.executeOperation(
      { query: DRAFT, variables: { input: { caseId: "c-1" } } }, { contextValue: ctx });
    const d = (single(res)?.data as any).draftCaseFields;
    expect(d.fields[0]).toMatchObject({ name: "summary", value: "Duplicate of INV-5540" });
  });

  it("returns an empty draft (not an error) when the model replies with prose", async () => {
    const server = makeApolloServer(cfg);
    const { fetchImpl } = services("I could not determine any values from this material.");
    const ctx = await ctxWith(fetchImpl);
    const res = await server.executeOperation(
      { query: DRAFT, variables: { input: { caseId: "c-1" } } }, { contextValue: ctx });
    const d = (single(res)?.data as any).draftCaseFields;
    expect(d.fields).toEqual([]);
    expect(d.unfilled).toHaveLength(3);
  });

  it("drafts from pasted text with no case at all", async () => {
    const server = makeApolloServer(cfg);
    const { fetchImpl, requests } = services(JSON.stringify({
      fields: [{ name: "summary", value: "Vendor resubmitted the same invoice" }],
    }));
    const ctx = await ctxWith(fetchImpl);
    const res = await server.executeOperation(
      { query: DRAFT, variables: { input: { evidenceText: "Vendor resubmitted INV-5540." } } },
      { contextValue: ctx },
    );
    const d = (single(res)?.data as any).draftCaseFields;
    expect(d.fields[0].name).toBe("summary");
    expect(d.evidenceUsed).toEqual(["provided text"]);
    // no case was read
    expect(requests.find((r) => r.path === "/api/v1/cases/c-1")).toBeUndefined();
  });

  it("says AI drafting is unconfigured rather than returning an empty draft", async () => {
    const unconfigured = testConfig({ aiVirtualKey: "" });
    const server = makeApolloServer(unconfigured);
    const { fetchImpl } = services("{}");
    const ctx = await ctxWith(fetchImpl, unconfigured);
    const res = await server.executeOperation(
      { query: DRAFT, variables: { input: { caseId: "c-1" } } }, { contextValue: ctx });
    expect(single(res)?.errors?.[0]?.message).toContain("not configured");
  });

  it("names the tenant/key mismatch instead of leaking a bare 401", async () => {
    // ai-gateway binds a virtual key to ONE tenant and rejects a caller from
    // another with KEY_INVALID. A single deployment key therefore serves one
    // tenant; the operator should read that, not "unauthorized".
    const server = makeApolloServer(cfg);
    const { fetchImpl } = mockFetch((req: CapturedRequest) => {
      if (req.path === "/api/v1/cases/form") {
        return { status: 200, body: { data: { mode: "create", defaults: [], custom_fields: FIELDS } } };
      }
      if (req.path === "/v1/chat/completions") {
        return { status: 401, body: { error: { code: "KEY_INVALID", message: "virtual key is invalid or revoked", trace_id: "t" } } };
      }
      return { status: 200, body: { data: { id: "c-1", description: "x" } } };
    });
    const ctx = await ctxWith(fetchImpl);
    const res = await server.executeOperation(
      { query: DRAFT, variables: { input: { evidenceText: "some material" } } },
      { contextValue: ctx });
    expect(single(res)?.errors?.[0]?.message).toContain("belongs to a different tenant");
  });

  it("refuses when there is nothing to draft from", async () => {
    const server = makeApolloServer(cfg);
    const { fetchImpl } = services("{}");
    const ctx = await ctxWith(fetchImpl);
    const res = await server.executeOperation(
      { query: DRAFT, variables: { input: {} } }, { contextValue: ctx });
    expect(single(res)?.errors?.[0]?.message).toContain("caseId or evidenceText");
  });
});
