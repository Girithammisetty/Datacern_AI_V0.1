import Link from "next/link";
import { WindroseLogo } from "@/components/brand/WindroseLogo";
import { Button } from "@/components/ui/button";

/**
 * Public pre-login marketing page (the front door for signed-out visitors).
 * Go-to-market framing: buyer outcomes and confidence, not platform internals.
 * Rule #1 — NO invented numbers. No fabricated stats, customer counts, logos,
 * percentages, ROI figures, uptime claims or testimonials. Every claim is a
 * qualitative statement about what the product does.
 */
export const metadata = {
  title: "Windrose AI — Decide faster. Defend every call.",
  description:
    "Windrose AI helps regulated teams clear high-stakes work — claims, authorizations, alerts, investigations — faster and more consistently. AI drafts the call, your experts decide, and the system gets sharper with every decision.",
};

const PILLARS = [
  {
    title: "Clear the queue faster",
    body:
      "AI does the reading and drafts a recommendation for every case — so your team reviews and decides instead of digging. Backlogs shrink; your best people spend their time on judgment, not busywork.",
  },
  {
    title: "Consistency you can defend",
    body:
      "The same standards applied to every case, every time — with the reasoning and evidence attached. When an auditor, regulator or customer asks how a decision was made, the answer is already there.",
  },
  {
    title: "Costs that trend down",
    body:
      "Routine, repetitive decisions move off expensive AI and onto models you own. Scaling your volume doesn't mean scaling your bill — the more you decide, the cheaper each decision gets.",
  },
  {
    title: "Gets smarter every day",
    body:
      "Every decision your experts make teaches the system. Accuracy compounds over time, so the platform keeps getting better the more your team uses it — no re-implementation required.",
  },
];

const STEPS = [
  ["AI does the reading", "It gathers the evidence, checks it against your rules, and drafts a clear recommendation with the reasoning laid out."],
  ["Your expert decides", "Approve, adjust or override. People stay accountable for every outcome — nothing acts on its own."],
  ["It learns and improves", "Each decision becomes training. Quality climbs, the routine gets automated, and your team is freed for the hard calls."],
];

const OUTCOMES = [
  "Shorter backlogs",
  "More consistent determinations",
  "Confident audits & exams",
  "Lower cost per decision",
  "Experts focused on judgment",
];

const SOLUTIONS = [
  ["Insurance Claims", "Resolve denials, appeals and prior authorizations faster — with the reasoning attached to every call."],
  ["Provider Revenue Cycle", "Lift clean-claim rates, work denials down and recover the revenue you've earned."],
  ["Fraud, Waste & Abuse", "Surface suspect claims and providers, then run each investigation to a defensible close."],
  ["Care Management", "Enroll, track and bill chronic-care and remote-monitoring programs without leaving revenue on the table."],
  ["Pharmacy Benefits", "Speed authorization turnaround while protecting patient safety and rebate capture."],
  ["Post-Acute Care", "Run episodes and assessments cleanly and stay ahead of readmissions."],
  ["Financial Crime / AML", "Monitor transactions, screen for sanctions and reach filing decisions you can stand behind."],
  ["...and your operation next", "New solutions install onto the same platform, so your teams learn the tool once and reuse it everywhere."],
] as const;

const TRUST = [
  ["Your data stays yours", "Cleanly isolated for your organization — never mingled, never shared."],
  ["The right access for the right people", "Everyone sees and does exactly what their role allows, and nothing more."],
  ["A second set of eyes where it counts", "The changes that matter most require another reviewer to sign off before they go live."],
  ["A complete, tamper-evident record", "Who decided what, when, and on what evidence — captured for every action, ready for any review."],
] as const;

