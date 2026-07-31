/**
 * The card's HONESTY behaviours, which are the ones that matter.
 *
 * The arithmetic is covered in lib/insights/cases.test.ts. What is tested here
 * is what the card claims: that a bounded window is presented as a floor and
 * not a total, that "nothing is wrong" is stated rather than left blank, and
 * that a failed query takes nothing else down with it.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { renderWithProviders } from "@/test/utils";

let pages: unknown[] = [];
let fail = false;

vi.mock("@/lib/graphql/client", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/graphql/client")>();
  return {
    ...actual,
    graphqlRequest: (doc: string) => {
      if (doc.includes("query CaseSearch")) {
        if (fail) return Promise.reject(new Error("case-service unreachable"));
        return Promise.resolve({ caseSearch: pages[0] });
      }
      return Promise.resolve({});
    },
  };
});

import { InsightsCard } from "./InsightsCard";

const DAY = 86_400_000;
const past = new Date(Date.now() - DAY).toISOString();

function conn(nodes: unknown[], hasMore = false) {
  return { nodes, pageInfo: { nextCursor: hasMore ? "c" : null, hasMore } };
}

beforeEach(() => {
  fail = false;
  pages = [conn([])];
});

describe("InsightsCard", () => {
  it("says nothing is wrong instead of rendering an empty card", async () => {
    pages = [conn([{ id: "c1", status: "IN_PROGRESS", createdAt: new Date().toISOString() }])];
    renderWithProviders(<InsightsCard />);
    expect(await screen.findByText(/Nothing needs attention/)).toBeInTheDocument();
  });

  it("presents a bounded window as a FLOOR, never as a total", async () => {
    // hasMore = there are cases we did not examine, so every count is a
    // minimum. Printing a bare number here would assert a tenant-wide total
    // that case-service cannot currently provide (it has no aggregate).
    pages = [conn([{ id: "c1", status: "IN_PROGRESS", createdAt: past, dueDate: past }], true)];
    renderWithProviders(<InsightsCard />);
    expect(await screen.findByText(/at least 1/)).toBeInTheDocument();
    expect(screen.getByText(/more exist, so these are minimums/)).toBeInTheDocument();
  });

  it("states an exact count only when the window is complete", async () => {
    pages = [conn([{ id: "c1", status: "IN_PROGRESS", createdAt: past, dueDate: past }], false)];
    renderWithProviders(<InsightsCard />);
    await waitFor(() => expect(screen.getByText(/past its due date/)).toBeInTheDocument());
    expect(screen.queryByText(/at least/)).not.toBeInTheDocument();
    expect(screen.getByText(/Across all 1 of your cases/)).toBeInTheDocument();
  });

  it("shows the rule behind each insight so a user can disagree with it", async () => {
    pages = [conn([{ id: "c1", status: "UNASSIGNED", createdAt: new Date().toISOString() }])];
    renderWithProviders(<InsightsCard />);
    expect(await screen.findByText(/still in the unassigned queue/)).toBeInTheDocument();
  });

  it("renders nothing at all when the query fails — it is additive, never fatal", async () => {
    // The decision-queue and approvals cards sit beside this one; a secondary
    // signal must not put an error box on the home page.
    fail = true;
    const { container } = renderWithProviders(<InsightsCard />);
    await waitFor(() => expect(container.textContent).not.toMatch(/Checking your worklist/));
    expect(container.textContent).not.toMatch(/Needs attention/);
  });
});
