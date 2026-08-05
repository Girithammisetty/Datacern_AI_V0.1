/**
 * Dashboard viewer state encoded in the URL, so a filtered/ranged view is a
 * copyable link (fixes the shareability gap where cross-filters lived only in
 * component state). Two pieces of state round-trip:
 *
 *   - cross-filters: repeated `cf` params, each `enc(origin)|enc(field)|enc(value)`.
 *     Parts are encodeURIComponent'd, so the `|` delimiter can never appear raw
 *     inside a part (it encodes to %7C), making the split unambiguous.
 *   - time-range: a single `range` param — a preset id (`24h`/`7d`/`30d`/`90d`),
 *     absent/`all` for all-time, or `custom:<fromISO>:<toISO>` for explicit bounds.
 *
 * Pure functions over URLSearchParams — no router, no window — so they are unit-
 * testable and reused by both the read (params → state) and write (state → params)
 * directions.
 */
import type { CrossFilter } from "@/lib/charts/crossfilter";
import { ALL_TIME, presetToRange, type TimeRange, type TimeRangePresetId } from "./timeRange";

const CF = "cf";
const RANGE = "range";
const PRESETS: TimeRangePresetId[] = ["all", "24h", "7d", "30d", "90d"];

function encodeFilter(f: CrossFilter): string {
  return [f.origin, f.field, f.value].map(encodeURIComponent).join("|");
}

function decodeFilter(raw: string): CrossFilter | null {
  const parts = raw.split("|");
  if (parts.length !== 3) return null;
  const [origin, field, value] = parts.map((p) => {
    try {
      return decodeURIComponent(p);
    } catch {
      return p;
    }
  });
  if (!origin || !field || value === undefined) return null;
  return { origin, field, value, op: "eq" };
}

/** Read the cross-filter set from search params (empty array when none). */
export function readCrossFilters(params: URLSearchParams): CrossFilter[] {
  return params
    .getAll(CF)
    .map(decodeFilter)
    .filter((f): f is CrossFilter => f != null);
}

/** Serialize a time-range to its `range` param value, or null when all-time.
 * Custom bounds are epoch ms (`custom:<from>:<to>`) — no colons of their own, so
 * the split stays unambiguous (unlike ISO strings, which contain colons). */
export function serializeTimeRange(range: TimeRange): string | null {
  if (range.preset === "all" || (!range.from && !range.to && range.preset !== "custom")) return null;
  if (range.preset === "custom") {
    if (range.from == null && range.to == null) return null;
    return `custom:${range.from ?? ""}:${range.to ?? ""}`;
  }
  return range.preset;
}

/**
 * Read the time-range from search params. Presets are resolved against `now`
 * (so a shared `?range=7d` link always means "the 7 days ending when opened").
 */
export function readTimeRange(params: URLSearchParams, now: number = Date.now()): TimeRange {
  const raw = params.get(RANGE);
  if (!raw) return ALL_TIME;
  if (raw.startsWith("custom:")) {
    const [fromStr, toStr] = raw.slice("custom:".length).split(":");
    const from = fromStr ? Number(fromStr) : NaN;
    const to = toStr ? Number(toStr) : NaN;
    const fromMs = Number.isFinite(from) ? from : null;
    const toMs = Number.isFinite(to) ? to : null;
    if (fromMs == null && toMs == null) return ALL_TIME;
    return { preset: "custom", from: fromMs, to: toMs };
  }
  if ((PRESETS as string[]).includes(raw)) return presetToRange(raw as TimeRangePresetId, now);
  return ALL_TIME;
}

export interface DashboardUrlState {
  filters: CrossFilter[];
  range: TimeRange;
}

/** Read the full viewer state from search params. */
export function readDashboardUrlState(params: URLSearchParams, now: number = Date.now()): DashboardUrlState {
  return { filters: readCrossFilters(params), range: readTimeRange(params, now) };
}

/**
 * Produce a new URLSearchParams reflecting `state`, preserving any unrelated
 * params already present. `cf` and `range` are fully replaced from `state`.
 */
export function writeDashboardUrlState(
  base: URLSearchParams,
  state: DashboardUrlState,
): URLSearchParams {
  const next = new URLSearchParams(base.toString());
  next.delete(CF);
  next.delete(RANGE);
  for (const f of state.filters) next.append(CF, encodeFilter(f));
  const range = serializeTimeRange(state.range);
  if (range) next.set(RANGE, range);
  return next;
}
