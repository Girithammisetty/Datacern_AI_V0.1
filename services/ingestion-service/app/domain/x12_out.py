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

Renders 837 (professional claim) and 276 (claim status request, STD-FR-012).
Other transaction sets refuse by name rather than emitting a
structurally-plausible message for the wrong spec (Rule 2). 276 is
outbound-only, matching x12.py's decode side: this platform SENDS status
inquiries and DECODES the 277 responses to them, never the reverse.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
from typing import Any

from app.domain.errors import ErrorCategory, PermanentJobError
from app.domain.x12 import Delimiters

#: ISA is fixed-width; these are the exact field widths in element order.
_ISA_WIDTHS = (2, 10, 2, 10, 2, 15, 2, 15, 6, 4, 1, 5, 9, 1, 1, 1)
SUPPORTED_OUTBOUND = ("837", "276")


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


def render_276(
    inquiries: list[dict[str, Any]],
    control: OutboundControl,
    *,
    payer_id: str,
    payer_name: str,
    provider_npi: str,
    provider_name: str,
    subscriber_id: str,
    subscriber_last: str,
    subscriber_first: str,
    delimiters: Delimiters | None = None,
) -> str:
    """Render one interchange containing a batch of 276 claim-status requests.

    Header-level payer/provider/subscriber context, matching the same
    simplification `render_837` already makes (one subscriber per interchange,
    not per claim) rather than looping a full 2000A-2000D hierarchy. Each
    inquiry loops only its own tracking info (TRN02), using `claim_id` — the
    SAME field name `render_837`'s claims use — so a partner's eventual 277
    response, which echoes the requester's TRN, correlates back through
    `x12.py`'s `_ClaimStatusHandler` (which already reads TRN02 as claim_id)
    the same way an 835 already correlates to its 837.
    """
    if not inquiries:
        raise _fail("X12 render: refusing to render an interchange with zero status inquiries")
    d = delimiters or Delimiters(element="*", component=":", segment="~")
    _safe(payer_id, d, "payer_id")
    _safe(payer_name, d, "payer_name")
    _safe(provider_npi, d, "provider_npi")
    _safe(provider_name, d, "provider_name")
    _safe(subscriber_id, d, "subscriber_id")
    _safe(subscriber_last, d, "subscriber_last")
    _safe(subscriber_first, d, "subscriber_first")
    for name in ("sender_id", "receiver_id", "isa_control", "gs_control", "st_control",
                 "date_yymmdd", "time_hhmm", "date_ccyymmdd", "usage_indicator"):
        _safe(str(getattr(control, name)), d, f"control.{name}")

    body: list[str] = [
        d.element.join(["ST", "276", control.st_control]),
        d.element.join(
            ["BHT", "0010", "13", control.st_control, control.date_ccyymmdd, control.time_hhmm]
        ),
        d.element.join(["NM1", "PR", "2", payer_name, "", "", "", "", "PI", payer_id]),
        d.element.join(["NM1", "1P", "2", provider_name, "", "", "", "", "XX", provider_npi]),
        d.element.join(
            ["NM1", "IL", "1", subscriber_last, subscriber_first, "", "", "", "MI", subscriber_id]
        ),
    ]
    for inquiry in inquiries:
        claim_id = str(inquiry.get("claim_id") or "").strip()
        if not claim_id:
            raise _fail("X12 render: status inquiry is missing claim_id (TRN02)")
        _safe(claim_id, d, "claim_id")
        body.append(d.element.join(["TRN", "1", claim_id]))
        payer_claim_ctrl = str(inquiry.get("payer_claim_control_number") or "").strip()
        if payer_claim_ctrl:
            _safe(payer_claim_ctrl, d, f"inquiry {claim_id!r} payer_claim_control_number")
            body.append(d.element.join(["REF", "1K", payer_claim_ctrl]))
        total_charge = str(inquiry.get("total_charge") or "").strip()
        if total_charge:
            _safe(total_charge, d, f"inquiry {claim_id!r} total_charge")
            body.append(d.element.join(["AMT", "T3", total_charge]))
        service_date = str(inquiry.get("service_date") or "").strip()
        if service_date:
            _safe(service_date, d, f"inquiry {claim_id!r} service_date")
            body.append(d.element.join(["DTP", "472", "D8", service_date]))
    # SE01 counts ST..SE inclusive; +1 for the SE segment itself (same
    # convention as render_837, cross-checked in tests since 276 has no
    # decoder to round-trip through -- it is outbound-only).
    body.append(d.element.join(["SE", str(len(body) + 1), control.st_control]))

    segments = [
        d.element.join(
            ["GS", "HR", control.sender_id.strip(), control.receiver_id.strip(),
             control.date_ccyymmdd, control.time_hhmm, control.gs_control, "X", "005010X212"]
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


# --- writeback integration (BR-1) -------------------------------------------
# An outbound interchange rides the EXISTING proposal-mode writeback spine: no
# new approval code, no second governance path. The only thing added here is
# that the bytes are produced at PROPOSE time and pinned by checksum, so what a
# human approves is byte-identical to what leaves the building.

X12_FORMAT = "x12"
RENDERED_KEY = "x12_rendered"
CHECKSUM_KEY = "x12_checksum"


def is_x12_writeback(target: dict[str, Any] | None) -> bool:
    return bool(target) and str(target.get("format", "")).lower() == X12_FORMAT


def render_for_writeback(
    payload: dict[str, Any], target: dict[str, Any]
) -> dict[str, Any]:
    """Render the interchange at PROPOSE time and pin it into the payload.

    Returns the payload augmented with the exact bytes + their checksum, so
    `GET /writebacks/{id}` shows the approver the literal message (BR-1). A
    render failure raises here, at enqueue — a claim (or status inquiry) that
    cannot be expressed as conformant X12 must never become a pending proposal
    someone could approve. Dispatches on `target.transaction_set`: each
    outbound shape has its own required payload key and identity fields, so
    there is no single generic schema to validate against.
    """
    transaction_set = str(target.get("transaction_set") or "837")
    missing = [
        k for k in ("sender_id", "receiver_id", "isa_control", "gs_control", "st_control")
        if not str(target.get(k) or "").strip()
    ]
    if missing:
        raise _fail(f"X12 writeback: target is missing control field(s) {missing!r}")

    control = OutboundControl(
        sender_id=str(target["sender_id"]),
        receiver_id=str(target["receiver_id"]),
        isa_control=str(target["isa_control"]),
        gs_control=str(target["gs_control"]),
        st_control=str(target["st_control"]),
        date_yymmdd=str(target.get("date_yymmdd") or "000101"),
        time_hhmm=str(target.get("time_hhmm") or "0000"),
        date_ccyymmdd=str(target.get("date_ccyymmdd") or "20000101"),
        usage_indicator=str(target.get("usage_indicator") or "P"),
    )

    if transaction_set == "837":
        claims = payload.get("claims")
        if not isinstance(claims, list):
            raise _fail("X12 writeback: payload.claims must be a list of claims")
        rendered = render_837(
            claims,
            control,
            billing_provider_npi=str(target.get("billing_provider_npi") or ""),
            subscriber_id=str(target.get("subscriber_id") or ""),
            transaction_set=transaction_set,
        )
    elif transaction_set == "276":
        inquiries = payload.get("inquiries")
        if not isinstance(inquiries, list):
            raise _fail("X12 writeback: payload.inquiries must be a list for a 276 request")
        missing_276 = [
            k for k in ("payer_id", "payer_name", "provider_npi", "provider_name",
                        "subscriber_id", "subscriber_last", "subscriber_first")
            if not str(target.get(k) or "").strip()
        ]
        if missing_276:
            raise _fail(f"X12 writeback: 276 target is missing field(s) {missing_276!r}")
        rendered = render_276(
            inquiries,
            control,
            payer_id=str(target["payer_id"]),
            payer_name=str(target["payer_name"]),
            provider_npi=str(target["provider_npi"]),
            provider_name=str(target["provider_name"]),
            subscriber_id=str(target["subscriber_id"]),
            subscriber_last=str(target["subscriber_last"]),
            subscriber_first=str(target["subscriber_first"]),
        )
    else:
        raise _fail(
            f"X12 writeback: transaction set {transaction_set!r} is not supported for "
            f"outbound; this build renders {', '.join(SUPPORTED_OUTBOUND)}"
        )
    return {**payload, RENDERED_KEY: rendered, CHECKSUM_KEY: checksum(rendered)}


def approved_bytes(payload: dict[str, Any]) -> str:
    """Return the exact bytes to transmit, proving they are the approved ones.

    Defence in depth for BR-1: the checksum was computed before a human approved
    the message, so re-verifying it at delivery detects any mutation of the row
    between approval and transmission. A mismatch refuses to send rather than
    transmitting bytes nobody approved.
    """
    rendered = payload.get(RENDERED_KEY)
    if not isinstance(rendered, str) or not rendered:
        raise _fail("X12 writeback: no rendered interchange stored on this writeback")
    expected = payload.get(CHECKSUM_KEY)
    actual = checksum(rendered)
    if expected != actual:
        raise _fail(
            "X12 writeback: rendered interchange does not match the approved checksum "
            "(the message changed after approval); refusing to transmit"
        )
    return rendered
