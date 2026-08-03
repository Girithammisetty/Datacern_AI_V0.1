"""Domain ontology: a governed entity-TYPE registry (inc11). A capability pack
(or a tenant) declares the entity types its vertical operates on (Vendor,
Invoice, PaymentRun, ...) with their attributes + typed RELATIONSHIPS to other
types — the type-level domain model, distinct from dataset-derived semantic
entities (flat) and from entity RESOLUTION (which resolves instances)."""

from __future__ import annotations

from fastapi import APIRouter, Body, Depends, Query, Request, Response

from app.api.auth import Principal, require
from app.domain.errors import ValidationFailed

router = APIRouter(prefix="/api/v1")


def _c(request: Request):
    return request.app.state.container


def _payload(e) -> dict:
    return {
        "id": e.id, "entity_key": e.entity_key, "workspace_id": e.workspace_id,
        "name": e.name, "description": e.description,
        "attributes": e.attributes, "relationships": e.relationships,
        "version_no": e.version_no,
        "created_at": e.created_at.isoformat() if e.created_at else None,
    }


def _version_payload(v) -> dict:
    return {
        "entity_key": v.entity_key, "workspace_id": v.workspace_id,
        "version_no": v.version_no, "status": v.status,
        "name": v.name, "description": v.description,
        "attributes": v.attributes, "relationships": v.relationships,
        "diff": v.diff, "submitted_by": v.submitted_by, "approved_by": v.approved_by,
        "decision_note": v.decision_note,
        "created_at": v.created_at.isoformat() if v.created_at else None,
        "decided_at": v.decided_at.isoformat() if v.decided_at else None,
    }


@router.post("/ontology/entities", status_code=201)
async def create_entity(
    request: Request, body: dict = Body(...),
    principal: Principal = Depends(require("dataset.ontology.create")),
):
    workspace_id = body.get("workspace_id")
    if not workspace_id:
        raise ValidationFailed("workspace_id is required")
    e = await _c(request).ontology_service.create(
        principal.ctx(), workspace_id, body)
    return {"data": _payload(e)}


@router.get("/ontology/entities")
async def list_entities(
    request: Request,
    principal: Principal = Depends(require("dataset.ontology.read")),
    workspace_id: str | None = Query(default=None, alias="filter[workspace_id]"),
):
    items = await _c(request).ontology_service.list(principal.ctx(), workspace_id)
    return {"data": [_payload(e) for e in items]}


@router.get("/ontology/entities/{entity_key}")
async def get_entity(
    request: Request, entity_key: str,
    principal: Principal = Depends(require("dataset.ontology.read")),
    workspace_id: str = Query(alias="filter[workspace_id]"),
):
    e = await _c(request).ontology_service.get(principal.ctx(), workspace_id, entity_key)
    return {"data": _payload(e)}


@router.delete("/ontology/entities/{entity_key}", status_code=204)
async def delete_entity(
    request: Request, entity_key: str,
    principal: Principal = Depends(require("dataset.ontology.delete")),
    workspace_id: str = Query(alias="filter[workspace_id]"),
):
    await _c(request).ontology_service.delete(principal.ctx(), workspace_id, entity_key)
    return Response(status_code=204)


# ---- WS4 data contracts -----------------------------------------------------


@router.post("/ontology/entities/{entity_key}/contract-check")
async def contract_check(
    request: Request, entity_key: str, body: dict = Body(...),
    principal: Principal = Depends(require("dataset.dataset.read")),
):
    """Enforce the type's attribute constraints (required/enum) against a
    dataset's real rows through an attribute -> column map. Read-only; gated on
    dataset.dataset.read because it reads dataset content."""
    workspace_id = body.get("workspace_id")
    dataset_id = body.get("dataset_id")
    if not workspace_id or not dataset_id:
        raise ValidationFailed("workspace_id and dataset_id are required")
    row_limit = body.get("row_limit") or 20000
    if not isinstance(row_limit, int) or row_limit < 1:
        raise ValidationFailed("row_limit must be a positive integer")
    result = await _c(request).dataset_service.check_ontology_contract(
        principal.ctx(), workspace_id, entity_key, dataset_id,
        attribute_map=body.get("attribute_map") or {}, row_limit=row_limit)
    return {"data": result}


# ---- versioned four-eyes update (WS3) --------------------------------------


@router.get("/ontology/entities/{entity_key}/versions")
async def list_versions(
    request: Request, entity_key: str,
    principal: Principal = Depends(require("dataset.ontology.read")),
    workspace_id: str = Query(alias="filter[workspace_id]"),
):
    """The type's revision history + any in-review proposal (newest first)."""
    vs = await _c(request).ontology_service.list_versions(principal.ctx(), workspace_id, entity_key)
    return {"data": [_version_payload(v) for v in vs]}


@router.post("/ontology/entities/{entity_key}/versions", status_code=201)
async def propose_update(
    request: Request, entity_key: str, body: dict = Body(...),
    principal: Principal = Depends(require("dataset.ontology.update")),
):
    """Open an in-review update to a type's definition (name/description/
    attributes/relationships). The live type is unchanged until a DISTINCT
    approver publishes it."""
    workspace_id = body.get("workspace_id")
    if not workspace_id:
        raise ValidationFailed("workspace_id is required")
    v = await _c(request).ontology_service.propose_update(
        principal.ctx(), workspace_id, entity_key, body)
    return {"data": _version_payload(v)}


@router.post("/ontology/entities/{entity_key}/versions/{version_no}/approve")
async def approve_update(
    request: Request, entity_key: str, version_no: int, body: dict = Body(default={}),
    principal: Principal = Depends(require("dataset.ontology.approve")),
):
    """Publish an in-review update (four-eyes: approver ≠ submitter)."""
    workspace_id = body.get("workspace_id")
    if not workspace_id:
        raise ValidationFailed("workspace_id is required")
    v = await _c(request).ontology_service.approve_update(
        principal.ctx(), workspace_id, entity_key, version_no, body.get("note"))
    return {"data": _version_payload(v)}


@router.post("/ontology/entities/{entity_key}/versions/{version_no}/reject")
async def reject_update(
    request: Request, entity_key: str, version_no: int, body: dict = Body(default={}),
    principal: Principal = Depends(require("dataset.ontology.approve")),
):
    """Reject an in-review update; the live type is unchanged."""
    workspace_id = body.get("workspace_id")
    if not workspace_id:
        raise ValidationFailed("workspace_id is required")
    v = await _c(request).ontology_service.reject_update(
        principal.ctx(), workspace_id, entity_key, version_no, body.get("note"))
    return {"data": _version_payload(v)}
