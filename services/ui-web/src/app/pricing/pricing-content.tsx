"use client";

import { useMemo, useState } from "react";
import {
  ArrowRight,
  Check,
  Gauge,
  Info,
  Layers,
  ShieldCheck,
} from "lucide-react";
import Link from "next/link";

import { DatacernLogo } from "@/components/brand/DatacernLogo";
import { Button } from "@/components/ui/button";
import {
  computeEstimate,
  ILLUSTRATIVE_RATES,
  type PricingInput,
  type Rates,
} from "@/lib/pricing/calc";

/* ------------------------------------------------------------------ */
/* formatting helpers                                                  */
/* ------------------------------------------------------------------ */
const usd = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });
const usd0 = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const int = (n: number) => n.toLocaleString("en-US");

/* Illustrative pack menu — labels only; the operator's rate card governs price.
 * Round numbers so nothing here reads as a real quote. */
const PACKS = [
  { key: "disputes", label: "Card disputes" },
  { key: "claims", label: "Health claims" },
  { key: "aml", label: "Financial-crime alerts" },
  { key: "insurance", label: "Insurance losses" },
  { key: "invoices", label: "Supplier invoices" },
];

/* Illustrative default rates — NOT Datacern's published pricing. Deliberately
 * round so no one mistakes the estimate for a quote. An operator replaces these
 * from the active rate card. Kept here (not in the calc module) so the pure
 * math module carries zero fabricated numbers. */
const DEFAULT_RATES: Rates = {
  ...ILLUSTRATIVE_RATES,
  platformFloorUsd: 2000,
  perDecisionUsd: 0.4,
  perSeatUsd: 120,
  perPackUsd: 400,
};

function NumberField({
  label, value, onChange, min = 0, step = 1, suffix,
}: {
  label: string; value: number; onChange: (n: number) => void;
  min?: number; step?: number; suffix?: string;
}) {
  return (
    <label className="block">
      <span className="text-sm font-medium">{label}</span>
      <div className="mt-1.5 flex items-center gap-2">
        <input
          type="number"
          inputMode="numeric"
          min={min}
          step={step}
          value={Number.isFinite(value) ? value : 0}
          onChange={(e) => onChange(Number(e.target.value))}
          className="w-full rounded-lg border border-border/70 bg-background px-3 py-2 text-sm tabular-nums outline-none focus:ring-2 focus:ring-primary/40"
        />
        {suffix && <span className="shrink-0 text-xs text-muted-foreground">{suffix}</span>}
      </div>
    </label>
  );
}

