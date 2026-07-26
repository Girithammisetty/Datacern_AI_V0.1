"""pack_sku entitlement gate (BRD 66 slice 3, CPL-FR-030).

Reads the `entitlements_flat` Redis projection identity-service's commercial-
plane projection worker writes -- one JSON blob per tenant at
`ent:{tenant}:flat` (see docs/initiatives/commercial-plane.md
"entitlements_flat Redis projection" and
services/identity-service/internal/projection/{keys,redis}.go for the
authoritative key/schema). pack-service reads it directly, no synchronous
identity-service call in the request path (CPL-NFR-001) -- the same direct-
Redis pattern rbac-service uses for `permissions_flat` (internal/projection/
reader.go) and pack-service itself already uses for the OPA authz projection
(app/api/auth.py's OpaAuthzClient). Per the wave-1 "self-contained services"
convention (docs/platform/CONVENTIONS.md), this is a small vendored copy of
the read-side contract, not a cross-service import.
"""

from __future__ import annotations

import enum
import json
from typing import Any

import redis.asyncio as aioredis


def key(tenant_id: str) -> str:
    """ent:{tenant}:flat -- the key identity-service's projection worker writes."""
    return f"ent:{tenant_id}:flat"


class EntitlementStatus(enum.Enum):
    """Outcome of a pack_sku entitlement check (CPL-FR-030)."""

    ENTITLED = "entitled"
    BLOCKED = "blocked"
    #: the projection key is missing/unreadable -- fail CLOSED (CPL-NFR-004),
    #: never silently ENTITLED.
    UNAVAILABLE = "unavailable"


async def check_pack_sku(
    redis: aioredis.Redis | None, tenant_id: str, pack_name: str
) -> EntitlementStatus:
    """CPL-FR-030: is `pack_sku:{pack_name}` entitled for this tenant?

    Fail-closed (CPL-NFR-004): any Redis error, a missing projection key, or a
    corrupt payload returns UNAVAILABLE -- entitlement-gated writes (install)
    must not silently proceed when the projection can't be consulted. A
    present projection with no matching `pack_sku` entitlement is BLOCKED
    (not unavailable) -- that is the legitimate "not entitled" outcome.
    """
    if redis is None:
        return EntitlementStatus.UNAVAILABLE
    try:
        raw = await redis.get(key(tenant_id))
    except Exception:  # noqa: BLE001 - any Redis failure is "unavailable"
        return EntitlementStatus.UNAVAILABLE
    if not raw:
        return EntitlementStatus.UNAVAILABLE
    try:
        doc: dict[str, Any] = json.loads(raw)
    except (TypeError, ValueError):
        return EntitlementStatus.UNAVAILABLE
    for ent in doc.get("entitlements") or []:
        if ent.get("kind") == "pack_sku" and ent.get("key") == pack_name:
            return EntitlementStatus.ENTITLED
    return EntitlementStatus.BLOCKED
