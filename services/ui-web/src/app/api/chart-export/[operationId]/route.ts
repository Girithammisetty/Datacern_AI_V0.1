/**
 * Chart export-artifact download proxy (CHART-FR-041), modeled on
 * case-export/[operationId]/route.ts. The artifact link lives on the
 * operation resource (chart-service GET /api/v1/operations/{id}, which needs
 * the caller's Bearer JWT a plain <a href> cannot carry), and the link itself
 * points at a service host: FSStore mints a chart-service-relative signed path
 * (/api/v1/exports/…?exp&sig), S3Store an absolute presigned URL. This route
 * resolves the operation with the httpOnly session, then streams the artifact
 * through same-origin. Zero business logic here.
 */
import { NextRequest, NextResponse } from "next/server";
import { getSessionToken } from "@/lib/auth/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CHART_URL = process.env.CHART_URL ?? "http://localhost:9007";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ operationId: string }> },
) {
  const { operationId } = await params;
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  // 1. Resolve the operation → artifact_url (requires the caller's JWT).
  let opRes: Response;
  try {
    opRes = await fetch(`${CHART_URL}/api/v1/operations/${encodeURIComponent(operationId)}`, {
      headers: { authorization: `Bearer ${token}` },
    });
  } catch {
    return NextResponse.json({ error: "chart service unreachable" }, { status: 502 });
  }
  if (!opRes.ok) {
    const text = await opRes.text();
    return new NextResponse(text || JSON.stringify({ error: `chart service returned ${opRes.status}` }), {
      status: opRes.status,
      headers: { "content-type": opRes.headers.get("content-type") ?? "application/json" },
    });
  }
  const op = ((await opRes.json()) as { data?: { status?: string; artifact_url?: string } }).data;
  if (op?.status !== "completed" || !op.artifact_url) {
    return NextResponse.json(
      { error: `export not ready: operation is ${op?.status ?? "unknown"}` },
      { status: 409 },
    );
  }

  // 2. Stream the signed artifact. A relative FSStore path resolves against
  //    chart-service; an S3 presigned URL is already absolute.
  const artifactUrl = new URL(op.artifact_url, CHART_URL).toString();
  let upstream: Response;
  try {
    upstream = await fetch(artifactUrl);
  } catch {
    return NextResponse.json({ error: "artifact store unreachable" }, { status: 502 });
  }
  if (!upstream.ok) {
    const text = await upstream.text();
    return new NextResponse(text || JSON.stringify({ error: `artifact store returned ${upstream.status}` }), {
      status: upstream.status,
      headers: { "content-type": upstream.headers.get("content-type") ?? "application/json" },
    });
  }

  return new NextResponse(upstream.body, {
    status: upstream.status,
    headers: {
      "content-type": upstream.headers.get("content-type") ?? "text/csv; charset=utf-8",
      "content-disposition":
        upstream.headers.get("content-disposition") ??
        `attachment; filename="chart-${operationId}.csv"`,
    },
  });
}
