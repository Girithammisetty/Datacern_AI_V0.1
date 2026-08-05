import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { renderWithProviders } from "@/test/utils";

let handler: (doc: string, vars: any) => any = () => ({});
vi.mock("@/lib/graphql/client", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/graphql/client")>();
  return { ...actual, graphqlRequest: (doc: string, vars: any) => Promise.resolve(handler(doc, vars)) };
});

import { UseCaseSwitcher } from "./UseCaseSwitcher";

/**
 * An identity outage must not masquerade as an ordinary tenant label.
 *
 * `tenantName` falls back to the raw tenant ID, which renders as a plausible —
 * if ugly — label. Before `tenantDegraded` existed there was nothing to tell the
 * two apart, so a downed identity service looked like a tenant that simply had
 * no display name.
 */
const ME = (over: Record<string, unknown>) => ({
  me: {
    userId: "u-1", tenantId: "t-42", type: "user", scopes: [], workspaceId: "ws-1",
    workspaceName: "Claims", roles: ["Admin"], capabilities: ["*"], capsDegraded: false,
    isPlatformAdmin: false, tenantName: null, ...over,
  },
});

beforeEach(() => {
  handler = (doc: string) => {
    if (doc.includes("query Me")) return ME({ tenantName: "Acme", tenantDegraded: false });
    if (doc.includes("query Workspaces")) {
      return { workspaces: { nodes: [], pageInfo: { nextCursor: null, hasMore: false } } };
    }
    return {};
  };
});

describe("tenant chip announces a degraded lookup", () => {
  it("marks the label when the identity lookup failed", async () => {
    handler = (doc: string) =>
      doc.includes("query Me")
        ? ME({ tenantName: null, tenantDegraded: true })
        : { workspaces: { nodes: [], pageInfo: { nextCursor: null, hasMore: false } } };
    renderWithProviders(<UseCaseSwitcher />);
    await waitFor(() => expect(screen.getByTestId("tenant-degraded")).toBeInTheDocument());
    // The raw tenant id (from the session, not from `me`) is still shown — useful —
    // but is no longer passed off as the tenant's name.
    expect(screen.getByTestId("tenant-degraded").textContent).toBeTruthy();
  });

  it("does not mark a tenant that genuinely has no display name", async () => {
    // The case that used to be indistinguishable from an outage.
    handler = (doc: string) =>
      doc.includes("query Me")
        ? ME({ tenantName: null, tenantDegraded: false })
        : { workspaces: { nodes: [], pageInfo: { nextCursor: null, hasMore: false } } };
    renderWithProviders(<UseCaseSwitcher />);
    // Same visible fallback as the degraded case — which is exactly why the two
    // needed a distinguishing signal — but with no marker.
    await waitFor(() => expect(screen.queryByTestId("tenant-degraded")).not.toBeInTheDocument());
    expect(screen.getByRole("button")).toBeInTheDocument();
  });

  it("does not mark a healthy lookup", async () => {
    renderWithProviders(<UseCaseSwitcher />);
    await waitFor(() => expect(screen.getByText("Acme")).toBeInTheDocument());
    expect(screen.queryByTestId("tenant-degraded")).not.toBeInTheDocument();
  });
});
