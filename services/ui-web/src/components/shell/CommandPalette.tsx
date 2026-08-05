"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import {
  Search, CornerDownLeft, ArrowUp, ArrowDown, Database, LayoutDashboard,
  TableProperties, BarChart3, Workflow, FlaskConical, Boxes, Briefcase,
  type LucideIcon,
} from "lucide-react";
import { NAV_ITEMS, FEATURE_GATES, cap, type Gate } from "@/lib/authz/registry";
import { useCapabilities } from "@/lib/authz/useCapabilities";
import { useSession } from "@/lib/session/SessionContext";
import { t } from "@/lib/i18n/messages";
import { graphqlRequest } from "@/lib/graphql/client";
import * as ops from "@/lib/graphql/operations";

/** The custom event the TopBar (or any surface) dispatches to open the palette. */
export const CMDK_EVENT = "datacern:cmdk";

interface Item {
  id: string;
  label: string;
  hint?: string;
  section: string;
  icon: LucideIcon;
  run: () => void;
}

const norm = (s: string) => s.toLowerCase().trim();
const matches = (text: string, q: string) => norm(text).includes(norm(q));

/**
 * The searchable entity kinds, in the order they are offered. Each row binds
 * one bff `SearchEntityType` to the capability that unlocks it and the route a
 * hit opens.
 *
 * `gate` is a UX filter, not the security boundary: it keeps the palette from
 * asking for kinds the viewer plainly cannot read. The real decision is made
 * by the owning service on the forwarded JWT, and a kind it refuses comes back
 * `denied` with no hits regardless of what the client asked for (BRD 74 AC-8).
 */
const SEARCH_KINDS: {
  type: ops.SearchEntityType;
  gate: Gate;
  section: string;
  hint: string;
  icon: LucideIcon;
  href: (hit: ops.SearchHit) => string;
}[] = [
  { type: "DATASET", gate: cap("dataset.dataset.list"), section: "Datasets", hint: "Dataset",
    icon: Database, href: (h) => `/data/datasets/${h.id}` },
  { type: "DASHBOARD", gate: cap("chart.dashboard.read"), section: "Dashboards", hint: "Dashboard",
    icon: LayoutDashboard, href: (h) => `/dashboards/${h.id}` },
  // A chart is not independently addressable — open the dashboard it lives on,
  // which is exactly the question BRD 74 D2's chart search answers.
  { type: "CHART", gate: cap("chart.chart.read"), section: "Charts", hint: "Chart",
    icon: BarChart3, href: (h) => (h.parentId ? `/dashboards/${h.parentId}` : "/dashboards") },
  { type: "CASE", gate: cap("case.case.read"), section: "Cases", hint: "Case",
    icon: Briefcase, href: (h) => `/cases/${h.id}` },
  { type: "PIPELINE", gate: cap("pipeline.template.read"), section: "Pipelines", hint: "Pipeline",
    icon: Workflow, href: (h) => `/data/pipelines/${h.id}` },
  { type: "EXPERIMENT", gate: cap("experiment.experiment.read"), section: "Experiments",
    hint: "Experiment", icon: FlaskConical, href: (h) => `/ml/experiments/${h.id}` },
  { type: "MODEL", gate: cap("experiment.model.read"), section: "Models", hint: "Model",
    icon: Boxes, href: (h) => `/ml/models/${h.id}` },
  { type: "DECISION_MODEL", gate: cap("case.disposition.read"), section: "Decision tables",
    hint: "Decision table", icon: TableProperties, href: () => "/decisions" },
];

/**
 * ⌘K command palette + global search. Keyboard-first: open with ⌘K / Ctrl+K,
 * type to filter navigation and quick actions, and (2+ chars) search across
 * every entity kind the viewer can read.
 *
 * BRD 74 D3: the search is ONE `search()` query. It used to be three — and one
 * of them fetched `first: 50` dashboards and matched titles in the browser,
 * which made dashboard 51 unfindable and left charts, cases, pipelines,
 * experiments and models unsearchable entirely. bff-graphql now fans out to
 * the service that owns each kind, so the matching happens server-side and the
 * authorization stays with the owner.
 */
