"use client";

/**
 * /welcome/walkthrough — public demo-walkthrough marketing subpage.
 *
 * Pure renderer: every sentence comes from
 * src/content/marketing/walkthrough.ts, chrome from MarketingShell — the same
 * design system as /welcome, /solutions and /security. This file owns
 * structure, the icon lookup and the illustrative step mocks (labeled as
 * mocks where rendered).
 */

import {
  ArrowRight,
  Bot,
  Check,
  CheckCheck,
  Database,
  FileSearch,
  GraduationCap,
  History,
  ListChecks,
  Lock,
  ShieldCheck,
  Sparkles,
  UserCheck,
  X,
} from "lucide-react";
import Link from "next/link";
import { DatacernLogo } from "@/components/brand/DatacernLogo";
import { MarketingShell } from "@/components/marketing/MarketingShell";
import { Reveal } from "@/components/marketing/Reveal";
import { Button } from "@/components/ui/button";
import { WALKTHROUGH_CONTENT as C } from "@/content/marketing/walkthrough";

/* the small "this is a mock" caption every illustration carries (Rule #1) */
function MockLabel() {
  return (
    <div className="mt-3 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
      Illustrative product mock — not customer data
    </div>
  );
}

/* fact chip: a claim that is checkable in the product/repo */
function Fact({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2 text-sm text-muted-foreground">
      <ShieldCheck className="mt-0.5 size-4 shrink-0 text-primary" />
      <span>{children}</span>
    </li>
  );
}

/* ------------------------------------------------------------------ */
/* step mocks — divs, not screenshots; all labeled via <MockLabel />    */
/* ------------------------------------------------------------------ */

const RISK_CLASS: Record<string, string> = {
  hi: "bg-red-500/12 text-red-700 dark:text-red-400",
  md: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
  lo: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
};

