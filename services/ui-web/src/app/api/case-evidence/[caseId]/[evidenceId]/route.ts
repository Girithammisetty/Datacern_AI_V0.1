/**
 * Authed case-evidence DOWNLOAD proxy → case-service GET
 * /cases/{id}/evidence/{eid}/download (task #77). Streams the file through this
 * same-origin route with the httpOnly session Bearer, so a browser <a href>
 * can download it. Mirrors api/case-export/[operationId]/route.ts.
 */
import { NextRequest, NextResponse } from "next/server";
import { getSessionToken } from "@/lib/auth/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CASE_URL = process.env.CASE_URL ?? "http://localhost:8308";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ caseId: string; evidenceId: string }> },
) {
  const { caseId, evidenceId } = await params;
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  let upstream: Response;
  try {
    upstream = await fetch(
      `${CASE_URL}/api/v1/cases/${encodeURIComponent(caseId)}/evidence/${encodeURIComponent(evidenceId)}/download`,
      { headers: { authorization: `Bearer ${token}` } },
    );
  } catch {
    return NextResponse.json({ error: "case service unreachable" }, { status: 502 });
  }

  if (!upstream.ok) {
    const text = await upstream.text();
    return new NextResponse(text || JSON.stringify({ error: `case service returned ${upstream.status}` }), {
      status: upstream.status,
      headers: { "content-type": upstream.headers.get("content-type") ?? "application/json" },
    });
  }

  return new NextResponse(upstream.body, {
    status: upstream.status,
    headers: {
      "content-type": upstream.headers.get("content-type") ?? "application/octet-stream",
      "content-disposition": upstream.headers.get("content-disposition") ?? "attachment",
    },
  });
}
