"use client";
import { useState } from "react";
import { Check, Link2, Maximize2, Minimize2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { TimeRangePicker } from "./TimeRangePicker";
import { AutoRefreshControl } from "./AutoRefreshControl";
import type { TimeRange } from "@/lib/dashboards/timeRange";
import type { RefreshIntervalId } from "@/lib/dashboards/autoRefresh";
import { t } from "@/lib/i18n/messages";

/**
 * The rich-viewer control cluster: time-range, auto-refresh + last-updated,
 * copy-shareable-link, and the fullscreen toggle. Rendered in the page header
 * and, in a slimmer form, as the fullscreen overlay. None of these touch
 * capabilities (they are view affordances over already-fetched data), so no
 * <Can> gate — unlike the authoring/delete actions beside them.
 */
export function DashboardControls({
  range,
  onRangeChange,
  interval,
  onIntervalChange,
  onRefresh,
  lastUpdated,
  isFetching,
  isFullscreen,
  onToggleFullscreen,
  compact = false,
}: {
  range: TimeRange;
  onRangeChange: (r: TimeRange) => void;
  interval: RefreshIntervalId;
  onIntervalChange: (id: RefreshIntervalId) => void;
  onRefresh: () => void;
  lastUpdated: number | null;
  isFetching: boolean;
  isFullscreen: boolean;
  onToggleFullscreen: () => void;
  compact?: boolean;
}) {
  const [copied, setCopied] = useState(false);

  const copyLink = async () => {
    if (typeof window === "undefined") return;
    const url = window.location.href;
    try {
      await navigator.clipboard?.writeText(url);
    } catch {
      // Clipboard blocked — nothing else to do; the URL is already shareable.
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      <TimeRangePicker value={range} onChange={onRangeChange} compact={compact} />
      <AutoRefreshControl
        interval={interval}
        onIntervalChange={onIntervalChange}
        onRefresh={onRefresh}
        lastUpdated={lastUpdated}
        isFetching={isFetching}
      />
      <Button
        variant="outline"
        size="sm"
        onClick={copyLink}
        aria-label={t("dashboards.copyLink")}
        title={t("dashboards.copyLink")}
      >
        {copied ? <Check /> : <Link2 />}
        {copied ? t("dashboards.linkCopied") : t("dashboards.copyLink")}
      </Button>
      <Button
        variant="outline"
        size="icon"
        className="size-8"
        onClick={onToggleFullscreen}
        aria-label={isFullscreen ? t("dashboards.exitFullscreen") : t("dashboards.fullscreen")}
        title={isFullscreen ? t("dashboards.exitFullscreen") : t("dashboards.fullscreen")}
      >
        {isFullscreen ? <Minimize2 /> : <Maximize2 />}
      </Button>
    </div>
  );
}
