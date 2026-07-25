-- BRD 70 (Demo Sandbox & POC Mode) slice 1: Tenant.Profile (DSP-FR-001).
-- Profile is a THIRD, independent axis from status (provisioning lifecycle,
-- 0001_init) and commercial_state (BRD 66 paying/trial relationship,
-- 0011_commercial_tenant) -- see docs/initiatives/demo-sandbox-poc-mode.md
-- §2.1 "Options weighed" for why this stays its own column rather than
-- folding into either existing state machine. Set once at CreateTenant time;
-- NEVER present in UpdateTenant's SET list (domain/tenant_service.go) --
-- immutability by absence from the mutable surface, mirroring how `id`/
-- `created_by` are already handled.
ALTER TABLE tenants
    ADD COLUMN profile   text NOT NULL DEFAULT 'standard'
        CHECK (profile IN ('standard','demo','poc')),
    -- demo_pack names the deploy/demo/<pack>/ bundle a profile=demo tenant
    -- was seeded from (empty for standard/poc); ttl_days is the TTL reaper's
    -- countdown from created_at (DSP-FR-013) -- null for non-demo tenants,
    -- who are never TTL-reaped.
    ADD COLUMN demo_pack text NOT NULL DEFAULT '',
    ADD COLUMN ttl_days  integer;

-- Supports the TTL reaper's sweep query (§2.5): WHERE profile='demo' AND
-- status<>'deleted' ORDER BY created_at.
CREATE INDEX tenants_demo_profile_idx ON tenants (profile, created_at) WHERE profile = 'demo';
