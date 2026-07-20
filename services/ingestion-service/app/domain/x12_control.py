"""X12 control-number governance (BRD 57 STD-FR-013/043, BR-6, AC-5/AC-6).

Two related, DB-backed concerns that `x12.py` (decode) and `x12_out.py`
(render) deliberately do NOT own, because both of those stay pure functions:

* **Outbound sequencing** (`reserve_control_numbers`) — `render_837` takes its
  control numbers as input rather than generating them, so the propose-time
  checksum means something (BR-1). Something still has to hand out those
  numbers, strictly increasing per trading partner and durable across a
  restart (BR-6) — that is this module's job, not the caller's, and not the
  renderer's.
* **Inbound duplicate detection** (`check_and_record_isa`) — `decode_x12` is a
  pure stream function with no cross-run memory, so it cannot know whether an
  ISA control number was already processed by an earlier ingestion. This is
  inherently stateful (STD-FR-043), which is why it lives here instead of in
  the decoder.

Both are keyed on (tenant_id, sender_id, receiver_id) rather than a formal
trading-partner registry, because STD-FR-040 (the registry) does not exist
yet — sender/receiver ARE the partner identity carried in every ISA, so this
is the narrowest correct key today, not a placeholder for something else.
"""

from __future__ import annotations

import sqlalchemy as sa
from sqlalchemy.ext.asyncio import AsyncSession

from app.domain.errors import ErrorCategory, PermanentJobError
from app.store.models import X12ControlSequence, X12SeenInterchange


def _fail(msg: str) -> PermanentJobError:
    return PermanentJobError(ErrorCategory.DECODE_ERROR, msg)


async def reserve_control_numbers(
    session: AsyncSession,
    tenant_id: str,
    sender_id: str,
    receiver_id: str,
) -> tuple[str, str, str]:
    """Atomically advance and return the next (isa, gs, st) control numbers for
    this trading partner, as strings ready for `OutboundControl`.

    ISA13 is zero-padded to 9 digits (the ISA is fixed-width, so this is the
    conformant representation); GS06/ST02 are rendered as plain decimal
    strings. Row-locked (`with_for_update`) so two concurrent proposals for
    the same partner cannot both claim the same number; the first-ever
    reservation for a partner is guarded against a create/create race via a
    nested-transaction retry rather than assuming the SELECT-then-INSERT is
    uncontended.
    """
    stmt = (
        sa.select(X12ControlSequence)
        .where(
            X12ControlSequence.tenant_id == tenant_id,
            X12ControlSequence.sender_id == sender_id,
            X12ControlSequence.receiver_id == receiver_id,
        )
        .with_for_update()
    )
    row = (await session.execute(stmt)).scalar_one_or_none()
    if row is None:
        try:
            async with session.begin_nested():
                row = X12ControlSequence(
                    tenant_id=tenant_id, sender_id=sender_id, receiver_id=receiver_id,
                    isa_seq=0, gs_seq=0, st_seq=0,
                )
                session.add(row)
                await session.flush()
        except sa.exc.IntegrityError:
            # Another concurrent reservation created the row first; re-fetch
            # and lock the row it committed rather than erroring out.
            row = (await session.execute(stmt)).scalar_one()
    row.isa_seq += 1
    row.gs_seq += 1
    row.st_seq += 1
    await session.flush()
    return f"{row.isa_seq:09d}", str(row.gs_seq), str(row.st_seq)


async def check_and_record_isa(
    session: AsyncSession,
    tenant_id: str,
    sender_id: str,
    receiver_id: str,
    isa_control_number: str,
    *,
    ingestion_id: str | None = None,
) -> None:
    """Reject a replayed inbound ISA control number (STD-FR-043 / AC-5).

    The UNIQUE constraint on (tenant, sender, receiver, isa_control_number) is
    the actual guard — this inserts speculatively inside a SAVEPOINT so a
    conflict raises a clean, typed error instead of aborting the caller's
    whole transaction. Recording happens BEFORE decode, matching real X12
    practice: a sender must not reuse a control number even if the receiver's
    processing of that interchange later fails for an unrelated reason.
    """
    seen = X12SeenInterchange(
        tenant_id=tenant_id, sender_id=sender_id, receiver_id=receiver_id,
        isa_control_number=isa_control_number, ingestion_id=ingestion_id,
    )
    try:
        async with session.begin_nested():
            session.add(seen)
            await session.flush()
    except sa.exc.IntegrityError:
        raise _fail(
            f"malformed X12: interchange control number {isa_control_number!r} from "
            f"{sender_id!r} to {receiver_id!r} has already been processed "
            "(STD-FR-043: replayed ISA control numbers are rejected)"
        ) from None
