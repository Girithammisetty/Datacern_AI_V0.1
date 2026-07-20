"""X12 serialization (BRD 57 inc-2) — round-trip, determinism, honest refusal.

The round-trip is the load-bearing test: the decoder independently validates
SE01 segment counts and every control-number pairing, so a serializer that
miscounts or mismatches fails HERE rather than at a trading partner.
"""

from __future__ import annotations

from collections.abc import AsyncIterator

import pytest

from app.domain.errors import PermanentJobError
from app.domain.x12 import Delimiters, decode_x12
from app.domain.x12_out import (
    CHECKSUM_KEY,
    RENDERED_KEY,
    OutboundControl,
    approved_bytes,
    checksum,
    is_x12_writeback,
    render_837,
    render_for_writeback,
)
from tests.unit.test_x12 import _rows  # noqa: F401  (shared stream helper style)


def _control(**kw) -> OutboundControl:
    base = dict(
        sender_id="SENDER", receiver_id="RECEIVER",
        isa_control="000000123", gs_control="77", st_control="0001",
    )
    base.update(kw)
    return OutboundControl(**base)


CLAIMS = [
    {
        "claim_id": "CLAIM-A", "total_charge": "250.00", "place_of_service": "11",
        "diagnosis_codes": ["Z0000", "E1165"],
        "service_lines": [{"procedure_code": "99213", "charge": "250.00"}],
    },
    {
        "claim_id": "CLAIM-B", "total_charge": "80.00",
        "diagnosis_codes": ["J069"],
        "service_lines": [
            {"procedure_code": "99212", "charge": "40.00"},
            {"procedure_code": "85025", "charge": "40.00"},
        ],
    },
]


def _render(**kw) -> str:
    return render_837(
        CLAIMS, _control(), billing_provider_npi="1234567893", subscriber_id="MEMBER123", **kw
    )


async def _stream(data: bytes, chunk: int = 64) -> AsyncIterator[bytes]:
    for i in range(0, len(data), chunk):
        yield data[i : i + chunk]


async def _decode(rendered: str) -> tuple[list, list[str]]:
    from app.domain.decode import DecodeStats

    stats, rows, cols = DecodeStats(), [], []
    async for batch in decode_x12(_stream(rendered.encode("latin-1")), 5000, stats):
        cols = batch.columns
        rows.extend(batch.rows)
    return rows, cols


# ---- the round trip ---------------------------------------------------------

async def test_round_trip_preserves_claims():
    rows, cols = await _decode(_render())
    assert len(rows) == 2
    a = dict(zip(cols, rows[0], strict=True))
    b = dict(zip(cols, rows[1], strict=True))

    assert a["claim_id"] == "CLAIM-A" and a["total_charge"] == "250.00"
    assert a["place_of_service"] == "11"
    assert a["diagnosis_codes"] == "Z0000,E1165"
    assert a["service_line_count"] == 1
    assert b["claim_id"] == "CLAIM-B" and b["service_line_count"] == 2
    assert b["diagnosis_codes"] == "J069"


async def test_round_trip_preserves_envelope_identity():
    rows, cols = await _decode(_render())
    r = dict(zip(cols, rows[0], strict=True))
    assert r["interchange_control_number"] == "000000123"
    assert r["group_control_number"] == "77"
    assert r["transaction_control_number"] == "0001"
    assert r["sender_id"] == "SENDER" and r["receiver_id"] == "RECEIVER"
    assert r["billing_provider_npi"] == "1234567893"
    assert r["subscriber_id"] == "MEMBER123"


async def test_round_trip_with_non_standard_delimiters():
    rendered = _render(delimiters=Delimiters(element="|", component="^", segment="\n"))
    rows, cols = await _decode(rendered)
    assert len(rows) == 2
    assert dict(zip(cols, rows[0], strict=True))["diagnosis_codes"] == "Z0000,E1165"


async def test_se01_segment_count_is_correct():
    """Pinned explicitly: the decoder rejects a wrong SE01, so a silent
    off-by-one here would surface as a confusing decode error instead."""
    rendered = _render()
    se = [s for s in rendered.split("~") if s.startswith("SE*")][0]
    # ST, NM1x2, then per claim: CLM+HI+ (LX+SV1 per line) -> 4 + 6 = 10, +ST/SE.
    assert se == "SE*14*0001", se
    await _decode(rendered)  # decoder agrees, or this raises


