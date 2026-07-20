"""Outbound X12 276 (claim status request) render (BRD 57 STD-FR-012).

276 is outbound-only -- x12.py's decoder deliberately refuses it by name (we
SEND status inquiries, we DECODE the 277 responses to them) -- so unlike
render_837, this cannot be validated by round-tripping through decode_x12.
Instead these tests parse the rendered segments directly and cross-check the
same envelope-conformance rules the decoder WOULD enforce (SE01 count,
ST02==SE02, IEA02==ISA13, GS06==GE02) by hand.
"""

from __future__ import annotations

import pytest

from app.domain.errors import PermanentJobError
from app.domain.x12_out import (
    OutboundControl,
    checksum,
    is_x12_writeback,
    render_276,
    render_for_writeback,
)

_CONTROL = OutboundControl(
    sender_id="PROVIDER1", receiver_id="PAYERX",
    isa_control="000000005", gs_control="5", st_control="0005",
)
_INQUIRY = {"claim_id": "CLAIM1", "total_charge": "250.00", "service_date": "20240115"}


def _segments(rendered: str) -> list[str]:
    isa, rest = rendered[:106], rendered[106:]
    return [isa.rstrip("~")] + [s for s in rest.split("~") if s]


def test_renders_isa_and_conformant_envelope():
    rendered = render_276(
        [_INQUIRY], _CONTROL, payer_id="PAYERXID", payer_name="PAYER X",
        provider_npi="1234567893", provider_name="PROVIDER CLINIC",
        subscriber_id="MEMBER1", subscriber_last="DOE", subscriber_first="JANE",
    )
    assert len(rendered[:106]) == 106
    segs = _segments(rendered)
    st = next(s for s in segs if s.startswith("ST*"))
    se = next(s for s in segs if s.startswith("SE*"))
    ge = next(s for s in segs if s.startswith("GE*"))
    iea = next(s for s in segs if s.startswith("IEA*"))
    assert st == "ST*276*0005"
    assert se.split("*")[2] == "0005"  # SE02 == ST02
    assert ge.split("*")[1] == "1"
    assert iea.split("*")[1] == "1" and iea.split("*")[2] == "000000005"
    # SE01 declares the segment count from ST through SE inclusive.
    st_idx = segs.index(st)
    se_idx = segs.index(se)
    assert int(se.split("*")[1]) == se_idx - st_idx + 1


def test_header_carries_payer_provider_subscriber():
    rendered = render_276(
        [_INQUIRY], _CONTROL, payer_id="PAYERXID", payer_name="PAYER X",
        provider_npi="1234567893", provider_name="PROVIDER CLINIC",
        subscriber_id="MEMBER1", subscriber_last="DOE", subscriber_first="JANE",
    )
    assert "NM1*PR*2*PAYER X" in rendered and "*PI*PAYERXID" in rendered
    assert "NM1*1P*2*PROVIDER CLINIC" in rendered and "*XX*1234567893" in rendered
    assert "NM1*IL*1*DOE*JANE" in rendered and "*MI*MEMBER1" in rendered


def test_gs01_is_the_claim_status_request_functional_id():
    rendered = render_276(
        [_INQUIRY], _CONTROL, payer_id="P", payer_name="PN",
        provider_npi="N", provider_name="PRN",
        subscriber_id="S", subscriber_last="L", subscriber_first="F",
    )
    gs = next(s for s in _segments(rendered) if s.startswith("GS*"))
    assert gs.split("*")[1] == "HR"


def test_one_trn_per_inquiry_keyed_on_claim_id():
    """TRN02 uses the same claim_id field 837 uses, so a partner's 277 (which
    echoes the requester's TRN) correlates back the way an 835 already does."""
    rendered = render_276(
        [{"claim_id": "A1"}, {"claim_id": "A2"}], _CONTROL,
        payer_id="P", payer_name="PN", provider_npi="N", provider_name="PRN",
        subscriber_id="S", subscriber_last="L", subscriber_first="F",
    )
    assert "TRN*1*A1" in rendered
    assert "TRN*1*A2" in rendered


def test_optional_fields_render_when_present():
    rendered = render_276(
        [{"claim_id": "A1", "payer_claim_control_number": "PCN99", "total_charge": "50.00",
          "service_date": "20240201"}],
        _CONTROL, payer_id="P", payer_name="PN", provider_npi="N", provider_name="PRN",
        subscriber_id="S", subscriber_last="L", subscriber_first="F",
    )
    assert "REF*1K*PCN99" in rendered
    assert "AMT*T3*50.00" in rendered
    assert "DTP*472*D8*20240201" in rendered


