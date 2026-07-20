"""X12 outbound control-number sequencing + inbound duplicate-ISA detection
(BRD 57 STD-FR-013/043, BR-6, AC-5/AC-6).

Two small, tenant-isolated tables:

* ``x12_control_sequences`` — one row per (tenant, sender, receiver) trading
  partner, holding the last-issued ISA/GS/ST control numbers. Durable across
  restarts (BR-6): the counter lives in the database, not in memory.
* ``x12_seen_interchanges`` — one row per inbound ISA control number ever
  processed for a partner. The UNIQUE constraint is the actual duplicate guard
  (STD-FR-043); the row is an audit trail as a side effect.

Revision ID: 0008
Revises: 0007
"""

from __future__ import annotations

from alembic import op

revision = "0008"
down_revision = "0007"
branch_labels = None
depends_on = None

DDL = """
CREATE TABLE x12_control_sequences (
    id uuid PRIMARY KEY,
    tenant_id uuid NOT NULL,
    sender_id text NOT NULL,
    receiver_id text NOT NULL,
    isa_seq bigint NOT NULL DEFAULT 0,
    gs_seq bigint NOT NULL DEFAULT 0,
    st_seq bigint NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT uq_x12_control_seq_partner UNIQUE (tenant_id, sender_id, receiver_id)
);

CREATE TABLE x12_seen_interchanges (
    id uuid PRIMARY KEY,
    tenant_id uuid NOT NULL,
    sender_id text NOT NULL,
    receiver_id text NOT NULL,
    isa_control_number text NOT NULL,
    ingestion_id uuid,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT uq_x12_seen_interchange
        UNIQUE (tenant_id, sender_id, receiver_id, isa_control_number)
);
CREATE INDEX ix_x12_seen_interchanges_tenant ON x12_seen_interchanges (tenant_id);
"""


def upgrade() -> None:
    op.execute(DDL)
    for table in ("x12_control_sequences", "x12_seen_interchanges"):
        op.execute(f"ALTER TABLE {table} ENABLE ROW LEVEL SECURITY")
        op.execute(f"ALTER TABLE {table} FORCE ROW LEVEL SECURITY")
        op.execute(
            f"CREATE POLICY tenant_isolation ON {table} "
            "USING (tenant_id = current_setting('app.tenant_id')::uuid) "
            "WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid)"
        )


def downgrade() -> None:
    raise NotImplementedError("forward-only migrations (MASTER-FR-060)")
