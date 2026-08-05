"use client";

import { forwardRef, useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  BarChart3,
  Bot,
  Building2,
  Check,
  ChevronDown,
  Cpu,
  HeartPulse,
  History,
  Landmark,
  ListChecks,
  MessageSquareText,
  Network,
  Scale,
  ShieldCheck,
  Sparkles,
  Umbrella,
  Users,
  Workflow,
  X,
} from "lucide-react";
import Link from "next/link";
import { DatacernLogo } from "@/components/brand/DatacernLogo";
import { ArchitectureDiagrams } from "@/components/marketing/ArchitectureDiagrams";
import { DecisionLoopDiagram } from "@/components/marketing/DecisionLoopDiagram";
import { Button } from "@/components/ui/button";
import { SOLUTION_PACK_COUNT } from "@/content/marketing/packs.gen";
import { MARKETING_SHELL } from "@/content/marketing/shell";
import {
  WELCOME_CONTENT as C,
  type WelcomeIndustry,
  type WelcomeWfRow,
} from "@/content/marketing/welcome";

/* Pure renderer: every sentence comes from src/content/marketing/welcome.ts.
 * This file owns only structure, icons (looked up by config keys) and the
 * illustrative product mocks — which are diagram components, labeled as mocks
 * where rendered. */

type IconType = React.ComponentType<{ className?: string }>;

/* icon lookups for config keys — config stores strings, never components */
const CAP_ICONS: Record<string, IconType> = {
  agents: Bot,
  worklist: ListChecks,
  copilot: MessageSquareText,
  entity: Network,
  decisions: Workflow,
  analytics: BarChart3,
  audit: History,
  ml: Cpu,
};

const INDUSTRY_ICONS: Record<string, IconType> = {
  healthcare: HeartPulse,
  banking: Landmark,
  insurance: Umbrella,
  "risk-ops": Scale,
};

/* ------------------------------------------------------------------ */
/* scroll-reveal (dependency-free)                                     */
/* ------------------------------------------------------------------ */
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
      className={`wr-reveal ${shown ? "wr-in" : ""} ${className}`}
    >
      {children}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* small illustrative product mocks (divs, not screenshots)            */
/* ------------------------------------------------------------------ */
function Dot({ className = "" }: { className?: string }) {
  return <span className={`inline-block size-1.5 rounded-full ${className}`} />;
}

function HeroMock() {
  return (
    <div className="wr-float relative w-full max-w-md">
      <div className="absolute -inset-6 -z-10 rounded-[2.5rem] bg-gradient-to-tr from-primary/30 via-[#a78bfa]/25 to-[#8ab4ff]/20 blur-3xl" />
      <div className="wr-glass wr-ring wr-glow rounded-2xl p-5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
            <Bot className="size-4 text-primary" />
            Claims Triage Agent
          </div>
          <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-primary">
            Proposal
          </span>
        </div>
        <div className="mt-4">
          <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Recommended disposition</div>
          <div className="mt-1 text-base font-semibold">Deny — duplicate submission</div>
        </div>
        <div className="mt-3">
          <div className="flex items-center justify-between text-[11px] text-muted-foreground">
            <span>Confidence</span>
            <span className="font-medium text-foreground">High</span>
          </div>
          <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-muted">
            <div className="wr-grow h-full rounded-full bg-primary" />
          </div>
        </div>
        <div className="mt-4 space-y-1.5">
          {["Matches a prior claim on policy + invoice", "Same claimant and amount as the earlier submission"].map((e) => (
            <div key={e} className="flex items-start gap-2 text-xs text-muted-foreground">
              <Check className="mt-0.5 size-3.5 shrink-0 text-primary" />
              {e}
            </div>
          ))}
        </div>
        <div className="mt-5 flex items-center gap-2">
          <div className="flex-1 rounded-md bg-primary px-3 py-2 text-center text-xs font-semibold text-primary-foreground">
            Approve
          </div>
          <div className="flex-1 rounded-md border border-border px-3 py-2 text-center text-xs font-semibold text-foreground">
            Adjust
          </div>
        </div>
        <div className="mt-3 flex items-center gap-1.5 text-[10px] text-muted-foreground">
          <ShieldCheck className="size-3" />
          Logged with evidence · you decide
        </div>
      </div>
    </div>
  );
}

