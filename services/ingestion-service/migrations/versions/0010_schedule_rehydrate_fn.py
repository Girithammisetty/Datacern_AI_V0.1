"""Cross-tenant schedule listing for boot-time rehydration (ING-FR-060/062).

The in-process scheduler keeps its registry in memory, so every enabled
schedule is forgotten on restart: the process comes back with an empty entry
table and a `schedule_tenants` map with no way to resolve a fire to a tenant.
Rehydration has to read schedules across ALL tenants at boot, on a connection
that never calls `tenant_session` -- exactly the situation migration 0005
solved for the outbox relay.

Same remedy, same shape: one narrow SECURITY DEFINER function scoped to the
timing columns of enabled, non-deleted schedules. The runtime role stays
NOSUPERUSER NOBYPASSRLS (0004) and nothing here exposes tenant payloads --
`ingestion_template` is deliberately NOT returned; the fire path re-reads the
row inside the owning tenant's session.

Revision ID: 0010
Revises: 0009
"""

from __future__ import annotations

from alembic import op

revision = "0010"
down_revision = "0009"
branch_labels = None
depends_on = None

FN = """
CREATE OR REPLACE FUNCTION ing_schedules_for_rehydrate()
RETURNS TABLE (
    id uuid,
    tenant_id uuid,
    cron text,
    interval_seconds integer,
    timezone text
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT s.id, s.tenant_id, s.cron, s.interval_seconds, s.timezone
    FROM schedules s
    WHERE s.deleted_at IS NULL AND s.enabled IS TRUE
    ORDER BY s.id
$$;
GRANT EXECUTE ON FUNCTION ing_schedules_for_rehydrate() TO PUBLIC;
"""


def upgrade() -> None:
    op.execute(FN)


def downgrade() -> None:
    raise NotImplementedError("forward-only migrations (MASTER-FR-060)")
