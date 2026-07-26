DROP TABLE IF EXISTS commercial_dirty;
DROP TABLE IF EXISTS tenant_entitlement_overrides;
DROP TABLE IF EXISTS tenant_plan;
DROP INDEX IF EXISTS tenants_trial_sweep_idx;
ALTER TABLE tenants
    DROP COLUMN IF EXISTS commercial_state,
    DROP COLUMN IF EXISTS trial_started_at,
    DROP COLUMN IF EXISTS trial_ends_at;
