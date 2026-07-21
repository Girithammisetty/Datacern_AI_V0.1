"""X12 acknowledgments (BRD 57 REMAINING item) — TA1 interchange ack + 999
implementation ack.

Both close the loop on outbound governance built in inc-2: after Datacern
transmits an approved 837, the payer's TA1/999 tells us whether the
interchange and the individual transaction sets inside it were accepted.
"""

from __future__ import annotations

from collections.abc import AsyncIterator

import pytest

from app.domain.decode import DecodeStats
from app.domain.errors import PermanentJobError
from app.domain.x12 import TA1_COLUMNS, decode_x12
from tests.unit.test_x12 import build_isa


def build_ta1(
    *, isa_control: str = "000000001", ack_date: str = "210101", ack_time: str = "1200",
    ack_code: str = "A", note_code: str = "000", elem: str = "*", comp: str = ":",
    term: str = "~", with_functional_group: bool = False,
) -> bytes:
    """A standalone TA1 ack interchange (the common case: no GS at all)."""
    isa = build_isa(isa_control, elem, comp, term)
    ta1 = f"TA1{elem}{isa_control}{elem}{ack_date}{elem}{ack_time}{elem}{ack_code}{elem}{note_code}"
    segs = [ta1]
    if with_functional_group:
        segs += [
            f"GS{elem}HC{elem}SENDER{elem}RECEIVER{elem}20210101{elem}1200{elem}1{elem}X{elem}005010X222A1",
            f"ST{elem}837{elem}0001",
            f"SE{elem}2{elem}0001",
            f"GE{elem}1{elem}1",
        ]
    segs.append(f"IEA{elem}{'1' if with_functional_group else '0'}{elem}{isa_control}")
    return (isa + term.join(segs) + term).encode("latin-1")


def build_999(
    *, isa_control: str = "000000001", gs_control: str = "1", st_control: str = "0001",
    acked_functional_id: str = "HC", acked_group: str = "1", units=None,
    elem: str = "*", comp: str = ":", term: str = "~",
) -> bytes:
    units = units if units is not None else [
        {"ts_id": "837", "ts_control": "0001", "ack": "A", "errors": [], "seg_errors": []},
        {"ts_id": "837", "ts_control": "0002", "ack": "R", "errors": ["1"], "seg_errors": ["I3"]},
    ]
    gs = elem.join(["GS", "FA", "SENDER", "RECEIVER", "20210101", "1200", gs_control,
                    "X", "005010X231A1"])
    segs = [gs, f"ST{elem}999{elem}{st_control}",
            f"AK1{elem}{acked_functional_id}{elem}{acked_group}"]
    for u in units:
        segs.append(f"AK2{elem}{u['ts_id']}{elem}{u['ts_control']}")
        for code in u["seg_errors"]:
            segs.append(f"IK3{elem}CLM{elem}5{elem}{elem}{code}")
        err_tail = "".join(f"{elem}{c}" for c in u["errors"])
        segs.append(f"AK5{elem}{u['ack']}{err_tail}")
    segs.append(f"AK9{elem}A{elem}{len(units)}{elem}{len(units)}{elem}{len(units)}")
    body_count = len(segs) - 1  # everything after GS
    segs.append(f"SE{elem}{body_count + 1}{elem}{st_control}")
    segs.append(f"GE{elem}1{elem}{gs_control}")
    segs.append(f"IEA{elem}1{elem}{isa_control}")
    return (build_isa(isa_control, elem, comp, term) + term.join(segs) + term).encode("latin-1")


async def _stream(data: bytes, chunk: int = 64) -> AsyncIterator[bytes]:
    for i in range(0, len(data), chunk):
        yield data[i : i + chunk]


async def _rows(data: bytes, chunk: int = 64) -> tuple[list, list[str], DecodeStats]:
    stats, rows, cols = DecodeStats(), [], []
    async for batch in decode_x12(_stream(data, chunk), 5000, stats):
        cols = batch.columns
        rows.extend(batch.rows)
    return rows, cols, stats


