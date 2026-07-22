"""B7 (BRD 58): cross-tenant worker policy for processed_events, mirroring
0001's `worker_outbox` policy on `outbox` (same rationale as
dataset-service's identical 0005 migration).

Revision ID: 0003
Revises: 0002
"""

from __future__ import annotations

from alembic import op

revision = "0003"
down_revision = "0002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        CREATE POLICY worker_processed_events ON processed_events
        USING (coalesce(current_setting('app.worker', true), '') = 'true');
        """
    )


def downgrade() -> None:
    raise NotImplementedError("forward-only migrations (MASTER-FR-060)")
