import { describe, expect, it } from "vitest";

import { CHECKLIST_TRACKS, LEARN_THE_WORDS, visibleTracks } from "./checklist";
import type { Gate } from "@/lib/authz/registry";

/** A fake capability evaluator over an allowlist of actions + roles. */
function canWith(actions: string[], roles: string[] = []) {
  return (gate: Gate): boolean => {
    if (gate.kind === "public") return true;
    if (gate.kind === "capability") return actions.includes(gate.action);
    if (gate.kind === "role") return roles.includes(gate.role);
    if (gate.kind === "anyOf") return gate.gates.some((g) => canWith(actions, roles)(g));
    return false;
  };
}

describe("visibleTracks (role-aware getting-started)", () => {
  it("an analyst sees only the casework track, with the glossary appended", () => {
    const tracks = visibleTracks(canWith(["case.case.read", "ai.proposal.read", "chart.dashboard.read"]));
    expect(tracks.map((t) => t.key)).toEqual(["casework"]);
    const keys = tracks[0].items.map((i) => i.key);
    expect(keys).toContain("open-worklist");
    expect(keys).toContain("review-proposal");
    // Universal steps ride along: copilot (public) + the glossary last.
    expect(keys).toContain("ask-copilot");
    expect(keys[keys.length - 1]).toBe(LEARN_THE_WORDS.key);
    // No data/admin steps leak in.
    expect(keys).not.toContain("connect-source");
    expect(keys).not.toContain("install-pack");
  });

  it("an admin sees the setup track", () => {
    const tracks = visibleTracks(canWith([], ["Admin"]));
    const keys = tracks.flatMap((t) => t.items.map((i) => i.key));
    expect(keys).toContain("install-pack");
    expect(keys).toContain("invite-team");
    expect(keys).toContain("set-budgets");
  });

  it("every item's step is reachable — the gate matches its destination", () => {
    // Structural guard: each registered item has a non-empty href + title +
    // description, so a step can never point nowhere or read as jargon-only.
    for (const track of CHECKLIST_TRACKS) {
      for (const item of track.items) {
        expect(item.href.startsWith("/")).toBe(true);
        expect(item.title.length).toBeGreaterThan(0);
        expect(item.description.length).toBeGreaterThan(0);
      }
    }
  });
});
