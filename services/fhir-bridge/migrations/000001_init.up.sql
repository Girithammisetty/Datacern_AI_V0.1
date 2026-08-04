-- fhir-bridge schema. Forward-only (MASTER-FR-060).
--
-- ONE table: the tenant's registered external FHIR R4 backends. The bridge is
-- a STATELESS proxy — no FHIR resources, no response bodies, no PHI are ever
-- persisted here. Secret material (tokens, passwords, client secrets, private
-- keys) lives in Vault behind vault_ref; there are deliberately NO secret
-- columns in Postgres.

CREATE TABLE fhir_backends (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id    UUID NOT NULL,
    workspace_id UUID,
    name         TEXT NOT NULL,
    base_url     TEXT NOT NULL,
    auth_method  TEXT NOT NULL
                   CHECK (auth_method IN ('none','bearer','basic',
                                          'oauth2_client_credentials',
                                          'smart_backend_services')),
    token_url    TEXT,                       -- oauth2 / smart token endpoint
    client_id    TEXT,
    scopes       TEXT,                       -- e.g. system/*.read
    vault_ref    TEXT NOT NULL DEFAULT '',   -- KV v2 path to secret material
    status       TEXT NOT NULL DEFAULT 'active'
                   CHECK (status IN ('active','disabled')),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, name)
);

CREATE INDEX fhir_backends_tenant_idx ON fhir_backends (tenant_id, status);
