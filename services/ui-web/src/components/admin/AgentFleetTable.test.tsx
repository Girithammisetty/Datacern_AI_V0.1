import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { renderWithProviders } from "@/test/utils";

/**
 * BRD 68 slice 1 (docs/initiatives/agent-control-tower.md). Same conventions
 * as AgentCatalogCard.test.tsx: graphqlRequest is routed by operation name.
 * DataTable body rows never materialize in jsdom (virtualized against a real
 * scroll-container height, which jsdom always reports as 0 — see
 * DataTable.test.tsx / AgentCatalogCard.test.tsx's header comment), so row
 * assertions target aria-rowcount + the (non-virtualized) sticky header row,
 * not individual cell text. Degradation-state assertions instead target
 * AgentFleetTiles, which renders as plain (non-virtualized) DOM.
 */
let handler: (doc: string, vars: any) => any = () => ({});
const requests: { doc: string; vars: any }[] = [];
vi.mock("@/lib/graphql/client", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/graphql/client")>();
  return {
    ...actual,
    graphqlRequest: (doc: string, vars: any) => {
      requests.push({ doc, vars });
      return Promise.resolve(handler(doc, vars));
    },
  };
});

import { AgentFleetTable, AgentFleetTiles } from "./AgentFleetTable";

const ADMIN_VIEWER = {
  me: { userId: "u-1", tenantId: "t-42", type: "user", scopes: [], roles: ["Admin"], capabilities: ["*"], capsDegraded: false },
};

/** A tenant custom role holding ai.agent.read but NOT usage.report.read —
 * exercises the FEATURE_GATES.viewAgentFleetSpend gate without the Admin
 * role short-circuit (allows() passes every gate for isAdmin). */
const NO_SPEND_VIEWER = {
  me: { userId: "u-2", tenantId: "t-42", type: "user", scopes: [], roles: ["RiskOfficer"], capabilities: ["ai.agent.read"], capsDegraded: false },
};

const FLEET_ROW = {
  key: "case-triage", kind: "PLATFORM", display: "Case Triage", lifecycle: "ACTIVE",
  activeVersion: { id: 1, graphDigest: "sha256:aaa", rollout: "UNKNOWN" },
  guardrails: { dataScope: null, tokenBudget: null, piiEgress: null, ruleOfTwo: true },
  toolset: ["tool.read_case"],
  evalGate: { status: "PASS", lastRunAt: "2026-07-24T00:05:00Z", suiteKey: "suite-core", unavailable: false },
  killSwitch: { id: null, state: "active", updatedAt: null, actor: null },
  spend: { periodUsd: 12.5, trend7dPct: 25, unavailable: false },
  decisions: { proposed: null, approved: null, edited: null, rejected: null, period: "2026-06-25/2026-07-25", unavailable: true },
  lastIncidentAt: null,
  external: null,
  liveUpdates: { hubUrl: "http://localhost:9020", topics: ["list:agent"] },
};

const DEGRADED_ROW = {
  ...FLEET_ROW,
  key: "acme-custom-1", kind: "CUSTOM", display: "Acme Custom",
  evalGate: { status: "NONE", lastRunAt: null, suiteKey: null, unavailable: true },
  spend: { periodUsd: null, trend7dPct: null, unavailable: true },
};

function baseHandler(overrides: Partial<Record<string, () => any>> = {}) {
  return (doc: string) => {
    if (doc.includes("query Me")) return overrides.me ? overrides.me() : ADMIN_VIEWER;
    if (doc.includes("query AgentFleetSummary")) {
      return overrides.summary
        ? overrides.summary()
        : { agentFleetSummary: { totalByKind: { platform: 1, custom: 1, external: 0 }, activeCount: 1, killedCount: 1, quarantinedCount: 0, periodSpendUsd: 12.5, periodDecisions: null } };
    }
    if (doc.includes("query AgentFleet")) {
      return overrides.fleet ? overrides.fleet() : { agentFleet: [FLEET_ROW, DEGRADED_ROW] };
    }
    return {};
  };
}

beforeEach(() => {
  requests.length = 0;
  handler = baseHandler();
});

describe("AgentFleetTable: renders rows (AC-1)", () => {
  it("reflects the fetched fleet row count in the grid and requests the spend field group as an admin", async () => {
    renderWithProviders(<AgentFleetTable />);
    await waitFor(() => {
      expect(screen.getByRole("grid", { name: "Fleet" })).toHaveAttribute("aria-rowcount", "2");
    });
    // Admin passes viewAgentFleetSpend -> includeSpend=true -> the WITH_SPEND document.
    await waitFor(() => {
      expect(requests.some((r) => r.doc.includes("query AgentFleet") && r.doc.includes("spend {"))).toBe(true);
    });
    // Spend column header is present (capability gate open).
    expect(screen.getByText("Spend (period)")).toBeInTheDocument();
  });
});

describe("AgentFleetTable: gated column hidden without capability (AC-5)", () => {
  it("hides the spend column and omits the spend field from the query for a viewer without usage.report.read", async () => {
    handler = baseHandler({ me: () => NO_SPEND_VIEWER });
    renderWithProviders(<AgentFleetTable />);
    await waitFor(() => {
      expect(screen.getByRole("grid", { name: "Fleet" })).toHaveAttribute("aria-rowcount", "2");
    });
    expect(screen.queryByText("Spend (period)")).not.toBeInTheDocument();
    const fleetCall = requests.find((r) => r.doc.includes("query AgentFleet") && !r.doc.includes("AgentFleetSummary"));
    expect(fleetCall?.doc.includes("spend {")).toBe(false);
    // Decisions is always unavailable in slice 1 regardless of capability —
    // that column stays visible (no capability gate on it).
    expect(screen.getByText("Decisions")).toBeInTheDocument();
  });
});

describe("AgentFleetTiles: degraded columns show the unavailable state (ACT-NFR-004)", () => {
  it("shows 'unavailable' for period decisions (permanent slice-1 gap) and real totals for kind/state counts", async () => {
    renderWithProviders(<AgentFleetTiles />);
    await waitFor(() => {
      expect(screen.getAllByText("unavailable").length).toBeGreaterThanOrEqual(1);
    });
    expect(screen.getByText("Period decisions")).toBeInTheDocument();
    expect(screen.getAllByText("1")).toHaveLength(2); // activeCount + killedCount, both 1
  });

  it("shows 'unavailable' for period spend (never a fabricated $0) when usage-service is degraded", async () => {
    handler = baseHandler({
      summary: () => ({ agentFleetSummary: { totalByKind: { platform: 2 }, activeCount: 2, killedCount: 0, quarantinedCount: 0, periodSpendUsd: null, periodDecisions: null } }),
    });
    renderWithProviders(<AgentFleetTiles />);
    await waitFor(() => {
      // Both the period-spend tile and the (always-unavailable) decisions tile read "unavailable".
      expect(screen.getAllByText("unavailable").length).toBe(2);
    });
    expect(screen.getByText("Period spend")).toBeInTheDocument();
  });
});