function CapVisual({ k }: { k: string }) {
  if (k === "agents")
    return (
      <div className="grid grid-cols-2 gap-2">
        {["Triage", "Analytics", "ML Engineer", "Governance"].map((a, i) => (
          <div key={a} className="flex items-center gap-2 rounded-lg border border-border/70 bg-background/70 p-3 text-xs">
            <span className="flex size-6 items-center justify-center rounded-md bg-primary/10 text-primary">
              <Bot className="size-3.5" />
            </span>
            <span className="font-medium">{a}</span>
            <Dot className={`ml-auto ${i % 2 ? "bg-primary" : "bg-[#a78bfa]"} wr-pulse`} />
          </div>
        ))}
      </div>
    );
  if (k === "worklist")
    return <WorklistRows />;
  if (k === "copilot")
    return (
      <div className="space-y-2">
        <div className="ml-auto w-4/5 rounded-2xl rounded-br-sm bg-primary px-3 py-2 text-xs text-primary-foreground">
          Which denials spiked this week, and why?
        </div>
        <div className="w-11/12 rounded-2xl rounded-bl-sm border border-border/70 bg-background/70 px-3 py-2 text-xs text-muted-foreground">
          Timely-filing denials rose on two payers. <span className="font-medium text-foreground">Draft a rule to auto-flag them?</span>
        </div>
        <div className="flex gap-2">
          <span className="rounded-md bg-primary/10 px-2 py-1 text-[10px] font-semibold text-primary">Propose rule</span>
          <span className="rounded-md border border-border px-2 py-1 text-[10px] text-muted-foreground">Open worklist</span>
        </div>
      </div>
    );
  if (k === "entity")
    return (
      <div className="flex items-center justify-between gap-2">
        <div className="space-y-1.5">
          {["V. Petrov · sys A", "Viktor P. · sys B", "Petrov, V · sys C"].map((r) => (
            <div key={r} className="rounded-md border border-border/70 bg-background/70 px-2.5 py-1.5 text-[11px] text-muted-foreground">
              {r}
            </div>
          ))}
        </div>
        <ArrowRight className="size-4 shrink-0 text-primary" />
        <div className="rounded-xl border border-primary/40 bg-primary/5 px-3 py-3 text-center">
          <Network className="mx-auto size-5 text-primary" />
          <div className="mt-1 text-xs font-semibold">One resolved entity</div>
          <div className="text-[10px] text-muted-foreground">full exposure</div>
        </div>
      </div>
    );
  if (k === "decisions")
    return (
      <div className="space-y-1.5 font-mono text-[11px]">
        {[
          ["IF", "exposure ≥ threshold", "→ escalate"],
          ["IF", "duplicate = true", "→ deny"],
          ["ELSE", "", "→ standard review"],
        ].map(([a, b, c], i) => (
          <div key={i} className="flex items-center gap-2 rounded-md border border-border/70 bg-background/70 px-2.5 py-1.5">
            <span className="font-semibold text-primary">{a}</span>
            <span className="text-muted-foreground">{b}</span>
            <span className="ml-auto font-medium text-foreground">{c}</span>
          </div>
        ))}
      </div>
    );
  if (k === "analytics")
    return (
      <div>
        <div className="flex items-end gap-1.5">
          {[45, 70, 40, 90, 60, 80].map((h, i) => (
            <div key={i} className="flex-1 rounded-t bg-primary/70" style={{ height: `${h}px` }} />
          ))}
        </div>
        <div className="mt-2 grid grid-cols-3 gap-2">
          {["Denial rate", "Clean-claim", "A/R days"].map((t) => (
            <div key={t} className="rounded-md border border-border/70 bg-background/70 px-2 py-1.5 text-center text-[10px] text-muted-foreground">
              {t}
            </div>
          ))}
        </div>
      </div>
    );
  if (k === "audit")
    return (
      <div className="space-y-2.5">
        {[
          ["Agent proposed", "disposition drafted · evidence attached"],
          ["A. Chen approved", "second reviewer signed off"],
          ["Action executed", "logged to the immutable trail"],
        ].map(([title, sub]) => (
          <div key={title} className="flex items-start gap-2.5 text-xs">
            <Check className="mt-0.5 size-4 shrink-0 text-primary" />
            <div>
              <div className="font-semibold text-foreground">{title}</div>
              <div className="text-muted-foreground">{sub}</div>
            </div>
          </div>
        ))}
      </div>
    );
  // ml
  return (
    <div className="flex items-center gap-1.5 text-[11px]">
      {["Train", "Evaluate", "Promote"].map((s, i) => (
        <div key={s} className="flex items-center gap-1.5">
          <span className={`rounded-md border px-2.5 py-1.5 font-medium ${i === 2 ? "border-primary/40 bg-primary/10 text-primary" : "border-border/70 bg-background/70 text-muted-foreground"}`}>
            {s}
          </span>
          {i < 2 && <ArrowRight className="size-3 text-muted-foreground" />}
        </div>
      ))}
    </div>
  );
}

/* shared case-row mockup: risk tag + human-reviewer avatar chip, reused by
 * both the "worklist" capability tab and each industry spotlight's
 * "In your workflow" panel. Rows come from config and are clearly illustrative
 * placeholder data (Rule #1 — no invented stats presented as real). */
const TAG_LABEL: Record<WelcomeWfRow[2], string> = { hi: "High", md: "Med", lo: "Low" };
const TAG_CLASS: Record<WelcomeWfRow[2], string> = {
  hi: "bg-red-500/12 text-red-700 dark:text-red-400",
  md: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
  lo: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
};

