-- Commercial plane, slice 1 (BRD 66): platform-defined plan catalog.
-- Platform-scoped (no RLS) -- mirrors tenants/cells/signing_keys: the catalog
-- is owned by platform operators (CPL-FR-001), not by any tenant, and CRUD is
-- gated to requireSuperAdmin (see internal/api/middleware.go), matching the
-- existing /platform/admins precedent rather than inventing a new RBAC action
-- (docs/initiatives/commercial-plane.md "Options considered and rejected").
CREATE TABLE plans (
    key                text PRIMARY KEY,
    name                text NOT NULL,
    description         text NOT NULL DEFAULT '',
    trial_days_default  integer,
    status              text NOT NULL CHECK (status IN ('active','deprecated')) DEFAULT 'active',
    version             integer NOT NULL DEFAULT 1 CHECK (version >= 1),
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now()
);

-- Versioned plan defaults (CPL-FR-002): plan_version pins which plans.version
-- these rows describe. Updating a plan's defaults (PATCH /platform/plans/{key})
-- bumps plans.version and inserts a NEW set of rows at the new version --
-- existing rows at prior versions are never mutated, so a tenant_plan row
-- pinned to an old plan_version_snapshot can still resolve its original
-- defaults for audit (docs/initiatives/commercial-plane.md "Data model").
CREATE TABLE plan_entitlements (
    id              uuid PRIMARY KEY,
    plan_key        text NOT NULL REFERENCES plans(key),
    plan_version    integer NOT NULL,
    kind            text NOT NULL CHECK (kind IN ('pack_sku','meter_allowance','seat_cap','workspace_cap','feature')),
    entitlement_key text NOT NULL,
    -- <=64KB per MASTER-FR-061 (small-document guard applied elsewhere in
    -- this service, e.g. tenants.quotas <=4KB, 0001_init.up.sql).
    value_json      jsonb NOT NULL DEFAULT '{}' CHECK (pg_column_size(value_json) <= 65536),
    created_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (plan_key, plan_version, kind, entitlement_key)
);
CREATE INDEX plan_entitlements_plan_idx ON plan_entitlements (plan_key, plan_version);

-- Seed the four plans (CPL-FR-001, US-1) with a starter set of default
-- entitlements so the effective-set resolution (CPL-FR-010) has something
-- concrete to resolve out of the box. Packs/features/meter allowances are
-- catalog-specific and left for operators to add via PATCH; seat/workspace
-- caps are seeded here as reasonable per-plan starting points.
INSERT INTO plans (key, name, description, trial_days_default, status, version) VALUES
    ('internal-demo',  'Internal Demo',  'Datacern-internal demo and sandbox tenants.',            NULL, 'active', 1),
    ('design-partner', 'Design Partner', 'Early design-partner tenants co-building the product.',  NULL, 'active', 1),
    ('pilot',          'Pilot',          'Time-boxed proof-of-concept tenants.',                     60, 'active', 1),
    ('enterprise',     'Enterprise',     'Contracted enterprise tenants.',                          NULL, 'active', 1);

INSERT INTO plan_entitlements (id, plan_key, plan_version, kind, entitlement_key, value_json) VALUES
    (gen_random_uuid(), 'internal-demo',  1, 'seat_cap',      'seats',      '{"n": 10}'),
    (gen_random_uuid(), 'internal-demo',  1, 'workspace_cap', 'workspaces', '{"n": 5}'),
    (gen_random_uuid(), 'design-partner', 1, 'seat_cap',      'seats',      '{"n": 25}'),
    (gen_random_uuid(), 'design-partner', 1, 'workspace_cap', 'workspaces', '{"n": 10}'),
    (gen_random_uuid(), 'pilot',          1, 'seat_cap',      'seats',      '{"n": 15}'),
    (gen_random_uuid(), 'pilot',          1, 'workspace_cap', 'workspaces', '{"n": 5}'),
    (gen_random_uuid(), 'enterprise',     1, 'seat_cap',      'seats',      '{"n": 200}'),
    (gen_random_uuid(), 'enterprise',     1, 'workspace_cap', 'workspaces', '{"n": 50}');
