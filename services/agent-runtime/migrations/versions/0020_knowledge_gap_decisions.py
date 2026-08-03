"""Add knowledge_gap_decisions — steward triage state for the WS5
missing-knowledge queue (handled / dismissed).

A gap row IS a decided transcript carrying the missing-knowledge signal; the
transcript corpus is a captured training record and is never mutated by triage.
The steward's disposition of a gap therefore lives in its own tiny table keyed
by transcript_id: "handled" (a governed proposal/creation was opened from it)
or "dismissed" (the steward judged it noise). Re-deciding upserts — triage is a
working state, not an audit record (the WORM audit spine covers the actual
ontology proposals the gap produced).

Tenant-isolated with forced RLS like the transcript corpus it annotates.

Forward-only (MASTER-FR-060).

Revision ID: 0020
"""

from alembic import op

revision = "0020"
down_revision = "0019"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE knowledge_gap_decisions (
            transcript_id uuid PRIMARY KEY,
            tenant_id     uuid NOT NULL,
            status        text NOT NULL CHECK (status IN ('handled', 'dismissed')),
            decided_by    text NOT NULL,
            decided_at    timestamptz NOT NULL DEFAULT now()
        );
        CREATE INDEX ix_gap_decisions_tenant
            ON knowledge_gap_decisions (tenant_id, decided_at DESC);

        GRANT SELECT, INSERT, UPDATE, DELETE ON knowledge_gap_decisions TO agent_runtime_app;

        ALTER TABLE knowledge_gap_decisions ENABLE ROW LEVEL SECURITY;
        ALTER TABLE knowledge_gap_decisions FORCE ROW LEVEL SECURITY;
        CREATE POLICY knowledge_gap_decisions_isolation ON knowledge_gap_decisions
            USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
            WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
        """
    )


def downgrade() -> None:
    raise NotImplementedError("forward-only migrations (MASTER-FR-060)")
