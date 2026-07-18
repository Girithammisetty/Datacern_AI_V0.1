"""Add tenant_agent_configs.guardrail_policy — the per-agent security envelope
(BRD 53 inc2, PA-FR-001): ``{data_scope, budget, pii}`` for a tenant custom
agent. Kept separate from ``prompt_params`` (LLM config channel) and
``auto_execute_policy`` (autonomy) because it is a machine-enforced SECURITY
boundary, not prompt or autonomy config: data-scope constrains grounding reads
(PA-FR-040), budget caps per-run tokens, pii governs egress redaction. Enforced
in the persona_copilot graph, independent of the prompt.

Forward-only (MASTER-FR-060).

Revision ID: 0014
"""

from alembic import op

revision = "0014"
down_revision = "0013"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        "ALTER TABLE tenant_agent_configs "
        "ADD COLUMN IF NOT EXISTS guardrail_policy jsonb NOT NULL DEFAULT '{}';"
    )
