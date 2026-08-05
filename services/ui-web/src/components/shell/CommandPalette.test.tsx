import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "@/test/utils";
import { CommandPalette, CMDK_EVENT } from "./CommandPalette";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }), usePathname: () => "/" }));

/** Every GraphQL document the palette issues, in order. */
let calls: { doc: string; vars: any }[] = [];
let handler: (doc: string, vars: any) => any = () => ({});
vi.mock("@/lib/graphql/client", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/graphql/client")>();
  return {
    ...actual,
    graphqlRequest: async (doc: string, vars: any) => {
      calls.push({ doc, vars });
      return handler(doc, vars);
    },
  };
});

const meResult = {
  me: { userId: "u", tenantId: "t", type: "user", scopes: [], roles: ["Admin"], capabilities: ["*"], capsDegraded: false },
};

/**
 * A server double for bff-graphql's `search()`. It models the property that
 * matters: the SERVER matches the term. There are 51 dashboards; only the last
 * contains "denial" — a client that fetched `first: 50` and filtered locally
 * (the pre-BRD-74-D3 palette) would never see it.
 */
const DASHBOARDS = [
  ...Array.from({ length: 50 }, (_, i) => ({ id: `dash-${i}`, name: `Ops board ${i}` })),
  { id: "dash-51", name: "Denial rate review" },
];

function searchServer(q: string, types: string[]) {
  const hits: any[] = [];
  const add = (type: string, id: string, title: string, extra: any = {}) => {
    if (!types.includes(type)) return;
    if (!title.toLowerCase().includes(q.toLowerCase())) return;
    hits.push({ key: `${type}:${id}`, id, type, title, subtitle: null, parentId: null, ...extra });
  };
  add("DATASET", "ds-9", "auto_claims");
  for (const d of DASHBOARDS) add("DASHBOARD", d.id, d.name);
  add("CHART", "c-1", "Denial rate by payer", { subtitle: "Finance", parentId: "dash-2" });
  add("CASE", "case-1", "denial dispute");
  return {
    search: {
      hits,
      types: types.map((type) => ({ type, denied: false, error: null })),
    },
  };
}

/** The palette's live-search call (the only document carrying a `q`). */
const searchCalls = () => calls.filter((c) => c.doc.includes("query GlobalSearch"));

beforeEach(() => {
  push.mockClear();
  calls = [];
  handler = (doc: string, vars: any) => {
    if (doc.includes("query Me")) return meResult;
    if (doc.includes("query GlobalSearch")) return searchServer(vars.q, vars.types ?? []);
    return {};
  };
});

function openWithMeta() {
  fireEvent.keyDown(window, { key: "k", metaKey: true });
}

describe("CommandPalette (⌘K global search)", () => {
  it("is hidden until opened, then opens on ⌘K", async () => {
    renderWithProviders(<CommandPalette />);
    expect(screen.queryByRole("dialog", { name: /command palette/i })).not.toBeInTheDocument();
    openWithMeta();
    expect(await screen.findByRole("dialog", { name: /command palette/i })).toBeInTheDocument();
    expect(screen.getByLabelText("Command palette search")).toBeInTheDocument();
  });

  it("opens on the CMDK event (the top-bar trigger)", async () => {
    renderWithProviders(<CommandPalette />);
    window.dispatchEvent(new Event(CMDK_EVENT));
    expect(await screen.findByRole("dialog", { name: /command palette/i })).toBeInTheDocument();
  });

  it("offers capability-gated navigation and jumps on Enter", async () => {
    const user = userEvent.setup();
    renderWithProviders(<CommandPalette />);
    await waitFor(() => expect(screen.queryByText(/^\*$/)).not.toBeInTheDocument()); // let viewer load
    openWithMeta();
    const input = await screen.findByLabelText("Command palette search");
    await user.type(input, "dashboards");
    const opt = await screen.findByRole("option", { name: /Dashboards/i });
    expect(opt).toBeInTheDocument();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(push).toHaveBeenCalledWith("/dashboards"));
  });

  it("searches datasets when the query is 2+ chars", async () => {
    const user = userEvent.setup();
    renderWithProviders(<CommandPalette />);
    openWithMeta();
    const input = await screen.findByLabelText("Command palette search");
    await user.type(input, "claim");
    expect(await screen.findByRole("option", { name: /auto_claims/i })).toBeInTheDocument();
    await user.click(screen.getByRole("option", { name: /auto_claims/i }));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/data/datasets/ds-9"));
  });

  it("closes on Escape", async () => {
    renderWithProviders(<CommandPalette />);
    openWithMeta();
    const input = await screen.findByLabelText("Command palette search");
    fireEvent.keyDown(input, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: /command palette/i })).not.toBeInTheDocument());
  });
});

