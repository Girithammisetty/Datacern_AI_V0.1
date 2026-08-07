-- Default pool cells, one per cloud (IDN-FR-006 AssignCell).
--
-- Until now cells existed only where deploy/e2e/seed.sh had run — the laptop
-- bring-up. On a real cluster the table was empty, so the FIRST tenant
-- provisioning (including every /public/demo-signup) died at step 1 with
-- CELL_CAPACITY: "no cell with capacity for cloud aws" — found on the first
-- GCP rollout. Seed them in a migration so any deployment that has run
-- migrations can provision tenants; same fixed UUIDs as seed.sh so the two
-- paths converge instead of duplicating.
--
-- A production control plane manages real cells via the API; these defaults
-- are additive (ON CONFLICT DO NOTHING) and never overwrite operator changes.
INSERT INTO cells (id, name, cloud, region, capacity, tenant_count) VALUES
    ('11111111-1111-1111-1111-111111111111', 'cell-aws-use1',  'aws',   'us-east-1',   500, 0),
    ('22222222-2222-2222-2222-222222222222', 'cell-gcp-usc1',  'gcp',   'us-central1', 500, 0),
    ('33333333-3333-3333-3333-333333333333', 'cell-azure-eus', 'azure', 'eastus',      500, 0)
ON CONFLICT (name) DO NOTHING;
