"""BRD 56 inc2 — entity-resolution merge proposals (ER-FR-030).

A data steward reviewing a below-auto merge candidate confirms it through the
SAME governed four-eyes proposal spine every write in the platform uses: this
route mints a ``dataset.entity.merge`` WriteIntent, runs it through
``ProposalService.create_from_intent`` (caller-gate: the steward must hold
``dataset.entity.merge`` on the dataset — the copilot/proposer cannot escalate),
and returns the pending proposal. A SECOND user approves it via the normal
``/proposals/{id}/decide`` endpoint (four-eyes), which executes the signed grant
through tool-plane → dataset-service's facade, confirming the merge (link layer
only; the source of record is never mutated — ER-FR-050/BR-4).
"""

from __future__ import annotations

from fastapi import APIRouter, Body, Request

from app.api.auth import principal_of
from app.domain.entities import Run, new_uuid
from app.domain.errors import ValidationFailed
from app.graphs.base import WriteIntent

router = APIRouter(prefix="/api/v1")

MERGE_TOOL_ID = "dataset.entity.merge"
MERGE_TOOL_VERSION = "1.0.0"


def _dataset_urn(tenant_id: str, dataset_id: str) -> str:
    return f"wr:{tenant_id}:dataset:dataset/{dataset_id}"


@router.post("/entity-merges", status_code=201)
async def propose_entity_merge(request: Request, body: dict = Body(...)):
    """Open a four-eyes proposal to confirm a reviewed merge candidate."""
    principal = await principal_of(request)
    c = request.app.state.container
    tenant = principal.tenant_id

    dataset_id = body.get("dataset_id")
    run_id = body.get("run_id")
    candidate_id = body.get("candidate_id")
    if not (dataset_id and run_id and candidate_id):
        raise ValidationFailed("dataset_id, run_id and candidate_id are required")
    left, right = body.get("left_pk"), body.get("right_pk")
    score = body.get("score")
    workspace_id = body.get("workspace_id") or getattr(principal, "workspace_id", None)
    approve = bool(body.get("approve", True))

    intent = WriteIntent(
        tool_id=MERGE_TOOL_ID, tool_version=MERGE_TOOL_VERSION,
        tier="write-proposal", side_effects="reversible",
        args={"candidate_id": candidate_id, "dataset_id": dataset_id, "run_id": run_id,
              "left_pk": left, "right_pk": right, "approve": approve,
              "workspace_id": workspace_id},
        rationale=(body.get("rationale")
                   or f"Confirm entity merge of {left!r} and {right!r} "
                      f"(review score {score})."),
        affected_urns=[_dataset_urn(tenant, dataset_id)],
        workspace_id=workspace_id, required_action=MERGE_TOOL_ID,
        predicted_effect={
            "summary": (f"Confirm resolved-entity merge of records {left} and {right} "
                        "in the resolution link layer (source unchanged)."),
            "reversibility": "reversible", "blast_radius": 1})

    # Synthetic run so the proposal carries provenance = the resolution run. The
    # agent_key does not resolve to a published agent_version, so the guardrail's
    # allow-list check is a no-op (no agent owns this steward-initiated tool) —
    # governance is the caller-gate above + four-eyes at decide.
    run = Run(run_id=new_uuid(), tenant_id=tenant, session_id=new_uuid(),
              agent_key=f"entity-resolution:{dataset_id}", agent_version=1,
              temporal_workflow_id=None, status="running",
              principal_type="user_obo", obo_sub=principal.sub)
    await c.store.create_run(run)
    prop, executed = await c.proposal_service.create_from_intent(
        run=run, intent=intent, obo_user=principal.sub, auto_execute_policy={})
    return {"data": {"proposal_id": prop.proposal_id, "status": prop.status,
                     "executed": executed, "run_id": run.run_id}}
