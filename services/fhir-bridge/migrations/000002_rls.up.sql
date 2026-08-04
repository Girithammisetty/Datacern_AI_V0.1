-- Row-level security (MASTER-FR-001). fhir_backends is tenant-scoped: the
-- service sets app.tenant_id per transaction from the verified JWT (REST) or
-- the facade body's tenant field (already enforced upstream by tool-plane),
-- never from arbitrary request input (MASTER-FR-002). FORCE binds the policy
-- to the table owner too, so even a superuser-owned session (test containers)
-- is constrained.

ALTER TABLE fhir_backends ENABLE ROW LEVEL SECURITY;
ALTER TABLE fhir_backends FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON fhir_backends
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
