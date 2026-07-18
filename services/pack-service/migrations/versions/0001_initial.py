"""pack-service initial schema (BRD 23).

Two tenant-scoped, RLS-forced tables:

  * installs             — one governed install of a pack version into a
                           workspace (PKG-FR-020/021): its dry-run plan, status,
                           and summary.
  * materialized_objects — the install ledger (PKG-FR-021): every real object a
                           pack materialized into a Core service, origin-tagged
                           (``pack:<name>@<version>:<identity>``) so uninstall
                           (PKG-FR-025) can reverse exactly what the pack created
                           and nothing a user made.

The pack CATALOG is not stored here — it is read live from the on-disk packs/
directory (a real deployment would resolve it from the OCI registry, PKG-FR-005;
deferred). So there is no cross-tenant catalog table to leak.

Every table carries tenant_id and gets ENABLE + FORCE ROW LEVEL SECURITY with a
``tenant_isolation`` policy keyed on ``current_setting('app.tenant_id')``
(MASTER-FR-001). Migrations run privileged (PACK_MIGRATE_URL); the runtime logs
in as the non-superuser ``pack_app`` role so the policy is enforced.

Forward-only (MASTER-FR-060). Revision ID: 0001
"""

from alembic import op

revision = "0001"
down_revision = None
branch_labels = None
depends_on = None

TENANT_TABLES = ["installs", "materialized_objects"]


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE installs (
            id             uuid PRIMARY KEY,
            tenant_id      uuid NOT NULL,
            workspace_id   uuid NOT NULL,
            pack_name      text NOT NULL,
            pack_version   text NOT NULL,
            status         text NOT NULL DEFAULT 'planned',
            plan           jsonb NOT NULL DEFAULT '[]'::jsonb,
            summary        jsonb NOT NULL DEFAULT '{}'::jsonb,
            created_by     text,
            created_at     timestamptz NOT NULL DEFAULT now(),
            updated_at     timestamptz NOT NULL DEFAULT now()
        );
        CREATE INDEX installs_ws_idx ON installs (tenant_id, workspace_id);

        CREATE TABLE materialized_objects (
            id             uuid PRIMARY KEY,
            install_id     uuid NOT NULL REFERENCES installs(id) ON DELETE CASCADE,
            tenant_id      uuid NOT NULL,
            kind           text NOT NULL,
            identity       text NOT NULL,
            target_urn     text,
            target_id      text,
            origin         text NOT NULL,
            action         text NOT NULL,
            detail         text,
            reversible     boolean NOT NULL DEFAULT false,
            tombstoned     boolean NOT NULL DEFAULT false,
            created_at     timestamptz NOT NULL DEFAULT now()
        );
        CREATE INDEX materialized_install_idx ON materialized_objects (install_id);
        """
    )

    for table in TENANT_TABLES:
        op.execute(f"ALTER TABLE {table} ENABLE ROW LEVEL SECURITY;")
        op.execute(f"ALTER TABLE {table} FORCE ROW LEVEL SECURITY;")
        op.execute(
            f"""
            CREATE POLICY tenant_isolation_{table} ON {table}
            USING (
                tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
            );
            """
        )

    # Non-superuser LOGIN runtime role (NOBYPASSRLS) so the policies above are
    # actually enforced. A dev password ships so the default DSN works; prod
    # overrides PACK_DATABASE_URL with Vault creds.
    op.execute(
        """
        DO $$ BEGIN
            IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'pack_app') THEN
                ALTER ROLE pack_app WITH LOGIN PASSWORD 'pack_app'
                    NOSUPERUSER NOBYPASSRLS;
            ELSE
                CREATE ROLE pack_app WITH LOGIN PASSWORD 'pack_app'
                    NOSUPERUSER NOBYPASSRLS;
            END IF;
        END $$;
        GRANT USAGE ON SCHEMA public TO pack_app;
        GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO pack_app;
        GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO pack_app;
        ALTER DEFAULT PRIVILEGES IN SCHEMA public
            GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO pack_app;
        ALTER DEFAULT PRIVILEGES IN SCHEMA public
            GRANT USAGE, SELECT ON SEQUENCES TO pack_app;
        """
    )


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS materialized_objects CASCADE;")
    op.execute("DROP TABLE IF EXISTS installs CASCADE;")
