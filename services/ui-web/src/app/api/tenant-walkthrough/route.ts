/**
 * Authed tenant-walkthrough proxy (BRD 70 DSP-FR-015) — GET forwards to
 * identity-service GET /tenants/self/walkthrough, which returns the caller
 * tenant's guided-walkthrough steps (`{"steps": [...]}`, always 200, empty
 * for a non-demo tenant or a bundle with no walkthrough.yaml). Mirrors the
 * tenant-branding logo proxy (src/app/api/tenant-branding/logo/route.ts):
 * the browser can't attach the httpOnly session Bearer to a cross-service
 * request, so this same-origin route does it.
 */
import { NextResponse } from "next/server";
import { getSessionToken } from "@/lib/auth/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const IDENTITY_URL = process.env.IDENTITY_URL ?? "http://localhost:9001";

export async function GET() {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  let upstream: Response;
  try {
    upstream = await fetch(`${IDENTITY_URL}/api/v1/tenants/self/walkthrough`, {
      headers: { authorization: `Bearer ${token}` },
    });
  } catch {
    return NextResponse.json({ error: "identity service unreachable" }, { status: 502 });
  }

  const text = await upstream.text();
  return new NextResponse(text || JSON.stringify({ error: `identity service returned ${upstream.status}` }), {
    status: upstream.status,
    headers: { "content-type": upstream.headers.get("content-type") ?? "application/json" },
  });
}
