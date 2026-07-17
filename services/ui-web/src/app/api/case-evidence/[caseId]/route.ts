/**
 * Authed case-evidence UPLOAD proxy → case-service POST /cases/{id}/evidence
 * (task #77). The browser posts a multipart form (field "file") here; this
 * same-origin route forwards it with the httpOnly session Bearer the downstream
 * requires (a browser fetch can't attach it cross-service). Zero business logic
 * — case-service enforces case.evidence.create + the 25 MiB cap.
 */
import { NextRequest, NextResponse } from "next/server";
import { getSessionToken } from "@/lib/auth/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CASE_URL = process.env.CASE_URL ?? "http://localhost:8308";

export async function POST(req: NextRequest, { params }: { params: Promise<{ caseId: string }> }) {
  const { caseId } = await params;
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  const contentType = req.headers.get("content-type") ?? "";
  if (!contentType.startsWith("multipart/form-data")) {
    return NextResponse.json({ error: "expected multipart/form-data" }, { status: 400 });
  }
  // Buffer the upload (capped downstream at 25 MiB) and forward the multipart
  // body verbatim so the boundary + the "file" part reach case-service intact.
  const body = await req.arrayBuffer();

  let upstream: Response;
  try {
    upstream = await fetch(`${CASE_URL}/api/v1/cases/${encodeURIComponent(caseId)}/evidence`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": contentType },
      body,
    });
  } catch {
    return NextResponse.json({ error: "case service unreachable" }, { status: 502 });
  }

  const text = await upstream.text();
  return new NextResponse(text || JSON.stringify({ error: `case service returned ${upstream.status}` }), {
    status: upstream.status,
    headers: { "content-type": upstream.headers.get("content-type") ?? "application/json" },
  });
}
