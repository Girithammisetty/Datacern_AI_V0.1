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
import { describe, it, expect, vi } from "vitest";
import { ServiceClient } from "../../src/clients/base.js";
import { AiGatewayClient } from "../../src/clients/aigateway.js";
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

/**
 * Timeout budget: inference does not get the CRUD budget.
 *
 * The bug this pins, observed in e2e-live on two separate runs: draftCaseFields
 * failed with `{"message":"ai-gateway timed out","code":"SERVICE_UNAVAILABLE",
 * "httpStatus":0}`. httpStatus 0 is a CLIENT abort — the bff killed a healthy
 * generation at the 10s DOWNSTREAM_TIMEOUT_MS meant for CRUD, then reported it
 * as if the downstream had failed. The same Ollama served agent-runtime twice in
 * the same run; agent-runtime just does not borrow the bff's budget.
 *
 * Asserting on the ABORT SIGNAL's deadline rather than by sleeping: a test that
 * actually waits 10s to prove a 10s timeout is one nobody will keep.
 */
describe("draftCaseFields timeout budget", () => {
  const hangingFetch = (flag: { aborted: boolean }): typeof fetch =>
    ((_i: any, init: any = {}) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener?.("abort", () => {
          flag.aborted = true;
          const e = new Error("aborted");
          e.name = "AbortError";
          reject(e);
        });
      })) as any;

  const svc = (fetchImpl: typeof fetch) =>
    new ServiceClient({
      service: "ai-gateway",
      baseUrl: "http://ai-gateway",
      ctx: { authorization: "Bearer jwt", traceId: "t" } as any,
      fetchImpl,
      timeoutMs: 10_000, // the CRUD budget that used to kill drafting
    });

  it("does NOT abort the model call at the CRUD budget, and does abort at the inference budget", async () => {
    vi.useFakeTimers();
    try {
      const flag = { aborted: false };
      const client = new AiGatewayClient(svc(hangingFetch(flag)));
      const p = client
        .draftJson({ virtualKey: "vk", model: "m", system: "s", user: "u", timeoutMs: 130_000 })
        .catch((e) => e);

      // Past the CRUD budget: a healthy generation must still be running.
      await vi.advanceTimersByTimeAsync(11_000);
      expect(flag.aborted).toBe(false);

      // Past the inference budget: now it is allowed to give up.
      await vi.advanceTimersByTimeAsync(120_000);
      expect(flag.aborted).toBe(true);
      const err = await p;
      expect(String(err?.message ?? err)).toContain("timed out");
    } finally {
      vi.useRealTimers();
    }
  });

  it("still applies the short CRUD budget to ai-gateway's admin plane", async () => {
    vi.useFakeTimers();
    try {
      const flag = { aborted: false };
      // The slow thing is inference, not the service — raising the whole
      // client would make provider/ladder/budget reads hang for two minutes.
      const p = svc(hangingFetch(flag)).get("/api/v1/providers").catch((e) => e);
      await vi.advanceTimersByTimeAsync(11_000);
      expect(flag.aborted).toBe(true);
      await p;
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the inference budget above the platform's 120s provider timeout", () => {
    // Ordering invariant, not a style preference: ai-gateway and agent-runtime
    // both use timeout_s=120.0 for a provider call. If the bff's budget drops
    // to or below that, the bff aborts FIRST and the caller gets an opaque
    // httpStatus 0 instead of ai-gateway's structured, metered, budget-aware
    // error — which is exactly the failure this change exists to remove.
    const c = testConfig();
    expect(c.aiInferenceTimeoutMs).toBeGreaterThan(120_000);
    expect(c.aiInferenceTimeoutMs).toBeGreaterThan(c.downstreamTimeoutMs);
  });
});
