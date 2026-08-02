import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "@/test/utils";

/** graphqlRequest routed by operation name; viewer is a full admin. DataTable
 * rows never materialize in jsdom (virtualized) — assertions target request
 * variables + aria-rowcount (repo convention). */
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

import { RetrainWatchesCard } from "./RetrainWatchesCard";

const meResult = {
  me: { userId: "u-1", tenantId: "t-42", type: "user", scopes: [], roles: ["Admin"], capabilities: ["*"], capsDegraded: false },
};

const WATCH = {
  id: "w-1", modelUrn: "urn:dc:model:fraud-scorer:3", watchedAgentKey: "case-triage",
  workspaceId: "ws-1", cadenceSeconds: 86400, correctionWindowHours: 168,
  driftThreshold: 0.3, minCorrections: 20, enabled: true,
  lastCheckedAt: "2026-08-01T00:00:00Z", lastSignal: { ratio: 0.1 }, createdBy: "u-1",
};

beforeEach(() => {
  requests.length = 0;
  handler = (doc: string) => {
    if (doc.includes("query Me")) return meResult;
    if (doc.includes("query RetrainWatches")) return { retrainWatches: [WATCH] };
    if (doc.includes("mutation CreateRetrainWatch")) return { createRetrainWatch: WATCH };
    return {};
  };
});

describe("RetrainWatchesCard (BRD 52 inc3 drift thresholds)", () => {
  it("lists the tenant's watches and reflects the row count in the grid", async () => {
    renderWithProviders(<RetrainWatchesCard />);
    await waitFor(() => {
      expect(screen.getByRole("grid", { name: "Retrain watches" })).toHaveAttribute("aria-rowcount", "1");
    });
    expect(requests.some((r) => r.doc.includes("query RetrainWatches"))).toBe(true);
  });

  it("creates a watch with the drift threshold converted from % to a ratio", async () => {
    const user = userEvent.setup();
    renderWithProviders(<RetrainWatchesCard />);
    await user.click(await screen.findByRole("button", { name: "New watch" }));
    await user.type(screen.getByLabelText("Model URN"), "urn:dc:model:fraud-scorer:3");
    await user.type(screen.getByLabelText("Watched agent key"), "case-triage");
    await user.click(screen.getByRole("button", { name: "Create watch" }));

    await waitFor(() => {
      const create = requests.find((r) => r.doc.includes("mutation CreateRetrainWatch"));
      expect(create?.vars.input).toMatchObject({
        modelUrn: "urn:dc:model:fraud-scorer:3", watchedAgentKey: "case-triage",
        driftThreshold: 0.3, minCorrections: 20, correctionWindowHours: 168,
      });
      expect(create?.vars.idempotencyKey).toBeTruthy();
    });
  });
});
