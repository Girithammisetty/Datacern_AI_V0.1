/**
 * Report catalog — the discovery layer for Insights › Reports
 * (docs/initiatives/reports-hub.md). Before this, "Reports" was only scheduled
 * email subscriptions; every actual report the platform produces lived on an
 * admin/data page a line-of-business user would never find. This is a static,
 * capability-filtered index of the reports that EXIST and are REACHABLE today —
 * no aspirational entries — each linking to where it already runs/downloads.
 *
 * Pure metadata (no data fetch). The gate on each entry is a real capability
 * Gate (via cap()), so the hub can hide a report the viewer can't reach, using
 * the same useCapabilities().can() path the nav uses.
 */
import { cap, type Gate } from "@/lib/authz/registry";

export type ReportFormat = "csv" | "json" | "artifact";
export type ReportDomain = "financial" | "governance" | "operations";
export type ReportCadence = "on_demand" | "monthly" | "point_in_time";

export interface ReportDefinition {
  /** Stable slug (also the catalog test's identity + any future deep anchor). */
  id: string;
  title: string;
  /** What business question it answers — written for the person who wants it. */
  description: string;
  domain: ReportDomain;
  formats: ReportFormat[];
  cadence: ReportCadence;
  /** Capability required to see/run it — the same gate its owning page enforces. */
  gate: Gate;
  /** Where it runs/downloads today (route, optionally with a #hash). */
  href: string;
  /** True when it can also be scheduled for email delivery (subscriptions). */
  schedulable?: boolean;
  /** Honesty note surfaced on the card (a real constraint, never marketing). */
  note?: string;
}

export const REPORT_DOMAINS: Record<ReportDomain, { label: string; blurb: string }> = {
  financial: {
    label: "Cost & value",
    blurb: "What the platform costs and what it returned.",
  },
  governance: {
    label: "Governance & audit",
    blurb: "Evidence an examiner or auditor can follow.",
  },
  operations: {
    label: "Operations",
    blurb: "The work itself — cases, decisions, dashboards.",
  },
};

export const REPORT_CATALOG: ReportDefinition[] = [
  {
    id: "chargeback",
    title: "Chargeback / spend showback",
    description: "Priced monthly AI spend per meter and workspace — the invoice-line view of a finalized month.",
    domain: "financial",
    formats: ["csv"],
    cadence: "monthly",
    gate: cap("usage.report.read"),
    href: "/admin/usage",
    note: "Available for finalized months only; a month in reconciliation variance is blocked until resolved.",
  },
  {
    id: "value-roi",
    title: "ROI / value report",
    description: "Governed decisions, hours saved and cost-per-decision for the period, with every derived figure disclosing its assumption.",
    domain: "financial",
    formats: ["csv", "json"],
    cadence: "monthly",
    gate: cap("usage.report.read"),
    href: "/admin/value",
    note: "Hours-saved and net-value need a minutes-per-decision + loaded-rate assumption; no default is assumed for you.",
  },
  {
    id: "agent-inventory",
    title: "Agent inventory",
    description: "A flat, point-in-time list of every AI agent, what it's allowed to do, and its current control state — the EU AI Act Annex IV system inventory.",
    domain: "governance",
    formats: ["csv"],
    cadence: "point_in_time",
    gate: cap("ai.agent.read"),
    href: "/admin/agents",
  },
  {
    id: "evidence-pack",
    title: "Decision evidence pack",
    description: "For one governed decision: who proposed, who approved (a distinct human), the exact tool call, and cryptographic proof the record is unaltered.",
    domain: "governance",
    formats: ["json"],
    cadence: "point_in_time",
    gate: cap("audit.compliance.read"),
    href: "/inbox",
  },
  {
    id: "compliance-pack",
    title: "Compliance / audit pack",
    description: "A tenant + date-range evidence bundle (SOC 2 / EU AI Act) assembled from the tamper-evident audit chain.",
    domain: "governance",
    formats: ["artifact"],
    cadence: "on_demand",
    gate: cap("audit.compliance.read"),
    href: "/admin/audit/export",
  },
  {
    id: "case-export",
    title: "Case export",
    description: "The current case worklist as a file — filtered by status — for offline review or hand-off.",
    domain: "operations",
    formats: ["csv"],
    cadence: "on_demand",
    gate: cap("case.case.export"),
    href: "/cases",
  },
  {
    id: "decision-outcomes",
    title: "Decision outcomes",
    description: "How decisions resolved — approved / edited / rejected — the substrate for the learning loop and outcome monitoring.",
    domain: "operations",
    formats: ["csv"],
    cadence: "on_demand",
    gate: cap("case.disposition.read"),
    href: "/decisions",
  },
  {
    id: "dashboard-chart",
    title: "Dashboard & chart export",
    description: "Any governed chart's underlying rows as a file, straight from the dashboard it lives on.",
    domain: "operations",
    formats: ["csv"],
    cadence: "on_demand",
    gate: cap("chart.chart.export"),
    href: "/dashboards",
    schedulable: true,
  },
];

/** The catalog filtered to what the caller can actually reach. `can` is
 * useCapabilities().can — the same predicate the nav uses. */
export function visibleReports(can: (gate: Gate) => boolean): ReportDefinition[] {
  return REPORT_CATALOG.filter((r) => can(r.gate));
}

/** Group reports by domain, preserving REPORT_DOMAINS order and dropping empty
 * domains — so the hub never renders a heading with nothing under it. */
export function reportsByDomain(
  reports: ReportDefinition[],
): { domain: ReportDomain; reports: ReportDefinition[] }[] {
  const order = Object.keys(REPORT_DOMAINS) as ReportDomain[];
  return order
    .map((domain) => ({ domain, reports: reports.filter((r) => r.domain === domain) }))
    .filter((g) => g.reports.length > 0);
}
