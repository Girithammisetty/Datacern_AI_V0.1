"""BRD 73 — batch job orchestration (chained ingest → pipeline).

Three tables, all with RLS exactly like every other tenant table in this service
(ENABLE + FORCE + tenant_isolation with an explicit WITH CHECK), plus the
permissive `app.worker` policy that `pipeline_runs` (0004) and `outbox` (0001)
already carry — the due-scan, the orphan reaper and the phase-deadline sweep all
read ACROSS tenants from a worker session, and under FORCE RLS the isolation
policy alone matches zero rows for a session with no `app.tenant_id`. That is a
silent no-op rather than an error, so the sweeps would simply never find anything
and the whole mechanism would look like it worked.

Two constraints carry real semantics rather than hygiene:

* `ux_batch_runs_active_job` — a PARTIAL unique index on (batch_job_id) over the
  non-terminal statuses. Two orchestrator instances that both see the same job
  come due would otherwise each create a run and each fire the bindings, i.e.
  ingest the batch twice. The index makes the second insert fail instead.
* `ux_batch_run_ingestions_binding` — one ingestion record per (run, binding).
  This is the local half of trigger idempotency; the remote half is the
  ingestion-service Idempotency-Key built from `batch_key` + binding.

Revision ID: 0005
Revises: 0004
"""

from __future__ import annotations

from alembic import op

revision = "0005"
down_revision = "0004"
branch_labels = None
depends_on = None

_TABLES = ["batch_jobs", "batch_job_runs", "batch_job_run_ingestions"]

# BatchRunStatus.pending=0 / running=1 (app/domain/enums.py) — the states in which
# a run still belongs to its job exclusively.
_ACTIVE = "(0, 1)"


def upgrade() -> None:
    op.execute(
        f"""
        CREATE TABLE batch_jobs (
            id uuid PRIMARY KEY,
            tenant_id uuid NOT NULL,
            workspace_id uuid NOT NULL,
            name text NOT NULL,
            pipeline_template_id uuid NOT NULL REFERENCES pipeline_templates(id),
            pipeline_version_id uuid REFERENCES pipeline_template_versions(id),
            connection_bindings jsonb NOT NULL DEFAULT '[]'::jsonb,
            cron text,
            timezone text NOT NULL DEFAULT 'UTC',
            run_parameters jsonb NOT NULL DEFAULT '{{}}'::jsonb,
            start_at timestamptz,
            end_at timestamptz,
            paused boolean NOT NULL DEFAULT false,
            phase_timeout_seconds int,
            next_fire_at timestamptz,
            last_fire_at timestamptz,
            last_run_id uuid,
            created_by text,
            created_at timestamptz NOT NULL,
            updated_at timestamptz NOT NULL,
            deleted_at timestamptz
        );
        CREATE UNIQUE INDEX ux_batch_jobs_ws_name
            ON batch_jobs (tenant_id, workspace_id, lower(name))
            WHERE deleted_at IS NULL;
        CREATE INDEX ix_batch_jobs_due
            ON batch_jobs (next_fire_at)
            WHERE deleted_at IS NULL AND NOT paused;

        CREATE TABLE batch_job_runs (
            id uuid PRIMARY KEY,
            tenant_id uuid NOT NULL,
            batch_job_id uuid NOT NULL REFERENCES batch_jobs(id),
            pipeline_template_id uuid NOT NULL,
            pipeline_version_id uuid,
            batch_key text NOT NULL,
            phase smallint NOT NULL DEFAULT 0,
            status smallint NOT NULL DEFAULT 0,
            trigger text NOT NULL DEFAULT 'manual',
            input_dataset_urns text[] NOT NULL DEFAULT '{{}}',
            output_dataset_urns text[] NOT NULL DEFAULT '{{}}',
            pipeline_run_id uuid,
            error jsonb,
            phase_deadline_at timestamptz,
            retried_from_run_id uuid,
            submitted_by text,
            via_agent jsonb,
            created_at timestamptz NOT NULL,
            updated_at timestamptz NOT NULL,
            started_at timestamptz,
            finished_at timestamptz,
            lease_owner text,
            lease_expires_at timestamptz
        );
        CREATE UNIQUE INDEX ux_batch_runs_active_job
            ON batch_job_runs (batch_job_id)
            WHERE status IN {_ACTIVE};
        CREATE INDEX ix_batch_runs_job
            ON batch_job_runs (tenant_id, batch_job_id, created_at DESC);
        CREATE INDEX ix_batch_runs_lease
            ON batch_job_runs (lease_expires_at)
            WHERE status IN {_ACTIVE};
        CREATE INDEX ix_batch_runs_deadline
            ON batch_job_runs (phase_deadline_at)
            WHERE status IN {_ACTIVE};

        CREATE TABLE batch_job_run_ingestions (
            id uuid PRIMARY KEY,
            tenant_id uuid NOT NULL,
            batch_job_run_id uuid NOT NULL REFERENCES batch_job_runs(id),
            binding_key text NOT NULL,
            ingestion_id text,
            status text NOT NULL DEFAULT 'triggered',
            dataset_urn text,
            iceberg_snapshot_id text,
            dataset_version_urn text,
            error jsonb,
            created_at timestamptz NOT NULL,
            updated_at timestamptz NOT NULL
        );
        CREATE UNIQUE INDEX ux_batch_run_ingestions_binding
            ON batch_job_run_ingestions (batch_job_run_id, binding_key);
        CREATE INDEX ix_batch_run_ingestions_ingestion
            ON batch_job_run_ingestions (tenant_id, ingestion_id);
        """
    )

    for table in _TABLES:
        op.execute(f"ALTER TABLE {table} ENABLE ROW LEVEL SECURITY;")
        op.execute(f"ALTER TABLE {table} FORCE ROW LEVEL SECURITY;")
        op.execute(
            f"""
            CREATE POLICY tenant_isolation_{table} ON {table}
            USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
            WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
            """
        )
        # SELECT-only for the workers: the due scan, the orphan reaper and the
        # deadline sweep READ across tenants, but every write they cause goes back
        # through a tenant-scoped session so the WITH CHECK above still governs it.
        op.execute(
            f"""
            CREATE POLICY worker_{table} ON {table}
            FOR SELECT
            USING (coalesce(current_setting('app.worker', true), '') = 'true');
            """
        )

    op.execute(
        """
        GRANT SELECT, INSERT, UPDATE, DELETE
            ON batch_jobs, batch_job_runs, batch_job_run_ingestions TO pipeline_app;
        """
    )


def downgrade() -> None:
    raise NotImplementedError("forward-only migrations (MASTER-FR-060)")
