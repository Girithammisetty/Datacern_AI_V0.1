"""Case Streams API (realtime-case-streams add-on, slice 3).

The stream is a gated binding over the EXISTING watermark-schedule engine, so
these tests assert three things and only these: the entitlement gate's three
outcomes at the two gated verbs (create, resume), the composition (a created
stream really owns a live watermark schedule), and the ungated lifecycle
(pause/delete work for a lapsed tenant).
"""

from __future__ import annotations

import json

from app.domain.entitlements import FEATURE_REALTIME_CASE_STREAMS, key
from app.domain.querysource import FakeQuerySource
from tests.util import TENANT_A, create_connection

ROWS = [
    {"id": 1, "updated_at": "2026-07-02T00:00:00+00:00"},
    {"id": 2, "updated_at": "2026-07-04T00:00:00+00:00"},
]

ENTITLED_BLOB = json.dumps(
    {"v": 1, "entitlements": [{"kind": "feature", "key": FEATURE_REALTIME_CASE_STREAMS}]}
)
UNENTITLED_BLOB = json.dumps(
    # kind matters: a pack_sku sharing the key string must not unlock the feature.
    {"v": 1, "entitlements": [{"kind": "pack_sku", "key": FEATURE_REALTIME_CASE_STREAMS}]}
)


class FakeEntRedis:
    """entitlements_flat projection double: async get() over a dict, or raise."""

    def __init__(self, blobs: dict[str, str] | None = None, fail: bool = False):
        self.blobs = blobs or {}
        self.fail = fail

    async def get(self, k: str):
        if self.fail:
            raise ConnectionError("redis down")
        return self.blobs.get(k)


def entitle(container, tenant_id: str = TENANT_A) -> None:
    container.entitlements_redis = FakeEntRedis({key(tenant_id): ENTITLED_BLOB})


def stream_payload(connection_id: str, **overrides):
    return {
        "name": "high-value-orders",
        "connection_id": connection_id,
        "interval_seconds": 300,
        "timezone": "UTC",
        "ingestion_template": {
            "ingestion_mode": "query",
            "statement": "SELECT * FROM public.orders",
            "new_dataset": {"name": "orders-stream"},
        },
        "watermark": {
            "column": "updated_at",
            "operator": ">",
            "value_type": "timestamp",
            "initial_value": "2026-07-01T00:00:00+00:00",
        },
        "enabled": True,
        **overrides,
    }


async def make_stream(client, auth, container, **overrides):
    container.query_sources.set("postgres", FakeQuerySource(rows=ROWS))
    entitle(container)
    conn = await create_connection(client, auth)
    resp = await client.post(
        "/api/v1/case-streams", json=stream_payload(conn["id"], **overrides), headers=auth
    )
    assert resp.status_code == 201, resp.text
    return conn, resp.json()["data"]


# ---- the gate --------------------------------------------------------------


async def test_create_without_entitlement_is_403_naming_the_sku(client, auth_a, container):
    container.query_sources.set("postgres", FakeQuerySource(rows=ROWS))
    container.entitlements_redis = FakeEntRedis({key(TENANT_A): UNENTITLED_BLOB})
    conn = await create_connection(client, auth_a)

    resp = await client.post(
        "/api/v1/case-streams", json=stream_payload(conn["id"]), headers=auth_a
    )

    assert resp.status_code == 403, resp.text
    msg = resp.json()["error"]["message"]
    assert "realtime-case-streams" in msg and "realtime_case_streams" in msg


async def test_create_fails_closed_when_projection_unreadable(client, auth_a, container):
    """Redis down / no projection / no client at all → 503 ENTITLEMENT_UNAVAILABLE.
    "Could not check" is never "not entitled" and never a silent grant."""
    container.query_sources.set("postgres", FakeQuerySource(rows=ROWS))
    conn = await create_connection(client, auth_a)

    for broken in (FakeEntRedis(fail=True), FakeEntRedis({}), None):
        container.entitlements_redis = broken
        resp = await client.post(
            "/api/v1/case-streams", json=stream_payload(conn["id"]), headers=auth_a
        )
        assert resp.status_code == 503, resp.text
        assert resp.json()["error"]["code"] == "ENTITLEMENT_UNAVAILABLE"


