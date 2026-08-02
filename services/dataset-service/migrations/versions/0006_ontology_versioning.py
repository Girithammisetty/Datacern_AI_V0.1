"""WS3 — govern the ontology like semantic models (versioning + four-eyes update).

The domain ontology (0004) was CRUD-only: changing an entity type was
delete+recreate, with no version history and no four-eyes review — the
governance asymmetry vs the semantic layer (which has draft→published→superseded
+ author≠approver). This adds:

  * ``ontology_entities.version_no`` — the currently-published version the live
    row mirrors (backfilled to 1 for existing types).
  * ``ontology_entity_versions`` — every revision + the review queue: a proposed
    update lands ``in_review``; a distinct approver publishes it (superseding the
    prior published version); each revision keeps its definition + a machine diff.

Existing types are backfilled with a v1 ``published`` version row so their
history is complete from day one. Tenant-RLS like every other table
(0001/0002); dataset_app already holds DML via 0002 default privileges.
Forward-only (MASTER-FR-060).

Revision ID: 0006
"""

from alembic import op

revision = "0006"
down_revision = "0005"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        "ALTER TABLE ontology_entities "
        "ADD COLUMN IF NOT EXISTS version_no integer NOT NULL DEFAULT 1;"
    )
    op.execute(
        """
        CREATE TABLE ontology_entity_versions (
            id uuid PRIMARY KEY,
            tenant_id uuid NOT NULL,
            workspace_id uuid NOT NULL,
            entity_key text NOT NULL,
            version_no integer NOT NULL,
            status text NOT NULL,
            name text NOT NULL,
            description text NOT NULL DEFAULT '',
            attributes jsonb NOT NULL DEFAULT '[]'::jsonb,
            relationships jsonb NOT NULL DEFAULT '[]'::jsonb,
            diff jsonb,
            submitted_by text NOT NULL,
            approved_by text,
            decision_note text,
            created_at timestamptz NOT NULL,
            decided_at timestamptz,
            CONSTRAINT ux_ontology_version UNIQUE (tenant_id, workspace_id, entity_key, version_no)
        );
        CREATE INDEX ix_ontology_version_key
            ON ontology_entity_versions (tenant_id, workspace_id, entity_key);
        """
    )
    op.execute("ALTER TABLE ontology_entity_versions ENABLE ROW LEVEL SECURITY;")
    op.execute("ALTER TABLE ontology_entity_versions FORCE ROW LEVEL SECURITY;")
    op.execute(
        """
        CREATE POLICY tenant_isolation_ontology_entity_versions ON ontology_entity_versions
            USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
            WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
        """
    )
    # Backfill: every existing type gets a v1 published version so its history is
    # complete (the creator is recorded as both submitter and approver — the
    # bootstrap revision, not a reviewed change).
    op.execute(
        """
        INSERT INTO ontology_entity_versions
            (id, tenant_id, workspace_id, entity_key, version_no, status, name,
             description, attributes, relationships, diff, submitted_by,
             approved_by, decision_note, created_at, decided_at)
        SELECT gen_random_uuid(), tenant_id, workspace_id, entity_key,
               COALESCE(version_no, 1), 'published', name, description,
               attributes, relationships, NULL, created_by, created_by,
               'bootstrap (pre-versioning)', created_at, created_at
        FROM ontology_entities;
        """
    )


def downgrade() -> None:
    raise NotImplementedError("forward-only migrations (MASTER-FR-060)")
