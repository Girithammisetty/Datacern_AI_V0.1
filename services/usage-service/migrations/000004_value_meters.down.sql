ALTER TABLE usage_monthly DROP CONSTRAINT usage_monthly_pkey;
ALTER TABLE usage_monthly ADD CONSTRAINT usage_monthly_pkey
  PRIMARY KEY (tenant_id, meter_key, bucket, workspace_id, user_id, agent_id, model, cloud);
ALTER TABLE usage_monthly DROP COLUMN decision;
ALTER TABLE usage_monthly DROP COLUMN pack_name;

ALTER TABLE usage_daily DROP CONSTRAINT usage_daily_pkey;
ALTER TABLE usage_daily ADD CONSTRAINT usage_daily_pkey
  PRIMARY KEY (tenant_id, meter_key, bucket, workspace_id, user_id, agent_id, model, cloud);
ALTER TABLE usage_daily DROP COLUMN decision;
ALTER TABLE usage_daily DROP COLUMN pack_name;

ALTER TABLE usage_hourly DROP CONSTRAINT usage_hourly_pkey;
ALTER TABLE usage_hourly ADD CONSTRAINT usage_hourly_pkey
  PRIMARY KEY (tenant_id, meter_key, bucket, workspace_id, user_id, agent_id, model, cloud);
ALTER TABLE usage_hourly DROP COLUMN decision;
ALTER TABLE usage_hourly DROP COLUMN pack_name;

ALTER TABLE usage_raw DROP COLUMN meta;
ALTER TABLE usage_raw DROP COLUMN decision;
ALTER TABLE usage_raw DROP COLUMN pack_name;
