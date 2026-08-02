/**
 * Lead-capture core for the public /welcome demo-request intake (GTM B4).
 *
 * Before this module, a valid lead was forwarded to DEMO_WEBHOOK_URL if set and
 * otherwise only `console.info`'d — so an unset webhook silently dropped every
 * lead. This module makes capture durable and idempotent: validate → normalize
 * → dedupe → persist to a durable append-only store (when configured) → forward
 * to the webhook (when configured). No single sink is required for a lead to be
 * *kept*: the durable store and the webhook are independent, and the route
 * reports honestly which sinks accepted it.
 *
 * The pure functions (validate/normalize/dedupeKey/buildLead) are unit-tested
 * with no filesystem or network; the fs sink is a thin, injectable adapter.
 */

export interface LeadInput {
  name?: unknown;
  email?: unknown;
  company?: unknown;
  teamSize?: unknown;
  message?: unknown;
  website?: unknown; // honeypot
  source?: unknown;
}

export interface Lead {
  name: string;
  email: string;
  company: string;
  teamSize: string | null;
  message: string | null;
  source: string;
  receivedAt: string;
  /** Normalized email, the dedupe key (never shown to the user). */
  dedupeKey: string;
}

export type ValidationResult =
  | { ok: true; lead: Lead }
  | { ok: false; reason: "honeypot" }
  | { ok: false; reason: "validation"; fields: string[] };

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export function clean(v: unknown, max = 300): string {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}

/** The dedupe key: lower-cased, whitespace-trimmed email. Two submissions from
 * the same address collapse to one lead regardless of casing or padding. */
export function dedupeKey(email: string): string {
  return email.trim().toLowerCase();
}

/** Validate + normalize a raw submission into a Lead, or an explicit reason.
 * `receivedAt` is injected so the pure function stays deterministic in tests. */
export function validateLead(input: LeadInput, receivedAt: string): ValidationResult {
  // Honeypot: real users never fill a hidden "website" field; bots do. Return a
  // benign "handled" so a bot cannot distinguish rejection from acceptance.
  if (clean(input.website)) {
    return { ok: false, reason: "honeypot" };
  }

  const name = clean(input.name, 200);
  const email = clean(input.email, 200);
  const company = clean(input.company, 200);
  const teamSize = clean(input.teamSize, 40);
  const message = clean(input.message, 2000);

  const fields: string[] = [];
  if (name.length < 2) fields.push("name");
  if (!EMAIL_RE.test(email)) fields.push("email");
  if (company.length < 1) fields.push("company");
  if (fields.length) {
    return { ok: false, reason: "validation", fields };
  }

  return {
    ok: true,
    lead: {
      name,
      email,
      company,
      teamSize: teamSize || null,
      message: message || null,
      source: clean(input.source, 40) || "welcome",
      receivedAt,
      dedupeKey: dedupeKey(email),
    },
  };
}

/** A durable lead store. `has` powers dedupe; `append` persists. */
export interface LeadStore {
  has(dedupeKey: string): Promise<boolean>;
  append(lead: Lead): Promise<void>;
}

export interface CaptureSinks {
  /** Durable store (dedupe + persistence). Null when unconfigured. */
  store?: LeadStore | null;
  /** Forward to an external webhook (Slack/CRM/Zapier). Null when unconfigured. */
  webhook?: ((lead: Lead) => Promise<boolean>) | null;
  /** Send the prospect a confirmation. Null when unconfigured. */
  confirm?: ((lead: Lead) => Promise<boolean>) | null;
}

export interface CaptureResult {
  /** True when the lead was accepted by at least one durable sink OR the
   * webhook — i.e. it is not lost. False only when NOTHING was configured. */
  captured: boolean;
  duplicate: boolean;
  persisted: boolean;
  forwarded: boolean;
  confirmed: boolean;
}

/** Run a validated lead through the configured sinks. Idempotent: a duplicate
 * (same dedupeKey already in the store) is acknowledged but not re-persisted,
 * re-forwarded, or re-confirmed. Every sink failure degrades safely — one
 * broken sink never blocks the others, and the result reports exactly what
 * happened so the route can log/telemetry honestly. */
export async function captureLead(lead: Lead, sinks: CaptureSinks): Promise<CaptureResult> {
  const res: CaptureResult = {
    captured: false, duplicate: false, persisted: false, forwarded: false, confirmed: false,
  };

  if (sinks.store) {
    try {
      if (await sinks.store.has(lead.dedupeKey)) {
        // Already captured — idempotent no-op, but still "captured" (not lost).
        return { ...res, captured: true, duplicate: true };
      }
      await sinks.store.append(lead);
      res.persisted = true;
      res.captured = true;
    } catch {
      // Store failure must not drop the lead — fall through to the webhook.
      res.persisted = false;
    }
  }

  if (sinks.webhook) {
    try {
      res.forwarded = await sinks.webhook(lead);
      if (res.forwarded) res.captured = true;
    } catch {
      res.forwarded = false;
    }
  }

  if (sinks.confirm) {
    try {
      res.confirmed = await sinks.confirm(lead);
    } catch {
      res.confirmed = false;
    }
  }

  return res;
}
