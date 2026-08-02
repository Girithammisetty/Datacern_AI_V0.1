import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "@/test/utils";

// downloadCsv's Blob/anchor side effect is exercised in lib/export/csv.test.ts;
// here we only assert WHAT the runner hands to it.
const { downloadCsvMock } = vi.hoisted(() => ({ downloadCsvMock: vi.fn() }));
vi.mock("@/lib/export/csv", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/export/csv")>();
  return { ...actual, downloadCsv: downloadCsvMock };
});

// graphqlRequest routed by operation text (same idiom as AgentFleetTable.test).
let handler: (doc: string, vars: any) => any = () => ({});
vi.mock("@/lib/graphql/client", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/graphql/client")>();
  return { ...actual, graphqlRequest: (doc: string, vars: any) => Promise.resolve(handler(doc, vars)) };
});

import { INLINE_RUNNERS, hasInlineRunner } from "./InlineReportDownload";

const Chargeback = INLINE_RUNNERS.chargeback;
const AgentInventory = INLINE_RUNNERS["agent-inventory"];
const ValueRoi = INLINE_RUNNERS["value-roi"];
const BillingPeriods = INLINE_RUNNERS["billing-periods"];

function billingPeriod() {
  return {
    id: "bp-1", urn: "urn:x", period: "2026-06", version: 1,
    rateCardId: "rc-1", rateCardVersion: 3, grossUsd: 1200.5, netBillableUsd: 1150.25,
    status: "exported", closedAt: "2026-07-01T00:00:00Z", closedBy: "u-close",
    export: { csvKey: "s3://bill.csv", csvSha256: "bb", jsonlKey: "s3://bill.jsonl", jsonlSha256: "aa",
      pushedStatus: "pushed", pushedReference: "in_123", pushedAt: "2026-07-01T01:00:00Z", createdAt: "2026-07-01T00:30:00Z" },
  };
}

function valueSummary() {
  return {
    period: "2026-07", workspaceId: null,
    decisions: { total: 842, byDecision: {}, byKind: {}, byAgent: {}, byPack: {} },
    hoursSavedEst: { value: 120, assumptionVersion: 3 },
    laborValueEstUsd: { value: 9000, assumptionVersion: 3 },
    aiCostUsd: 1234.56,
    costPerDecision: { value: 1.47, basis: "blended" },
    humanBaselineCostUsd: { value: 15000, assumptionVersion: 3 },
    netValueEstUsd: { value: 7765.44, assumptionVersion: 3 },
    ladderSavingsUsd: 42, adoption: {}, provenance: {},
  };
}

function chargebackRow() {
  return {
    tenantId: "t-1", workspaceId: "ws-7", month: "2026-07", meterKey: "governed_decision",
    quantity: 842, rateCardId: "rc-1", pricePerUnitUsd: 0.08, usd: 67.36, adjustmentsUsd: 0, totalUsd: 67.36,
  };
}

beforeEach(() => {
  downloadCsvMock.mockClear();
  handler = () => ({});
});

describe("hasInlineRunner", () => {
  it("is true only for reports with an inline runner wired", () => {
    expect(hasInlineRunner("chargeback")).toBe(true);
    expect(hasInlineRunner("agent-inventory")).toBe(true);
    expect(hasInlineRunner("value-roi")).toBe(true);
    expect(hasInlineRunner("billing-periods")).toBe(true);
    expect(hasInlineRunner("case-export")).toBe(true);
    // chart-export needs a chart selection; evidence/compliance are point reads.
    expect(hasInlineRunner("dashboard-chart")).toBe(false);
    expect(hasInlineRunner("evidence-pack")).toBe(false);
  });
});

describe("InlineChargebackDownload", () => {
  it("fetches the selected month and downloads a CSV of the rows", async () => {
    const seen: { doc: string; vars: any }[] = [];
    handler = (doc, vars) => {
      seen.push({ doc, vars });
      if (doc.includes("chargebackReport")) return { chargebackReport: [chargebackRow()] };
      return {};
    };
    renderWithProviders(<Chargeback />);
    await userEvent.click(screen.getByRole("button", { name: /download csv/i }));

    await waitFor(() => expect(downloadCsvMock).toHaveBeenCalledTimes(1));
    const [filename, csv] = downloadCsvMock.mock.calls[0];
    expect(filename).toBe("chargeback-2026-07.csv"); // default = previous month
    expect(csv).toContain("governed_decision");
    expect(csv).toContain("TOTAL");
    // Fetched with the month variable.
    expect(seen.some((r) => r.doc.includes("chargebackReport") && r.vars.month === "2026-07")).toBe(true);
  });

  it("does NOT download when the month has no rows (toasts instead)", async () => {
    handler = (doc) => (doc.includes("chargebackReport") ? { chargebackReport: [] } : {});
    renderWithProviders(<Chargeback />);
    await userEvent.click(screen.getByRole("button", { name: /download csv/i }));

    // Give the async handler a tick; assert no download happened.
    await waitFor(() => expect(screen.getByRole("button", { name: /download csv/i })).toBeEnabled());
    expect(downloadCsvMock).not.toHaveBeenCalled();
  });
});

describe("InlineValueDownload", () => {
  it("fetches the value summary and downloads a ROI CSV", async () => {
    handler = (doc) => (doc.includes("valueSummary") ? { valueSummary: valueSummary() } : {});
    renderWithProviders(<ValueRoi />);
    await userEvent.click(screen.getByRole("button", { name: /download csv/i }));

    await waitFor(() => expect(downloadCsvMock).toHaveBeenCalledTimes(1));
    const [filename, csv] = downloadCsvMock.mock.calls[0];
    expect(filename).toBe("value-report-2026-07.csv");
    expect(csv).toContain("Governed decisions,842,measured");
    expect(csv).toContain("Net value (est USD),7765.44,assumption v3");
  });
});

describe("InlineBillingPeriodsDownload", () => {
  it("fetches all closed periods and downloads a CSV", async () => {
    handler = (doc) => (doc.includes("billingPeriods") ? { billingPeriods: [billingPeriod()] } : {});
    renderWithProviders(<BillingPeriods />);
    await userEvent.click(screen.getByRole("button", { name: /download csv/i }));

    await waitFor(() => expect(downloadCsvMock).toHaveBeenCalledTimes(1));
    const [filename, csv] = downloadCsvMock.mock.calls[0];
    expect(filename).toBe("billing-periods.csv");
    expect(csv).toContain("2026-06,1,exported,1200.50,1150.25");
    expect(csv).toContain("pushed,in_123");
  });

  it("does NOT download when no periods are closed yet (toasts instead)", async () => {
    handler = (doc) => (doc.includes("billingPeriods") ? { billingPeriods: [] } : {});
    renderWithProviders(<BillingPeriods />);
    await userEvent.click(screen.getByRole("button", { name: /download csv/i }));

    await waitFor(() => expect(screen.getByRole("button", { name: /download csv/i })).toBeEnabled());
    expect(downloadCsvMock).not.toHaveBeenCalled();
  });
});

describe("InlineAgentInventoryDownload", () => {
  it("calls the agent-fleet query and does not download when there are no agents", async () => {
    const seen: string[] = [];
    handler = (doc) => {
      seen.push(doc);
      if (doc.includes("agentFleet")) return { agentFleet: [] };
      return {};
    };
    renderWithProviders(<AgentInventory />);
    await userEvent.click(screen.getByRole("button", { name: /download csv/i }));

    await waitFor(() => expect(seen.some((d) => d.includes("agentFleet"))).toBe(true));
    expect(downloadCsvMock).not.toHaveBeenCalled();
  });
});
