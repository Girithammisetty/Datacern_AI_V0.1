/**
 * Domain-fluent rendering of a case's display_projection — the pack/dataset-
 * provided evidence summary. The projection is an arbitrary key->value map
 * authored per vertical (dispute_id/cardholder/amount/deadline_days_left …),
 * so everything here is heuristic-by-key-name and must degrade gracefully:
 * a case with no projection renders exactly as before.
 */
import { Clock } from "lucide-react";
import type { Case } from "@/lib/graphql/types";

/** Keys whose value names the subject of the decision ("who/what"). */
const WHO_KEY_HINTS = [
  "party", "cardholder", "customer", "consumer", "claimant", "patient",
  "borrower", "applicant", "insured", "seller", "supplier", "vendor",
  "carrier", "dealer", "employer", "product", "merchant", "account_name",
];
/** Keys that reference the source row / business identifier. */
const REF_KEY_RE = /(^|_)(id|number|ref|pk)$/;
/** Keys that carry a dollar/exposure figure. */
const AMOUNT_KEY_RE = /amount|exposure|cost|value|upb|assessed|claimed|recover/;
/** Keys that carry a regulatory-clock runway in days. */
const DEADLINE_KEY_RE = /deadline|days_left|days_to|runway/;

export interface ProjectionSummary {
  /** The subject line — who/what this decision is about. */
  headline: string | null;
  /** The business ref (dispute_id, case_id, …) when distinct from headline. */
  reference: string | null;
  /** Short categorical descriptors worth surfacing inline (type, reason …). */
  descriptors: string[];
  /** Formatted dollar figure, if any. */
  amount: string | null;
  /** Days remaining on the tightest regulatory clock, if any. */
  deadlineDays: number | null;
  /** The investigator briefing. */
  note: string | null;
  /** Every non-note field, for the evidence panel. */
  fields: [string, string][];
}

export function summarizeProjection(
  p: Record<string, string> | null | undefined,
): ProjectionSummary | null {
  if (!p) return null;
  const entries = Object.entries(p).filter(
    ([k, v]) => k !== "note" && v != null && String(v).trim() !== "",
  );
  if (entries.length === 0 && !p.note) return null;

  const used = new Set<string>();
  const take = (pred: (k: string, v: string) => boolean) => {
    const hit = entries.find(([k, v]) => !used.has(k) && pred(k, String(v)));
    if (hit) used.add(hit[0]);
    return hit ?? null;
  };

  const who = take((k) => WHO_KEY_HINTS.some((w) => k.includes(w)));
  const ref = take((k) => REF_KEY_RE.test(k));
  const deadline = take((k, v) => DEADLINE_KEY_RE.test(k) && isFinite(Number(v)));
  const amount = take((k, v) => AMOUNT_KEY_RE.test(k) && isFinite(Number(v)));
  // Up to two more short categorical values (severity/status handled elsewhere).
  const descriptors: string[] = [];
  for (const [k, v] of entries) {
    if (descriptors.length >= 2) break;
    if (used.has(k) || /severity|status/.test(k)) continue;
    const s = String(v);
    if (s.length <= 28 && !isFinite(Number(s))) {
      descriptors.push(s.replaceAll("_", " "));
      used.add(k);
    }
  }

  return {
    headline: who ? String(who[1]) : ref ? String(ref[1]) : String(entries[0]?.[1] ?? ""),
    reference: who && ref ? String(ref[1]) : null,
    descriptors,
    amount: amount ? formatAmount(String(amount[1])) : null,
    deadlineDays: deadline ? Number(deadline[1]) : null,
    note: p.note?.trim() || null,
    fields: entries.map(([k, v]) => [k, String(v)]),
  };
}

function formatAmount(v: string): string {
  const n = Number(v);
  if (!isFinite(n)) return v;
  return n.toLocaleString(undefined, { style: "currency", currency: "USD", maximumFractionDigits: n % 1 ? 2 : 0 });
}

/** Urgency-coloured regulatory-clock chip ("3d left"). */
export function DeadlineChip({ days }: { days: number | null | undefined }) {
  if (days == null || !isFinite(days)) return null;
  const tone =
    days <= 3
      ? "bg-destructive/15 text-destructive"
      : days <= 7
        ? "bg-amber-500/15 text-amber-700 dark:text-amber-400"
        : "bg-muted text-muted-foreground";
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${tone}`}
      title="Days remaining on the regulatory clock"
    >
      <Clock className="size-3" aria-hidden />
      {days}d left
    </span>
  );
}

/**
 * Two-line worklist cell: subject + inline facts, then the briefing note.
 * Falls back to the plain title for cases without a projection.
 */
export function CaseTitleCell({ c }: { c: Case }) {
  const s = summarizeProjection(c.displayProjection);
  if (!s) return <span className="font-medium">{c.title ?? c.urn}</span>;
  return (
    <div className="min-w-0 py-0.5">
      <div className="flex min-w-0 items-center gap-2">
        <span className="truncate font-medium">{s.headline}</span>
        {s.reference && <span className="shrink-0 font-mono text-xs text-muted-foreground">{s.reference}</span>}
        {s.descriptors.map((d) => (
          <span key={d} className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
            {d}
          </span>
        ))}
        {s.amount && <span className="shrink-0 text-xs font-medium tabular-nums">{s.amount}</span>}
        <DeadlineChip days={s.deadlineDays} />
      </div>
      {s.note && <p className="mt-0.5 truncate text-xs text-muted-foreground">{s.note}</p>}
    </div>
  );
}
