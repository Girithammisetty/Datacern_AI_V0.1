import { NextRequest, NextResponse } from "next/server";

/**
 * Public (unauthenticated) demo-request intake for the pre-login marketing page.
 *
 * It does something real with every valid submission: forwards the lead to a
 * configured webhook (Slack / CRM / Zapier / n8n — set DEMO_WEBHOOK_URL) and
 * always writes a structured server log so nothing is lost even if the webhook
 * is unset or down. A hidden honeypot field drops obvious bots. To wire a real
 * inbox, point DEMO_WEBHOOK_URL at your endpoint (no code change needed).
 */

export const runtime = "nodejs";

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

function clean(v: unknown, max = 300): string {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}

export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }

  // Honeypot: real users never fill a hidden "website" field; bots do.
  if (clean(body.website)) {
    return NextResponse.json({ ok: true });
  }

  const name = clean(body.name, 200);
  const email = clean(body.email, 200);
  const company = clean(body.company, 200);
  const teamSize = clean(body.teamSize, 40);
  const message = clean(body.message, 2000);

  const fields: string[] = [];
  if (name.length < 2) fields.push("name");
  if (!EMAIL_RE.test(email)) fields.push("email");
  if (company.length < 1) fields.push("company");
  if (fields.length) {
    return NextResponse.json({ ok: false, error: "validation", fields }, { status: 422 });
  }

  const lead = {
    name,
    email,
    company,
    teamSize: teamSize || null,
    message: message || null,
    source: "welcome",
    receivedAt: new Date().toISOString(),
  };

  let delivered = false;
  const hook = process.env.DEMO_WEBHOOK_URL;
  if (hook) {
    try {
      const res = await fetch(hook, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          text: `New demo request — ${lead.name} · ${lead.company} · ${lead.email}`,
          lead,
        }),
      });
      delivered = res.ok;
    } catch {
      delivered = false;
    }
  }

  // Capture server-side regardless, so a missing/broken webhook never loses a lead.
  console.info("[request-demo] lead", JSON.stringify({ ...lead, delivered }));

  return NextResponse.json({ ok: true });
}
