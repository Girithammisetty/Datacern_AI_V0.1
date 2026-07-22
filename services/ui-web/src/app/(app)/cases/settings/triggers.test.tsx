import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "@/test/utils";

/** Route graphqlRequest by operation name to a per-test handler. */
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

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

// Replace the virtualizer with a full-render stand-in so DataTable rows exist
// in jsdom (same idiom as InferenceSchedulesPanel.test.tsx).
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 44,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({ index, key: index, start: index * 44, size: 44 })),
    scrollToIndex: () => {},
    measureElement: () => {},
  }),
}));

import CaseSettingsPage from "./page";

const meResult = {
  me: {
    userId: "u", tenantId: "t-42", type: "user", scopes: [],
    roles: ["Admin"], capabilities: ["*"], capsDegraded: false,
  },
};

const trigger = {
  id: "trg-1",
  workspaceId: "ws-1",
  name: "High-value auto claims",
  enabled: true,
  datasetUrn: null,
  datasetName: "auto-claims",
  conditions: [{ col: "amount", op: "gt", value: "5000" }],
  rowPkField: "claim_id",
  severity: "high",
  dueHours: 48,
  projectionFields: ["claim_id", "amount"],
  maxCasesPerEvent: 100,
  createdById: "u",
  createdAt: "2026-07-21T00:00:00Z",
  updatedAt: "2026-07-21T00:00:00Z",
};

beforeEach(() => {
  requests.length = 0;
  handler = (doc: string) => {
    if (doc.includes("query Me")) return meResult;
    if (doc.includes("query CaseTriggers")) return { caseTriggers: [trigger] };
    if (doc.includes("query Dispositions")) return { dispositions: [] };
    if (doc.includes("query CaseFields")) return { caseFields: [] };
    if (doc.includes("query CaseSchemas")) return { caseSchemas: [] };
    if (doc.includes("query Users")) return { users: { nodes: [], pageInfo: { nextCursor: null, hasMore: false } } };
    if (doc.includes("mutation CreateCaseTrigger")) {
      return { createCaseTrigger: { ...trigger, id: "trg-2", name: "New trigger" } };
    }
    if (doc.includes("mutation UpdateCaseTrigger")) {
      return { updateCaseTrigger: { ...trigger, enabled: false } };
    }
    return {};
  };
});

describe("cases settings — Triggers tab", () => {
  it("lists triggers with source, conditions and status", async () => {
    renderWithProviders(<CaseSettingsPage />);
    await userEvent.click(await screen.findByRole("tab", { name: "Triggers" }));

    expect(await screen.findByText("High-value auto claims")).toBeInTheDocument();
    expect(screen.getByText("auto-claims")).toBeInTheDocument();
    expect(screen.getByText("amount gt 5000")).toBeInTheDocument();
    expect(screen.getByText("enabled")).toBeInTheDocument();
    expect(screen.getByText("48h")).toBeInTheDocument();
  });

  it("creates a trigger through the dialog (mutation carries the form fields)", async () => {
    renderWithProviders(<CaseSettingsPage />);
    await userEvent.click(await screen.findByRole("tab", { name: "Triggers" }));
    await userEvent.click(await screen.findByRole("button", { name: "New trigger" }));

    await userEvent.type(screen.getByLabelText("Name"), "New trigger");
    await userEvent.type(screen.getByLabelText("Dataset name"), "denials");
    await userEvent.type(screen.getByLabelText("Row ID column"), "claim_id");
    await userEvent.click(screen.getByRole("button", { name: "Add condition" }));
    await userEvent.type(screen.getByLabelText("Condition 1 column"), "status");
    await userEvent.type(screen.getByLabelText("Condition 1 value"), "denied");
    await userEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => {
      const call = requests.find((r) => r.doc.includes("mutation CreateCaseTrigger"));
      expect(call).toBeTruthy();
      expect(call!.vars.input).toMatchObject({
        name: "New trigger",
        datasetName: "denials",
        rowPkField: "claim_id",
        conditions: [{ col: "status", op: "eq", value: "denied" }],
      });
    });
  });

  it("pauses a trigger via the row action", async () => {
    renderWithProviders(<CaseSettingsPage />);
    await userEvent.click(await screen.findByRole("tab", { name: "Triggers" }));
    await userEvent.click(await screen.findByRole("button", { name: "Pause" }));

    await waitFor(() => {
      const call = requests.find((r) => r.doc.includes("mutation UpdateCaseTrigger"));
      expect(call).toBeTruthy();
      expect(call!.vars.input).toMatchObject({ id: "trg-1", enabled: false });
    });
  });
});
