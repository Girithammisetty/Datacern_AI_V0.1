/** /solutions page content — ALL copy lives here, the page only renders it.
 *
 * Two sources feed the page and they are deliberately separate:
 *   - packs.gen.ts   — GENERATED from packs/(star)/pack.yaml; catalog entries can
 *                      only claim what a shipped manifest claims.
 *   - this file      — the narrative copy around the catalog. Reviewed prose,
 *                      no numbers that aren't structural counts from the
 *                      generated data.
 */

export const SOLUTIONS_CONTENT = {
  meta: {
    title: "Solutions — Datacern AI",
    description:
      "One governed decision engine, installable solution packs for every regulated queue: claims, disputes, alerts, appeals, audits and more.",
  },

  hero: {
    eyebrow: "Solution packs",
    // {count} is replaced with SOLUTION_PACK_COUNT at render time so the
    // headline can never drift from what actually ships.
    headline: "One decision engine. {count} queues it already runs.",
    sub:
      "Every pack installs the same governed core — agents that draft, humans who approve, an audit trail throughout — pre-shaped for one regulated queue: its intake rules, its dispositions, its deadlines, its regulatory grounding. Install a pack, connect your data, and the queue is running. No blank slate, no consulting project.",
    ctaPrimary: { label: "Start a live demo", href: "/live-demo" },
    ctaSecondary: { label: "How pricing works", href: "/pricing" },
  },

  howPacksWork: {
    title: "What a pack actually installs",
    body:
      "A pack is not a template or a demo dataset — it ships zero seed data by design. It is the operating shape of one decision queue, installed onto the governed core:",
    items: [
      ["Intake & triggers", "Which arriving records become cases, with the regulatory clocks that govern them."],
      ["Dispositions & decision tables", "The outcomes your policy allows, codified where anyone can read them."],
      ["Specialist agents & grounding", "Domain agents with the rules and reference memories they cite when drafting."],
      ["Semantics & dashboards", "The queue's KPIs defined once, reviewed, and rendered on day one."],
      ["Roles & guardrails", "Who may see, draft, approve — with four-eyes where your policy demands it."],
    ],
    note:
      "Datasets in a pack are binding contracts resolved to YOUR real data at install. Cases come from your rows, never from seeds — and anything the engine can't yet materialize is recorded honestly in the install ledger, not faked.",
  },

  catalog: {
    title: "The catalog",
    sub:
      "Grouped by industry. Every card below is generated from the pack's shipped manifest — the description is the manifest's own, so this page can only claim what the pack claims.",
    libraryNote:
      "Foundations are shared building blocks other packs compose — installable, but not sold as standalone solutions.",
  },

  engine: {
    title: "The same engine under every pack",
    sub:
      "Whatever the queue, the mechanics don't change — that's what makes the next pack cheap to adopt and your team's skills portable across them.",
    spokes: [
      "Documents & records in",
      "Cases opened by rule",
      "Agents draft with evidence",
      "A named human approves",
      "Write-back with a receipt",
      "Corrections train your model",
    ],
  },

  cta: {
    title: "Don't see your queue?",
    body:
      "If a team reads evidence, applies a policy, and makes a call at volume — the engine runs it. New packs install onto the same governed core, and the investigation framework gives any custom queue the same primitives the shipped packs use.",
    action: { label: "Talk to us about your queue", href: "/welcome#faq" },
  },
} as const;
