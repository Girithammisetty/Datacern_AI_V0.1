/**
 * Case triage — asking the `case-triage` agent to read one case and draft a
 * governed disposition proposal.
 *
 * Why this is its own path rather than the copilot drawer: `case-triage` is
 * deliberately absent from the copilot allow-list (app/api/copilot/message)
 * because it is not a conversational agent — it requires a `case_id` and
 * agent-runtime 422s without one. That comment promised "its own triage
 * surface"; this module plus app/api/cases/[id]/triage is that surface.
 *
 * Kept as pure functions so the request shape and the two-mode response
 * handling are unit-testable without a server (the house pattern — see
 * lib/embed/token.ts and its route).
 */

/** Terminal run states from agent-runtime's Run model. `awaiting_approval` is
 *  a SUCCESS for us: it means the agent produced a proposal and is correctly
 *  waiting for a human, which is the whole point of the product. */
export const TERMINAL_RUN_STATUSES = new Set([
  "completed",
  "awaiting_approval",
  "failed",
  "killed",
  "cancelled",
]);

export function isTerminalRunStatus(status: string | null | undefined): boolean {
  return !!status && TERMINAL_RUN_STATUSES.has(status);
}

/** The instruction sent to the agent. Deliberately short: the graph grounds
 *  itself on the case, its evidence and the tenant's disposition catalog — the
 *  prompt is not where the domain knowledge lives. */
export const TRIAGE_PROMPT =
  "Triage this case: review the evidence, apply the tenant's disposition catalog, " +
  "and propose a disposition with your reasoning.";

export interface TriageUpstreamRequest {
  path: string;
  body: {
    messages: { role: "user"; content: string }[];
    metadata: { case_id: string };
  };
}

/**
 * Build the agent-runtime call for a case. `case_id` goes in `metadata` because
 * that is the branch agent-runtime's `_inputs_from_body` reads first; a case
 * `context_urn` would also work but requires the tenant id we do not hold here.
 */
export function buildTriageRequest(caseId: string): TriageUpstreamRequest | { error: string } {
  const id = (caseId ?? "").trim();
  if (!id) return { error: "a case id is required" };
  return {
    path: `/api/v1/agents/case-triage/chat/completions`,
    body: {
      messages: [{ role: "user", content: TRIAGE_PROMPT }],
      metadata: { case_id: id },
    },
  };
}

export interface TriageResult {
  runId: string | null;
  sessionId: string | null;
  /** "inline" → the proposal already exists; "temporal" → poll the run. */
  mode: "inline" | "temporal" | "unknown";
  proposalId: string | null;
  proposalStatus: string | null;
}

/**
 * Normalize agent-runtime's reply. It answers 200 in BOTH execution modes and
 * the difference matters to the caller: inline carries `proposal_id` already,
 * temporal carries only a workflow handle and the proposal appears later. The
 * envelope is `{data: {...}}`, but accept a bare body too so a change in the
 * wrapper does not silently produce nulls.
 */
export function normalizeTriageResponse(json: unknown): TriageResult {
  const root = (json ?? {}) as Record<string, unknown>;
  const d = ((root.data as Record<string, unknown>) ?? root) ?? {};
  const rawMode = typeof d.mode === "string" ? d.mode : "";
  return {
    runId: (d.run_id as string) ?? null,
    sessionId: (d.session_id as string) ?? null,
    mode: rawMode === "inline" || rawMode === "temporal" ? rawMode : "unknown",
    proposalId: (d.proposal_id as string) ?? null,
    proposalStatus: (d.proposal_status as string) ?? null,
  };
}

/**
 * Pull a usable message out of the platform error envelope
 * (`{error: {code, message, trace_id}}`). The copilot route collapses every
 * upstream failure to a bare 502, which hides the two errors a user can act
 * on: 422 (no case id) and 403 ("you lack case.case.update on this case" —
 * the caller-gate that stops the copilot proposing what the invoker could not
 * do themselves). Surface those instead of swallowing them.
 */
export function upstreamErrorMessage(json: unknown, status: number): string {
  const err = ((json ?? {}) as Record<string, unknown>).error as
    | Record<string, unknown>
    | undefined;
  const msg = typeof err?.message === "string" ? err.message : "";
  if (msg) return msg;
  if (status === 403) return "You do not have permission to triage this case.";
  if (status === 422) return "This case cannot be triaged (missing case id).";
  if (status === 423) return "The triage agent is currently disabled by an administrator.";
  if (status === 402) return "This workspace's AI budget is exhausted.";
  return "The triage agent is unavailable.";
}
