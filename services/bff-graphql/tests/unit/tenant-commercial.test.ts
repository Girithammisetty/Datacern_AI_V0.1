import { describe, it, expect } from "vitest";
import { makeApolloServer } from "../../src/server.js";
import { makeTestContext, testConfig } from "../helpers/context.js";
import { mockFetch, type CapturedRequest, type MockResponse } from "../helpers/mockFetch.js";

const cfg = testConfig();

const QUERY = `
  query($id: ID!) {
    tenantCommercial(id: $id) {
      commercialState
      lockedFeatureKeys
      planKey
      planVersion
      trialEndsAt
      entitlements { kind key provenance value }
    }
  }
`;

const ENTITLEMENTS_BODY = {
  data: [
    { kind: "pack_sku", key: "card-disputes", provenance: "plan_default" },
    { kind: "seat_cap", key: "seats", value: { n: 15 }, provenance: "plan_default" },
  ],
  plan: { key: "pilot", version: 1 },
  commercial_state: "active",
  trial_ends_at: null,
};

/** rbac /me/capabilities + identity GET /tenants/{id}/entitlements double. */
function backend(opts: {
  caps: { roles: string[]; capabilities: string[]; admin: boolean };
  entitlementsStatus?: number;
  entitlementsBody?: unknown;
}) {
  return mockFetch((req: CapturedRequest): MockResponse => {
    if (req.path === "/api/v1/me/capabilities") {
      return { status: 200, body: { roles: opts.caps.roles, capabilities: opts.caps.capabilities, admin: opts.caps.admin } };
    }
    if (req.path.endsWith("/entitlements")) {
      if (opts.entitlementsStatus && opts.entitlementsStatus !== 200) {
        return {
          status: opts.entitlementsStatus,
          body: { error: { code: opts.entitlementsStatus === 404 ? "NOT_FOUND" : "PERMISSION_DENIED", message: "x", trace_id: "t" } },
        };
      }
      return { status: 200, body: opts.entitlementsBody ?? ENTITLEMENTS_BODY };
    }
    return { status: 404, body: { error: { code: "NOT_FOUND", message: "x", trace_id: "t" } } };
  });
}

