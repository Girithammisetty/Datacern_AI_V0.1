-- case_triggers: tenant-authored event-rule triggers (realtime-decisioning
-- INC-1). Each row is a rule: when an ingestion completes into a matching
-- dataset, fetch the new rows (server-side filter pushdown to dataset-service)
-- and materialize them as cases through the SAME CreateCases path the
-- inference auto-case consumer uses — dedup by (dataset_urn, row_pk) makes
-- replays idempotent. Triggers only CREATE work; they never decide (four-eyes
-- governance on AI proposals is untouched). Tenant-RLS like every other
-- case-service table (000002). Forward-only (MASTER-FR-060).
CREATE TABLE case_triggers (
    id                UUID PRIMARY KEY,
    tenant_id         UUID NOT NULL,
    workspace_id      UUID NOT NULL,
    name              TEXT NOT NULL,
    enabled           BOOLEAN NOT NULL DEFAULT true,
    -- Source match: exact dataset URN or (for new_dataset ingestions) the
    -- target dataset name from the ingestion.completed payload. At least one
    -- is required (enforced in domain validation).
    dataset_urn       TEXT NOT NULL DEFAULT '',
    dataset_name      TEXT NOT NULL DEFAULT '',
    -- Row filter conditions, pushed down to dataset-service browse_rows as
    -- filter=<col>:<op>:<value> (op ∈ eq|neq|contains|gt|gte|lt|lte).
    conditions        JSONB NOT NULL DEFAULT '[]' CHECK (pg_column_size(conditions) <= 8192),
    -- Row column whose value becomes the case row_pk (dedup identity). Empty =
    -- first column of the dataset.
    row_pk_field      TEXT NOT NULL DEFAULT '',
    severity          TEXT NOT NULL DEFAULT 'medium',
    due_hours         INT  NOT NULL DEFAULT 72 CHECK (due_hours BETWEEN 1 AND 2160),
    -- Row columns copied into the case display_projection (worklist title
    -- derivation); empty = all columns (subject to TruncateProjection caps).
    projection_fields JSONB NOT NULL DEFAULT '[]' CHECK (pg_column_size(projection_fields) <= 4096),
    max_cases_per_event INT NOT NULL DEFAULT 100 CHECK (max_cases_per_event BETWEEN 1 AND 500),
    created_by        TEXT NOT NULL DEFAULT '',
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, workspace_id, name)
);

CREATE INDEX case_triggers_tenant_enabled ON case_triggers (tenant_id, enabled);

ALTER TABLE case_triggers ENABLE ROW LEVEL SECURITY;
ALTER TABLE case_triggers FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON case_triggers
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- 000003's ALTER DEFAULT PRIVILEGES covers new tables, but grant explicitly for
-- environments migrated before the default was in place (mirrors 000004).
DO $$ BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'case_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON case_triggers TO case_app;
  END IF;
END $$;
