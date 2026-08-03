"use client";
import { useCallback, useState } from "react";

/**
 * Getting-started checklist progress, persisted client-side per (tenant, user)
 * — the same v1 design decision as the walkthrough overlay
 * (lib/walkthrough/useWalkthroughProgress.ts): this is one person's UI state,
 * not tenant data any service needs, so no backend field/migration for it.
 * A v2 wanting cross-device progress needs a real backend field, not a
 * localStorage upgrade.
 */

interface StoredOnboarding {
  done: string[];
  dismissed: boolean;
}

function storageKey(tenantId: string, userId: string): string {
  return `datacern.onboarding.${tenantId}.${userId}`;
}

function read(tenantId: string, userId: string): StoredOnboarding {
  if (typeof window === "undefined") return { done: [], dismissed: false };
  try {
    const raw = window.localStorage.getItem(storageKey(tenantId, userId));
    if (!raw) return { done: [], dismissed: false };
    const parsed = JSON.parse(raw) as Partial<StoredOnboarding>;
    return {
      done: Array.isArray(parsed.done) ? parsed.done.filter((k) => typeof k === "string") : [],
      dismissed: parsed.dismissed === true,
    };
  } catch {
    return { done: [], dismissed: false };
  }
}

function write(tenantId: string, userId: string, state: StoredOnboarding): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(storageKey(tenantId, userId), JSON.stringify(state));
  } catch {
    // Storage unavailable (private mode, quota) — the checklist still works,
    // it just won't remember across reloads.
  }
}

export function useOnboardingProgress(tenantId: string, userId: string) {
  const [state, setState] = useState<StoredOnboarding>(() => read(tenantId, userId));

  const toggle = useCallback(
    (key: string) => {
      setState((prev) => {
        const done = prev.done.includes(key)
          ? prev.done.filter((k) => k !== key)
          : [...prev.done, key];
        const next = { ...prev, done };
        write(tenantId, userId, next);
        return next;
      });
    },
    [tenantId, userId],
  );

  const dismiss = useCallback(() => {
    setState((prev) => {
      const next = { ...prev, dismissed: true };
      write(tenantId, userId, next);
      return next;
    });
  }, [tenantId, userId]);

  return { done: state.done, dismissed: state.dismissed, toggle, dismiss };
}
