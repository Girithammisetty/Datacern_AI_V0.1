"""Decision outcome monitoring (BRD 55) — realized outcomes on decisions.

Attach a REALIZED outcome to a decision (a proposal produced by an agent,
decision table, or persona copilot), joined on the decision's provenance; read
decision EFFECTIVENESS (decided-vs-realized agreement) sliced by decision type
or producer. Labels annotate, never mutate a closed decision (BR-1); tenant-
scoped (RLS); audited via the store. Correlational effectiveness only (BR-3).
"""

from __future__ import annotations

from fastapi import APIRouter, Body, Query, Request

from app.api.auth import principal_of
from app.domain.entities import new_uuid
from app.domain.errors import NotFound, PermissionDenied, ValidationFailed
from app.domain.outcomes import (
    LABEL_SOURCES,
    OutcomeLabel,
    compute_correct,
    detect_drift,
    effectiveness,
    sft_enrichment,
)

router = APIRouter(prefix="/api/v1")


async def _require(request: Request, principal, action: str) -> None:
    c = request.app.state.container
    if not await c.authz.allow(subject=principal.actor, action=action,
                               tenant=principal.tenant_id,
                               workspace_id=getattr(principal, "workspace_id", None)):
        raise PermissionDenied(f"{action} capability required")


def _label_view(lab: OutcomeLabel) -> dict:
    return {"id": lab.label_id, "decision_ref": lab.decision_ref,
            "decision_type": lab.decision_type, "producer": lab.producer,
            "decided_outcome": lab.decided_outcome,
            "realized_outcome": lab.realized_outcome, "correct": lab.correct,
            "label_source": lab.label_source, "note": lab.note,
            "labeled_by": lab.labeled_by}


def _decided_outcome_of(prop) -> str | None:
    """What the platform DECIDED for this proposal — the disposition-ish outcome
    carried in the proposal args (severity/disposition), else None."""
    a = prop.args or {}
    return (a.get("disposition_code") or a.get("target_stage")
            or a.get("severity") or a.get("disposition_id"))


@router.post("/decisions/{decision_ref}/outcome", status_code=201)
async def mark_outcome(request: Request, decision_ref: str, body: dict = Body(...)):
    """Record the realized outcome of a decision (DM-FR-010 human path). Joins
    the decided outcome + producer from the referenced proposal when it exists,
    so effectiveness needs no extra input. Reuses case.case.update (the pack
    roles that decide also record outcomes); a dedicated decision.outcome.* is
    inc2."""
    principal = await principal_of(request)
    await _require(request, principal, "case.case.update")
    c = request.app.state.container

    realized = str(body.get("realized_outcome") or "").strip()
    if not realized:
        raise ValidationFailed("realized_outcome is required")
    source = str(body.get("label_source") or "human")
    if source not in LABEL_SOURCES:
        raise ValidationFailed(f"label_source must be one of {LABEL_SOURCES}")

    # Join provenance from the proposal (best-effort — decision_ref may also be a
    # case/decision urn labeled directly, in which case the caller supplies type).
    prop = await c.store.get_proposal(principal.tenant_id, decision_ref)
    if prop is not None:
        decision_type = body.get("decision_type") or prop.tool_id
        producer = prop.agent_key
        decided = _decided_outcome_of(prop)
    else:
        decision_type = body.get("decision_type")
        producer = body.get("producer")
        decided = body.get("decided_outcome")
        if not decision_type:
            raise NotFound("no proposal for that decision_ref; pass decision_type")

    lab = OutcomeLabel(
        label_id=new_uuid(), tenant_id=principal.tenant_id, decision_ref=decision_ref,
        decision_type=decision_type, producer=producer, decided_outcome=decided,
        realized_outcome=realized, correct=compute_correct(decided, realized),
        label_source=source, note=body.get("note"), labeled_by=principal.sub)
    await c.store.upsert_outcome_label(lab)
    return {"data": _label_view(lab)}


