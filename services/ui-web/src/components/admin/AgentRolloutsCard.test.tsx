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

import { AgentRolloutsCard } from "./AgentRolloutsCard";

const meResult = {
  me: { userId: "u-1", tenantId: "t-42", type: "user", scopes: [], roles: ["Admin"], capabilities: ["*"], capsDegraded: false },
};

const rollouts = {
  agentRollouts: [
    { rolloutId: "r-1", agentKey: "case-triage", cell: "dev", mode: "canary",
      candidateVersion: 3, baselineVersion: 2, pct: 10, tenantFilter: {}, status: "active" },
    { rolloutId: "r-2", agentKey: "analytics", cell: "dev", mode: "shadow",
      candidateVersion: 2, baselineVersion: 1, pct: 0, tenantFilter: {}, status: "promoted" },
  ],
};

beforeEach(() => {
  requests.length = 0;
  handler = (doc: string) => {
    if (doc.includes("query Me")) return meResult;
    if (doc.includes("query AgentRollouts")) return rollouts;
    if (doc.includes("mutation StartAgentRollout"))
      return { startAgentRollout: { rolloutId: "r-new", status: "active" } };
    return {};
  };
});

describe("AgentRolloutsCard (Control Tower rollout management)", () => {
  it("lists the rollout records and reflects the row count in the grid", async () => {
    renderWithProviders(<AgentRolloutsCard />);
    await waitFor(() => {
      expect(screen.getByRole("grid", { name: "Rollouts" })).toHaveAttribute("aria-rowcount", "2");
    });
    expect(requests.some((r) => r.doc.includes("query AgentRollouts"))).toBe(true);
  });

  it("starts a canary rollout with the filled candidate/baseline/pct", async () => {
    const user = userEvent.setup();
    renderWithProviders(<AgentRolloutsCard />);
    await user.click(await screen.findByRole("button", { name: "Start rollout" }));
    await user.type(screen.getByLabelText("Agent key"), "case-triage");
    await user.type(screen.getByLabelText("Candidate version"), "3");
    await user.type(screen.getByLabelText("Baseline version"), "2");
    await user.type(screen.getByLabelText("Traffic percent"), "10");
    await user.click(screen.getByRole("button", { name: "Start rollout" }));

    await waitFor(() => {
      const start = requests.find((r) => r.doc.includes("mutation StartAgentRollout"));
      expect(start?.vars.input).toMatchObject({
        agentKey: "case-triage", mode: "canary", candidateVersion: 3, baselineVersion: 2, pct: 10,
      });
      expect(start?.vars.idempotencyKey).toBeTruthy();
    });
  });
});
