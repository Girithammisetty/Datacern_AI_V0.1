"""Add platform_agent_ceilings — the operator-set ceilings that clamp EVERY
tenant custom agent's guardrail envelope (BRD 53 inc3, BR-8: no tenant setting
can raise autonomy/budget/tier above the operator maximum). Single-row (id=true)
platform config, operator-only; author-time validation reads it instead of a
hard-coded constant so operators can tighten the platform without a redeploy.

Forward-only (MASTER-FR-060).

Revision ID: 0015
"""

from alembic import op

revision = "0015"
down_revision = "0014"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS platform_agent_ceilings (
            id boolean PRIMARY KEY DEFAULT true CHECK (id),
            max_budget_tokens int NOT NULL DEFAULT 200000,
            max_tier text NOT NULL DEFAULT 'write-proposal',
            updated_at timestamptz NOT NULL DEFAULT now(),
            updated_by text
        );
        INSERT INTO platform_agent_ceilings (id) VALUES (true)
            ON CONFLICT (id) DO NOTHING;
        """
    )
