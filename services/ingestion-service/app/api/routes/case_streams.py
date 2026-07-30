"""Case Stream endpoints (realtime-case-streams add-on, slice 3).

Authz reuses the ingestion.schedule.* action catalog deliberately: a stream IS
a governed wrapper over a schedule, so whoever may manage schedules in a
workspace may manage its streams — no new action-catalog entries to seed. The
add-on boundary is the ENTITLEMENT gate inside CaseStreamService (create and
resume), not a new RBAC action.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Response

from app.api.deps import ContainerDep, PrincipalDep, tenant_urn
from app.api.schemas import CaseStreamCreate, CaseStreamPatch
from app.domain.policy import authorize
from app.domain.services.case_streams import CaseStreamService

router = APIRouter(prefix="/case-streams", tags=["case-streams"])


@router.post("", status_code=201)
async def create_case_stream(
    body: CaseStreamCreate, principal: PrincipalDep, container: ContainerDep
) -> dict[str, Any]:
    await authorize(
        container.policy,
        principal,
        "ingestion.schedule.create",
        tenant_urn(principal.tenant_id, "schedule", "*"),
    )
    return {"data": await CaseStreamService(container).create(principal, body)}


@router.get("")
async def list_case_streams(
    principal: PrincipalDep, container: ContainerDep, workspace_id: str | None = None
) -> dict[str, Any]:
    await authorize(
        container.policy,
        principal,
        "ingestion.schedule.read",
        tenant_urn(principal.tenant_id, "schedule", "*"),
    )
    return {"data": await CaseStreamService(container).list(principal, workspace_id)}


@router.get("/{stream_id}")
async def get_case_stream(
    stream_id: str, principal: PrincipalDep, container: ContainerDep
) -> dict[str, Any]:
    await authorize(
        container.policy,
        principal,
        "ingestion.schedule.read",
        tenant_urn(principal.tenant_id, "schedule", stream_id),
    )
    return {"data": await CaseStreamService(container).get(principal, stream_id)}


@router.post("/{stream_id}/pause")
async def pause_case_stream(
    stream_id: str, principal: PrincipalDep, container: ContainerDep
) -> dict[str, Any]:
    await authorize(
        container.policy,
        principal,
        "ingestion.schedule.update",
        tenant_urn(principal.tenant_id, "schedule", stream_id),
    )
    return {"data": await CaseStreamService(container).pause(principal, stream_id)}


@router.post("/{stream_id}/resume")
async def resume_case_stream(
    stream_id: str, principal: PrincipalDep, container: ContainerDep
) -> dict[str, Any]:
    await authorize(
        container.policy,
        principal,
        "ingestion.schedule.update",
        tenant_urn(principal.tenant_id, "schedule", stream_id),
    )
    return {"data": await CaseStreamService(container).resume(principal, stream_id)}


@router.patch("/{stream_id}")
async def patch_case_stream(
    stream_id: str, body: CaseStreamPatch, principal: PrincipalDep, container: ContainerDep
) -> dict[str, Any]:
    await authorize(
        container.policy,
        principal,
        "ingestion.schedule.update",
        tenant_urn(principal.tenant_id, "schedule", stream_id),
    )
    return {"data": await CaseStreamService(container).patch(principal, stream_id, body)}


@router.delete("/{stream_id}", status_code=204)
async def delete_case_stream(
    stream_id: str, principal: PrincipalDep, container: ContainerDep
) -> Response:
    await authorize(
        container.policy,
        principal,
        "ingestion.schedule.delete",
        tenant_urn(principal.tenant_id, "schedule", stream_id),
    )
    await CaseStreamService(container).delete(principal, stream_id)
    return Response(status_code=204)