# ---- TA1 ---------------------------------------------------------------------

async def test_ta1_accepted_ack_decodes_standalone():
    rows, cols, stats = await _rows(build_ta1(ack_code="A"))
    assert len(rows) == 1 and stats.rows_ok == 1
    r = dict(zip(cols, rows[0], strict=True))
    assert r["acked_interchange_control_number"] == "000000001"
    assert r["interchange_ack_code"] == "A"
    assert r["interchange_note_code"] == "000"


async def test_ta1_rejected_ack_carries_note_code():
    rows, cols, _ = await _rows(build_ta1(ack_code="R", note_code="021"))
    r = dict(zip(cols, rows[0], strict=True))
    assert r["interchange_ack_code"] == "R"
    assert r["interchange_note_code"] == "021"


async def test_ta1_alongside_a_functional_group_yields_both_schemas():
    """A rarer shape: TA1 combined with an actual functional group in the same
    interchange. Proves the two row shapes never land in the same batch."""
    rows, stats = [], DecodeStats()
    schemas = []
    async for batch in decode_x12(_stream(build_ta1(with_functional_group=True)), 5000, stats):
        schemas.append(batch.columns)
        rows.extend(batch.rows)
    assert stats.rows_ok == 1  # the TA1 row; the empty 837 (no CLM) yields none
    assert len(schemas) == 1 and schemas[0] == TA1_COLUMNS
    assert len(rows) == 1


async def test_ta1_delimiters_follow_the_isa():
    rows, cols, _ = await _rows(build_ta1(elem="|", comp="^", term="\n"))
    r = dict(zip(cols, rows[0], strict=True))
    assert r["interchange_ack_code"] == "A"


# ---- 999 -----------------------------------------------------------------

async def test_999_one_row_per_acked_transaction_set():
    rows, cols, stats = await _rows(build_999())
    assert len(rows) == 2 and stats.rows_ok == 2
    r0 = dict(zip(cols, rows[0], strict=True))
    assert r0["transaction_set"] == "999"
    assert r0["acked_functional_id_code"] == "HC"
    assert r0["acked_group_control_number"] == "1"
    assert r0["acked_transaction_set_id"] == "837"
    assert r0["acked_transaction_set_control_number"] == "0001"
    assert r0["transaction_ack_code"] == "A"
    assert r0["transaction_error_codes"] == ""
    assert r0["segment_error_codes"] == ""


async def test_999_rejected_unit_carries_error_codes():
    rows, cols, _ = await _rows(build_999())
    r1 = dict(zip(cols, rows[1], strict=True))
    assert r1["acked_transaction_set_control_number"] == "0002"
    assert r1["transaction_ack_code"] == "R"
    assert r1["transaction_error_codes"] == "1"
    assert r1["segment_error_codes"] == "I3"


async def test_999_group_ack_code_is_stamped_onto_every_row_despite_being_a_trailer():
    """AK9 arrives AFTER every AK2/AK5 unit; the group_ack_code must still land
    on rows that were logically 'closed' before AK9 was read."""
    rows, cols, _ = await _rows(build_999())
    for row in rows:
        r = dict(zip(cols, row, strict=True))
        assert r["group_ack_code"] == "A"


async def test_999_correlates_back_to_the_837_it_acknowledges():
    rows, cols, _ = await _rows(build_999(units=[
        {"ts_id": "837", "ts_control": "0042", "ack": "A", "errors": [], "seg_errors": []},
    ]))
    r = dict(zip(cols, rows[0], strict=True))
    # the field name deliberately echoes what an outbound 837 renders as ST02
    assert r["acked_transaction_set_control_number"] == "0042"


async def test_999_streams_across_tiny_chunk_boundaries():
    rows, _, _ = await _rows(build_999(), chunk=9)
    assert len(rows) == 2


async def test_999_conformance_still_holds():
    data = build_999().replace(b"IEA*1*000000001", b"IEA*1*000000099")
    with pytest.raises(PermanentJobError) as e:
        await _rows(data)
    assert "IEA02" in str(e.value)
