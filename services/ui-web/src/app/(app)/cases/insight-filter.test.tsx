/**
 * The deep link, end to end (insight-surfacing, slice 2).
 *
 * lib/insights/cases.test.ts proves the predicate is correct. What this proves
 * is that the WORKLIST actually applies it — that clicking "3 cases are past
 * their due date" lands on a page narrowed to those three and says how. A count
 * that links to an unfiltered list is worse than no link: it looks like
 * evidence and is not.
 *
 * Assertions are on the BANNER, not on table rows, because DataTable is
 * virtualized and jsdom has no viewport height — it renders zero rows here
 * regardless of the data, so a row assertion would test the virtualizer rather
 * than the filter. The banner's "N of the M loaded" is computed from the same
 * two arrays the table receives, so a broken predicate shows up in it
 * immediately.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
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

// Two overdue, one healthy, one CLOSED-but-past-due (must never be counted).
const NODES = [
  { id: "c1", urn: "u1", caseNumber: 1, status: "IN_PROGRESS", severity: "HIGH",
    dueDate: iso(-2 * DAY), createdAt: iso(-3 * DAY), reassignCount: 0 },
  { id: "c2", urn: "u2", caseNumber: 2, status: "IN_PROGRESS", severity: "LOW",
    dueDate: iso(-DAY), createdAt: iso(-2 * DAY), reassignCount: 0 },
  { id: "c3", urn: "u3", caseNumber: 3, status: "IN_PROGRESS", severity: "LOW",
    dueDate: iso(5 * DAY), createdAt: iso(-DAY), reassignCount: 0 },
  { id: "c4", urn: "u4", caseNumber: 4, status: "CLOSED", severity: "HIGH",
    dueDate: iso(-9 * DAY), createdAt: iso(-9 * DAY), reassignCount: 0 },
];

let hasMore = false;
vi.mock("@/lib/graphql/client", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/graphql/client")>();
  return {
    ...actual,
    graphqlRequest: (doc: string) => {
      if (doc.includes("query CaseSearch")) {
        return Promise.resolve({
          caseSearch: { nodes: NODES, pageInfo: { nextCursor: hasMore ? "c" : null, hasMore } },
        });
      }
      // The page mounts BulkAssignBar, which paginates assignable users; an
      // undefined connection breaks getNextPageParam before any assertion runs.
      if (doc.includes("AssignableUsers")) {
        return Promise.resolve({
          assignableUsers: { nodes: [], pageInfo: { nextCursor: null, hasMore: false } },
        });
      }
      return Promise.resolve({});
    },
  };
});

import CasesPage from "./page";

beforeEach(() => {
  search = new URLSearchParams();
  hasMore = false;
  replace.mockClear();
});

describe("cases worklist ?insight=", () => {
  it("does not narrow anything when no insight is applied", async () => {
    renderWithProviders(<CasesPage />);
    await waitFor(() => expect(screen.getByLabelText("Search cases")).toBeInTheDocument());
    expect(screen.queryByText(/Showing:/)).not.toBeInTheDocument();
  });

  it("narrows to exactly the cases behind the insight, and says so", async () => {
    // 4 loaded: two overdue, one due in future, one CLOSED-but-past-due. The
    // rule must keep exactly the two — dropping the healthy case AND the
    // finished one.
    search = new URLSearchParams("insight=overdue");
    renderWithProviders(<CasesPage />);
    expect(await screen.findByText(/open case whose due date has passed/)).toBeInTheDocument();
    // The banner renders from the URL immediately; the counts only settle once
    // the query resolves, so this must await rather than read synchronously.
    expect(await screen.findByText(/2 of the 4 loaded/)).toBeInTheDocument();
  });

  it("narrows by a different rule when a different insight is asked for", async () => {
    // Guards against the filter being hardcoded to one predicate: unassigned
    // matches none of these four, so the banner must say 0.
    search = new URLSearchParams("insight=unassigned");
    renderWithProviders(<CasesPage />);
    expect(await screen.findByText(/still in the unassigned queue/)).toBeInTheDocument();
    expect(await screen.findByText(/0 of the 4 loaded/)).toBeInTheDocument();
  });

  it("admits the filter only covers what is loaded when more pages exist", async () => {
    // Client-side narrowing over a paginated list: CaseFilter has no dueDate,
    // so this cannot be pushed to the server. Saying so is the difference
    // between a filter and a claim about the tenant.
    hasMore = true;
    search = new URLSearchParams("insight=overdue");
    renderWithProviders(<CasesPage />);
    expect(await screen.findByText(/load more to widen the search/)).toBeInTheDocument();
  });

  it("offers a way back to the unfiltered list", async () => {
    search = new URLSearchParams("insight=overdue");
    renderWithProviders(<CasesPage />);
    await userEvent.click(await screen.findByText("Show all cases"));
    expect(replace).toHaveBeenCalledWith("/cases?");
  });

  it("ignores an unknown insight rather than showing an empty worklist", async () => {
    // A stale bookmark must not read as "you have no work".
    search = new URLSearchParams("insight=not-a-real-insight");
    renderWithProviders(<CasesPage />);
    await waitFor(() => expect(screen.getByLabelText("Search cases")).toBeInTheDocument());
    expect(screen.queryByText(/Showing:/)).not.toBeInTheDocument();
  });
});