export default function WelcomePage() {
  return (
    <main id="main" className="min-h-screen bg-background text-foreground">
      {/* header */}
      <header className="sticky top-0 z-20 border-b border-border/60 bg-background/80 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <div className="flex items-center gap-2.5">
            <WindroseLogo className="size-8" />
            <span className="text-lg font-bold tracking-tight">Windrose AI</span>
          </div>
          <nav className="hidden items-center gap-7 text-sm text-muted-foreground md:flex">
            <a href="#why" className="transition-colors hover:text-foreground">Why Windrose</a>
            <a href="#how" className="transition-colors hover:text-foreground">How it works</a>
            <a href="#solutions" className="transition-colors hover:text-foreground">Solutions</a>
          </nav>
          <Button asChild>
            <Link href="/login">Sign in</Link>
          </Button>
        </div>
      </header>

      {/* hero */}
      <section className="relative overflow-hidden">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 -z-10 bg-gradient-to-b from-primary/10 via-background to-background"
        />
        <div
          aria-hidden
          className="pointer-events-none absolute -top-24 right-0 -z-10 h-[28rem] w-[28rem] rounded-full bg-primary/15 blur-3xl"
        />
        <div className="mx-auto max-w-6xl px-6 pb-20 pt-16 md:pt-24">
          <div className="max-w-3xl">
            <span className="inline-flex items-center rounded-full border border-primary/30 bg-primary/10 px-3 py-1 text-xs font-semibold uppercase tracking-widest text-primary">
              Decision Intelligence for regulated operations
            </span>
            <h1 className="mt-6 text-balance text-4xl font-bold leading-[1.05] tracking-tight md:text-6xl">
              Decide faster.
              <br />
              Defend every call.
              <br />
              <span className="text-primary">Improve every day.</span>
            </h1>
            <p className="mt-6 max-w-2xl text-pretty text-lg leading-relaxed text-muted-foreground">
              Windrose AI turns your highest-volume, highest-stakes decisions — claims,
              authorizations, alerts, investigations — into a system that moves faster and
              stands up to scrutiny. AI does the reading and drafts the call. Your experts
              decide. And it gets sharper with every one.
            </p>
            <div className="mt-9 flex flex-wrap items-center gap-3">
              <Button asChild size="lg">
                <Link href="/login">Get started</Link>
              </Button>
              <Button asChild size="lg" variant="outline">
                <a href="#solutions">Explore solutions</a>
              </Button>
            </div>
            <p className="mt-6 text-sm text-muted-foreground">
              Built for teams whose every determination needs evidence, an owner, and a trail.
            </p>
          </div>
        </div>
      </section>

      {/* who it's for */}
      <section className="border-y border-border/60 bg-card/50">
        <div className="mx-auto max-w-5xl px-6 py-10">
          <p className="text-center text-pretty text-base leading-relaxed text-muted-foreground">
            Made for{" "}
            <span className="font-medium text-foreground">regulated, decision-heavy operations</span>{" "}
            — health payers and providers, pharmacy benefit managers, post-acute networks and
            financial-crime teams. If your analysts make hundreds of judgment calls a day, and
            your auditors ask how each one was made, Windrose AI was built for you.
          </p>
        </div>
      </section>

      {/* why / value pillars */}
      <section id="why" className="mx-auto max-w-6xl scroll-mt-20 px-6 py-20">
        <h2 className="text-balance text-3xl font-bold tracking-tight">
          The advantage isn't the AI. It's what it does for the decision.
        </h2>
        <p className="mt-3 max-w-2xl text-muted-foreground">
          Plenty of tools bolt AI onto a workflow. Windrose AI is built around the decision
          itself — so the wins show up where you feel them: speed, consistency, cost and trust.
        </p>
        <div className="mt-10 grid gap-5 md:grid-cols-2">
          {PILLARS.map((p) => (
            <div
              key={p.title}
              className="group rounded-2xl border border-border/70 bg-card p-7 transition-all hover:border-primary/40 hover:shadow-sm"
            >
              <h3 className="text-lg font-semibold">{p.title}</h3>
              <p className="mt-2.5 text-sm leading-relaxed text-muted-foreground">{p.body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* how it works */}
      <section id="how" className="border-t border-border/60 bg-card/50">
        <div className="mx-auto max-w-6xl scroll-mt-20 px-6 py-20">
          <h2 className="text-3xl font-bold tracking-tight">How it works</h2>
          <p className="mt-3 max-w-2xl text-muted-foreground">
            Three steps, every time — so the work moves quickly and the accountability never leaves your people.
          </p>
          <div className="mt-10 grid gap-6 md:grid-cols-3">
            {STEPS.map(([title, body], i) => (
              <div key={title} className="relative rounded-2xl border border-border/70 bg-background p-7">
                <div className="flex size-9 items-center justify-center rounded-full bg-primary/10 text-sm font-bold text-primary">
                  {i + 1}
                </div>
                <h3 className="mt-4 text-lg font-semibold">{title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{body}</p>
              </div>
            ))}
          </div>
          <div className="mt-10 flex flex-wrap items-center gap-x-3 gap-y-2">
            <span className="text-sm font-medium text-foreground">What changes for your team:</span>
            {OUTCOMES.map((o) => (
              <span
                key={o}
                className="rounded-full border border-border/70 bg-card px-3 py-1 text-xs text-muted-foreground"
              >
                {o}
              </span>
            ))}
          </div>
        </div>
      </section>

      {/* solutions */}
      <section id="solutions" className="mx-auto max-w-6xl scroll-mt-20 px-6 py-20">
        <h2 className="text-3xl font-bold tracking-tight">Built for your domain, ready to run</h2>
        <p className="mt-3 max-w-2xl text-muted-foreground">
          Start from a solution shaped for your operation — the data, the metrics, the work
          queues and the domain expertise already in place — instead of a blank slate.
        </p>
        <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {SOLUTIONS.map(([name, body]) => (
            <div
              key={name}
              className="rounded-2xl border border-border/70 bg-card p-5 transition-colors hover:border-primary/40"
            >
              <h3 className="text-sm font-semibold">{name}</h3>
              <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* trust / built for scrutiny */}
      <section className="border-t border-border/60 bg-card/50">
        <div className="mx-auto max-w-6xl px-6 py-20">
          <h2 className="text-3xl font-bold tracking-tight">Built for scrutiny</h2>
          <p className="mt-3 max-w-2xl text-muted-foreground">
            The controls a regulated buyer needs aren't an add-on here — they're how the whole
            thing works, so security and compliance are on your side from day one.
          </p>
          <div className="mt-10 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
            {TRUST.map(([title, body]) => (
              <div key={title}>
                <h3 className="text-sm font-semibold">{title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* closing CTA */}
      <section className="relative overflow-hidden border-t border-border/60">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 -z-10 bg-gradient-to-b from-background to-primary/10"
        />
        <div className="mx-auto flex max-w-6xl flex-col items-center gap-5 px-6 py-20 text-center">
          <WindroseLogo className="size-12" />
          <h2 className="text-balance text-3xl font-bold tracking-tight">
            Many directions. One confident, auditable bearing.
          </h2>
          <p className="max-w-xl text-pretty text-muted-foreground">
            Give your team a faster, steadier way to make the calls that matter — and a record
            that speaks for itself when anyone asks.
          </p>
          <Button asChild size="lg" className="mt-2">
            <Link href="/login">Get started</Link>
          </Button>
        </div>
      </section>

      <footer className="border-t border-border/60">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-2 px-6 py-6 text-xs text-muted-foreground sm:flex-row">
          <span>Windrose AI — Decision Intelligence platform</span>
          <span>AI proposes. People decide. The platform remembers.</span>
        </div>
      </footer>
    </main>
  );
}
