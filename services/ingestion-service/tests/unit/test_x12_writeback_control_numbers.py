"""Core-owned outbound control-number generation for X12 writebacks (BRD 57
STD-FR-013, BR-6, AC-6) -- exercised through the real writeback API, not the
domain function in isolation, so the enqueue() wiring itself is proven.
"""

from __future__ import annotations

from app.domain import x12_out

_CLAIM = {"claim_id": "CLM-1", "total_charge": "100.00"}


async def _outgoing_http_conn(client, auth, url: str = "http://127.0.0.1:1") -> dict:
    resp = await client.post(
        "/api/v1/connections",
        json={
            "name": "payer x12 endpoint",
            "connector_type": "http_api",
            "config": {"url": url, "method": "POST"},
            "traffic_direction": "outgoing",
            "skip_test": True,
        },
        headers=auth,
    )
    assert resp.status_code == 201, resp.text
    return resp.json()["data"]


def _x12_wb_body(conn_id: str, idem: str, **target_over) -> dict:
    return {
        "connection_id": conn_id,
        "decision_kind": "claim.corrected",
        "decision_ref": f"wr:t:case:case/{idem}",
        "idempotency_key": idem,
        "target": {
            "format": "x12",
            "sender_id": "PROVIDER1",
            "receiver_id": "PAYERX",
            "billing_provider_npi": "1234567893",
            "subscriber_id": "MEMBER123",
            **target_over,
        },
        "payload": {"claims": [_CLAIM]},
    }


async def test_core_assigns_control_numbers_when_caller_supplies_none(client, auth_a):
    conn = await _outgoing_http_conn(client, auth_a)
    r = await client.post(
        "/api/v1/writebacks", json=_x12_wb_body(conn["id"], "claim-1"), headers=auth_a
    )
    assert r.status_code == 201, r.text
    wb = r.json()["data"]
    assert wb["target"]["isa_control"] == "000000001"
    assert wb["target"]["gs_control"] == "1"
    assert wb["target"]["st_control"] == "1"
    assert x12_out.RENDERED_KEY in wb["payload"]


async def test_caller_supplied_control_numbers_are_ignored_and_overridden(client, auth_a):
    """BR-6: Core owns the sequence. A caller trying to force isa_control=999
    (e.g. a stale client, or an attempted replay) must not succeed."""
    conn = await _outgoing_http_conn(client, auth_a)
    r = await client.post(
        "/api/v1/writebacks",
        json=_x12_wb_body(
            conn["id"], "claim-2",
            isa_control="999999999", gs_control="999", st_control="999",
        ),
        headers=auth_a,
    )
    assert r.status_code == 201, r.text
    wb = r.json()["data"]
    assert wb["target"]["isa_control"] == "000000001"  # NOT the caller's 999999999
    assert "999999999" not in wb["payload"][x12_out.RENDERED_KEY]


async def test_consecutive_proposals_to_the_same_partner_get_strictly_increasing_numbers(
    client, auth_a
):
    conn = await _outgoing_http_conn(client, auth_a)
    first = (
        await client.post(
            "/api/v1/writebacks", json=_x12_wb_body(conn["id"], "claim-a"), headers=auth_a
        )
    ).json()["data"]
    second = (
        await client.post(
            "/api/v1/writebacks", json=_x12_wb_body(conn["id"], "claim-b"), headers=auth_a
        )
    ).json()["data"]
    assert first["target"]["isa_control"] == "000000001"
    assert second["target"]["isa_control"] == "000000002"
    assert first["payload"][x12_out.RENDERED_KEY] != second["payload"][x12_out.RENDERED_KEY]


async def test_different_trading_partners_get_independent_sequences(client, auth_a):
    conn = await _outgoing_http_conn(client, auth_a)
    payer_x = (
        await client.post(
            "/api/v1/writebacks", json=_x12_wb_body(conn["id"], "claim-x"), headers=auth_a
        )
    ).json()["data"]
    payer_y = (
        await client.post(
            "/api/v1/writebacks",
            json=_x12_wb_body(conn["id"], "claim-y", receiver_id="PAYERY"),
            headers=auth_a,
        )
    ).json()["data"]
    # Both are the FIRST proposal for their respective (sender, receiver) pair.
    assert payer_x["target"]["isa_control"] == "000000001"
    assert payer_y["target"]["isa_control"] == "000000001"


async def test_missing_sender_or_receiver_is_refused(client, auth_a):
    conn = await _outgoing_http_conn(client, auth_a)
    body = _x12_wb_body(conn["id"], "claim-bad")
    del body["target"]["sender_id"]
    r = await client.post("/api/v1/writebacks", json=body, headers=auth_a)
    assert r.status_code == 422, r.text
    assert "sender_id" in r.text
