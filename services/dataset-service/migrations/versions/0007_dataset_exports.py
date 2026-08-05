"""BRD 74 D1 — dataset export operations.

Until now the only way to get a dataset OUT of the platform was to hand-write a
``SELECT *`` saved query and export THAT through query-service. This adds the
operation row behind ``POST /datasets/{id}/exports``.

Deliberately thin: the artifact bytes, the HMAC signing secret and the 24h
retention GC all stay in query-service (BRD 74 AC-3), so this table has no
artifact column and no expiry sweeper — only which dataset VERSION was exported,
the query-service execution that produced it, and the signed URL it minted.

Tenant-RLS like every other table (0001/0002); dataset_app already holds DML via
0002's default privileges. Forward-only (MASTER-FR-060).

Revision ID: 0007
"""

from alembic import op

revision = "0007"
down_revision = "0006"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE dataset_exports (
            id uuid PRIMARY KEY,
            tenant_id uuid NOT NULL,
            dataset_id uuid NOT NULL,
            version_id uuid NOT NULL,
            version_no integer NOT NULL,
            version_urn text NOT NULL,
            format text NOT NULL,
            status text NOT NULL DEFAULT 'pending',
            query_execution_id text,
            download_url text,
            expires_at timestamptz,
            row_count bigint,
            error text,
            created_by text NOT NULL,
            started_at timestamptz,
            finished_at timestamptz,
            created_at timestamptz NOT NULL,
            CONSTRAINT ck_dataset_exports_status
                CHECK (status IN ('pending','running','completed','failed'))
        );
        CREATE INDEX ix_dataset_exports_tenant ON dataset_exports (tenant_id, id);
        CREATE INDEX ix_dataset_exports_active
            ON dataset_exports (tenant_id, dataset_id)
            WHERE status IN ('pending','running');
        """
    )
    op.execute("ALTER TABLE dataset_exports ENABLE ROW LEVEL SECURITY;")
    op.execute("ALTER TABLE dataset_exports FORCE ROW LEVEL SECURITY;")
    op.execute(
        """
        CREATE POLICY tenant_isolation_dataset_exports ON dataset_exports
            USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
            WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
        """
    )


def downgrade() -> None:
    raise NotImplementedError("forward-only migrations (MASTER-FR-060)")
