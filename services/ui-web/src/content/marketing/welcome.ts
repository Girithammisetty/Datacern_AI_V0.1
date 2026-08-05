/** /welcome page content — ALL narrative copy lives here; the page only
 * renders it. Same discipline as solutions.ts / security.ts:
 *
 *   - Rule #1: NO invented numbers. The only count on the page is
 *     SOLUTION_PACK_COUNT, rendered from the generated catalog at runtime
 *     ({count} placeholder below).
 *   - Icons stay in the component, looked up by the string keys stored here —
 *     config is data, not React.
 *   - The illustrative product mocks (HeroMock, CapVisual, workflow rows) are
 *     diagram components, like DecisionLoopDiagram; their micro-copy lives with
 *     the mock, clearly labeled illustrative. Everything a marketer would edit
 *     is in this file.
 */

/* a worklist mock row: [id, description, risk tag, reviewer initials] */
export type WelcomeWfRow = readonly [string, string, "hi" | "md" | "lo", string];

export const WELCOME_CONTENT = {
  meta: {
    title: "Datacern AI — AI does the work, a named human signs it",
    description:
      "Datacern works your regulated back-office queues — card disputes, health claims, financial-crime alerts, insurance losses, supplier invoices. Agents read the file, apply your rules and draft the recommendation. Nothing takes effect until a named person approves it, no one can approve their own work, and every action leaves a receipt an examiner can follow.",
  },

  /* in-page anchor nav (the cross-page links come from MARKETING_SHELL) */
  header: {
    signIn: "Sign in",
    demoCta: "Request a demo",
    anchors: [
      { label: "Solutions", href: "/solutions" },
      { label: "Industries", href: "#industries" },
      { label: "Platform", href: "#capabilities" },
      { label: "Why not BI", href: "#difference" },
      { label: "How it works", href: "#how" },
      { label: "Architecture", href: "#architecture" },
      { label: "FAQ", href: "#faq" },
      { label: "Security", href: "/security" },
      { label: "Pricing", href: "/pricing" },
    ],
  },

  hero: {
    eyebrow: "Governed AI for regulated operations",
    /* rendered as: line1 <br/> line2lead <gradient>line2accent</gradient> */
    headline: {
      line1: "AI does the work.",
      line2Lead: "A named human ",
      line2Accent: "signs it.",
    },
    sub:
      "Point Datacern at the data behind your regulated back-office work — card disputes, health claims, financial-crime alerts, insurance losses, supplier invoices. Write one intake rule and matching rows become a worklist on their own. Your team works that queue with an agent drafting the recommendation and its evidence; nothing takes effect until a named person approves it, no one can approve their own work, and every action leaves a receipt an examiner can follow.",
    ctaSecondary: { label: "Explore by industry", href: "#industries" },
    assurance: "Governed end to end — every determination has evidence, an owner, and a trail.",
    liveDemo: {
      label: "Or start a live demo yourself right now",
      href: "/live-demo",
      note: "— no sales call, no operator.",
    },
    walkthrough: {
      label: "See the walkthrough first",
      href: "/welcome/walkthrough",
      note: "— one decision, end to end, in five steps.",
    },
  },

  /* the moving agent roster — business-facing roles, each with the job it
   * does. (Internal orchestration agents like routing/inference plumbing are
   * intentionally not surfaced here.) */
  agentsMarquee: {
    eyebrow: "Agentic AI at work",
    agents: [
      ["Claims Triage Agent", "reads each case and drafts the disposition"],
      ["Analytics assistant", "answers data questions in plain language"],
      ["Governance & Compliance Agent", "checks every action against policy"],
      ["Data Onboarding Agent", "profiles new data and gets it decision-ready"],
      ["Reporting Designer Agent", "builds the dashboards your team needs"],
      ["Model Ops Agent", "trains, evaluates and promotes your models"],
    ],
  },

  /* the AI-capability tabs (the centerpiece). `key` also selects the tab's
   * icon and illustrative visual in the component. */
  caps: [
    {
      key: "agents",
      eyebrow: "Agentic workforce",
      title: "A team of specialist AI agents",
      body:
        "Purpose-built agents do the reading and draft the work — triaging cases, answering data questions, designing dashboards, training models, watching for drift. They propose; they never act on their own.",
      points: ["Draft dispositions with cited evidence", "Route work to the right specialist", "Open proposals, never silent writes"],
    },
    {
      key: "worklist",
      eyebrow: "Governed queue",
      title: "A worklist built for decisions",
      body:
        "Every case lands pre-scored by risk and age, with the evidence and the agent's draft already attached — so your reviewers open a case ready to decide, not to dig for context.",
      points: ["Auto-prioritized by risk and SLA", "Evidence and draft attached on open", "Assign, escalate or approve in one place"],
    },
    {
      key: "copilot",
      eyebrow: "Conversational",
      title: "An assistant that knows your role",
      body:
        "Ask in plain language and get an answer grounded in your governed data and your permissions. Need a change made? The assistant proposes it for a human to approve — it can't do anything you couldn't.",
      points: ["Grounded in your metrics, not guesses", "Aware of what you're allowed to see", "Turns a question into a governed action"],
    },
    {
      key: "entity",
      eyebrow: "Data unification",
      title: "Entity resolution",
      body:
        "The same person or party shows up across systems under different identifiers. Datacern unifies those fragmented records into one resolved entity — so decisions run on the full picture, not a single row.",
      points: ["Deterministic + probabilistic matching", "Ambiguous merges reviewed by a human", "Decide on total exposure, not one record"],
    },
    {
      key: "decisions",
      eyebrow: "Codified policy",
      title: "No-code decision automation",
      body:
        "Turn your operating policy into decision tables anyone can read. Apply them consistently across thousands of cases — and every table change is itself reviewed before it goes live.",
      points: ["Author rules without engineering", "Consistent outcomes, every case", "Change control on the logic itself"],
    },
    {
      key: "analytics",
      eyebrow: "Governed insight",
      title: "Analytics your team can trust",
      body:
        "Business metrics are defined once, reviewed, and reused everywhere — so dashboards agree. Click any bar, slice or row and the whole board filters to match.",
      points: ["One trusted definition per metric", "Cross-filter the entire board", "From a chart straight into a work queue"],
    },
    {
      key: "audit",
      eyebrow: "Tamper-evident",
      title: "An audit trail for every decision",
      body:
        "Every proposal, approval and override is time-stamped and chained together — so when a regulator or auditor asks why a call was made, the answer is already written down.",
      points: ["Immutable, chained record", "A second reviewer on sensitive changes", "Exportable evidence, case by case"],
    },
    {
      key: "ml",
      eyebrow: "Own your models",
      title: "Machine learning, built in",
      body:
        "Train candidate models on your own decisions, evaluate them against your benchmarks, and promote the winner through an approval gate. Repetitive calls move off expensive AI and onto models you own.",
      points: ["No-code pipelines over a rich algorithm catalog", "Evaluated before anything ships", "Cost per decision trends down"],
    },
  ],

  industriesIntro: {
    eyebrow: "Solutions by industry",
    title: "Decision intelligence for every industry",
    sub:
      "If a team reads evidence, applies a policy and makes a call — at volume and under scrutiny — Datacern runs it. Four domains ship deep today; the same governed platform adapts to any data-driven decision queue.",
    flagshipLabel: "Flagship solutions — built deep",
  },

  /* Solutions organized by industry — each use case is a real installable
   * capability pack. Industry is the primary way a buyer navigates: pick your
   * world (payer, bank, carrier, ops) and see the exact queues Datacern runs,
   * the outcomes that move, and the packs that ship it. `id` selects the icon.
   * Workflow KPI tiles and rows are illustrative product mocks and are labeled
   * as such where rendered (Rule #1). */
  industries: [
    {
      id: "healthcare",
      name: "Healthcare",
      who: "Payers, providers & pharmacy",
      tag: "Claims, care and revenue decisions — the reasoning attached to every call.",
      headline: "Adjudicate, appeal and recover — without leaving revenue or defensibility behind.",
      blurb:
        "From prior authorization to payment integrity, specialist agents do the reading and your clinicians and analysts make the call — with the evidence and the rules on the record.",
      outcomes: ["Faster prior-auth turnaround", "Higher clean-claim rates", "Audit-ready determinations"],
      segments: [
        {
          id: "payer",
          name: "Payer",
          useCases: [
            ["Claims Adjudication & Appeals", "Resolve denials, appeals and prior authorizations faster."],
            ["Payment Integrity (FWA / SIU)", "Surface suspect claims and providers, then close each case defensibly."],
            ["Care Management", "Enroll, track and bill chronic-care and remote-monitoring programs."],
          ],
          workflow: {
            kpis: [["Open cases", "482"], ["Clean-claim rate", "94%"], ["Auto-drafted", "76%"]],
            rows: [
              ["PA-48213", "Prior authorization · duplicate flag", "hi", "VP"],
              ["FWA-1187", "Payment integrity · suspect billing", "md", "AC"],
              ["CM-3390", "Care management · enrollment review", "lo", "JR"],
            ],
          },
        },
        {
          id: "provider",
          name: "Provider",
          useCases: [
            ["Provider Revenue Cycle", "Lift clean-claim rates and recover the revenue you've earned."],
            ["Post-Acute Care", "Run episodes and assessments cleanly and stay ahead of readmissions."],
          ],
          workflow: {
            kpis: [["Open cases", "318"], ["Clean-claim rate", "91%"], ["Recovered revenue", "$640K"]],
            rows: [
              ["RCM-77021", "Denial · timely filing appeal", "hi", "DL"],
              ["RCM-77088", "Underpayment · recovery review", "md", "NT"],
              ["PAC-2201", "Post-acute episode · assessment due", "lo", "KM"],
            ],
          },
        },
        {
          id: "pharmacy",
          name: "Pharmacy & Life Sciences",
          useCases: [
            ["Pharmacy Benefits (PBM)", "Speed authorization turnaround while protecting safety and rebates."],
            ["Pharmacovigilance", "Triage and assess adverse-event reports on the regulatory clock."],
            ["Device Complaints", "Route and assess medical-device complaints toward an MDR call."],
          ],
          workflow: {
            kpis: [["Open cases", "203"], ["PA turnaround", "−31%"], ["Safety signals triaged", "58"]],
            rows: [
              ["PBM-5510", "Prior auth · specialty drug", "hi", "SW"],
              ["ICSR-9042", "Adverse event · causality review", "md", "RB"],
              ["DEV-1187", "Device complaint · MDR assessment", "lo", "HP"],
            ],
          },
        },
      ],
    },
    {
      id: "banking",
      name: "Banking & Financial Services",
      who: "Fraud, AML, disputes & lending",
      tag: "Monitor, adjudicate and file with a decision you can stand behind.",
      headline: "Reach the filing, the dispute call and the credit decision — and prove how you got there.",
      blurb:
        "Route alerts and cases to the right specialist, cut false positives, and reach determinations a regulator can follow — every step logged with the evidence it stood on.",
      outcomes: ["Fewer false positives", "Consistent filing decisions", "Regulator-ready trails"],
      segments: [
        {
          id: "fraud-aml",
          name: "Fraud & AML",
          useCases: [
            ["Financial Crime & AML", "Monitor transactions, screen sanctions and reach defensible filing decisions."],
          ],
          workflow: {
            kpis: [["Open alerts", "318"], ["False positives", "−42%"], ["Filing SLA", "On track"]],
            rows: [
              ["AML-90142", "Structuring pattern · escalate", "hi", "MK"],
              ["SAR-2207", "Suspicious activity · filing review", "md", "JB"],
              ["SCR-8810", "Sanctions screening · auto-cleared", "lo", "RS"],
            ],
          },
        },
        {
          id: "disputes",
          name: "Disputes",
          useCases: [
            ["Card Disputes & Chargebacks", "Adjudicate disputes and representment with the evidence attached."],
            ["Credit Bureau Disputes", "Investigate and resolve consumer disputes inside the regulatory clock."],
          ],
          workflow: {
            kpis: [["Open disputes", "540"], ["Reg E SLA", "98%"], ["Recovery rate", "61%"]],
            rows: [
              ["DSP-33871", "Card dispute · evidence attached", "hi", "LT"],
              ["CBK-1290", "Chargeback · representment drafted", "md", "FS"],
              ["CBD-4471", "Credit bureau dispute · reinvestigation", "lo", "AN"],
            ],
          },
        },
        {
          id: "lending",
          name: "Lending",
          useCases: [
            ["Mortgage Loss Mitigation", "Work borrowers through options consistently and on time."],
            ["Underwriting Intake", "Turn messy application packages into a clean, ranked decision."],
          ],
          workflow: {
            kpis: [["Open applications", "276"], ["Time to decision", "−38%"], ["Loss mit. on track", "89%"]],
            rows: [
              ["UW-6621", "Underwriting · income verification", "hi", "TC"],
              ["LM-3390", "Loss mitigation · options review", "md", "PV"],
              ["UW-6688", "Underwriting · auto-ranked", "lo", "EG"],
            ],
          },
        },
      ],
    },
    {
      id: "insurance",
      name: "Insurance",
      who: "P&C, specialty & warranty",
      tag: "Triage and resolve claims across lines with a consistent, auditable call.",
      headline: "Triage severity, catch leakage and settle — the same defensible way, every claim.",
      blurb:
        "Score severity on arrival, route each claim to the right desk, and settle with the coverage read and the reasoning captured — so outcomes hold up on review.",
      outcomes: ["Less claims leakage", "Right-desk routing", "Consistent settlements"],
      segments: [
        {
          id: "claims",
          name: "Auto & Property Claims",
          useCases: [
            ["Auto & Trucking Claims", "Triage severity, spot leakage and route each claim to the right desk."],
            ["Construction & Property", "Handle defect and property claims with the evidence in one place."],
          ],
          workflow: {
            kpis: [["Open claims", "647"], ["Leakage caught", "$1.2M"], ["Right-desk routing", "98%"]],
            rows: [
              ["CLM-55210", "Auto claim · high severity", "hi", "DW"],
              ["PROP-9021", "Construction claim · defect review", "md", "IK"],
              ["CLM-55344", "Property claim · standard review", "lo", "BT"],
            ],
          },
        },
        {
          id: "workers-comp",
          name: "Workers' Compensation",
          useCases: [
            ["Workers' Compensation", "Manage claims and reserves with the reasoning captured end to end."],
          ],
          workflow: {
            kpis: [["Open claims", "214"], ["Reserve accuracy", "92%"], ["Return-to-work", "+18%"]],
            rows: [
              ["WC-19042", "Workers' comp · reserve review", "hi", "NB"],
              ["WC-19088", "Workers' comp · medical review", "md", "OL"],
              ["WC-19110", "Workers' comp · closed, validated", "lo", "QF"],
            ],
          },
        },
        {
          id: "warranty",
          name: "Warranty",
          useCases: [["Warranty Claims", "Validate coverage and settle warranty claims at scale."]],
          workflow: {
            kpis: [["Open claims", "389"], ["Validation rate", "96%"], ["Cycle time", "−27%"]],
            rows: [
              ["WAR-8821", "Warranty · coverage validated", "hi", "EK"],
              ["WAR-8855", "Warranty · parts dispute", "md", "GC"],
              ["WAR-8890", "Warranty · auto-approved", "lo", "ZM"],
            ],
          },
        },
      ],
    },
    {
      id: "risk-ops",
      name: "Risk, Trust & Operations",
      who: "Back-office adjudication queues",
      tag: "The judgment-heavy back-office queues, standardized and sped up.",
      headline: "Standardize the judgment calls buried in operations — and clear the backlog.",
      blurb:
        "Invoice audit, screening, appeals and notices are all the same shape: read the evidence, apply the policy, decide. Datacern runs each as a governed queue your team can trust.",
      outcomes: ["Shorter backlogs", "Policy applied consistently", "Every call defensible"],
      segments: [
        {
          id: "invoice-vetting",
          name: "Invoice & Vetting",
          useCases: [
            ["AP Invoice Audit", "Catch duplicate, non-compliant and over-billed invoices before they pay."],
            ["Background & Seller Vetting", "Adjudicate screening and marketplace-vetting cases against policy."],
          ],
          workflow: {
            kpis: [["Open cases", "890"], ["Duplicate billing caught", "$310K"], ["Backlog", "−58%"]],
            rows: [
              ["INV-40213", "Invoice audit · duplicate billing", "hi", "TS"],
              ["SCR-9042", "Seller vetting · flagged pattern", "md", "GH"],
              ["INV-40255", "Invoice audit · auto-cleared", "lo", "WD"],
            ],
          },
        },
        {
          id: "trust-safety",
          name: "Trust & Safety",
          useCases: [["Trust & Safety Appeals", "Review enforcement appeals quickly and consistently."]],
          workflow: {
            kpis: [["Open appeals", "412"], ["Review SLA", "94%"], ["Consistency score", "99%"]],
            rows: [
              ["APP-2201", "Enforcement appeal · standard review", "hi", "CP"],
              ["APP-2244", "Enforcement appeal · escalated", "md", "YB"],
              ["APP-2290", "Enforcement appeal · upheld", "lo", "MR"],
            ],
          },
        },
        {
          id: "tax-compliance",
          name: "Tax & Compliance",
          useCases: [["Tax Notice Resolution", "Classify notices, draft the response and track each to closure."]],
          workflow: {
            kpis: [["Open notices", "1,204"], ["Response SLA", "100%"], ["Auto-classified", "82%"]],
            rows: [
              ["TAX-7710", "Notice · deadline this week", "hi", "JL"],
              ["TAX-7744", "Notice · response drafted", "md", "VK"],
              ["TAX-7790", "Notice · closed", "lo", "SF"],
            ],
          },
        },
      ],
    },
  ],

  /* Breadth beyond the flagships is deliberately NOT enumerated here — the
   * full industry-grouped catalog lives on /solutions, generated from the pack
   * manifests, so the two pages can never drift apart or duplicate. This page
   * only says the boundary and hands off. */
  moreIndustries: {
    title: "…and any other decision that runs on data",
    note: "Same platform · same governance",
    dontSee: {
      lead: "Don't see yours?",
      body:
        " Datacern isn't built around an industry — it's built around the decision. New verticals install as capability packs onto the same core, so any judgment-heavy queue is a fit — the full catalog below is grouped by industry.",
    },
  },

  /* the pack-catalog CTA band — {count} renders SOLUTION_PACK_COUNT from the
   * generated catalog, so the headline cannot drift from what ships. */
  catalogCta: {
    headline: "{count} installable solution packs — and counting",
    body:
      "Every queue above ships as a pack: intake rules, dispositions, regulatory grounding, dashboards and roles — installed onto the same governed engine.",
    action: { label: "Browse the catalog", href: "/solutions" },
  },

  capabilitiesIntro: {
    eyebrow: "One platform under every industry",
    title: "Every solution runs on the same AI operation.",
    sub:
      "The industry packs above aren't separate products — they're the same coordinated set of AI capabilities that read, reason, decide and learn, with governance running through all of it. Learn the platform once; reuse it in every queue.",
  },

  /* Category comparison — the boundary a BI vendor cannot cross. The
   * separating question is deliberately concrete: "show me the record of ONE
   * decision — who proposed it, who approved it, what evidence they saw, what
   * changed in the source system." Row shape: [dimension, BI, models, Datacern]. */
  compare: {
    eyebrow: "Where the work actually lands",
    title: "A different category from BI and AI",
    sub:
      "Business intelligence tells you what happened. AI models predict what might. Decision intelligence makes the call — governed, evidenced and accountable — and learns from every one.",
    dimensionLabel: "By this measure",
    datacernSubtitle: "Approved actions",
    cols: ["Traditional BI", "AI / ML models", "Approved actions"],
    rows: [
      ["What it delivers", "Dashboards & reports", "Predictions & scores", "A governed decision + its reasoning"],
      ["Unit of work", "A metric or a chart", "A model output", "A case, handled end to end"],
      ["Who acts on it", "An analyst reads, then acts by hand", "A person interprets the score", "Agents draft, your expert approves, the action is taken"],
      ["Evidence & audit", "Numbers, no per-decision trail", "Often a black box", "Every decision has evidence, an owner and a trail"],
      ["Governance", "Access control", "Model governance (sometimes)", "Four-eyes, row-level isolation, policy-as-code, immutable audit"],
      ["Learning loop", "Static until rebuilt", "Retrained offline", "Every human correction trains the next model"],
      ["Consistency", "Depends on the analyst", "Consistent scores", "Consistent, policy-driven determinations"],
      ["Time to value", "Build the dashboards", "Build & train the models", "Install a solution pack for the decision"],
    ],
    note:
      "Keep your dashboards and your models — Datacern adds a governed decision layer on top, so the insight actually becomes an auditable action.",
  },

  how: {
    title: "How every decision flows",
    sub:
      "A loop, not a pipeline — the work moves quickly, the accountability never leaves your people, and every decision makes the next one better.",
    outcomesLabel: "What changes for your team:",
    outcomes: [
      "Shorter backlogs",
      "Consistent determinations",
      "Confident audits",
      "Lower cost per decision",
      "Experts on judgment, not busywork",
    ],
  },

  architecture: {
    title: "Under the hood, on your cloud",
    sub:
      "Twenty-three services in five planes over an all-open-source backbone — and one Terraform + Helm path each for AWS, Google Cloud and Azure, shipped in the same repository as the platform. The diagrams below are generated from that code, not drawn from ambition.",
  },

  spotlights: {
    solutionsTab: "Solutions that ship",
    workflowTab: "In your workflow",
    mockLabel: "Illustrative product mock — not customer data",
    reviewNote: "Reviewed and approved by your team — logged automatically",
    outro: {
      lead: "…and your operation next.",
      body:
        " New solutions install onto the same governed platform — your teams learn the tool once and reuse it everywhere.",
    },
  },

  /* a teaser only — the mechanisms behind each control live on /security
   * (SECURITY_CONTENT), which this band links to instead of repeating. */
  trust: {
    eyebrow: "Built for scrutiny",
    title: "Governance isn't a feature. It's the foundation.",
    sub:
      "The controls a regulated buyer needs are how the whole thing works — so security and compliance are on your side from day one.",
    items: [
      ["Your data stays yours", "Cleanly isolated for your organization — never mingled, never shared."],
      ["Least-privilege access", "Everyone sees and does exactly what their role allows, and nothing more."],
      ["A second set of eyes", "The changes that matter most require another reviewer to sign off before they go live."],
      ["A tamper-evident trail", "Who decided what, when, and on what evidence — captured for every action, ready for any review."],
    ],
    more: { label: "See how each control is enforced", href: "/security" },
  },

  faq: {
    title: "Questions, answered",
    items: [
      ["What does Datacern actually do?",
        "It works your regulated back-office queues — disputes, claims, alerts, invoices — and keeps a named person accountable for every outcome. Agents read the case, apply your rules and draft the recommendation with its evidence. A person approves it, someone other than the requester signs anything sensitive, and the whole chain is recorded. Ask any vendor for the complete record of one decision — who proposed it, who approved it, what evidence they saw, what changed in the source system. That record is what this platform is built to produce."],
      ["What exactly is “agentic AI”?",
        "A chatbot answers a question; a model returns a score. An agentic AI takes on multi-step work: it reads the evidence, checks it against your rules, uses tools to gather what it needs, and drafts a decision or action — then hands it to a person to approve. Datacern runs a team of these specialist agents (triage, analytics, governance and more), each scoped to what it's allowed to see and do. They propose; they never act on their own."],
      ["How is this different from BI or analytics?",
        "BI tells you what happened and leaves the decision to you. Datacern is built around the decision itself: it reads the case, drafts the call with cited evidence, records who decided and why, and learns from every correction — end to end, under governance. Dashboards are one capability inside it, not the point."],
      ["How is it different from just using an LLM or an ML model?",
        "An LLM or model gives you an output; you still have to ground it, govern it, route the work, capture the audit trail and close the loop. Datacern is that surrounding system — grounding on your governed data, four-eyes approval, immutable audit, and a correction-to-retrain loop — with the models plugged in where they help."],
      ["Does the AI ever act on its own?",
        "No. Agents draft recommendations and the assistant proposes changes, but a person approves, adjusts or rejects every outcome. Sensitive changes require a second reviewer (four-eyes) before they go live."],
      ["Do the agents replace my team?",
        "No — they do the reading and drafting so your experts spend their time on judgment, not busywork. People stay accountable for every determination; the routine gets automated and the hard calls get more attention."],
      ["How do you prevent hallucinations and wrong decisions?",
        "Answers and drafts are grounded in your governed data and cite the evidence they used. Nothing is a silent write — every decision is gated by a human, sensitive ones by a second reviewer. Models are evaluated against your benchmarks before they're ever promoted, and every action is logged for review."],
      ["Is our data secure and compliant?",
        "Your data is cleanly isolated for your organization (row-level security), everyone operates under least-privilege access, the changes that matter need a second set of eyes, and every action lands in a tamper-evident trail. You can bring your own identity provider, secrets store and cloud."],
      ["Will it work with our existing data, models and stack?",
        "Bring data as files or from your sources; it's profiled on arrival and queryable quickly. Define metrics and models on top, or plug in models you already own — you keep your system of record."],
      ["How quickly can we get value?",
        "Start from a solution pack shaped for your domain — the data model, metrics, work queues and expertise already in place — instead of a blank slate. New verticals install onto the same governed core."],
      ["How do you keep AI costs from spiraling?",
        "Work is routed across model tiers, and repetitive decisions migrate onto smaller models you own — so scaling volume doesn't mean scaling the bill."],
    ],
  },

  closingCta: {
    title: "Many directions. One confident, auditable bearing.",
    body:
      "Put an AI operation to work on the calls that matter — with your experts in command and a record that speaks for itself when anyone asks.",
  },

  demoDialog: {
    title: "Request a demo",
    sub: "See Datacern AI on your kind of decisions. Tell us a little about you.",
    fields: {
      name: "Full name",
      email: "Work email",
      company: "Company",
      teamSize: "Team size",
      teamSizeOptions: ["1–10", "11–50", "51–200", "200+"],
      message: "What are you looking to solve?",
      optional: "(optional)",
      selectPlaceholder: "Select…",
    },
    submit: "Request a demo",
    submitting: "Sending…",
    privacy: "We'll only use your details to arrange your demo.",
    done: {
      title: "Thanks — we'll be in touch.",
      body: "Your request is in. Someone from our team will reach out to set up your demo.",
      close: "Close",
    },
    errors: {
      validation: "Please check the highlighted fields.",
      generic: "Something went wrong. Please try again.",
      network: "Couldn't reach the server. Please try again.",
    },
  },
} as const;

export type WelcomeIndustry = (typeof WELCOME_CONTENT.industries)[number];
export type WelcomeCap = (typeof WELCOME_CONTENT.caps)[number];
