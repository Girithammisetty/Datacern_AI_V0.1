/**
 * BRD 68 slice 3 — the agent inventory export, the last piece of the Agent
 * Control Tower (docs/initiatives/agent-control-tower.md). Buyer motivation:
 * the EU AI Act Art. 11/Annex IV "system inventory" use case — an operator
 * must be able to hand an auditor a flat, point-in-time list of every AI
 * agent, what it's allowed to do, and its current control state.
 *
 * Built entirely from the AgentFleetRow[] the fleet table already has in
 * hand (useAgentFleet) — no second network round-trip. Every column that
 * mirrors a resolver field carrying an `unavailable: Boolean!` sibling
 * (evalGate, spend, decisions — see typeDefs.ts AgentFleetRow doc and
 * resolvers/index.ts buildAgentFleetRows) renders the literal marker
 * UNAVAILABLE_MARKER when that sibling is true, or when the field was never
 * requested at all (spend omitted for a caller without
 * FEATURE_GATES.viewAgentFleetSpend) — never a blank cell or a fabricated 0,
 * per this repo's no-fabrication rule. Fields with no `unavailable` sibling
 * (guardrails, activeVersion, killSwitch) have no representable "down" state
 * in this schema revision (a hard outage on their source fails the whole
 * query instead, per the same doc comment) — a null there is a genuine
 * "not set", rendered as NOT_SET_MARKER, not UNAVAILABLE_MARKER.
 */
import type { AgentFleetRow } from "@/lib/graphql/types";
import { buildCsv } from "./csv";

/** Reserved for a field whose resolver source is down, permission-gated, or
 * (in slice 1) permanently unbuilt — see AgentFleetDecisions/AgentFleetSpend/
 * AgentFleetEvalGate's `unavailable` sibling. Never used for a legitimate
 * empty/zero value. */
export const UNAVAILABLE_MARKER = "UNAVAILABLE";
/** A field with no `unavailable` sibling that is genuinely null/empty (e.g.
 * no data-scope guardrail configured, no version digest recorded). */
const NOT_SET_MARKER = "—";

export const AGENT_INVENTORY_CSV_HEADER = [
  "Agent key",
  "Agent name",
  "Kind",
  "Lifecycle state",
  "Active version",
  "Version digest",
  "Rollout mode",
  "Guardrail envelope summary",
  "Toolset / permissions",
  "Eval gate status",
  "Eval gate last run (UTC)",
  "Kill switch state",
  "Kill switch actor",
  "Kill switch since (UTC)",
  "Spend period (USD)",
  "Spend trend 7d (%)",
  "Decisions proposed (period)",
  "Decisions approved (period)",
  "Decisions edited (period)",
  "Decisions rejected (period)",
  "Period start",
  "Period end",
  "Generated at (UTC)",
];

function formatGuardrails(row: AgentFleetRow): string {
  const g = row.guardrails;
  const dataScope = g.dataScope != null ? JSON.stringify(g.dataScope) : NOT_SET_MARKER;
  const tokenBudget = g.tokenBudget != null ? String(g.tokenBudget) : NOT_SET_MARKER;
  const piiEgress = g.piiEgress ?? NOT_SET_MARKER;
  const ruleOfTwo = g.ruleOfTwo ? "on" : "off";
  return `dataScope=${dataScope}; tokenBudget=${tokenBudget}; piiEgress=${piiEgress}; ruleOfTwo=${ruleOfTwo}`;
}

function formatToolset(row: AgentFleetRow): string {
  return row.toolset.length ? row.toolset.join("; ") : "none";
}

/** `${from}/${to}`, per bff-graphql's decisionsPeriod (resolvers/index.ts
 * resolveFleetPeriod) — decisions is a non-null field group on every row, so
 * this is the one reliable client-side source of the query's resolved
 * period bounds (the raw period isn't otherwise echoed back on
 * AgentFleetRow/AgentFleetSummary). Malformed input can't happen from a real
 * response, but degrades to the unavailable marker rather than a blank
 * rather than trusting an unexpected shape. */
function periodBounds(rows: AgentFleetRow[]): { start: string; end: string } {
  const raw = rows[0]?.decisions.period ?? "";
  const [start, end] = raw.split("/");
  if (!start || !end) return { start: UNAVAILABLE_MARKER, end: UNAVAILABLE_MARKER };
  return { start, end };
}

