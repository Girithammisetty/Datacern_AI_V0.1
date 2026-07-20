"""HL7 FHIR R4 decoding (BRD 57 inc-3c, STD-FR-020, BR-2/BR-4).

FHIR is JSON, so unlike X12 there is no wire grammar to tokenize — the parsing is
done, and the work is turning a deeply-nested clinical/financial resource into a
flat governed row. Two input shapes are accepted, both common in the wild:

* a **Bundle** — one JSON object with ``entry: [{resource: {...}}, …]`` (a FHIR
  search result or transaction bundle);
* **NDJSON** — one resource per line, the FHIR Bulk Data ($export) format, which
  is the streamable one.

Row shape is dispatched by ``resourceType`` to a per-type mapper (Patient,
Coverage, Claim, ClaimResponse, ExplanationOfBenefit, Encounter), mirroring the
per-transaction-set handlers in x12.py. Unmapped resource types are SKIPPED
rather than fabricated into a wrong-shaped row (a Bundle legitimately mixes types
— e.g. an EOB search returns OperationOutcome + included Patients); the raw
resource is preserved on every row for lineage (BR-4).

Rule 2: a resource with no ``resourceType`` in a stream that claims to be FHIR is
a malformed feed and fails; a syntactically-broken JSON stream fails. Neither is
coerced into rows.

The REST transport (paginated `_since` incremental sync, SMART-on-FHIR auth via
SecretsStore — STD-FR-020/021) is the connector half and a separate increment;
this module is the decode half that a file drop or that connector both feed.
"""

from __future__ import annotations

import json
from collections.abc import AsyncIterator
from typing import Any

from app.domain.errors import ErrorCategory, PermanentJobError

MAX_RESOURCE_BYTES = 25 * 1024 * 1024   # a single FHIR resource past this is hostile
MAX_BUNDLE_BYTES = 512 * 1024 * 1024    # whole-Bundle cap (upstream upload caps also apply)

#: resourceType -> the mapper is looked up here; anything else is skipped.
MAPPED_RESOURCE_TYPES = (
    "Patient", "Coverage", "Claim", "ClaimResponse", "ExplanationOfBenefit", "Encounter",
)

COLUMNS: list[str] = [
    "resource_type",
    "resource_id",
    "patient_ref",
    "status",
    "identifier",
    "code",
    "amount",
    "period_start",
    "period_end",
    "raw_resource",
]


def _fail(msg: str) -> PermanentJobError:
    return PermanentJobError(ErrorCategory.DECODE_ERROR, msg)


def _first_identifier(res: dict[str, Any]) -> str:
    ids = res.get("identifier")
    if isinstance(ids, list) and ids and isinstance(ids[0], dict):
        return str(ids[0].get("value", ""))
    if isinstance(ids, dict):
        return str(ids.get("value", ""))
    return ""


def _money(node: Any) -> str:
    if isinstance(node, dict) and "value" in node:
        return str(node["value"])
    return ""


def _map_resource(res: dict[str, Any]) -> list[Any] | None:
    """Flatten one resource into a governed row, or None to skip its type.

    Columns are intentionally generic (identifier/code/amount/period) so one row
    schema spans resource types; `raw_resource` keeps the full fidelity FHIR is
    good at, so nothing is lost to the flattening (BR-4).
    """
    rtype = res.get("resourceType")
    if rtype not in MAPPED_RESOURCE_TYPES:
        return None

    rid = str(res.get("id", ""))
    status = str(res.get("status", ""))
    raw = json.dumps(res, ensure_ascii=False, separators=(",", ":"))

    patient_ref = ""
    code = ""
    amount = ""
    pstart = ""
    pend = ""

    if rtype == "Patient":
        patient_ref = f"Patient/{rid}"
    elif rtype in ("Coverage", "Claim", "ClaimResponse", "ExplanationOfBenefit", "Encounter"):
        # These all reference a subject/patient; FHIR spells the field differently.
        subj = res.get("patient") or res.get("subject") or res.get("beneficiary")
        if isinstance(subj, dict):
            patient_ref = str(subj.get("reference", ""))

    if rtype in ("Claim", "ExplanationOfBenefit"):
        total = res.get("total")
        if isinstance(total, dict):
            # Claim.total is a single Money.
            amount = _money(total)
        elif isinstance(total, list) and total and isinstance(total[0], dict):
            # ExplanationOfBenefit.total is [{category, amount}] — take the first.
            amount = _money(total[0].get("amount"))
        typ = res.get("type")
        if isinstance(typ, dict):
            coding = typ.get("coding")
            if isinstance(coding, list) and coding and isinstance(coding[0], dict):
                code = str(coding[0].get("code", ""))
    elif rtype == "ClaimResponse":
        pay = res.get("payment")
        if isinstance(pay, dict):
            amount = _money(pay.get("amount"))
    elif rtype == "Encounter":
        period = res.get("period") or {}
        pstart = str(period.get("start", ""))
        pend = str(period.get("end", ""))

    return [
        rtype, rid, patient_ref, status, _first_identifier(res),
        code, amount, pstart, pend, raw,
    ]


