/**
 * Switch the active use case (workspace) for the current session.
 *
 * A user's workspace is a JWT claim, so switching = re-minting the session token
 * with a new workspace_id, keeping the SAME identity, tenant, and scopes. This
 * is safe: the workspace_id claim grants nothing on its own — rbac enforces
 * per-workspace capabilities downstream, so switching into a use case where the
 * caller has no grants simply shows an empty, read-only view (fail-safe). The
 * tenant is never changed here, so there is no cross-tenant escalation.
 *
 * Dev-auth parity: like /api/auth/login, this re-mints with the harness key the
 * local stack trusts. Under real OIDC the re-scope belongs in identity-service
 * (a follow-up); this route is gated to dev auth so it never silently mints a
 * token a production stack would reject.
 */
import { NextResponse } from "next/server";
import { mintUserToken } from "@/lib/auth/keys";
import { getSessionClaims, SESSION_COOKIE } from "@/lib/auth/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  if ((process.env.AUTH_MODE ?? "dev") !== "dev") {
    return NextResponse.json(
      { error: "Switching use cases is handled by your identity provider in this deployment." },
      { status: 403 },
    );
  }
  const claims = await getSessionClaims();
  if (!claims) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }
  const { workspaceId } = (await req.json().catch(() => ({}))) as { workspaceId?: string };
  if (!workspaceId) {
    return NextResponse.json({ error: "workspaceId required" }, { status: 400 });
  }
  if (workspaceId === claims.workspaceId) {
    return NextResponse.json({ ok: true, workspaceId });
  }

  const token = await mintUserToken({
    sub: claims.sub,
    tenantId: claims.tenantId,
    workspaceId,
    scopes: claims.scopes,
  });
  const res = NextResponse.json({ ok: true, workspaceId });
  res.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 8,
  });
  return res;
}
