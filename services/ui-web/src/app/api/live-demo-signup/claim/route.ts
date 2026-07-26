/**
 * Polled by the /live-demo page while a self-serve demo tenant is still
 * provisioning (BRD 70 v1.1). Reads the short-lived claim_token stashed by
 * POST /api/live-demo-signup (httpOnly, path-scoped, never exposed to
 * client JS) and forwards it as a Bearer to identity-service's
 * POST /api/v1/public/demo-signup/claim.
 *
 * Response shapes:
 *  - 200 {ok:true, ready:true, tenant} + sets the real session cookie once
 *    identity-service reports the tenant is active and the owner user
 *    exists — the page redirects into the live app.
 *  - 202 {ok:true, ready:false, tenant} — still provisioning, keep polling.
 *  - 401 {ok:false, error} — the claim_token is missing/expired (e.g. the
 *    visitor left the tab open past claim_expires_in); the page should tell
 *    them to sign up again rather than poll forever.
 */
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { SESSION_COOKIE } from "@/lib/auth/session";
import { DEMO_CLAIM_COOKIE } from "../shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const IDENTITY_URL = process.env.IDENTITY_URL ?? "http://localhost:9001";

export async function POST() {
  const jar = await cookies();
  const claimToken = jar.get(DEMO_CLAIM_COOKIE)?.value;
  if (!claimToken) {
    return NextResponse.json({ ok: false, error: "no pending demo signup to claim" }, { status: 401 });
  }

  let upstream: Response;
  try {
    upstream = await fetch(`${IDENTITY_URL}/api/v1/public/demo-signup/claim`, {
      method: "POST",
      headers: { authorization: `Bearer ${claimToken}` },
      cache: "no-store",
    });
  } catch {
    return NextResponse.json({ ok: false, error: "identity service unreachable" }, { status: 502 });
  }

  const json = (await upstream.json().catch(() => ({}))) as {
    tenant?: { id: string; display_name: string; status: string; profile: string };
    ready?: boolean;
    access_token?: string;
    expires_in?: number;
    error?: { code?: string; message?: string };
  };

  if (upstream.status === 401) {
    const res = NextResponse.json({ ok: false, error: json.error?.message ?? "claim link expired" }, { status: 401 });
    res.cookies.delete(DEMO_CLAIM_COOKIE);
    return res;
  }
  if (!upstream.ok) {
    return NextResponse.json({ ok: false, error: json.error?.message ?? `claim failed (${upstream.status})` }, { status: upstream.status });
  }

  if (json.ready && json.access_token) {
    const res = NextResponse.json({ ok: true, ready: true, tenant: json.tenant });
    res.cookies.set(SESSION_COOKIE, json.access_token, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: json.expires_in && json.expires_in > 0 ? json.expires_in : 60 * 60 * 2,
    });
    res.cookies.delete(DEMO_CLAIM_COOKIE);
    return res;
  }

  return NextResponse.json({ ok: true, ready: false, tenant: json.tenant }, { status: 202 });
}
