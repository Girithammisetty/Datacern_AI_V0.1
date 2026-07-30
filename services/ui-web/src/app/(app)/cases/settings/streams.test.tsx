import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "@/test/utils";
import { GraphQLRequestError } from "@/lib/graphql/client";

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

const stream = {
  id: "cs-1",
  name: "high-value-orders",
  status: "active",
  connectionId: "conn-1",
  scheduleId: "sch-9",
  caseTriggerId: "trg-7",
  workspaceId: "ws-1",
  schedule: {
    interval_seconds: 300,
    next_fire_at: "2026-07-30T04:05:00Z",
    watermark: { column: "updated_at", operator: ">", current_value: "2026-07-30T03:55:00Z" },
    enabled: true,
  },
  createdAt: "2026-07-30T04:00:00Z",
  updatedAt: "2026-07-30T04:00:00Z",
};

// The verbatim commercial refusal ingestion-service emits (slice 3) — the UI
// must show exactly this, not a softened generic error.
const SKU_REFUSAL =
  "case streams require the realtime-case-streams add-on (feature entitlement " +
  "'realtime_case_streams'); contact your administrator to enable the SKU for this tenant";

beforeEach(() => {
  requests.length = 0;
  handler = (doc: string) => {
    if (doc.includes("query Me")) return meResult;
    if (doc.includes("query CaseStreams")) return { caseStreams: [stream] };
    if (doc.includes("query Connections")) {
      return { connections: { nodes: [{ id: "conn-1", name: "ERP Postgres" }], pageInfo: { nextCursor: null, hasMore: false } } };
    }
    if (doc.includes("query Dispositions")) return { dispositions: [] };
    if (doc.includes("query CaseFields")) return { caseFields: [] };
    if (doc.includes("query CaseSchemas")) return { caseSchemas: [] };
    if (doc.includes("query CaseTriggers")) return { caseTriggers: [] };
    if (doc.includes("query Users")) return { users: { nodes: [], pageInfo: { nextCursor: null, hasMore: false } } };
    if (doc.includes("mutation CreateCaseStream")) {
      return { createCaseStream: { ...stream, id: "cs-2" } };
    }
    if (doc.includes("mutation PauseCaseStream")) {
      return { pauseCaseStream: { ...stream, status: "paused" } };
    }
    if (doc.includes("mutation ResumeCaseStream")) {
      return { resumeCaseStream: stream };
    }
    return {};
  };
});

async function openStreamsTab() {
  renderWithProviders(<CaseSettingsPage />);
  await userEvent.click(await screen.findByRole("tab", { name: "Streams" }));
}

describe("cases settings — Streams tab (realtime-case-streams add-on)", () => {
  it("lists streams with status, live watermark cursor and trigger binding", async () => {
    await openStreamsTab();

    expect(await screen.findByText("high-value-orders")).toBeInTheDocument();
    expect(screen.getByText("active")).toBeInTheDocument();
    // The cursor is the proof the stream is reading incrementally, not re-scanning.
    expect(screen.getByText("2026-07-30T03:55:00Z")).toBeInTheDocument();
    expect(screen.getByText("bound")).toBeInTheDocument();
  });

  it("creates a stream: the mutation carries the query template, watermark and evidence-capturing trigger", async () => {
    await openStreamsTab();
    await userEvent.click(await screen.findByRole("button", { name: "New stream" }));

    await userEvent.type(screen.getByLabelText("Name"), "late-shipments");
    await userEvent.selectOptions(screen.getByLabelText("Connection"), "conn-1");
    await userEvent.type(screen.getByLabelText("Source statement"), "SELECT * FROM public.shipments");
    await userEvent.type(screen.getByLabelText("Target dataset name"), "shipments-stream");
    await userEvent.type(screen.getByLabelText("Watermark column"), "updated_at");
    await userEvent.type(screen.getByLabelText("Start from (initial watermark)"), "2026-07-01T00:00:00Z");
    await userEvent.click(screen.getByRole("button", { name: "Create stream" }));

    await waitFor(() => {
      const call = requests.find((r) => r.doc.includes("mutation CreateCaseStream"));
      expect(call).toBeTruthy();
      expect(call!.vars.idempotencyKey).toBeTruthy();
      expect(call!.vars.input).toMatchObject({
        name: "late-shipments",
        connectionId: "conn-1",
        ingestionTemplate: {
          ingestion_mode: "query",
          statement: "SELECT * FROM public.shipments",
          new_dataset: { name: "shipments-stream" },
        },
        intervalSeconds: 300,
        watermark: { column: "updated_at", valueType: "timestamp", initialValue: "2026-07-01T00:00:00Z" },
        trigger: { severity: "medium", attachEvidence: true },
      });
    });
  });

  it("shows the entitlement refusal verbatim (SKU named) instead of a generic error", async () => {
    const base = handler;
    handler = (doc, vars) => {
      if (doc.includes("mutation CreateCaseStream")) {
        throw new GraphQLRequestError(
          [{ message: SKU_REFUSAL, extensions: { code: "PERMISSION_DENIED" } }] as any, 403,
        );
      }
      return base(doc, vars);
    };
    await openStreamsTab();
    await userEvent.click(await screen.findByRole("button", { name: "New stream" }));

    await userEvent.type(screen.getByLabelText("Name"), "x");
    await userEvent.selectOptions(screen.getByLabelText("Connection"), "conn-1");
    await userEvent.type(screen.getByLabelText("Source statement"), "SELECT 1");
    await userEvent.type(screen.getByLabelText("Target dataset name"), "d");
    await userEvent.type(screen.getByLabelText("Watermark column"), "u");
    await userEvent.type(screen.getByLabelText("Start from (initial watermark)"), "0");
    await userEvent.click(screen.getByRole("button", { name: "Create stream" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(SKU_REFUSAL);
  });

  it("pauses a stream via the row action", async () => {
    await openStreamsTab();
    await userEvent.click(await screen.findByRole("button", { name: "Pause" }));

    await waitFor(() => {
      const call = requests.find((r) => r.doc.includes("mutation PauseCaseStream"));
      expect(call).toBeTruthy();
      expect(call!.vars.id).toBe("cs-1");
    });
  });
});
