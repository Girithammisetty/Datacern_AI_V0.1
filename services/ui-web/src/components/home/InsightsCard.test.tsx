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
/** null = the aggregate is unavailable, so the card must fall back to floors. */
let queueIntel: unknown = null;

vi.mock("@/lib/graphql/client", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/graphql/client")>();
  return {
    ...actual,
    graphqlRequest: (doc: string) => {
      if (doc.includes("query CaseSearch")) {
        if (fail) return Promise.reject(new Error("case-service unreachable"));
        return Promise.resolve({ caseSearch: pages[0] });
      }
      if (doc.includes("query QueueIntelligence")) {
        if (queueIntel === null) return Promise.reject(new Error("no aggregate"));
        return Promise.resolve({ queueIntelligence: queueIntel });
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


/**
 * The "at least N" floors were correct when case-service had no aggregate, and
 * WRONG the moment it grew one. That is the failure mode of an honesty caveat
 * nobody revisits: it keeps under-reporting long after the limitation is gone.
 * These tests pin that the card prefers the real total, and still falls back.
 */
describe("InsightsCard exact vs bounded counts", () => {
  const AGG = {
    generatedAt: new Date().toISOString(),
    windowDays: 7,
    open: { total: 40, unassigned: 5, inProgress: 3 },
    aging: [],
    sla: { breached: 12, dueWithin24h: 4 },
    throughput: { opened: 9, resolved: 6, closed: 2, autoOpened: 7 },
    latency: { p50Seconds: 3600, p90Seconds: 7200, sample: 6 },
  };

  beforeEach(() => {
    fail = false;
    queueIntel = null;
  });

  it("uses the workspace total for SLA rows instead of the windowed floor", async () => {
    const now = Date.now();
    // One overdue case in the window; the aggregate knows there are 12.
    pages = [{
      nodes: [{
        id: "c-1", status: "IN_PROGRESS", severity: "HIGH",
        dueDate: new Date(now - DAY).toISOString(),
        createdAt: new Date(now - 2 * DAY).toISOString(), reassignCount: 0,
      }],
      pageInfo: { hasMore: true },
    }];
    queueIntel = AGG;
    renderWithProviders(<InsightsCard />);

    // 12, not "at least 1" — the window saw one, the workspace has twelve.
    await waitFor(() => expect(screen.getByText("12")).toBeInTheDocument());
    expect(screen.queryByText(/at least 12/)).toBeNull();
  });

  it("still says 'at least' for insights with no server-side aggregate", async () => {
    const now = Date.now();
    pages = [{
      nodes: [{
        id: "c-2", status: "UNASSIGNED", severity: "LOW",
        dueDate: new Date(now + 30 * DAY).toISOString(),
        createdAt: new Date(now - 1 * DAY).toISOString(), reassignCount: 0,
      }],
      pageInfo: { hasMore: true },
    }];
    queueIntel = AGG;
    renderWithProviders(<InsightsCard />);
    // "unassigned" has no aggregate, so its count stays an honest floor even
    // while the SLA rows beside it are exact.
    await waitFor(() => expect(screen.getByText(/at least 1/)).toBeInTheDocument());
  });

  it("falls back to floors when the aggregate is unavailable", async () => {
    const now = Date.now();
    pages = [{
      nodes: [{
        id: "c-3", status: "IN_PROGRESS", severity: "HIGH",
        dueDate: new Date(now - DAY).toISOString(),
        createdAt: new Date(now - 2 * DAY).toISOString(), reassignCount: 0,
      }],
      pageInfo: { hasMore: true },
    }];
    queueIntel = null; // aggregate rejects
    renderWithProviders(<InsightsCard />);
    // The rows must NOT disappear: a missing aggregate degrades the precision,
    // it does not remove the signal.
    await waitFor(() => expect(screen.getByText(/at least 1/)).toBeInTheDocument());
  });
});
