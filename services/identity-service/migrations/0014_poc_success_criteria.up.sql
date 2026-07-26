-- POC mode (BRD 70 slice 3, DSP-FR-020..022, design doc §2.9). Tenant-scoped,
-- RLS -- both tables mirror trial_events' (0013) RLS shape: a plain tenant-
-- isolation policy plus a platform-bypass policy, since a future operator
-- read (e.g. an admin dashboard listing every POC's criteria) needs the same
-- cross-tenant escape hatch trial_events already has.

-- poc_success_criteria: one row per declared SuccessCriterion (design §2.9's
-- "{key, description, metric_ref, target, direction}", verbatim columns).
-- SetPocSuccessCriteria replaces the full set (delete-then-insert in one
-- transaction); UpdatePocCriterionManualValue updates ONE row's
-- manual_value in place without touching the rest of the set.
CREATE TABLE poc_success_criteria (
    id           uuid PRIMARY KEY,
    tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    key          text NOT NULL,
    description  text NOT NULL,
    metric_ref   text NOT NULL CHECK (metric_ref IN
        ('decisions_total','hours_saved_est_hours','net_value_est_usd','adoption_active_users','manual')),
    target       double precision NOT NULL,
    direction    text NOT NULL CHECK (direction IN ('gte','lte')),
    manual_value double precision, -- only meaningful when metric_ref='manual'; NULL = "not yet reported"
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, key)
);
CREATE INDEX poc_success_criteria_tenant_idx ON poc_success_criteria (tenant_id);

ALTER TABLE poc_success_criteria ENABLE ROW LEVEL SECURITY;
ALTER TABLE poc_success_criteria FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON poc_success_criteria
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY poc_success_criteria_platform ON poc_success_criteria
    USING (current_setting('app.role', true) = 'platform')
    WITH CHECK (current_setting('app.role', true) = 'platform');

-- poc_exports: one row per poc-report.v1 generation (DSP-FR-022, design
-- §2.9's "stored/checksummed like other audited exports"), mirroring
-- usage-service's value_exports table shape (internal/store/value_exports.go)
-- -- the one proven precedent in this codebase for exactly this requirement.
-- Only a JSON artifact ships here (no CSV) -- poc-report.v1's schema (design
-- §2.9) is a single JSON document, unlike value-report.v1 which explicitly
-- asks for both.
CREATE TABLE poc_exports (
    id           uuid PRIMARY KEY,
    tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    version      integer NOT NULL,
    json_key     text NOT NULL,
    json_sha256  text NOT NULL,
    generated_by text NOT NULL,
    created_at   timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, version)
);
CREATE INDEX poc_exports_tenant_idx ON poc_exports (tenant_id, created_at DESC);

ALTER TABLE poc_exports ENABLE ROW LEVEL SECURITY;
ALTER TABLE poc_exports FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON poc_exports
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY poc_exports_platform ON poc_exports
    USING (current_setting('app.role', true) = 'platform')
    WITH CHECK (current_setting('app.role', true) = 'platform');
