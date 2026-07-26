import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SessionProvider, type SessionInfo } from "@/lib/session/SessionContext";
import { WalkthroughOverlay } from "./WalkthroughOverlay";

const push = vi.fn();
let pathname = "/cases";
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
  usePathname: () => pathname,
}));

const steps = [
  { title: "Worklist", target_route: "/cases", narration: "Every pending request lands here." },
  { title: "Copilot triage", target_route: "/cases/PAR-5001", narration: "Open the urgent request." },
  { title: "Audit trail", target_route: "/audit", narration: "Every disposition is logged here." },
];

function renderOverlay(session: Partial<SessionInfo> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const base: SessionInfo = { userId: "u", tenantId: "t-demo-1", workspaceId: "ws", scopes: [], profile: "demo" };
  return render(
    <QueryClientProvider client={client}>
      <SessionProvider value={{ ...base, ...session }}>
        <WalkthroughOverlay />
      </SessionProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  push.mockClear();
  pathname = "/cases";
  window.localStorage.clear();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ steps }), { status: 200 })),
  );
});

describe("WalkthroughOverlay (BRD 70 DSP-FR-015)", () => {
  it("renders nothing for a non-demo session", async () => {
    renderOverlay({ profile: "standard" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: /guided tour/i })).not.toBeInTheDocument());
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("renders nothing when the tenant's walkthrough has no steps", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ steps: [] }), { status: 200 })),
    );
    renderOverlay();
    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    expect(screen.queryByRole("dialog", { name: /guided tour/i })).not.toBeInTheDocument();
  });

  it("shows step 1 of N for a demo tenant with steps", async () => {
    renderOverlay();
    expect(await screen.findByRole("dialog", { name: /guided tour/i })).toBeInTheDocument();
    expect(screen.getByText(/step 1 of 3/i)).toBeInTheDocument();
    expect(screen.getByText("Worklist")).toBeInTheDocument();
    expect(screen.getByText(/every pending request lands here/i)).toBeInTheDocument();
  });

  it("advances to the next step and navigates to its target route", async () => {
    const user = userEvent.setup();
    renderOverlay();
    await screen.findByText("Worklist");
    await user.click(screen.getByRole("button", { name: /next/i }));
    expect(await screen.findByText("Copilot triage")).toBeInTheDocument();
    expect(screen.getByText(/step 2 of 3/i)).toBeInTheDocument();
    expect(push).toHaveBeenCalledWith("/cases/PAR-5001");
  });

  it("goes back to the previous step", async () => {
    const user = userEvent.setup();
    renderOverlay();
    await screen.findByText("Worklist");
    await user.click(screen.getByRole("button", { name: /next/i }));
    await screen.findByText("Copilot triage");
    await user.click(screen.getByRole("button", { name: /back/i }));
    expect(await screen.findByText("Worklist")).toBeInTheDocument();
    expect(push).toHaveBeenCalledWith("/cases");
  });

  it("shows Finish on the last step and dismisses into a resume affordance", async () => {
    const user = userEvent.setup();
    renderOverlay();
    await screen.findByText("Worklist");
    await user.click(screen.getByRole("button", { name: /next/i }));
    await screen.findByText("Copilot triage");
    await user.click(screen.getByRole("button", { name: /next/i }));
    expect(await screen.findByText("Audit trail")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /finish/i })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /finish/i }));
    expect(await screen.findByRole("button", { name: /resume guided tour/i })).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: /guided tour/i })).not.toBeInTheDocument();
  });

  it("skip dismisses the tour into the resume affordance", async () => {
    const user = userEvent.setup();
    renderOverlay();
    await screen.findByText("Worklist");
    await user.click(screen.getByRole("button", { name: /skip guided tour/i }));
    expect(await screen.findByRole("button", { name: /resume guided tour/i })).toBeInTheDocument();
  });

  it("persists progress across remounts via localStorage, scoped per tenant", async () => {
    const user = userEvent.setup();
    const { unmount } = renderOverlay();
    await screen.findByText("Worklist");
    await user.click(screen.getByRole("button", { name: /next/i }));
    await screen.findByText("Copilot triage");
    unmount();

    renderOverlay();
    expect(await screen.findByText("Copilot triage")).toBeInTheDocument();
  });

  it("does not show a 'go to this step' prompt when already on the step's route", async () => {
    renderOverlay();
    await screen.findByText("Worklist");
    expect(screen.queryByRole("button", { name: /go to this step/i })).not.toBeInTheDocument();
  });

  it("shows a 'go to this step' prompt when navigated away from the step's route", async () => {
    pathname = "/somewhere-else";
    renderOverlay();
    expect(await screen.findByRole("button", { name: /go to this step/i })).toBeInTheDocument();
  });
});
