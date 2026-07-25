import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "@/test/utils";

/**
 * Same convention as admin/usage/usage.test.tsx: graphqlRequest is routed by
 * operation name, capabilities come from the mocked `me` result (the real
 * Can/useCapabilities wiring, not a hook mock — proves the actual gate).
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

import AdminValuePage from "./page";

const ADMIN = { userId: "u-1", tenantId: "t-42", type: "user", scopes: [], roles: ["Admin"], capabilities: ["*"], capsDegraded: false };
const READ_ONLY = {
  userId: "u-2", tenantId: "t-42", type: "user", scopes: [], roles: ["CSM"],
  capabilities: ["usage.report.read"], capsDegraded: false,
};

const POPULATED_SUMMARY = {
  valueSummary: {
    period: "2026-07", workspaceId: null,
    decisions: {
      total: 12340,
      byDecision: { approved: 11800, edited: 420, rejected: 120 },
      byKind: { claims_disposition: 12340 },
      byAgent: { "claims-copilot": 12340 },
      byPack: { "insurance-claims-payer": 12340 },
    },
    hoursSavedEst: { value: 4113.3, assumptionVersion: 1 },
    laborValueEstUsd: { value: 740400, assumptionVersion: 1 },
    aiCostUsd: 812.44,
    costPerDecision: { value: 0.0658, basis: "blended" },
    humanBaselineCostUsd: { value: 740400, assumptionVersion: 1 },
    netValueEstUsd: { value: 739587.56, assumptionVersion: 1 },
    ladderSavingsUsd: null,
    adoption: { activeUsers: 84, byWorkspace: { "ws-7": 40, "ws-9": 44 } },
    provenance: { rollupVersion: "usage_monthly@2026-07-finalized", assumptionVersion: 1, meterGap: null },
  },
};

const GAP_SUMMARY = {
  valueSummary: {
    period: "2026-01", workspaceId: null,
    decisions: null,
    hoursSavedEst: null, laborValueEstUsd: null,
    aiCostUsd: 0, costPerDecision: null, humanBaselineCostUsd: null, netValueEstUsd: null,
    ladderSavingsUsd: null,
    adoption: { activeUsers: 0, byWorkspace: {} },
    provenance: {
      rollupVersion: "usage_monthly@2026-01-open", assumptionVersion: null,
      meterGap: "governed_decision meter not emitted yet (BRD 67 VMB-FR-001)",
    },
  },
};

const EMPTY_TREND = { valueTrend: { metric: "cost_per_decision", granularity: "month", points: [] } };
const EMPTY_EXPORTS = { valueExports: [] };

function baseHandler(opts: { me?: any; summary?: any; assumptions?: any; history?: any } = {}) {
  const me = opts.me ?? ADMIN;
  return (doc: string, vars: any) => {
    if (doc.includes("query Me")) return { me };
    if (doc.includes("query ValueSummary")) return opts.summary ?? POPULATED_SUMMARY;
    if (doc.includes("query ValueTrend")) return EMPTY_TREND;
    if (doc.includes("query ValueAssumptions")) return opts.assumptions ?? { valueAssumptions: null };
    if (doc.includes("query ValueAssumptionHistory")) return opts.history ?? { valueAssumptionHistory: [] };
    if (doc.includes("query ValueExports")) return EMPTY_EXPORTS;
    if (doc.includes("mutation UpdateValueAssumptions")) {
      return {
        updateValueAssumptions: {
          id: "va-1", urn: "wr:t-42:usage:value_assumptions/va-1", version: 1,
          minutesPerDecision: vars.input.minutesPerDecision, loadedHourlyRateUsd: vars.input.loadedHourlyRateUsd,
          effectiveFrom: "2026-07-25", status: "active", createdBy: "u-1", createdAt: "2026-07-25T00:00:00Z",
        },
      };
    }
    if (doc.includes("mutation ExportValueReport")) {
      return {
        exportValueReport: {
          id: "ve-1", urn: "wr:t-42:usage:value_export/ve-1", period: vars.period, workspaceId: null, version: 1,
          jsonUrl: "https://x/report.json", jsonSha256: "abc", csvUrl: "https://x/report.csv", csvSha256: "def",
          assumptionVersion: 1, createdAt: "2026-08-01T00:00:00Z",
        },
      };
    }
    return {};
  };
}

beforeEach(() => {
  requests.length = 0;
  handler = baseHandler();
});

describe("Admin Value page — populated tiles", () => {
  it("renders decisions, hours saved, cost/decision and net value from valueSummary", async () => {
    renderWithProviders(<AdminValuePage />);
    expect(await screen.findByText("12,340")).toBeInTheDocument(); // decisions.total
    expect(screen.getByText("4,113.3")).toBeInTheDocument(); // hoursSavedEst
    expect(screen.getAllByText(/assumption v1/).length).toBeGreaterThan(0);
  });
});

describe("Admin Value page — Tier-0/gap empty states (assumptions unset, decisions null)", () => {
  it("shows the honest empty states instead of a fabricated zero", async () => {
    handler = baseHandler({ summary: GAP_SUMMARY });
    renderWithProviders(<AdminValuePage />);

    // Decisions + cost/decision tiles both surface the meter_gap hint.
    expect((await screen.findAllByText(/governed_decision meter not emitted yet/)).length).toBeGreaterThanOrEqual(1);
    // Hours-saved tile: empty, "set assumptions" hint.
    expect(screen.getByText("Set assumptions below to see hours saved.")).toBeInTheDocument();
    // Net-value tile: empty, "set assumptions" hint.
    expect(screen.getByText("Set assumptions below to see net value.")).toBeInTheDocument();
    // No fabricated numbers rendered anywhere for these fields.
    expect(screen.queryByText("0")).not.toBeInTheDocument();
  });

  it("decision-mix chart shows its own empty state when decisions is null", async () => {
    handler = baseHandler({ summary: GAP_SUMMARY });
    renderWithProviders(<AdminValuePage />);
    expect(await screen.findByText("No decision breakdown yet.")).toBeInTheDocument();
  });
});

describe("Admin Value page — assumptions panel empty state", () => {
  it("shows the unset-assumptions empty state and never a default rate", async () => {
    renderWithProviders(<AdminValuePage />);
    expect(await screen.findByText("No assumptions set.")).toBeInTheDocument();
    expect(screen.queryByText(/\$0\.00\/hr/)).not.toBeInTheDocument();
  });
});

describe("Admin Value page — assumption edit gating (manageValueAssumptions)", () => {
  it("admin (capabilities: *) sees the Set assumptions control", async () => {
    renderWithProviders(<AdminValuePage />);
    expect(await screen.findByRole("button", { name: "Set assumptions" })).toBeInTheDocument();
  });

  it("a usage.report.read-only viewer (AC-5) does NOT see the edit control", async () => {
    handler = baseHandler({ me: READ_ONLY });
    renderWithProviders(<AdminValuePage />);
    // Page itself still renders (read gate is separate) — tiles show.
    expect(await screen.findByText("12,340")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Set assumptions" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit" })).not.toBeInTheDocument();
  });

  it("submitting the assumptions form calls updateValueAssumptions with parsed minutes", async () => {
    const user = userEvent.setup();
    renderWithProviders(<AdminValuePage />);
    await user.click(await screen.findByRole("button", { name: "Set assumptions" }));
    await user.type(screen.getByLabelText("Loaded hourly rate USD"), "180");
    await user.type(screen.getByLabelText("Minutes per decision kind"), "claims_disposition=20");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      const call = requests.find((r) => r.doc.includes("mutation UpdateValueAssumptions"));
      expect(call?.vars.input).toMatchObject({
        loadedHourlyRateUsd: 180,
        minutesPerDecision: { claims_disposition: 20 },
      });
    });
  });
});

describe("Admin Value page — export", () => {
  it("exportValueReport is called with the selected period", async () => {
    const user = userEvent.setup();
    renderWithProviders(<AdminValuePage />);
    await user.click(await screen.findByRole("button", { name: "Export this period" }));

    await waitFor(() => {
      const call = requests.find((r) => r.doc.includes("mutation ExportValueReport"));
      expect(call?.vars.period).toBeTruthy();
    });
  });
});
