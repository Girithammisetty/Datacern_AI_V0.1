"""276 claim-status-request writeback, through the real writeback API end to
end (BRD 57 STD-FR-012) -- proves render_for_writeback's 276 dispatch and the
Core-owned control-number injection (BR-6) both work together, not just in
isolation.
"""

from __future__ import annotations

from app.domain import x12_out


async def _outgoing_http_conn(client, auth, url: str = "http://127.0.0.1:1") -> dict:
    resp = await client.post(
        "/api/v1/connections",
        json={
            "name": "payer status-check endpoint",
            "connector_type": "http_api",
            "config": {"url": url, "method": "POST"},
            "traffic_direction": "outgoing",
            "skip_test": True,
        },
        headers=auth,
    )
    assert resp.status_code == 201, resp.text
    return resp.json()["data"]


def _wb_body(conn_id: str, idem: str, **target_over) -> dict:
    return {
        "connection_id": conn_id,
        "decision_kind": "claim.status_check",
        "decision_ref": f"wr:t:case:case/{idem}",
        "idempotency_key": idem,
        "target": {
            "format": "x12", "transaction_set": "276",
            "sender_id": "PROVIDER1", "receiver_id": "PAYERX",
            "payer_id": "PAYERXID", "payer_name": "PAYER X",
            "provider_npi": "1234567893", "provider_name": "PROVIDER CLINIC",
            "subscriber_id": "MEMBER1", "subscriber_last": "DOE", "subscriber_first": "JANE",
            **target_over,
        },
        "payload": {"inquiries": [{"claim_id": "CLAIM1"}]},
    }


async def test_276_status_request_is_rendered_and_control_numbers_assigned(client, auth_a):
    conn = await _outgoing_http_conn(client, auth_a)
    r = await client.post(
        "/api/v1/writebacks", json=_wb_body(conn["id"], "status-1"), headers=auth_a
    )
    assert r.status_code == 201, r.text
    wb = r.json()["data"]
    assert wb["target"]["isa_control"] == "000000001"
    rendered = wb["payload"][x12_out.RENDERED_KEY]
    assert "ST*276*1" in rendered
    assert "TRN*1*CLAIM1" in rendered


async def test_276_and_837_to_the_same_partner_share_one_sequence(client, auth_a):
    """BR-6's sequence is per (tenant, sender, receiver) -- it doesn't care
    which transaction set is being proposed, so an 837 followed by a 276 to
    the same payer must not collide."""
    conn = await _outgoing_http_conn(client, auth_a)
    claim_body = {
        "connection_id": conn["id"],
        "decision_kind": "claim.corrected",
        "decision_ref": "wr:t:case:case/claim-1",
        "idempotency_key": "claim-1",
        "target": {
            "format": "x12", "sender_id": "PROVIDER1", "receiver_id": "PAYERX",
            "billing_provider_npi": "1234567893", "subscriber_id": "MEMBER1",
        },
        "payload": {"claims": [{"claim_id": "C1", "total_charge": "10.00"}]},
    }
    first = (
        await client.post("/api/v1/writebacks", json=claim_body, headers=auth_a)
    ).json()["data"]
    second = (
        await client.post(
            "/api/v1/writebacks", json=_wb_body(conn["id"], "status-2"), headers=auth_a
        )
    ).json()["data"]
    assert first["target"]["isa_control"] == "000000001"
    assert second["target"]["isa_control"] == "000000002"