@router.post("/outcomes/ingest", status_code=200)
async def ingest_outcomes(request: Request, body: dict = Body(...)):
    """Close the outcome loop: ingest REALIZED outcomes from the system of
    record automatically (DM-FR-011 / OM inbound). The SoR knows a business
    entity — a case/claim/dispute URN — not our internal decision id, so each
    item is keyed by ``business_urn`` (+ optional ``decision_type``) and
    resolved back to the ACTIONED decision(s) that produced it. Every resolved
    decision gets a ``label_source=sor`` (or ``event``) outcome label with
    agreement computed against what the platform decided; unresolved keys are
    reported honestly, never fabricated. Idempotent per decision (annotate,
    never mutate — the label upsert is keyed by decision_ref).

    This is the seam a connector, webhook, or event relay pushes the SoR's
    realized results into; once recorded, the labels flow into decision
    effectiveness (the agreement number) AND into SFT curation weighting (a
    correct decision is imitated, an incorrect one down-weighted) with no
    further call — the model learns from reality, not just from execution.

    Service-authenticated (reuses ``case.case.update``, matching the human
    path; a dedicated ``decision.outcome.*`` action is a later increment)."""
    principal = await principal_of(request)
    await _require(request, principal, "case.case.update")
    c = request.app.state.container

    source = str(body.get("label_source") or "sor")
    if source not in LABEL_SOURCES:
        raise ValidationFailed(f"label_source must be one of {LABEL_SOURCES}")
    items = body.get("outcomes")
    if not isinstance(items, list) or not items:
        raise ValidationFailed("outcomes must be a non-empty list")

    resolved: list[dict] = []
    unmatched: list[dict] = []
    for i, item in enumerate(items):
        business_urn = str((item or {}).get("business_urn") or "").strip()
        realized = str((item or {}).get("realized_outcome") or "").strip()
        dtype = (item or {}).get("decision_type")
        if not business_urn or not realized:
            raise ValidationFailed(
                f"outcomes[{i}]: business_urn and realized_outcome are required")
        props = await c.store.find_actioned_proposals_by_urn(
            principal.tenant_id, business_urn=business_urn, decision_type=dtype)
        if not props:
            # Honest: the SoR sent an outcome for an entity no actioned decision
            # touched. Report it — never invent a decision to attach it to.
            unmatched.append({"business_urn": business_urn, "reason": "no_actioned_decision"})
            continue
        for prop in props:
            decided = _decided_outcome_of(prop)
            lab = OutcomeLabel(
                label_id=new_uuid(), tenant_id=principal.tenant_id,
                decision_ref=prop.proposal_id, decision_type=prop.tool_id,
                producer=prop.agent_key, decided_outcome=decided,
                realized_outcome=realized,
                correct=compute_correct(decided, realized),
                label_source=source, note=(item or {}).get("note"),
                labeled_by=principal.sub)
            await c.store.upsert_outcome_label(lab)
            resolved.append(_label_view(lab))

    return {"data": {"resolved": len(resolved), "unmatched": unmatched,
                     "labels": resolved}}


@router.get("/decisions/{decision_ref}/outcome")
async def get_outcome(request: Request, decision_ref: str):
    principal = await principal_of(request)
    await _require(request, principal, "case.case.read")
    c = request.app.state.container
    lab = await c.store.get_outcome_label(principal.tenant_id, decision_ref)
    if lab is None:
        raise NotFound("no outcome recorded for that decision")
    return {"data": _label_view(lab)}


@router.get("/decision-effectiveness")
async def decision_effectiveness(request: Request,
                                 by: str = Query(default="decision_type"),
                                 decision_type: str | None = Query(default=None)):
    """Decision-effectiveness KPIs: decided-vs-realized agreement, grouped by
    decision_type or producer (OM-FR-020). The monitoring surface that separates
    a DI platform from a static rules engine."""
    principal = await principal_of(request)
    await _require(request, principal, "case.case.read")
    if by not in ("decision_type", "producer"):
        raise ValidationFailed("by must be 'decision_type' or 'producer'")
    c = request.app.state.container
    labels = await c.store.list_outcome_labels(principal.tenant_id,
                                               decision_type=decision_type)
    return {"data": {"by": by, "labeled_decisions": len(labels),
                     "groups": effectiveness(labels, by=by)}}


@router.get("/decision-drift")
async def decision_drift(request: Request,
                         by: str = Query(default="decision_type"),
                         min_drop: float = Query(default=0.15, ge=0.0, le=1.0),
                         min_scored: int = Query(default=10, ge=1)):
    """Decision-drift signals (OM-FR-030): per decision type (or producer), a
    material drop in effectiveness between an earlier baseline window and the
    recent window. A REVIEW signal only — the governance agent turns a flag into
    a proposal-mode review (AC-3); nothing here auto-retires a model or table.
    Correlational (BR-3), RLS-scoped, deterministic."""
    principal = await principal_of(request)
    await _require(request, principal, "case.case.read")
    if by not in ("decision_type", "producer"):
        raise ValidationFailed("by must be 'decision_type' or 'producer'")
    # The store lists newest-first; detect_drift wants chronological order so the
    # baseline is the EARLIER window.
    labels = await c_store_labels_chrono(request, principal)
    signals = detect_drift(labels, by=by, min_drop=min_drop, min_scored_per_window=min_scored)
    return {"data": {"by": by, "min_drop": min_drop, "signals": signals}}


async def c_store_labels_chrono(request: Request, principal) -> list[OutcomeLabel]:
    labels = await request.app.state.container.store.list_outcome_labels(principal.tenant_id)
    return list(reversed(labels))  # DESC -> chronological (ASC)


@router.get("/decisions/{decision_ref}/sft-enrichment")
async def decision_sft_enrichment(request: Request, decision_ref: str):
    """The SFT curation annotation for a decision's transcript (OM-FR-040):
    sample_weight + outcome tag derived from its realized-correctness label, so
    curation can weight/filter by outcome (extends BRD 12 M2). 404 when the
    decision has no outcome label yet."""
    principal = await principal_of(request)
    await _require(request, principal, "case.case.read")
    lab = await request.app.state.container.store.get_outcome_label(
        principal.tenant_id, decision_ref)
    if lab is None:
        raise NotFound("no outcome label for this decision")
    return {"data": sft_enrichment(lab)}
