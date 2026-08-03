import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "@/test/utils";

let capabilities: string[] = [];
let roles: string[] = [];
vi.mock("@/lib/graphql/client", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/graphql/client")>();
  return {
    ...actual,
    graphqlRequest: async (doc: string) => {
      if (/query Me\b/.test(doc)) {
        return { me: { userId: "u", tenantId: "t-acme", type: "user", scopes: [],
                       roles, capabilities, capsDegraded: false } };
      }
      return {};
    },
  };
});

import { OnboardingChecklist } from "./OnboardingChecklist";

beforeEach(() => {
  window.localStorage.clear();
  capabilities = ["case.case.read", "ai.proposal.read", "chart.dashboard.read"];
  roles = ["Case Analyst"];
});

describe("OnboardingChecklist (role-aware getting started)", () => {
  it("shows the analyst track only, and checking off a step persists", async () => {
    const user = userEvent.setup();
    renderWithProviders(<OnboardingChecklist />);

    expect(await screen.findByText("Open your worklist")).toBeInTheDocument();
    // Analyst never sees admin/data setup steps.
    expect(screen.queryByText("Install a capability pack")).not.toBeInTheDocument();
    expect(screen.queryByText("Connect a data source")).not.toBeInTheDocument();
    // The glossary step rides along for everyone.
    expect(screen.getByText("Learn the words")).toBeInTheDocument();
    expect(screen.getByText(/0 of \d+ done/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: 'Mark "Open your worklist" as done' }));
    expect(screen.getByText(/1 of \d+ done/)).toBeInTheDocument();
    // Persisted per (tenant, user) in localStorage.
    const stored = JSON.parse(window.localStorage.getItem("datacern.onboarding.t-acme.u")!);
    expect(stored.done).toContain("open-worklist");
  });

  it("Hide dismisses the card for good", async () => {
    const user = userEvent.setup();
    renderWithProviders(<OnboardingChecklist />);
    await screen.findByTestId("onboarding-checklist");

    await user.click(screen.getByRole("button", { name: "Hide getting started" }));
    expect(screen.queryByTestId("onboarding-checklist")).not.toBeInTheDocument();
    const stored = JSON.parse(window.localStorage.getItem("datacern.onboarding.t-acme.u")!);
    expect(stored.dismissed).toBe(true);
  });

  it("disappears on its own once every step is checked off", async () => {
    // Pre-complete everything the analyst track shows (incl. the glossary step).
    window.localStorage.setItem(
      "datacern.onboarding.t-acme.u",
      JSON.stringify({ done: ["open-worklist", "review-proposal", "ask-copilot",
                             "open-dashboards", "learn-words"], dismissed: false }),
    );
    renderWithProviders(<OnboardingChecklist />);
    // Give the caps query a tick, then assert the card never appears.
    await waitFor(() => expect(screen.queryByTestId("onboarding-checklist")).not.toBeInTheDocument());
  });
});
