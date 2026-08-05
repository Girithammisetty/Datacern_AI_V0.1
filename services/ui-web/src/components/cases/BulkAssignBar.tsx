"use client";
import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/primitives";
import { ConfirmDialog } from "@/components/primitives/ConfirmDialog";
import { useSelection, useToasts } from "@/stores/ui";
import { BULK_APPROVE_CAP } from "@/lib/agentic/proposals";
import { useCapabilities } from "@/lib/authz/useCapabilities";
import { FEATURE_GATES } from "@/lib/authz/registry";
import { useAssignableUsers, useBulkAssignCases, useDispositions } from "@/lib/graphql/hooks";
import { graphqlRequest } from "@/lib/graphql/client";
import * as ops from "@/lib/graphql/operations";
import { t } from "@/lib/i18n/messages";
import type { Case } from "@/lib/graphql/types";

/**
 * Bulk operations bar for the case list (UI-FR-045, BR-8). Selection lives in
 * Zustand keyed by filter signature.
 *
 * ASSIGN is real server-side bulk via case-service's POST /cases/bulk
 * (operation=assign) — id-based only (≤BULK_APPROVE_CAP per action); "select
 * all matching filter" (the server's async filter-based path) is not wired
 * here. Reports the REAL per-case succeeded/failed result, never an
 * optimistic "queued" toast.
 *
 * RESOLVE (bulk disposition) has NO server batch: the BFF's only bulk op is
 * bulkAssignCases(caseIds, assigneeId). So it runs N sequential resolveCase
 * mutations client-side, with a live progress counter and a per-case failure
 * report at the end — honest partial-failure handling, not a fake batch.
 * Only IN_PROGRESS cases are eligible (the state machine's resolve guard);
 * ineligible selections are counted and skipped up front rather than burned
 * as guaranteed 409s. Failed cases stay selected so a retry is one click.
 */
