import { NextRequest, NextResponse } from "next/server";

import { fileLeadStore } from "@/lib/leads/fileStore";
import { captureLead, validateLead, type Lead } from "@/lib/leads/leads";

/**
 * Public (unauthenticated) demo-request intake for the pre-login marketing page
 * (GTM B4). Every valid submission is captured DURABLY and IDEMPOTENTLY:
 *
 *   validate + honeypot  →  dedupe + persist (LEAD_STORE_PATH JSONL, when set)
 *                        →  forward to a webhook (DEMO_WEBHOOK_URL, when set)
 *                        →  confirm to the prospect (LEAD_CONFIRM_WEBHOOK_URL)
 *
 * No single sink is required to KEEP a lead — the durable store and the webhook
 * are independent, and a duplicate email is a no-op. When nothing is
 * configured the lead is still logged and the response is honest (`captured`
 * reflects whether a durable/forwarding sink actually accepted it), so an
 * operator can see that intake is unwired rather than silently losing leads.
 *
 * Wiring: set LEAD_STORE_PATH (durable file), DEMO_WEBHOOK_URL (Slack/CRM/
 * Zapier/n8n), and optionally LEAD_CONFIRM_WEBHOOK_URL (a prospect
 * confirmation relay — e.g. an email-sending webhook) — no code change needed.
 */

export const runtime = "nodejs";

function webhookSink(url: string | undefined, shape: (lead: Lead) => unknown) {
  if (!url) return null;
  return async (lead: Lead): Promise<boolean> => {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(shape(lead)),
    });
    return res.ok;
  };
}

export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }

  const v = validateLead(body, new Date().toISOString());
  if (!v.ok) {
    if (v.reason === "honeypot") return NextResponse.json({ ok: true }); // benign to bots
    return NextResponse.json({ ok: false, error: "validation", fields: v.fields }, { status: 422 });
  }
  const lead = v.lead;

  const result = await captureLead(lead, {
    store: fileLeadStore(),
    webhook: webhookSink(process.env.DEMO_WEBHOOK_URL, (l) => ({
      text: `New demo request — ${l.name} · ${l.company} · ${l.email}`,
      lead: l,
    })),
    confirm: webhookSink(process.env.LEAD_CONFIRM_WEBHOOK_URL, (l) => ({
      to: l.email,
      subject: "Thanks for your interest in Datacern",
      template: "demo_request_confirmation",
      vars: { name: l.name, company: l.company },
    })),
  });

  // Structured log regardless — a missing/broken sink never loses the record,
  // and `captured:false` flags an entirely-unconfigured intake for the operator.
  const { dedupeKey: _k, ...safe } = lead;
  console.info("[request-demo] lead", JSON.stringify({ ...safe, ...result }));

  return NextResponse.json({ ok: true, duplicate: result.duplicate });
}
