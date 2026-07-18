"""Add retrain_watches — the scheduled, drift-driven retrain loop (BRD 52 inc2/
Phase 3 / WS3). Each row is a standing watch on a deployed model: on its cadence
the scheduler computes a drift signal (human corrections to the watched agent's
proposals in a window) and, when it crosses the threshold, invokes the governance
agent autonomously — which opens a four-eyes ``mlops.open_retrain`` PROPOSAL a
human still approves. No autonomous retrain; the loop only proposes.

Tenant-filtered at the query layer (no RLS) — the same pattern as decision_models
— because the scheduler must read DUE watches ACROSS tenants (the app role is
non-superuser, so an RLS table can't be read platform-wide). Every tenant-facing
query filters ``tenant_id`` explicitly; only the scheduler's due-scan is unscoped.

Forward-only (MASTER-FR-060).

Revision ID: 0016
"""

from alembic import op

revision = "0016"
down_revision = "0015"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE retrain_watches (
            id uuid PRIMARY KEY,
            tenant_id uuid NOT NULL,
            model_urn text NOT NULL,
            workspace_id uuid,
            watched_agent_key text NOT NULL,
            cadence_seconds int NOT NULL DEFAULT 86400,
            correction_window_hours int NOT NULL DEFAULT 168,
            drift_threshold double precision NOT NULL DEFAULT 0.3,
            min_corrections int NOT NULL DEFAULT 20,
            enabled boolean NOT NULL DEFAULT true,
            last_checked_at timestamptz,
            last_signal jsonb NOT NULL DEFAULT '{}',
            created_by text,
            created_at timestamptz NOT NULL DEFAULT now(),
            updated_at timestamptz NOT NULL DEFAULT now()
        );
        CREATE INDEX retrain_watches_tenant ON retrain_watches (tenant_id);
        CREATE INDEX retrain_watches_due ON retrain_watches (enabled, last_checked_at);
        """
    )
