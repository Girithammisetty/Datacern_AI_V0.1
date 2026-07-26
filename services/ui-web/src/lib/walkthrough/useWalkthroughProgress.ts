"use client";
import { useCallback, useEffect, useState } from "react";

/**
 * Walkthrough progress, persisted client-side (v1 design decision).
 *
 * There is no backend field for "which walkthrough step is this tenant on"
 * (domain.Tenant carries no such column, and adding one would mean a
 * migration + a write endpoint for what is a single browser's UI state, not
 * tenant data any other service or persona needs to see). A demo tenant is
 * also typically driven by ONE person at a time (an SE running the 5-minute
 * script, or a prospect self-touring) rather than a team that needs shared
 * progress, so localStorage — scoped per tenant, so DemoService's own
 * reset/clone flows (which mint a fresh tenant id) naturally start a new
 * tenant's overlay from step 0 — is sufficient for v1. Noted here rather
 * than silently assumed: a v2 wanting cross-device/shared progress would
 * need a real backend field (or to fold into the existing tenant metadata),
 * not a localStorage upgrade.
 */

type Status = "active" | "skipped" | "finished";

interface StoredProgress {
  stepIndex: number;
  status: Status;
}

function storageKey(tenantId: string): string {
  return `datacern.walkthrough.${tenantId}`;
}

function readProgress(tenantId: string): StoredProgress | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(storageKey(tenantId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredProgress>;
    if (typeof parsed.stepIndex !== "number" || typeof parsed.status !== "string") return null;
    return { stepIndex: parsed.stepIndex, status: parsed.status as Status };
  } catch {
    return null;
  }
}

function writeProgress(tenantId: string, progress: StoredProgress): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(storageKey(tenantId), JSON.stringify(progress));
  } catch {
    // Storage unavailable (private mode, quota) — the overlay just won't
    // remember progress across reloads; never worth surfacing an error for.
  }
}

export interface WalkthroughProgress {
  /** Index into the steps array the overlay should currently show. */
  stepIndex: number;
  /** True once the viewer skipped or finished — the overlay renders nothing. */
  isDismissed: boolean;
  next: () => void;
  prev: () => void;
  skip: () => void;
  finish: () => void;
  restart: () => void;
}

export function useWalkthroughProgress(tenantId: string, totalSteps: number): WalkthroughProgress {
  const [progress, setProgress] = useState<StoredProgress>(() => readProgress(tenantId) ?? { stepIndex: 0, status: "active" });

  // Re-read when the tenant changes (e.g. a demo clone swaps the session
  // tenant id) so one tenant's finished/skipped state never bleeds into
  // another's fresh overlay.
  useEffect(() => {
    setProgress(readProgress(tenantId) ?? { stepIndex: 0, status: "active" });
  }, [tenantId]);

  const update = useCallback(
    (next: StoredProgress) => {
      setProgress(next);
      writeProgress(tenantId, next);
    },
    [tenantId],
  );

  const next = useCallback(() => {
    const isLastStep = progress.stepIndex >= totalSteps - 1;
    if (isLastStep) {
      update({ stepIndex: progress.stepIndex, status: "finished" });
    } else {
      update({ stepIndex: progress.stepIndex + 1, status: "active" });
    }
  }, [progress.stepIndex, totalSteps, update]);

  const prev = useCallback(() => {
    update({ stepIndex: Math.max(progress.stepIndex - 1, 0), status: "active" });
  }, [progress.stepIndex, update]);

  const skip = useCallback(() => {
    update({ stepIndex: progress.stepIndex, status: "skipped" });
  }, [progress.stepIndex, update]);

  const finish = useCallback(() => {
    update({ stepIndex: progress.stepIndex, status: "finished" });
  }, [progress.stepIndex, update]);

  const restart = useCallback(() => {
    update({ stepIndex: 0, status: "active" });
  }, [update]);

  return {
    stepIndex: progress.stepIndex,
    isDismissed: progress.status !== "active",
    next,
    prev,
    skip,
    finish,
    restart,
  };
}
