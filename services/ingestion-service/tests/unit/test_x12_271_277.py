"""X12 271 eligibility + 277 claim-status decode (BRD 57 inc-3b, STD-FR-011).

271/277 are the RESPONSE halves the platform ingests; 270/276 (the outbound
inquiries) are refused as recognised-but-not-decoded, since we send those.
"""

from __future__ import annotations

from collections.abc import AsyncIterator

import pytest

from app.domain.decode import DecodeStats
from app.domain.errors import PermanentJobError
from app.domain.x12 import decode_x12
from tests.unit.test_x12 import build_isa


def _wrap(st_id: str, gs_code: str, gs_version: str, body_segs: list[str],
          *, elem="*", comp=":", term="~", st_control="0001",
          isa_control="000000001", gs_control="1") -> bytes:
    segs = [
        f"GS{elem}{gs_code}{elem}SENDER{elem}RECEIVER{elem}20210101{elem}1200{elem}{gs_control}{elem}X{elem}{gs_version}",
        f"ST{elem}{st_id}{elem}{st_control}",
        *body_segs,
        f"SE{elem}{len(body_segs) + 2}{elem}{st_control}",
        f"GE{elem}1{elem}{gs_control}",
        f"IEA{elem}1{elem}{isa_control}",
    ]
    return (build_isa(isa_control, elem, comp, term) + term.join(segs) + term).encode("latin-1")


def build_271(elem="*", comp=":", term="~") -> bytes:
    body = [
        f"HL{elem}1{elem}{elem}20{elem}1",
        f"NM1{elem}PR{elem}2{elem}ACME HEALTH PLAN{elem}{elem}{elem}{elem}{elem}PI{elem}PAYER01",
        f"HL{elem}2{elem}1{elem}21{elem}1",
        f"NM1{elem}IL{elem}1{elem}DOE{elem}JANE{elem}{elem}{elem}{elem}MI{elem}MEMBER123",
        f"EB{elem}1{elem}IND{elem}30{elem}{elem}HEALTH PLAN{elem}{elem}{elem}",
        f"EB{elem}B{elem}IND{elem}30{elem}{elem}COPAY{elem}{elem}25.00{elem}",
        f"EB{elem}A{elem}IND{elem}30{elem}{elem}COINSURANCE{elem}{elem}{elem}20",
    ]
    return _wrap("271", "HB", "005010X279A1", body, elem=elem, comp=comp, term=term)


def build_277(elem="*", comp=":", term="~") -> bytes:
    body = [
        f"NM1{elem}PR{elem}2{elem}ACME HEALTH PLAN{elem}{elem}{elem}{elem}{elem}PI{elem}PAYER01",
        f"NM1{elem}1P{elem}2{elem}BILLING CLINIC{elem}{elem}{elem}{elem}{elem}XX{elem}1234567893",
        f"TRN{elem}2{elem}CLAIM1",
        f"STC{elem}{comp.join(['A1', '20'])}{elem}20210110{elem}{elem}200.00{elem}150.00",
        f"TRN{elem}2{elem}CLAIM2",
        f"STC{elem}{comp.join(['A3', '21'])}{elem}20210110{elem}{elem}80.00{elem}0.00",
    ]
    return _wrap("277", "HN", "005010X212", body, elem=elem, comp=comp, term=term)


async def _stream(data: bytes, chunk: int = 64) -> AsyncIterator[bytes]:
    for i in range(0, len(data), chunk):
        yield data[i : i + chunk]


async def _rows(data: bytes) -> tuple[list, list[str]]:
    stats, rows, cols = DecodeStats(), [], []
    async for batch in decode_x12(_stream(data), 5000, stats):
        cols = batch.columns
        rows.extend(batch.rows)
    return rows, cols


# ---- 271 eligibility --------------------------------------------------------

async def test_271_one_row_per_benefit_with_subscriber_context():
    rows, cols = await _rows(build_271())
    assert len(rows) == 3
    r = dict(zip(cols, rows[0], strict=True))
    assert r["transaction_set"] == "271"
    assert r["information_source"] == "ACME HEALTH PLAN"
    assert r["subscriber_id"] == "MEMBER123"
    assert r["subscriber_name"] == "DOE JANE"
    assert r["benefit_status"] == "1"          # active coverage
    assert r["service_type"] == "30"           # health benefit plan coverage
    assert r["loop_path"] == "ISA/GS/ST(271)/2110"


async def test_271_captures_amounts_and_percentages():
    rows, cols = await _rows(build_271())
    copay = dict(zip(cols, rows[1], strict=True))
    assert copay["benefit_amount"] == "25.00"
    coins = dict(zip(cols, rows[2], strict=True))
    assert coins["benefit_percent"] == "20"


async def test_271_active_vs_inactive_status_visible():
    rows, cols = await _rows(build_271())
    assert dict(zip(cols, rows[0], strict=True))["benefit_status"] == "1"


# ---- 277 claim status -------------------------------------------------------

async def test_277_one_row_per_status_correlating_on_claim_id():
    rows, cols = await _rows(build_277())
    assert len(rows) == 2
    r = dict(zip(cols, rows[0], strict=True))
    assert r["transaction_set"] == "277"
    assert r["claim_id"] == "CLAIM1"           # echoes the 837 CLM01 -> correlation
    assert r["status_category"] == "A1"
    assert r["status_code"] == "20"
    assert r["total_charge"] == "200.00"
    assert r["paid_amount"] == "150.00"
    assert r["information_source"] == "ACME HEALTH PLAN"
    assert r["provider_id"] == "1234567893"
    assert dict(zip(cols, rows[1], strict=True))["claim_id"] == "CLAIM2"


# ---- the inquiry halves are refused (we SEND those) -------------------------

@pytest.mark.parametrize("st_id", ["270", "276"])
async def test_inquiry_transaction_sets_refused(st_id):
    data = _wrap(st_id, "HS", "005010X279A1", ["NM1*IL*1*DOE"])
    with pytest.raises(PermanentJobError) as e:
        await _rows(data)
    assert st_id in str(e.value) and "recognised but not decoded" in str(e.value)


# ---- envelope conformance + streaming still apply ---------------------------

async def test_271_streams_and_conformance_holds():
    stats, rows = DecodeStats(), []
    async for batch in decode_x12(_stream(build_271(), chunk=11), 5000, stats):
        rows.extend(batch.rows)
    assert len(rows) == 3 and stats.rows_ok == 3


async def test_277_control_mismatch_refused():
    data = build_277().replace(b"IEA*1*000000001", b"IEA*1*000000077")
    with pytest.raises(PermanentJobError) as e:
        await _rows(data)
    assert "IEA02" in str(e.value)
