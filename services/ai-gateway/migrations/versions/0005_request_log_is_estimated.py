"""Add request_log.is_estimated (AIG-FR-060 metering honesty).

Token accounting normally reflects the provider's own measured `usage` block;
when a provider omits usable usage data the gateway falls back to
`estimate_tokens` (a char-count heuristic) so the request is still metered.
Until now that fallback was written into the same input_tokens/output_tokens
columns with no marker, so a measured figure and a guessed one were
indistinguishable downstream (billing, usage-service's chargeback
reconciliation). This column threads the distinction through — the same field
is added to `ai_token_usage.avsc` (the ai.token_usage.v1 outbox payload) so it
survives the event boundary too.

Forward-only (MASTER-FR-060).

Revision ID: 0005
Revises: 0004
"""

from alembic import op

revision = "0005"
down_revision = "0004"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        ALTER TABLE request_log
            ADD COLUMN is_estimated boolean NOT NULL DEFAULT false;
        """
    )


def downgrade() -> None:
    raise NotImplementedError("forward-only migrations (MASTER-FR-060)")
