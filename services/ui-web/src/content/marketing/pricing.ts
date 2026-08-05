/** /pricing page content — ALL copy lives here, the page only renders it.
 *
 * Deliberately NO prices on this page. Real rates live in operator-configured,
 * versioned rate cards (there are no seeded public prices in this repo), so the
 * page explains HOW pricing works — the meter, the levers, the hard budget
 * cap — and asks the visitor to contact us for a quote. This replaces the
 * earlier illustrative-rates calculator: showing placeholder dollar figures,
 * however clearly labeled, still put numbers next to the brand. The billing
 * math itself remains real and unit-tested (src/lib/pricing/calc.ts).
 */

export const PRICING_CONTENT = {
  meta: {
    title: "Datacern AI — Pricing you can put a ceiling on",
    description:
      "Datacern is priced on governed decisions — the unit your operation already thinks in — with seats and solution packs as the only other levers, and a hard monthly budget cap the platform structurally will not cross. No public rate card: contact us and we'll quote from your volumes.",
  },

  hero: {
    eyebrow: "Pricing with a ceiling",
    headline: "The one agentic-AI bill that can’t run away from you",
    sub:
      "Most agentic products meter usage with no floor and no ceiling — spend is whatever the agents decide to do. A Datacern plan can be given a hard monthly budget cap: when it’s reached, the platform stops serving new value-delivering writes for the cycle rather than overspending. The number you commit to is a number, not a hope.",
  },

  /* how the bill is built — the levers, no rates attached */
  levers: {
    title: "What actually drives your cost",
    sub:
      "Three levers, all of them yours to set — and every metered event is itself in the audit trail, so the bill is checkable line by line.",
    items: [
      [
        "Governed decisions",
        "The primary usage meter — one per case an agent resolves or a human approves. It's the unit your operation already thinks in.",
      ],
      [
        "Named seats",
        "The people who review, approve and administer. Agents aren't seats — you don't pay per bot.",
      ],
      [
        "Solution packs",
        "Each installed pack — the intake rules, dispositions, grounding and dashboards for one queue. Install only the queues you run.",
      ],
    ],
    cap: {
      title: "…under a hard monthly budget cap",
      body:
        "Committed spend structurally cannot exceed the ceiling you set. When projected usage would cross it, decisions beyond the cap defer to the next cycle instead of overspending — enforced by the commercial gate, not promised by a dashboard.",
    },
  },

  /* the contact-first replacement for the rate calculator */
  contact: {
    title: "Contact us for pricing",
    body:
      "We don't publish a rate card — rates are set per deployment and quoted from your volumes: how many decisions a month, how many reviewers, which packs. Tell us about your queue and we'll come back with a concrete number and the ceiling to put on it.",
    action: { label: "Request a demo & quote", href: "/welcome" },
    secondary: { label: "Or start a live demo first", href: "/live-demo" },
    note:
      "No pressure sequence — the live demo is self-serve and the quote conversation starts from your numbers, not ours.",
  },

  included: {
    title: "In every plan",
    items: [
      ["Human approval on every write", "Agents propose; nothing takes effect until a named person approves it, and no one can approve their own work."],
      ["Tamper-evident audit trail", "Every decision leaves a receipt an examiner can follow — who, what, why and on what evidence."],
      ["Tenant isolation", "Row-level security keeps each tenant’s data its own; the platform makes no cross-tenant reads."],
      ["Governed analytics", "Business metrics defined once, reviewed, and reused — so dashboards agree and answers are grounded."],
      ["The hard budget cap", "The commercial gate refuses value-delivering writes once a plan hits its ceiling — a spend limit that’s enforced, not advisory."],
      ["Bring your own model & data", "Runs against your governed data and your permissions; the copilot can’t do anything you couldn’t do yourself."],
    ],
  },

  faq: {
    title: "Pricing, answered",
    items: [
      [
        "How is usage actually metered?",
        "By governed decisions — one per case an agent resolves or a human approves. It’s the unit your operation already thinks in, and every metered event is itself in the audit trail.",
      ],
      [
        "What exactly happens when the budget cap is reached?",
        "The commercial gate suspends value-delivering writes for the rest of the cycle and returns a distinct, stable signal (not a generic error) so the app can offer to raise the cap. Reads and already-approved work aren’t affected; new decision work resumes next cycle or when you lift the ceiling.",
      ],
      [
        "Why isn’t there a price list on this page?",
        "Rates are set per deployment from a versioned rate card, and quoting them out of context would just be a number without your volumes behind it. Contact us with your decision volume, seats and packs and you’ll get a real figure — plus the cap that bounds it.",
      ],
      [
        "Can fixed costs still accrue under a cap?",
        "Yes — the platform floor, seats and packs commit when a plan is active. The cap governs the variable, decision-driven spend on top of them, which is the part that can otherwise run away.",
      ],
    ],
  },
} as const;
