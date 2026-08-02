/**
 * Query result-export download proxy → query-service GET
 * /api/v1/downloads/{token} (QRY-FR-062). The downstream link is
 * pre-authenticated by its HMAC-signed token (no JWT needed), but it lives on
 * a service host the browser cannot reach — so the CSV streams through this
 * same-origin route, modeled on case-export/[operationId]/route.ts. A session
 * is still required so ui-web never acts as an open relay. Zero business
 * logic here.
 */
import { NextRequest, NextResponse } from "next/server";
import { getSessionToken } from "@/lib/auth/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const QUERY_URL = process.env.QUERY_URL ?? "http://localhost:8085";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  const session = await getSessionToken();
  if (!session) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  let upstream: Response;
  try {
    upstream = await fetch(`${QUERY_URL}/api/v1/downloads/${encodeURIComponent(token)}`);
  } catch {
    return NextResponse.json({ error: "query service unreachable" }, { status: 502 });
  }

  if (!upstream.ok) {
    // Surface the downstream failure (e.g. 410 "download link expired or
    // invalid" / "results expired") as JSON with its real status — never a
    // fake file.
    const text = await upstream.text();
    return new NextResponse(text || JSON.stringify({ error: `query service returned ${upstream.status}` }), {
      status: upstream.status,
      headers: { "content-type": upstream.headers.get("content-type") ?? "application/json" },
    });
  }

  // Stream the CSV straight through — never buffered into ui-web memory —
  // preserving the attachment filename the service set.
  return new NextResponse(upstream.body, {
    status: upstream.status,
    headers: {
      "content-type": upstream.headers.get("content-type") ?? "text/csv",
      "content-disposition":
        upstream.headers.get("content-disposition") ?? `attachment; filename="results.csv"`,
    },
  });
}