function MockRow({ id, desc, tag, label }: { id: string; desc: string; tag: string; label: string }) {
  return (
    <div className="flex items-center gap-2.5 rounded-lg border border-border/70 bg-background/60 px-2.5 py-2">
      <span className="w-[4.75rem] shrink-0 font-mono text-[11px] font-semibold text-foreground">{id}</span>
      <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{desc}</span>
      <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold ${RISK_CLASS[tag]}`}>{label}</span>
    </div>
  );
}

function WorklistMock() {
  return (
    <div>
      <div className="space-y-2">
        <MockRow id="PAR-5001" desc="Prior auth · lumbar fusion · urgent" tag="hi" label="High" />
        <MockRow id="PAR-5002" desc="Prior auth · imaging · standard" tag="md" label="Med" />
        <MockRow id="PAR-5003" desc="Prior auth · flagged incomplete" tag="lo" label="Hold" />
      </div>
      <MockLabel />
    </div>
  );
}

function TriageMock() {
  return (
    <div>
      <div className="rounded-lg border border-border/70 bg-background/60 p-3">
        <div className="flex items-center gap-2 text-xs font-semibold">
          <Bot className="size-3.5 text-primary" />
          assistant draft — disposition proposal
        </div>
        <div className="mt-2 rounded-md bg-primary/5 px-2.5 py-2 text-xs text-foreground">
          Recommend <span className="font-semibold">approve</span> — criteria met per plan policy;
          conservative therapy documented.
        </div>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {["Clinical notes p.2", "Plan policy §4.1", "Confidence: high"].map((c) => (
            <span key={c} className="rounded-full border border-border/70 px-2 py-0.5 text-[10px] text-muted-foreground">
              {c}
            </span>
          ))}
        </div>
        <div className="mt-2 flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <Lock className="size-3 shrink-0" />
          Proposal only — nothing happens until a person approves.
        </div>
      </div>
      <MockLabel />
    </div>
  );
}

function ApprovalMock() {
  return (
    <div>
      <div className="rounded-lg border border-border/70 bg-background/60 p-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 text-xs">
            <span className="font-mono font-semibold">PAR-5001</span>
            <span className="text-muted-foreground">proposed by assistant</span>
          </div>
          <div className="flex gap-1.5">
            <span className="flex items-center gap-1 rounded-md bg-primary px-2 py-1 text-[10px] font-bold text-primary-foreground">
              <Check className="size-3" /> Approve
            </span>
            <span className="flex items-center gap-1 rounded-md border border-border/70 px-2 py-1 text-[10px] font-bold text-muted-foreground">
              <X className="size-3" /> Reject
            </span>
          </div>
        </div>
        <div className="mt-2 flex items-center gap-1.5 rounded-md bg-amber-500/10 px-2.5 py-1.5 text-[11px] text-amber-700 dark:text-amber-400">
          <Lock className="size-3 shrink-0" />
          Approving your own proposal is rejected by the server — a different person must sign.
        </div>
      </div>
      <MockLabel />
    </div>
  );
}

function LearningMock() {
  const steps: [React.ElementType, string][] = [
    [UserCheck, "Human correction"],
    [Database, "Labeled example"],
    [GraduationCap, "Model trained (MLflow)"],
    [CheckCheck, "Promoted — four-eyes"],
  ];
  return (
    <div>
      <div className="flex flex-wrap items-center gap-1.5">
        {steps.map(([Icon, label], i) => (
          <div key={label} className="flex items-center gap-1.5">
            <span className="flex items-center gap-1.5 rounded-lg border border-border/70 bg-background/60 px-2.5 py-1.5 text-[11px] font-medium">
              <Icon className="size-3.5 text-primary" />
              {label}
            </span>
            {i < steps.length - 1 && <ArrowRight className="size-3.5 text-muted-foreground" />}
          </div>
        ))}
      </div>
      <MockLabel />
    </div>
  );
}

function AuditMock() {
  const rows: [string, string, string][] = [
    ["proposal.created", "agent: case-triage", "evidence attached"],
    ["proposal.approved", "reviewer (human)", "distinct from proposer"],
    ["disposition.applied", "system", "hash-chained event"],
  ];
  return (
    <div>
      <div className="space-y-2">
        {rows.map(([ev, actor, note]) => (
          <div key={ev} className="flex items-center gap-2.5 rounded-lg border border-border/70 bg-background/60 px-2.5 py-2 text-xs">
            <History className="size-3.5 shrink-0 text-primary" />
            <span className="font-mono font-semibold">{ev}</span>
            <span className="min-w-0 flex-1 truncate text-muted-foreground">{actor}</span>
            <span className="shrink-0 text-[10px] text-muted-foreground">{note}</span>
          </div>
        ))}
      </div>
      <MockLabel />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* step icon + mock lookup — config stores the `icon` key, never React  */
/* ------------------------------------------------------------------ */

const STEP_VISUALS: Record<string, { Icon: React.ElementType; Mock: React.ComponentType }> = {
  worklist: { Icon: ListChecks, Mock: WorklistMock },
  triage: { Icon: FileSearch, Mock: TriageMock },
  approval: { Icon: UserCheck, Mock: ApprovalMock },
  learning: { Icon: GraduationCap, Mock: LearningMock },
  audit: { Icon: History, Mock: AuditMock },
};

/* ------------------------------------------------------------------ */
/* page                                                                */
/* ------------------------------------------------------------------ */
export default function WalkthroughContent() {
  return (
    <MarketingShell active="/welcome">
      {/* hero */}
      <section className="relative overflow-hidden border-b border-border/60">
        <div aria-hidden className="mk-mesh pointer-events-none absolute inset-0 -z-10" />
        <div className="mx-auto max-w-3xl px-6 py-16 text-center">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-primary/30 bg-primary/10 px-3 py-1 text-xs font-semibold uppercase tracking-widest text-primary">
            <Sparkles className="size-3.5" />
            {C.hero.eyebrow}
          </span>
          <h1 className="mt-6 text-balance text-4xl font-bold leading-[1.05] tracking-tight md:text-5xl">
            {C.hero.headline.lead}
            <span className="mk-grad">{C.hero.headline.accent}</span>
          </h1>
          <p className="mx-auto mt-6 max-w-2xl text-pretty text-lg leading-relaxed text-muted-foreground">
            {C.hero.sub}
          </p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <Button asChild size="lg">
              <Link href={C.hero.ctaPrimary.href}>
                {C.hero.ctaPrimary.label} <ArrowRight className="size-4" />
              </Link>
            </Button>
            <Button asChild size="lg" variant="outline">
              <Link href={C.hero.ctaSecondary.href}>{C.hero.ctaSecondary.label}</Link>
            </Button>
          </div>
        </div>
      </section>

      {/* the refusal — the honesty beat, deliberately first */}
      <section className="border-b border-border/60 bg-card/40">
        <div className="mx-auto max-w-6xl px-6 py-14">
          <Reveal>
          <div className="mk-glass mk-ring mx-auto max-w-3xl rounded-2xl p-6">
            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-widest text-primary">
              <ShieldCheck className="size-4" />
              {C.refusal.eyebrow}
            </div>
            <p className="mt-3 text-pretty leading-relaxed text-muted-foreground">
              {C.refusal.pre}
              <span className="font-semibold text-foreground">{C.refusal.emphasis}</span>
              {C.refusal.post}
            </p>
          </div>
          </Reveal>
        </div>
      </section>

      {/* the five steps */}
      <section className="mx-auto max-w-6xl px-6 py-16">
        <div className="space-y-14">
          {C.steps.map((s, i) => {
            const { Icon, Mock } = STEP_VISUALS[s.icon];
            return (
              <Reveal key={s.title}>
              <div className="grid items-start gap-8 md:grid-cols-2">
                <div className={i % 2 === 1 ? "md:order-2" : ""}>
                  <div className="flex items-center gap-3">
                    <span className="flex size-11 items-center justify-center rounded-xl bg-primary/10 text-primary">
                      <Icon className="size-5" />
                    </span>
                    <div>
                      <div className="text-xs font-semibold uppercase tracking-widest text-primary">
                        {C.stepLabel.replace("{n}", String(i + 1)).replace("{total}", String(C.steps.length))}
                      </div>
                      <h2 className="text-2xl font-bold tracking-tight">{s.title}</h2>
                    </div>
                  </div>
                  <p className="mt-4 text-pretty leading-relaxed text-muted-foreground">{s.body}</p>
                  <ul className="mt-4 space-y-2">
                    {s.facts.map((f) => (
                      <Fact key={f}>{f}</Fact>
                    ))}
                  </ul>
                </div>
                <div className={`mk-glass mk-ring rounded-2xl p-5 ${i % 2 === 1 ? "md:order-1" : ""}`}>
                  <Mock />
                </div>
              </div>
              </Reveal>
            );
          })}
        </div>
      </section>

      {/* the sandbox, honestly */}
      <section className="border-t border-border/60 bg-card/40">
        <div className="mx-auto max-w-6xl px-6 py-16">
          <h2 className="text-balance text-center text-3xl font-bold tracking-tight">
            {C.sandbox.title}
          </h2>
          <p className="mx-auto mt-3 max-w-2xl text-center text-muted-foreground">
            {C.sandbox.sub}
          </p>
          <div className="mt-10 grid gap-5 md:grid-cols-2">
            <div className="mk-glass mk-ring h-full rounded-2xl p-6">
              <h3 className="flex items-center gap-2 text-lg font-bold tracking-tight">
                <Check className="size-5 text-primary" /> {C.sandbox.isTitle}
              </h3>
              <ul className="mt-4 space-y-2.5 text-sm text-muted-foreground">
                {C.sandbox.is.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </div>
            <div className="mk-glass mk-ring h-full rounded-2xl p-6">
              <h3 className="flex items-center gap-2 text-lg font-bold tracking-tight">
                <X className="size-5 text-muted-foreground" /> {C.sandbox.isntTitle}
              </h3>
              <ul className="mt-4 space-y-2.5 text-sm text-muted-foreground">
                {C.sandbox.isnt.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      </section>

      {/* closing CTA */}
      <section className="relative overflow-hidden border-t border-border/60">
        <div aria-hidden className="mk-mesh pointer-events-none absolute inset-0 -z-10 opacity-80" />
        <div className="mx-auto flex max-w-6xl flex-col items-center gap-5 px-6 py-20 text-center">
          <DatacernLogo className="size-12 drop-shadow-[0_0_28px_hsl(var(--primary)/0.6)]" />
          <h2 className="text-balance text-3xl font-bold tracking-tight md:text-4xl">
            {C.closing.title}
          </h2>
          <p className="max-w-xl text-pretty text-muted-foreground">{C.closing.body}</p>
          <div className="mt-2 flex flex-wrap items-center justify-center gap-3">
            <Button asChild size="lg">
              <Link href={C.closing.ctaPrimary.href}>
                {C.closing.ctaPrimary.label} <ArrowRight className="size-4" />
              </Link>
            </Button>
            <Button asChild size="lg" variant="outline">
              <Link href={C.closing.ctaSecondary.href}>{C.closing.ctaSecondary.label}</Link>
            </Button>
          </div>
        </div>
      </section>
    </MarketingShell>
  );
}
