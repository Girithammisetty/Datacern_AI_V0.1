"""case_streams: the first-class Stream object of the realtime-case-streams
add-on (docs/initiatives/realtime-case-streams-addon.md, slice 3).

A Case Stream binds what a tenant previously assembled by hand — a connection
plus a watermark-incremental schedule plus (optionally, wired by the caller
until the bff slice lands) a case-service CaseTrigger — into one named,
department-scoped object the UX and the entitlement gate can hold onto. The
streaming engine itself is NOT new: the underlying `schedules` row carries the
watermark cursor and Temporal timing; this table is the binding + lifecycle
state, so dropping it loses no data-plane state.

Tenant-RLS like every other ingestion table (0001's pattern). Forward-only
(MASTER-FR-060).

Revision ID: 0011
Revises: 0010
"""

from __future__ import annotations

from alembic import op

revision = "0011"
down_revision = "0010"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE case_streams (
            id              UUID PRIMARY KEY,
            tenant_id       UUID NOT NULL,
            workspace_id    UUID NOT NULL,
            name            TEXT NOT NULL,
            connection_id   UUID NOT NULL,
            schedule_id     UUID NOT NULL,
            -- case-service CaseTrigger this stream feeds; NULL until the caller
            -- (the bff in slice 4) registers one. Deliberately NOT a foreign
            -- key: it lives in another service's database.
            case_trigger_id UUID,
            status          TEXT NOT NULL DEFAULT 'active'
                            CHECK (status IN ('active', 'paused')),
            created_by      TEXT,
            created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
            deleted_at      TIMESTAMPTZ
        )
        """
    )
    op.execute("CREATE INDEX ix_case_streams_tenant ON case_streams (tenant_id, status)")
    # Partial unique index: live streams own their name; soft-deleted ones free it.
    op.execute(
        "CREATE UNIQUE INDEX uq_case_streams_live_name "
        "ON case_streams (tenant_id, workspace_id, name) WHERE deleted_at IS NULL"
    )
    op.execute("ALTER TABLE case_streams ENABLE ROW LEVEL SECURITY")
    op.execute("ALTER TABLE case_streams FORCE ROW LEVEL SECURITY")
    op.execute(
        "CREATE POLICY tenant_isolation ON case_streams "
        "USING (tenant_id = current_setting('app.tenant_id')::uuid) "
        "WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid)"
    )


def downgrade() -> None:
    raise NotImplementedError("forward-only migrations (MASTER-FR-060)")
