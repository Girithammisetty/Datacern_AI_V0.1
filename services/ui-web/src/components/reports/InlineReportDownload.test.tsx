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
  it("is true only for reports with a builder wired", () => {
    expect(hasInlineRunner("chargeback")).toBe(true);
    expect(hasInlineRunner("agent-inventory")).toBe(true);
    expect(hasInlineRunner("value-roi")).toBe(false);
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
