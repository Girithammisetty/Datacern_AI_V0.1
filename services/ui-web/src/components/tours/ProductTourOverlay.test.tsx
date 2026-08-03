import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "@/test/utils";
import { useProductTour } from "@/stores/ui";

const push = vi.fn();
let pathname = "/";
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
  usePathname: () => pathname,
}));

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

import { ProductTourOverlay } from "./ProductTourOverlay";

beforeEach(() => {
  push.mockClear();
  pathname = "/";
  // The analyst persona: casework track + the universal glossary step = 5 steps.
  capabilities = ["case.case.read", "ai.proposal.read", "chart.dashboard.read"];
  roles = ["Case Analyst"];
  useProductTour.setState({ active: false, stepIndex: 0 });
});

describe("ProductTourOverlay (guided walk of the getting-started checklist)", () => {
  it("renders nothing while the tour is inactive", async () => {
    renderWithProviders(<ProductTourOverlay />);
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Product tour" })).not.toBeInTheDocument(),
    );
  });

  it("shows step 1 with its track kicker once started", async () => {
    useProductTour.setState({ active: true, stepIndex: 0 });
    renderWithProviders(<ProductTourOverlay />);

    expect(await screen.findByRole("dialog", { name: "Product tour" })).toBeInTheDocument();
    expect(screen.getByText(/Working cases — step 1 of 5/)).toBeInTheDocument();
    expect(screen.getByText("Open your worklist")).toBeInTheDocument();
    expect(screen.getByText(/the cases waiting on a decision/i)).toBeInTheDocument();
  });

  it("filters steps by capability — an analyst never tours admin setup", async () => {
    useProductTour.setState({ active: true, stepIndex: 0 });
    renderWithProviders(<ProductTourOverlay />);
    await screen.findByText(/step 1 of 5/);

    // 5 steps = 4 casework items + glossary; no data/admin tracks anywhere.
    const labels = ["Connect a data source", "Install a capability pack", "Invite your team"];
    for (const label of labels) expect(screen.queryByText(label)).not.toBeInTheDocument();
  });

  it("Next advances and navigates to the next step's page", async () => {
    const user = userEvent.setup();
    useProductTour.setState({ active: true, stepIndex: 0 });
    renderWithProviders(<ProductTourOverlay />);
    await screen.findByText("Open your worklist");

    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(await screen.findByText("Review an AI proposal")).toBeInTheDocument();
    expect(screen.getByText(/step 2 of 5/)).toBeInTheDocument();
    expect(push).toHaveBeenCalledWith("/inbox");
  });

  it("Back returns to the previous step and its page", async () => {
    const user = userEvent.setup();
    useProductTour.setState({ active: true, stepIndex: 1 });
    renderWithProviders(<ProductTourOverlay />);
    await screen.findByText("Review an AI proposal");

    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(await screen.findByText("Open your worklist")).toBeInTheDocument();
    expect(push).toHaveBeenCalledWith("/cases");
  });

  it("offers 'Go to this step' only when off the step's route", async () => {
    const user = userEvent.setup();
    pathname = "/cases";
    useProductTour.setState({ active: true, stepIndex: 0 });
    const { unmount } = renderWithProviders(<ProductTourOverlay />);
    await screen.findByText("Open your worklist");
    expect(screen.queryByRole("button", { name: "Go to this step" })).not.toBeInTheDocument();
    unmount();

    pathname = "/somewhere-else";
    renderWithProviders(<ProductTourOverlay />);
    const go = await screen.findByRole("button", { name: "Go to this step" });
    await user.click(go);
    expect(push).toHaveBeenCalledWith("/cases");
  });

  it("the last step says Finish and finishing ends the tour", async () => {
    const user = userEvent.setup();
    useProductTour.setState({ active: true, stepIndex: 4 });
    renderWithProviders(<ProductTourOverlay />);

    expect(await screen.findByText("Learn the words")).toBeInTheDocument();
    expect(screen.getByText(/step 5 of 5/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Finish" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Product tour" })).not.toBeInTheDocument(),
    );
    expect(useProductTour.getState().active).toBe(false);
  });

  it("the close button ends the tour without navigating", async () => {
    const user = userEvent.setup();
    useProductTour.setState({ active: true, stepIndex: 0 });
    renderWithProviders(<ProductTourOverlay />);
    await screen.findByText("Open your worklist");

    await user.click(screen.getByRole("button", { name: "End product tour" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Product tour" })).not.toBeInTheDocument(),
    );
    expect(push).not.toHaveBeenCalled();
  });
});
