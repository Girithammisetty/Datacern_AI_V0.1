/**
 * Human-friendly labels for internal identifiers (tool ids, agent keys) so the
 * approvals/inbox surfaces never show raw tokens like "case.apply_disposition"
 * or "ml_engineer" to non-technical reviewers. Falls back to a generic
 * de-slugify for ids not in the known map, so a new tool still reads cleanly.
 */

// action-first wording for the common governed tools an agent proposes.
const TOOL_LABELS: Record<string, string> = {
  "case.apply_disposition": "Apply case disposition",
  "case.get": "Read case",
  "inference.submit": "Submit prediction job",
  "pipeline.train": "Train a model",
  "mlops.open_retrain": "Open a retraining run",
  "ingestion.create": "Start a data ingestion",
  "dataset.inspect": "Inspect a dataset",
  "proposal.apply": "Apply a proposed change",
};

const AGENT_LABELS: Record<string, string> = {
  triage: "Triage agent",
  ml_engineer: "ML engineer agent",
  analyst: "Analyst agent",
  reviewer: "Reviewer agent",
  governance: "Governance agent",
};

/** Title-case a snake/kebab/dotted slug's last segment (generic fallback). */
function deslugify(raw: string): string {
  const seg = raw.includes(".") ? raw.split(".").slice(1).join(" ") : raw;
  const words = seg.replace(/[_-]+/g, " ").trim();
  if (!words) return raw;
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Friendly label for a governed tool id (e.g. "case.apply_disposition"). */
export function toolLabel(tool?: string | null): string {
  if (!tool) return "Proposed change";
  return TOOL_LABELS[tool] ?? deslugify(tool);
}

/** Friendly label for an agent key (e.g. "ml_engineer" → "ML engineer agent"). */
export function agentLabel(agentKey?: string | null): string {
  if (!agentKey) return "";
  return AGENT_LABELS[agentKey] ?? `${deslugify(agentKey)} agent`;
}
