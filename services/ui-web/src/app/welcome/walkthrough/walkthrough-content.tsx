"use client";

/**
 * /welcome/walkthrough — public demo-walkthrough marketing subpage.
 *
 * Rule #1 (inherited from /welcome): NO invented numbers. Every product claim
 * on this page is verifiable in this repository, every mock is labeled as a
 * mock, and the "honestly" panel states what the sandbox does NOT include.
 * The five steps mirror the in-product guided tour that demo tenants get
 * (deploy/demo/insurance-claims-payer/walkthrough.yaml, served by
 * identity-service and rendered by WalkthroughOverlay).
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
          Copilot draft — disposition proposal
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
            <span className="text-muted-foreground">proposed by Copilot</span>
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
/* the five steps + the refusal beat                                    */
/* ------------------------------------------------------------------ */

const STEPS: {
  icon: React.ElementType;
  title: string;
  body: string;
  facts: string[];
  Mock: React.ComponentType;
}[] = [
  {
    icon: ListChecks,
    title: "The worklist",
    body:
      "Every pending request lands in a governed queue the moment it arrives, ranked by risk and deadline. In the demo sandbox that's a seeded prior-authorization queue; in production it's fed by your own systems through an intake rule you can read.",
    facts: [
      "Your tenant's data is isolated by the database itself (Postgres row-level security in every stateful service), not by careful application code.",
      "Every guarded route checks policy (OPA) before it answers; denials are audited.",
    ],
    Mock: WorklistMock,
  },
  {
    icon: FileSearch,
    title: "Copilot triage",
    body:
      "Open the urgent case and run triage: the copilot reads the documentation and drafts a disposition with its evidence cited and its confidence stated. It proposes — it has no authority to act.",
    facts: [
      "Model calls go through a governed AI gateway with hard budget caps that fail closed.",
      "If the model call fails, the UI says so — a visible “auto-generated fallback, not LLM-reasoned” label. No silent canned answers.",
    ],
    Mock: TriageMock,
  },
  {
    icon: UserCheck,
    title: "Approval — four eyes",
    body:
      "The draft becomes a proposal in the approval inbox. A reviewer approves or overrides it with a reason. Approving your own proposal is rejected by the server, and high-risk actions always require a second, different person — that rule has no tenant-level off switch.",
    facts: [
      "Agent tool calls carry signed, single-use grants; the end-to-end test proves a forged grant is rejected.",
      "Four-eyes is the default for AI-proposed writes; tenants can policy-enable auto-execution only for low-risk, non-destructive actions — and that choice is itself recorded.",
    ],
    Mock: ApprovalMock,
  },
  {
    icon: GraduationCap,
    title: "The learning loop",
    body:
      "When a reviewer corrects the AI, that correction becomes a labeled training example. Models retrain on real corrections, the run is logged to MLflow, and promotion to production goes through the same four-eyes gate as everything else — then new work is scored by the promoted model.",
    facts: [
      "This whole loop runs in our end-to-end test against the real stack — real Kafka, real object storage, real MLflow, real local LLM. No mocks in that path.",
      "A model cannot promote itself: promotion approval requires a distinct human, with no opt-out.",
    ],
    Mock: LearningMock,
  },
  {
    icon: History,
    title: "The audit trail",
    body:
      "Every step you just took — the draft, the approval, the applied disposition — is on a tamper-evident record: who proposed, who approved, what changed, and the evidence each decision stood on. This is the part your regulator will ask for.",
    facts: [
      "Per-tenant hash-chained audit log, plus a write-once (S3 Object-Lock compliance mode) export with a 7-year default retention.",
      "Exports format as JSON, CEF, or LEEF for your security tooling.",
    ],
    Mock: AuditMock,
  },
];

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
            <span className="text-lg font-bold tracking-tight">Datacern AI</span>
          </Link>
          <div className="flex items-center gap-3">
            <Link
              href="/welcome"
              className="hidden items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground sm:inline-flex"
            >
              <ArrowLeft className="size-3.5" /> Overview
            </Link>
            <Button asChild>
              <Link href="/live-demo">Start the live demo</Link>
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
            The demo walkthrough
          </span>
          <h1 className="mt-6 text-balance text-4xl font-bold leading-[1.05] tracking-tight md:text-5xl">
            One decision,{" "}
            <span className="wt-grad bg-clip-text text-transparent">end to end.</span>
          </h1>
          <p className="mx-auto mt-6 max-w-2xl text-pretty text-lg leading-relaxed text-muted-foreground">
            This is the same five-step tour the product gives you inside a live demo sandbox: a case
            arrives, AI drafts, a named person decides, the system learns, and everything lands on
            the record. Five steps, nothing staged that the product can&apos;t actually do.
          </p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <Button asChild size="lg">
              <Link href="/live-demo">
                Start the live demo <ArrowRight className="size-4" />
              </Link>
            </Button>
            <Button asChild size="lg" variant="outline">
              <Link href="/welcome">Back to overview</Link>
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
                Before step one: the refusal
              </div>
              <p className="mt-3 text-pretty leading-relaxed text-muted-foreground">
                The most honest 30 seconds in the product: install a vertical pack against a tenant
                with no data, and it <span className="font-semibold text-foreground">refuses</span> —
                failing closed and naming every data field it needs before it will run. Nothing on
                this platform half-works quietly. When your real data satisfies the contract, the
                same install completes cleanly.
              </p>
            </div>
          </Reveal>
        </div>
      </section>

      {/* the five steps */}
      <section className="mx-auto max-w-6xl px-6 py-16">
        <div className="space-y-14">
          {STEPS.map((s, i) => {
            const Icon = s.icon;
            const Mock = s.Mock;
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
                          Step {i + 1} of {STEPS.length}
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
              The sandbox, honestly
            </h2>
            <p className="mx-auto mt-3 max-w-2xl text-center text-muted-foreground">
              We&apos;d rather you know exactly what you&apos;re looking at.
            </p>
          </Reveal>
          <div className="mt-10 grid gap-5 md:grid-cols-2">
            <Reveal>
              <div className="wt-glass wt-ring h-full rounded-2xl p-6">
                <h3 className="flex items-center gap-2 text-lg font-bold tracking-tight">
                  <Check className="size-5 text-primary" /> What the live demo is
                </h3>
                <ul className="mt-4 space-y-2.5 text-sm text-muted-foreground">
                  <li>A real, isolated tenant of the real platform — the same services, the same governance gates, no separate &quot;demo build.&quot;</li>
                  <li>A seeded healthcare prior-authorization scenario with clearly synthetic sample data, and a guided five-step tour inside the product.</li>
                  <li>Self-serve: no sales call, no operator. It expires and tears itself down automatically after 14 days.</li>
                </ul>
              </div>
            </Reveal>
            <Reveal delay={80}>
              <div className="wt-glass wt-ring h-full rounded-2xl p-6">
                <h3 className="flex items-center gap-2 text-lg font-bold tracking-tight">
                  <X className="size-5 text-muted-foreground" /> What it isn&apos;t (yet)
                </h3>
                <ul className="mt-4 space-y-2.5 text-sm text-muted-foreground">
                  <li>Not a production deployment — Datacern is pre-launch, pre-certification (no SOC 2 yet), with no production customers. We say this everywhere, on purpose.</li>
                  <li>The sandbox seeds the case queue, not the full analytics layer — dashboards and semantic models ship with packs installed by an operator-led setup.</li>
                  <li>Agents in shipped configurations work when a person initiates them; fully autonomous, event-triggered runs are switched off by default.</li>
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
            Now walk it yourself.
          </h2>
          <p className="max-w-xl text-pretty text-muted-foreground">
            Two minutes to a live sandbox. The same five steps, with your hands on the keyboard.
          </p>
          <div className="mt-2 flex flex-wrap items-center justify-center gap-3">
            <Button asChild size="lg">
              <Link href="/live-demo">
                Start the live demo <ArrowRight className="size-4" />
              </Link>
            </Button>
            <Button asChild size="lg" variant="outline">
              <Link href="/welcome">Request a guided demo</Link>
            </Button>
          </div>
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
