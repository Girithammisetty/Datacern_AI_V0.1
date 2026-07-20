"""X12 control-number governance (BRD 57 STD-FR-013/043, BR-6, AC-5/AC-6).

Exercises `x12_control.py` directly against a real (SQLite, unit tier)
session, since both functions are DB-backed by design (unlike the pure
decode/render modules).
"""

from __future__ import annotations

import sqlalchemy as sa

from app.domain import x12_control
from app.domain.errors import PermanentJobError
from app.store.models import X12ControlSequence, X12SeenInterchange
from tests.util import TENANT_A, TENANT_B


async def test_reserve_control_numbers_starts_at_one(container):
    async with container.db.tenant_session(TENANT_A) as session:
        isa, gs, st = await x12_control.reserve_control_numbers(
            session, TENANT_A, "SENDER", "RECEIVER"
        )
        await session.commit()
    assert isa == "000000001" and gs == "1" and st == "1"


async def test_reserve_control_numbers_is_monotonic_per_partner(container):
    async with container.db.tenant_session(TENANT_A) as session:
        first = await x12_control.reserve_control_numbers(
            session, TENANT_A, "SENDER", "RECEIVER"
        )
        await session.commit()
    async with container.db.tenant_session(TENANT_A) as session:
        second = await x12_control.reserve_control_numbers(
            session, TENANT_A, "SENDER", "RECEIVER"
        )
        await session.commit()
    assert second[0] == "000000002" and second[1] == "2" and second[2] == "2"
    assert first != second


async def test_reserve_control_numbers_is_isolated_per_partner_and_tenant(container):
    async with container.db.tenant_session(TENANT_A) as session:
        a = await x12_control.reserve_control_numbers(session, TENANT_A, "S", "R")
        b = await x12_control.reserve_control_numbers(session, TENANT_A, "S2", "R2")
        await session.commit()
    async with container.db.tenant_session(TENANT_B) as session:
        c = await x12_control.reserve_control_numbers(session, TENANT_B, "S", "R")
        await session.commit()
    # Different partners (and different tenants for the same partner id) each
    # start their own sequence at 1 -- no cross-contamination.
    assert a == ("000000001", "1", "1")
    assert b == ("000000001", "1", "1")
    assert c == ("000000001", "1", "1")


async def test_reserve_control_numbers_survives_a_fresh_session(container):
    """BR-6: durable across a restart. A brand-new session against the same
    engine (simulating a service restart) must continue the sequence, not
    reset it -- proving the counter lives in the database, not in memory."""
    async with container.db.tenant_session(TENANT_A) as session:
        await x12_control.reserve_control_numbers(session, TENANT_A, "SENDER", "RECEIVER")
        await session.commit()
    async with container.db.tenant_session(TENANT_A) as fresh_session:
        row = (
            await fresh_session.execute(
                sa.select(X12ControlSequence).where(
                    X12ControlSequence.tenant_id == TENANT_A,
                    X12ControlSequence.sender_id == "SENDER",
                )
            )
        ).scalar_one()
        assert row.isa_seq == 1
        next_isa, _, _ = await x12_control.reserve_control_numbers(
            fresh_session, TENANT_A, "SENDER", "RECEIVER"
        )
        await fresh_session.commit()
    assert next_isa == "000000002"


async def test_check_and_record_isa_accepts_a_new_control_number(container):
    async with container.db.tenant_session(TENANT_A) as session:
        await x12_control.check_and_record_isa(
            session, TENANT_A, "SENDER", "RECEIVER", "000000001", ingestion_id=None
        )
        await session.commit()
    async with container.db.tenant_session(TENANT_A) as session:
        row = (
            await session.execute(
                sa.select(X12SeenInterchange).where(
                    X12SeenInterchange.tenant_id == TENANT_A,
                    X12SeenInterchange.isa_control_number == "000000001",
                )
            )
        ).scalar_one()
        assert row.sender_id == "SENDER"


async def test_check_and_record_isa_rejects_a_replay(container):
    async with container.db.tenant_session(TENANT_A) as session:
        await x12_control.check_and_record_isa(
            session, TENANT_A, "SENDER", "RECEIVER", "000000001"
        )
        await session.commit()
    async with container.db.tenant_session(TENANT_A) as session:
        try:
            await x12_control.check_and_record_isa(
                session, TENANT_A, "SENDER", "RECEIVER", "000000001"
            )
            raised = False
        except PermanentJobError as exc:
            raised = True
            assert "already been processed" in str(exc)
            assert "000000001" in str(exc)
        assert raised
        await session.commit()  # the savepoint rollback leaves the outer txn usable


async def test_check_and_record_isa_same_number_different_partner_is_not_a_replay(container):
    """The same control number from a DIFFERENT sender/receiver pair is not a
    collision -- ISA control numbers are only unique per trading partner."""
    async with container.db.tenant_session(TENANT_A) as session:
        await x12_control.check_and_record_isa(
            session, TENANT_A, "SENDER", "RECEIVER", "000000001"
        )
        await x12_control.check_and_record_isa(
            session, TENANT_A, "OTHER_SENDER", "RECEIVER", "000000001"
        )
        await session.commit()  # no error


async def test_check_and_record_isa_same_number_different_tenant_is_not_a_replay(container):
    async with container.db.tenant_session(TENANT_A) as session:
        await x12_control.check_and_record_isa(
            session, TENANT_A, "SENDER", "RECEIVER", "000000001"
        )
        await session.commit()
    async with container.db.tenant_session(TENANT_B) as session:
        await x12_control.check_and_record_isa(
            session, TENANT_B, "SENDER", "RECEIVER", "000000001"
        )
        await session.commit()  # no error -- RLS-isolated tenants
