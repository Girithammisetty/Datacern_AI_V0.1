/**
 * Sign out. Always clears every local Datacern cookie. For a real-OIDC
 * session this ALSO performs RP-initiated (single) logout at the IdP — a
 * click on "Sign out" that only cleared the Datacern cookie left the IdP's
 * own SSO session alive, so "Sign in with SSO" right after silently
 * re-authenticated with no credential prompt at all. GET (not POST) because
 * completing single logout requires a real browser navigation through the
 * IdP and back, not a fetch the client can't follow cross-origin.
 */
import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, OIDC_REFRESH_COOKIE, OIDC_ID_TOKEN_COOKIE } from "@/lib/auth/session";
import { oidcConfig, discover } from "@/lib/auth/oidc";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function clearAuthCookies(res: NextResponse) {
  res.cookies.set(SESSION_COOKIE, "", { httpOnly: true, path: "/", maxAge: 0 });
  res.cookies.set(OIDC_REFRESH_COOKIE, "", { httpOnly: true, path: "/api/auth", maxAge: 0 });
  res.cookies.set(OIDC_ID_TOKEN_COOKIE, "", { httpOnly: true, path: "/api/auth", maxAge: 0 });
}

async function handleLogout(req: NextRequest): Promise<NextResponse> {
  const idToken = req.cookies.get(OIDC_ID_TOKEN_COOKIE)?.value;
  const loginUrl = new URL("/login", req.url);

  if (idToken) {
    const cfg = oidcConfig();
    if (cfg) {
      try {
        const meta = await discover(cfg.issuer);
        if (meta.end_session_endpoint) {
          const endSession = new URL(meta.end_session_endpoint);
          endSession.searchParams.set("id_token_hint", idToken);
          endSession.searchParams.set("post_logout_redirect_uri", loginUrl.toString());
          endSession.searchParams.set("client_id", cfg.clientId);
          const res = NextResponse.redirect(endSession.toString());
          clearAuthCookies(res);
          return res;
        }
      } catch {
        // Fall through to a local-only logout — the user is still signed out
        // of Datacern even if the IdP round-trip couldn't be started.
      }
    }
  }

  const res = NextResponse.redirect(loginUrl);
  clearAuthCookies(res);
  return res;
}

export async function GET(req: NextRequest) {
  return handleLogout(req);
}

// Back-compat for any caller still POSTing (e.g. a stale client bundle).
export async function POST(req: NextRequest) {
  return handleLogout(req);
}
