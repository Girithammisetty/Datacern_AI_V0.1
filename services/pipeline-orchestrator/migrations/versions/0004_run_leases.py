"""Run leases, so an evicted orchestrator pod does not strand its runs.

A run was driven by an ``asyncio.Task`` inside whichever orchestrator process
happened to accept the request, with nothing on the row recording that fact. If
that process went away mid-run -- which under horizontal autoscaling is not an
incident but the normal way capacity is returned -- the task died with it and the
run stayed in `running` forever: never terminal, never retried, and still
counting against the tenant's max_concurrent_runs. That single property is what
stopped the compute plane from being safe to scale on demand.

A run is now only ever driven by the holder of an unexpired lease. Losing the pod
means simply failing to heartbeat, and the reaper recovers the run: re-attaching
to the Argo workflow that is still running in Kubernetes, or failing a local run
whose in-process work genuinely died with the pod.

`ix_runs_lease` is partial on the two non-terminal states because that is the
only thing the reaper ever scans for, and it must stay cheap as the runs table
grows -- it runs every few seconds forever.

The reaper scans across ALL tenants with no tenant context, so `pipeline_runs`
needs the permissive worker policy that `outbox` (0001) and `processed_events`
(0003) already carry: under FORCE ROW LEVEL SECURITY the tenant_isolation policy
alone matches zero rows for a session with no app.tenant_id, which is a silent
no-op rather than an error -- the reaper would simply never find anything and the
whole mechanism would look like it worked.

Revision ID: 0004
Revises: 0003
"""

from __future__ import annotations

from alembic import op

revision = "0004"
down_revision = "0003"
branch_labels = None
depends_on = None

# RunStatus.submitted=2 / running=3 (app/domain/enums.py) are the only states a
# run can be stranded in: pending=0 was never submitted and quota_queued=1 sits in
# run_queue, neither of which is being driven by anyone.
_DRIVABLE = "(2, 3)"


def upgrade() -> None:
    op.execute(
        f"""
        ALTER TABLE pipeline_runs
            ADD COLUMN lease_owner text,
            ADD COLUMN lease_expires_at timestamptz;

        CREATE INDEX ix_runs_lease ON pipeline_runs (lease_expires_at)
            WHERE status IN {_DRIVABLE};

        CREATE POLICY worker_pipeline_runs ON pipeline_runs
        USING (coalesce(current_setting('app.worker', true), '') = 'true');
        """
    )


def downgrade() -> None:
    raise NotImplementedError("forward-only migrations (MASTER-FR-060)")