function spendCells(row: AgentFleetRow, includeSpend: boolean): [string, string] {
  // Not requested at all (viewer lacks usage.report.read — useAgentFleet's
  // includeSpend / FEATURE_GATES.viewAgentFleetSpend): genuinely unavailable
  // to THIS export, not a real zero.
  if (!includeSpend || !row.spend || row.spend.unavailable) return [UNAVAILABLE_MARKER, UNAVAILABLE_MARKER];
  const usd = row.spend.periodUsd != null ? row.spend.periodUsd.toFixed(2) : UNAVAILABLE_MARKER;
  // trend7dPct is legitimately null when there was no prior-period spend to
  // compare against (bucketSpendByAgent's priorUsd === 0 case) — a real
  // "not computable", not a source outage, so it gets the not-set marker.
  const trend = row.spend.trend7dPct != null ? row.spend.trend7dPct.toFixed(1) : NOT_SET_MARKER;
  return [usd, trend];
}

function decisionCells(row: AgentFleetRow): [string, string, string, string] {
  if (row.decisions.unavailable) {
    return [UNAVAILABLE_MARKER, UNAVAILABLE_MARKER, UNAVAILABLE_MARKER, UNAVAILABLE_MARKER];
  }
  const cell = (n?: number | null) => (n != null ? String(n) : NOT_SET_MARKER);
  return [cell(row.decisions.proposed), cell(row.decisions.approved), cell(row.decisions.edited), cell(row.decisions.rejected)];
}

function rowToCells(row: AgentFleetRow, opts: { includeSpend: boolean; periodStart: string; periodEnd: string; generatedAt: string }): string[] {
  const [spendUsd, spendTrend] = spendCells(row, opts.includeSpend);
  const [proposed, approved, edited, rejected] = decisionCells(row);
  return [
    row.key,
    row.display,
    row.kind,
    row.lifecycle,
    `v${row.activeVersion.id}`,
    row.activeVersion.graphDigest ?? NOT_SET_MARKER,
    row.activeVersion.rollout,
    formatGuardrails(row),
    formatToolset(row),
    row.evalGate.unavailable ? UNAVAILABLE_MARKER : row.evalGate.status,
    row.evalGate.unavailable ? UNAVAILABLE_MARKER : (row.evalGate.lastRunAt ?? "never run"),
    row.killSwitch.state,
    row.killSwitch.actor ?? NOT_SET_MARKER,
    row.killSwitch.updatedAt ?? NOT_SET_MARKER,
    spendUsd,
    spendTrend,
    proposed,
    approved,
    edited,
    rejected,
    opts.periodStart,
    opts.periodEnd,
    opts.generatedAt,
  ];
}

/**
 * Build the full RFC 4180 CSV document for the agent inventory export.
 * `rows` should be exactly what the fleet table already fetched
 * (useAgentFleet's query.data) — this function performs no fetching of its
 * own. `includeSpend` should mirror the same FEATURE_GATES.viewAgentFleetSpend
 * check the table uses, so the export never claims a real $0 for a viewer who
 * simply isn't allowed to see spend.
 */
export function buildAgentInventoryCsv(
  rows: AgentFleetRow[],
  opts: { includeSpend: boolean; generatedAt?: string },
): string {
  const generatedAt = opts.generatedAt ?? new Date().toISOString();
  const { start: periodStart, end: periodEnd } = periodBounds(rows);

  return buildCsv({
    leadingComments: [
      "Datacern AI system inventory export (Agent Control Tower, BRD 68).",
      `Point-in-time snapshot generated ${generatedAt}.`,
      `Period: ${periodStart} to ${periodEnd}.`,
      `Every "${UNAVAILABLE_MARKER}" cell reflects a real gap in the underlying source or a permission the export requester lacks — never a fabricated zero or blank.`,
    ],
    header: AGENT_INVENTORY_CSV_HEADER,
    rows: rows.map((r) => rowToCells(r, { includeSpend: opts.includeSpend, periodStart, periodEnd, generatedAt })),
  });
}

/** Filename for the download — includes the resolved period so a
 * re-generated export doesn't silently overwrite a differently-scoped one. */
export function agentInventoryFilename(rows: AgentFleetRow[]): string {
  const { start, end } = periodBounds(rows);
  const safe = (s: string) => s.replace(/[^0-9A-Za-z-]/g, "");
  return `datacern-agent-inventory_${safe(start)}_${safe(end)}.csv`;
}
