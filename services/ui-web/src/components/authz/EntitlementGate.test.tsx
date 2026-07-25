import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithProviders } from "@/test/utils";
import type { Viewer } from "@/lib/graphql/types";

// Same mocking shape as components/authz/gating.test.tsx: useMe backs the
// capability set, useTenantCommercial backs the locked-feature-entitlement set.
let mockViewer: Viewer | undefined;
let mockLockedFeatureKeys: string[] | undefined;
vi.mock("@/lib/graphql/hooks", () => ({
  useMe: () => ({ data: mockViewer ? { me: mockViewer } : undefined, isLoading: false, isError: false }),
  useTenantCommercial: () => ({
    data: mockLockedFeatureKeys ? { lockedFeatureKeys: mockLockedFeatureKeys } : undefined,
    isLoading: false,
    isError: false,
  }),
}));

import { EntitlementGate, LockedFeaturePreview } from "@/components/authz/EntitlementGate";

function viewer(): Viewer {
  return {
    userId: "u", tenantId: "t", tenantName: "Tenant T", workspaceId: "w", workspaceName: "Default use case",
    type: "user", scopes: [], isPlatformAdmin: false, roles: ["Admin"], capabilities: ["*"], capsDegraded: false,
  };
}

beforeEach(() => {
  mockViewer = viewer();
  mockLockedFeatureKeys = undefined;
});

describe("EntitlementGate (BRD 66 slice 3, CPL-FR-013)", () => {
  it("renders children normally when the feature is NOT locked", () => {
    mockLockedFeatureKeys = [];
    renderWithProviders(
      <EntitlementGate featureKey="banking-aml" featureLabel="Banking AML">
        <div data-testid="feature-content">Full feature UI</div>
      </EntitlementGate>,
    );
    expect(screen.getByTestId("feature-content")).toBeInTheDocument();
    expect(screen.queryByTestId("entitlement-locked")).not.toBeInTheDocument();
  });

  it("renders a locked preview + upsell CTA (never hidden) when the feature IS locked", () => {
    mockLockedFeatureKeys = ["banking-aml"];
    renderWithProviders(
      <EntitlementGate featureKey="banking-aml" featureLabel="Banking AML">
        <div data-testid="feature-content">Full feature UI</div>
      </EntitlementGate>,
    );
    // Never hidden: the preview wrapper is present, and so is a CTA -- this is
    // NOT the same as Can/RouteGuard's fail-safe-HIDE behavior for capabilities.
    expect(screen.getByTestId("entitlement-locked")).toBeInTheDocument();
    expect(screen.getByTestId("entitlement-upgrade-cta")).toBeInTheDocument();
    expect(screen.getByText(/Banking AML/)).toBeInTheDocument();
  });

  it("an admin viewer does NOT bypass a locked commercial entitlement", () => {
    mockLockedFeatureKeys = ["banking-aml"];
    mockViewer = { ...viewer(), roles: ["Admin"], capabilities: ["*"] };
    renderWithProviders(
      <EntitlementGate featureKey="banking-aml" featureLabel="Banking AML">
        <div data-testid="feature-content">Full feature UI</div>
      </EntitlementGate>,
    );
    expect(screen.getByTestId("entitlement-locked")).toBeInTheDocument();
  });

  it("a feature key NOT in the locked set renders normally", () => {
    mockLockedFeatureKeys = ["some-other-pack"];
    renderWithProviders(
      <EntitlementGate featureKey="banking-aml" featureLabel="Banking AML">
        <div data-testid="feature-content">Full feature UI</div>
      </EntitlementGate>,
    );
    expect(screen.getByTestId("feature-content")).toBeInTheDocument();
    expect(screen.queryByTestId("entitlement-locked")).not.toBeInTheDocument();
  });

  it("LockedFeaturePreview renders directly (no useCapabilities lookup) for callers that already know the lock state", () => {
    renderWithProviders(
      <LockedFeaturePreview featureLabel="Banking AML">
        <div>preview content</div>
      </LockedFeaturePreview>,
    );
    expect(screen.getByTestId("entitlement-locked")).toBeInTheDocument();
    expect(screen.getByTestId("entitlement-upgrade-cta")).toBeInTheDocument();
  });
});
