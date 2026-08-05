/**
 * Case worklist view model — the Case Workbench's shareable-state vocabulary.
 *
 * A "view" is nothing but a named bundle of URL params ({q, status, severity,
 * assignee, sort, dir, live, sla, insight}): applying one just rewrites the
 * URL, so the URL stays the single source of truth and every view remains a
 * shareable link. Three built-ins ship with no persistence; user-saved views
 * persist per-user in localStorage under `datacern.cases.views.v1`.
 *
 * HONESTY NOTES (mirror lib/insights/cases.ts):
 *  - `live` and `sla` are CLIENT-SIDE narrowings — CaseFilter can filter only
 *    {status, severity, assignee} server-side, and has no dueDate operator —
 *    so they apply to the loaded window only. The worklist banner says so.
 *  - `sort` is client-side over the loaded window too: caseSearch takes no
 *    sort argument. The UI must show a "sorted within loaded results" hint
 *    whenever more pages exist rather than implying a global order.
 *  - `sla` reuses the EXACT overdue/due-soon predicates from INSIGHT_DEFS —
 *    the same arithmetic the home insights and QueueIntelligencePanel counts
 *    are built on — so "SLA at risk" here provably means what it means there.
 */
import type { Case } from "@/lib/graphql/types";
import { INSIGHT_DEFS } from "@/lib/insights/cases";

export interface CaseViewParams {
  q?: string;
  status?: string;
  severity?: string;
  /** A user id, or the literal "me" (resolved to the session user at query
   * time so a shared "My open cases" link adapts to whoever opens it). */
  assignee?: string;
  sort?: CaseSortKey;
  dir?: "asc" | "desc";
  /** Client-side: keep only non-terminal (DRAFT/UNASSIGNED/IN_PROGRESS) cases. */
  live?: boolean;
  /** Client-side: keep only overdue or due-within-24h open cases. */
  sla?: boolean;
  /** Existing ?insight=<slug> narrowing (lib/insights/cases.ts). */
  insight?: string;
}

export interface SavedCaseView {
  id: string;
  name: string;
  params: CaseViewParams;
}

export type CaseSortKey = "due" | "severity" | "status" | "created";

/** Sort vocabulary. "updated" is deliberately absent: the caseSearch
 * projection carries no updatedAt field, and sorting on a field we don't have
 * would be a lie. createdAt is the honest available recency proxy. */
export const CASE_SORT_KEYS: readonly CaseSortKey[] = ["due", "severity", "status", "created"];

export const CASE_VIEWS_STORAGE_KEY = "datacern.cases.views.v1";

/* ---------------------------- URL round-trip ---------------------------- */

export function readViewParams(sp: URLSearchParams): CaseViewParams {
  const sortRaw = sp.get("sort") ?? "";
  const sort = (CASE_SORT_KEYS as readonly string[]).includes(sortRaw)
    ? (sortRaw as CaseSortKey)
    : undefined;
  return {
    q: sp.get("q") || undefined,
    status: sp.get("status") || undefined,
    severity: sp.get("severity") || undefined,
    assignee: sp.get("assignee") || undefined,
    sort,
    dir: sort ? (sp.get("dir") === "desc" ? "desc" : "asc") : undefined,
    live: sp.get("live") === "1" || undefined,
    sla: sp.get("sla") === "1" || undefined,
    insight: sp.get("insight") || undefined,
  };
}

export function viewParamsToSearch(p: CaseViewParams): string {
  const sp = new URLSearchParams();
  if (p.q) sp.set("q", p.q);
  if (p.status) sp.set("status", p.status);
  if (p.severity) sp.set("severity", p.severity);
  if (p.assignee) sp.set("assignee", p.assignee);
  if (p.sort) {
    sp.set("sort", p.sort);
    if (p.dir) sp.set("dir", p.dir);
  }
  if (p.live) sp.set("live", "1");
  if (p.sla) sp.set("sla", "1");
  if (p.insight) sp.set("insight", p.insight);
  return sp.toString();
}

/** Structural equality after normalization — drives the "active chip". */
export function viewParamsEqual(a: CaseViewParams, b: CaseViewParams): boolean {
  return viewParamsToSearch(a) === viewParamsToSearch(b);
}

