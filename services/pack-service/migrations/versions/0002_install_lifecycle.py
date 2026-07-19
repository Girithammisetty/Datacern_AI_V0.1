"""pack-service install lifecycle — upgrade + rollback (BRD 23 PKG-FR-003/026).

Adds the columns that let one install SUPERSEDE another across a version change,
so a pack can be upgraded to a newer version (materialize added components,
reverse removed ones, re-apply retained ones) and rolled back to a prior version:

  * operation         — how this install row came to be: 'install' | 'upgrade'
                        | 'rollback'. The original install is 'install'; each
                        subsequent version transition creates a NEW row.
  * supersedes        — the install row this one replaced (the version we moved
                        FROM). NULL for a first install.
  * superseded_by     — set on the PRIOR row when a newer install replaces it, so
                        the head of the chain is the row with superseded_by IS
                        NULL. A superseded row also flips status -> 'superseded'.
  * manifest_snapshot — the FULL pack bundle text (pack.yaml + every component
                        file) exactly as materialized by this row. Rollback
                        re-applies a prior row's snapshot verbatim, so a downgrade
                        re-creates a component a later version removed WITHOUT
                        needing the old bundle still on disk (PKG-FR-005 registry
                        is deferred; the snapshot is the durable version record).

installs already has RLS ENABLE+FORCE + the tenant_isolation policy from 0001 and
pack_app already holds table privileges, so no policy/grant change is needed.

Forward-only (MASTER-FR-060). Revision ID: 0002
"""

from alembic import op

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        ALTER TABLE installs
            ADD COLUMN operation        text  NOT NULL DEFAULT 'install',
            ADD COLUMN supersedes       uuid  REFERENCES installs(id),
            ADD COLUMN superseded_by    uuid  REFERENCES installs(id),
            ADD COLUMN manifest_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb;

        -- The live head of each pack-in-workspace chain (superseded_by IS NULL).
        CREATE INDEX installs_head_idx ON installs (tenant_id, workspace_id, pack_name)
            WHERE superseded_by IS NULL;
        """
    )


def downgrade() -> None:
    op.execute(
        """
        DROP INDEX IF EXISTS installs_head_idx;
        ALTER TABLE installs
            DROP COLUMN IF EXISTS manifest_snapshot,
            DROP COLUMN IF EXISTS superseded_by,
            DROP COLUMN IF EXISTS supersedes,
            DROP COLUMN IF EXISTS operation;
        """
    )