export default function PricingContent() {
  const [decisionsPerMonth, setDecisions] = useState(20_000);
  const [seats, setSeats] = useState(8);
  const [packs, setPacks] = useState<string[]>(["disputes", "claims"]);
  const [capEnabled, setCapEnabled] = useState(true);
  const [budgetCapUsd, setCap] = useState(12_000);

  const input: PricingInput = useMemo(
    () => ({
      decisionsPerMonth,
      seats,
      packs,
      budgetCapUsd: capEnabled ? budgetCapUsd : null,
    }),
    [decisionsPerMonth, seats, packs, capEnabled, budgetCapUsd],
  );

  const est = useMemo(() => computeEstimate(input, DEFAULT_RATES), [input]);

  const togglePack = (key: string) =>
    setPacks((cur) => (cur.includes(key) ? cur.filter((k) => k !== key) : [...cur, key]));

  const deferred = est.capReached
    ? Math.max(0, decisionsPerMonth - est.decisionsWithinCap)
    : 0;

  return (
    <main className="min-h-screen bg-background text-foreground">
      {/* top bar */}
      <header className="sticky top-0 z-20 border-b border-border/60 bg-background/80 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-3">
          <Link href="/welcome" className="flex items-center gap-2">
            <DatacernLogo className="size-6" />
            <span className="text-sm font-semibold">Datacern AI</span>
          </Link>
          <nav className="flex items-center gap-2">
            <Link href="/welcome" className="text-sm text-muted-foreground hover:text-foreground">
              Overview
            </Link>
            <Link href="/solutions" className="text-sm text-muted-foreground hover:text-foreground">
              Solutions
            </Link>
            <Link href="/security" className="text-sm text-muted-foreground hover:text-foreground">
              Security
            </Link>
            <Button asChild size="sm">
              <Link href="/welcome">Request a demo <ArrowRight className="size-4" /></Link>
            </Button>
          </nav>
        </div>
      </header>

      {/* hero — lead with the budget-cap differentiator */}
      <section className="border-b border-border/60">
        <div className="mx-auto max-w-3xl px-6 py-16 text-center">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-primary/30 bg-primary/5 px-3 py-1 text-xs font-medium text-primary">
            <ShieldCheck className="size-3.5" aria-hidden /> Pricing with a ceiling
          </span>
          <h1 className="mt-5 text-balance text-4xl font-bold tracking-tight md:text-5xl">
            The one agentic-AI bill that can’t run away from you
          </h1>
          <p className="mx-auto mt-5 max-w-2xl text-pretty text-lg leading-relaxed text-muted-foreground">
            Most agentic products meter usage with no floor and no ceiling — spend is whatever the
            agents decide to do. A Datacern plan can be given a <strong>hard monthly budget cap</strong>:
            when it’s reached, the platform stops serving new value-delivering writes for the cycle
            rather than overspending. The number you commit to is a number, not a hope.
          </p>
          <p className="mx-auto mt-4 max-w-2xl text-sm text-muted-foreground">
            Estimate below from the levers that actually drive cost. Every figure is computed by the
            same math the platform bills on — see how the cap changes what you commit to.
          </p>
        </div>
      </section>

      {/* calculator */}
      <section className="mx-auto max-w-6xl px-6 py-14">
        <div className="grid gap-8 lg:grid-cols-[1fr_1.1fr]">
          {/* inputs */}
          <div className="space-y-6">
            <h2 className="text-lg font-semibold">Your operation</h2>

            <div className="grid gap-5 sm:grid-cols-2">
              <div className="sm:col-span-2">
                <NumberField
                  label="Governed decisions / month"
                  value={decisionsPerMonth}
                  onChange={(n) => setDecisions(Math.max(0, Math.floor(n)))}
                  step={1000}
                  suffix="decisions"
                />
                <p className="mt-1.5 flex items-center gap-1 text-xs text-muted-foreground">
                  <Gauge className="size-3.5" aria-hidden /> The primary usage meter — one per case an agent resolves or a human approves.
                </p>
              </div>
              <NumberField
                label="Named seats"
                value={seats}
                onChange={(n) => setSeats(Math.max(0, Math.floor(n)))}
                suffix="people"
              />
            </div>

            <div>
              <span className="flex items-center gap-1.5 text-sm font-medium">
                <Layers className="size-4" aria-hidden /> Domain packs
              </span>
              <div className="mt-2 flex flex-wrap gap-2">
                {PACKS.map((p) => {
                  const on = packs.includes(p.key);
                  return (
                    <button
                      key={p.key}
                      type="button"
                      onClick={() => togglePack(p.key)}
                      className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition ${
                        on
                          ? "border-primary bg-primary/10 text-primary"
                          : "border-border/70 text-muted-foreground hover:border-foreground/40"
                      }`}
                    >
                      {on && <Check className="size-3.5" aria-hidden />}
                      {p.label}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* the differentiator control */}
            <div className="rounded-xl border border-primary/30 bg-primary/[0.03] p-4">
              <label className="flex items-center gap-2.5">
                <input
                  type="checkbox"
                  checked={capEnabled}
                  onChange={(e) => setCapEnabled(e.target.checked)}
                  className="size-4 accent-[hsl(var(--primary))]"
                />
                <span className="text-sm font-semibold">Set a hard monthly budget cap</span>
              </label>
              {capEnabled && (
                <div className="mt-3">
                  <NumberField
                    label="Monthly ceiling"
                    value={budgetCapUsd}
                    onChange={(n) => setCap(Math.max(0, Math.floor(n)))}
                    step={500}
                    suffix="USD / month"
                  />
                  <p className="mt-1.5 text-xs text-muted-foreground">
                    Committed spend structurally cannot exceed this. Decisions beyond the cap defer
                    to the next cycle instead of overspending.
                  </p>
                </div>
              )}
            </div>
          </div>

          {/* estimate */}
          <div className="lg:sticky lg:top-20 lg:self-start">
            <div className="rounded-2xl border border-border/60 bg-card p-6 shadow-sm">
              <h2 className="text-lg font-semibold">Estimated monthly cost</h2>

              <dl className="mt-4 space-y-2.5 text-sm">
                <Row label="Platform floor" value={usd0(est.platformFloorUsd)} />
                <Row label={`Seats (${int(seats)})`} value={usd0(est.seatCostUsd)} />
                <Row label={`Packs (${packs.length})`} value={usd0(est.packCostUsd)} />
                <Row label={`Usage (${int(decisionsPerMonth)} decisions)`} value={usd0(est.usageCostUsd)} />
                <div className="border-t border-border/60 pt-2.5">
                  <Row
                    label="Projected (uncapped)"
                    value={usd0(est.uncappedTotalUsd)}
                    muted={est.capReached}
                    strike={est.capReached}
                  />
                </div>
              </dl>

              {/* the committed number — the promise the cap makes */}
              <div className={`mt-4 rounded-xl border p-4 ${est.capReached ? "border-primary/40 bg-primary/5" : "border-border/60 bg-muted/30"}`}>
                <div className="flex items-baseline justify-between">
                  <span className="text-sm font-medium">You commit to</span>
                  <span className="text-2xl font-bold tabular-nums">{usd0(est.committedTotalUsd)}</span>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">per month</p>
                {est.capReached ? (
                  <p className="mt-3 flex items-start gap-1.5 text-xs text-primary">
                    <ShieldCheck className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                    <span>
                      The cap binds: at these volumes projected usage would exceed your ceiling, so
                      the platform serves <strong>{int(est.decisionsWithinCap)}</strong> decisions
                      this cycle and defers <strong>{int(deferred)}</strong> to the next — you are
                      never billed past {usd0(est.committedTotalUsd)}.
                    </span>
                  </p>
                ) : (
                  <p className="mt-3 text-xs text-muted-foreground">
                    {capEnabled
                      ? "Under your ceiling — the cap isn’t binding at these volumes."
                      : "No cap set — you’d pay for whatever the agents do. Turn on a ceiling to bound it."}
                  </p>
                )}
              </div>

              <div className="mt-4 flex items-center justify-between rounded-lg bg-muted/40 px-3 py-2.5 text-sm">
                <span className="text-muted-foreground">Effective cost / decision served</span>
                <span className="font-semibold tabular-nums">{usd(est.effectiveCostPerDecisionUsd)}</span>
              </div>

              <Button asChild className="mt-5 w-full" size="lg">
                <Link href="/welcome">Get a quote for your volumes <ArrowRight className="size-4" /></Link>
              </Button>
            </div>

            {/* honesty disclosure — mirrors /welcome + /admin/value discipline */}
            <p className="mt-3 flex items-start gap-1.5 px-1 text-xs text-muted-foreground">
              <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              <span>
                <strong>Illustrative rates.</strong> The figures above use placeholder unit rates to
                show how the estimate is built — they are <em>not</em> Datacern’s published pricing.
                Your operator sets real rates from the active rate card; the calculation itself is
                the same math the platform bills on.
              </span>
            </p>
          </div>
        </div>
      </section>

      {/* what's always included */}
      <section className="border-t border-border/60 bg-muted/20">
        <div className="mx-auto max-w-6xl px-6 py-16">
          <h2 className="text-center text-2xl font-bold tracking-tight">In every plan</h2>
          <div className="mt-10 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {INCLUDED.map(([title, body]) => (
              <div key={title} className="rounded-xl border border-border/60 bg-card p-5">
                <div className="flex items-center gap-2">
                  <Check className="size-4 text-primary" aria-hidden />
                  <h3 className="text-sm font-semibold">{title}</h3>
                </div>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* pricing FAQ */}
      <section className="mx-auto max-w-3xl px-6 py-16">
        <h2 className="text-center text-2xl font-bold tracking-tight">Pricing, answered</h2>
        <div className="mt-8 space-y-4">
          {FAQ.map(([q, a]) => (
            <div key={q} className="rounded-xl border border-border/60 bg-card p-5">
              <h3 className="text-sm font-semibold">{q}</h3>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{a}</p>
            </div>
          ))}
        </div>
      </section>

      <footer className="border-t border-border/60">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-2 px-6 py-6 text-xs text-muted-foreground sm:flex-row">
          <span>Datacern AI — governed AI for regulated operations</span>
          <span>AI proposes. A named person approves. The platform remembers.</span>
        </div>
      </footer>
    </main>
  );
}

function Row({
  label, value, muted, strike,
}: { label: string; value: string; muted?: boolean; strike?: boolean }) {
  return (
    <div className="flex items-center justify-between">
      <dt className={muted ? "text-muted-foreground" : ""}>{label}</dt>
      <dd className={`tabular-nums ${strike ? "text-muted-foreground line-through" : "font-medium"}`}>{value}</dd>
    </div>
  );
}

const INCLUDED: [string, string][] = [
  ["Human approval on every write", "Agents propose; nothing takes effect until a named person approves it, and no one can approve their own work."],
  ["Tamper-evident audit trail", "Every decision leaves a receipt an examiner can follow — who, what, why and on what evidence."],
  ["Tenant isolation", "Row-level security keeps each tenant’s data its own; the platform makes no cross-tenant reads."],
  ["Governed analytics", "Business metrics defined once, reviewed, and reused — so dashboards agree and answers are grounded."],
  ["The hard budget cap", "The commercial gate refuses value-delivering writes once a plan hits its ceiling — a spend limit that’s enforced, not advisory."],
  ["Bring your own model & data", "Runs against your governed data and your permissions; the copilot can’t do anything you couldn’t do yourself."],
];

const FAQ: [string, string][] = [
  [
    "How is usage actually metered?",
    "By governed decisions — one per case an agent resolves or a human approves. It’s the unit your operation already thinks in, and every metered event is itself in the audit trail.",
  ],
  [
    "What exactly happens when the budget cap is reached?",
    "The commercial gate suspends value-delivering writes for the rest of the cycle and returns a distinct, stable signal (not a generic error) so the app can offer to raise the cap. Reads and already-approved work aren’t affected; new decision work resumes next cycle or when you lift the ceiling.",
  ],
  [
    "Are the numbers on this page your real prices?",
    "No. They’re illustrative placeholders that show how an estimate is built. Published unit rates are set per deployment from the rate card. The calculation is real; the default rates are not a quote.",
  ],
  [
    "Can fixed costs still accrue under a cap?",
    "Yes — the platform floor, seats and packs commit when a plan is active. The cap governs the variable, decision-driven spend on top of them, which is the part that can otherwise run away.",
  ],
];
