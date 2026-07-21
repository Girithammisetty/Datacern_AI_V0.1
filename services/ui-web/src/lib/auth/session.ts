/**
 * Session helpers shared by the auth/graphql/rt route handlers. The user JWT
 * lives in an httpOnly cookie (never readable by JS); these read it server-side.
 */
import "server-only";
import { cookies } from "next/headers";
import { decodeJwt } from "jose";

export const SESSION_COOKIE = "wr_session";
/** Embed session cookie (SameSite=None; Secure; Partitioned) for the headless
 * `/embed/*` surfaces framed on a tenant's origin. Kept separate from the main
 * first-party session so third-party-cookie behavior never affects normal use. */
export const EMBED_COOKIE = "wr_embed";
/** The IdP's OAuth2 refresh_token from a real OIDC login (BYO-P4), set once at
 * /api/auth/callback and used by /api/auth/refresh to silently re-mint the
 * 5-min platform session (MASTER-FR-010) before it expires — never sent to
 * the browser as JS-readable, never forwarded downstream. Absent entirely for
 * dev-login sessions (which mint an 8h token and don't need this). */
export const OIDC_REFRESH_COOKIE = "wr_oidc_refresh";
/** The IdP's own id_token, kept ONLY to pass as `id_token_hint` on RP-initiated
 * logout (OIDC single logout) — never used for anything else. Without this,
 * "Sign out" only cleared the platform session; the IdP's own SSO session (a
 * separate cookie on the IdP's origin) stayed alive, so clicking "Sign in with
 * SSO" again silently re-authenticated with no credential prompt at all — a
 * real gap for a regulated/shared-workstation product. */
export const OIDC_ID_TOKEN_COOKIE = "wr_oidc_id_token";

export interface SessionClaims {
  sub: string;
  tenantId: string;
  workspaceId: string;
  scopes: string[];
  type: string;
  exp?: number;
}

export async function getSessionToken(): Promise<string | null> {
  const store = await cookies();
  // First-party session wins; fall back to the embed session so the shared
  // /api/graphql data path authenticates unchanged inside an iframe.
  return store.get(SESSION_COOKIE)?.value ?? store.get(EMBED_COOKIE)?.value ?? null;
}

export function parseClaims(token: string): SessionClaims | null {
  try {
    const c = decodeJwt(token);
    return {
      sub: String(c.sub ?? ""),
      tenantId: String((c as Record<string, unknown>).tenant_id ?? ""),
      workspaceId: String((c as Record<string, unknown>).workspace_id ?? ""),
      scopes: Array.isArray((c as Record<string, unknown>).scopes)
        ? ((c as Record<string, unknown>).scopes as string[])
        : [],
      type: String((c as Record<string, unknown>).typ ?? "user"),
      exp: typeof c.exp === "number" ? c.exp : undefined,
    };
  } catch {
    return null;
  }
}

export async function getSessionClaims(): Promise<SessionClaims | null> {
  const token = await getSessionToken();
  if (!token) return null;
  const claims = parseClaims(token);
  if (!claims) return null;
  if (claims.exp && claims.exp * 1000 < Date.now()) return null;
  return claims;
}
