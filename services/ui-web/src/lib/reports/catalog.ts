/**
 * Report catalog — presentation layer for Insights › Reports
 * (docs/initiatives/reports-hub.md). The catalog LIST is now
 * server-authoritative: the BFF's `reportCatalog` query returns the reports the
 * caller's capabilities can reach (see useReportCatalog), so the client no
 * longer decides visibility. This module keeps only the presentation concerns —
 * the domain labels and the grouping helper — plus the shared types the GraphQL
 * result conforms to.
 */
export type ReportFormat = "csv" | "json" | "artifact";
export type ReportDomain = "financial" | "governance" | "operations";
export type ReportCadence = "on_demand" | "monthly" | "point_in_time";

/** One catalog entry, exactly as the BFF `reportCatalog` query returns it
 * (server has already filtered by capability, so there is no client-side gate). */
export interface ReportDefinition {
  id: string;
  title: string;
  description: string;
  domain: ReportDomain;
  formats: ReportFormat[];
  cadence: ReportCadence;
  /** In-app route where the report runs/downloads. */
  href: string;
  /** True when the report can also be scheduled for email delivery. */
  schedulable: boolean;
  /** A real constraint disclosed on the card, or null. */
  note: string | null;
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
