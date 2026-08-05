"use client";

/**
 * /welcome/walkthrough — public demo-walkthrough marketing subpage.
 *
 * Pure renderer: every sentence comes from
 * src/content/marketing/walkthrough.ts. This file owns structure, the icon
 * lookup and the illustrative step mocks (labeled as mocks where rendered).
 */

import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
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
import { Button } from "@/components/ui/button";
import { MARKETING_SHELL } from "@/content/marketing/shell";
import { WALKTHROUGH_CONTENT as C } from "@/content/marketing/walkthrough";

/* scroll-reveal (same pattern as welcome-content) */
function Reveal({
  children,
  className = "",
  delay = 0,
}: {
  children: React.ReactNode;
  className?: string;
  delay?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // no IntersectionObserver (older browsers, jsdom): show content, skip the effect
    if (typeof IntersectionObserver === "undefined") {
      setShown(true);
      return;
    }
    const io = new IntersectionObserver(
      ([e]) => {
        if (e.isIntersecting) {
          setShown(true);
          io.disconnect();
        }
      },
      { threshold: 0.12 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return (
    <div
      ref={ref}
      style={{ transitionDelay: `${delay}ms` }}
      className={`wt-reveal ${shown ? "wt-in" : ""} ${className}`}
    >
      {children}
    </div>
  );
}

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
  hi: "bg-red-500/12 text-red-700",
  md: "bg-amber-500/15 text-amber-700",
  lo: "bg-emerald-500/15 text-emerald-700",
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
        <div className="mt-2 flex items-center gap-1.5 rounded-md bg-amber-500/10 px-2.5 py-1.5 text-[11px] text-amber-700">
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
    <main id="main" className="relative isolate min-h-screen bg-background text-foreground">
      <style>{WT_CSS}</style>

      <div aria-hidden className="pointer-events-none fixed inset-0 -z-10">
        <div className="absolute inset-0 bg-[radial-gradient(80rem_50rem_at_50%_-10%,hsl(var(--primary)/0.12),transparent_60%)]" />
        <div className="wt-grid absolute inset-0" />
      </div>

      {/* header */}
      <header className="sticky top-0 z-30 border-b border-border/60 bg-background/80 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <Link href="/welcome" className="flex items-center gap-2.5">
            <DatacernLogo className="size-8" />
            <span className="text-lg font-bold tracking-tight">{MARKETING_SHELL.product}</span>
          </Link>
          <div className="flex items-center gap-3">
            <Link
              href="/welcome"
              className="hidden items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground sm:inline-flex"
            >
              <ArrowLeft className="size-3.5" /> {C.header.back}
            </Link>
            <Button asChild>
              <Link href={C.header.cta.href}>{C.header.cta.label}</Link>
            </Button>
          </div>
        </div>
      </header>

      {/* hero */}
      <section className="relative overflow-hidden">
        <div aria-hidden className="wt-mesh pointer-events-none absolute inset-0 -z-10" />
        <div className="mx-auto max-w-3xl px-6 pb-16 pt-14 text-center md:pt-20">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-primary/30 bg-primary/10 px-3 py-1 text-xs font-semibold uppercase tracking-widest text-primary">
            <Sparkles className="size-3.5" />
            {C.hero.eyebrow}
          </span>
          <h1 className="mt-6 text-balance text-4xl font-bold leading-[1.05] tracking-tight md:text-5xl">
            {C.hero.headline.lead}
            <span className="wt-grad bg-clip-text text-transparent">{C.hero.headline.accent}</span>
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
      <section className="border-t border-border/60 bg-card/50">
        <div className="mx-auto max-w-6xl px-6 py-16">
          <Reveal>
            <div className="wt-glass wt-ring mx-auto max-w-3xl rounded-2xl p-6">
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
                  <div className={`wt-glass wt-ring rounded-2xl p-5 ${i % 2 === 1 ? "md:order-1" : ""}`}>
                    <Mock />
                  </div>
                </div>
              </Reveal>
            );
          })}
        </div>
      </section>

      {/* the sandbox, honestly */}
      <section className="border-t border-border/60 bg-card/50">
        <div className="mx-auto max-w-6xl px-6 py-16">
          <Reveal>
            <h2 className="text-balance text-center text-3xl font-bold tracking-tight">
              {C.sandbox.title}
            </h2>
            <p className="mx-auto mt-3 max-w-2xl text-center text-muted-foreground">
              {C.sandbox.sub}
            </p>
          </Reveal>
          <div className="mt-10 grid gap-5 md:grid-cols-2">
            <Reveal>
              <div className="wt-glass wt-ring h-full rounded-2xl p-6">
                <h3 className="flex items-center gap-2 text-lg font-bold tracking-tight">
                  <Check className="size-5 text-primary" /> {C.sandbox.isTitle}
                </h3>
                <ul className="mt-4 space-y-2.5 text-sm text-muted-foreground">
                  {C.sandbox.is.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </div>
            </Reveal>
            <Reveal delay={80}>
              <div className="wt-glass wt-ring h-full rounded-2xl p-6">
                <h3 className="flex items-center gap-2 text-lg font-bold tracking-tight">
                  <X className="size-5 text-muted-foreground" /> {C.sandbox.isntTitle}
                </h3>
                <ul className="mt-4 space-y-2.5 text-sm text-muted-foreground">
                  {C.sandbox.isnt.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </div>
            </Reveal>
          </div>
        </div>
      </section>

      {/* closing CTA */}
      <section className="relative overflow-hidden border-t border-border/60">
        <div aria-hidden className="wt-mesh pointer-events-none absolute inset-0 -z-10 opacity-80" />
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

      <footer className="border-t border-border/60">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-2 px-6 py-6 text-xs text-muted-foreground sm:flex-row">
          <span>{MARKETING_SHELL.footer.left}</span>
          <span>{MARKETING_SHELL.footer.right}</span>
        </div>
      </footer>
    </main>
  );
}

