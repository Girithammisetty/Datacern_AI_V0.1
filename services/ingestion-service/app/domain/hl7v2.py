r"""HL7 v2.x decoding (BRD 57 inc-3d, STD-FR-022, BR-2/BR-4).

The FHIR-absent read path: many hospital feeds are still pipe-delimited HL7v2
(ADT admissions, ORU lab/observation results). Structurally this is close to X12
— delimiter-separated segments whose separators are DECLARED IN THE HEADER (MSH),
not assumed — so the same "read the delimiters from the data" discipline applies.

* **Delimiters come from MSH.** `MSH|^~\&|…` — the field separator is the 4th
  character (right after ``MSH``) and MSH-2 carries component/repetition/escape/
  subcomponent. Hardcoding ``|^~\&`` is the HL7 version of the X12 delimiter bug.
* **Message dispatch.** MSH-9 gives the message type (``ADT^A01``, ``ORU^R01``).
  ADT emits one patient/event row per message; ORU emits one row per OBX
  observation — the granularity each is actually queried at.
* **Streaming.** Segments are split on the segment terminator (``\r``, with
  ``\n``/``\r\n`` tolerated) and rows emitted as messages/observations complete.
* **Refuse, never half-parse (Rule 2).** A stream that does not begin with MSH,
  or an MSH too short to carry its own delimiters, is refused rather than yielding
  guesswork rows.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from typing import Any

from app.domain.errors import ErrorCategory, PermanentJobError

MAX_SEGMENT_CHARS = 100_000
MAX_SEGMENTS = 5_000_000
MAX_RAW_SEGMENTS_PER_MESSAGE = 10_000

COLUMNS: list[str] = [
    "message_type",
    "message_control_id",
    "sending_app",
    "sending_facility",
    "patient_id",
    "patient_name",
    "event_type",
    "observation_id",
    "observation_value",
    "observation_units",
    "abnormal_flag",
    "loop_path",
    "raw_segments",
]


def _fail(msg: str) -> PermanentJobError:
    return PermanentJobError(ErrorCategory.DECODE_ERROR, msg)


@dataclass(slots=True)
class _Delims:
    field: str
    component: str
    repetition: str
    subcomponent: str

    @classmethod
    def from_msh(cls, seg: str) -> _Delims:
        # "MSH" + field-sep + "encoding-chars" + field-sep + ...
        if len(seg) < 8 or not seg.startswith("MSH"):
            raise _fail("malformed HL7v2: stream does not begin with a usable MSH segment")
        fsep = seg[3]
        enc = seg[4 : seg.find(fsep, 4)] if fsep in seg[4:] else seg[4:8]
        comp = enc[0] if len(enc) > 0 else "^"
        rep = enc[1] if len(enc) > 1 else "~"
        sub = enc[3] if len(enc) > 3 else "&"
        return cls(field=fsep, component=comp, repetition=rep, subcomponent=sub)


@dataclass(slots=True)
class _Msg:
    """Header + patient context for the message currently being read."""

    message_type: str = ""
    control_id: str = ""
    sending_app: str = ""
    sending_facility: str = ""
    patient_id: str = ""
    patient_name: str = ""
    event_type: str = ""
    raw: list[str] = field(default_factory=list)


def _fld(fields: list[str], i: int) -> str:
    return fields[i] if i < len(fields) else ""


def _first_comp(value: str, d: _Delims) -> str:
    """First component of the first repetition — the common 'the id/name' pick."""
    return value.split(d.repetition)[0].split(d.component)[0].strip()


async def _segments(chunks: AsyncIterator[bytes]) -> AsyncIterator[str]:
    """Yield raw segment strings. Splits on \\r (HL7's terminator); \\n tolerated."""
    buf = ""
    async for chunk in chunks:
        buf += chunk.decode("latin-1")
        # Normalise line endings to the HL7 segment terminator.
        buf = buf.replace("\r\n", "\r").replace("\n", "\r")
        while True:
            idx = buf.find("\r")
            if idx < 0:
                if len(buf) > MAX_SEGMENT_CHARS:
                    raise _fail(
                        f"malformed HL7v2: segment exceeds {MAX_SEGMENT_CHARS} chars"
                    )
                break
            seg = buf[:idx].strip()
            buf = buf[idx + 1 :]
            if seg:
                yield seg
    tail = buf.strip()
    if tail:
        yield tail


async def decode_hl7v2(
    chunks: AsyncIterator[bytes], batch_size: int, stats: Any
) -> AsyncIterator[Any]:
    """Decode an HL7v2 stream (one or many messages) into governed rows."""
    from app.domain.tablewriter import RowBatch  # local: avoid import cycle

    delims: _Delims | None = None
    msg: _Msg | None = None
    is_oru = False
    emitted_for_msg = False
    rows: list[list[Any]] = []
    seg_count = 0

    def _base(m: _Msg) -> list[Any]:
        return [
            m.message_type, m.control_id, m.sending_app, m.sending_facility,
            m.patient_id, m.patient_name, m.event_type,
        ]

    def _flush_adt() -> None:
        # ADT (or any non-ORU): one summary row per message, if not already emitted
        # via observations.
        nonlocal emitted_for_msg
        if msg is None or is_oru or emitted_for_msg:
            return
        rows.append([
            *_base(msg), "", "", "", "",
            f"MSH/{msg.message_type}",
            "\n".join(msg.raw[:MAX_RAW_SEGMENTS_PER_MESSAGE]),
        ])
        stats.rows_ok += 1
        emitted_for_msg = True

    async for seg in _segments(chunks):
        seg_count += 1
        if seg_count > MAX_SEGMENTS:
            raise _fail(f"malformed HL7v2: stream exceeds {MAX_SEGMENTS} segments")

        if seg.startswith("MSH"):
            _flush_adt()                 # close the previous message
            delims = _Delims.from_msh(seg)
            f = seg.split(delims.field)
            msg = _Msg(raw=[seg])
            # After the MSH split, index 0 is "MSH", index 1 is the encoding chars,
            # so MSH-3 is f[2], MSH-9 is f[8] (HL7 counts MSH-1 as the separator).
            msg.sending_app = _first_comp(_fld(f, 2), delims)
            msg.sending_facility = _first_comp(_fld(f, 3), delims)
            msg.message_type = _fld(f, 8).replace(delims.component, "^").strip()
            msg.control_id = _fld(f, 9).strip()
            is_oru = msg.message_type.startswith("ORU")
            emitted_for_msg = False
            continue

        if msg is None or delims is None:
            raise _fail("malformed HL7v2: a segment appeared before any MSH header")
        if len(msg.raw) < MAX_RAW_SEGMENTS_PER_MESSAGE:
            msg.raw.append(seg)

        f = seg.split(delims.field)
        sid = f[0].strip()
        if sid == "EVN":
            msg.event_type = _fld(f, 1).strip()
        elif sid == "PID":
            msg.patient_id = _first_comp(_fld(f, 3), delims)
            name = _fld(f, 5)
            parts = name.split(delims.component)
            msg.patient_name = " ".join(p.strip() for p in parts[:2] if p.strip())
        elif sid == "OBX" and is_oru:
            rows.append([
                *_base(msg),
                _first_comp(_fld(f, 3), delims),   # observation id (OBX-3)
                _fld(f, 5).strip(),                # value (OBX-5)
                _fld(f, 6).strip(),                # units (OBX-6)
                _fld(f, 8).strip(),                # abnormal flag (OBX-8)
                f"MSH/{msg.message_type}/OBX",
                seg,
            ])
            stats.rows_ok += 1
            emitted_for_msg = True

        if len(rows) >= batch_size:
            yield RowBatch(columns=list(COLUMNS), rows=rows)
            rows = []

    _flush_adt()
    if delims is None:
        raise _fail("malformed HL7v2: no MSH header found in the stream")
    if rows:
        yield RowBatch(columns=list(COLUMNS), rows=rows)
