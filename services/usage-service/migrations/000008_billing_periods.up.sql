-- BRD 67 slice 3 (value-metering-billing-export design §2.6): a tenant's
-- closed billing month and its exported artifacts. Not WORM/Object-Lock (unlike
-- audit-service's compliance exports) — a business record a close job produces
-- monthly. Immutability is by convention, matching value_exports (000006): a
-- correction inserts version N+1; version N's row and object-store keys are
-- never touched (UPDATE is limited to status / pushed_* columns).

CREATE TABLE billing_periods (
    id                 UUID PRIMARY KEY,
    tenant_id          UUID NOT NULL,
    period             TEXT NOT NULL,               -- YYYY-MM
    version            INT NOT NULL DEFAULT 1,       -- corrections bump; never update numbers in place
    rate_card_id       UUID NOT NULL,
    rate_card_version  INT NOT NULL,
    meter_totals       JSONB NOT NULL,               -- {meter_key: {quantity, gross_usd}}, bounded (<20 meters)
    allowance_drawdown JSONB NOT NULL DEFAULT '{}',  -- {meter_key: {included_qty, drawn, overage_qty}}
    gross_usd          NUMERIC(14,2) NOT NULL,
    net_billable_usd   NUMERIC(14,2) NOT NULL,
    status             TEXT NOT NULL DEFAULT 'closed', -- closed|exported|export_failed
    closed_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    closed_by          TEXT NOT NULL DEFAULT 'system', -- close-job leader identity, audited
    UNIQUE (tenant_id, period, version)
);
CREATE INDEX billing_periods_tenant_idx ON billing_periods (tenant_id, period DESC, version DESC);

CREATE TABLE billing_exports (
    id                UUID PRIMARY KEY,
    billing_period_id UUID NOT NULL REFERENCES billing_periods(id),
    tenant_id         UUID NOT NULL,
    period            TEXT NOT NULL,
    version           INT NOT NULL,
    jsonl_key         TEXT NOT NULL,     -- billing/<tenant>/<period>/<version>/meters.jsonl
    jsonl_sha256      TEXT NOT NULL,
    csv_key           TEXT NOT NULL,     -- billing/<tenant>/<period>/<version>/summary.csv
    csv_sha256        TEXT NOT NULL,
    pushed_status     TEXT,              -- null|pushed|billing_push_not_configured|push_failed
    pushed_reference  TEXT,              -- provider-side reference when pushed
    pushed_at         TIMESTAMPTZ,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, period, version)
);
CREATE INDEX billing_exports_tenant_idx ON billing_exports (tenant_id, period DESC, version DESC);

-- RLS: standard tenant_isolation policy (matches 000002_rls / value_exports).
ALTER TABLE billing_periods ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_periods FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON billing_periods
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
         OR current_setting('app.role', true) = 'platform')
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
         OR current_setting('app.role', true) = 'platform');

ALTER TABLE billing_exports ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_exports FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON billing_exports
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
         OR current_setting('app.role', true) = 'platform')
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
         OR current_setting('app.role', true) = 'platform');