def _looks_like_bundle(sample: str) -> bool:
    """A Bundle starts with a JSON object whose resourceType is Bundle; NDJSON
    starts with a resource object per line. Peek the first non-space bytes."""
    s = sample.lstrip()
    return s.startswith("{") and '"resourceType"' in s and '"Bundle"' in s[:400]


async def decode_fhir(
    chunks: AsyncIterator[bytes], batch_size: int, stats: Any
) -> AsyncIterator[Any]:
    """Decode a FHIR Bundle or NDJSON stream into governed rows."""
    from app.domain.tablewriter import RowBatch  # local: avoid import cycle

    # Peek enough to tell Bundle from NDJSON without buffering everything.
    head = b""
    it = chunks.__aiter__()
    while len(head) < 4096:
        try:
            head += await it.__anext__()
        except StopAsyncIteration:
            break
    sample = head.decode("utf-8", errors="replace")

    async def remaining() -> AsyncIterator[bytes]:
        yield head
        async for c in it:
            yield c

    rows: list[list[Any]] = []

    def _emit(res: Any) -> None:
        if not isinstance(res, dict):
            raise _fail("FHIR: expected a resource object, got a non-object")
        if "resourceType" not in res:
            raise _fail("FHIR: resource has no resourceType (not a FHIR resource)")
        row = _map_resource(res)
        if row is not None:
            rows.append(row)
            stats.rows_ok += 1

    if _looks_like_bundle(sample):
        # Whole-Bundle parse (bounded); FHIR Bundles are not a streaming grammar.
        buf = bytearray()
        async for c in remaining():
            buf += c
            if len(buf) > MAX_BUNDLE_BYTES:
                raise _fail(f"FHIR Bundle exceeds {MAX_BUNDLE_BYTES} bytes")
        try:
            bundle = json.loads(buf.decode("utf-8"))
        except json.JSONDecodeError as e:
            raise _fail(f"FHIR Bundle is not valid JSON: {e}") from e
        entries = bundle.get("entry")
        if not isinstance(entries, list):
            # An empty/searchset Bundle with no entries is a valid empty result.
            entries = []
        for entry in entries:
            res = entry.get("resource") if isinstance(entry, dict) else None
            if res is not None:
                _emit(res)
                if len(rows) >= batch_size:
                    yield RowBatch(columns=list(COLUMNS), rows=rows)
                    rows = []
    else:
        # NDJSON: one resource per line, truly streaming.
        line = bytearray()
        async for c in remaining():
            line += c
            while True:
                nl = line.find(b"\n")
                if nl < 0:
                    if len(line) > MAX_RESOURCE_BYTES:
                        raise _fail(
                            f"FHIR NDJSON line exceeds {MAX_RESOURCE_BYTES} bytes "
                            "(missing newline or hostile resource)"
                        )
                    break
                raw = bytes(line[:nl]).strip()
                del line[: nl + 1]
                if not raw:
                    continue
                try:
                    _emit(json.loads(raw.decode("utf-8")))
                except json.JSONDecodeError as e:
                    raise _fail(f"FHIR NDJSON line is not valid JSON: {e}") from e
                if len(rows) >= batch_size:
                    yield RowBatch(columns=list(COLUMNS), rows=rows)
                    rows = []
        tail = bytes(line).strip()
        if tail:
            try:
                _emit(json.loads(tail.decode("utf-8")))
            except json.JSONDecodeError as e:
                raise _fail(f"FHIR NDJSON trailing line is not valid JSON: {e}") from e

    if rows:
        yield RowBatch(columns=list(COLUMNS), rows=rows)
