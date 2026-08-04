-- Ship a NON-superuser, NON-owner runtime login role (tenant-isolation
-- discipline, cross-tenant RLS-bypass).
--
-- 000002 ENABLEd + FORCEd row-level security on fhir_backends, but FORCE (and
-- even ENABLE) is silently ignored for a superuser or the table owner. A
-- default DSN connecting as the dev cluster superuser would leave
-- tenant_isolation effectively OFF. So the runtime pool logs in as
-- `fhirbridge_app` (NOSUPERUSER NOBYPASSRLS, DML only) and FORCE RLS binds it;
-- migrations keep running privileged via MIGRATE_DATABASE_URL.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fhirbridge_app') THEN
    ALTER ROLE fhirbridge_app WITH LOGIN PASSWORD 'fhirbridge_app' NOSUPERUSER NOBYPASSRLS;
  ELSE
    CREATE ROLE fhirbridge_app WITH LOGIN PASSWORD 'fhirbridge_app' NOSUPERUSER NOBYPASSRLS;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO fhirbridge_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO fhirbridge_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO fhirbridge_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO fhirbridge_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO fhirbridge_app;
