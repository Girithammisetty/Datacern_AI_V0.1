ALTER TABLE usage_monthly DROP CONSTRAINT usage_monthly_pkey;
ALTER TABLE usage_monthly ADD CONSTRAINT usage_monthly_pkey
  PRIMARY KEY (tenant_id, meter_key, bucket, workspace_id, user_id, agent_id, model, cloud, pack_name, decision);
ALTER TABLE usage_monthly DROP COLUMN proposal_kind;

ALTER TABLE usage_daily DROP CONSTRAINT usage_daily_pkey;
ALTER TABLE usage_daily ADD CONSTRAINT usage_daily_pkey
  PRIMARY KEY (tenant_id, meter_key, bucket, workspace_id, user_id, agent_id, model, cloud, pack_name, decision);
ALTER TABLE usage_daily DROP COLUMN proposal_kind;

ALTER TABLE usage_hourly DROP CONSTRAINT usage_hourly_pkey;
ALTER TABLE usage_hourly ADD CONSTRAINT usage_hourly_pkey
  PRIMARY KEY (tenant_id, meter_key, bucket, workspace_id, user_id, agent_id, model, cloud, pack_name, decision);
ALTER TABLE usage_hourly DROP COLUMN proposal_kind;

ALTER TABLE usage_raw DROP COLUMN proposal_kind;
