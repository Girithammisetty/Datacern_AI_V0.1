/**
 * Auto-refresh interval selection for the dashboard viewer, persisted per
 * dashboard in localStorage. The chosen interval feeds react-query's
 * `refetchInterval` on the dashboard query — the same mechanism job polling
 * already uses (see useIngestion in lib/graphql/hooks.ts). Off === no polling.
 */
"use client";
import { useCallback, useState } from "react";

export type RefreshIntervalId = "off" | "30s" | "1m" | "5m";

export const REFRESH_INTERVALS: RefreshIntervalId[] = ["off", "30s", "1m", "5m"];

/** Interval id → milliseconds, or false (no polling) for "off". */
export function refreshMs(id: RefreshIntervalId): number | false {
  switch (id) {
    case "30s":
      return 30_000;
    case "1m":
      return 60_000;
    case "5m":
      return 300_000;
    default:
      return false;
  }
}

function key(dashboardId: string): string {
  return `datacern.dashboards.refresh.${dashboardId}`;
}

function isValid(v: unknown): v is RefreshIntervalId {
  return typeof v === "string" && (REFRESH_INTERVALS as string[]).includes(v);
}

export function readRefreshInterval(dashboardId: string): RefreshIntervalId {
  if (typeof window === "undefined") return "off";
  try {
    const raw = window.localStorage.getItem(key(dashboardId));
    return isValid(raw) ? raw : "off";
  } catch {
    return "off";
  }
}

export function writeRefreshInterval(dashboardId: string, id: RefreshIntervalId): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key(dashboardId), id);
  } catch {
    // ignore storage errors — refresh still works this session.
  }
}

/**
 * Coarse "time ago" label for the last-updated stamp. Returns a short unit
 * string ("5s", "2m", "1h") — the caller composes it via t() so it stays
 * translatable. null when there is no timestamp yet.
 */
export function formatAgo(sinceMs: number | null, now: number = Date.now()): string | null {
  if (sinceMs == null) return null;
  const secs = Math.max(0, Math.floor((now - sinceMs) / 1000));
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/** Interval selection persisted per dashboard. */
export function useRefreshInterval(dashboardId: string) {
  const [interval, setIntervalState] = useState<RefreshIntervalId>(() => readRefreshInterval(dashboardId));

  const setInterval = useCallback(
    (id: RefreshIntervalId) => {
      setIntervalState(id);
      writeRefreshInterval(dashboardId, id);
    },
    [dashboardId],
  );

  return { interval, setInterval };
}