/* trimmed copy of the welcome page's marketing CSS (wt- prefix to avoid any
 * cross-page collision); the #main token override keeps the light indigo /
 * lavender marketing palette scoped to this page. */
const WT_CSS = `
.wt-reveal{opacity:0;transform:translateY(16px);transition:opacity .6s ease,transform .6s ease;}
.wt-in{opacity:1;transform:none;}
#main{
  --background:227 69% 97%;
  --foreground:232 31% 15%;
  --card:0 0% 100%;
  --card-foreground:232 31% 15%;
  --primary:235 60% 56%;
  --primary-foreground:0 0% 100%;
  --border:243 47% 93%;
  --muted:231 62% 96%;
  --muted-foreground:229 13% 41%;
}
.wt-mesh{background:
  radial-gradient(55rem 42rem at 10% -12%, hsl(var(--primary) / 0.22), transparent 60%),
  radial-gradient(46rem 40rem at 92% -8%, hsl(255 92% 76% / 0.22), transparent 58%),
  radial-gradient(50rem 44rem at 58% 6%, hsl(218 100% 77% / 0.16), transparent 62%);}
.wt-grid{background-image:
  linear-gradient(hsl(var(--primary) / 0.06) 1px, transparent 1px),
  linear-gradient(90deg, hsl(var(--primary) / 0.06) 1px, transparent 1px);
  background-size:54px 54px;
  -webkit-mask-image:radial-gradient(120% 90% at 50% -5%, #000, transparent 72%);
  mask-image:radial-gradient(120% 90% at 50% -5%, #000, transparent 72%);}
.wt-glass{background:hsl(var(--card));
  border:1px solid hsl(var(--primary) / 0.14);}
.wt-ring{position:relative;}
.wt-ring::before{content:"";position:absolute;inset:0;border-radius:inherit;padding:1px;
  background:linear-gradient(140deg, hsl(var(--primary) / 0.35), transparent 45%, hsl(255 92% 66% / 0.35));
  -webkit-mask:linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
  -webkit-mask-composite:xor;mask-composite:exclude;pointer-events:none;}
.wt-grad{background-image:linear-gradient(100deg, hsl(var(--primary)), hsl(218 100% 72%), hsl(255 92% 76%));}
@media (prefers-reduced-motion: reduce){
  .wt-reveal{opacity:1!important;transform:none!important;}
}
`;
