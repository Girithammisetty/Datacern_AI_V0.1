/**
 * Value-report artifact download proxy → usage-service GET
 * /api/v1/value-report-artifacts/* (BRD 69 design §2.8). The downstream link
 * is HMAC-presigned (exp + sig query params), not JWT'd — but it points at
 * usage-service, which a browser cannot reach when only ui-web is exposed.
 * This same-origin route streams the artifact through, forwarding the signed
 * query string verbatim, exactly like case-export/[operationId]/route.ts does
 * for case CSVs. Zero business logic here — signature validation, expiry and
 * content type all stay downstream.
 */
import { NextRequest, NextResponse } from "next/server";
import { getSessionToken } from "@/lib/auth/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const USAGE_URL = process.env.USAGE_URL ?? "http://localhost:9017";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ key: string[] }> },
) {
  // A platform session is required so ui-web never acts as an open relay for a
  // leaked presigned link — the same guard query-export uses. Signature/expiry
  // validation still stays downstream; this only refuses anonymous callers.
  const session = await getSessionToken();
  if (!session) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  const { key } = await params;
  // Reject dot-segments before assembling the path: encodeURIComponent leaves
  // "." untouched, so a "%2e%2e" catch-all segment would otherwise survive into
  // the URL and normalize to a path-traversal within usage-service.
  if (key.some((seg) => seg === "." || seg === ".." || seg.includes("/") || seg.includes("\\"))) {
    return NextResponse.json({ error: "invalid artifact key" }, { status: 400 });
  }
  const path = key.map(encodeURIComponent).join("/");

  let upstream: Response;
  try {
    upstream = await fetch(
      `${USAGE_URL}/api/v1/value-report-artifacts/${path}${req.nextUrl.search}`,
    );
  } catch {
    return NextResponse.json({ error: "usage service unreachable" }, { status: 502 });
  }

  if (!upstream.ok) {
    // Surface the downstream failure (404 "artifact not found or link
    // expired", 503 store-not-configured) with its real status — never a
    // fake file.
    const text = await upstream.text();
    return new NextResponse(text || JSON.stringify({ error: `usage service returned ${upstream.status}` }), {
      status: upstream.status,
      headers: { "content-type": upstream.headers.get("content-type") ?? "application/json" },
    });
  }

  // Stream the artifact straight through, preserving the attachment
  // disposition and content type the service set.
  return new NextResponse(upstream.body, {
    status: upstream.status,
    headers: {
      "content-type": upstream.headers.get("content-type") ?? "application/octet-stream",
      "content-disposition": upstream.headers.get("content-disposition") ?? "attachment",
    },
  });
}
