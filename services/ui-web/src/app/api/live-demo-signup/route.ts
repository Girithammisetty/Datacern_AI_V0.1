/**
 * Public, UNAUTHENTICATED self-serve demo signup (BRD 70 v1.1). Forwards
 * {full_name, work_email, company} to identity-service's public
 * POST /api/v1/public/demo-signup (rate-limited/capped/denylisted there —
 * see identity-service's handlers_public_demo.go for the abuse-prevention
 * layering; this route adds no additional gating of its own beyond what the
 * upstream call already enforces).
 *
 * identity-service's response is one of:
 *  - 201 {tenant, access_token, token_type, expires_in} — provisioning
 *    already finished (fast path); we set the SAME session cookie a real
 *    login sets and report ready:true so the visitor lands straight in the
 *    live tenant, no extra round trip.
 *  - 202 {tenant, operation_id, claim_token, claim_expires_in} —
 *    provisioning is still running (the normal case for a real deployment,
 *    since tenant provisioning is async); we stash claim_token in a
 *    short-lived httpOnly cookie (never exposed to client JS — same
 *    treatment OIDC_REFRESH_COOKIE gets) and report ready:false so the page
 *    can poll POST /api/live-demo-signup/claim until it's ready.
 *  - an error envelope (429 rate limited, 503 at capacity, 422 validation,
 *    etc.) — passed through with its status and message so the form can
 *    show a real reason, not a generic failure.
 */
import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth/session";
import { DEMO_CLAIM_COOKIE } from "./shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const IDENTITY_URL = process.env.IDENTITY_URL ?? "http://localhost:9001";

function clean(v: unknown, max = 200): string {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}

export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }

  const payload = {
    full_name: clean(body.full_name ?? body.name),
    work_email: clean(body.work_email ?? body.email),
    company: clean(body.company),
    // Honeypot: forwarded through unchanged so identity-service's own
    // handler makes the call (single source of truth for the abuse logic;
    // this route doesn't duplicate it).
    website: clean(body.website, 500),
  };

  // Best-effort caller IP for identity-service's per-IP rate limiter — this
  // is the direct peer as far as this Next.js server sees it; a real
  // deployment behind an ingress/LB is expected to set X-Forwarded-For
  // itself, in which case identity-service (which sits behind the same
  // ingress) sees the same chain either way.
  const forwardedFor = req.headers.get("x-forwarded-for") ?? req.headers.get("x-real-ip") ?? "";

  let upstream: Response;
  try {
    upstream = await fetch(`${IDENTITY_URL}/api/v1/public/demo-signup`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": forwardedFor },
      body: JSON.stringify(payload),
      cache: "no-store",
    });
  } catch {
    return NextResponse.json({ ok: false, error: "identity service unreachable" }, { status: 502 });
  }

  const json = (await upstream.json().catch(() => ({}))) as {
    tenant?: { id: string; display_name: string; status: string; profile: string } | null;
    access_token?: string;
    expires_in?: number;
    claim_token?: string;
    claim_expires_in?: number;
    error?: { code?: string; message?: string; details?: unknown };
  };

  if (!upstream.ok) {
    return NextResponse.json(
      {
        ok: false,
        error: json.error?.message ?? `signup failed (${upstream.status})`,
        code: json.error?.code,
        details: json.error?.details,
      },
      { status: upstream.status, headers: copyRetryAfter(upstream) },
    );
  }

  if (json.access_token) {
    const res = NextResponse.json({ ok: true, ready: true, tenant: json.tenant });
    res.cookies.set(SESSION_COOKIE, json.access_token, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: json.expires_in && json.expires_in > 0 ? json.expires_in : 60 * 60 * 2,
    });
    return res;
  }

  if (json.claim_token) {
    const res = NextResponse.json({ ok: true, ready: false, tenant: json.tenant });
    res.cookies.set(DEMO_CLAIM_COOKIE, json.claim_token, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/api/live-demo-signup",
      maxAge: json.claim_expires_in && json.claim_expires_in > 0 ? json.claim_expires_in : 60 * 30,
    });
    return res;
  }

  // Honeypot no-op (tenant: null, no token, no claim_token) — report success
  // without anything for a bot to learn from, mirroring /api/request-demo.
  return NextResponse.json({ ok: true, ready: false, tenant: null });
}

function copyRetryAfter(upstream: Response): HeadersInit | undefined {
  const ra = upstream.headers.get("retry-after");
  return ra ? { "retry-after": ra } : undefined;
}
