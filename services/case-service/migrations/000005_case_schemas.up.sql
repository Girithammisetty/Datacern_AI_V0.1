-- case_schemas: typed case SCHEMAS keyed by a named case TYPE (pack-service
-- inc10). Each row is a governed case type (duplicate_review,
-- banking_change_verification, shell_vendor_investigation, ...) that binds a
-- DISTINCT field set — the per-type schema keying the flat case_fields catalog
-- (CASE-FR-022) cannot express. `fields` is the embedded field-definition array
-- (name/data_type/label/required), self-contained per type. Tenant-RLS like
-- every other case-service table (000002). Forward-only (MASTER-FR-060).
CREATE TABLE case_schemas (
    id           UUID PRIMARY KEY,
    tenant_id    UUID NOT NULL,
    workspace_id UUID NOT NULL,
    schema_key   TEXT NOT NULL,
    name         TEXT NOT NULL,
    description  TEXT NOT NULL DEFAULT '',
    fields       JSONB NOT NULL DEFAULT '[]' CHECK (pg_column_size(fields) <= 32768),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at   TIMESTAMPTZ,
    UNIQUE (tenant_id, workspace_id, schema_key)
);

ALTER TABLE case_schemas ENABLE ROW LEVEL SECURITY;
ALTER TABLE case_schemas FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON case_schemas
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
