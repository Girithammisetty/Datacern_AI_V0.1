"""Model archetypes: governed model BLUEPRINTS (inc9). A capability pack (or a
tenant) declares the models a vertical EXPECTS — task/target/expected metrics/
governance — independent of any trained artifact. Distinct from registered
models (materialized from runs)."""

from __future__ import annotations

from fastapi import APIRouter, Depends, Query, Request, Response

from app.api.auth import Principal, require
from app.api.schemas import ArchetypeCreate

router = APIRouter(prefix="/api/v1")


def _c(request: Request):
    return request.app.state.container


def _payload(a) -> dict:
    return {
        "id": a.id, "archetype_key": a.archetype_key, "workspace_id": a.workspace_id,
        "name": a.name, "task_type": a.task_type, "target": a.target,
        "description": a.description, "expected_metrics": a.expected_metrics,
        "governance_notes": a.governance_notes,
        "created_at": a.created_at.isoformat() if a.created_at else None,
    }


@router.post("/archetypes", status_code=201)
async def create_archetype(
    request: Request, body: ArchetypeCreate,
    principal: Principal = Depends(require("experiment.archetype.create")),
):
    c = _c(request)
    ctx = principal.ctx(request.state.trace_id, workspace_id=body.workspace_id)
    a = await c.archetype_service.create(ctx, body.model_dump())
    return {"data": _payload(a)}


@router.get("/archetypes")
async def list_archetypes(
    request: Request,
    principal: Principal = Depends(require("experiment.archetype.read")),
    workspace_id: str | None = Query(default=None, alias="filter[workspace_id]"),
):
    c = _c(request)
    ctx = principal.ctx(request.state.trace_id, workspace_id=workspace_id)
    items = await c.archetype_service.list(ctx, workspace_id)
    return {"data": [_payload(a) for a in items]}


@router.get("/archetypes/{archetype_key}")
async def get_archetype(
    request: Request, archetype_key: str,
    principal: Principal = Depends(require("experiment.archetype.read")),
    workspace_id: str = Query(alias="filter[workspace_id]"),
):
    c = _c(request)
    ctx = principal.ctx(request.state.trace_id, workspace_id=workspace_id)
    return {"data": _payload(await c.archetype_service.get(ctx, workspace_id, archetype_key))}


@router.delete("/archetypes/{archetype_key}", status_code=204)
async def delete_archetype(
    request: Request, response: Response, archetype_key: str,
    principal: Principal = Depends(require("experiment.archetype.delete")),
    workspace_id: str = Query(alias="filter[workspace_id]"),
):
    c = _c(request)
    ctx = principal.ctx(request.state.trace_id, workspace_id=workspace_id)
    await c.archetype_service.delete(ctx, workspace_id, archetype_key)
    return Response(status_code=204)
