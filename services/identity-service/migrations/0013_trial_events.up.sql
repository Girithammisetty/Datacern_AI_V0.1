-- Commercial plane, slice 2 (BRD 66): trial lifecycle audit trail
-- (CPL-FR-020..023, design doc §2 "trial_events"). Tenant-scoped, RLS.
--
-- Row volume is one entry per trial lifecycle transition per tenant (started/
-- extended/converted/expired/ending_t14/t7/t1) -- nowhere near usage-service's
-- high-cardinality metering stream, so this is NOT partitioned by month
-- despite the design doc noting MASTER-FR-062 applies in principle; deferred
-- as a follow-up if trial volume ever warrants it (documented, not silent).
CREATE TABLE trial_events (
    id          uuid PRIMARY KEY,
    tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    event_type  text NOT NULL CHECK (event_type IN
        ('started','extended','expired','converted','ending_t14','ending_t7','ending_t1')),
    trial_days  integer NOT NULL DEFAULT 0,
    reason      text NOT NULL DEFAULT '',
    actor       text NOT NULL DEFAULT '',
    occurred_at timestamptz NOT NULL DEFAULT now()
);
-- US-4: a tenant's trial history, newest first.
CREATE INDEX trial_events_tenant_idx ON trial_events (tenant_id, occurred_at DESC);
-- CPL-FR-023 dedup: "no trial_events row of type ending_tN already exists for
-- this tenant" -- the sweep's threshold-event query filters candidates on
-- exactly this (tenant_id, event_type) pair.
CREATE INDEX trial_events_dedup_idx ON trial_events (tenant_id, event_type);

-- RLS: same dual-policy shape as commercial_dirty (0011_commercial_tenant) --
-- normal app writes/reads are tenant-isolated; the leader-elected trial sweep
-- (CPL-FR-022/023) additionally needs a single cross-tenant dedup read
-- ("which of these candidate tenants already has an ending_t14 row") under
-- app.role=platform, exactly like ClaimCommercialDirty's worker read.
ALTER TABLE trial_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE trial_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON trial_events
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY trial_events_platform ON trial_events
    USING (current_setting('app.role', true) = 'platform')
    WITH CHECK (current_setting('app.role', true) = 'platform');
