/**
 * Silent session refresh for real OIDC logins (BYO-P4 follow-up). The Windrose
 * session JWT is intentionally short-lived (5 min, MASTER-FR-010) — without
 * this, a real-SSO user gets bounced to a raw "session expired" error every
 * 5 minutes of active use. The client polls this route in the background
 * (see useSessionRefresh); it's a silent no-op for dev-login sessions (no
 * wr_oidc_refresh cookie was ever set for those — they mint an 8h token).
 *
 * Uses the IdP's own refresh_token (captured at /api/auth/callback) to get a
 * fresh id_token from the IdP, then re-exchanges it via identity-service's
 * real POST /token/oidc — the exact same verify-and-mint path a fresh login
 * uses, so nothing here bypasses real verification.
 */
import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, OIDC_REFRESH_COOKIE, OIDC_ID_TOKEN_COOKIE } from "@/lib/auth/session";
import { oidcConfig, discover } from "@/lib/auth/oidc";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const refreshToken = req.cookies.get(OIDC_REFRESH_COOKIE)?.value;
  if (!refreshToken) return NextResponse.json({ refreshed: false });

  const cfg = oidcConfig();
  if (!cfg) return NextResponse.json({ refreshed: false });

  let meta;
  try {
    meta = await discover(cfg.issuer);
  } catch {
    return NextResponse.json({ refreshed: false });
  }

  let idToken: string;
  let newRefreshToken: string | undefined;
  try {
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: cfg.clientId,
    });
    const tokenRes = await fetch(meta.token_endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
      cache: "no-store",
    });
    if (!tokenRes.ok) {
      // The IdP refresh token is dead (expired/revoked) — stop retrying every
      // poll; the next real API call surfaces the normal "session expired,
      // please sign in again" flow.
      const res = NextResponse.json({ refreshed: false });
      res.cookies.delete(OIDC_REFRESH_COOKIE);
      return res;
    }
    const tokens = (await tokenRes.json()) as { id_token?: string; refresh_token?: string };
    if (!tokens.id_token) return NextResponse.json({ refreshed: false });
    idToken = tokens.id_token;
    newRefreshToken = tokens.refresh_token;
  } catch {
    return NextResponse.json({ refreshed: false });
  }

  let sessionToken: string;
  try {
    const res = await fetch(`${cfg.identityUrl}/api/v1/token/oidc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id_token: idToken }),
      cache: "no-store",
    });
    if (!res.ok) return NextResponse.json({ refreshed: false });
    const out = (await res.json()) as { access_token?: string };
    if (!out.access_token) return NextResponse.json({ refreshed: false });
    sessionToken = out.access_token;
  } catch {
    return NextResponse.json({ refreshed: false });
  }

  const res = NextResponse.json({ refreshed: true });
  res.cookies.set(SESSION_COOKIE, sessionToken, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 8,
  });
  // Keycloak rotates refresh tokens by default — persist the new one if
  // issued, otherwise the existing cookie (still valid) is left as-is.
  if (newRefreshToken) {
    res.cookies.set(OIDC_REFRESH_COOKIE, newRefreshToken, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/api/auth",
      maxAge: 60 * 60 * 12,
    });
  }
  // Keep the id_token_hint fresh too (used only by /api/auth/logout).
  res.cookies.set(OIDC_ID_TOKEN_COOKIE, idToken, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/api/auth",
    maxAge: 60 * 60 * 12,
  });
  return res;
}
