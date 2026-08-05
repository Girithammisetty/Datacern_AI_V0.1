import { describe, it, expect } from "vitest";
import { makeApolloServer } from "../../src/server.js";
import { makeTestContext, testConfig } from "../helpers/context.js";
import { mockFetch, type CapturedRequest } from "../helpers/mockFetch.js";

const cfg = testConfig();

/**
 * An identity outage must not render as an ordinary blank tenant chip.
 *
 * `viewerTenant` caught its own failure and returned bare nulls, so
 * "identity is down" and "this tenant has no display name" were byte-identical
 * on the wire. Nothing downstream could tell them apart, so the UI showed a
 * blank chip and no one learned the lookup had failed. `tenantDegraded` is the
 * distinguishing signal, mirroring the `capsDegraded` flag `viewerCaps` already
 * carries for exactly the same reason.
 */
function identity(tenantSelf: { status: number; body: unknown }) {
  return mockFetch((req: CapturedRequest) => {
    if (req.path === "/api/v1/tenants/self") return tenantSelf;
    if (req.path === "/api/v1/me/capabilities") {
      return { status: 200, body: { user_id: "u", tenant_id: "t", roles: [], capabilities: [] } };
    }
    return { status: 404, body: { error: { code: "NOT_FOUND", message: "x", trace_id: "t" } } };
  });
}

const Q = `query { me { tenantName tenantDisplayName tenantDegraded } }`;

async function run(fetchImpl: ReturnType<typeof mockFetch>["fetchImpl"]) {
  const server = makeApolloServer(cfg);
  const ctx = await makeTestContext(fetchImpl);
  const res = await server.executeOperation({ query: Q }, { contextValue: ctx });
  const body = res.body as { singleResult: { data?: any; errors?: any } };
  expect(body.singleResult.errors).toBeUndefined();
  return body.singleResult.data.me;
}

describe("viewer tenant degradation is distinguishable", () => {
  it("reports degraded when the identity lookup fails", async () => {
    const { fetchImpl } = identity({
      status: 503, body: { error: { code: "UNAVAILABLE", message: "identity down", trace_id: "t" } },
    });
    const me = await run(fetchImpl);
    expect(me.tenantDegraded).toBe(true);
    expect(me.tenantName).toBeNull();
  });

  it("does NOT report degraded for a tenant that genuinely has no display name", async () => {
    // The case that used to be indistinguishable from an outage.
    const { fetchImpl } = identity({ status: 200, body: { id: "t", name: "acme" } });
    const me = await run(fetchImpl);
    expect(me.tenantDegraded).toBe(false);
    expect(me.tenantName).toBe("acme");
    expect(me.tenantDisplayName).toBeNull();
  });

  it("does not report degraded on a healthy lookup", async () => {
    const { fetchImpl } = identity({
      status: 200, body: { id: "t", name: "acme", display_name: "Acme Insurance" },
    });
    const me = await run(fetchImpl);
    expect(me.tenantDegraded).toBe(false);
    expect(me.tenantName).toBe("Acme Insurance");
  });

  it("a 404 is still a failure, not an absent name", async () => {
    // /tenants/self 404ing means the route or the tenant is gone — a real
    // problem, not a tenant without a label.
    const { fetchImpl } = identity({
      status: 404, body: { error: { code: "NOT_FOUND", message: "x", trace_id: "t" } },
    });
    expect((await run(fetchImpl)).tenantDegraded).toBe(true);
  });
});
