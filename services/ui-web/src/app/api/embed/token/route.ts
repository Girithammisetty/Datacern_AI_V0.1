/**
 * Embedding-server token exchange (embedded-UI, increment 1).
 *
 * The tenant's BACKEND (never the browser) calls this with the shared embed
 * secret + the user context, and gets back a short-lived, tightly-scoped user
 * JWT + an embed URL to drop into an <iframe>. The token is a normal user JWT
 * (aud=windrose) so every downstream service accepts it; it additionally
 * carries `embed:true` + a `surface` allowlist + a short TTL, and narrow
 * scopes bound to one workspace.
 *
 * PRODUCTION NOTE: the mint moves to identity-service `POST /token/embed` with
 * PER-TENANT embed secrets; this route becomes a thin proxy. The token shape
 * here is already the production shape.
 */
import { NextRequest, NextResponse } from "next/server";
import { mintUserToken } from "@/lib/auth/keys";
import { type EmbedBody, resolveEmbedRequest, resolveEmbedTarget, secretOk } from "@/lib/embed/token";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Embed-federated SSO (task #84): the tenant posts the END USER's OIDC ID token
 * instead of the shared secret. We proxy it to identity-service
 * /token/embed/oidc, which verifies it against the IdP, binds it to a real user
 * in the tenant, and mints the per-user embed token. Requires IDENTITY_URL (the
 * OIDC verify + signing live there). */
async function proxyFederated(body: EmbedBody): Promise<NextResponse> {
  const identity = process.env.IDENTITY_URL;
  if (!identity) {
    return NextResponse.json({ error: "embed OIDC federation requires IDENTITY_URL" }, { status: 501 });
  }
  const target = resolveEmbedTarget(body);
  if ("error" in target) {
    return NextResponse.json({ error: target.error }, { status: target.status });
  }
  const r = await fetch(`${identity.replace(/\/$/, "")}/api/v1/token/embed/oidc`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      tenant_id: body.tenantId,
      id_token: body.idToken,
      workspace_id: body.workspaceId,
      scopes: body.scopes,
      surface: target.surface,
      ttl_seconds: target.ttl,
    }),
  });
  if (!r.ok) {
    return NextResponse.json({ error: "embed federation rejected" }, { status: r.status });
  }
  const data = (await r.json()) as { access_token: string; expires_in: number };
  return NextResponse.json({
    token: data.access_token,
    expiresIn: data.expires_in,
    surface: target.surface,
    embedUrl: `${target.path}?t=${encodeURIComponent(data.access_token)}`,
  });
}

/** In production the mint lives in identity-service (which holds the signing
 * key and the PER-TENANT embed secret + allowed origins). When IDENTITY_URL is
 * set we PROXY there — validating nothing locally, since identity owns the
 * per-tenant secret. In dev (no IDENTITY_URL) we mint locally with the harness
 * key gated by the single WINDROSE_EMBED_SECRET. */
async function proxyToIdentity(req: NextRequest, body: EmbedBody): Promise<NextResponse | null> {
  const identity = process.env.IDENTITY_URL;
  if (!identity) return null;
  const resolved = resolveEmbedRequest(body);
  if ("error" in resolved) {
    return NextResponse.json({ error: resolved.error }, { status: resolved.status });
  }
  const secret =
    req.headers.get("x-windrose-embed-secret") ?? req.nextUrl.searchParams.get("secret") ?? "";
  const r = await fetch(`${identity.replace(/\/$/, "")}/api/v1/token/embed`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      tenant_id: resolved.mint.tenantId,
      secret,
      sub: resolved.mint.sub,
      workspace_id: resolved.mint.workspaceId,
      scopes: resolved.mint.scopes,
      surface: resolved.mint.surface,
      ttl_seconds: resolved.mint.ttlSeconds,
    }),
  });
  if (!r.ok) {
    return NextResponse.json({ error: "embed exchange rejected" }, { status: r.status });
  }
  const data = (await r.json()) as { access_token: string; expires_in: number };
  const embedUrl = `${resolved.path}?t=${encodeURIComponent(data.access_token)}`;
  return NextResponse.json({
    token: data.access_token,
    expiresIn: data.expires_in,
    surface: resolved.surface,
    embedUrl,
  });
}

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as EmbedBody;

  // Embed-federated SSO: an ID token in place of the shared secret (task #84).
  if (body.idToken) {
    return proxyFederated(body);
  }

  // Production: identity-service owns the per-tenant secret + signing key.
  const proxied = await proxyToIdentity(req, body);
  if (proxied) return proxied;

  // Dev fallback: local mint gated by the single WINDROSE_EMBED_SECRET.
  const provided =
    req.headers.get("x-windrose-embed-secret") ??
    req.nextUrl.searchParams.get("secret");
  if (!secretOk(provided)) {
    return NextResponse.json({ error: "invalid embed secret" }, { status: 401 });
  }
  const resolved = resolveEmbedRequest(body);
  if ("error" in resolved) {
    return NextResponse.json({ error: resolved.error }, { status: resolved.status });
  }

  const token = await mintUserToken({ ...resolved.mint, embed: true });
  // A convenience embed URL: the tenant drops this in an <iframe>; the ?t=
  // token is consumed once into the wr_embed cookie by the middleware.
  const embedUrl = `${resolved.path}?t=${encodeURIComponent(token)}`;
  return NextResponse.json({
    token,
    expiresIn: resolved.ttl,
    surface: resolved.surface,
    embedUrl,
  });
}
