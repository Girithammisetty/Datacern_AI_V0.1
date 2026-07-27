"use client";

import { Bot, Network, RefreshCw, ScrollText, UserCheck, Workflow } from "lucide-react";

/* The one diagram. It has to work for two audiences at once:
 *
 *   a customer  — "my people stay in charge, and the work gets faster"
 *   an investor — "every decision makes the product better, and that compounds"
 *
 * Which is why it is drawn as a LOOP and not a pipeline. A pipeline is a tool
 * you buy once; a loop is an asset that appreciates. The return arc is the
 * whole thesis, so it is labelled, not decorative.
 *
 * Two more deliberate choices:
 *   - Step 3 (the human gate) is the only filled/elevated card. The category
 *     claim is that AI proposes and a person disposes, so the eye has to land
 *     on the person.
 *   - AI steps carry the lavender accent the design system already reserves for
 *     AI surfaces; human + system-of-record steps stay indigo. The colour is
 *     doing the "who did what" work before anyone reads a word.
 *
 * Built as flex cards + a CSS loop track rather than one big SVG: labels stay
 * real text (legible, translatable, selectable, screen-readable) and it reflows
 * to a vertical stack on a phone without a second drawing.
 */

const STEPS = [
  {
    icon: Network,
    kicker: "Your world",
    title: "Your data, connected",
    body: "Claims, policies, documents and systems of record — in place, under your existing controls.",
    tone: "system" as const,
  },
  {
    icon: Bot,
    kicker: "AI",
    title: "Agents do the reading",
    body: "Specialist agents gather the evidence, check it against your rules, and draft a recommendation.",
    tone: "ai" as const,
  },
  {
    icon: UserCheck,
    kicker: "Your people",
    title: "Your expert decides",
    body: "Approve, adjust or override. Nothing is written until a person with the authority says so.",
    tone: "human" as const,
  },
  {
    icon: Workflow,
    kicker: "Outcome",
    title: "The action is taken",
    body: "Written back to your systems with the evidence and the reasoning attached to it.",
    tone: "system" as const,
  },
];

const TONE = {
  system: {
    chip: "bg-primary/10 text-primary ring-primary/20",
    icon: "text-primary",
  },
  ai: {
    chip: "bg-[hsl(255_92%_66%_/_0.12)] text-[hsl(255_60%_46%)] ring-[hsl(255_92%_66%_/_0.25)]",
    icon: "text-[hsl(255_60%_52%)]",
  },
  human: {
    chip: "bg-primary text-primary-foreground ring-primary/30",
    icon: "text-primary",
  },
};

function Step({ step, index }: { step: (typeof STEPS)[number]; index: number }) {
  const Icon = step.icon;
  const tone = TONE[step.tone];
  const isGate = step.tone === "human";
  return (
    <li className="relative flex-1">
      <div
        className={`wr-ring flex h-full flex-col rounded-2xl p-5 ${
          isGate
            ? "wr-glow bg-primary/[0.045] ring-2 ring-primary/35 md:-mt-2 md:pb-7 md:pt-7"
            : "wr-glass"
        }`}
      >
        <div className="flex items-center gap-2">
          <span
            className={`flex size-9 shrink-0 items-center justify-center rounded-xl ring-1 ${tone.chip}`}
          >
            <Icon className={`size-[18px] ${isGate ? "" : tone.icon}`} aria-hidden />
          </span>
          <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            {step.kicker}
          </span>
        </div>
        <h3 className="mt-3.5 text-base font-semibold leading-snug text-foreground">
          {index + 1}. {step.title}
        </h3>
        <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{step.body}</p>
        {isGate && (
          <p className="mt-3 border-t border-primary/15 pt-3 text-[13px] font-medium text-primary">
            The AI never writes on its own.
          </p>
        )}
      </div>

      {/* connector into the next step — desktop only, decorative */}
      {index < STEPS.length - 1 && (
        <span
          aria-hidden
          className="absolute -right-[18px] top-1/2 hidden h-px w-[18px] -translate-y-1/2 bg-primary/25 md:block"
        >
          <span className="absolute -right-px -top-[3px] size-[7px] rotate-45 border-r border-t border-primary/40" />
        </span>
      )}
    </li>
  );
}

export function DecisionLoopDiagram() {
  return (
    <figure className="m-0">
      <ol className="flex list-none flex-col gap-6 p-0 md:flex-row md:gap-[18px]">
        {STEPS.map((s, i) => (
          <Step key={s.title} step={s} index={i} />
        ))}
      </ol>

      {/* the return arc — the actual thesis, so it is labelled and never
       * decorative. Drawn as a three-sided track so it stays crisp at any
       * width; on a phone it collapses to a single centred chip. */}
      <div className="relative mt-0 md:mt-3">
        <div aria-hidden className="relative hidden md:block">
          <div className="mx-6 h-9 rounded-b-2xl border-b border-l border-r border-dashed border-primary/30" />
          {/* arrowhead pointing back UP into step 1 — without it the track reads
           * as a box rather than a return path, and the loop is the whole point */}
          <span className="absolute left-6 top-0 size-2 -translate-x-1/2 -translate-y-1/2 rotate-45 border-l-2 border-t-2 border-primary/50" />
        </div>
        <div className="mt-4 flex justify-center md:mt-[-14px]">
          <span className="inline-flex items-center gap-2 rounded-full border border-primary/25 bg-card px-4 py-1.5 text-[13px] font-medium text-foreground shadow-sm">
            <RefreshCw className="size-4 text-[hsl(255_60%_52%)]" aria-hidden />
            Every decision teaches the system — so quality climbs and the routine
            work automates itself
          </span>
        </div>
      </div>

      {/* the audit spine: the claim that makes the loop sellable in a regulated
       * industry. Deliberately understated — it is a floor, not a feature. */}
      <figcaption className="mt-7 flex items-center justify-center gap-2 text-center text-sm text-muted-foreground">
        <ScrollText className="size-4 shrink-0 text-primary/70" aria-hidden />
        <span>
          Every step above is recorded — <strong className="font-medium text-foreground">who decided what, when, and on
          what evidence</strong> — ready for an auditor, a regulator or a dispute.
        </span>
      </figcaption>
    </figure>
  );
}