def test_optional_fields_are_absent_when_not_supplied():
    rendered = render_276(
        [{"claim_id": "A1"}], _CONTROL, payer_id="P", payer_name="PN",
        provider_npi="N", provider_name="PRN", subscriber_id="S",
        subscriber_last="L", subscriber_first="F",
    )
    assert "REF*1K" not in rendered
    assert "AMT*T3" not in rendered
    assert "DTP*472" not in rendered


def test_refuses_empty_inquiry_batch():
    with pytest.raises(PermanentJobError, match="zero status inquiries"):
        render_276(
            [], _CONTROL, payer_id="P", payer_name="PN", provider_npi="N",
            provider_name="PRN", subscriber_id="S", subscriber_last="L",
            subscriber_first="F",
        )


def test_refuses_inquiry_without_claim_id():
    with pytest.raises(PermanentJobError, match="claim_id"):
        render_276(
            [{"total_charge": "1.00"}], _CONTROL, payer_id="P", payer_name="PN",
            provider_npi="N", provider_name="PRN", subscriber_id="S",
            subscriber_last="L", subscriber_first="F",
        )


def test_refuses_injection_via_claim_id():
    with pytest.raises(PermanentJobError, match="reserved delimiter"):
        render_276(
            [{"claim_id": "A1~NM1*PR*2*ATTACKER*****PI*9999999999"}],
            _CONTROL, payer_id="P", payer_name="PN", provider_npi="N",
            provider_name="PRN", subscriber_id="S", subscriber_last="L",
            subscriber_first="F",
        )


def test_refuses_injection_via_payer_name():
    with pytest.raises(PermanentJobError, match="reserved delimiter"):
        render_276(
            [_INQUIRY], _CONTROL, payer_id="P", payer_name="EVIL~IEA*1*000000001",
            provider_npi="N", provider_name="PRN", subscriber_id="S",
            subscriber_last="L", subscriber_first="F",
        )


def test_is_deterministic_and_checksum_stable():
    a = render_276(
        [_INQUIRY], _CONTROL, payer_id="P", payer_name="PN", provider_npi="N",
        provider_name="PRN", subscriber_id="S", subscriber_last="L",
        subscriber_first="F",
    )
    b = render_276(
        [_INQUIRY], _CONTROL, payer_id="P", payer_name="PN", provider_npi="N",
        provider_name="PRN", subscriber_id="S", subscriber_last="L",
        subscriber_first="F",
    )
    assert a == b and checksum(a) == checksum(b)


# ---- render_for_writeback dispatch (837 vs 276) -----------------------------

_BASE_TARGET = {
    "format": "x12", "sender_id": "PROVIDER1", "receiver_id": "PAYERX",
    "isa_control": "000000001", "gs_control": "1", "st_control": "0001",
}


def test_render_for_writeback_dispatches_to_276():
    assert is_x12_writeback({**_BASE_TARGET, "transaction_set": "276"})
    payload = {"inquiries": [{"claim_id": "C1"}]}
    target = {
        **_BASE_TARGET, "transaction_set": "276",
        "payer_id": "P", "payer_name": "PN", "provider_npi": "N",
        "provider_name": "PRN", "subscriber_id": "S",
        "subscriber_last": "L", "subscriber_first": "F",
    }
    result = render_for_writeback(payload, target)
    assert "ST*276*0001" in result["x12_rendered"]


def test_render_for_writeback_276_requires_inquiries_list():
    target = {
        **_BASE_TARGET, "transaction_set": "276",
        "payer_id": "P", "payer_name": "PN", "provider_npi": "N",
        "provider_name": "PRN", "subscriber_id": "S",
        "subscriber_last": "L", "subscriber_first": "F",
    }
    with pytest.raises(PermanentJobError, match="payload.inquiries must be a list"):
        render_for_writeback({"inquiries": "not-a-list"}, target)


def test_render_for_writeback_276_requires_identity_fields():
    target = {**_BASE_TARGET, "transaction_set": "276"}
    with pytest.raises(PermanentJobError, match="276 target is missing field"):
        render_for_writeback({"inquiries": [{"claim_id": "C1"}]}, target)


def test_render_for_writeback_still_defaults_to_837():
    target = {**_BASE_TARGET, "billing_provider_npi": "1234567893", "subscriber_id": "M1"}
    payload = {"claims": [{"claim_id": "C1", "total_charge": "10.00"}]}
    result = render_for_writeback(payload, target)
    assert "ST*837*0001" in result["x12_rendered"]
