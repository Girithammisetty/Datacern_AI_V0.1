"""Feature entitlement gate for the realtime-case-streams add-on (slice 3).

Reads the commercial plane's `entitlements_flat` Redis projection — the same
vendored read-side contract pack-service enforces `pack_sku` with
(pack-service/app/domain/entitlements.py, CPL-FR-030) and case-service enforces
the attach-evidence surface with (case-service/internal/entitlements). One JSON
blob per tenant at ``ent:{tenant}:flat``, written by identity-service's
projection worker; no synchronous identity-service call in the request path.

Fail-closed (CPL-NFR-004): a missing/unreadable projection is UNAVAILABLE —
never silently ENTITLED, and never conflated with the legitimate "not
entitled" BLOCKED outcome.
"""

from __future__ import annotations

import enum
import json
from typing import Any

FEATURE_REALTIME_CASE_STREAMS = "realtime_case_streams"


def key(tenant_id: str) -> str:
    """ent:{tenant}:flat — the key identity-service's projection worker writes."""
    return f"ent:{tenant_id}:flat"


class EntitlementStatus(enum.Enum):
    ENTITLED = "entitled"
    BLOCKED = "blocked"
    UNAVAILABLE = "unavailable"


async def check_feature(redis: Any, tenant_id: str, feature_key: str) -> EntitlementStatus:
    """Does this tenant hold the ``feature``-kind entitlement ``feature_key``?

    ``redis`` is any object with ``async get(key) -> bytes | str | None``
    (redis.asyncio in the runtime; a fake in unit tests). Kind matters: a
    ``pack_sku`` or meter that happens to share the key string does not unlock
    the feature.
    """
    if redis is None:
        return EntitlementStatus.UNAVAILABLE
    try:
        raw = await redis.get(key(tenant_id))
    except Exception:  # noqa: BLE001 — any read failure is "could not check"
        return EntitlementStatus.UNAVAILABLE
    if not raw:
        return EntitlementStatus.UNAVAILABLE
    try:
        doc: dict[str, Any] = json.loads(raw)
    except (TypeError, ValueError):
        return EntitlementStatus.UNAVAILABLE
    for ent in doc.get("entitlements") or []:
        if ent.get("kind") == "feature" and ent.get("key") == feature_key:
            return EntitlementStatus.ENTITLED
    return EntitlementStatus.BLOCKED
