"use client";
import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  REFRESH_INTERVALS,
  formatAgo,
  type RefreshIntervalId,
} from "@/lib/dashboards/autoRefresh";
import { t } from "@/lib/i18n/messages";

const LABELS: Record<RefreshIntervalId, string> = {
  off: t("dashboards.autoRefresh.off"),
  "30s": t("dashboards.autoRefresh.30s"),
  "1m": t("dashboards.autoRefresh.1m"),
  "5m": t("dashboards.autoRefresh.5m"),
};

/**
 * Auto-refresh interval selector + manual refresh + a live "Updated Xs ago"
 * stamp. The interval drives react-query's refetchInterval upstream; this
 * component only owns the choice and the relative label (which ticks once a
 * second so it stays honest between refetches).
 */
export function AutoRefreshControl({
  interval,
  onIntervalChange,
  onRefresh,
  lastUpdated,
  isFetching = false,
}: {
  interval: RefreshIntervalId;
  onIntervalChange: (id: RefreshIntervalId) => void;
  onRefresh: () => void;
  /** Epoch ms of the last successful data update, or null. */
  lastUpdated: number | null;
  isFetching?: boolean;
}) {
  // Re-render every second so the relative stamp advances between refetches.
  const [, setTick] = useState(0);
  useEffect(() => {
    const h = window.setInterval(() => setTick((n) => n + 1), 1000);
    return () => window.clearInterval(h);
  }, []);

  const ago = formatAgo(lastUpdated);
  const stamp =
    lastUpdated == null
      ? t("dashboards.updatedNever")
      : ago === "0s"
        ? t("dashboards.updatedJustNow")
        : t("dashboards.updatedAgo", { ago: ago ?? "" });

  return (
    <div className="flex items-center gap-1.5">
      <label className="sr-only" htmlFor="dashboard-auto-refresh">
        {t("dashboards.autoRefresh")}
      </label>
      <select
        id="dashboard-auto-refresh"
        aria-label={t("dashboards.autoRefresh")}
        value={interval}
        onChange={(e) => onIntervalChange(e.target.value as RefreshIntervalId)}
        className="h-8 rounded-md border border-input bg-background px-2 text-xs"
      >
        {REFRESH_INTERVALS.map((id) => (
          <option key={id} value={id}>
            {LABELS[id]}
          </option>
        ))}
      </select>
      <span className="hidden text-xs text-muted-foreground sm:inline" aria-live="polite">
        {stamp}
      </span>
      <Button
        variant="ghost"
        size="icon"
        className="size-8"
        aria-label={t("dashboards.refreshNow")}
        title={t("dashboards.refreshNow")}
        onClick={onRefresh}
        disabled={isFetching}
      >
        <RefreshCw className={isFetching ? "animate-spin" : undefined} />
      </Button>
    </div>
  );
}
