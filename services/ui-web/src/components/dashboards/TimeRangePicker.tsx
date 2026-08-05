"use client";
import { Clock } from "lucide-react";
import { presetToRange, type TimeRange, type TimeRangePresetId } from "@/lib/dashboards/timeRange";
import { t } from "@/lib/i18n/messages";

/** Local <input type="date"> value (YYYY-MM-DD) from an epoch-ms bound. */
function toDateInput(ms: number | null): string {
  if (ms == null) return "";
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "";
  return d.toISOString().slice(0, 10);
}

const PRESET_LABELS: Record<TimeRangePresetId, string> = {
  all: t("dashboards.timeRange.all"),
  "24h": t("dashboards.timeRange.24h"),
  "7d": t("dashboards.timeRange.7d"),
  "30d": t("dashboards.timeRange.30d"),
  "90d": t("dashboards.timeRange.90d"),
};

/**
 * Global time-range control. Presets resolve to bounds now; "custom" reveals two
 * native date inputs. The picker is honestly labelled: it filters the points a
 * chart already loaded (see lib/dashboards/timeRange.ts) — it does not re-query.
 */
export function TimeRangePicker({
  value,
  onChange,
  compact = false,
}: {
  value: TimeRange;
  onChange: (range: TimeRange) => void;
  compact?: boolean;
}) {
  const selectValue = value.preset;

  const onSelect = (next: string) => {
    if (next === "custom") {
      // Seed custom bounds from whatever the current range implies.
      onChange({ preset: "custom", from: value.from, to: value.to });
      return;
    }
    onChange(presetToRange(next as TimeRangePresetId));
  };

  const onCustom = (which: "from" | "to", dateStr: string) => {
    const ms = dateStr ? Date.parse(dateStr + (which === "to" ? "T23:59:59.999Z" : "T00:00:00.000Z")) : NaN;
    const bound = Number.isNaN(ms) ? null : ms;
    onChange({
      preset: "custom",
      from: which === "from" ? bound : value.from,
      to: which === "to" ? bound : value.to,
    });
  };

  return (
    <div className="flex items-center gap-1.5" title={t("dashboards.timeRange.note")}>
      <Clock className="size-4 text-muted-foreground" aria-hidden />
      <label className="sr-only" htmlFor="dashboard-time-range">
        {t("dashboards.timeRange")}
      </label>
      <select
        id="dashboard-time-range"
        aria-label={t("dashboards.timeRange")}
        value={selectValue}
        onChange={(e) => onSelect(e.target.value)}
        className="h-8 rounded-md border border-input bg-background px-2 text-xs"
      >
        <option value="all">{PRESET_LABELS.all}</option>
        <option value="24h">{PRESET_LABELS["24h"]}</option>
        <option value="7d">{PRESET_LABELS["7d"]}</option>
        <option value="30d">{PRESET_LABELS["30d"]}</option>
        <option value="90d">{PRESET_LABELS["90d"]}</option>
        <option value="custom">{t("dashboards.timeRange.custom")}</option>
      </select>
      {value.preset === "custom" && !compact && (
        <span className="flex items-center gap-1">
          <input
            type="date"
            aria-label={t("dashboards.timeRange.from")}
            value={toDateInput(value.from)}
            onChange={(e) => onCustom("from", e.target.value)}
            className="h-8 rounded-md border border-input bg-background px-2 text-xs"
          />
          <span className="text-xs text-muted-foreground">–</span>
          <input
            type="date"
            aria-label={t("dashboards.timeRange.to")}
            value={toDateInput(value.to)}
            onChange={(e) => onCustom("to", e.target.value)}
            className="h-8 rounded-md border border-input bg-background px-2 text-xs"
          />
        </span>
      )}
    </div>
  );
}