def test_isa_is_exactly_106_chars():
    assert len(_render().split("~")[0]) == 105  # 105 + the terminator we split on


# ---- determinism / the BR-1 immutability contract ---------------------------

def test_render_is_deterministic_and_checksum_stable():
    """Propose-time bytes must be reproducible, else the stored checksum could
    not prove that what ships is what was approved."""
    first, second = _render(), _render()
    assert first == second
    assert checksum(first) == checksum(second)


def test_checksum_changes_when_content_changes():
    other = render_837(
        [{**CLAIMS[0], "total_charge": "999.00"}, CLAIMS[1]],
        _control(), billing_provider_npi="1234567893", subscriber_id="MEMBER123",
    )
    assert checksum(other) != checksum(_render())


def test_control_numbers_are_caller_supplied_not_invented():
    """Rendering stays pure; the per-partner monotonic sequence (BR-6) is owned
    by the caller, so the same payload can be re-rendered identically."""
    a = render_837(CLAIMS, _control(isa_control="000000001"),
                   billing_provider_npi="1", subscriber_id="M")
    b = render_837(CLAIMS, _control(isa_control="000000002"),
                   billing_provider_npi="1", subscriber_id="M")
    assert a != b and checksum(a) != checksum(b)


# ---- honest refusal (Rule 2 / BR-2) -----------------------------------------

def test_refuses_empty_interchange():
    with pytest.raises(PermanentJobError) as e:
        render_837([], _control(), billing_provider_npi="1", subscriber_id="M")
    assert "zero claims" in str(e.value)


def test_refuses_claim_without_id():
    with pytest.raises(PermanentJobError) as e:
        render_837([{"total_charge": "10.00"}], _control(),
                   billing_provider_npi="1", subscriber_id="M")
    assert "claim_id" in str(e.value)


def test_refuses_claim_without_charge():
    with pytest.raises(PermanentJobError) as e:
        render_837([{"claim_id": "X"}], _control(),
                   billing_provider_npi="1", subscriber_id="M")
    assert "total_charge" in str(e.value)


def test_refuses_incomplete_service_line():
    with pytest.raises(PermanentJobError) as e:
        render_837(
            [{"claim_id": "X", "total_charge": "1.00",
              "service_lines": [{"procedure_code": "99213"}]}],
            _control(), billing_provider_npi="1", subscriber_id="M",
        )
    assert "service line 1" in str(e.value)


def test_refuses_unsupported_outbound_transaction_set():
    with pytest.raises(PermanentJobError) as e:
        render_837(CLAIMS, _control(), billing_provider_npi="1", subscriber_id="M",
                   transaction_set="835")
    assert "835" in str(e.value)


# ---- EDI injection (found during the inc-2 hardening pass) ------------------

def test_refuses_segment_terminator_injection_in_claim_id():
    """THE forgery vector. Before the guard, this exact payload rendered a second
    NM1*85 billing-provider segment with an attacker NPI — in a live 837 that
    reroutes payment. X12 has no escaping, so the value must be refused."""
    evil = [{
        "claim_id": "GOOD~NM1*85*2*ATTACKER*****XX*9999999999",
        "total_charge": "1.00",
    }]
    with pytest.raises(PermanentJobError) as e:
        render_837(evil, _control(), billing_provider_npi="1234567893", subscriber_id="M")
    assert "reserved delimiter" in str(e.value) and "claim_id" in str(e.value)


@pytest.mark.parametrize("bad", ["A*B", "A:B", "A~B", "A^B"])
def test_refuses_every_reserved_delimiter(bad):
    """Element, component, segment and the ISA11 repetition separator."""
    with pytest.raises(PermanentJobError):
        render_837([{"claim_id": bad, "total_charge": "1.00"}], _control(),
                   billing_provider_npi="1", subscriber_id="M")


def test_injection_guard_follows_custom_delimiters():
    """A '|' is harmless with default delimiters but lethal when it IS the
    element separator — the guard must key off the delimiters in use."""
    pipe = Delimiters(element="|", component="^", segment="\n")
    claim = [{"claim_id": "A|B", "total_charge": "1.00"}]
    # Safe under default delimiters...
    render_837(claim, _control(), billing_provider_npi="1", subscriber_id="M")
    # ...refused when '|' is the element separator.
    with pytest.raises(PermanentJobError):
        render_837(claim, _control(), billing_provider_npi="1", subscriber_id="M",
                   delimiters=pipe)


