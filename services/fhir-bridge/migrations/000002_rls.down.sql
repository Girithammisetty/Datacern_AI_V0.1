DROP POLICY IF EXISTS tenant_isolation ON fhir_backends;
ALTER TABLE fhir_backends DISABLE ROW LEVEL SECURITY;
