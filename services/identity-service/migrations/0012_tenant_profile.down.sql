DROP INDEX IF EXISTS tenants_demo_profile_idx;
ALTER TABLE tenants
    DROP COLUMN IF EXISTS profile,
    DROP COLUMN IF EXISTS demo_pack,
    DROP COLUMN IF EXISTS ttl_days;