def test_refuses_injection_in_identity_and_control_fields():
    with pytest.raises(PermanentJobError) as e:
        render_837(CLAIMS, _control(), billing_provider_npi="1~GS*XX", subscriber_id="M")
    assert "billing_provider_npi" in str(e.value)
    with pytest.raises(PermanentJobError) as e:
        render_837(CLAIMS, _control(sender_id="S~IEA*1*0"),
                   billing_provider_npi="1", subscriber_id="M")
    assert "control.sender_id" in str(e.value)


def test_refuses_overlong_isa_field():
    """A 20-char sender id would silently corrupt the fixed-width ISA."""
    with pytest.raises(PermanentJobError) as e:
        render_837(CLAIMS, _control(sender_id="X" * 20),
                   billing_provider_npi="1", subscriber_id="M")
    assert "fixed width" in str(e.value)


# ---- inc-2b: the governed writeback path (BR-1) -----------------------------

TARGET = {
    "format": "x12", "transaction_set": "837",
    "sender_id": "SENDER", "receiver_id": "RECEIVER",
    "isa_control": "000000123", "gs_control": "77", "st_control": "0001",
    "billing_provider_npi": "1234567893", "subscriber_id": "MEMBER123",
}


def test_detects_x12_writebacks_only():
    assert is_x12_writeback(TARGET)
    assert not is_x12_writeback({"path": "/claims"})
    assert not is_x12_writeback(None)


async def test_propose_time_render_is_visible_and_round_trips():
    """The approver sees the literal bytes (payload is exposed by
    serialize_writeback), and those bytes are a real interchange."""
    out = render_for_writeback({"claims": CLAIMS}, TARGET)
    assert out[RENDERED_KEY].startswith("ISA*")
    assert out[CHECKSUM_KEY] == checksum(out[RENDERED_KEY])
    assert out["claims"] == CLAIMS  # source data preserved for lineage
    rows, cols = await _decode(out[RENDERED_KEY])
    assert [dict(zip(cols, r, strict=True))["claim_id"] for r in rows] == ["CLAIM-A", "CLAIM-B"]


def test_unrenderable_claim_never_becomes_a_pending_proposal():
    """Rendering at enqueue means a bad claim fails BEFORE anyone can approve it."""
    with pytest.raises(PermanentJobError):
        render_for_writeback({"claims": [{"claim_id": "X"}]}, TARGET)  # no charge


def test_injection_is_refused_at_propose_time():
    evil = {"claims": [{"claim_id": "A~NM1*85*2*ATTACKER", "total_charge": "1.00"}]}
    with pytest.raises(PermanentJobError) as e:
        render_for_writeback(evil, TARGET)
    assert "reserved delimiter" in str(e.value)


def test_missing_control_fields_refused():
    with pytest.raises(PermanentJobError) as e:
        render_for_writeback({"claims": CLAIMS}, {**TARGET, "isa_control": ""})
    assert "isa_control" in str(e.value)


def test_claims_must_be_a_list():
    with pytest.raises(PermanentJobError) as e:
        render_for_writeback({"claims": "not-a-list"}, TARGET)
    assert "must be a list" in str(e.value)


def test_approved_bytes_returns_exactly_what_was_rendered():
    payload = render_for_writeback({"claims": CLAIMS}, TARGET)
    assert approved_bytes(payload) == payload[RENDERED_KEY]


def test_tampering_after_approval_refuses_to_transmit():
    """THE governance property. If the stored interchange is mutated between
    approval and delivery, the checksum no longer matches and we refuse to put
    bytes on the wire that no human approved."""
    payload = render_for_writeback({"claims": CLAIMS}, TARGET)
    tampered = {**payload, RENDERED_KEY: payload[RENDERED_KEY].replace("CLAIM-A", "CLAIM-Z")}
    with pytest.raises(PermanentJobError) as e:
        approved_bytes(tampered)
    assert "does not match the approved checksum" in str(e.value)


def test_missing_rendered_interchange_refuses():
    with pytest.raises(PermanentJobError) as e:
        approved_bytes({"claims": CLAIMS})
    assert "no rendered interchange" in str(e.value)
