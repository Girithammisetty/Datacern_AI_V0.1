"""X12 EDI serialization (BRD 57 inc-2, STD-FR-012, BR-1/BR-6).

The encode half of the grammar; `x12.py` decodes. Kept separate because the two
directions have different failure semantics: decoding tolerates a hostile file
and must refuse it, encoding produces OUR bytes and must refuse to emit anything
that is not conformant.

**Why rendering happens at PROPOSE time, not at transmit time.** BR-1 requires
that the approver of an outbound message sees the exact message that will be
transmitted. If the interchange were assembled during delivery, the bytes on the
wire could differ from the bytes reviewed — different control numbers, or source
data that changed between approval and send — which would make four-eyes
approval of an outbound claim meaningless. So the caller renders here, stores the
result (plus `checksum`) on the writeback, routes THAT through the existing
four-eyes spine, and transmits the stored bytes verbatim.

Consequence, accepted deliberately: a rejected proposal burns its control
numbers, leaving a gap in the outbound sequence. BR-6 already treats a gap as an
operational alert rather than something to silently paper over, and "this number
belonged to a transmission a human refused" is a better audit story than
"approved bytes and sent bytes differ".

inc-2 renders 837 (professional). Other transaction sets refuse by name rather
than emitting a structurally-plausible message for the wrong spec (Rule 2).
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
from typing import Any

from app.domain.errors import ErrorCategory, PermanentJobError
from app.domain.x12 import Delimiters

#: ISA is fixed-width; these are the exact field widths in element order.
_ISA_WIDTHS = (2, 10, 2, 10, 2, 15, 2, 15, 6, 4, 1, 5, 9, 1, 1, 1)
SUPPORTED_OUTBOUND = ("837",)


def _fail(msg: str) -> PermanentJobError:
    return PermanentJobError(ErrorCategory.DECODE_ERROR, msg)


def _safe(value: str, d: Delimiters, field: str) -> str:
    """Refuse any value carrying a reserved delimiter — X12 EDI INJECTION guard.

    X12 has NO escape mechanism: a delimiter inside a data element is
    indistinguishable from a real one. A ``~`` in a field therefore terminates
    the segment early and everything after it is parsed as a NEW segment, which
    lets untrusted content forge segments — e.g. a claim id of
    ``GOOD~NM1*85*2*ATTACKER*****XX*9999999999`` injects a second billing-provider
    NM1 and reroutes payment. (Verified against this renderer before the guard
    existed.) Since the value cannot be escaped and must not be silently mangled,
    the only safe action is to refuse it (Rule 2).

    ``^`` is included because ISA11 declares it as the repetition separator.
    """
    reserved = {d.element, d.component, d.segment, "^"}
    found = sorted(reserved & set(value))
    if found:
        raise _fail(
            f"X12 render: {field} contains reserved delimiter(s) {found!r}; X12 has no "
            "escape mechanism, so the value cannot be transmitted without corrupting "
            "the interchange"
        )
    return value


@dataclass(slots=True)
class OutboundControl:
    """Envelope identity for one interchange.

    Control numbers are supplied by the caller (which owns the per-partner
    monotonic sequence, BR-6) rather than generated here, so rendering stays a
    pure function — the same inputs always produce the same bytes, which is what
    makes the propose-time checksum meaningful.
    """

    sender_id: str
    receiver_id: str
    isa_control: str
    gs_control: str
    st_control: str
    date_yymmdd: str = "000101"
    time_hhmm: str = "0000"
    date_ccyymmdd: str = "20000101"
    usage_indicator: str = "P"  # P=production, T=test


def _isa(control: OutboundControl, d: Delimiters) -> str:
    """Build the fixed-width 106-char ISA. Over-long fields are a caller bug and
    are refused rather than silently truncated into a malformed envelope."""
    fields = [
        "00", "", "00", "", "ZZ", control.sender_id, "ZZ", control.receiver_id,
        control.date_yymmdd, control.time_hhmm, "^", "00501",
        control.isa_control, "0", control.usage_indicator, d.component,
    ]
    out = []
    for value, width in zip(fields, _ISA_WIDTHS, strict=True):
        if len(value) > width:
            raise _fail(f"X12 render: ISA field {value!r} exceeds its fixed width {width}")
        out.append(value.ljust(width))
    seg = "ISA" + d.element + d.element.join(out) + d.segment
    if len(seg) != 106:
        raise _fail(f"X12 render: assembled ISA is {len(seg)} chars, must be 106")
    return seg


def _claim_segments(claim: dict[str, Any], d: Delimiters) -> list[str]:
    """The 2300 loop for one claim. Missing required data refuses the render."""
    claim_id = str(claim.get("claim_id") or "").strip()
    if not claim_id:
        raise _fail("X12 render: claim is missing claim_id (CLM01)")
    _safe(claim_id, d, "claim_id")
    charge = str(claim.get("total_charge") or "").strip()
    if not charge:
        raise _fail(f"X12 render: claim {claim_id!r} is missing total_charge (CLM02)")
    _safe(charge, d, f"claim {claim_id!r} total_charge")

    pos = _safe(
        str(claim.get("place_of_service") or "11"), d, f"claim {claim_id!r} place_of_service"
    )
    segs = [
        d.element.join(["CLM", claim_id, charge, "", "", d.component.join([pos, "B", "1"])])
    ]
    diagnoses = [
        _safe(str(x).strip(), d, f"claim {claim_id!r} diagnosis code")
        for x in (claim.get("diagnosis_codes") or [])
        if str(x).strip()
    ]
    if diagnoses:
        # First diagnosis is the principal (ABK), the rest are secondary (ABF).
        comps = [d.component.join(["ABK", diagnoses[0]])]
        comps += [d.component.join(["ABF", code]) for code in diagnoses[1:]]
        segs.append(d.element.join(["HI", *comps]))
    for idx, line in enumerate(claim.get("service_lines") or [], start=1):
        proc = str(line.get("procedure_code") or "").strip()
        amount = str(line.get("charge") or "").strip()
        if not proc or not amount:
            raise _fail(
                f"X12 render: claim {claim_id!r} service line {idx} needs procedure_code + charge"
            )
        _safe(proc, d, f"claim {claim_id!r} service line {idx} procedure_code")
        _safe(amount, d, f"claim {claim_id!r} service line {idx} charge")
        segs.append(d.element.join(["LX", str(idx)]))
        segs.append(
            d.element.join(["SV1", d.component.join(["HC", proc]), amount, "UN", "1"])
        )
    return segs


def render_837(
    claims: list[dict[str, Any]],
    control: OutboundControl,
    *,
    billing_provider_npi: str,
    subscriber_id: str,
    delimiters: Delimiters | None = None,
    transaction_set: str = "837",
) -> str:
    """Render one interchange containing `claims`. Pure: same inputs -> same bytes."""
    if transaction_set not in SUPPORTED_OUTBOUND:
        raise _fail(
            f"X12 render: transaction set {transaction_set!r} is not supported for outbound; "
            f"this build renders {', '.join(SUPPORTED_OUTBOUND)}"
        )
    if not claims:
        # An empty interchange is never a valid thing to transmit — refusing beats
        # sending a partner a well-formed envelope with nothing in it.
        raise _fail("X12 render: refusing to render an interchange with zero claims")
    d = delimiters or Delimiters(element="*", component=":", segment="~")
    # Every caller-supplied value that reaches a segment is delimiter-checked;
    # identity fields matter most because an injected NM1 can reroute payment.
    _safe(billing_provider_npi, d, "billing_provider_npi")
    _safe(subscriber_id, d, "subscriber_id")
    for name in ("sender_id", "receiver_id", "isa_control", "gs_control", "st_control",
                 "date_yymmdd", "time_hhmm", "date_ccyymmdd", "usage_indicator"):
        _safe(str(getattr(control, name)), d, f"control.{name}")

    body: list[str] = [
        d.element.join(["ST", transaction_set, control.st_control]),
        d.element.join(
            ["NM1", "85", "2", "BILLING PROVIDER", "", "", "", "", "XX", billing_provider_npi]
        ),
        d.element.join(["NM1", "IL", "1", "SUBSCRIBER", "", "", "", "", "MI", subscriber_id]),
    ]
    for claim in claims:
        body.extend(_claim_segments(claim, d))
    # SE01 counts ST..SE inclusive; +1 for the SE segment itself. The decoder
    # verifies this, so a miscount here fails the round-trip test rather than
    # reaching a trading partner.
    body.append(d.element.join(["SE", str(len(body) + 1), control.st_control]))

    segments = [
        d.element.join(
            ["GS", "HC", control.sender_id.strip(), control.receiver_id.strip(),
             control.date_ccyymmdd, control.time_hhmm, control.gs_control, "X", "005010X222A1"]
        ),
        *body,
        d.element.join(["GE", "1", control.gs_control]),
        d.element.join(["IEA", "1", control.isa_control]),
    ]
    return _isa(control, d) + d.segment.join(segments) + d.segment


def checksum(rendered: str) -> str:
    """SHA-256 of the exact bytes to be transmitted.

    Stored on the writeback at propose time so the delivery step can prove it is
    sending precisely what the approver saw (BR-1).
    """
    return hashlib.sha256(rendered.encode("latin-1")).hexdigest()
