/**
 * Authed tenant-branding logo proxy (BRD 59 WS3) — GET streams the caller
 * tenant's logo from identity-service GET /tenants/self/branding/logo; POST
 * forwards a multipart upload (field "file") to identity-service POST
 * /tenants/self/branding/logo. Mirrors the case-evidence proxy pair
 * (src/app/api/case-evidence/[caseId]/route.ts): the browser can't attach the
 * httpOnly session Bearer to a cross-service request, and a raw <img src=...>
 * can't attach one at all, so this same-origin route does it for both.
 */
import { NextRequest, NextResponse } from "next/server";
import { getSessionToken } from "@/lib/auth/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const IDENTITY_URL = process.env.IDENTITY_URL ?? "http://localhost:9001";

export async function GET() {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  let upstream: Response;
  try {
    upstream = await fetch(`${IDENTITY_URL}/api/v1/tenants/self/branding/logo`, {
      headers: { authorization: `Bearer ${token}` },
    });
  } catch {
    return NextResponse.json({ error: "identity service unreachable" }, { status: 502 });
  }

  if (!upstream.ok) {
    const text = await upstream.text();
    return new NextResponse(text || JSON.stringify({ error: `identity service returned ${upstream.status}` }), {
      status: upstream.status,
      headers: { "content-type": upstream.headers.get("content-type") ?? "application/json" },
    });
  }

  return new NextResponse(upstream.body, {
    status: upstream.status,
    headers: {
      "content-type": upstream.headers.get("content-type") ?? "application/octet-stream",
      "cache-control": upstream.headers.get("cache-control") ?? "private, max-age=300",
    },
  });
}

export async function POST(req: NextRequest) {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  const contentType = req.headers.get("content-type") ?? "";
  if (!contentType.startsWith("multipart/form-data")) {
    return NextResponse.json({ error: "expected multipart/form-data" }, { status: 400 });
  }
  // Buffer the upload (capped downstream at 2 MiB) and forward the multipart
  // body verbatim so the boundary + the "file" part reach identity-service intact.
  const body = await req.arrayBuffer();

  let upstream: Response;
  try {
    upstream = await fetch(`${IDENTITY_URL}/api/v1/tenants/self/branding/logo`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": contentType },
      body,
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