function WfRowItem({ row }: { row: WelcomeWfRow }) {
  const [id, desc, tag, initials] = row;
  return (
    <div className="flex items-center gap-2.5 rounded-lg border border-border/70 bg-background/60 px-2.5 py-2 transition-transform hover:translate-x-0.5">
      <span className="w-[4.75rem] shrink-0 font-mono text-[11px] font-semibold text-foreground">{id}</span>
      <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{desc}</span>
      <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold ${TAG_CLASS[tag]}`}>{TAG_LABEL[tag]}</span>
      <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary text-[10px] font-bold text-primary-foreground">
        {initials}
      </span>
    </div>
  );
}

function WorklistRows() {
  const rows: WelcomeWfRow[] = [
    ["#48213", "Prior auth · duplicate flag", "hi", "VP"],
    ["#48219", "Appeal · missing docs", "md", "AC"],
    ["#48224", "Claim · ready to pay", "lo", "JR"],
  ];
  return (
    <div className="space-y-2">
      {rows.map((r) => (
        <WfRowItem key={r[0]} row={r} />
      ))}
    </div>
  );
}

/* per-industry deep dive: pick a sub-vertical (segment), then flip between
 * its "Solutions that ship" and "In your workflow" views. Segments are the
 * real sub-verticals a buyer actually navigates by (e.g. Healthcare's Payer
 * vs. Provider vs. Pharmacy teams run different queues) — so this is the
 * primary intra-industry navigation, not decoration. */
function IndustryShipsCard({ ind }: { ind: WelcomeIndustry }) {
  const [segIdx, setSegIdx] = useState(0);
  const [view, setView] = useState<"solutions" | "workflow">("solutions");
  const seg = ind.segments[segIdx];

  return (
    <div className="wr-glass wr-ring rounded-2xl p-6 shadow-[0_24px_70px_-40px_hsl(var(--primary)/0.5)]">
      {ind.segments.length > 1 && (
        <div role="tablist" aria-label={`${ind.name} sub-verticals`} className="flex flex-wrap gap-1.5">
          {ind.segments.map((s, i) => (
            <button
              key={s.id}
              type="button"
              role="tab"
              aria-selected={i === segIdx}
              onClick={() => setSegIdx(i)}
              className={`rounded-full border px-3 py-1 text-xs font-semibold transition-colors ${
                i === segIdx
                  ? "border-primary/50 bg-primary text-primary-foreground"
                  : "border-border/70 bg-background/60 text-muted-foreground hover:border-primary/30"
              }`}
            >
              {s.name}
            </button>
          ))}
        </div>
      )}

      <div className={`flex gap-1.5 ${ind.segments.length > 1 ? "mt-3" : ""}`}>
        <button
          type="button"
          onClick={() => setView("solutions")}
          className={`flex-1 rounded-lg border px-2.5 py-2 text-xs font-semibold transition-colors ${
            view === "solutions"
              ? "border-primary/50 bg-primary/10 text-primary"
              : "border-border/70 text-muted-foreground hover:border-primary/30"
          }`}
        >
          {C.spotlights.solutionsTab}
        </button>
        <button
          type="button"
          onClick={() => setView("workflow")}
          className={`flex flex-1 items-center justify-center gap-1.5 rounded-lg border px-2.5 py-2 text-xs font-semibold transition-colors ${
            view === "workflow"
              ? "border-primary/50 bg-primary/10 text-primary"
              : "border-border/70 text-muted-foreground hover:border-primary/30"
          }`}
        >
          <Users className="size-3.5" />
          {C.spotlights.workflowTab}
        </button>
      </div>

      {view === "solutions" ? (
        <ul key={seg.id} className="wr-swap mt-5 space-y-4">
          {seg.useCases.map(([name, body]) => (
            <li key={name} className="flex gap-3">
              <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
                <Check className="size-3.5" />
              </span>
              <div>
                <div className="text-sm font-semibold leading-snug">{name}</div>
                <div className="mt-0.5 text-sm leading-relaxed text-muted-foreground">{body}</div>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <div key={seg.id} className="wr-swap mt-5">
          {/* Rule #1: the stat tiles below are a product mock, and the rendered
           * page must say so — not just this comment. */}
          <div className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
            {C.spotlights.mockLabel}
          </div>
          <div className="grid grid-cols-3 gap-2">
            {seg.workflow.kpis.map(([label, value]) => (
              <div key={label} className="rounded-lg border border-border/70 bg-background/60 px-2 py-2 text-center">
                <div className="text-sm font-bold text-foreground">{value}</div>
                <div className="mt-0.5 text-[10px] uppercase leading-tight tracking-wide text-muted-foreground">{label}</div>
              </div>
            ))}
          </div>
          <div className="mt-3 space-y-2">
            {seg.workflow.rows.map((r) => (
              <WfRowItem key={r[0]} row={r} />
            ))}
          </div>
          <div className="mt-4 flex items-center gap-2 text-xs text-muted-foreground">
            <Check className="size-3.5 shrink-0 text-primary" />
            {C.spotlights.reviewNote}
          </div>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* page                                                                */
/* ------------------------------------------------------------------ */
export default function WelcomeContent() {
  const [tab, setTab] = useState(0);
  const [auto, setAuto] = useState(true);
  const [faq, setFaq] = useState<number | null>(0);
  const [demoOpen, setDemoOpen] = useState(false);

  useEffect(() => {
    if (!auto) return;
    // eslint-disable-next-line no-restricted-syntax -- decorative tab carousel on the pre-login marketing page; not data polling (UI-FR-012 targets SSE-vs-poll for live data)
    const t = setInterval(() => setTab((v) => (v + 1) % C.caps.length), 4200);
    return () => clearInterval(t);
  }, [auto]);

  const Cap = C.caps[tab];

  return (
    <main id="main" className="relative isolate min-h-screen bg-background text-foreground">
      <style>{WR_CSS}</style>

      {/* page-wide next-gen backdrop: deep gradient wash + subtle grid + drifting aurora */}
      <div aria-hidden className="pointer-events-none fixed inset-0 -z-10">
        <div className="absolute inset-0 bg-[radial-gradient(80rem_50rem_at_50%_-10%,hsl(var(--primary)/0.12),transparent_60%)]" />
        <div className="wr-grid absolute inset-0" />
        <div className="wr-aurora absolute -top-40 left-1/2 h-[38rem] w-[70rem] -translate-x-1/2 rounded-full opacity-60" />
      </div>

      {/* header */}
      <header className="sticky top-0 z-30 border-b border-border/60 bg-background/80 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <div className="flex items-center gap-2.5">
            <DatacernLogo className="size-8" />
            <span className="text-lg font-bold tracking-tight">{MARKETING_SHELL.product}</span>
          </div>
          <nav className="hidden items-center gap-7 text-sm text-muted-foreground md:flex">
            {C.header.anchors.map((n) =>
              n.href.startsWith("#") ? (
                <a key={n.href} href={n.href} className="transition-colors hover:text-foreground">
                  {n.label}
                </a>
              ) : (
                <Link key={n.href} href={n.href} className="transition-colors hover:text-foreground">
                  {n.label}
                </Link>
              ),
            )}
          </nav>
          <div className="flex items-center gap-4">
            <Link
              href="/login"
              className="text-sm text-muted-foreground transition-colors hover:text-foreground"
            >
              {C.header.signIn}
            </Link>
            <Button onClick={() => setDemoOpen(true)}>{C.header.demoCta}</Button>
          </div>
        </div>
      </header>

      {/* hero */}
      <section className="relative overflow-hidden">
        <div aria-hidden className="wr-mesh pointer-events-none absolute inset-0 -z-10" />
        <div className="mx-auto grid max-w-6xl items-center gap-12 px-6 pb-20 pt-14 md:grid-cols-2 md:pt-20">
          <div>
            <span className="inline-flex items-center gap-1.5 rounded-full border border-primary/30 bg-primary/10 px-3 py-1 text-xs font-semibold uppercase tracking-widest text-primary">
              <Sparkles className="size-3.5" />
              {C.hero.eyebrow}
            </span>
            <h1 className="wr-glowtext mt-6 text-balance text-4xl font-bold leading-[1.03] tracking-tight md:text-6xl">
              {C.hero.headline.line1}
              <br />
              {C.hero.headline.line2Lead}
              <span className="wr-grad bg-clip-text text-transparent">{C.hero.headline.line2Accent}</span>
            </h1>
            <p className="mt-6 max-w-xl text-pretty text-lg leading-relaxed text-muted-foreground">
              {C.hero.sub}
            </p>
            <div className="mt-9 flex flex-wrap items-center gap-3">
              <Button size="lg" onClick={() => setDemoOpen(true)}>
                {C.header.demoCta} <ArrowRight className="size-4" />
              </Button>
              <Button asChild size="lg" variant="outline">
                <a href={C.hero.ctaSecondary.href}>{C.hero.ctaSecondary.label}</a>
              </Button>
            </div>
            <p className="mt-6 text-sm text-muted-foreground">{C.hero.assurance}</p>
            <p className="mt-3 text-sm">
              <Link
                href={C.hero.liveDemo.href}
                className="inline-flex items-center gap-1 font-medium text-primary underline-offset-2 hover:underline"
              >
                {C.hero.liveDemo.label} <ArrowRight className="size-3.5" />
              </Link>
              <span className="ml-1.5 text-muted-foreground">{C.hero.liveDemo.note}</span>
            </p>
            <p className="mt-2 text-sm">
              <Link
                href={C.hero.walkthrough.href}
                className="inline-flex items-center gap-1 font-medium text-primary underline-offset-2 hover:underline"
              >
                {C.hero.walkthrough.label} <ArrowRight className="size-3.5" />
              </Link>
              <span className="ml-1.5 text-muted-foreground">{C.hero.walkthrough.note}</span>
            </p>
          </div>
          <div className="flex justify-center md:justify-end">
            <HeroMock />
          </div>
        </div>

        {/* moving agent roster — the agentic workforce */}
        <div className="border-y border-border/60 bg-card/40 py-4">
          <div className="mx-auto max-w-6xl overflow-hidden px-6">
            <div className="flex items-center gap-3">
              <span className="flex shrink-0 items-center gap-1.5 text-xs font-semibold uppercase tracking-widest text-primary">
                <Sparkles className="size-3.5" />
                {C.agentsMarquee.eyebrow}
              </span>
              <div className="wr-marquee-wrap flex-1">
                <div className="wr-marquee flex gap-2">
                  {[...C.agentsMarquee.agents, ...C.agentsMarquee.agents].map(([name, role], i) => (
                    <span
                      key={i}
                      className="flex shrink-0 items-center gap-1.5 rounded-full border border-border/70 bg-background px-3 py-1.5 text-xs"
                    >
                      <Bot className="size-3.5 shrink-0 text-primary" />
                      <span className="font-medium text-foreground">{name}</span>
                      <span className="text-muted-foreground">— {role}</span>
                    </span>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* industries — the primary way in */}
      <section id="industries" className="mx-auto max-w-6xl scroll-mt-20 px-6 py-20">
        <Reveal>
          <span className="inline-flex items-center gap-1.5 rounded-full border border-primary/30 bg-primary/10 px-3 py-1 text-xs font-semibold uppercase tracking-widest text-primary">
            <Sparkles className="size-3.5" />
            {C.industriesIntro.eyebrow}
          </span>
          <h2 className="mt-5 text-balance text-3xl font-bold tracking-tight md:text-4xl">
            {C.industriesIntro.title}
          </h2>
          <p className="mt-3 max-w-2xl text-muted-foreground">{C.industriesIntro.sub}</p>
        </Reveal>

        <div className="mt-9 text-xs font-semibold uppercase tracking-widest text-muted-foreground">
          {C.industriesIntro.flagshipLabel}
        </div>
        <div className="mt-4 grid gap-5 sm:grid-cols-2">
          {C.industries.map((ind, i) => {
            const Icon = INDUSTRY_ICONS[ind.id] ?? Building2;
            return (
              <Reveal key={ind.id} delay={(i % 2) * 80}>
                <a
                  href={`#ind-${ind.id}`}
                  className="group relative flex h-full flex-col rounded-2xl wr-glass wr-ring p-6 transition-all duration-300 hover:-translate-y-1 hover:shadow-[0_28px_80px_-30px_hsl(var(--primary)/0.6)]"
                >
                  <div className="flex items-start justify-between">
                    <span className="flex size-11 items-center justify-center rounded-xl bg-primary/10 text-primary transition-colors group-hover:bg-primary group-hover:text-primary-foreground">
                      <Icon className="size-6" />
                    </span>
                    <ArrowRight className="size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-primary" />
                  </div>
                  <h3 className="mt-4 text-lg font-bold tracking-tight">{ind.name}</h3>
                  <div className="text-xs font-medium uppercase tracking-wide text-primary">{ind.who}</div>
                  <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{ind.tag}</p>
                  {/* sub-vertical preview — the real navigation inside this industry */}
                  <div className="mt-4 flex flex-wrap gap-1.5">
                    {ind.segments.map((s) => (
                      <span key={s.id} className="rounded-full border border-border/70 bg-background/60 px-2.5 py-0.5 text-[11px] font-medium text-muted-foreground">
                        {s.name}
                      </span>
                    ))}
                  </div>
                </a>
              </Reveal>
            );
          })}
        </div>

        {/* breadth beyond the flagships — deliberately NOT an industry grid;
         * the full industry-grouped catalog lives on /solutions (generated
         * from pack manifests), so this page only states the boundary and
         * hands off. Avoids duplicating the catalog's content here. */}
        <div className="mt-14">
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <h3 className="text-xl font-bold tracking-tight">{C.moreIndustries.title}</h3>
            <span className="text-sm text-muted-foreground">{C.moreIndustries.note}</span>
          </div>
          <p className="mt-4 max-w-2xl text-sm text-muted-foreground">
            <span className="font-medium text-foreground">{C.moreIndustries.dontSee.lead}</span>
            {C.moreIndustries.dontSee.body}
          </p>
          {/* the pack catalog CTA — the count is generated from the shipped
           * pack manifests (packs.gen.ts), so this headline cannot drift. */}
          <div className="mt-8 flex flex-col items-start justify-between gap-4 rounded-2xl border border-primary/25 bg-primary/[0.04] p-6 sm:flex-row sm:items-center">
            <div>
              <div className="text-lg font-bold tracking-tight">
                {C.catalogCta.headline.replace("{count}", String(SOLUTION_PACK_COUNT))}
              </div>
              <p className="mt-1 max-w-xl text-sm text-muted-foreground">{C.catalogCta.body}</p>
            </div>
            <Button asChild size="lg" className="shrink-0">
              <Link href={C.catalogCta.action.href}>
                {C.catalogCta.action.label} <ArrowRight className="size-4" />
              </Link>
            </Button>
          </div>
        </div>
      </section>

      {/* capabilities showcase (interactive tabs) */}
      <section id="capabilities" className="mx-auto max-w-6xl scroll-mt-20 px-6 py-20">
        <Reveal>
          <span className="inline-flex items-center gap-1.5 rounded-full border border-primary/30 bg-primary/10 px-3 py-1 text-xs font-semibold uppercase tracking-widest text-primary">
            <Cpu className="size-3.5" />
            {C.capabilitiesIntro.eyebrow}
          </span>
          <h2 className="mt-5 text-balance text-3xl font-bold tracking-tight md:text-4xl">
            {C.capabilitiesIntro.title}
          </h2>
          <p className="mt-3 max-w-2xl text-muted-foreground">{C.capabilitiesIntro.sub}</p>
        </Reveal>

        <div className="mt-10 grid gap-8 lg:grid-cols-[1.1fr_1fr]">
          {/* tab list */}
          <div className="grid gap-2.5 sm:grid-cols-2">
            {C.caps.map((c, i) => {
              const Icon = CAP_ICONS[c.key];
              const active = i === tab;
              return (
                <button
                  key={c.key}
                  onMouseEnter={() => {
                    setAuto(false);
                    setTab(i);
                  }}
                  onClick={() => {
                    setAuto(false);
                    setTab(i);
                  }}
                  className={`group rounded-xl border p-4 text-left transition-all ${
                    active
                      ? "border-primary/50 bg-primary/5 shadow-sm"
                      : "border-border/70 bg-card hover:border-primary/30"
                  }`}
                >
                  <span
                    className={`flex size-9 items-center justify-center rounded-lg transition-colors ${
                      active ? "bg-primary text-primary-foreground" : "bg-primary/10 text-primary"
                    }`}
                  >
                    <Icon className="size-5" />
                  </span>
                  <div className="mt-3 text-sm font-semibold">{c.title}</div>
                  <div className="mt-1 text-xs leading-relaxed text-muted-foreground">{c.eyebrow}</div>
                </button>
              );
            })}
          </div>

          {/* active panel */}
          <div className="wr-glass wr-ring wr-glow relative overflow-hidden rounded-2xl p-7">
            <div aria-hidden className="pointer-events-none absolute -right-16 -top-16 size-48 rounded-full bg-primary/20 blur-2xl" />
            <div aria-hidden className="pointer-events-none absolute -bottom-16 -left-16 size-48 rounded-full bg-[#a78bfa]/20 blur-2xl" />
            <div key={Cap.key} className="wr-swap relative">
              <div className="text-xs font-semibold uppercase tracking-widest text-primary">{Cap.eyebrow}</div>
              <h3 className="mt-2 text-xl font-bold tracking-tight">{Cap.title}</h3>
              <p className="mt-2.5 text-sm leading-relaxed text-muted-foreground">{Cap.body}</p>
              <ul className="mt-4 space-y-1.5">
                {Cap.points.map((p) => (
                  <li key={p} className="flex items-start gap-2 text-sm">
                    <Check className="mt-0.5 size-4 shrink-0 text-primary" />
                    <span className="text-muted-foreground">{p}</span>
                  </li>
                ))}
              </ul>
              <div className="mt-6 rounded-xl border border-border/60 bg-background/60 p-4">
                <CapVisual k={Cap.key} />
              </div>
            </div>
          </div>
        </div>

        {/* progress dots */}
        <div className="mt-6 flex items-center justify-center gap-1.5">
          {C.caps.map((c, i) => (
            <button
              key={c.key}
              aria-label={c.title}
              onClick={() => {
                setAuto(false);
                setTab(i);
              }}
              className={`h-1.5 rounded-full transition-all ${i === tab ? "w-6 bg-primary" : "w-1.5 bg-border"}`}
            />
          ))}
        </div>
      </section>

      {/* the category boundary — BI reports, models predict, this one acts + is answerable */}
      <section id="difference" className="scroll-mt-16 border-t border-border/60">
        <div className="mx-auto max-w-6xl px-6 py-20">
          <Reveal>
            <span className="inline-flex items-center gap-1.5 rounded-full border border-primary/30 bg-primary/10 px-3 py-1 text-xs font-semibold uppercase tracking-widest text-primary">
              <Sparkles className="size-3.5" />
              {C.compare.eyebrow}
            </span>
            <h2 className="mt-5 text-balance text-3xl font-bold tracking-tight md:text-4xl">
              {C.compare.title}
            </h2>
            <p className="mt-3 max-w-2xl text-muted-foreground">{C.compare.sub}</p>
          </Reveal>

          <Reveal delay={80}>
            <div className="mt-10 overflow-x-auto">
              <table className="w-full min-w-[760px] border-separate border-spacing-0 text-left align-top text-sm">
                <thead>
                  <tr>
                    <th className="w-[22%] px-4 pb-4 align-bottom text-xs font-semibold uppercase tracking-widest text-muted-foreground">
                      {C.compare.dimensionLabel}
                    </th>
                    {C.compare.cols.map((c, i) => {
                      const di = i === C.compare.cols.length - 1;
                      return (
                        <th
                          key={c}
                          className={`px-4 pb-4 pt-3 align-bottom text-base font-bold ${
                            di ? "rounded-t-xl bg-primary/10 text-primary" : "text-foreground/70"
                          }`}
                        >
                          <span className="flex items-center gap-2">
                            {di && <DatacernLogo className="size-4" />}
                            {di ? "Datacern" : c}
                          </span>
                          {di && (
                            <span className="mt-0.5 block text-xs font-medium normal-case tracking-normal text-primary/80">
                              {C.compare.datacernSubtitle}
                            </span>
                          )}
                        </th>
                      );
                    })}
                  </tr>
                </thead>
                <tbody>
                  {C.compare.rows.map(([dim, bi, ai, di], r) => {
                    const last = r === C.compare.rows.length - 1;
                    return (
                      <tr key={dim}>
                        <td className="border-t border-border/60 px-4 py-4 font-semibold text-foreground">{dim}</td>
                        <td className="border-t border-border/60 px-4 py-4 text-muted-foreground">{bi}</td>
                        <td className="border-t border-border/60 px-4 py-4 text-muted-foreground">{ai}</td>
                        <td
                          className={`border-t border-primary/20 bg-primary/[0.06] px-4 py-4 font-medium text-foreground ${
                            last ? "rounded-b-xl" : ""
                          }`}
                        >
                          <span className="flex items-start gap-2">
                            <Check className="mt-0.5 size-4 shrink-0 text-primary" />
                            {di}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Reveal>

          <p className="mt-5 max-w-2xl text-sm text-muted-foreground">{C.compare.note}</p>
        </div>
      </section>

      {/* how it works */}
      <section id="how" className="border-t border-border/60 bg-card/50">
        <div className="mx-auto max-w-6xl scroll-mt-20 px-6 py-20">
          <Reveal>
            <h2 className="text-3xl font-bold tracking-tight">{C.how.title}</h2>
            <p className="mt-3 max-w-2xl text-muted-foreground">{C.how.sub}</p>
          </Reveal>
          <Reveal delay={90}>
            <div className="mt-10">
              <DecisionLoopDiagram />
            </div>
          </Reveal>
          <div className="mt-10 flex flex-wrap items-center gap-x-3 gap-y-2">
            <span className="text-sm font-medium text-foreground">{C.how.outcomesLabel}</span>
            {C.how.outcomes.map((o) => (
              <span key={o} className="rounded-full border border-border/70 bg-card px-3 py-1 text-xs text-muted-foreground">
                {o}
              </span>
            ))}
          </div>
        </div>
      </section>

      {/* layered + per-cloud architecture (assets copied from docs/architecture/diagrams) */}
      <section id="architecture" className="border-t border-border/60">
        <div className="mx-auto max-w-6xl scroll-mt-20 px-6 py-20">
          <Reveal>
            <h2 className="text-3xl font-bold tracking-tight">{C.architecture.title}</h2>
            <p className="mt-3 max-w-2xl text-muted-foreground">{C.architecture.sub}</p>
          </Reveal>
          <Reveal delay={90}>
            <div className="mt-10">
              <ArchitectureDiagrams />
            </div>
          </Reveal>
        </div>
      </section>

      {/* per-industry spotlights */}
      <div id="solutions">
        {C.industries.map((ind, idx) => {
          const Icon = INDUSTRY_ICONS[ind.id] ?? Building2;
          const alt = idx % 2 === 1;
          return (
            <section
              key={ind.id}
              id={`ind-${ind.id}`}
              className={`scroll-mt-16 border-t border-border/60 ${alt ? "bg-card/50" : ""}`}
            >
              <div className="mx-auto grid max-w-6xl items-start gap-10 px-6 py-20 lg:grid-cols-2">
                {/* narrative */}
                <Reveal>
                  <div className="flex items-center gap-3">
                    <span className="flex size-11 items-center justify-center rounded-xl bg-primary/10 text-primary">
                      <Icon className="size-6" />
                    </span>
                    <div>
                      <div className="text-xs font-semibold uppercase tracking-widest text-primary">{ind.who}</div>
                      <div className="text-lg font-bold tracking-tight">{ind.name}</div>
                    </div>
                  </div>
                  <h3 className="mt-6 text-balance text-2xl font-bold leading-tight tracking-tight md:text-3xl">
                    {ind.headline}
                  </h3>
                  <p className="mt-4 max-w-xl text-pretty leading-relaxed text-muted-foreground">{ind.blurb}</p>
                  <div className="mt-6 flex flex-wrap gap-2">
                    {ind.outcomes.map((o) => (
                      <span
                        key={o}
                        className="inline-flex items-center gap-1.5 rounded-full border border-primary/25 bg-primary/5 px-3 py-1 text-xs font-medium text-foreground"
                      >
                        <Check className="size-3.5 text-primary" />
                        {o}
                      </span>
                    ))}
                  </div>
                  <Button variant="outline" className="mt-7" onClick={() => setDemoOpen(true)}>
                    {C.header.demoCta} <ArrowRight className="size-4" />
                  </Button>
                </Reveal>

                {/* solutions that ship / in your workflow */}
                <Reveal delay={90}>
                  <IndustryShipsCard ind={ind} />
                </Reveal>
              </div>
            </section>
          );
        })}
        <div className="border-t border-border/60">
          <p className="mx-auto max-w-2xl px-6 py-12 text-center text-sm text-muted-foreground">
            <span className="font-medium text-foreground">{C.spotlights.outro.lead}</span>
            {C.spotlights.outro.body}
          </p>
        </div>
      </div>

      {/* trust */}
      <section className="border-t border-border/60 bg-card/50">
        <div className="mx-auto max-w-6xl px-6 py-20">
          <Reveal>
            <span className="inline-flex items-center gap-1.5 rounded-full border border-primary/30 bg-primary/10 px-3 py-1 text-xs font-semibold uppercase tracking-widest text-primary">
              <ShieldCheck className="size-3.5" />
              {C.trust.eyebrow}
            </span>
            <h2 className="mt-5 text-3xl font-bold tracking-tight">{C.trust.title}</h2>
            <p className="mt-3 max-w-2xl text-muted-foreground">{C.trust.sub}</p>
          </Reveal>
          <div className="mt-10 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
            {C.trust.items.map(([title, body], i) => (
              <Reveal key={title} delay={i * 70}>
                <div>
                  <h3 className="text-sm font-semibold">{title}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{body}</p>
                </div>
              </Reveal>
            ))}
          </div>
          {/* the mechanisms live on /security — link, don't repeat them here */}
          <p className="mt-8 text-sm">
            <Link
              href={C.trust.more.href}
              className="inline-flex items-center gap-1 font-medium text-primary underline-offset-2 hover:underline"
            >
              {C.trust.more.label} <ArrowRight className="size-3.5" />
            </Link>
          </p>
        </div>
      </section>

      {/* faq */}
      <section id="faq" className="mx-auto max-w-3xl scroll-mt-20 px-6 py-20">
        <h2 className="text-center text-3xl font-bold tracking-tight">{C.faq.title}</h2>
        <div className="wr-glass wr-ring mt-8 divide-y divide-border/60 rounded-2xl">
          {C.faq.items.map(([q, a], i) => {
            const open = faq === i;
            return (
              <div key={q}>
                <button
                  onClick={() => setFaq(open ? null : i)}
                  className="flex w-full items-center justify-between gap-4 px-5 py-4 text-left"
                >
                  <span className="text-sm font-semibold">{q}</span>
                  <ChevronDown className={`size-4 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`} />
                </button>
                <div className={`grid transition-all duration-300 ${open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"}`}>
                  <div className="overflow-hidden">
                    <p className="px-5 pb-4 text-sm leading-relaxed text-muted-foreground">{a}</p>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* closing CTA */}
      <section className="relative overflow-hidden border-t border-border/60">
        <div aria-hidden className="wr-mesh pointer-events-none absolute inset-0 -z-10 opacity-80" />
        <div aria-hidden className="wr-aurora pointer-events-none absolute left-1/2 top-0 -z-10 h-72 w-[48rem] -translate-x-1/2 rounded-full opacity-50" />
        <div className="mx-auto flex max-w-6xl flex-col items-center gap-5 px-6 py-24 text-center">
          <DatacernLogo className="size-12 drop-shadow-[0_0_28px_hsl(var(--primary)/0.6)]" />
          <h2 className="text-balance text-3xl font-bold tracking-tight md:text-4xl">
            {C.closingCta.title}
          </h2>
          <p className="max-w-xl text-pretty text-muted-foreground">{C.closingCta.body}</p>
          <Button size="lg" className="mt-2" onClick={() => setDemoOpen(true)}>
            {C.header.demoCta} <ArrowRight className="size-4" />
          </Button>
        </div>
      </section>

      <footer className="border-t border-border/60">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-2 px-6 py-6 text-xs text-muted-foreground sm:flex-row">
          <span>{MARKETING_SHELL.footer.left}</span>
          <span>{MARKETING_SHELL.footer.right}</span>
        </div>
      </footer>

      {demoOpen && <DemoDialog onClose={() => setDemoOpen(false)} />}
    </main>
  );
}

/* ------------------------------------------------------------------ */
/* demo-request modal (posts to /api/request-demo)                     */
/* ------------------------------------------------------------------ */
const Field = forwardRef<
  HTMLInputElement,
  { label: string; name: string; type?: string; autoComplete?: string; bad?: boolean }
>(function Field({ label, name, type = "text", autoComplete, bad }, ref) {
  return (
    <div>
      <label htmlFor={name} className="text-xs font-medium">
        {label}
      </label>
      <input
        ref={ref}
        id={name}
        name={name}
        type={type}
        required
        autoComplete={autoComplete}
        className={`mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm outline-none transition-shadow focus:ring-2 focus:ring-primary/40 ${
          bad ? "border-destructive" : "border-border"
        }`}
      />
    </div>
  );
});

function DemoDialog({ onClose }: { onClose: () => void }) {
  const D = C.demoDialog;
  const [state, setState] = useState<"idle" | "submitting" | "done" | "error">("idle");
  const [err, setErr] = useState("");
  const [bad, setBad] = useState<string[]>([]);
  const firstRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    firstRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setState("submitting");
    setErr("");
    setBad([]);
    const payload = Object.fromEntries(new FormData(e.currentTarget).entries());
    try {
      const res = await fetch("/api/request-demo", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const json = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        fields?: string[];
      };
      if (res.ok && json.ok) {
        setState("done");
        return;
      }
      setBad(Array.isArray(json.fields) ? json.fields : []);
      setErr(json.error === "validation" ? D.errors.validation : D.errors.generic);
      setState("error");
    } catch {
      setErr(D.errors.network);
      setState("error");
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-label={D.title}
    >
      <div className="absolute inset-0 bg-background/70 backdrop-blur-sm" onClick={onClose} />
      <div className="wr-swap relative w-full max-w-md rounded-2xl border border-border bg-card p-6 shadow-2xl">
        <button
          onClick={onClose}
          aria-label="Close"
          className="absolute right-4 top-4 rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <X className="size-5" />
        </button>

        {state === "done" ? (
          <div className="py-6 text-center">
            <div className="mx-auto flex size-12 items-center justify-center rounded-full bg-primary/10 text-primary">
              <Check className="size-6" />
            </div>
            <h3 className="mt-4 text-lg font-bold tracking-tight">{D.done.title}</h3>
            <p className="mt-1.5 text-sm text-muted-foreground">{D.done.body}</p>
            <Button className="mt-5" onClick={onClose}>
              {D.done.close}
            </Button>
          </div>
        ) : (
          <>
            <h3 className="text-lg font-bold tracking-tight">{D.title}</h3>
            <p className="mt-1 text-sm text-muted-foreground">{D.sub}</p>
            <form onSubmit={onSubmit} className="mt-5 space-y-3.5">
              {/* honeypot — hidden from real users; bots fill it */}
              <input
                type="text"
                name="website"
                tabIndex={-1}
                autoComplete="off"
                aria-hidden="true"
                className="hidden"
              />
              <Field label={D.fields.name} name="name" autoComplete="name" ref={firstRef} bad={bad.includes("name")} />
              <Field label={D.fields.email} name="email" type="email" autoComplete="email" bad={bad.includes("email")} />
              <Field label={D.fields.company} name="company" autoComplete="organization" bad={bad.includes("company")} />
              <div>
                <label htmlFor="teamSize" className="text-xs font-medium">
                  {D.fields.teamSize} <span className="text-muted-foreground">{D.fields.optional}</span>
                </label>
                <select
                  id="teamSize"
                  name="teamSize"
                  defaultValue=""
                  className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/40"
                >
                  <option value="">{D.fields.selectPlaceholder}</option>
                  {D.fields.teamSizeOptions.map((o) => (
                    <option key={o}>{o}</option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor="message" className="text-xs font-medium">
                  {D.fields.message} <span className="text-muted-foreground">{D.fields.optional}</span>
                </label>
                <textarea
                  id="message"
                  name="message"
                  rows={3}
                  className="mt-1 w-full resize-none rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/40"
                />
              </div>
              {err && <p className="text-sm text-destructive">{err}</p>}
              <Button type="submit" className="w-full" disabled={state === "submitting"}>
                {state === "submitting" ? D.submitting : D.submit}
              </Button>
              <p className="text-center text-[11px] text-muted-foreground">{D.privacy}</p>
            </form>
          </>
        )}
      </div>
    </div>
  );
}

/* keyframes + reveal, injected globally (unique wr- prefixes avoid collisions) */
const WR_CSS = `
.wr-reveal{opacity:0;transform:translateY(16px);transition:opacity .6s ease,transform .6s ease;}
.wr-in{opacity:1;transform:none;}
.wr-float{animation:wr-float 6s ease-in-out infinite;}
@keyframes wr-float{0%,100%{transform:translateY(0)}50%{transform:translateY(-10px)}}
.wr-pulse{animation:wr-pulse 1.8s ease-in-out infinite;}
@keyframes wr-pulse{0%,100%{opacity:1}50%{opacity:.35}}
.wr-grow{width:0;animation:wr-grow 1.4s .3s cubic-bezier(.2,.8,.2,1) forwards;}
@keyframes wr-grow{to{width:82%}}
.wr-swap{animation:wr-swap .5s ease;}
@keyframes wr-swap{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
.wr-marquee-wrap{overflow:hidden;-webkit-mask-image:linear-gradient(90deg,transparent,#000 8%,#000 92%,transparent);mask-image:linear-gradient(90deg,transparent,#000 8%,#000 92%,transparent);}
.wr-marquee{width:max-content;animation:wr-marquee 26s linear infinite;}
@keyframes wr-marquee{to{transform:translateX(-50%)}}
/* Light blue / lavender / white palette — matches the standalone marketing
 * site (deploy/marketing site index.html). #main (id) scopes the override so
 * the rest of the (light-mode-default) app is unaffected. */
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
/* accent hues: primary indigo (235) → lavender (255) → sky blue (218) */
.wr-mesh{background:
  radial-gradient(55rem 42rem at 10% -12%, hsl(var(--primary) / 0.22), transparent 60%),
  radial-gradient(46rem 40rem at 92% -8%, hsl(255 92% 76% / 0.22), transparent 58%),
  radial-gradient(50rem 44rem at 58% 6%, hsl(218 100% 77% / 0.16), transparent 62%);}
.wr-grid{background-image:
  linear-gradient(hsl(var(--primary) / 0.06) 1px, transparent 1px),
  linear-gradient(90deg, hsl(var(--primary) / 0.06) 1px, transparent 1px);
  background-size:54px 54px;
  -webkit-mask-image:radial-gradient(120% 90% at 50% -5%, #000, transparent 72%);
  mask-image:radial-gradient(120% 90% at 50% -5%, #000, transparent 72%);}
.wr-aurora{background:linear-gradient(115deg,
  hsl(var(--primary) / 0.5), hsl(255 92% 76% / 0.45), hsl(218 100% 77% / 0.38), hsl(var(--primary) / 0.5));
  background-size:300% 300%;filter:blur(64px);animation:wr-aurora 20s ease infinite;}
@keyframes wr-aurora{0%,100%{background-position:0% 50%}50%{background-position:100% 50%}}
.wr-glass{background:hsl(var(--card));
  border:1px solid hsl(var(--primary) / 0.14);}
.wr-glow{box-shadow:0 1px 2px hsl(232 31% 15% / 0.04), 0 24px 70px -28px hsl(var(--primary) / 0.32);}
.wr-glow-soft{box-shadow:0 20px 60px -30px hsl(255 92% 66% / 0.5);}
/* gradient border ring drawn with a masked pseudo-element */
.wr-ring{position:relative;}
.wr-ring::before{content:"";position:absolute;inset:0;border-radius:inherit;padding:1px;
  background:linear-gradient(140deg, hsl(var(--primary) / 0.35), transparent 45%, hsl(255 92% 66% / 0.35));
  -webkit-mask:linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
  -webkit-mask-composite:xor;mask-composite:exclude;pointer-events:none;}
.wr-grad{background-image:linear-gradient(100deg, hsl(var(--primary)), hsl(218 100% 72%), hsl(255 92% 76%));}
.wr-glowtext{text-shadow:none;}
@media (prefers-reduced-motion: reduce){
  .wr-float,.wr-pulse,.wr-grow,.wr-marquee,.wr-swap,.wr-aurora{animation:none!important;}
  .wr-reveal{opacity:1!important;transform:none!important;}
  .wr-grow{width:82%;}
}
`;
