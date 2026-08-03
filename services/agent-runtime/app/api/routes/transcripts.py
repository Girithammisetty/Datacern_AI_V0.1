"""SLM transcript corpus — read API (distillation milestone 1).

Tenant-scoped (RLS) browse of the governed agent-run corpus that SFT curation
reads from. Sensitive fields are already PII-redacted at capture; isolation is
enforced by RLS on ``principal.tenant_id`` (same pattern as /proposals)."""

from __future__ import annotations

from fastapi import APIRouter, Query, Request

from app.api.auth import principal_of
from app.domain.errors import NotFound, ValidationFailed

router = APIRouter(prefix="/api/v1")


def _view(t) -> dict:
    return {
        "transcript_id": t.transcript_id, "run_id": t.run_id, "session_id": t.session_id,
        "agent_key": t.agent_key, "agent_version": t.agent_version,
        "principal_type": t.principal_type, "obo_sub": t.obo_sub,
        "inputs": t.inputs, "grounding": t.grounding, "final_text": t.final_text,
        "proposed_action": t.proposed_action, "proposal_id": t.proposal_id,
        "model": t.model, "usage": t.usage, "consent": t.consent,
        "decision": t.decision, "corrected_output": t.corrected_output,
        "decided_by": t.decided_by,
        "decided_at": t.decided_at.isoformat() if t.decided_at else None,
        "created_at": t.created_at.isoformat() if t.created_at else None,
    }


@router.get("/transcripts")
async def list_transcripts(
    request: Request,
    agent_key: str | None = Query(default=None, alias="filter[agent_key]"),
    only_decided: bool = Query(default=False, alias="filter[decided]"),
    limit: int = Query(default=50, ge=1, le=200),
):
    principal = await principal_of(request)
    c = request.app.state.container
    rows = await c.store.list_transcripts(
        principal.tenant_id, agent_key=agent_key, only_decided=only_decided, limit=limit)
    return {"data": [_view(t) for t in rows],
            "page": {"next_cursor": None, "has_more": False}}


@router.get("/knowledge-gaps")
async def list_knowledge_gaps(
    request: Request,
    limit: int = Query(default=50, ge=1, le=200),
    include_decided: bool = Query(default=False),
):
    """WS5 (knowledge spine): the missing-knowledge signals humans recorded at
    decision time, projected as a steward queue — each gap names knowledge the
    agent lacked, so a steward can turn it into a governed ontology proposal.
    Text was PII-redacted at capture. Triaged gaps (handled/dismissed) drop out
    of the default view; ``include_decided`` lists them with their triage
    state (``gap_status``/``gap_decided_by``/``gap_decided_at``, null while
    open)."""
    principal = await principal_of(request)
    c = request.app.state.container
    rows = await c.store.list_knowledge_gaps(
        principal.tenant_id, limit=limit, include_decided=include_decided)
    decisions = await c.store.gap_decisions(
        principal.tenant_id, [t.transcript_id for t in rows])
    def _gap(t):
        d = decisions.get(t.transcript_id)
        return {
            "transcript_id": t.transcript_id, "run_id": t.run_id,
            "agent_key": t.agent_key, "agent_version": t.agent_version,
            "missing_knowledge": (t.feedback or {}).get("missing_knowledge"),
            "knowledge_relevance": (t.feedback or {}).get("knowledge_relevance"),
            "adoption": (t.feedback or {}).get("adoption"),
            "decided_by": t.decided_by,
            "decided_at": t.decided_at.isoformat() if t.decided_at else None,
            "gap_status": d["status"] if d else None,
            "gap_decided_by": d["decided_by"] if d else None,
            "gap_decided_at": d["decided_at"].isoformat() if d else None,
        }
    return {"data": [_gap(t) for t in rows],
            "page": {"next_cursor": None, "has_more": False}}


@router.post("/knowledge-gaps/{transcript_id}/decision")
async def decide_knowledge_gap(request: Request, transcript_id: str, body: dict):
    """WS5 steward triage: mark a gap ``handled`` (a governed proposal or type
    was opened from it) or ``dismissed`` (judged noise). The transcript corpus
    is never mutated — triage lives in its own table. Re-deciding upserts."""
    principal = await principal_of(request)
    status = (body or {}).get("status")
    if status not in ("handled", "dismissed"):
        raise ValidationFailed("status must be 'handled' or 'dismissed'")
    c = request.app.state.container
    rec = await c.store.decide_knowledge_gap(
        principal.tenant_id, transcript_id,
        status=status, decided_by=principal.sub)
    if rec is None:
        raise NotFound("no knowledge gap for that transcript")
    return {"data": {
        "transcript_id": rec["transcript_id"], "status": rec["status"],
        "decided_by": rec["decided_by"],
        "decided_at": rec["decided_at"].isoformat()
        if rec.get("decided_at") is not None and not isinstance(rec["decided_at"], str)
        else rec.get("decided_at"),
    }}


@router.get("/transcripts/{transcript_id}")
async def get_transcript(request: Request, transcript_id: str):
    principal = await principal_of(request)
    c = request.app.state.container
    t = await c.store.get_transcript(principal.tenant_id, transcript_id)
    if t is None:
        raise NotFound("transcript not found")
    return {"data": _view(t)}
