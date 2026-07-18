"""Decision-model lifecycle governance (BRD 54 inc3) — four-eyes approval +
versioning for the decision LOGIC itself.

A decision table no longer goes live on create: it lands ``draft``, and a
DIFFERENT user must approve it to ``published`` (four-eyes on the logic, not just
on the decisions it produces). Editing a published table creates a new ``draft``
version; approving it archives the prior published version of the same name — so
what runs is always the one that was approved (Leapter "what you approve is what
runs"). Adds ``approved_by``/``approved_at`` and the ``archived`` status.

Revision ID: 0013
"""

from alembic import op

revision = "0013"
down_revision = "0012"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("ALTER TABLE decision_models "
               "ADD COLUMN IF NOT EXISTS approved_by text;")
    op.execute("ALTER TABLE decision_models "
               "ADD COLUMN IF NOT EXISTS approved_at timestamptz;")
    # widen the status CHECK to include 'archived' (a superseded published version)
    op.execute("ALTER TABLE decision_models "
               "DROP CONSTRAINT IF EXISTS decision_models_status_check;")
    op.execute("ALTER TABLE decision_models ADD CONSTRAINT decision_models_status_check "
               "CHECK (status IN ('draft','published','archived'));")
