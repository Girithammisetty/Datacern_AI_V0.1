"""HL7 v2.x decode (BRD 57 inc-3d) — ADT/ORU dispatch, delimiters-from-MSH, refusal."""

from __future__ import annotations

from collections.abc import AsyncIterator

import pytest

from app.domain.decode import DecodeOptions, DecodeStats, decode_stream
from app.domain.errors import PermanentJobError
from app.domain.hl7v2 import decode_hl7v2

# Standard delimiters. MSH-1 is the field sep '|', MSH-2 the encoding chars '^~\&'.
ADT = (
    "MSH|^~\\&|EPIC|HOSP|RECV|DEST|20210101120000||ADT^A01|MSG0001|P|2.5\r"
    "EVN|A01|20210101120000\r"
    "PID|1||MRN123^^^HOSP^MR||DOE^JANE^A||19800101|F\r"
    "PV1|1|I|ICU^101^01\r"
)
ORU = (
    "MSH|^~\\&|LAB|HOSP|RECV|DEST|20210101130000||ORU^R01|MSG0002|P|2.5\r"
    "PID|1||MRN456^^^HOSP^MR||SMITH^JOHN||19750505|M\r"
    "OBR|1|||CBC^Complete Blood Count\r"
    "OBX|1|NM|WBC^White Blood Cell||7.2|10*3/uL|4.0-11.0|N\r"
    "OBX|2|NM|HGB^Hemoglobin||9.1|g/dL|13.0-17.0|L\r"
)


async def _stream(data: str, chunk: int = 64) -> AsyncIterator[bytes]:
    raw = data.encode("latin-1")
    for i in range(0, len(raw), chunk):
        yield raw[i : i + chunk]


async def _rows(data: str, chunk: int = 64) -> tuple[list, list[str], DecodeStats]:
    stats, rows, cols = DecodeStats(), [], []
    async for batch in decode_hl7v2(_stream(data, chunk), 5000, stats):
        cols = batch.columns
        rows.extend(batch.rows)
    return rows, cols, stats


# ---- ADT: one patient/event row per message ---------------------------------

async def test_adt_one_row_per_message():
    rows, cols, stats = await _rows(ADT)
    assert len(rows) == 1 and stats.rows_ok == 1
    r = dict(zip(cols, rows[0], strict=True))
    assert r["message_type"] == "ADT^A01"
    assert r["message_control_id"] == "MSG0001"
    assert r["sending_app"] == "EPIC"
    assert r["patient_id"] == "MRN123"
    assert r["patient_name"] == "DOE JANE"
    assert r["event_type"] == "A01"
    assert r["loop_path"] == "MSH/ADT^A01"
    assert r["observation_value"] == ""     # not an ORU


# ---- ORU: one row per OBX observation ---------------------------------------

async def test_oru_one_row_per_observation():
    rows, cols, stats = await _rows(ORU)
    assert len(rows) == 2 and stats.rows_ok == 2
    wbc = dict(zip(cols, rows[0], strict=True))
    assert wbc["message_type"] == "ORU^R01"
    assert wbc["patient_id"] == "MRN456"
    assert wbc["observation_id"] == "WBC"
    assert wbc["observation_value"] == "7.2"
    assert wbc["observation_units"] == "10*3/uL"
    assert wbc["abnormal_flag"] == "N"
    hgb = dict(zip(cols, rows[1], strict=True))
    assert hgb["observation_id"] == "HGB" and hgb["abnormal_flag"] == "L"


# ---- multi-message batch file ----------------------------------------------

async def test_batch_of_mixed_messages():
    rows, cols, _ = await _rows(ADT + ORU)
    types = [dict(zip(cols, r, strict=True))["message_type"] for r in rows]
    assert types == ["ADT^A01", "ORU^R01", "ORU^R01"]  # 1 ADT + 2 OBX


# ---- delimiters are read from MSH, not assumed ------------------------------

async def test_non_standard_delimiters_from_msh():
    """A feed using # as the field separator must still parse."""
    weird = (
        "MSH#^~\\&#EPIC#HOSP#RECV#DEST#20210101##ADT^A01#MSGX#P#2.5\r"
        "PID#1##MRN999^^^HOSP^MR##DOE^JOHN\r"
    )
    rows, cols, _ = await _rows(weird)
    r = dict(zip(cols, rows[0], strict=True))
    assert r["patient_id"] == "MRN999"
    assert r["patient_name"] == "DOE JOHN"


async def test_tolerates_crlf_and_lf_terminators():
    rows_crlf, _, _ = await _rows(ADT.replace("\r", "\r\n"))
    rows_lf, _, _ = await _rows(ADT.replace("\r", "\n"))
    assert len(rows_crlf) == 1 and len(rows_lf) == 1


async def test_streams_across_tiny_chunks():
    rows, _, _ = await _rows(ADT + ORU, chunk=5)
    assert len(rows) == 3


# ---- honest refusal (Rule 2 / BR-2) -----------------------------------------

async def test_stream_not_starting_with_msh_refused():
    with pytest.raises(PermanentJobError) as e:
        await _rows("PID|1||MRN123\rOBX|1|NM|X\r")
    assert "before any MSH" in str(e.value) or "does not begin" in str(e.value)


async def test_empty_or_non_hl7_refused():
    with pytest.raises(PermanentJobError) as e:
        await _rows("col_a,col_b\n1,2\n")
    assert "MSH" in str(e.value)


# ---- registry wiring --------------------------------------------------------

async def test_registered_in_decoder_registry():
    stats = DecodeStats()
    opts = DecodeOptions(file_format="hl7v2", batch_size=5000)
    rows = []
    async for batch in decode_stream(_stream(ORU), opts, stats):
        rows.extend(batch.rows)
    assert len(rows) == 2
