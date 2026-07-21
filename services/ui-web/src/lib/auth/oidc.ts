/**
 * Shared OIDC config + discovery for the real login flow (BYO-P4). The web tier
 * runs the Authorization-Code + PKCE dance; identity-service (POST /token/oidc)
 * verifies the resulting ID token and mints the platform session. Deployment-
 * level config for increment 1 (Keycloak/Okta/Auth0/Entra are just different
 * OIDC_ISSUER values); per-tenant IdP config is a documented follow-up.
 */
export interface OidcConfig {
  issuer: string; // used for .well-known discovery
  clientId: string;
  redirectUri: string;
  /** identity-service base URL that mints the platform session from the ID token. */
  identityUrl: string;
}

// The OIDC login routes are available whenever an IdP is configured — this is
// INDEPENDENT of AUTH_MODE. AUTH_MODE=oidc additionally disables the dev/persona
// login (prod); in dev both can coexist (dev login for tests + SSO for real).
export function oidcEnabled(): boolean {
  return !!process.env.OIDC_ISSUER;
}

export function oidcConfig(): OidcConfig | null {
  if (!oidcEnabled()) return null;
  return {
    issuer: process.env.OIDC_ISSUER!,
    clientId: process.env.OIDC_CLIENT_ID ?? "datacern-web",
    redirectUri: process.env.OIDC_REDIRECT_URI ?? "http://localhost:3000/api/auth/callback",
    identityUrl: process.env.IDENTITY_URL ?? "http://localhost:8301",
  };
}

export interface OidcMetadata {
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  issuer: string;
  /** RP-initiated (single) logout endpoint — standard OIDC discovery field,
   * absent from a handful of non-compliant IdPs, so callers must treat it as
   * optional and fall back to a local-only logout. */
  end_session_endpoint?: string;
}

/** Fetch the IdP's discovery document. Cached per issuer for the process. */
const cache = new Map<string, OidcMetadata>();
export async function discover(issuer: string): Promise<OidcMetadata> {
  const cached = cache.get(issuer);
  if (cached) return cached;
  const url = `${issuer.replace(/\/$/, "")}/.well-known/openid-configuration`;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`oidc discovery ${res.status}`);
  const meta = (await res.json()) as OidcMetadata;
  if (!meta.authorization_endpoint || !meta.token_endpoint) throw new Error("oidc discovery missing endpoints");
  cache.set(issuer, meta);
  return meta;
}
