/**
 * OIDC login — step 1 (BYO-P4). Begins a real Authorization-Code + PKCE flow
 * against the tenant's OIDC IdP (locally: the Keycloak in the stack). Discovers
 * the IdP's authorization endpoint, mints a PKCE verifier/challenge + state,
 * stashes them in short-lived httpOnly cookies, and 302-redirects the browser
 * to the IdP. The callback (../callback) completes the exchange. Enabled when
 * AUTH_MODE=oidc; the dev/persona login is untouched.
 */
import { NextRequest, NextResponse } from "next/server";
import { createHash, randomBytes } from "node:crypto";
import { oidcConfig, discover } from "@/lib/auth/oidc";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function GET(_req: NextRequest) {
  const cfg = oidcConfig();
  if (!cfg) {
    return NextResponse.json({ error: "oidc login is not configured (set AUTH_MODE=oidc + OIDC_*)" }, { status: 501 });
  }
  let meta;
  try {
    meta = await discover(cfg.issuer);
  } catch {
    return NextResponse.json({ error: "oidc discovery failed" }, { status: 502 });
  }

  const verifier = b64url(randomBytes(48));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  const state = b64url(randomBytes(24));

  const authorize = new URL(meta.authorization_endpoint);
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("client_id", cfg.clientId);
  authorize.searchParams.set("redirect_uri", cfg.redirectUri);
  authorize.searchParams.set("scope", "openid email profile");
  authorize.searchParams.set("state", state);
  authorize.searchParams.set("code_challenge", challenge);
  authorize.searchParams.set("code_challenge_method", "S256");

  const res = NextResponse.redirect(authorize.toString());
  const opts = { httpOnly: true as const, sameSite: "lax" as const, secure: process.env.NODE_ENV === "production", path: "/", maxAge: 600 };
  res.cookies.set("oidc_verifier", verifier, opts);
  res.cookies.set("oidc_state", state, opts);
  return res;
}
