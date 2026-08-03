/**
 * /welcome/walkthrough — the public demo-walkthrough marketing subpage.
 * Focus: the honesty contract (every mock labeled, the "isn't yet" panel
 * present) and the navigation contract (live-demo + welcome links).
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import WalkthroughContent from "./walkthrough-content";

describe("WalkthroughContent", () => {
  it("renders the five steps in order", () => {
    render(<WalkthroughContent />);
    expect(screen.getByRole("heading", { name: /the worklist/i })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /jessie triage/i })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /approval — four eyes/i })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /the learning loop/i })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /the audit trail/i })).toBeInTheDocument();
    expect(screen.getAllByText(/step \d of 5/i)).toHaveLength(5);
  });

  it("labels every product mock as illustrative (Rule #1)", () => {
    render(<WalkthroughContent />);
    // one label per step mock — none may render unlabeled fake data
    expect(
      screen.getAllByText(/illustrative product mock — not customer data/i),
    ).toHaveLength(5);
  });

  it("includes the honesty panel with both sides", () => {
    render(<WalkthroughContent />);
    expect(screen.getByRole("heading", { name: /the sandbox, honestly/i })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /what the live demo is/i })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /what it isn't \(yet\)/i })).toBeInTheDocument();
    // the pre-launch disclosure must be present verbatim in spirit
    expect(screen.getByText(/pre-launch, pre-certification/i)).toBeInTheDocument();
  });

  it("links to the live demo and back to the overview", () => {
    render(<WalkthroughContent />);
    const liveDemoLinks = screen
      .getAllByRole("link")
      .filter((a) => a.getAttribute("href") === "/live-demo");
    expect(liveDemoLinks.length).toBeGreaterThanOrEqual(2);
    const welcomeLinks = screen
      .getAllByRole("link")
      .filter((a) => a.getAttribute("href") === "/welcome");
    expect(welcomeLinks.length).toBeGreaterThanOrEqual(1);
  });
});