/* ----------------------------- built-ins ----------------------------- */

export interface BuiltinCaseView {
  key: string;
  name: string;
  params: CaseViewParams;
}

export const BUILTIN_CASE_VIEWS: readonly BuiltinCaseView[] = [
  // assignee=me is a server-side filter; `live` narrows the loaded window to
  // non-terminal cases with the insights lib's own LIVE predicate.
  { key: "mine", name: "My open cases", params: { assignee: "me", live: true } },
  { key: "sla", name: "SLA at risk", params: { sla: true } },
  { key: "unassigned", name: "Unassigned", params: { status: "UNASSIGNED" } },
];

/* -------------------------- persistence (v1) -------------------------- */

/** Stored shape: { [userId]: SavedCaseView[] } under one versioned key, so a
 * shared browser profile never leaks one user's views into another session. */
type ViewsFile = Record<string, SavedCaseView[]>;

function readFile(): ViewsFile {
  try {
    const raw = window.localStorage.getItem(CASE_VIEWS_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as ViewsFile) : {};
  } catch {
    return {};
  }
}

export function loadSavedViews(userId: string): SavedCaseView[] {
  if (typeof window === "undefined") return [];
  const mine = readFile()[userId];
  return Array.isArray(mine)
    ? mine.filter((v) => v && typeof v.id === "string" && typeof v.name === "string" && !!v.params)
    : [];
}

export function persistSavedViews(userId: string, views: SavedCaseView[]): void {
  if (typeof window === "undefined") return;
  try {
    const file = readFile();
    file[userId] = views;
    window.localStorage.setItem(CASE_VIEWS_STORAGE_KEY, JSON.stringify(file));
  } catch {
    /* quota/privacy-mode failures degrade to session-only views */
  }
}

/* ------------------------- client-side predicates ------------------------- */

const overdueDef = INSIGHT_DEFS.find((d) => d.slug === "overdue");
const dueSoonDef = INSIGHT_DEFS.find((d) => d.slug === "due-soon");

/** "SLA at risk" = the union of the overdue and due-soon insight predicates —
 * the SAME rules the home insight cards count with, not a re-derivation. */
export function slaAtRisk(c: Case, now: number): boolean {
  return !!(overdueDef?.match(c, now) || dueSoonDef?.match(c, now));
}

/* ------------------------------ sorting ------------------------------ */

const SEVERITY_RANK: Record<string, number> = { LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 };
const STATUS_RANK: Record<string, number> = {
  DRAFT: 0,
  UNASSIGNED: 1,
  IN_PROGRESS: 2,
  RESOLVED: 3,
  CLOSED: 4,
};

function timeOf(value: string | null | undefined): number | null {
  if (!value) return null;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : t;
}

/** null-safe comparator: absent values always sort last, in either direction,
 * so "no due date" never masquerades as "due first". */
function cmpNullable(a: number | null, b: number | null): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a - b;
}

function keyOf(c: Case, sort: CaseSortKey): number | null {
  switch (sort) {
    case "due":
      return timeOf(c.dueDate);
    case "created":
      return timeOf(c.createdAt);
    case "severity":
      return SEVERITY_RANK[String(c.severity ?? "")] ?? null;
    case "status":
      return STATUS_RANK[String(c.status ?? "")] ?? null;
  }
}

/** Stable client-side sort over the LOADED window (caseSearch has no server
 * sort). Returns a new array; the caller shows the bounded-window hint. */
export function sortCases(rows: Case[], sort: CaseSortKey, dir: "asc" | "desc"): Case[] {
  const sign = dir === "desc" ? -1 : 1;
  return rows
    .map((c, i) => ({ c, i }))
    .sort((x, y) => {
      const d = cmpNullable(keyOf(x.c, sort), keyOf(y.c, sort));
      // null-last must hold regardless of direction; only real values flip.
      if (d !== 0 && keyOf(x.c, sort) !== null && keyOf(y.c, sort) !== null) return d * sign;
      return d !== 0 ? d : x.i - y.i; // stable
    })
    .map((x) => x.c);
}
