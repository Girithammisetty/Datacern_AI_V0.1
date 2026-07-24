"use client";

import { forwardRef, useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  BarChart3,
  Bot,
  Building2,
  Car,
  Check,
  ChevronDown,
  Cpu,
  CreditCard,
  Factory,
  FlaskConical,
  Gavel,
  GraduationCap,
  HardHat,
  HeartPulse,
  History,
  Home,
  Landmark,
  ListChecks,
  MessageSquareText,
  Network,
  Plane,
  Radio,
  Rocket,
  Scale,
  ShieldCheck,
  ShoppingBag,
  Sparkles,
  Sprout,
  Truck,
  Umbrella,
  Users,
  Workflow,
  X,
  Zap,
} from "lucide-react";
import { DatacernLogo } from "@/components/brand/DatacernLogo";
import { Button } from "@/components/ui/button";

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
/* the AI-capability tabs (the centerpiece)                            */
/* ------------------------------------------------------------------ */
const CAPS = [
  {
    key: "agents",
    icon: Bot,
    eyebrow: "Agentic workforce",
    title: "A team of specialist AI agents",
    body:
      "Purpose-built agents do the reading and draft the work — triaging cases, answering data questions, designing dashboards, training models, watching for drift. They propose; they never act on their own.",
    points: ["Draft dispositions with cited evidence", "Route work to the right specialist", "Open proposals, never silent writes"],
  },
  {
    key: "worklist",
    icon: ListChecks,
    eyebrow: "Governed queue",
    title: "A worklist built for decisions",
    body:
      "Every case lands pre-scored by risk and age, with the evidence and the agent's draft already attached — so your reviewers open a case ready to decide, not to dig for context.",
    points: ["Auto-prioritized by risk and SLA", "Evidence and draft attached on open", "Assign, escalate or approve in one place"],
  },
  {
    key: "copilot",
    icon: MessageSquareText,
    eyebrow: "Conversational",
    title: "A copilot that knows your role",
    body:
      "Ask in plain language and get an answer grounded in your governed data and your permissions. Need a change made? The copilot proposes it for a human to approve — it can't do anything you couldn't.",
    points: ["Grounded in your metrics, not guesses", "Aware of what you're allowed to see", "Turns a question into a governed action"],
  },
  {
    key: "entity",
    icon: Network,
    eyebrow: "Data unification",
    title: "Entity resolution",
    body:
      "The same person or party shows up across systems under different identifiers. Datacern unifies those fragmented records into one resolved entity — so decisions run on the full picture, not a single row.",
    points: ["Deterministic + probabilistic matching", "Ambiguous merges reviewed by a human", "Decide on total exposure, not one record"],
  },
  {
    key: "decisions",
    icon: Workflow,
    eyebrow: "Codified policy",
    title: "No-code decision automation",
    body:
      "Turn your operating policy into decision tables anyone can read. Apply them consistently across thousands of cases — and every table change is itself reviewed before it goes live.",
    points: ["Author rules without engineering", "Consistent outcomes, every case", "Change control on the logic itself"],
  },
  {
    key: "analytics",
    icon: BarChart3,
    eyebrow: "Governed insight",
    title: "Analytics your team can trust",
    body:
      "Business metrics are defined once, reviewed, and reused everywhere — so dashboards agree. Click any bar, slice or row and the whole board filters to match.",
    points: ["One trusted definition per metric", "Cross-filter the entire board", "From a chart straight into a work queue"],
  },
  {
    key: "audit",
    icon: History,
    eyebrow: "Tamper-evident",
    title: "An audit trail for every decision",
    body:
      "Every proposal, approval and override is time-stamped and chained together — so when a regulator or auditor asks why a call was made, the answer is already written down.",
    points: ["Immutable, chained record", "A second reviewer on sensitive changes", "Exportable evidence, case by case"],
  },
  {
    key: "ml",
    icon: Cpu,
    eyebrow: "Own your models",
    title: "Machine learning, built in",
    body:
      "Train candidate models on your own decisions, evaluate them against your benchmarks, and promote the winner through an approval gate. Repetitive calls move off expensive AI and onto models you own.",
    points: ["No-code pipelines over a rich algorithm catalog", "Evaluated before anything ships", "Cost per decision trends down"],
  },
] as const;

/* the specialist AI agents, as a moving roster — business-facing roles, each with
 * the job it does. (Internal orchestration agents like routing/inference plumbing
 * are intentionally not surfaced here.) */
