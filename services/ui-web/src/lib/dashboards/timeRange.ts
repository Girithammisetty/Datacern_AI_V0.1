/**
 * Dashboard global time-range: an HONEST client-side post-filter.
 *
 * Why client-side. Each chart's time window is baked into its saved query, and
 * the dashboard data operation (`DashboardDetail`) takes only `id` + cross-filter
 * `filters` — there is no time-range/param argument to push a global window
 * through. The `ChartFilterInput` op whitelist does include `between`/`gte`/`lte`,
 * but applying a time predicate server-side would require each chart's real time-
 * dimension name, which the BFF does not expose per chart. So a global range can
 * only narrow the time-series points a chart ALREADY returned. That is what this
 * does, and the UI labels it "filters loaded data" so it is never mistaken for a
 * fresh server query. Charts with no detectable time column are a no-op.
 */

export type TimeRangePresetId = "all" | "24h" | "7d" | "30d" | "90d";

export interface TimeRange {
  /** Preset id, or "custom" when explicit bounds are set. */
  preset: TimeRangePresetId | "custom";
  /** Inclusive lower bound (epoch ms), or null for open-ended / all-time. */
  from: number | null;
  /** Inclusive upper bound (epoch ms), or null for open-ended / all-time. */
  to: number | null;
}

export const ALL_TIME: TimeRange = { preset: "all", from: null, to: null };

const PRESET_SPANS_MS: Record<Exclude<TimeRangePresetId, "all">, number> = {
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
  "90d": 90 * 24 * 60 * 60 * 1000,
};

/** Resolve a preset to concrete bounds relative to `now` (default Date.now()). */
export function presetToRange(preset: TimeRangePresetId, now: number = Date.now()): TimeRange {
  if (preset === "all") return ALL_TIME;
  return { preset, from: now - PRESET_SPANS_MS[preset], to: now };
}

/** True when the range imposes any bound at all (i.e. is not all-time/open). */
export function isBoundedRange(range: TimeRange): boolean {
  return range.from != null || range.to != null;
}

// A value is treated as a timestamp only when it LOOKS like a date/datetime
// string — a leading YYYY-MM (optionally -DD and a time). This deliberately
// excludes bare numeric measures (revenue, counts) so a numeric column is never
// mistaken for a time axis.
const DATE_RE = /^\d{4}-\d{2}(-\d{2})?([ T]\d{2}:\d{2})?/;

/** Parse a cell to epoch ms if it is a date-like string, else null. */
export function parseTimestamp(value: unknown): number | null {
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isNaN(ms) ? null : ms;
  }
  if (typeof value !== "string") return null;
  if (!DATE_RE.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

function asRows(rows: unknown): unknown[][] {
  return Array.isArray(rows) ? (rows as unknown[][]) : [];
}

function asColumns(columns: unknown): string[] {
  return Array.isArray(columns) ? columns.map((c) => (typeof c === "string" ? c : String((c as { name?: unknown })?.name ?? c))) : [];
}

/**
 * Index of the first column whose sampled values are overwhelmingly date-like,
 * or -1 when the data has no time dimension. Samples the first 20 rows.
 */
export function detectTimeColumnIndex(columns: unknown, rows: unknown): number {
  const cols = asColumns(columns);
  const rowList = asRows(rows);
  if (cols.length === 0 || rowList.length === 0) return -1;
  const sample = rowList.slice(0, 20);
  for (let c = 0; c < cols.length; c++) {
    let dateLike = 0;
    let total = 0;
    for (const row of sample) {
      const v = Array.isArray(row) ? row[c] : undefined;
      if (v == null || v === "") continue;
      total++;
      if (parseTimestamp(v) != null) dateLike++;
    }
    if (total > 0 && dateLike / total >= 0.8) return c;
  }
  return -1;
}

export interface TimeFilterResult {
  columns: unknown;
  rows: unknown;
  /** True when this chart HAS a time column the range could act on. */
  applicable: boolean;
  /** Rows kept after filtering (equals total when not applicable/unbounded). */
  shown: number;
  /** Total rows before filtering. */
  total: number;
}

/**
 * Post-filter shaped chart data to the given range. Non-mutating. When the range
 * is unbounded (all-time) or the data has no time column, the data passes through
 * unchanged and `applicable` reflects whether a time column exists at all.
 */
export function filterChartDataByTimeRange(
  columns: unknown,
  rows: unknown,
  range: TimeRange,
): TimeFilterResult {
  const rowList = asRows(rows);
  const total = rowList.length;
  const timeCol = detectTimeColumnIndex(columns, rows);
  const applicable = timeCol >= 0;

  if (!applicable || !isBoundedRange(range)) {
    return { columns, rows, applicable, shown: total, total };
  }

  const kept = rowList.filter((row) => {
    const ts = parseTimestamp(Array.isArray(row) ? row[timeCol] : undefined);
    if (ts == null) return true; // keep rows we can't place rather than drop silently
    if (range.from != null && ts < range.from) return false;
    if (range.to != null && ts > range.to) return false;
    return true;
  });

  return { columns, rows: kept, applicable, shown: kept.length, total };
}