export function BulkAssignBar({ caseCount, cases }: { caseCount: number; cases?: Case[] }) {
  const selection = useSelection();
  const { ids, clear, selectMany } = selection;
  const push = useToasts((s) => s.push);
  const { can } = useCapabilities();
  const client = useQueryClient();
  const [confirm, setConfirm] = useState(false);
  const [assigneeId, setAssigneeId] = useState("");
  // Member-safe assignee directory (no identity.user.admin) — bulk assign is
  // gated on case.case.assign, which does not imply the user-admin scope.
  const usersQuery = useAssignableUsers();
  const users = useMemo(() => usersQuery.data?.pages.flatMap((p) => p.nodes) ?? [], [usersQuery.data]);
  const bulkAssign = useBulkAssignCases();

  // ---- bulk resolve state ----
  const [resolveOpen, setResolveOpen] = useState(false);
  const [dispositionId, setDispositionId] = useState("");
  const [note, setNote] = useState("");
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [failures, setFailures] = useState<{ caseId: string; message: string }[]>([]);
  // Lazy: the catalog is only fetched once a bulk-resolve is actually in
  // play, not on every worklist render with an empty selection.
  const dispositionsQuery = useDispositions({ enabled: resolveOpen });
  const activeDispositions = useMemo(
    () => (dispositionsQuery.data ?? []).filter((d) => d.active),
    [dispositionsQuery.data],
  );
  const chosenDisposition = activeDispositions.find((d) => d.id === dispositionId);
  const noteMissing = !!chosenDisposition?.requiresNote && note.trim() === "";

  const canAssign = can(FEATURE_GATES.bulkAssignCases);
  const canResolve = can(FEATURE_GATES.manageCase);
  if (ids.size === 0 || (!canAssign && !canResolve)) return null;

  const capped = ids.size > BULK_APPROVE_CAP;
  const batch = Array.from(ids).slice(0, BULK_APPROVE_CAP);

  // Resolve is only legal from IN_PROGRESS — split the batch by the same
  // state-machine guard CaseActionsBar uses, and say what was skipped.
  const byId = new Map((cases ?? []).map((c) => [c.id, c]));
  const eligible = batch.filter((id) => {
    const c = byId.get(id);
    // A selected id no longer in the loaded window: let the server rule on it
    // rather than silently dropping it.
    return !c || c.status === "IN_PROGRESS";
  });
  const skipped = batch.length - eligible.length;

  const runBulkAssign = () => {
    if (!assigneeId) return;
    bulkAssign.mutate(
      { caseIds: batch, assigneeId },
      {
        onSuccess: (data) => {
          setConfirm(false);
          const { succeededIds, failed } = data.bulkAssignCases;
          push({
            title: t("cases.bulk.result", { succeeded: succeededIds.length, failed: failed.length }),
            variant: failed.length === 0 ? "success" : succeededIds.length === 0 ? "error" : "default",
          });
          clear();
          setAssigneeId("");
        },
        onError: () => {
          setConfirm(false);
          push({ title: t("cases.bulk.allFailed"), variant: "error" });
        },
      },
    );
  };

  const runBulkResolve = async () => {
    if (!dispositionId || noteMissing || progress || eligible.length === 0) return;
    setFailures([]);
    setProgress({ done: 0, total: eligible.length });
    const failed: { caseId: string; message: string }[] = [];
    const succeeded: string[] = [];
    for (const id of eligible) {
      try {
        await graphqlRequest<ops.ResolveCaseResult>(ops.RESOLVE_CASE, {
          id,
          dispositionId,
          resolutionNote: note.trim() || undefined,
          idempotencyKey: crypto.randomUUID(),
        });
        succeeded.push(id);
      } catch (e) {
        failed.push({ caseId: id, message: e instanceof Error ? e.message : String(e) });
      }
      setProgress((p) => (p ? { ...p, done: p.done + 1 } : p));
    }
    setProgress(null);
    setFailures(failed);
    // One refetch at the end (not per case) so the list/scroll survives the run.
    void client.invalidateQueries({ queryKey: ["cases", "list"] });
    push({
      title: `${succeeded.length} resolved, ${failed.length} failed${skipped ? `, ${skipped} skipped` : ""}`,
      variant: failed.length === 0 ? "success" : succeeded.length === 0 ? "error" : "default",
    });
    // Keep failed (and skipped) cases selected so the user can retry them.
    const remaining = batch.filter((id) => !succeeded.includes(id));
    if (remaining.length === 0) clear();
    else selectMany(remaining);
    if (failed.length === 0) {
      setResolveOpen(false);
      setDispositionId("");
      setNote("");
    }
  };

  return (
    <div className="mb-3 rounded-md border bg-accent/40 px-3 py-2 text-sm">
      <div className="flex items-center gap-3">
        <span className="font-medium">{ids.size} selected</span>
        {canAssign && (
          <Button size="sm" variant="secondary" onClick={() => setConfirm(true)}>
            {t("cases.bulk.assign")}
          </Button>
        )}
        {canResolve && (
          <Button
            size="sm"
            variant="secondary"
            onClick={() => setResolveOpen(true)}
            data-testid="bulk-resolve"
          >
            Bulk resolve
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={() => { clear(); setFailures([]); }}>
          {t("cases.bulk.clear")}
        </Button>
        {capped && <span className="text-xs text-muted-foreground">{t("cases.bulk.cap", { count: BULK_APPROVE_CAP })}</span>}
        <span className="ml-auto text-xs text-muted-foreground">{t("cases.bulk.loaded", { count: caseCount })}</span>
      </div>

      {/* Per-case failure report from the last bulk resolve — the honest
          alternative to a batch endpoint we don't have. */}
      {failures.length > 0 && (
        <div role="alert" className="mt-2 rounded-md border border-destructive/40 bg-destructive/5 p-2">
          <p className="text-xs font-medium text-destructive">
            {failures.length} case{failures.length === 1 ? "" : "s"} failed to resolve (still selected):
          </p>
          <ul className="mt-1 max-h-32 space-y-0.5 overflow-auto text-xs text-muted-foreground">
            {failures.map((f) => (
              <li key={f.caseId}>
                <span className="font-mono">{byId.get(f.caseId)?.caseNumber != null ? `#${byId.get(f.caseId)!.caseNumber}` : f.caseId}</span>
                {" — "}
                {f.message}
              </li>
            ))}
          </ul>
        </div>
      )}

      <ConfirmDialog
        open={confirm}
        onOpenChange={(o) => {
          setConfirm(o);
          if (!o) setAssigneeId("");
        }}
        title={t("cases.bulk.confirmTitle", { count: batch.length })}
        description={t("cases.bulk.confirmDesc")}
        confirmLabel={t("cases.bulk.apply")}
        onConfirm={runBulkAssign}
      >
        <div className="mt-3 space-y-1.5">
          <label htmlFor="bulk-assignee" className="text-xs text-muted-foreground">
            {t("cases.bulk.assignTo")}
          </label>
          <select
            id="bulk-assignee"
            value={assigneeId}
            onChange={(e) => setAssigneeId(e.target.value)}
            disabled={bulkAssign.isPending}
            className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
          >
            <option value="">{t("cases.bulk.pickAssignee")}</option>
            {users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.fullName || u.email}
              </option>
            ))}
          </select>
        </div>
      </ConfirmDialog>

      {/* Bulk resolve — N sequential resolveCase calls, never a fake batch. */}
      <ConfirmDialog
        open={resolveOpen}
        onOpenChange={(o) => {
          if (progress) return; // no closing mid-run — the run reports when done
          setResolveOpen(o);
          if (!o) {
            setDispositionId("");
            setNote("");
          }
        }}
        title={`Resolve ${eligible.length} case${eligible.length === 1 ? "" : "s"}?`}
        description={
          <div className="space-y-1">
            <p>
              There is no server-side bulk resolve — each case is resolved individually, in
              sequence, and per-case failures are reported at the end.
            </p>
            {skipped > 0 && (
              <p className="text-xs">
                {skipped} of the {batch.length} selected {skipped === 1 ? "is" : "are"} not in
                progress and will be skipped (only in-progress cases can be resolved).
              </p>
            )}
          </div>
        }
        confirmLabel={progress ? `Resolving ${progress.done + 1} of ${progress.total}…` : `Resolve ${eligible.length}`}
        onConfirm={() => void runBulkResolve()}
      >
        <div className="mt-3 space-y-3">
          <div className="space-y-1.5">
            <label htmlFor="bulk-disposition" className="text-xs text-muted-foreground">
              {t("cases.disposition")}
            </label>
            <select
              id="bulk-disposition"
              value={dispositionId}
              onChange={(e) => setDispositionId(e.target.value)}
              disabled={!!progress}
              className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
            >
              <option value="">Pick a disposition…</option>
              {activeDispositions.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.label} ({d.category?.replaceAll("_", " ")})
                </option>
              ))}
            </select>
            {dispositionsQuery.data && activeDispositions.length === 0 && (
              <p className="text-xs text-destructive">
                No active dispositions in this workspace — create one under Cases → Settings first.
              </p>
            )}
          </div>
          <div className="space-y-1.5">
            <label htmlFor="bulk-resolution-note" className="text-xs text-muted-foreground">
              Resolution note{chosenDisposition?.requiresNote ? " (required for this disposition)" : " (optional)"}
            </label>
            <Textarea
              id="bulk-resolution-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              disabled={!!progress}
              placeholder="Applied to every case in this batch…"
            />
            {noteMissing && (
              <p className="text-xs text-destructive">This disposition requires a resolution note.</p>
            )}
          </div>
          {/* Live progress: real count of completed mutations, announced politely. */}
          <p aria-live="polite" className="text-xs text-muted-foreground">
            {progress ? `Resolving ${Math.min(progress.done + 1, progress.total)} of ${progress.total}…` : ""}
          </p>
        </div>
      </ConfirmDialog>
    </div>
  );
}
