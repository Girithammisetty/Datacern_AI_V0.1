"""B6 (BRD 58): cross-tenant outbox PRUNE function, following the exact
precedent of 0005's claim/mark-published functions.

0005 explained why a plain cross-tenant `SELECT`/`UPDATE` on `outbox` fails
under FORCE ROW LEVEL SECURITY with no GUC ever set on the relay's connection:
`tenant_isolation`'s policy raises on the unset `app.tenant_id` GUC. The fix
there was two narrow SECURITY DEFINER functions scoped to `outbox` only, rather
than a broad RLS bypass. A prune (DELETE, not SELECT/UPDATE) needs the same
treatment -- a plain `DELETE FROM outbox WHERE published_at < ...` would be
blocked identically, so published outbox rows would silently never be pruned.

Revision ID: 0009
Revises: 0008
"""

from __future__ import annotations

from alembic import op

revision = "0009"
down_revision = "0008"
branch_labels = None
depends_on = None

FN = """
CREATE OR REPLACE FUNCTION ing_outbox_prune(p_retention_seconds bigint, p_batch integer)
RETURNS bigint
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
    WITH doomed AS (
        SELECT id FROM outbox
        WHERE published_at IS NOT NULL
          AND published_at < now() - (p_retention_seconds::text || ' seconds')::interval
        LIMIT p_batch
    ), deleted AS (
        DELETE FROM outbox USING doomed WHERE outbox.id = doomed.id
        RETURNING outbox.id
    )
    SELECT count(*) FROM deleted
$$;
GRANT EXECUTE ON FUNCTION ing_outbox_prune(bigint, integer) TO PUBLIC;
"""


def upgrade() -> None:
    op.execute(FN)


def downgrade() -> None:
    raise NotImplementedError("forward-only migrations (MASTER-FR-060)")
