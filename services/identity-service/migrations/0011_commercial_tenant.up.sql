-- Commercial plane, slice 1 (BRD 66), continued: per-tenant commercial state,
-- plan assignment, and entitlement overrides.

-- CPL-FR-020: commercial_state is a SECOND, independent state machine from
-- tenants.status (guarded by domain.CanTransitionCommercial, mirroring
-- domain.CanTransition) -- it is never threaded into the provisioning
-- lifecycle. Columns live directly on `tenants` (platform-scoped, RLS-exempt,
-- same table Tier/Cloud/Status already live on) rather than a joined table:
-- see docs/initiatives/commercial-plane.md "Data model" for the rejected
-- alternative and rationale (avoids a mandatory join on the hottest tenant
-- read path for three small scalars).
ALTER TABLE tenants
    ADD COLUMN commercial_state text NOT NULL DEFAULT 'none'
        CHECK (commercial_state IN ('none','trial','active','suspended_commercial','churned')),
    ADD COLUMN trial_started_at timestamptz,
    ADD COLUMN trial_ends_at    timestamptz;

-- Supports the slice-2 sweep's `WHERE commercial_state='trial' AND
-- trial_ends_at<=now()` query; harmless to add now.
CREATE INDEX tenants_trial_sweep_idx ON tenants (commercial_state, trial_ends_at)
    WHERE commercial_state = 'trial';

-- Tenant -> plan assignment (CPL-FR-002): one active row per tenant, snapshots
-- the plan version at attach time so a later PATCH to the plan's defaults
-- never mutates an existing assignment. Tenant-scoped, RLS (MASTER-FR-001).
CREATE TABLE tenant_plan (
    tenant_id             uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
    plan_key              text NOT NULL REFERENCES plans(key),
    plan_version_snapshot integer NOT NULL,
    assigned_at           timestamptz NOT NULL DEFAULT now(),
    assigned_by           text NOT NULL DEFAULT ''
);

-- Per-tenant entitlement overrides (CPL-FR-010): the effective set resolves
-- as plan defaults at plan_version_snapshot, with an override winning by
-- (kind, entitlement_key) when present -- and an override may also be purely
-- additive (a key the plan doesn't define at all). Tenant-scoped, RLS.
CREATE TABLE tenant_entitlement_overrides (
    id              uuid PRIMARY KEY,
    tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    kind            text NOT NULL CHECK (kind IN ('pack_sku','meter_allowance','seat_cap','workspace_cap','feature')),
    entitlement_key text NOT NULL,
    value_json      jsonb NOT NULL DEFAULT '{}' CHECK (pg_column_size(value_json) <= 65536),
    granted_by      text NOT NULL DEFAULT '',
    granted_at      timestamptz NOT NULL DEFAULT now(),
    reason          text NOT NULL DEFAULT '',
    UNIQUE (tenant_id, kind, entitlement_key)
);

-- entitlements_flat (ent:{tenant}:flat) recompute queue -- mirrors
-- rbac-service's projection_dirty (services/rbac-service/migrations/
-- 000001_init.up.sql): every mutation to tenant_plan,
-- tenant_entitlement_overrides, or the tenants commercial columns enqueues a
-- row in the SAME transaction as the write; the projection worker claims
-- batches with SKIP LOCKED (visibility-timeout at-least-once) and deletes
-- them after a successful Redis write. Tenant-scoped, RLS, but also readable/
-- claimable by the worker under app.role=platform (WithWorker-equivalent,
-- see postgres.platformTx).
CREATE TABLE commercial_dirty (
    id          bigserial PRIMARY KEY,
    tenant_id   uuid NOT NULL,
    enqueued_at timestamptz NOT NULL DEFAULT now(),
    claimed_at  timestamptz,
    claimed_by  text
);
CREATE INDEX commercial_dirty_claim_idx ON commercial_dirty (claimed_at NULLS FIRST, id);

-- RLS (MASTER-FR-001): same tenant_isolation policy shape as 0002_rls.up.sql.
ALTER TABLE tenant_plan ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_plan FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenant_plan
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE tenant_entitlement_overrides ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_entitlement_overrides FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenant_entitlement_overrides
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE commercial_dirty ENABLE ROW LEVEL SECURITY;
ALTER TABLE commercial_dirty FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON commercial_dirty
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (true);
CREATE POLICY commercial_dirty_platform ON commercial_dirty
    USING (current_setting('app.role', true) = 'platform')
    WITH CHECK (current_setting('app.role', true) = 'platform');

-- Explicit grant, not left to ALTER DEFAULT PRIVILEGES (0003_app_role.up.sql):
-- these are the first new tables created after 0003 ran, and default
-- privileges only apply to objects subsequently created *by the same role*
-- that executed the ALTER DEFAULT PRIVILEGES statement -- a property this
-- migration file cannot itself guarantee holds for every migration runner
-- (e.g. a CI harness that reconnects as a different role between files).
-- rbac-service's equivalent dirty-queue table (projection_dirty) never hit
-- this gap because it was created in that service's very first migration,
-- before its app-role grant ever ran, so the bulk "ALL SEQUENCES" grant in
-- that later migration already covered it. commercial_dirty is the first
-- BIGSERIAL table in this service created *after* 0003, which is exactly the
-- case ALTER DEFAULT PRIVILEGES's role-scoping can silently miss -- confirmed
-- live: CI failed with "permission denied for sequence
-- commercial_dirty_id_seq" (nextval() requires USAGE) on the bulk grant path
-- alone. Sequences need USAGE explicitly; GRANT on a table never implies it.
GRANT SELECT, INSERT, UPDATE, DELETE ON tenant_plan, tenant_entitlement_overrides, commercial_dirty TO identity_app;
GRANT USAGE, SELECT ON SEQUENCE commercial_dirty_id_seq TO identity_app;
