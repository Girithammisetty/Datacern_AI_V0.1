/**
 * OIDC login — step 2 (BYO-P4). The IdP redirects here with an authorization
 * code. We validate state, exchange the code (with the PKCE verifier) at the
 * IdP's token endpoint, then hand the resulting ID token to identity-service
 * POST /token/oidc, which verifies it against the IdP's JWKS, resolves the
 * Windrose user, and mints the platform session JWT. We set that as the
 * wr_session cookie and land the user in the app — a real end-to-end SSO login.
 */
import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth/session";
import { oidcConfig, discover } from "@/lib/auth/oidc";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function fail(req: NextRequest, reason: string) {
  const url = new URL("/login", req.url);
  url.searchParams.set("error", reason);
  return NextResponse.redirect(url);
}

export async function GET(req: NextRequest) {
  const cfg = oidcConfig();
  if (!cfg) return NextResponse.json({ error: "oidc not configured" }, { status: 501 });

  const params = req.nextUrl.searchParams;
  if (params.get("error")) return fail(req, params.get("error")!);
  const code = params.get("code");
  const state = params.get("state");
  const verifier = req.cookies.get("oidc_verifier")?.value;
  const savedState = req.cookies.get("oidc_state")?.value;
  if (!code || !state || !verifier || !savedState) return fail(req, "missing_oidc_params");
  if (state !== savedState) return fail(req, "state_mismatch");

  let meta;
  try {
    meta = await discover(cfg.issuer);
  } catch {
    return fail(req, "discovery_failed");
  }

  // Exchange the code for tokens (PKCE — public client, no secret).
  let idToken: string;
  try {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: cfg.redirectUri,
      client_id: cfg.clientId,
      code_verifier: verifier,
    });
    const tokenRes = await fetch(meta.token_endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
      cache: "no-store",
    });
    if (!tokenRes.ok) return fail(req, "token_exchange_failed");
    const tokens = (await tokenRes.json()) as { id_token?: string };
    if (!tokens.id_token) return fail(req, "no_id_token");
    idToken = tokens.id_token;
  } catch {
    return fail(req, "token_exchange_error");
  }

  // Hand the verified-upstream ID token to identity-service, which verifies it
  // against the IdP JWKS and mints the Windrose session JWT.
  let sessionToken: string;
  try {
    const res = await fetch(`${cfg.identityUrl}/api/v1/token/oidc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id_token: idToken }),
      cache: "no-store",
    });
    if (!res.ok) return fail(req, "session_mint_failed");
    const out = (await res.json()) as { access_token?: string };
    if (!out.access_token) return fail(req, "no_session_token");
    sessionToken = out.access_token;
  } catch {
    return fail(req, "identity_unreachable");
  }

  const res = NextResponse.redirect(new URL("/", req.url));
  res.cookies.set(SESSION_COOKIE, sessionToken, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 8,
  });
  // One-time PKCE cookies are spent.
  res.cookies.delete("oidc_verifier");
  res.cookies.delete("oidc_state");
  return res;
}
