-- BRD 69 slice 3: value-report.v1 export listing (ROI-FR-021, design §2.8).
-- Not WORM/Object-Lock (unlike audit-service's exports) — a periodic
-- business export a tenant admin can regenerate, not a compliance record.
-- Immutability is by convention: re-exporting a period inserts version N+1;
-- version N's row and object-store keys are never touched.
CREATE TABLE value_exports (
    id                  UUID PRIMARY KEY,
    tenant_id           UUID NOT NULL,
    period              TEXT NOT NULL, -- YYYY-MM
    workspace_id        TEXT NOT NULL DEFAULT '', -- '' = tenant-wide export
    version             INT NOT NULL,
    json_key            TEXT NOT NULL,
    json_sha256         TEXT NOT NULL,
    csv_key             TEXT NOT NULL,
    csv_sha256          TEXT NOT NULL,
    assumption_version  INT,
    generated_by        TEXT NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, period, workspace_id, version)
);
CREATE INDEX value_exports_tenant_period_idx ON value_exports (tenant_id, period, created_at DESC);

ALTER TABLE value_exports ENABLE ROW LEVEL SECURITY;
ALTER TABLE value_exports FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON value_exports
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
         OR current_setting('app.role', true) = 'platform')
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
         OR current_setting('app.role', true) = 'platform');
