"""Add proposals.rationale_source: distinguishes a real LLM-generated
rationale from a canned fallback substituted when the LLM call failed.

Bug found in a production-readiness audit: inference_agent.py's ``check``
node falls back to a templated sentence when ``deps.llm.chat`` raises/returns
empty, and returns it in the exact same shape as a real LLM rationale — the
human approver reviewing the proposal has no way to tell them apart. This
column (mirrored on WriteIntent/Proposal as ``rationale_source``) makes the
provenance explicit: "llm" (default, real model call) or "fallback_template".

Forward-only (MASTER-FR-060).

Revision ID: 0019
"""

from alembic import op

revision = "0019"
down_revision = "0018"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        "ALTER TABLE proposals ADD COLUMN IF NOT EXISTS rationale_source text "
        "NOT NULL DEFAULT 'llm';"
    )
