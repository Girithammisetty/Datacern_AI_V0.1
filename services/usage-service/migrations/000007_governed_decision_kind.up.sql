-- BRD 69 (docs/initiatives/value-roi-reporting.md §3 "Repo-state finding" /
-- "Known limits") — closes the by_kind gap that BRD 67 slice 1 left open.
--
-- BRD 67 slice 1 widened usage_raw/usage_hourly/usage_daily/usage_monthly
-- with pack_name/decision as rollup-worthy dimensions (migrations/
-- 000004_value_meters.up.sql), but kept proposal_kind raw-detail-only in
-- usage_raw.meta JSONB, never rolled up — that migration's own doc comment
-- says so explicitly. Consequently decisions.by_kind (and every
-- assumption-derived *_est figure that needs per-kind decision counts:
-- hours_saved_est, labor_value_est_usd, human_baseline_cost_usd,
-- net_value_est_usd) could not be computed from the real store even with
-- value_assumptions set (internal/valuecalc.BuildSummary already implements
-- the per-kind formula and is unit-tested against a synthetic fixture — see
-- valuecalc_test.go's AC-1 test — it was only ever missing real input data).
--
-- This migration promotes proposal_kind from usage_raw.meta to a physical
-- rollup-worthy column, following the EXACT same pattern 000004 already
-- established for pack_name/decision (nullable on usage_raw, NOT NULL
-- DEFAULT '' + widened PRIMARY KEY on every rollup table). Every pre-existing
-- meter's rollup rows are unaffected: proposal_kind is always '' for them,
-- same COALESCE(...,'') sentinel convention as the other dims.
--
-- proposal_kind stays ADDITIONALLY in usage_raw.meta too? No — once it is a
-- physical dimension it is redundant there; the ingest mapping (internal/
-- ingest/mapping.go) is updated in the same change to extract it as a
-- DimPath instead of a MetaPath, so meta only ever carries
-- decision_latency_ms/edit_distance_bucket from here on (still genuinely
-- raw-detail-only — no showback query groups by either).

ALTER TABLE usage_raw ADD COLUMN proposal_kind TEXT;

ALTER TABLE usage_hourly ADD COLUMN proposal_kind TEXT NOT NULL DEFAULT '';
ALTER TABLE usage_hourly DROP CONSTRAINT usage_hourly_pkey;
ALTER TABLE usage_hourly ADD CONSTRAINT usage_hourly_pkey
  PRIMARY KEY (tenant_id, meter_key, bucket, workspace_id, user_id, agent_id, model, cloud, pack_name, decision, proposal_kind);

ALTER TABLE usage_daily ADD COLUMN proposal_kind TEXT NOT NULL DEFAULT '';
ALTER TABLE usage_daily DROP CONSTRAINT usage_daily_pkey;
ALTER TABLE usage_daily ADD CONSTRAINT usage_daily_pkey
  PRIMARY KEY (tenant_id, meter_key, bucket, workspace_id, user_id, agent_id, model, cloud, pack_name, decision, proposal_kind);

ALTER TABLE usage_monthly ADD COLUMN proposal_kind TEXT NOT NULL DEFAULT '';
ALTER TABLE usage_monthly DROP CONSTRAINT usage_monthly_pkey;
ALTER TABLE usage_monthly ADD CONSTRAINT usage_monthly_pkey
  PRIMARY KEY (tenant_id, meter_key, bucket, workspace_id, user_id, agent_id, model, cloud, pack_name, decision, proposal_kind);
