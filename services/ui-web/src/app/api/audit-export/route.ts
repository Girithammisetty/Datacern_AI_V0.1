/**
 * Authed raw audit-export download proxy → audit-service GET
 * /api/v1/audit/export (AUD-FR-032, capability audit.event.export). The
 * downstream route streams a filtered CSV/NDJSON file and requires the
 * caller's Bearer JWT, which a plain browser <a href> cannot carry — so the
 * file is streamed through this same-origin route with the httpOnly session
 * forwarded, exactly like api/case-export/[operationId]/route.ts does for
 * case CSVs. Zero business logic: the filter querystring (built by the BFF's
 * auditExportFile descriptor) is forwarded verbatim, except `format`, which
 * only selects the Accept header (text/csv vs application/x-ndjson).
 */
import { NextRequest, NextResponse } from "next/server";
import { getSessionToken } from "@/lib/auth/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const AUDIT_URL = process.env.AUDIT_URL ?? "http://localhost:8322";

export async function GET(req: NextRequest) {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  const params = new URLSearchParams(req.nextUrl.searchParams);
  const ndjson = params.get("format") === "ndjson";
  params.delete("format");
  const accept = ndjson ? "application/x-ndjson" : "text/csv";

  let upstream: Response;
  try {
    upstream = await fetch(`${AUDIT_URL}/api/v1/audit/export?${params.toString()}`, {
      headers: { authorization: `Bearer ${token}`, accept },
    });
  } catch {
    return NextResponse.json({ error: "audit service unreachable" }, { status: 502 });
  }

  if (!upstream.ok) {
    // Surface the downstream failure (e.g. 422 bad window, 403 missing
    // audit.event.export) as JSON with its real status — never a fake file.
    const text = await upstream.text();
    return new NextResponse(text || JSON.stringify({ error: `audit service returned ${upstream.status}` }), {
      status: upstream.status,
      headers: { "content-type": upstream.headers.get("content-type") ?? "application/json" },
    });
  }

  // Stream the CSV/NDJSON straight through — never buffered into ui-web
  // memory (the downstream caps the export at 100k rows).
  const stamp = new Date().toISOString().slice(0, 10);
  return new NextResponse(upstream.body, {
    status: upstream.status,
    headers: {
      "content-type": upstream.headers.get("content-type") ?? accept,
      "content-disposition": `attachment; filename="audit-export-${stamp}.${ndjson ? "ndjson" : "csv"}"`,
    },
  });
}