describe("BRD 74 AC-9: one query, and dashboard 51 is findable", () => {
  it("issues exactly ONE search query and finds a dashboard ranked below the first 50", async () => {
    const user = userEvent.setup();
    renderWithProviders(<CommandPalette />);
    openWithMeta();
    const input = await screen.findByLabelText("Command palette search");
    await user.type(input, "denial rate review");

    // The dashboard the old `first: 50` + client-side filter could never reach.
    const opt = await screen.findByRole("option", { name: /Denial rate review/i });
    expect(opt).toBeInTheDocument();

    // ONE search request for that term — not one per entity kind, and not the
    // three separate documents the palette used to issue.
    const forTerm = searchCalls().filter((c) => c.vars.q === "denial rate review");
    expect(forTerm).toHaveLength(1);
    expect(forTerm[0]!.vars.types).toContain("DASHBOARD");

    // And it opens the right dashboard.
    await user.click(opt);
    await waitFor(() => expect(push).toHaveBeenCalledWith("/dashboards/dash-51"));
  });

  it("never issues the old per-entity documents", async () => {
    const user = userEvent.setup();
    renderWithProviders(<CommandPalette />);
    openWithMeta();
    await user.type(await screen.findByLabelText("Command palette search"), "denial");
    await waitFor(() => expect(searchCalls().length).toBeGreaterThan(0));

    for (const legacy of ["query Datasets", "query Dashboards", "query DecisionModels"]) {
      expect(calls.some((c) => c.doc.includes(legacy)), legacy).toBe(false);
    }
  });

  it("a chart hit opens the dashboard it lives on", async () => {
    const user = userEvent.setup();
    renderWithProviders(<CommandPalette />);
    openWithMeta();
    await user.type(await screen.findByLabelText("Command palette search"), "denial rate by payer");
    const opt = await screen.findByRole("option", { name: /Denial rate by payer/i });
    await user.click(opt);
    await waitFor(() => expect(push).toHaveBeenCalledWith("/dashboards/dash-2"));
  });
});

describe("BRD 74 AC-8: the palette only asks for kinds the viewer can read", () => {
  it("a viewer with only dataset + case capabilities requests exactly those types", async () => {
    const user = userEvent.setup();
    handler = (doc: string, vars: any) => {
      if (doc.includes("query Me")) {
        return {
          me: {
            userId: "u", tenantId: "t", type: "user", scopes: [], roles: ["Analyst"],
            capabilities: ["dataset.dataset.list", "case.case.read"], capsDegraded: false,
          },
        };
      }
      if (doc.includes("query GlobalSearch")) return searchServer(vars.q, vars.types ?? []);
      return {};
    };

    renderWithProviders(<CommandPalette />);
    openWithMeta();
    await user.type(await screen.findByLabelText("Command palette search"), "denial");
    await waitFor(() => expect(searchCalls().length).toBeGreaterThan(0));

    const types: string[] = searchCalls().at(-1)!.vars.types;
    expect([...types].sort()).toEqual(["CASE", "DATASET"]);
    // No dashboard hits are even asked for, so none can be shown.
    expect(screen.queryByRole("option", { name: /Denial rate review/i })).not.toBeInTheDocument();
    expect(await screen.findByRole("option", { name: /denial dispute/i })).toBeInTheDocument();
  });
});
