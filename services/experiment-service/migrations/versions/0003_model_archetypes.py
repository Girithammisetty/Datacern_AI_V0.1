"""Model archetypes: governed model BLUEPRINTS (intended-model specs) a
capability pack declares — an archetype names a model the vertical expects
(task/target/expected metrics/governance) independent of any trained artifact,
which comes from a run. Tenant-RLS like every other table (MASTER-FR-001).
Forward-only (MASTER-FR-060). pack-service inc9.

Revision ID: 0003
"""

from alembic import op

revision = "0003"
down_revision = "0002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE model_archetypes (
            id uuid PRIMARY KEY,
            tenant_id uuid NOT NULL,
            workspace_id uuid NOT NULL,
            archetype_key text NOT NULL,
            name text NOT NULL,
            task_type text NOT NULL,
            target text,
            description text,
            expected_metrics jsonb NOT NULL DEFAULT '{}',
            governance_notes text,
            created_by text NOT NULL,
            created_at timestamptz NOT NULL,
            updated_at timestamptz NOT NULL,
            deleted_at timestamptz,
            UNIQUE (tenant_id, workspace_id, archetype_key)
        );
        """
    )
    # RLS: ENABLE + FORCE (so the owner is also subject) + the tenant_isolation
    # policy, matching every other tenant table (0001/0002).
    op.execute("ALTER TABLE model_archetypes ENABLE ROW LEVEL SECURITY;")
    op.execute("ALTER TABLE model_archetypes FORCE ROW LEVEL SECURITY;")
    op.execute(
        """
        CREATE POLICY tenant_isolation_model_archetypes ON model_archetypes
        USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
        """
    )
    # DML for the non-privileged runtime login role (0001 also sets ALTER DEFAULT
    # PRIVILEGES, but grant explicitly so this table is covered regardless).
    op.execute("GRANT SELECT, INSERT, UPDATE, DELETE ON model_archetypes TO experiment_app;")


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS model_archetypes;")
