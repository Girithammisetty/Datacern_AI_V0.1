"""Unit tests for the pack_sku entitlement gate (BRD 66 slice 3, CPL-FR-030).

No live stack needed: the Redis dependency is faked at the `redis.asyncio`
client boundary (a `.get(key)` coroutine), matching this repo's convention of
testing decision logic against a narrow fake rather than a live/dockerized
Redis for the unit tier (see test_pack_service.py's `_FakeClient` for the
installer's own equivalent pattern).
"""

from __future__ import annotations

import json
import types

import pytest

from app.domain import catalog, entitlements, installer
from app.domain.errors import EntitlementRequired, EntitlementUnavailable


class _FakeRedis:
    """Minimal async fake: only the `.get` coroutine entitlements.py calls."""

    def __init__(self, value: str | None = None, *, raise_on_get: Exception | None = None):
        self._value = value
        self._raise = raise_on_get

    async def get(self, _key: str) -> str | None:
        if self._raise is not None:
            raise self._raise
        return self._value


def _flat(entitlements_list: list[dict]) -> str:
    return json.dumps({
        "v": 1, "computed_at": "2026-07-25T00:00:00Z", "plan_key": "pilot",
        "plan_version": 1, "commercial_state": "active", "entitlements": entitlements_list,
    })


ENTITLED_BODY = _flat([{"kind": "pack_sku", "key": "card-disputes", "provenance": "plan_default"}])
BLOCKED_BODY = _flat([{"kind": "pack_sku", "key": "some-other-pack", "provenance": "plan_default"}])
EMPTY_BODY = _flat([])


async def test_check_pack_sku_entitled():
    status = await entitlements.check_pack_sku(_FakeRedis(ENTITLED_BODY), "t-1", "card-disputes")
    assert status is entitlements.EntitlementStatus.ENTITLED


async def test_check_pack_sku_blocked_when_projection_present_but_sku_absent():
    status = await entitlements.check_pack_sku(_FakeRedis(BLOCKED_BODY), "t-1", "card-disputes")
    assert status is entitlements.EntitlementStatus.BLOCKED


async def test_check_pack_sku_blocked_when_no_entitlements_at_all():
    status = await entitlements.check_pack_sku(_FakeRedis(EMPTY_BODY), "t-1", "card-disputes")
    assert status is entitlements.EntitlementStatus.BLOCKED


async def test_check_pack_sku_unavailable_when_redis_is_none():
    # No REDIS_ADDR wired (e.g. use_real_adapters=False) -- fail closed, never
    # silently entitled.
    status = await entitlements.check_pack_sku(None, "t-1", "card-disputes")
    assert status is entitlements.EntitlementStatus.UNAVAILABLE


async def test_check_pack_sku_unavailable_when_key_missing():
    status = await entitlements.check_pack_sku(_FakeRedis(None), "t-1", "card-disputes")
    assert status is entitlements.EntitlementStatus.UNAVAILABLE


async def test_check_pack_sku_unavailable_when_redis_errors():
    status = await entitlements.check_pack_sku(
        _FakeRedis(raise_on_get=ConnectionError("redis down")), "t-1", "card-disputes",
    )
    assert status is entitlements.EntitlementStatus.UNAVAILABLE


async def test_check_pack_sku_unavailable_when_payload_is_corrupt():
    status = await entitlements.check_pack_sku(_FakeRedis("not json"), "t-1", "card-disputes")
    assert status is entitlements.EntitlementStatus.UNAVAILABLE


def test_key_shape_matches_identity_service_projection():
    # ent:{tenant}:flat -- must byte-for-byte match identity-service's
    # projection.Key (services/identity-service/internal/projection/keys.go)
    # since both services read/write the SAME Redis key.
    assert entitlements.key("019f-tenant") == "ent:019f-tenant:flat"


# ---- installer.plan()'s entitlement branch (CPL-FR-030's "prepend to the ---
# ---- ops list instead of proceeding into the per-component loop") ---------

REPO_PACKS = None  # set by conftest-equivalent fixture below


@pytest.fixture(autouse=True)
def _configure_catalog():
    from pathlib import Path

    catalog.configure(str(Path(__file__).resolve().parents[4] / "packs"))


class _FakeClient:
    workspace_id = "ws-1"
    endpoints = types.SimpleNamespace(
        case="c", rbac="r", query="q", agent="a", semantic="s",
        chart="ch", dataset="d", ingestion="i", memory="m", pipeline="p", identity="id")

    @staticmethod
    def author_token():
        return "tok"

    @staticmethod
    def _req(method, url, tok):
        raise AssertionError("plan() must not touch the client when entitled=False")


def test_plan_not_entitled_returns_single_blocked_root_op():
    manifest = catalog.load_manifest("card-disputes")
    ops = installer.plan(_FakeClient(), manifest, entitled=False)
    assert ops == [{"kind": "root", "identity": "card-disputes",
                     "action": "blocked", "detail": "entitlement"}]


def test_plan_entitled_true_is_the_default_and_unchanged():
    # Non-regression: every existing caller of plan() (no entitled kwarg)
    # keeps materializing the real per-component plan.
    manifest = catalog.load_manifest("card-disputes")

    class _Resp:
        status_code = 200

        @staticmethod
        def json():
            return {"data": []}

    class _RealFakeClient(_FakeClient):
        @staticmethod
        def _req(method, url, tok):
            return _Resp()

    ops = installer.plan(_RealFakeClient(), manifest)
    assert any(o["kind"] == "dispositions" and o["action"] == "create" for o in ops)


# ---- error envelope (CPL-FR-030's exact contract) --------------------------

def test_entitlement_required_error_envelope():
    err = EntitlementRequired("banking-aml")
    assert err.status == 403
    assert err.code == "ENTITLEMENT_REQUIRED"
    assert err.details == {"missing_sku": "banking-aml"}
    assert "banking-aml" in err.message


def test_entitlement_unavailable_error_envelope():
    err = EntitlementUnavailable()
    assert err.status == 503
    assert err.code == "ENTITLEMENT_UNAVAILABLE"
