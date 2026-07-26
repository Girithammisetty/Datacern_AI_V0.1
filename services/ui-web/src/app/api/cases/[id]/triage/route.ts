/**
 * "Draft recommendation" on a case → the `case-triage` agent.
 *
 * This is the surface the copilot route's own comment promises but never had:
 * "case-triage is NOT selectable here — it requires a case_id and has its own
 * triage surface". Until this route existed the agent was reachable only by a
 * hand-rolled API call, so the product's central claim — an agent reads the
 * case and drafts a recommendation — could not be performed in the UI at all.
 *
 * A separate route rather than widening the copilot allow-list, because the
 * two have genuinely different contracts: the copilot is conversational and
 * free-text, this takes a case id and returns a proposal handle.
 *
 * Governance is unchanged and enforced upstream, not here: the agent emits a
 * WriteIntent that agent-runtime turns into a PENDING proposal, and before the
 * proposal row exists it re-authorizes `case.case.update` for THIS user on THIS
 * case (ProposalService._authorize_caller). A user who could not apply the
 * disposition by hand cannot get the agent to propose it for them. Nothing here
 * executes anything.
 */
import { NextRequest, NextResponse } from "next/server";
import { getSessionToken } from "@/lib/auth/session";
import {
  buildTriageRequest,
  normalizeTriageResponse,
  upstreamErrorMessage,
} from "@/lib/agentic/triage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const AGENT_RUNTIME_URL = process.env.AGENT_RUNTIME_URL ?? "http://localhost:8306";

/** Inline execution blocks for the whole model round-trip. On a laptop against
 *  local Ollama that is tens of seconds, so this must be well above the
 *  default fetch expectations — the copilot hit exactly this and showed
 *  "didn't return a response" over runs that had succeeded. */
const UPSTREAM_TIMEOUT_MS = Number(process.env.TRIAGE_TIMEOUT_MS ?? 180000);

export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  const { id } = await ctx.params;
  const built = buildTriageRequest(id);
  if ("error" in built) return NextResponse.json({ error: built.error }, { status: 400 });

  try {
    const res = await fetch(`${AGENT_RUNTIME_URL}${built.path}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(built.body),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    const json = await res.json().catch(() => ({}));

    if (!res.ok) {
      // Forward the real status and message. The copilot route collapses every
      // failure to 502, which hides the two a user can actually act on: 403
      // (you lack case.case.update on this case) and 422 (no case id). A
      // governance product that swallows its own authorization errors teaches
      // users the system is flaky rather than strict.
      return NextResponse.json(
        { error: upstreamErrorMessage(json, res.status) },
        { status: res.status },
      );
    }
    return NextResponse.json(normalizeTriageResponse(json));
  } catch (e) {
    const timedOut = e instanceof Error && e.name === "TimeoutError";
    return NextResponse.json(
      {
        error: timedOut
          ? "The triage agent did not respond in time. The run may still complete — check the case shortly."
          : "The triage agent is unreachable.",
      },
      { status: 504 },
    );
  }
}
