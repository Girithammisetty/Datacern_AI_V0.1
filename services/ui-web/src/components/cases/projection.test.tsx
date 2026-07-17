import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { summarizeProjection, CaseTitleCell } from "./projection";
import type { Case } from "@/lib/graphql/types";

const DISPUTE_PROJECTION = {
  dispute_id: "DSP-5002",
  cardholder: "Dana Whitfield (C-2001)",
  dispute_type: "not_received",
  reason_code: "13.1",
  amount: "342.20",
  deadline_days_left: "1",
  note: "Third 'item not received' claim in 3 months.",
};

describe("summarizeProjection", () => {
  it("returns null for missing/empty projections", () => {
    expect(summarizeProjection(null)).toBeNull();
    expect(summarizeProjection(undefined)).toBeNull();
    expect(summarizeProjection({})).toBeNull();
  });

  it("picks the who-field as headline and the id as reference", () => {
    const s = summarizeProjection(DISPUTE_PROJECTION)!;
    expect(s.headline).toBe("Dana Whitfield (C-2001)");
    expect(s.reference).toBe("DSP-5002");
    expect(s.deadlineDays).toBe(1);
    expect(s.amount).toBe("$342.20");
    expect(s.note).toMatch(/Third 'item not received'/);
  });

  it("falls back to the ref field as headline when no who-field exists", () => {
    const s = summarizeProjection({ case_id: "PVC-6001", seriousness: "death", note: "x" })!;
    expect(s.headline).toBe("PVC-6001");
    expect(s.reference).toBeNull();
  });

  it("keeps every non-note field for the evidence panel", () => {
    const s = summarizeProjection(DISPUTE_PROJECTION)!;
    expect(s.fields.map(([k]) => k)).not.toContain("note");
    expect(s.fields).toHaveLength(6);
  });
});

describe("CaseTitleCell", () => {
  const base = { id: "c1", urn: "wr:x:case:case/c1", proposals: [] } as unknown as Case;

  it("renders the plain title when there is no projection", () => {
    render(<CaseTitleCell c={{ ...base, title: "Case #7" }} />);
    expect(screen.getByText("Case #7")).toBeInTheDocument();
  });

  it("renders headline, reference, amount, deadline chip and note from the projection", () => {
    render(<CaseTitleCell c={{ ...base, title: "Case #2", displayProjection: DISPUTE_PROJECTION }} />);
    expect(screen.getByText("Dana Whitfield (C-2001)")).toBeInTheDocument();
    expect(screen.getByText("DSP-5002")).toBeInTheDocument();
    expect(screen.getByText("$342.20")).toBeInTheDocument();
    expect(screen.getByText("1d left")).toBeInTheDocument();
    expect(screen.getByText(/Third 'item not received'/)).toBeInTheDocument();
    expect(screen.queryByText("Case #2")).not.toBeInTheDocument();
  });
});
