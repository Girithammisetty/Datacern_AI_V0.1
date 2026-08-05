/** /welcome/walkthrough page content — ALL copy lives here, the page only
 * renders it.
 *
 * Rule #1 (inherited from /welcome): NO invented numbers. Every product claim
 * on this page is verifiable in this repository, every mock is labeled as a
 * mock, and the "honestly" panel states what the sandbox does NOT include.
 * The five steps mirror the in-product guided tour that demo tenants get
 * (deploy/demo/insurance-claims-payer/walkthrough.yaml, served by
 * identity-service and rendered by WalkthroughOverlay). Step icons are looked
 * up in the component by the `icon` key.
 */

export const WALKTHROUGH_CONTENT = {
  meta: {
    title: "Demo walkthrough — Datacern AI",
    description:
      "Follow one governed decision through Datacern AI, end to end: worklist, Jessie triage, four-eyes approval, learning loop, audit trail.",
  },

  hero: {
    eyebrow: "The demo walkthrough",
    /* rendered as: lead <gradient>accent</gradient> */
    headline: { lead: "One decision, ", accent: "end to end." },
    sub:
      "This is the same five-step tour the product gives you inside a live demo sandbox: a case arrives, AI drafts, a named person decides, the system learns, and everything lands on the record. Five steps, nothing staged that the product can't actually do.",
    ctaPrimary: { label: "Start the live demo", href: "/live-demo" },
    ctaSecondary: { label: "Back to overview", href: "/welcome" },
  },

  refusal: {
    eyebrow: "Before step one: the refusal",
    /* rendered with `refuses` emphasized inline: pre <strong>refuses</strong> post */
    pre: "The most honest 30 seconds in the product: install a vertical pack against a tenant with no data, and it ",
    emphasis: "refuses",
    post:
      " — failing closed and naming every data field it needs before it will run. Nothing on this platform half-works quietly. When your real data satisfies the contract, the same install completes cleanly.",
  },

  stepLabel: "Step {n} of {total}",

  steps: [
    {
      icon: "worklist",
      title: "The worklist",
      body:
        "Every pending request lands in a governed queue the moment it arrives, ranked by risk and deadline. In the demo sandbox that's a seeded prior-authorization queue; in production it's fed by your own systems through an intake rule you can read.",
      facts: [
        "Your tenant's data is isolated by the database itself (Postgres row-level security in every stateful service), not by careful application code.",
        "Every guarded route checks policy (OPA) before it answers; denials are audited.",
      ],
    },
    {
      icon: "triage",
      title: "Jessie triage",
      body:
        "Open the urgent case and run triage: the assistant reads the documentation and drafts a disposition with its evidence cited and its confidence stated. It proposes — it has no authority to act.",
      facts: [
        "Model calls go through a governed AI gateway with hard budget caps that fail closed.",
        "If the model call fails, the UI says so — a visible “auto-generated fallback, not LLM-reasoned” label. No silent canned answers.",
      ],
    },
    {
      icon: "approval",
      title: "Approval — four eyes",
      body:
        "The draft becomes a proposal in the approval inbox. A reviewer approves or overrides it with a reason. Approving your own proposal is rejected by the server, and high-risk actions always require a second, different person — that rule has no tenant-level off switch.",
      facts: [
        "Agent tool calls carry signed, single-use grants; the end-to-end test proves a forged grant is rejected.",
        "Four-eyes is the default for AI-proposed writes; tenants can policy-enable auto-execution only for low-risk, non-destructive actions — and that choice is itself recorded.",
      ],
    },
    {
      icon: "learning",
      title: "The learning loop",
      body:
        "When a reviewer corrects the AI, that correction becomes a labeled training example. Models retrain on real corrections, the run is logged to MLflow, and promotion to production goes through the same four-eyes gate as everything else — then new work is scored by the promoted model.",
      facts: [
        "This whole loop runs in our end-to-end test against the real stack — real Kafka, real object storage, real MLflow, real local LLM. No mocks in that path.",
        "A model cannot promote itself: promotion approval requires a distinct human, with no opt-out.",
      ],
    },
    {
      icon: "audit",
      title: "The audit trail",
      body:
        "Every step you just took — the draft, the approval, the applied disposition — is on a tamper-evident record: who proposed, who approved, what changed, and the evidence each decision stood on. This is the part your regulator will ask for.",
      facts: [
        "Per-tenant hash-chained audit log, plus a write-once (S3 Object-Lock compliance mode) export with a 7-year default retention.",
        "Exports format as JSON, CEF, or LEEF for your security tooling.",
      ],
    },
  ],

  sandbox: {
    title: "The sandbox, honestly",
    sub: "We'd rather you know exactly what you're looking at.",
    isTitle: "What the live demo is",
    is: [
      'A real, isolated tenant of the real platform — the same services, the same governance gates, no separate "demo build."',
      "A seeded healthcare prior-authorization scenario with clearly synthetic sample data, and a guided five-step tour inside the product.",
      "Self-serve: no sales call, no operator. It expires and tears itself down automatically after 14 days.",
    ],
    isntTitle: "What it isn't (yet)",
    isnt: [
      "Not a production deployment — Datacern is pre-launch, pre-certification (no SOC 2 yet), with no production customers. We say this everywhere, on purpose.",
      "The sandbox seeds the case queue, not the full analytics layer — dashboards and semantic models ship with packs installed by an operator-led setup.",
      "Agents in shipped configurations work when a person initiates them; fully autonomous, event-triggered runs are switched off by default.",
    ],
  },

  closing: {
    title: "Now walk it yourself.",
    body: "Two minutes to a live sandbox. The same five steps, with your hands on the keyboard.",
    ctaPrimary: { label: "Start the live demo", href: "/live-demo" },
    ctaSecondary: { label: "Request a guided demo", href: "/welcome" },
  },
} as const;