const AGENTS: [string, string][] = [
  ["Claims Triage Agent", "reads each case and drafts the disposition"],
  ["Analytics Copilot", "answers data questions in plain language"],
  ["Governance & Compliance Agent", "checks every action against policy"],
  ["Data Onboarding Agent", "profiles new data and gets it decision-ready"],
  ["Reporting Designer Agent", "builds the dashboards your team needs"],
  ["Model Ops Agent", "trains, evaluates and promotes your models"],
];

const STEPS = [
  ["AI does the reading", "Agents gather the evidence, check it against your rules, and draft a clear recommendation with the reasoning laid out."],
  ["Your expert decides", "Approve, adjust or override. People stay accountable for every outcome — nothing acts on its own."],
  ["It learns and improves", "Each decision becomes training data. Quality climbs, the routine gets automated, and your team is freed for the hard calls."],
];

/* Solutions organized by industry — each use case is a real installable
 * capability pack. Industry is the primary way a buyer navigates: pick your
 * world (payer, bank, carrier, ops) and see the exact queues Datacern runs, the
 * outcomes that move, and the packs that ship it. */
const INDUSTRIES = [
  {
    id: "healthcare",
    name: "Healthcare",
    who: "Payers, providers & pharmacy",
    icon: HeartPulse,
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
    icon: Landmark,
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
    icon: Umbrella,
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
        useCases: [
          ["Warranty Claims", "Validate coverage and settle warranty claims at scale."],
        ],
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
    icon: Scale,
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
        useCases: [
          ["Trust & Safety Appeals", "Review enforcement appeals quickly and consistently."],
        ],
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
        useCases: [
          ["Tax Notice Resolution", "Classify notices, draft the response and track each to closure."],
        ],
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
] as const;

/* The wider industry map — Datacern runs ANY judgment-heavy, data-driven decision
 * queue, not just the four flagship packs above. Each entry names the industry and
 * a representative decision it automates. Icon + name + example. */
const MORE_INDUSTRIES: [React.ComponentType<{ className?: string }>, string, string][] = [
  [HeartPulse, "Healthcare & Life Sciences", "Prior auth, claims, payment integrity"],
  [Landmark, "Banking & Capital Markets", "AML alerts, disputes, credit decisions"],
  [Umbrella, "Insurance", "Claim triage, leakage, settlements"],
  [Building2, "Government & Public Sector", "Benefits, eligibility, case adjudication"],
  [Factory, "Manufacturing & Industrial", "Quality dispositions, MRB, warranty"],
  [ShoppingBag, "Retail & Consumer Goods", "Returns, chargebacks, seller vetting"],
  [Zap, "Energy & Utilities", "Inspections, outage triage, safety cases"],
  [Radio, "Telecom & Media", "Fraud, provisioning, content appeals"],
  [Truck, "Transportation & Logistics", "Freight claims, safety, exceptions"],
  [FlaskConical, "Pharma & Biotech", "Pharmacovigilance, device complaints"],
  [CreditCard, "Fintech & Payments", "Onboarding/KYC, disputes, risk"],
  [Home, "Real Estate & Mortgage", "Underwriting intake, loss mitigation"],
  [Gavel, "Legal & Compliance", "Contract review, sanctions, filings"],
  [GraduationCap, "Education", "Admissions, aid, integrity cases"],
  [Plane, "Travel & Hospitality", "Refunds, chargebacks, fraud"],
  [Car, "Automotive", "Warranty, recalls, defect claims"],
  [Rocket, "Aerospace & Defense", "Nonconformance, compliance, audits"],
  [Sprout, "Agriculture & Food", "Inspections, quality, traceability"],
  [HardHat, "Construction & Engineering", "Defect claims, safety, change orders"],
  [ShieldCheck, "Technology & Trust/Safety", "Abuse review, appeals, moderation"],
];

const TRUST = [
  ["Your data stays yours", "Cleanly isolated for your organization — never mingled, never shared."],
  ["Least-privilege access", "Everyone sees and does exactly what their role allows, and nothing more."],
  ["A second set of eyes", "The changes that matter most require another reviewer to sign off before they go live."],
  ["A tamper-evident trail", "Who decided what, when, and on what evidence — captured for every action, ready for any review."],
] as const;

/* Category comparison — how decision intelligence differs from BI and raw AI.
 * cols map to [dimension, traditional BI, AI/ML models, Datacern DI]. */
const COMPARE_COLS = ["Traditional BI", "AI / ML models", "Decision Intelligence"] as const;
const COMPARE: [string, string, string, string][] = [
  ["What it delivers", "Dashboards & reports", "Predictions & scores", "A governed decision + its reasoning"],
  ["Unit of work", "A metric or a chart", "A model output", "A case, handled end to end"],
  ["Who acts on it", "An analyst reads, then acts by hand", "A person interprets the score", "Agents draft, your expert approves, the action is taken"],
  ["Evidence & audit", "Numbers, no per-decision trail", "Often a black box", "Every decision has evidence, an owner and a trail"],
  ["Governance", "Access control", "Model governance (sometimes)", "Four-eyes, row-level isolation, policy-as-code, immutable audit"],
  ["Learning loop", "Static until rebuilt", "Retrained offline", "Every human correction trains the next model"],
  ["Consistency", "Depends on the analyst", "Consistent scores", "Consistent, policy-driven determinations"],
  ["Time to value", "Build the dashboards", "Build & train the models", "Install a solution pack for the decision"],
];

const FAQ = [
  ["What is decision intelligence?",
    "It's the discipline — and this platform — of turning your data, your policy and AI into governed, auditable decisions at scale. Not a dashboard that reports the past or a model that predicts it: a system that makes the call, attaches the evidence, and keeps a person accountable for every one."],
  ["What exactly is “agentic AI”?",
    "A chatbot answers a question; a model returns a score. An agentic AI takes on multi-step work: it reads the evidence, checks it against your rules, uses tools to gather what it needs, and drafts a decision or action — then hands it to a person to approve. Datacern runs a team of these specialist agents (triage, analytics, governance and more), each scoped to what it's allowed to see and do. They propose; they never act on their own."],
  ["How is this different from BI or analytics?",
    "BI tells you what happened and leaves the decision to you. Datacern is built around the decision itself: it reads the case, drafts the call with cited evidence, records who decided and why, and learns from every correction — end to end, under governance. Dashboards are one capability inside it, not the point."],
  ["How is it different from just using an LLM or an ML model?",
    "An LLM or model gives you an output; you still have to ground it, govern it, route the work, capture the audit trail and close the loop. Datacern is that surrounding system — grounding on your governed data, four-eyes approval, immutable audit, and a correction-to-retrain loop — with the models plugged in where they help."],
  ["Does the AI ever act on its own?",
    "No. Agents draft recommendations and the copilot proposes changes, but a person approves, adjusts or rejects every outcome. Sensitive changes require a second reviewer (four-eyes) before they go live."],
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
];

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
 * "In your workflow" panel. Rows are clearly illustrative placeholder data
 * (Rule #1 — no invented stats presented as real). */
type WfRow = readonly [id: string, desc: string, tag: "hi" | "md" | "lo", initials: string];

const TAG_LABEL: Record<WfRow[2], string> = { hi: "High", md: "Med", lo: "Low" };
const TAG_CLASS: Record<WfRow[2], string> = {
  hi: "bg-red-500/12 text-red-700 dark:text-red-400",
  md: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
  lo: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
};

function WfRowItem({ row }: { row: WfRow }) {
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
  const rows: WfRow[] = [
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
function IndustryShipsCard({ ind }: { ind: (typeof INDUSTRIES)[number] }) {
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
          Solutions that ship
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
          In your workflow
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
            Reviewed and approved by your team — logged automatically
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
    const t = setInterval(() => setTab((v) => (v + 1) % CAPS.length), 4200);
    return () => clearInterval(t);
  }, [auto]);

  const Cap = CAPS[tab];

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
            <span className="text-lg font-bold tracking-tight">Datacern AI</span>
          </div>
          <nav className="hidden items-center gap-7 text-sm text-muted-foreground md:flex">
            <a href="#industries" className="transition-colors hover:text-foreground">Industries</a>
            <a href="#capabilities" className="transition-colors hover:text-foreground">Platform</a>
            <a href="#difference" className="transition-colors hover:text-foreground">Why DI</a>
            <a href="#how" className="transition-colors hover:text-foreground">How it works</a>
            <a href="#faq" className="transition-colors hover:text-foreground">FAQ</a>
          </nav>
          <Button onClick={() => setDemoOpen(true)}>Request a demo</Button>
        </div>
      </header>

      {/* hero */}
      <section className="relative overflow-hidden">
        <div aria-hidden className="wr-mesh pointer-events-none absolute inset-0 -z-10" />
        <div className="mx-auto grid max-w-6xl items-center gap-12 px-6 pb-20 pt-14 md:grid-cols-2 md:pt-20">
          <div>
            <span className="inline-flex items-center gap-1.5 rounded-full border border-primary/30 bg-primary/10 px-3 py-1 text-xs font-semibold uppercase tracking-widest text-primary">
              <Sparkles className="size-3.5" />
              AI decision intelligence
            </span>
            <h1 className="wr-glowtext mt-6 text-balance text-4xl font-bold leading-[1.03] tracking-tight md:text-6xl">
              AI agents that decide,
              <br />
              with your experts{" "}
              <span className="wr-grad bg-clip-text text-transparent">in command.</span>
            </h1>
            <p className="mt-6 max-w-xl text-pretty text-lg leading-relaxed text-muted-foreground">
              Datacern AI puts a team of specialist agents to work on your industry&apos;s
              highest-stakes decisions — health claims, financial-crime alerts, insurance losses,
              back-office adjudication. Agents draft, a copilot assists, your people decide, and
              every correction trains the next model.
            </p>
            <div className="mt-9 flex flex-wrap items-center gap-3">
              <Button size="lg" onClick={() => setDemoOpen(true)}>
                Request a demo <ArrowRight className="size-4" />
              </Button>
              <Button asChild size="lg" variant="outline">
                <a href="#industries">Explore by industry</a>
              </Button>
            </div>
            <p className="mt-6 text-sm text-muted-foreground">
              Governed end to end — every determination has evidence, an owner, and a trail.
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
                Agentic AI at work
              </span>
              <div className="wr-marquee-wrap flex-1">
                <div className="wr-marquee flex gap-2">
                  {[...AGENTS, ...AGENTS].map(([name, role], i) => (
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
            Solutions by industry
          </span>
          <h2 className="mt-5 text-balance text-3xl font-bold tracking-tight md:text-4xl">
            Decision intelligence for every industry
          </h2>
          <p className="mt-3 max-w-2xl text-muted-foreground">
            If a team reads evidence, applies a policy and makes a call — at volume and under scrutiny —
            Datacern runs it. Four domains ship deep today; the same governed platform adapts to any
            data-driven decision queue.
          </p>
        </Reveal>

        <div className="mt-9 text-xs font-semibold uppercase tracking-widest text-muted-foreground">
          Flagship solutions — built deep
        </div>
        <div className="mt-4 grid gap-5 sm:grid-cols-2">
          {INDUSTRIES.map((ind, i) => {
            const Icon = ind.icon;
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

        {/* the wider industry map — Datacern runs any data-driven decision */}
        <div className="mt-14">
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <h3 className="text-xl font-bold tracking-tight">…and any other decision that runs on data</h3>
            <span className="text-sm text-muted-foreground">Same platform · same governance</span>
          </div>
          <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {MORE_INDUSTRIES.map(([Icon, name, ex], i) => (
              <Reveal key={name} delay={(i % 4) * 40}>
                <div className="group flex h-full items-start gap-3 rounded-xl wr-glass wr-ring p-3.5 transition-all hover:-translate-y-0.5 hover:shadow-[0_20px_50px_-30px_hsl(var(--primary)/0.6)]">
                  <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary transition-colors group-hover:bg-primary group-hover:text-primary-foreground">
                    <Icon className="size-4" />
                  </span>
                  <div className="min-w-0">
                    <div className="text-sm font-semibold leading-tight">{name}</div>
                    <div className="mt-0.5 text-xs leading-snug text-muted-foreground">{ex}</div>
                  </div>
                </div>
              </Reveal>
            ))}
          </div>
          <p className="mt-7 max-w-2xl text-sm text-muted-foreground">
            <span className="font-medium text-foreground">Don&apos;t see yours?</span> Datacern isn&apos;t
            built around an industry — it&apos;s built around the decision. New verticals install as
            capability packs onto the same core, so any judgment-heavy queue is a fit.
          </p>
        </div>
      </section>

      {/* capabilities showcase (interactive tabs) */}
      <section id="capabilities" className="mx-auto max-w-6xl scroll-mt-20 px-6 py-20">
        <Reveal>
          <span className="inline-flex items-center gap-1.5 rounded-full border border-primary/30 bg-primary/10 px-3 py-1 text-xs font-semibold uppercase tracking-widest text-primary">
            <Cpu className="size-3.5" />
            One platform under every industry
          </span>
          <h2 className="mt-5 text-balance text-3xl font-bold tracking-tight md:text-4xl">
            Every solution runs on the same AI operation.
          </h2>
          <p className="mt-3 max-w-2xl text-muted-foreground">
            The industry packs above aren&apos;t separate products — they&apos;re the same coordinated set
            of AI capabilities that read, reason, decide and learn, with governance running through all
            of it. Learn the platform once; reuse it in every queue.
          </p>
        </Reveal>

        <div className="mt-10 grid gap-8 lg:grid-cols-[1.1fr_1fr]">
          {/* tab list */}
          <div className="grid gap-2.5 sm:grid-cols-2">
            {CAPS.map((c, i) => {
              const Icon = c.icon;
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
          {CAPS.map((c, i) => (
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

      {/* how decision intelligence is different — BI vs AI vs DI */}
      <section id="difference" className="scroll-mt-16 border-t border-border/60">
        <div className="mx-auto max-w-6xl px-6 py-20">
          <Reveal>
            <span className="inline-flex items-center gap-1.5 rounded-full border border-primary/30 bg-primary/10 px-3 py-1 text-xs font-semibold uppercase tracking-widest text-primary">
              <Sparkles className="size-3.5" />
              Why decision intelligence
            </span>
            <h2 className="mt-5 text-balance text-3xl font-bold tracking-tight md:text-4xl">
              A different category from BI and AI
            </h2>
            <p className="mt-3 max-w-2xl text-muted-foreground">
              Business intelligence tells you what happened. AI models predict what might. Decision
              intelligence makes the call — governed, evidenced and accountable — and learns from every one.
            </p>
          </Reveal>

          <Reveal delay={80}>
            <div className="mt-10 overflow-x-auto">
              <table className="w-full min-w-[760px] border-separate border-spacing-0 text-left align-top text-sm">
                <thead>
                  <tr>
                    <th className="w-[22%] px-4 pb-4 align-bottom text-xs font-semibold uppercase tracking-widest text-muted-foreground">
                      By this measure
                    </th>
                    {COMPARE_COLS.map((c, i) => {
                      const di = i === COMPARE_COLS.length - 1;
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
                              Decision Intelligence
                            </span>
                          )}
                        </th>
                      );
                    })}
                  </tr>
                </thead>
                <tbody>
                  {COMPARE.map(([dim, bi, ai, di], r) => {
                    const last = r === COMPARE.length - 1;
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

          <p className="mt-5 max-w-2xl text-sm text-muted-foreground">
            Keep your dashboards and your models — Datacern adds a governed decision layer on top, so the
            insight actually becomes an auditable action.
          </p>
        </div>
      </section>

      {/* how it works */}
      <section id="how" className="border-t border-border/60 bg-card/50">
        <div className="mx-auto max-w-6xl scroll-mt-20 px-6 py-20">
          <Reveal>
            <h2 className="text-3xl font-bold tracking-tight">How every decision flows</h2>
            <p className="mt-3 max-w-2xl text-muted-foreground">
              Three steps, every time — so the work moves quickly and the accountability never leaves your people.
            </p>
          </Reveal>
          <div className="mt-10 grid gap-6 md:grid-cols-3">
            {STEPS.map(([title, body], i) => (
              <Reveal key={title} delay={i * 90}>
                <div className="wr-glass wr-ring relative h-full rounded-2xl p-7">
                  <div className="flex size-9 items-center justify-center rounded-full bg-primary/15 text-sm font-bold text-primary ring-1 ring-primary/30">
                    {i + 1}
                  </div>
                  <h3 className="mt-4 text-lg font-semibold">{title}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{body}</p>
                </div>
              </Reveal>
            ))}
          </div>
          <div className="mt-10 flex flex-wrap items-center gap-x-3 gap-y-2">
            <span className="text-sm font-medium text-foreground">What changes for your team:</span>
            {["Shorter backlogs", "Consistent determinations", "Confident audits", "Lower cost per decision", "Experts on judgment, not busywork"].map((o) => (
              <span key={o} className="rounded-full border border-border/70 bg-card px-3 py-1 text-xs text-muted-foreground">
                {o}
              </span>
            ))}
          </div>
        </div>
      </section>

      {/* per-industry spotlights */}
      <div id="solutions">
        {INDUSTRIES.map((ind, idx) => {
          const Icon = ind.icon;
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
                    Request a demo <ArrowRight className="size-4" />
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
            <span className="font-medium text-foreground">…and your operation next.</span> New solutions
            install onto the same governed platform — your teams learn the tool once and reuse it everywhere.
          </p>
        </div>
      </div>

      {/* trust */}
      <section className="border-t border-border/60 bg-card/50">
        <div className="mx-auto max-w-6xl px-6 py-20">
          <Reveal>
            <span className="inline-flex items-center gap-1.5 rounded-full border border-primary/30 bg-primary/10 px-3 py-1 text-xs font-semibold uppercase tracking-widest text-primary">
              <ShieldCheck className="size-3.5" />
              Built for scrutiny
            </span>
            <h2 className="mt-5 text-3xl font-bold tracking-tight">Governance isn&apos;t a feature. It&apos;s the foundation.</h2>
            <p className="mt-3 max-w-2xl text-muted-foreground">
              The controls a regulated buyer needs are how the whole thing works — so security and
              compliance are on your side from day one.
            </p>
          </Reveal>
          <div className="mt-10 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
            {TRUST.map(([title, body], i) => (
              <Reveal key={title} delay={i * 70}>
                <div>
                  <h3 className="text-sm font-semibold">{title}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{body}</p>
                </div>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* faq */}
      <section id="faq" className="mx-auto max-w-3xl scroll-mt-20 px-6 py-20">
        <h2 className="text-center text-3xl font-bold tracking-tight">Questions, answered</h2>
        <div className="wr-glass wr-ring mt-8 divide-y divide-border/60 rounded-2xl">
          {FAQ.map(([q, a], i) => {
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
            Many directions. One confident, auditable bearing.
          </h2>
          <p className="max-w-xl text-pretty text-muted-foreground">
            Put an AI operation to work on the calls that matter — with your experts in command and a
            record that speaks for itself when anyone asks.
          </p>
          <Button size="lg" className="mt-2" onClick={() => setDemoOpen(true)}>
            Request a demo <ArrowRight className="size-4" />
          </Button>
        </div>
      </section>

      <footer className="border-t border-border/60">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-2 px-6 py-6 text-xs text-muted-foreground sm:flex-row">
          <span>Datacern AI — Decision Intelligence platform</span>
          <span>AI proposes. People decide. The platform remembers.</span>
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
      setErr(
        json.error === "validation"
          ? "Please check the highlighted fields."
          : "Something went wrong. Please try again.",
      );
      setState("error");
    } catch {
      setErr("Couldn't reach the server. Please try again.");
      setState("error");
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Request a demo"
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
            <h3 className="mt-4 text-lg font-bold tracking-tight">Thanks — we&apos;ll be in touch.</h3>
            <p className="mt-1.5 text-sm text-muted-foreground">
              Your request is in. Someone from our team will reach out to set up your demo.
            </p>
            <Button className="mt-5" onClick={onClose}>
              Close
            </Button>
          </div>
        ) : (
          <>
            <h3 className="text-lg font-bold tracking-tight">Request a demo</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              See Datacern AI on your kind of decisions. Tell us a little about you.
            </p>
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
              <Field label="Full name" name="name" autoComplete="name" ref={firstRef} bad={bad.includes("name")} />
              <Field label="Work email" name="email" type="email" autoComplete="email" bad={bad.includes("email")} />
              <Field label="Company" name="company" autoComplete="organization" bad={bad.includes("company")} />
              <div>
                <label htmlFor="teamSize" className="text-xs font-medium">
                  Team size <span className="text-muted-foreground">(optional)</span>
                </label>
                <select
                  id="teamSize"
                  name="teamSize"
                  defaultValue=""
                  className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/40"
                >
                  <option value="">Select…</option>
                  <option>1–10</option>
                  <option>11–50</option>
                  <option>51–200</option>
                  <option>200+</option>
                </select>
              </div>
              <div>
                <label htmlFor="message" className="text-xs font-medium">
                  What are you looking to solve? <span className="text-muted-foreground">(optional)</span>
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
                {state === "submitting" ? "Sending…" : "Request a demo"}
              </Button>
              <p className="text-center text-[11px] text-muted-foreground">
                We&apos;ll only use your details to arrange your demo.
              </p>
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
