/**
 * Breadcrumb resolution (backward navigation for nested routes).
 *
 * The app is deep — `/ml/eval/runs/{id}`, `/admin/audit/events/{id}`,
 * `/data/pipelines/{id}/edit` — but the sidebar only ever highlights the
 * top-level destination, so a nested page used to offer no way back except the
 * browser button. This module turns a pathname into an ordered trail; the
 * presentational side lives in `components/shell/Breadcrumbs.tsx` and is wired
 * once into `PageHeader`, which every page renders.
 *
 * PURE by design (no React, no hooks, no DOM): the resolution rules are the
 * part worth testing, and they are exercised directly in `breadcrumbs.test.ts`.
 * Capability gating is applied by the RENDERER, not here — a crumb carries the
 * `Gate` protecting its href and the component decides link-vs-text, so this
 * stays deterministic.
 *
 * Resolution, in priority order:
 *   1. Always start at Home (`/`).
 *   2. Longest-prefix match against NAV_ITEMS: any ancestor path that is
 *      exactly a nav item's href borrows that item's label + href, so the trail
 *      words match the sidebar exactly.
 *   3. A matched nav item that belongs to a sidebar section contributes a
 *      NON-LINK group crumb first (sections have no route of their own).
 *   4. Unmatched intermediate segments are humanized. They link ONLY when a
 *      page is known to exist there (LISTING_PATHS, or the path is a strict
 *      prefix of a nav item href) — a dead crumb link is worse than plain text.
 *   5. The final segment of a record route is an opaque id at runtime, so the
 *      last crumb prefers the caller's `currentLabel` (the record's human name)
 *      and falls back to a truncated id, never a full uuid.
 *   6. The current page's crumb is never a link.
 */
import {
  NAV_ITEMS,
  NAV_GROUP_LABEL,
  gateForPath,
  publicGate,
  type Gate,
} from "@/lib/authz/registry";
import { t, type MessageKey } from "@/lib/i18n/messages";

/** One resolved step of the trail. `href` absent ⇒ render as plain text. */
export interface Crumb {
  /** Stable React key (the path, or `group:<name>` for section crumbs). */
  key: string;
  /** Display text, already resolved through `t()`. */
  label: string;
  /** Link target. Absent for section crumbs, dead paths, and the current page. */
  href?: string;
  /** Gate protecting `href`; the renderer downgrades to text when it fails. */
  gate?: Gate;
  /** True for the last crumb (the page the viewer is on). */
  current?: boolean;
}

const NAV_BY_HREF = new Map(NAV_ITEMS.map((item) => [item.href, item]));

/**
 * Paths that have a real page but are NOT nav items, so an intermediate crumb
 * pointing at them is safe to link. Deliberately hand-maintained and short:
 * this file cannot see the route tree at runtime, and rule 4 says be
 * conservative — an unlisted intermediate renders as text, which is harmless.
 */
const LISTING_PATHS: ReadonlySet<string> = new Set([
  "/admin/audit",
  "/admin/ai-gateway",
  "/copilot/runs",
  "/ml/eval/runs",
  "/ml/inference",
  "/ml/models",
]);

/**
 * Preferred label for known static segments that are not nav items. Rule:
 * prefer a `t()` key whenever the segment is a known route; only genuinely
 * unknown segments fall through to `humanizeSegment()`.
 */
const SEGMENT_LABELS: Readonly<Record<string, MessageKey>> = {
  "ai-gateway": "breadcrumb.aiGateway",
  audit: "breadcrumb.audit",
  datasets: "breadcrumb.datasets",
  edit: "breadcrumb.edit",
  events: "breadcrumb.events",
  experiments: "breadcrumb.experiments",
  export: "breadcrumb.export",
  inference: "breadcrumb.inference",
  models: "breadcrumb.models",
  new: "breadcrumb.new",
  runs: "breadcrumb.runs",
  schedules: "breadcrumb.schedules",
  settings: "breadcrumb.settings",
};

/**
 * Every STATIC path segment the app routes on. A final segment outside this set
 * is a record id / slug at runtime (Next `[id]`, `[slug]`, `[eventId]`), which
 * is what makes a route a "detail" route — see `isDynamicSegment`.
 */
