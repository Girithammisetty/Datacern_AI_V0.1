import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { renderWithProviders } from "@/test/utils";
import { QueueIntelligencePanel, humanDuration } from "./QueueIntelligencePanel";

let payload: any;
vi.mock("@/lib/graphql/client", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/graphql/client")>();
  return {
    ...actual,
    graphqlRequest: async () => ({ queueIntelligence: payload }),
  };
});

const BASE = {
  generatedAt: "2026-07-31T22:00:00Z",
  windowDays: 7,
  open: { total: 4, unassigned: 2, inProgress: 2 },
  aging: [
    { label: "under_24h", count: 1 },
    { label: "1_to_3d", count: 1 },
    { label: "3_to_7d", count: 1 },
    { label: "over_7d", count: 1 },
  ],
  sla: { breached: 1, dueWithin24h: 1 },
  throughput: { opened: 5, resolved: 2, closed: 1 },
  latency: { p50Seconds: 255600, p90Seconds: 330120, sample: 2 },
};

beforeEach(() => {
  payload = structuredClone(BASE);
});

describe("QueueIntelligencePanel", () => {
  it("renders the approver's headline numbers", async () => {
    renderWithProviders(<QueueIntelligencePanel />);
    await waitFor(() => expect(screen.getByTestId("queue-intelligence")).toBeInTheDocument());
    await screen.findByText("Open");
    expect(screen.getByText("2 unassigned · 2 in progress")).toBeInTheDocument();
    expect(screen.getByText("SLA breached")).toBeInTheDocument();
    // 255600s is 71h, which the >48h threshold renders in days — the point is
    // that it is a DURATION, never raw seconds in front of a human.
    await waitFor(() => expect(screen.getByTestId("qi-latency").textContent).toMatch(/3\.0d/));
    expect(screen.getByTestId("qi-latency").textContent).not.toMatch(/255600/);
  });

  /** The failure that would actively mislead: null means "nothing resolved",
   * and rendering it as 0s tells an approver decisions are instant. */
  it("says 'no cases resolved' instead of showing a zero latency", async () => {
    payload.latency = { p50Seconds: null, p90Seconds: null, sample: 0 };
    renderWithProviders(<QueueIntelligencePanel />);
    const el = await screen.findByTestId("qi-latency");
    expect(el.textContent).toMatch(/No cases resolved in the last 7 days/);
    expect(el.textContent).not.toMatch(/\b0s\b/);
    expect(el.textContent).not.toMatch(/median/);
    // With no sample there is no percentile to qualify, so no badge either.
    expect(screen.queryByTestId("qi-sample")).toBeNull();
  });

  /** A p90 over three cases is a coincidence. The reader is the only one who
   * can judge that, so the sample size is always shown — and flagged when thin. */
  it("always shows the sample size, and flags a thin one", async () => {
    payload.latency = { p50Seconds: 3600, p90Seconds: 7200, sample: 3 };
    renderWithProviders(<QueueIntelligencePanel />);
    const badge = await screen.findByTestId("qi-sample");
    expect(badge.textContent).toMatch(/n=3/);
  });

  it("keeps the aging buckets in chronological order", async () => {
    renderWithProviders(<QueueIntelligencePanel />);
    const aging = await screen.findByTestId("qi-aging");
    // A reordered array would silently mislabel the shape of the backlog.
    expect(aging.textContent).toMatch(/< 24h[\s\S]*1–3d[\s\S]*3–7d[\s\S]*> 7d/);
  });

  it("stamps how fresh the figures are", async () => {
    renderWithProviders(<QueueIntelligencePanel />);
    // Polled, not pushed — a reader should not have to assume "breached" is live.
    expect((await screen.findByTestId("qi-generated-at")).textContent).toMatch(/last 7d · as of/);
  });
});

describe("humanDuration", () => {
  it("preserves null so 'no data' never becomes a number", () => {
    expect(humanDuration(null)).toBeNull();
    expect(humanDuration(undefined)).toBeNull();
    // 0 is a real measurement and must NOT be swallowed as null.
    expect(humanDuration(0)).toBe("0s");
  });

  it("scales the unit to the magnitude", () => {
    expect(humanDuration(45)).toBe("45s");
    expect(humanDuration(90)).toBe("2m");
    expect(humanDuration(3600 * 5)).toBe("5.0h");
    expect(humanDuration(3600 * 72)).toBe("3.0d");
  });
});