async def test_entitled_create_composes_a_live_watermark_schedule(client, auth_a, container):
    _conn, stream = await make_stream(client, auth_a, container)

    assert stream["status"] == "active"
    assert stream["schedule"]["watermark"]["column"] == "updated_at"
    assert stream["schedule"]["watermark"]["current_value"] == "2026-07-01T00:00:00+00:00"
    assert stream["schedule"]["next_fire_at"] is not None

    # The underlying schedule is a real schedules-API object, not a shadow copy.
    sched = await client.get(f"/api/v1/schedules/{stream['schedule_id']}", headers=auth_a)
    assert sched.status_code == 200
    assert sched.json()["data"]["watermark"]["column"] == "updated_at"


async def test_duplicate_stream_name_in_workspace_is_409(client, auth_a, container):
    conn, _ = await make_stream(client, auth_a, container)
    resp = await client.post(
        "/api/v1/case-streams", json=stream_payload(conn["id"]), headers=auth_a
    )
    assert resp.status_code == 409, resp.text


# ---- lifecycle -------------------------------------------------------------


async def test_pause_is_never_gated_resume_is(client, auth_a, container):
    """A lapsed tenant can always turn a stream OFF; turning it back ON
    re-checks the entitlement (CPL-FR-022 precedent)."""
    _conn, stream = await make_stream(client, auth_a, container)

    # entitlement lapses (projection now readable but without the grant)
    container.entitlements_redis = FakeEntRedis({key(TENANT_A): UNENTITLED_BLOB})

    paused = await client.post(f"/api/v1/case-streams/{stream['id']}/pause", headers=auth_a)
    assert paused.status_code == 200, paused.text
    assert paused.json()["data"]["status"] == "paused"
    assert paused.json()["data"]["schedule"]["enabled"] is False

    resumed = await client.post(f"/api/v1/case-streams/{stream['id']}/resume", headers=auth_a)
    assert resumed.status_code == 403, resumed.text

    # entitlement restored → resume works and the schedule re-enables
    entitle(container)
    resumed = await client.post(f"/api/v1/case-streams/{stream['id']}/resume", headers=auth_a)
    assert resumed.status_code == 200, resumed.text
    assert resumed.json()["data"]["status"] == "active"
    assert resumed.json()["data"]["schedule"]["enabled"] is True


async def test_patch_binds_a_case_trigger_and_delete_frees_the_name(client, auth_a, container):
    conn, stream = await make_stream(client, auth_a, container)

    trig_id = "22222222-2222-7222-8222-222222222222"
    patched = await client.patch(
        f"/api/v1/case-streams/{stream['id']}", json={"case_trigger_id": trig_id}, headers=auth_a
    )
    assert patched.status_code == 200
    assert patched.json()["data"]["case_trigger_id"] == trig_id

    # delete is never gated, removes the underlying schedule, and frees the name
    container.entitlements_redis = FakeEntRedis({key(TENANT_A): UNENTITLED_BLOB})
    deleted = await client.delete(f"/api/v1/case-streams/{stream['id']}", headers=auth_a)
    assert deleted.status_code == 204
    gone = await client.get(f"/api/v1/case-streams/{stream['id']}", headers=auth_a)
    assert gone.status_code == 404
    sched_gone = await client.get(f"/api/v1/schedules/{stream['schedule_id']}", headers=auth_a)
    assert sched_gone.status_code == 404

    entitle(container)
    resp = await client.post(
        "/api/v1/case-streams", json=stream_payload(conn["id"]), headers=auth_a
    )
    assert resp.status_code == 201, resp.text


async def test_list_scopes_to_workspace_filter(client, auth_a, container):
    _conn, stream = await make_stream(client, auth_a, container)
    listed = await client.get("/api/v1/case-streams", headers=auth_a)
    assert listed.status_code == 200
    assert [s["id"] for s in listed.json()["data"]] == [stream["id"]]

    other = await client.get(
        "/api/v1/case-streams",
        params={"workspace_id": "33333333-3333-7333-8333-333333333333"},
        headers=auth_a,
    )
    assert other.json()["data"] == []