export function CommandPalette() {
  const router = useRouter();
  const { can } = useCapabilities();
  const { workspaceId } = useSession();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const close = useCallback(() => { setOpen(false); setQuery(""); setActive(0); }, []);
  const go = useCallback((href: string) => { close(); router.push(href); }, [close, router]);

  // Global open shortcut + the TopBar's open event.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    const onOpen = () => setOpen(true);
    window.addEventListener("keydown", onKey);
    window.addEventListener(CMDK_EVENT, onOpen);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener(CMDK_EVENT, onOpen);
    };
  }, []);

  useEffect(() => { if (open) inputRef.current?.focus(); }, [open]);

  // ---- the entity kinds this viewer may search ------------------------------
  // Only kinds whose capability the viewer holds are requested, so the palette
  // never provokes a 403 it would have to hide. Memoised on `can` so the query
  // key is stable across renders.
  const kinds = useMemo(() => SEARCH_KINDS.filter((k) => can(k.gate)), [can]);
  const kindByType = useMemo(
    () => new Map(SEARCH_KINDS.map((k) => [k.type, k])),
    [],
  );
  const types = useMemo(() => kinds.map((k) => k.type), [kinds]);

  const q = query.trim();
  const search = useQuery({
    queryKey: ["cmdk", "search", workspaceId, q, types.join(",")],
    enabled: open && q.length >= 2 && types.length > 0,
    staleTime: 15_000,
    // ONE query (BRD 74 AC-9). Every kind is matched by the service that owns
    // it, so there is no client-side filtering of a truncated page here — the
    // reason a dashboard ranked below the old `first: 50` used to vanish.
    queryFn: () =>
      graphqlRequest<ops.SearchResult>(ops.SEARCH, {
        q, types, workspaceId, first: 6,
      }).then((r) => r.search),
  });

  // ---- build the flat, ordered item list ------------------------------------
  const items = useMemo<Item[]>(() => {
    const out: Item[] = [];

    // Navigation — capability-gated, filtered by the query.
    for (const nav of NAV_ITEMS) {
      if (!can(nav.gate)) continue;
      const label = t(nav.label);
      if (q && !matches(label, q)) continue;
      out.push({ id: `nav:${nav.key}`, label, section: "Go to", icon: nav.icon, run: () => go(nav.href) });
    }

    // Quick actions — each gated on the capability that unlocks it.
    for (const a of QUICK_ACTIONS) {
      if (!can(a.gate)) continue;
      if (q && !matches(a.label, q)) continue;
      out.push({ id: `act:${a.href}`, label: a.label, hint: "Action", section: "Actions", icon: a.icon, run: () => go(a.href) });
    }

    // Live search results (2+ chars), grouped in SEARCH_KINDS order. `hits`
    // already arrives in that order and already excludes any kind the owning
    // service denied — nothing is re-filtered or re-authorized here.
    if (q.length >= 2 && search.data) {
      for (const h of search.data.hits) {
        const kind = kindByType.get(h.type);
        if (!kind) continue; // a kind this build does not know how to open
        out.push({
          id: h.key,
          label: h.title,
          hint: kind.hint,
          section: kind.section,
          icon: kind.icon,
          run: () => go(kind.href(h)),
        });
      }
    }
    return out;
  }, [can, q, search.data, go, kindByType]);

  useEffect(() => { setActive(0); }, [q, search.data]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); close(); return; }
    if (e.key === "ArrowDown") { e.preventDefault(); setActive((i) => Math.min(i + 1, items.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((i) => Math.max(i - 1, 0)); }
    else if (e.key === "Enter") { e.preventDefault(); items[active]?.run(); }
  };

  // Keep the active row scrolled into view.
  useEffect(() => {
    if (!open) return;
    const row = listRef.current?.querySelector<HTMLElement>(`[data-idx="${active}"]`);
    row?.scrollIntoView?.({ block: "nearest" });
  }, [active, open]);

  if (!open) return null;

  // Group items by section for rendering, preserving flat indices for nav.
  let idx = -1;
  const sections: { name: string; rows: { item: Item; i: number }[] }[] = [];
  for (const item of items) {
    idx += 1;
    const last = sections[sections.length - 1];
    if (!last || last.name !== item.section) sections.push({ name: item.section, rows: [{ item, i: idx }] });
    else last.rows.push({ item, i: idx });
  }

  return (
    <div
      className="fixed inset-0 z-[100] flex items-start justify-center bg-background/70 p-4 pt-[12vh] backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label="Command palette"
      onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}
    >
      <div className="w-full max-w-xl overflow-hidden rounded-xl border bg-card shadow-2xl" onKeyDown={onKeyDown}>
        <div className="flex items-center gap-2 border-b px-3">
          <Search className="size-4 text-muted-foreground" aria-hidden />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search or jump to…  (datasets, dashboards, charts, cases, pipelines, models)"
            className="h-12 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            aria-label="Command palette search"
            aria-controls="cmdk-list"
            autoComplete="off"
            spellCheck={false}
          />
          <kbd className="hidden rounded border bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground sm:inline">esc</kbd>
        </div>

        <div id="cmdk-list" ref={listRef} className="max-h-[52vh] overflow-y-auto p-1.5" role="listbox">
          {items.length === 0 ? (
            <p className="px-3 py-8 text-center text-sm text-muted-foreground">
              {search.isFetching ? "Searching…" : q ? `No matches for “${q}”.` : "Type to search."}
            </p>
          ) : (
            sections.map((sec) => (
              <div key={sec.name} className="mb-1">
                <p className="px-2.5 pb-1 pt-2 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">{sec.name}</p>
                {sec.rows.map(({ item, i }) => {
                  const Icon = item.icon;
                  const isActive = i === active;
                  return (
                    <button
                      key={item.id}
                      data-idx={i}
                      role="option"
                      aria-selected={isActive}
                      onMouseMove={() => setActive(i)}
                      onClick={item.run}
                      className={`flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left text-sm ${
                        isActive ? "bg-accent text-accent-foreground" : "text-foreground"
                      }`}
                    >
                      <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                      <span className="min-w-0 flex-1 truncate">{item.label}</span>
                      {item.hint && <span className="shrink-0 text-xs text-muted-foreground">{item.hint}</span>}
                      {isActive && <CornerDownLeft className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />}
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>

        <div className="flex items-center gap-3 border-t px-3 py-2 font-mono text-[10px] text-muted-foreground">
          <span className="flex items-center gap-1"><ArrowUp className="size-3" /><ArrowDown className="size-3" /> navigate</span>
          <span className="flex items-center gap-1"><CornerDownLeft className="size-3" /> open</span>
          <span className="ml-auto">⌘K</span>
        </div>
      </div>
    </div>
  );
}

/** Curated create/act shortcuts, each gated on the capability that unlocks it. */
const QUICK_ACTIONS: { label: string; href: string; icon: LucideIcon; gate: Gate }[] = [
  { label: "Upload data", href: "/data/upload", icon: Database, gate: cap("ingestion.ingestion.create") },
  { label: "New dashboard", href: "/dashboards", icon: LayoutDashboard, gate: FEATURE_GATES.createDashboard },
  { label: "New decision table", href: "/decisions", icon: TableProperties, gate: cap("case.disposition.create") },
  { label: "New semantic model", href: "/data/semantic-models/new", icon: Database, gate: cap("semantic.model.create") },
  { label: "Run entity resolution", href: "/data/entity-resolution", icon: Database, gate: FEATURE_GATES.runEntityResolution },
  { label: "New pipeline", href: "/data/pipelines/new", icon: Database, gate: cap("pipeline.template.create") },
];
