import { describe, it, expect } from "vitest";
import {
  buildTriageRequest,
  normalizeTriageResponse,
  upstreamErrorMessage,
  isTerminalRunStatus,
  TRIAGE_PROMPT,
} from "./triage";

describe("buildTriageRequest — the contract agent-runtime actually accepts", () => {
  it("targets the chat/completions path, not /replay", () => {
    const r = buildTriageRequest("case-1");
    if ("error" in r) throw new Error("unexpected error");
    // This matters more than it looks: /api/v1/replay mints an AUTONOMOUS agent
    // principal that holds no RBAC grants and 403s on every case read, while
    // chat/completions mints on-behalf-of the caller. Same agent, opposite
    // outcome — pin the path so a "simplification" cannot silently break it.
    expect(r.path).toBe("/api/v1/agents/case-triage/chat/completions");
  });

  it("puts the case id where _inputs_from_body reads it", () => {
    const r = buildTriageRequest("case-1");
    if ("error" in r) throw new Error("unexpected error");
    expect(r.body.metadata).toEqual({ case_id: "case-1" });
    expect(r.body.messages).toEqual([{ role: "user", content: TRIAGE_PROMPT }]);
  });

  it("refuses a blank case id instead of letting agent-runtime 422", () => {
    expect(buildTriageRequest("   ")).toEqual({ error: "a case id is required" });
    expect(buildTriageRequest("")).toEqual({ error: "a case id is required" });
  });
});

describe("normalizeTriageResponse — both execution modes answer 200", () => {
  it("reads the inline mode's proposal straight off the envelope", () => {
    const r = normalizeTriageResponse({
      data: {
        run_id: "run-1",
        session_id: "sess-1",
        mode: "inline",
        proposal_id: "prop-1",
        proposal_status: "PENDING",
      },
    });
    expect(r).toEqual({
      runId: "run-1",
      sessionId: "sess-1",
      mode: "inline",
      proposalId: "prop-1",
      proposalStatus: "PENDING",
    });
  });

  it("reports temporal mode with no proposal yet — it appears later", () => {
    const r = normalizeTriageResponse({ data: { run_id: "run-2", mode: "temporal" } });
    expect(r.mode).toBe("temporal");
    expect(r.proposalId).toBeNull();
  });

  it("accepts a bare body so an envelope change does not silently null everything", () => {
    expect(normalizeTriageResponse({ run_id: "run-3", mode: "inline" }).runId).toBe("run-3");
  });

  it("does not invent a mode it was not given", () => {
    expect(normalizeTriageResponse({}).mode).toBe("unknown");
    expect(normalizeTriageResponse({ data: { mode: "something-new" } }).mode).toBe("unknown");
  });
});

describe("upstreamErrorMessage — surface authorization failures, do not swallow them", () => {
  it("prefers the platform error envelope's own message", () => {
    expect(
      upstreamErrorMessage({ error: { code: "FORBIDDEN", message: "no case.case.update on this case" } }, 403),
    ).toBe("no case.case.update on this case");
  });

  it("explains 403 as a permission decision, not a fault", () => {
    expect(upstreamErrorMessage({}, 403)).toBe("You do not have permission to triage this case.");
  });

  it("distinguishes the tenant-level refusals a user can act on", () => {
    expect(upstreamErrorMessage({}, 423)).toMatch(/disabled by an administrator/);
    expect(upstreamErrorMessage({}, 402)).toMatch(/budget is exhausted/);
    expect(upstreamErrorMessage({}, 422)).toMatch(/missing case id/);
  });

  it("falls back without throwing on a non-object body", () => {
    expect(upstreamErrorMessage(null, 500)).toBe("The triage agent is unavailable.");
    expect(upstreamErrorMessage("boom", 500)).toBe("The triage agent is unavailable.");
  });
});

describe("isTerminalRunStatus", () => {
  it("treats awaiting_approval as terminal — a proposal waiting on a human is success", () => {
    expect(isTerminalRunStatus("awaiting_approval")).toBe(true);
    expect(isTerminalRunStatus("completed")).toBe(true);
    expect(isTerminalRunStatus("failed")).toBe(true);
  });

  it("is false for in-flight and unknown states", () => {
    expect(isTerminalRunStatus("running")).toBe(false);
    expect(isTerminalRunStatus(null)).toBe(false);
    expect(isTerminalRunStatus(undefined)).toBe(false);
  });
});