const STATIC_SEGMENTS: ReadonlySet<string> = new Set([
  "admin", "agents", "ai-gateway", "api", "archetypes", "archive", "audit",
  "budgets", "canaries", "cases", "connections", "copilot", "customization",
  "dashboards", "data", "datasets", "decisions", "distillation", "edit",
  "entity-resolution", "eval", "events", "experiments", "expertise", "export",
  "groups", "guardrails", "help", "inbox", "inference", "ingestions", "keys",
  "ladders", "memory", "ml", "models", "new", "notifications", "ontology",
  "pack", "packs", "pipelines", "providers", "queries", "reports", "roles",
  "runs", "schedules", "scorers", "semantic-models", "service-accounts",
  "settings", "teams", "tenant", "tenants", "tools", "trends", "upload",
  "usage", "users", "value", "workspaces", "writebacks",
]);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function decodeSafe(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** `runs` → "Runs", `semantic-models` → "Semantic models". */
export function humanizeSegment(segment: string): string {
  const words = decodeSafe(segment).replace(/[-_]+/g, " ").trim();
  if (!words) return "";
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Never show a raw uuid in a crumb: `3f9a1c22-…` → `3f9a1c22…`. */
export function truncateId(value: string, max = 8): string {
  const decoded = decodeSafe(value);
  return decoded.length > max ? `${decoded.slice(0, max)}…` : decoded;
}

/** True when the segment is a runtime record id/slug rather than a static route. */
export function isDynamicSegment(segment: string): boolean {
  if (!segment) return false;
  return !STATIC_SEGMENTS.has(decodeSafe(segment).toLowerCase());
}

/** A dynamic segment that reads as an opaque identifier (truncate, don't humanize). */
export function looksLikeId(segment: string): boolean {
  if (!isDynamicSegment(segment)) return false;
  const value = decodeSafe(segment);
  return UUID_RE.test(value) || /\d/.test(value) || value.length >= 16;
}

/** Strip query/hash and any trailing slash; `""` and `"/"` both normalize to `/`. */
function normalize(pathname: string): string {
  const withoutQuery = (pathname ?? "").split(/[?#]/)[0];
  if (!withoutQuery) return "/";
  const trimmed = withoutQuery.replace(/\/+$/, "");
  return trimmed === "" ? "/" : trimmed;
}

/** Whether a page exists at `path` such that an intermediate crumb may link it. */
function isLinkablePath(path: string): boolean {
  if (LISTING_PATHS.has(path)) return true;
  const prefix = `${path}/`;
  return NAV_ITEMS.some((item) => item.href.startsWith(prefix));
}

function fallbackLabel(segment: string): string {
  const key = SEGMENT_LABELS[decodeSafe(segment).toLowerCase()];
  if (key) return t(key);
  return looksLikeId(segment) ? truncateId(segment) : humanizeSegment(segment);
}

/**
 * Resolve a pathname into a breadcrumb trail. Returns `[]` for the home route
 * (the home page shows no trail at all).
 */
export function crumbsFor(pathname: string, opts?: { currentLabel?: string }): Crumb[] {
  const clean = normalize(pathname);
  const segments = clean.split("/").filter(Boolean);
  if (segments.length === 0) return [];

  const home = NAV_BY_HREF.get("/");
  const crumbs: Crumb[] = [
    {
      key: "/",
      label: t(home?.label ?? "nav.home"),
      href: "/",
      gate: home?.gate ?? publicGate,
    },
  ];

  const currentLabel = opts?.currentLabel?.trim();
  const seenGroups = new Set<string>();
  let path = "";

  segments.forEach((segment, index) => {
    path += `/${segment}`;
    const last = index === segments.length - 1;
    const nav = NAV_BY_HREF.get(path);

    // Rule 2/3: an exact nav-item match borrows the sidebar's wording, and
    // opens its section with a non-link group crumb the first time we see it.
    if (nav) {
      if (nav.group && !seenGroups.has(nav.group)) {
        seenGroups.add(nav.group);
        crumbs.push({ key: `group:${nav.group}`, label: t(NAV_GROUP_LABEL[nav.group]) });
      }
      crumbs.push({
        key: path,
        label: t(nav.label),
        href: last ? undefined : path,
        gate: last ? undefined : nav.gate,
        current: last || undefined,
      });
      return;
    }

    // Rule 5: the final crumb of a record route prefers the human name the page
    // knows (case title, dashboard name, run id) over the raw path segment.
    const label = last && currentLabel ? currentLabel : fallbackLabel(segment);
    // Rule 4/6: link an intermediate only when a page is known to live there;
    // the current page is never a link.
    const linkable = !last && isLinkablePath(path);
    crumbs.push({
      key: path,
      label,
      href: linkable ? path : undefined,
      gate: linkable ? gateForPath(path) : undefined,
      current: last || undefined,
    });
  });

  return crumbs;
}

/**
 * Whether a trail is worth rendering. Home always links, and the current page
 * never does, so requiring TWO linked crumbs means "there is a real ancestor
 * above Home". Top-level destinations (`/cases`, `/copilot`, `/data/pipelines`)
 * fall below the bar and render nothing — the sidebar already says where you
 * are, and a Home-only trail is pure noise.
 */
export function hasTrail(crumbs: Crumb[]): boolean {
  let linked = 0;
  for (const crumb of crumbs) if (crumb.href) linked++;
  return linked >= 2;
}

/**
 * The parent a detail page should offer a one-click "← Back" to, or `undefined`
 * when the route is not a record page. Detail routes are detected at runtime:
 * the final segment is not a known static route segment, so it is a `[id]` /
 * `[slug]` / `[eventId]` value. Home is excluded — the trail already shows it,
 * and "← Home" is not the affordance a record page needs.
 */
export function backTargetFor(pathname: string, crumbs: Crumb[]): Crumb | undefined {
  const segments = normalize(pathname).split("/").filter(Boolean);
  const lastSegment = segments[segments.length - 1];
  if (!lastSegment || !isDynamicSegment(lastSegment)) return undefined;
  for (let i = crumbs.length - 1; i >= 1; i--) {
    const crumb = crumbs[i];
    if (crumb.href && !crumb.current) return crumb;
  }
  return undefined;
}
