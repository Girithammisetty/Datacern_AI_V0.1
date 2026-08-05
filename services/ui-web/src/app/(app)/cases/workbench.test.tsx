/**
 * The Case Workbench's headline behaviors, end to end against mocked GraphQL:
 *
 *  1. ?c=<id> deep-links the RIGHT PANE open (no route change) — the pane
 *     fetches the real CaseDetail and shows its position in the current list.
 *  2. Resolving in the pane runs the real resolveCase mutation and then
 *     AUTO-ADVANCES to the next case in the filtered order, announcing it.
 *  3. The built-in saved-view chips rewrite the URL (URL = source of truth).
 *
 * Table-row assertions are avoided on purpose: DataTable is virtualized and
 * jsdom has no viewport, so it renders zero rows here (see
 * insight-filter.test.tsx). The pane + URL are the observable surface.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "@/test/utils";

let search = new URLSearchParams();
const replace = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace, push: vi.fn() }),
  useSearchParams: () => search,
  usePathname: () => "/cases",
}));

const DAY = 86_400_000;
const iso = (ms: number) => new Date(Date.now() + ms).toISOString();

const NODES = [
  { id: "c1", urn: "wr:t:case/c1", caseNumber: 1, status: "IN_PROGRESS", severity: "HIGH",
    dueDate: iso(DAY), createdAt: iso(-DAY), reassignCount: 0 },
  { id: "c2", urn: "wr:t:case/c2", caseNumber: 2, status: "IN_PROGRESS", severity: "LOW",
    dueDate: iso(2 * DAY), createdAt: iso(-DAY), reassignCount: 0 },
];

const detailOf = (id: string) => {
  const base = NODES.find((n) => n.id === id)!;
  return {
    case: {
      ...base,
      title: `Case ${id}`,
      description: null,
      dispositionId: null,
      resolutionNote: null,
      resolvedAt: null,
      closedAt: null,
      caseVersion: 1,
      assignee: null,
      sourceDataset: null,
      proposals: [],
      evidence: [],
      displayProjection: null,
    },
  };
};

const requests: { doc: string; vars: Record<string, unknown> }[] = [];
vi.mock("@/lib/graphql/client", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/graphql/client")>();
  return {
    ...actual,
    graphqlRequest: async (doc: string, vars: Record<string, unknown>) => {
      requests.push({ doc, vars });
      if (doc.includes("query Me")) {
        return { me: { userId: "u", tenantId: "t", type: "user", scopes: [], roles: ["Admin"], capabilities: ["*"], capsDegraded: false } };
      }
      if (doc.includes("query CaseSearch")) {
        return { caseSearch: { nodes: NODES, pageInfo: { nextCursor: null, hasMore: false } } };
      }
      if (doc.includes("query CaseDetail")) return detailOf(vars.id as string);
      if (doc.includes("query Dispositions")) {
        return { dispositions: [{ id: "d1", code: "OK", label: "Confirmed fine", category: "no_action", requiresNote: false, active: true }] };
      }
      if (doc.includes("AssignableUsers")) {
        return { assignableUsers: { nodes: [], pageInfo: { nextCursor: null, hasMore: false } } };
      }
      // CaseActionsBar's sync-to-SoR target picker paginates connections.
      if (doc.includes("query Connections")) {
        return { connections: { nodes: [], pageInfo: { nextCursor: null, hasMore: false } } };
      }
      if (doc.includes("mutation ResolveCase")) {
        return { resolveCase: { ...detailOf(vars.id as string).case, status: "RESOLVED", resolvedAt: iso(0) } };
      }
      return {};
    },
  };
});

import CasesPage from "./page";

beforeEach(() => {
  search = new URLSearchParams();
  requests.length = 0;
  replace.mockClear();
  window.history.replaceState(null, "", "/cases");
});

describe("case workbench — split pane", () => {
  it("?c=<id> opens the work pane in place with its position in the list", async () => {
    search = new URLSearchParams("c=c1");
    window.history.replaceState(null, "", "/cases?c=c1");
    renderWithProviders(<CasesPage />);

    const pane = await screen.findByTestId("case-work-pane");
    expect(within(pane).getByText("Case c1")).toBeInTheDocument();
    // Position header: first of the two loaded cases.
    expect(await screen.findByTestId("pane-position")).toHaveTextContent("1 of 2");
    // A real CaseDetail was fetched for the pane — not a projection guess.
    expect(requests.some((r) => r.doc.includes("query CaseDetail") && r.vars.id === "c1")).toBe(true);
    // Deep link out still exists for the full page.
    expect(screen.getByRole("link", { name: /Open full page/ })).toHaveAttribute("href", "/cases/c1");
  });

  it("resolving in the pane auto-advances to the next case in the filtered order", async () => {
    search = new URLSearchParams("c=c1");
    window.history.replaceState(null, "", "/cases?c=c1");
    const user = userEvent.setup();
    renderWithProviders(<CasesPage />);

    const pane = await screen.findByTestId("case-work-pane");
    await within(pane).findByText("Case c1");

    await user.click(within(pane).getByRole("button", { name: "Resolve" }));
    const dialog = await screen.findByRole("dialog");
    await user.selectOptions(within(dialog).getByLabelText(/Disposition/), "d1");
    await user.click(within(dialog).getByRole("button", { name: "Resolve" }));

    // The REAL mutation ran against c1…
    await waitFor(() =>
      expect(requests.some((r) => r.doc.includes("mutation ResolveCase") && r.vars.id === "c1")).toBe(true),
    );
    // …and the pane advanced to c2 without any navigation, announcing it.
    expect(await screen.findByText("Case c2")).toBeInTheDocument();
    expect(await screen.findByText(/Advanced to next case/)).toBeInTheDocument();
    expect(screen.getByTestId("pane-position")).toHaveTextContent("2 of 2");
  });
});

describe("case workbench — saved views", () => {
  it("built-in chips apply their params by rewriting the URL", async () => {
    renderWithProviders(<CasesPage />);
    await user_click("Unassigned");
    expect(replace).toHaveBeenCalledWith("/cases?status=UNASSIGNED");
    await user_click("SLA at risk");
    expect(replace).toHaveBeenCalledWith("/cases?sla=1");
  });

  it("marks the chip matching the current URL active", async () => {
    search = new URLSearchParams("status=UNASSIGNED");
    renderWithProviders(<CasesPage />);
    const chip = await screen.findByRole("button", { name: "Unassigned" });
    expect(chip).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "SLA at risk" })).toHaveAttribute("aria-pressed", "false");
  });
});

async function user_click(name: string) {
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name }));
}
