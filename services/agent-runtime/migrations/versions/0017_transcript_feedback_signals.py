"""Add agent_transcripts.feedback — the four first-class human-correction signals
(Agent-in-the-Loop, EMNLP 2025 Industry Track): (1) adoption/rejection WITH
rationale, (2) pairwise preference (the agent's proposed output vs the human's
corrected one), (3) knowledge-relevance validation, and (4) missing-knowledge
identification. Captured as structured retraining inputs so the
correction->retrain flywheel is richer than a bare accept/reject label.

Forward-only (MASTER-FR-060).

Revision ID: 0017
"""

from alembic import op

revision = "0017"
down_revision = "0016"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("ALTER TABLE agent_transcripts ADD COLUMN IF NOT EXISTS feedback jsonb")


def downgrade() -> None:  # forward-only
    pass
