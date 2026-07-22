-- Per-tenant SIEM export destination (BRD 59 WS2). Every row is a proposed
-- configuration STATE, not a mutable single row — mirrors the platform's
-- existing four-eyes proposal pattern (ingestion-service `writebacks`):
-- propose (pending_approval) -> a DISTINCT approver approves or rejects.
-- On approval the newly-approved row becomes `active`; any previously-active
-- row for the same tenant is deactivated in the same transaction, so at most
-- one row per tenant is ever `active=true`, while full history (who proposed,
-- who approved, what changed) stays queryable for audit purposes — the
-- config governing where a tenant's audit events export to is itself
-- security-sensitive and must be reconstructable.
CREATE TABLE tenant_siem_configs (
    id           UUID PRIMARY KEY,
    tenant_id    UUID NOT NULL,
    endpoint     TEXT NOT NULL,
    format       TEXT NOT NULL DEFAULT 'JSON' CHECK (format IN ('CEF', 'LEEF', 'JSON')),
    -- Reference into the tenant's own secrets backend (Vault/AWS/Azure/GCP,
    -- BYO hardening P2) resolved at delivery time -- never the raw auth
    -- value at rest, matching ingestion-service's connection_secret_path
    -- convention. Empty string = unauthenticated endpoint (some SIEM
    -- collectors accept a bare mTLS/allowlisted HTTPS POST).
    auth_ref     TEXT NOT NULL DEFAULT '',
    active       BOOLEAN NOT NULL DEFAULT false,
    status       TEXT NOT NULL DEFAULT 'pending_approval'
                 CHECK (status IN ('pending_approval', 'approved', 'rejected')),
    requested_by TEXT NOT NULL,
    approved_by  TEXT,
    rejected_by  TEXT,
    reject_reason TEXT NOT NULL DEFAULT '',
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX tenant_siem_configs_active_idx ON tenant_siem_configs (tenant_id) WHERE active;
CREATE INDEX tenant_siem_configs_pending_idx ON tenant_siem_configs (tenant_id, created_at DESC) WHERE status = 'pending_approval';

ALTER TABLE tenant_siem_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_siem_configs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenant_siem_configs
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
-- Platform-scoped read for the export delivery path (siemexport.Exporter
-- looks up every tenant's active destination while processing one shared
-- ingest stream, not a single tenant's own request context).
CREATE POLICY platform_access ON tenant_siem_configs
  USING (current_setting('app.role', true) = 'platform')
  WITH CHECK (current_setting('app.role', true) = 'platform');

-- audit_rw needs DELETE here too (unlike the append-only event-metadata
-- tables in 000003): a tenant admin can withdraw/delete a rejected or
-- superseded config row, not just the append-only audit trail itself.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'audit_rw') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON tenant_siem_configs TO audit_rw;
  END IF;
END $$;
