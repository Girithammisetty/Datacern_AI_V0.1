-- BRD 67 slice 1: value meters (governed_decision, auto_executed_action) —
-- docs/initiatives/value-metering-billing-export.md §2.2.
--
-- Two dimension kinds:
--   - rollup-worthy (need cross-tenant/cross-period GROUP BY for showback/ROI,
--     US-1): pack_name, decision. New nullable/defaulted columns on usage_raw
--     AND every rollup table, added to every GROUP BY / PRIMARY KEY / ON
--     CONFLICT tuple. NULL (raw) / '' (rollups, matching the existing
--     COALESCE(...,'') sentinel convention) for every pre-existing infra
--     meter — no behavior change there, just a wider dimension tuple.
--   - raw-detail-only (point-lookup fields no showback query groups by:
--     proposal_kind, decision_latency_ms, edit_distance_bucket): a single
--     bounded `meta` JSONB column on usage_raw only, never rolled up
--     (MASTER-FR-061 carve-out — a handful of short scalar fields per row).
--
-- `disposition` (the case_resolved-only rollup dim) is intentionally NOT
-- added here: case_resolved needs case-service changes out of scope for
-- slice 1 (see docs/initiatives/value-metering-billing-export.md §3 slice
-- plan). Adding an unused column ahead of its meter would be exactly the
-- kind of fabricated-readiness this repo's conventions forbid.

ALTER TABLE usage_raw ADD COLUMN pack_name TEXT;
ALTER TABLE usage_raw ADD COLUMN decision  TEXT;
ALTER TABLE usage_raw ADD COLUMN meta      JSONB NOT NULL DEFAULT '{}';
-- usage_raw's idempotency key (tenant_id, event_id, meter_key, time) is
-- unchanged: one decision event still yields exactly one raw row per meter,
-- so widening the dimension tuple does not need to widen the unique key.

ALTER TABLE usage_hourly ADD COLUMN pack_name TEXT NOT NULL DEFAULT '';
ALTER TABLE usage_hourly ADD COLUMN decision  TEXT NOT NULL DEFAULT '';
ALTER TABLE usage_hourly DROP CONSTRAINT usage_hourly_pkey;
ALTER TABLE usage_hourly ADD CONSTRAINT usage_hourly_pkey
  PRIMARY KEY (tenant_id, meter_key, bucket, workspace_id, user_id, agent_id, model, cloud, pack_name, decision);

ALTER TABLE usage_daily ADD COLUMN pack_name TEXT NOT NULL DEFAULT '';
ALTER TABLE usage_daily ADD COLUMN decision  TEXT NOT NULL DEFAULT '';
ALTER TABLE usage_daily DROP CONSTRAINT usage_daily_pkey;
ALTER TABLE usage_daily ADD CONSTRAINT usage_daily_pkey
  PRIMARY KEY (tenant_id, meter_key, bucket, workspace_id, user_id, agent_id, model, cloud, pack_name, decision);

ALTER TABLE usage_monthly ADD COLUMN pack_name TEXT NOT NULL DEFAULT '';
ALTER TABLE usage_monthly ADD COLUMN decision  TEXT NOT NULL DEFAULT '';
ALTER TABLE usage_monthly DROP CONSTRAINT usage_monthly_pkey;
ALTER TABLE usage_monthly ADD CONSTRAINT usage_monthly_pkey
  PRIMARY KEY (tenant_id, meter_key, bucket, workspace_id, user_id, agent_id, model, cloud, pack_name, decision);

-- Seeded meter catalog rows for the two new meters (mirrors how 000001 seeds
-- via application boot (store.SeedMeters), not a migration-time INSERT — no
-- catalog INSERT needed here; internal/store/pg.go's SeedMeters upserts from
-- domain.Catalog() on every boot, which now includes governed_decision and
-- auto_executed_action).
