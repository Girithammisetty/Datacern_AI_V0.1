"""HL7 FHIR R4 decode (BRD 57 inc-3c) — Bundle + NDJSON, resource dispatch, refusal."""

from __future__ import annotations

import json
from collections.abc import AsyncIterator

import pytest

from app.domain.decode import DecodeOptions, DecodeStats, decode_stream
from app.domain.errors import PermanentJobError
from app.domain.fhir import decode_fhir

PATIENT = {"resourceType": "Patient", "id": "p1",
           "identifier": [{"value": "MRN123"}], "active": True}
COVERAGE = {"resourceType": "Coverage", "id": "cov1", "status": "active",
            "beneficiary": {"reference": "Patient/p1"}, "identifier": [{"value": "POL9"}]}
CLAIM = {"resourceType": "Claim", "id": "clm1", "status": "active",
         "patient": {"reference": "Patient/p1"},
         "type": {"coding": [{"code": "professional"}]},
         "total": {"value": 250.00, "currency": "USD"}}
EOB = {"resourceType": "ExplanationOfBenefit", "id": "eob1", "status": "active",
       "patient": {"reference": "Patient/p1"},
       "total": [{"category": {"text": "submitted"}, "amount": {"value": 250.0}}]}
ENCOUNTER = {"resourceType": "Encounter", "id": "enc1", "status": "finished",
             "subject": {"reference": "Patient/p1"},
             "period": {"start": "2021-01-01T09:00:00Z", "end": "2021-01-01T09:30:00Z"}}
OP_OUTCOME = {"resourceType": "OperationOutcome", "issue": [{"severity": "information"}]}


def bundle(*resources) -> bytes:
    b = {"resourceType": "Bundle", "type": "searchset",
         "entry": [{"resource": r} for r in resources]}
    return json.dumps(b).encode("utf-8")


def ndjson(*resources) -> bytes:
    return ("\n".join(json.dumps(r) for r in resources) + "\n").encode("utf-8")


async def _stream(data: bytes, chunk: int = 64) -> AsyncIterator[bytes]:
    for i in range(0, len(data), chunk):
        yield data[i : i + chunk]


async def _rows(data: bytes, chunk: int = 64) -> tuple[list, list[str], DecodeStats]:
    stats, rows, cols = DecodeStats(), [], []
    async for batch in decode_fhir(_stream(data, chunk), 5000, stats):
        cols = batch.columns
        rows.extend(batch.rows)
    return rows, cols, stats


# ---- Bundle ------------------------------------------------------------------

async def test_bundle_maps_each_resource_type():
    rows, cols, _ = await _rows(bundle(PATIENT, COVERAGE, CLAIM, EOB, ENCOUNTER))
    by_type = {dict(zip(cols, r, strict=True))["resource_type"]: dict(zip(cols, r, strict=True))
               for r in rows}
    assert set(by_type) == {"Patient", "Coverage", "Claim", "ExplanationOfBenefit", "Encounter"}
    assert by_type["Patient"]["identifier"] == "MRN123"
    assert by_type["Coverage"]["patient_ref"] == "Patient/p1"
    assert by_type["Claim"]["amount"] == "250.0"
    assert by_type["Claim"]["code"] == "professional"
    assert by_type["ExplanationOfBenefit"]["amount"] == "250.0"
    assert by_type["Encounter"]["period_start"] == "2021-01-01T09:00:00Z"


async def test_unmapped_resource_types_are_skipped_not_faked():
    """A Bundle legitimately mixes types; an OperationOutcome must not become a
    bogus row, but must not fail the whole decode either."""
    rows, cols, stats = await _rows(bundle(PATIENT, OP_OUTCOME, CLAIM))
    types = [dict(zip(cols, r, strict=True))["resource_type"] for r in rows]
    assert types == ["Patient", "Claim"]
    assert stats.rows_ok == 2


async def test_empty_bundle_yields_zero_rows():
    rows, _, stats = await _rows(bundle())
    assert rows == [] and stats.rows_ok == 0


async def test_raw_resource_preserved_for_lineage():
    rows, cols, _ = await _rows(bundle(CLAIM))
    r = dict(zip(cols, rows[0], strict=True))
    assert json.loads(r["raw_resource"])["id"] == "clm1"


async def test_bundle_streams_across_tiny_chunks():
    rows, _, _ = await _rows(bundle(PATIENT, CLAIM, ENCOUNTER), chunk=7)
    assert len(rows) == 3


# ---- NDJSON (FHIR Bulk Data) -------------------------------------------------

async def test_ndjson_one_resource_per_line():
    rows, cols, stats = await _rows(ndjson(PATIENT, COVERAGE, CLAIM))
    assert len(rows) == 3 and stats.rows_ok == 3
    assert dict(zip(cols, rows[0], strict=True))["resource_type"] == "Patient"


async def test_ndjson_streams_across_line_boundaries():
    rows, _, _ = await _rows(ndjson(PATIENT, CLAIM, ENCOUNTER, COVERAGE), chunk=5)
    assert len(rows) == 4


async def test_ndjson_skips_blank_lines():
    data = (json.dumps(PATIENT) + "\n\n" + json.dumps(CLAIM) + "\n").encode("utf-8")
    rows, _, _ = await _rows(data)
    assert len(rows) == 2


# ---- honest refusal (Rule 2 / BR-2) -----------------------------------------

async def test_malformed_json_ndjson_refused():
    with pytest.raises(PermanentJobError) as e:
        await _rows(b'{"resourceType":"Patient","id":"p1"\n')  # missing closing brace
    assert "not valid JSON" in str(e.value)


async def test_broken_bundle_json_refused():
    with pytest.raises(PermanentJobError) as e:
        await _rows(b'{"resourceType":"Bundle","entry":[')  # truncated
    assert "not valid JSON" in str(e.value)


async def test_resource_without_resourcetype_refused():
    with pytest.raises(PermanentJobError) as e:
        await _rows(ndjson({"id": "x", "active": True}))
    assert "no resourceType" in str(e.value)


# ---- registry wiring ---------------------------------------------------------

async def test_registered_in_decoder_registry():
    stats = DecodeStats()
    opts = DecodeOptions(file_format="fhir", batch_size=5000)
    rows = []
    async for batch in decode_stream(_stream(bundle(PATIENT, CLAIM)), opts, stats):
        rows.extend(batch.rows)
    assert len(rows) == 2
