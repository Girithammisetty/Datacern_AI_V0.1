/**
 * Dashboard favorites + recently-viewed, persisted client-side per (tenant, user)
 * — the same v1 decision as onboarding/walkthrough progress
 * (lib/onboarding/useOnboardingProgress.ts): this is one person's personal UI
 * state, not tenant data any service needs, so no backend field/migration. A v2
 * wanting cross-device sync needs a real backend field, not a localStorage
 * upgrade. All reads/writes are SSR-safe and swallow storage errors (private
 * mode / quota) — the feature degrades to in-memory rather than throwing.
 */
"use client";
import { useCallback, useEffect, useState } from "react";

const RECENT_CAP = 5;

function favKey(tenantId: string, userId: string): string {
  return `datacern.dashboards.favorites.${tenantId}.${userId}`;
}
function recentKey(tenantId: string, userId: string): string {
  return `datacern.dashboards.recent.${tenantId}.${userId}`;
}

export interface RecentDashboard {
  id: string;
  title: string;
}

function readJson<T>(key: string, fallback: T, validate: (v: unknown) => T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return fallback;
    return validate(JSON.parse(raw));
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage unavailable — state stays in memory for this session only.
  }
}

export function readFavorites(tenantId: string, userId: string): string[] {
  return readJson<string[]>(favKey(tenantId, userId), [], (v) =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [],
  );
}

export function writeFavorites(tenantId: string, userId: string, ids: string[]): void {
  writeJson(favKey(tenantId, userId), ids);
}

export function readRecent(tenantId: string, userId: string): RecentDashboard[] {
  return readJson<RecentDashboard[]>(recentKey(tenantId, userId), [], (v) =>
    Array.isArray(v)
      ? v
          .filter(
            (x): x is RecentDashboard =>
              !!x && typeof (x as RecentDashboard).id === "string" && typeof (x as RecentDashboard).title === "string",
          )
          .slice(0, RECENT_CAP)
      : [],
  );
}

/** Push a dashboard to the front of the MRU list (dedup by id, cap 5). */
export function pushRecent(tenantId: string, userId: string, entry: RecentDashboard): RecentDashboard[] {
  const current = readRecent(tenantId, userId).filter((r) => r.id !== entry.id);
  const next = [entry, ...current].slice(0, RECENT_CAP);
  writeJson(recentKey(tenantId, userId), next);
  return next;
}

/**
 * Favorites hook: the starred-id set plus a toggle that persists. Personal UI
 * state, so no capability gate — starring touches only this user's localStorage.
 */
export function useDashboardFavorites(tenantId: string, userId: string) {
  // Load in an effect (not a lazy initializer) so the server-rendered [] matches
  // the first client render — the stored set is applied post-hydration.
  const [ids, setIds] = useState<string[]>([]);
  useEffect(() => {
    setIds(readFavorites(tenantId, userId));
  }, [tenantId, userId]);

  const toggle = useCallback(
    (id: string) => {
      setIds((prev) => {
        const next = prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id];
        writeFavorites(tenantId, userId, next);
        return next;
      });
    },
    [tenantId, userId],
  );

  const isFavorite = useCallback((id: string) => ids.includes(id), [ids]);

  return { favoriteIds: ids, isFavorite, toggle };
}
