import { describe, it, expect } from "vitest";
import { makeApolloServer } from "../../src/server.js";
import { makeTestContext, testConfig } from "../helpers/context.js";
import { mockFetch, type CapturedRequest, type MockResponse } from "../helpers/mockFetch.js";

const cfg = testConfig();

/** rbac /me/capabilities double. */
function rbac(capabilities: string[], opts: { fail?: boolean } = {}) {
  return mockFetch((req: CapturedRequest): MockResponse => {
    if (req.path === "/api/v1/me/capabilities") {
      if (opts.fail) return { status: 503, body: { error: { code: "UNAVAILABLE", message: "rbac down", trace_id: "t" } } };
      return { status: 200, body: { roles: ["r"], capabilities, admin: false } };
    }
    return { status: 404, body: { error: { code: "NOT_FOUND", message: "x", trace_id: "t" } } };
  });
}

const CATALOG = `{ reportCatalog { id title domain formats cadence href schedulable note } }`;

async function run(fetchImpl: typeof fetch) {
  const server = makeApolloServer(cfg);
  const ctx = await makeTestContext(fetchImpl, { sub: "u", tenant_id: "t-42", typ: "user", scopes: [] });
  const res = await server.executeOperation({ query: CATALOG }, { contextValue: ctx });
  const body = res.body.kind === "single" ? res.body.singleResult : null;
  expect(body?.errors).toBeUndefined();
  return (body?.data?.reportCatalog ?? []) as Array<{ id: string; requiredCapability?: unknown }>;
}

describe("Query.reportCatalog (server-authoritative, capability-filtered)", () => {
  it("returns only reports the caller's capabilities reach", async () => {
    // usage.report.read → the two financial reports; nothing else.
    const { fetchImpl } = rbac(["usage.report.read"]);
    const ids = (await run(fetchImpl)).map((r) => r.id).sort();
    expect(ids).toEqual(["chargeback", "value-roi"]);
  });

  it("returns the whole catalog for a broadly-capable caller", async () => {
    const { fetchImpl } = rbac([
      "usage.report.read", "ai.agent.read", "audit.compliance.read",
      "case.case.export", "case.disposition.read", "chart.chart.export",
    ]);
    const ids = (await run(fetchImpl)).map((r) => r.id);
    expect(ids).toHaveLength(8);
    expect(ids).toContain("agent-inventory");
    expect(ids).toContain("compliance-pack");
  });

  it("returns nothing for a caller with no report capabilities", async () => {
    const { fetchImpl } = rbac(["case.case.read"]); // can read cases but no report caps
    expect(await run(fetchImpl)).toHaveLength(0);
  });

  it("never leaks the server-side filter field", async () => {
    const { fetchImpl } = rbac(["usage.report.read"]);
    for (const r of await run(fetchImpl)) {
      expect(r.requiredCapability).toBeUndefined();
    }
  });

  it("fails closed (empty, not an error) when the rbac lookup fails", async () => {
    const { fetchImpl } = rbac([], { fail: true });
    expect(await run(fetchImpl)).toHaveLength(0);
  });

  it("shapes each entry with the fields the hub renders", async () => {
    const { fetchImpl } = rbac(["usage.report.read"]);
    const chargeback = (await run(fetchImpl)).find((r) => r.id === "chargeback") as any;
    expect(chargeback).toMatchObject({
      title: "Chargeback / spend showback",
      domain: "financial",
      formats: ["csv"],
      cadence: "monthly",
      href: "/admin/usage",
      schedulable: false,
    });
    expect(chargeback.note).toContain("finalized months only");
  });
});