describe("Query.tenantCommercial (BRD 66 slice 3, CPL-FR-033)", () => {
  it("tenant admin (identity.user.admin) gets the FULL detail shape", async () => {
    const server = makeApolloServer(cfg);
    const { fetchImpl, requests } = backend({
      caps: { roles: ["Admin"], capabilities: ["identity.user.admin"], admin: false },
    });
    const ctx = await makeTestContext(fetchImpl, { sub: "u-admin", tenant_id: "t-42", typ: "user", scopes: [] });

    const res = await server.executeOperation({ query: QUERY, variables: { id: "t-42" } }, { contextValue: ctx });
    const body = res.body.kind === "single" ? res.body.singleResult : null;
    expect(body?.errors).toBeUndefined();
    const tc: any = body?.data?.tenantCommercial;
    expect(tc.commercialState).toBe("active");
    expect(tc.planKey).toBe("pilot");
    expect(tc.planVersion).toBe(1);
    expect(tc.entitlements).toHaveLength(2);
    expect(tc.entitlements[0]).toMatchObject({ kind: "pack_sku", key: "card-disputes", provenance: "plan_default" });

    // Forwarded the caller's own JWT downstream (no BFF-minted credential).
    const entReq = requests.find((r) => r.path.endsWith("/entitlements"));
    expect(entReq?.headers["authorization"]).toMatch(/^Bearer /);
  });

  it("the wildcard admin capability also unlocks full detail", async () => {
    const server = makeApolloServer(cfg);
    const { fetchImpl } = backend({ caps: { roles: ["Admin"], capabilities: ["*"], admin: true } });
    const ctx = await makeTestContext(fetchImpl, { sub: "u-admin", tenant_id: "t-42", typ: "user", scopes: [] });

    const res = await server.executeOperation({ query: QUERY, variables: { id: "t-42" } }, { contextValue: ctx });
    const tc: any = (res.body.kind === "single" ? res.body.singleResult : null)?.data?.tenantCommercial;
    expect(tc.commercialState).toBe("active");
  });

  it("a first-class platform admin (claims.platform_admin) skips the capability lookup and gets full detail", async () => {
    const server = makeApolloServer(cfg);
    // rbac endpoint would 500 if ever called — proves the platform_admin fast path never calls it.
    const { fetchImpl, requests } = mockFetch((req): MockResponse => {
      if (req.path === "/api/v1/me/capabilities") return { status: 500, body: { error: { code: "INTERNAL", message: "must not be called" } } };
      if (req.path.endsWith("/entitlements")) return { status: 200, body: ENTITLEMENTS_BODY };
      return { status: 404, body: { error: { code: "NOT_FOUND", message: "x", trace_id: "t" } } };
    });
    const ctx = await makeTestContext(fetchImpl, {
      sub: "u-op", tenant_id: "t-other", typ: "user", scopes: [], platform_admin: true,
    });

    const res = await server.executeOperation({ query: QUERY, variables: { id: "t-42" } }, { contextValue: ctx });
    const body = res.body.kind === "single" ? res.body.singleResult : null;
    expect(body?.errors).toBeUndefined();
    expect((body?.data?.tenantCommercial as any).commercialState).toBe("active");
    expect(requests.some((r) => r.path === "/api/v1/me/capabilities")).toBe(false);
  });

  it("a non-admin caller gets the MINIMAL shape and never calls identity's entitlements endpoint", async () => {
    const server = makeApolloServer(cfg);
    const { fetchImpl, requests } = backend({
      caps: { roles: ["Case Analyst"], capabilities: ["case.case.read"], admin: false },
    });
    const ctx = await makeTestContext(fetchImpl, { sub: "u-adjuster", tenant_id: "t-42", typ: "user", scopes: [] });

    const res = await server.executeOperation({ query: QUERY, variables: { id: "t-42" } }, { contextValue: ctx });
    const body = res.body.kind === "single" ? res.body.singleResult : null;
    expect(body?.errors).toBeUndefined();
    const tc: any = body?.data?.tenantCommercial;
    expect(tc).toEqual({
      commercialState: null,
      lockedFeatureKeys: [],
      planKey: null,
      planVersion: null,
      trialEndsAt: null,
      entitlements: null,
    });
    expect(requests.some((r) => r.path.endsWith("/entitlements"))).toBe(false);
  });

  it("cross-tenant (downstream 404) resolves to null, mirroring Query.tenant", async () => {
    const server = makeApolloServer(cfg);
    const { fetchImpl } = backend({
      caps: { roles: ["Admin"], capabilities: ["identity.user.admin"], admin: false },
      entitlementsStatus: 404,
    });
    const ctx = await makeTestContext(fetchImpl, { sub: "u-admin", tenant_id: "t-42", typ: "user", scopes: [] });

    const res = await server.executeOperation({ query: QUERY, variables: { id: "t-other" } }, { contextValue: ctx });
    const body = res.body.kind === "single" ? res.body.singleResult : null;
    expect(body?.errors).toBeUndefined();
    expect(body?.data?.tenantCommercial).toBeNull();
  });

  it("a downstream 403 (edge case) degrades to the minimal shape instead of erroring the query", async () => {
    const server = makeApolloServer(cfg);
    const { fetchImpl } = backend({
      caps: { roles: ["Admin"], capabilities: ["identity.user.admin"], admin: false },
      entitlementsStatus: 403,
    });
    const ctx = await makeTestContext(fetchImpl, { sub: "u-admin", tenant_id: "t-42", typ: "user", scopes: [] });

    const res = await server.executeOperation({ query: QUERY, variables: { id: "t-42" } }, { contextValue: ctx });
    const body = res.body.kind === "single" ? res.body.singleResult : null;
    expect(body?.errors).toBeUndefined();
    const tc: any = body?.data?.tenantCommercial;
    expect(tc.commercialState).toBeNull();
    expect(tc.lockedFeatureKeys).toEqual([]);
  });

  it("fails SAFE to the minimal shape when rbac's capability lookup is unavailable", async () => {
    const server = makeApolloServer(cfg);
    const { fetchImpl } = mockFetch(() => ({ status: 503, body: { error: { code: "UNAVAILABLE", message: "down" } } }));
    const ctx = await makeTestContext(fetchImpl, { sub: "u-x", tenant_id: "t-42", typ: "user", scopes: [] });

    const res = await server.executeOperation({ query: QUERY, variables: { id: "t-42" } }, { contextValue: ctx });
    const body = res.body.kind === "single" ? res.body.singleResult : null;
    expect(body?.errors).toBeUndefined();
    const tc: any = body?.data?.tenantCommercial;
    expect(tc.commercialState).toBeNull();
    expect(tc.lockedFeatureKeys).toEqual([]);
  });

  it("null-safety: a plan-less tenant (no plan assigned) maps planKey/planVersion/trialEndsAt to null without throwing", async () => {
    const server = makeApolloServer(cfg);
    const { fetchImpl } = backend({
      caps: { roles: ["Admin"], capabilities: ["identity.user.admin"], admin: false },
      entitlementsBody: { data: [], plan: null, commercial_state: "none", trial_ends_at: null },
    });
    const ctx = await makeTestContext(fetchImpl, { sub: "u-admin", tenant_id: "t-42", typ: "user", scopes: [] });

    const res = await server.executeOperation({ query: QUERY, variables: { id: "t-42" } }, { contextValue: ctx });
    const body = res.body.kind === "single" ? res.body.singleResult : null;
    expect(body?.errors).toBeUndefined();
    const tc: any = body?.data?.tenantCommercial;
    expect(tc).toEqual({
      commercialState: "none",
      lockedFeatureKeys: [],
      planKey: null,
      planVersion: null,
      trialEndsAt: null,
      entitlements: [],
    });
  });
});
