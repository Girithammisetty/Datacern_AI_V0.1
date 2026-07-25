-- BRD 69 slice 1: value-reporting assumptions (ROI-FR-001/002) —
-- docs/initiatives/value-roi-reporting.md §2.1. Numbered 000005 (not the
-- design doc's illustrative 000004_value_assumptions) because BRD 67 slice 1
-- already shipped 000004_value_meters — see that migration for the
-- governed_decision/auto_executed_action dimension widening this table's
-- consumer (GET /value/summary) reads from.
--
-- Mirrors the rate_cards versioning idiom (domain.RateCard): append-only
-- versions, immutable once written, resolved "as of" a date. The key
-- difference from rate cards: there is NO platform default row. A tenant
-- with zero rows *is* the "assumptions unset" state (ROI-FR-001) — no
-- sentinel, no zero-value default, because a present-but-zero row would be
-- indistinguishable from a deliberate zero and would violate the honesty
-- invariant (ROI-NFR-004).
CREATE TABLE value_assumptions (
    id                      UUID PRIMARY KEY,
    tenant_id               UUID NOT NULL,
    version                 INT NOT NULL,
    minutes_per_decision    JSONB NOT NULL DEFAULT '{}',  -- proposal_kind -> minutes; schemaless, <64KB (MASTER-FR-061)
    loaded_hourly_rate_usd  NUMERIC(10,2) NOT NULL,
    effective_from          DATE NOT NULL,
    status                  TEXT NOT NULL DEFAULT 'active', -- active | superseded (no draft state)
    created_by              TEXT NOT NULL,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, version)
);
CREATE INDEX value_assumptions_tenant_active_idx ON value_assumptions (tenant_id, status, effective_from DESC);

-- RLS (MASTER-FR-001), same tenant_isolation policy shape as 000002_rls.
ALTER TABLE value_assumptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE value_assumptions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON value_assumptions
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
         OR current_setting('app.role', true) = 'platform')
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
         OR current_setting('app.role', true) = 'platform');

-- Grants: 000003_app_role's ALTER DEFAULT PRIVILEGES already covers tables
-- created by later migrations, so no explicit GRANT is needed here.
