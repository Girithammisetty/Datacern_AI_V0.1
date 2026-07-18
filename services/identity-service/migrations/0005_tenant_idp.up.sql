-- Per-tenant OIDC identity-provider configuration (BYO-P4): lets each tenant
-- bring their OWN IdP (Okta/Auth0/Entra/Keycloak) instead of a single
-- deployment-wide OIDC_ISSUER. The issuer is globally UNIQUE so an inbound
-- ID token routes to exactly one tenant by its `iss` claim, with no tenant hint
-- required at login. Platform-scoped like tenants + tenant_embed_configs (one
-- row per tenant); no RLS — managed by tenant admins through the action-gated
-- admin API (identity.user.admin), read on the unauthenticated login path.
CREATE TABLE tenant_idp_configs (
    tenant_id     uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
    issuer        text NOT NULL UNIQUE,
    client_id     text NOT NULL DEFAULT '',
    discovery_url text NOT NULL DEFAULT '',
    enabled       boolean NOT NULL DEFAULT true,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now()
);
