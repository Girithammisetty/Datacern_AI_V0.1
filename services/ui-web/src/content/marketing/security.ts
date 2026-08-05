/** /security page content — ALL copy lives here, the page only renders it.
 *
 * House rule carried over from the evidence-ledger discipline: every claim on
 * this page names the mechanism that enforces it. Nothing here says
 * "enterprise-grade"; it says what the product does and where.
 */

export const SECURITY_CONTENT = {
  meta: {
    title: "Security & Governance — Datacern AI",
    description:
      "How Datacern governs AI in regulated work: human approval on every write, four-eyes review, signed execution grants, tenant isolation, and a tamper-evident audit trail.",
  },

  hero: {
    eyebrow: "Security & governance",
    headline: "Built so your compliance team can say yes",
    sub:
      "AI in regulated operations is a governance problem before it is a model problem. Datacern's answer is structural: the AI can only propose; execution requires a named human, a scoped grant, and leaves a receipt. This page describes the mechanisms — ask us to demonstrate any of them on a live decision.",
  },

  // The governance spine — rendered as the five-station diagram. Each station:
  // [kicker, title, body]. Order IS the runtime order.
  spine: {
    title: "The governance spine every AI action crosses",
    sub:
      "Not a policy document — the actual request path. There is no route around it: agents have no direct write access to anything.",
    steps: [
      {
        kicker: "1 · Propose",
        title: "The AI drafts, and only drafts",
        body: "Agents read the case and produce a proposal: the recommended action, the evidence cited, the rules applied. Proposals are inert — nothing has happened yet.",
      },
      {
        kicker: "2 · Approve",
        title: "A named human signs — never their own work",
        body: "The proposal is approved, adjusted, or rejected by a person with the authority. Self-approval is refused structurally; sensitive actions require a second reviewer (four-eyes).",
      },
      {
        kicker: "3 · Grant",
        title: "Approval mints a signed, scoped grant",
        body: "A cryptographically signed execution grant authorizes exactly the approved action — that tool, those arguments, single use. A forged or replayed grant is rejected at the gateway.",
      },
      {
        kicker: "4 · Execute",
        title: "One governed gateway performs the action",
        body: "Tools run behind a gateway that verifies workload identity and re-checks policy at call time. Writes to systems of record go through this path or not at all.",
      },
      {
        kicker: "5 · Record",
        title: "The receipt outlives everyone's memory",
        body: "Who proposed, who approved, what evidence they saw, what changed — appended to a tamper-evident audit log, exportable to your SIEM. This is the record an examiner asks for.",
      },
    ],
  },

  pillars: {
    title: "The floor underneath the spine",
    items: [
      ["Tenant isolation, enforced in the database",
        "Row-level security is applied and forced on every tenant table — isolation the application code cannot forget to apply, because the database refuses cross-tenant reads."],
      ["Least privilege as policy-as-code",
        "Every route and tool checks capabilities against a central policy engine. Roles grant exactly what a job needs; the action catalog is registered, not implied."],
      ["AI spend that cannot run away",
        "Every model call crosses one gateway with per-tenant budgets, guardrails, and a hard cap that stops spend at the ceiling instead of billing past it."],
      ["Models promoted only on evidence",
        "A model reaches production only after evaluation against your benchmarks — and the promotion itself is a recorded, gated decision."],
      ["Your keys, your identity, your cloud",
        "Bring your own identity provider and secrets store; deploy to your cloud. Secrets live in a vault, not in configuration files."],
      ["Data minimization by design",
        "Sensitive integrations (like FHIR clinical access) proxy and redact rather than copy — reads are grantable, writes are proposal-gated, and no PHI is stored in the bridge."],
    ],
  },

  honesty: {
    title: "What we won't claim",
    body:
      "Our engineering ledger separates PROVEN (exercised on a live stack, recorded), TESTED (green in CI, not yet live), and BUILT (exists, unproven) — and our compliance program is reported the same way. SOC 2 is in progress, not achieved; we'll say 'certified' the day the report exists and not before. Ask for the evidence behind any claim on this page and we will show you the run, the test, or the code.",
  },

  cta: {
    title: "Put the spine to the test",
    body:
      "The best diligence is a live one: pick a decision in the demo and ask for its complete record — proposer, approver, evidence, grant, write-back.",
    action: { label: "Start a live demo", href: "/live-demo" },
  },
} as const;
