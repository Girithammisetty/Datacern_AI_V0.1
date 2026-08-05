"use client";
/**
 * The case lifecycle action bar.
 *
 * Lives here rather than inside the page because Next.js validates a page
 * module's exports: a named component export makes `next build` fail with
 * "<name> is not a valid Page export field" — which neither `tsc --noEmit`
 * nor the vitest run catches. Its own file keeps it directly testable.
 */
import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Can } from "@/components/authz/Can";
import { FEATURE_GATES } from "@/lib/authz/registry";
import { Textarea } from "@/components/ui/primitives";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/primitives/ConfirmDialog";
import {
  useAssignableUsers, useDispositions, useAssignCase, useUnassignCase, useStartCase,
  useResolveCase, useReopenCase, useCloseCase, useEscalateCase, useConnections,
  useCreateWriteback,
} from "@/lib/graphql/hooks";
import { qk } from "@/lib/graphql/keys";
import { useToasts } from "@/stores/ui";
import { GraphQLRequestError } from "@/lib/graphql/client";
import { formatLocal } from "@/lib/utils";
import type { Case } from "@/lib/graphql/types";

/**
 * Starting skeletons for the sync-to-SoR dialog's "Insert template" row
 * (BRD 57). Field names match `x12_out.py`'s `render_for_writeback` exactly —
 * `sender_id`/`receiver_id` are the trading-partner identity (control
 * numbers are Core-assigned, not supplied here).
 */
const SYNC_TEMPLATES: Record<string, { label: string; target: object; payload: object }> = {
  json: { label: "Generic JSON", target: {}, payload: {} },
  x12_837: {
    label: "X12 837 — corrected claim",
    target: {
      format: "x12", transaction_set: "837",
      sender_id: "YOUR_TRADING_ID", receiver_id: "PAYER_TRADING_ID",
      billing_provider_npi: "1234567890", subscriber_id: "MEMBER_ID",
    },
    payload: {
      claims: [{
        claim_id: "CLAIM-ID", total_charge: "100.00", place_of_service: "11",
        diagnosis_codes: ["Z0000"],
        service_lines: [{ procedure_code: "99213", charge: "100.00" }],
      }],
    },
  },
  x12_276: {
    label: "X12 276 — claim status request",
    target: {
      format: "x12", transaction_set: "276",
      sender_id: "YOUR_TRADING_ID", receiver_id: "PAYER_TRADING_ID",
      payer_id: "PAYER_ID", payer_name: "PAYER NAME",
      provider_npi: "1234567890", provider_name: "PROVIDER NAME",
      subscriber_id: "MEMBER_ID", subscriber_last: "LAST", subscriber_first: "FIRST",
    },
    payload: { inquiries: [{ claim_id: "CLAIM-ID" }] },
  },
};

/** How long after resolvedAt the backend still accepts a reopen (CASE-FR). */
const REOPEN_WINDOW_MS = 30 * 86_400_000;

/** Which lifecycle transition just succeeded — lets a host surface (the
 * cases workbench pane) react, e.g. auto-advance to the next case after a
 * resolve/close. Optional: the full detail page passes nothing. */
export type CaseTransitionKind =
  | "assign" | "unassign" | "start" | "resolve" | "reopen" | "close" | "escalate";

/**
 * Lifecycle actions derived EXACTLY from case-service's state machine
 * (domain/statemachine.go): assign from unassigned/draft/in_progress; unassign
 * from draft/in_progress; start from draft; resolve from in_progress; reopen
 * from resolved (≤30 days after resolvedAt); close from resolved; escalate has
 * no status guard but is hidden on the terminal closed state. An illegal
 * transition still 409s server-side — these buttons just never offer one.
 */
export function CaseActionsBar({
  c,
  onAfterTransition,
}: {
  c: Case;
  onAfterTransition?: (kind: CaseTransitionKind) => void;
}) {
  const push = useToasts((s) => s.push);
  const [dialog, setDialog] = useState<null | "assign" | "resolve" | "close" | "escalate" | "sync">(null);
  const queryClient = useQueryClient();
  const [triaging, setTriaging] = useState(false);

  /**
   * Ask the case-triage agent to read this case and draft a disposition.
   * The agent cannot apply it: the run produces a PENDING proposal that a
   * second person decides in the approvals inbox, and agent-runtime re-checks
   * `case.case.update` for this user on this case before the proposal is even
   * created. Refetching the case is all that is needed to surface the result —
   * Case.proposals is resolved from agent-runtime by resource URN.
   */
  const runTriage = async () => {
    setTriaging(true);
    try {
      const res = await fetch(`/api/cases/${c.id}/triage`, { method: "POST" });
      const json = (await res.json().catch(() => ({}))) as { error?: string; mode?: string };
      if (!res.ok) {
        push({ title: "Could not draft a recommendation", description: json.error, variant: "error" });
        return;
      }
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: qk.case(c.id) }),
        queryClient.invalidateQueries({ queryKey: qk.caseTimeline(c.id) }),
      ]);
      push({
        title: "Recommendation drafted",
        // Honest about what just happened: a proposal exists, nothing was applied.
        description:
          json.mode === "temporal"
            ? "The agent is working; the proposal will appear on this case shortly."
            : "Review it in the approvals inbox — a second person must approve.",
        variant: "success",
      });
    } catch {
      push({ title: "Could not draft a recommendation", variant: "error" });
    } finally {
      setTriaging(false);
    }
  };

  const toastError = (title: string) => (err: unknown) => {
    const g = err instanceof GraphQLRequestError ? err : null;
    push({ title, description: g?.message ?? String(err), traceId: g?.traceId, variant: "error" });
  };
  const toastOk = (title: string, kind?: CaseTransitionKind) => () => {
    push({ title, variant: "success" });
    if (kind) onAfterTransition?.(kind);
  };

  const assign = useAssignCase(c.id);
  const unassign = useUnassignCase(c.id);
  const start = useStartCase(c.id);
  const resolve = useResolveCase(c.id);
  const reopen = useReopenCase(c.id);
  const close = useCloseCase(c.id);
  const escalate = useEscalateCase(c.id);

  const status = c.status;
  const canAssign = status === "UNASSIGNED" || status === "DRAFT" || status === "IN_PROGRESS";
  const canUnassign = status === "DRAFT" || status === "IN_PROGRESS";
  const canStart = status === "DRAFT";
  const canResolve = status === "IN_PROGRESS";
  const canReopen = status === "RESOLVED";
  const canClose = status === "RESOLVED";
  const canEscalate = status !== "CLOSED";
  // Decision write-back (INS-FR-061): only meaningful once a case has a real
  // outcome to sync — matches the design doc's "on a resolved case" framing.
  const canSync = status === "RESOLVED";
  // Reopen is only legal within 30 days of resolvedAt — offer it disabled with
  // the reason, matching the server's own guard.
  const reopenExpired =
    canReopen && !!c.resolvedAt && Date.now() - new Date(c.resolvedAt).getTime() > REOPEN_WINDOW_MS;

  // Assign dialog state. Uses the member-safe assignable-users directory (no
  // identity.user.admin) so a Case Manager holding case.case.assign — but not
  // the tenant user-admin scope — can still populate the assignee dropdown.
  const [assigneeId, setAssigneeId] = useState("");
  const usersQuery = useAssignableUsers();
  const users = useMemo(() => usersQuery.data?.pages.flatMap((p) => p.nodes) ?? [], [usersQuery.data]);

  // Resolve dialog state — dispositions come from the real workspace catalog.
  const [dispositionId, setDispositionId] = useState("");
  const [note, setNote] = useState("");
  const dispositionsQuery = useDispositions();
  const activeDispositions = useMemo(
    () => (dispositionsQuery.data ?? []).filter((d) => d.active),
    [dispositionsQuery.data],
  );
  const chosenDisposition = activeDispositions.find((d) => d.id === dispositionId);
  const noteMissing = !!chosenDisposition?.requiresNote && note.trim() === "";

  // Escalate dialog state.
  const [reason, setReason] = useState("");

  // Sync-to-SoR dialog state (INS-FR-061). Only postgres/http_api connections
  // have a real write-back executor server-side, so only `outgoing`/`both`
  // connections of those types are offered as targets.
  const connectionsQuery = useConnections();
  const outgoingConnections = useMemo(
    () =>
      (connectionsQuery.data?.pages.flatMap((p) => p.nodes) ?? []).filter(
        (conn) =>
          (conn.trafficDirection === "outgoing" || conn.trafficDirection === "both") &&
          (conn.connectorType === "postgres" || conn.connectorType === "http_api"),
      ),
    [connectionsQuery.data],
  );
  const [syncConnectionId, setSyncConnectionId] = useState("");
  const [syncTarget, setSyncTarget] = useState("{}");
  // BRD 57: this dialog's payload default (below) is a case-disposition
  // snapshot, which is NOT the shape x12_out.py expects (`{claims:[...]}` /
  // `{inquiries:[...]}`) — an X12 write-back is a different kind of decision
  // (e.g. a corrected claim), not a disposition sync. Rather than build a
  // bespoke form for ~10 rarely-used identity fields on a dialog that stays
  // fundamentally a generic JSON editor, "Insert template" swaps in a
  // starting skeleton the user edits — honest about what this screen is.
  // isa_control/gs_control/st_control are deliberately absent: Core assigns
  // them per trading partner (BR-6) and ignores anything supplied here.
  const [syncPayload, setSyncPayload] = useState(() =>
    JSON.stringify({ case_id: c.id, case_number: c.caseNumber, disposition_id: c.dispositionId ?? null,
      severity: c.severity, resolution_note: c.resolutionNote ?? null, resolved_at: c.resolvedAt ?? null }, null, 2),
  );
  const [syncJsonError, setSyncJsonError] = useState<string | null>(null);
  const createWriteback = useCreateWriteback();
  const syncError = createWriteback.error instanceof GraphQLRequestError ? createWriteback.error : null;

  if (status === "CLOSED") return null;

  return (
    <div className="mb-4 flex flex-wrap items-center gap-2">
      {canAssign && (
        <Can gate={FEATURE_GATES.assignCase}>
          <Button size="sm" variant="secondary" onClick={() => setDialog("assign")}>
            {c.assignee ? "Reassign" : "Assign"}
          </Button>
        </Can>
      )}
      {canUnassign && (
        <Can gate={FEATURE_GATES.assignCase}>
          <Button
            size="sm"
            variant="outline"
            disabled={unassign.isPending}
            onClick={() =>
              unassign.mutate(undefined, {
                onSuccess: toastOk("Case unassigned", "unassign"),
                onError: toastError("Unassign failed"),
              })
            }
          >
            Unassign
          </Button>
        </Can>
      )}
      {canStart && (
        <Can gate={FEATURE_GATES.startCase}>
          <Button
            size="sm"
            disabled={start.isPending}
            onClick={() =>
              start.mutate(undefined, {
                onSuccess: toastOk("Case started", "start"),
                onError: toastError("Start failed"),
              })
            }
          >
            Start
          </Button>
        </Can>
      )}
      {canResolve && (
        <Can gate={FEATURE_GATES.manageCase}>
          <Button size="sm" onClick={() => setDialog("resolve")}>
            Resolve
          </Button>
        </Can>
      )}
      {canReopen && (
        <Can gate={FEATURE_GATES.manageCase}>
          <Button
            size="sm"
            variant="secondary"
            disabled={reopen.isPending || reopenExpired}
            title={
              reopenExpired
                ? `Reopen window expired — cases can only be reopened within 30 days of resolution (resolved ${formatLocal(c.resolvedAt)})`
                : undefined
            }
            onClick={() =>
              reopen.mutate(undefined, {
                onSuccess: toastOk("Case reopened", "reopen"),
                onError: toastError("Reopen failed"),
              })
            }
          >
            Reopen
          </Button>
        </Can>
      )}
      {canClose && (
        <Can gate={FEATURE_GATES.manageCase}>
          <Button size="sm" variant="destructive" onClick={() => setDialog("close")}>
            Close
          </Button>
        </Can>
      )}
      {canEscalate && (
        <Can gate={FEATURE_GATES.manageCase}>
          <Button size="sm" variant="outline" onClick={() => setDialog("escalate")}>
            Escalate
          </Button>
        </Can>
      )}
      {/* Gated on manageCase (case.case.update) — the same capability
          agent-runtime re-checks before minting the proposal, so the button is
          hidden from exactly the users whose run would be refused. */}
      <Can gate={FEATURE_GATES.manageCase}>
        <Button size="sm" variant="ai" onClick={runTriage} disabled={triaging}>
          {triaging ? "Drafting…" : "Draft recommendation"}
        </Button>
      </Can>
      {canSync && (
        <Can gate={FEATURE_GATES.createWriteback}>
          <Button size="sm" variant="outline" onClick={() => setDialog("sync")}>
            Sync to system of record
          </Button>
        </Can>
      )}

      {/* Assign — real user directory, real transition. */}
      <ConfirmDialog
        open={dialog === "assign"}
        onOpenChange={(o) => {
          if (!o) setAssigneeId("");
          setDialog(o ? "assign" : null);
        }}
        title={c.assignee ? "Reassign case" : "Assign case"}
        description="The assignee becomes responsible for working this case to resolution."
        confirmLabel={assign.isPending ? "Assigning…" : "Assign"}
        onConfirm={() => {
          if (!assigneeId || assign.isPending) return;
          assign.mutate(assigneeId, {
            onSuccess: () => {
              setDialog(null);
              setAssigneeId("");
              push({ title: "Case assigned", variant: "success" });
              onAfterTransition?.("assign");
            },
            onError: toastError("Assign failed"),
          });
        }}
      >
        <div className="mt-3 space-y-1.5">
          <label htmlFor="case-assignee" className="text-xs text-muted-foreground">
            Assign to
          </label>
          <select
            id="case-assignee"
            value={assigneeId}
            onChange={(e) => setAssigneeId(e.target.value)}
            disabled={assign.isPending}
            className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
          >
            <option value="">Pick a user…</option>
            {users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.fullName || u.email}
              </option>
            ))}
          </select>
        </div>
      </ConfirmDialog>

      {/* Resolve — disposition from the real catalog; note enforced when the
          chosen disposition requires one (the server 422s regardless). */}
      <ConfirmDialog
        open={dialog === "resolve"}
        onOpenChange={(o) => {
          if (!o) {
            setDispositionId("");
            setNote("");
          }
          setDialog(o ? "resolve" : null);
        }}
        title="Resolve case"
        description="Pick the disposition that describes the outcome. Resolved cases can be reopened for 30 days, then closed."
        confirmLabel={resolve.isPending ? "Resolving…" : "Resolve"}
        onConfirm={() => {
          if (!dispositionId || noteMissing || resolve.isPending) return;
          resolve.mutate(
            { dispositionId, resolutionNote: note.trim() || undefined },
            {
              onSuccess: () => {
                setDialog(null);
                setDispositionId("");
                setNote("");
                push({ title: "Case resolved", variant: "success" });
                onAfterTransition?.("resolve");
              },
              onError: toastError("Resolve failed"),
            },
          );
        }}
      >
        <div className="mt-3 space-y-3">
          <div className="space-y-1.5">
            <label htmlFor="case-disposition" className="text-xs text-muted-foreground">
              Disposition
            </label>
            <select
              id="case-disposition"
              value={dispositionId}
              onChange={(e) => setDispositionId(e.target.value)}
              disabled={resolve.isPending}
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
            <label htmlFor="case-resolution-note" className="text-xs text-muted-foreground">
              Resolution note{chosenDisposition?.requiresNote ? " (required for this disposition)" : " (optional)"}
            </label>
            <Textarea
              id="case-resolution-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              disabled={resolve.isPending}
              placeholder="What was found and why this disposition applies…"
            />
            {noteMissing && (
              <p className="text-xs text-destructive">This disposition requires a resolution note.</p>
            )}
          </div>
        </div>
      </ConfirmDialog>

      {/* Close — terminal, so a proportionate destructive confirm. */}
      <ConfirmDialog
        open={dialog === "close"}
        onOpenChange={(o) => setDialog(o ? "close" : null)}
        title="Close case"
        description="Closing is terminal — a closed case can never be reopened or edited."
        confirmLabel={close.isPending ? "Closing…" : "Close case"}
        destructive
        onConfirm={() => {
          if (close.isPending) return;
          close.mutate(undefined, {
            onSuccess: () => {
              setDialog(null);
              push({ title: "Case closed", variant: "success" });
              onAfterTransition?.("close");
            },
            onError: toastError("Close failed"),
          });
        }}
      />

      {/* Escalate — bumps severity one level; status is unchanged. */}
      <ConfirmDialog
        open={dialog === "escalate"}
        onOpenChange={(o) => {
          if (!o) setReason("");
          setDialog(o ? "escalate" : null);
        }}
        title="Escalate case"
        description="Escalating bumps the severity one level and records who asked and why."
        confirmLabel={escalate.isPending ? "Escalating…" : "Escalate"}
        onConfirm={() => {
          if (escalate.isPending) return;
          escalate.mutate(
            { reason: reason.trim() || undefined },
            {
              onSuccess: () => {
                setDialog(null);
                setReason("");
                push({ title: "Case escalated", variant: "success" });
                onAfterTransition?.("escalate");
              },
              onError: toastError("Escalate failed"),
            },
          );
        }}
      >
        <div className="mt-3 space-y-1.5">
          <label htmlFor="case-escalate-reason" className="text-xs text-muted-foreground">
            Reason
          </label>
          <Textarea
            id="case-escalate-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            disabled={escalate.isPending}
            placeholder="Why this needs more urgency…"
          />
        </div>
      </ConfirmDialog>

      {/* Sync to system of record — enqueues a governed, four-eyes write-back
          (INS-FR-061); this only REQUESTS delivery, a different principal must
          approve it under Admin → Decision write-backs before it actually syncs. */}
      <ConfirmDialog
        open={dialog === "sync"}
        onOpenChange={(o) => {
          if (!o) {
            setSyncConnectionId("");
            setSyncTarget("{}");
            setSyncJsonError(null);
          }
          setDialog(o ? "sync" : null);
        }}
        title="Sync to system of record"
        description="Enqueues a decision write-back for four-eyes approval — a different user must approve it (Admin → Decision write-backs) before anything is actually delivered."
        confirmLabel={createWriteback.isPending ? "Enqueuing…" : "Enqueue write-back"}
        onConfirm={() => {
          if (!syncConnectionId || createWriteback.isPending) return;
          let target: Record<string, unknown>;
          let payload: Record<string, unknown>;
          try {
            target = JSON.parse(syncTarget);
            payload = JSON.parse(syncPayload);
          } catch {
            setSyncJsonError("Target and payload must be valid JSON.");
            return;
          }
          setSyncJsonError(null);
          createWriteback.mutate(
            { connectionId: syncConnectionId, decisionKind: "case.disposition", decisionRef: c.urn, target, payload },
            {
              onSuccess: () => {
                setDialog(null);
                setSyncConnectionId("");
                setSyncTarget("{}");
                push({ title: "Write-back enqueued — awaiting four-eyes approval", variant: "success" });
              },
              onError: toastError("Sync failed"),
            },
          );
        }}
      >
        <div className="mt-3 space-y-3">
          <div className="space-y-1.5">
            <p className="text-xs text-muted-foreground">Insert template</p>
            <div className="flex flex-wrap gap-1.5">
              {Object.entries(SYNC_TEMPLATES).map(([key, tpl]) => (
                <Button
                  key={key}
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={createWriteback.isPending}
                  onClick={() => {
                    setSyncTarget(JSON.stringify(tpl.target, null, 2));
                    setSyncPayload(JSON.stringify(tpl.payload, null, 2));
                  }}
                >
                  {tpl.label}
                </Button>
              ))}
            </div>
          </div>
          <div className="space-y-1.5">
            <label htmlFor="sync-connection" className="text-xs text-muted-foreground">
              Target connection
            </label>
            <select
              id="sync-connection"
              value={syncConnectionId}
              onChange={(e) => setSyncConnectionId(e.target.value)}
              disabled={createWriteback.isPending}
              className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
            >
              <option value="">Pick an outgoing connection…</option>
              {outgoingConnections.map((conn) => (
                <option key={conn.id} value={conn.id}>
                  {conn.name} ({conn.connectorType})
                </option>
              ))}
            </select>
            {connectionsQuery.data && outgoingConnections.length === 0 && (
              <p className="text-xs text-destructive">
                No outgoing connection configured yet — create one under Data → Data Sources
                (traffic direction: outgoing or both; postgres or http_api only).
              </p>
            )}
          </div>
          <div className="space-y-1.5">
            <label htmlFor="sync-target" className="text-xs text-muted-foreground">
              Target routing (postgres: {"{schema, table, key_column}"}; http_api: {"{path?, method?}"};
              X12 EDI: {"{format:\"x12\", transaction_set, sender_id, receiver_id, ...}"} — control
              numbers are assigned automatically, per trading partner)
            </label>
            <Textarea
              id="sync-target"
              value={syncTarget}
              onChange={(e) => setSyncTarget(e.target.value)}
              disabled={createWriteback.isPending}
              className="font-mono text-xs"
              rows={3}
            />
          </div>
          <div className="space-y-1.5">
            <label htmlFor="sync-payload" className="text-xs text-muted-foreground">
              Payload (the decision snapshot delivered to the system of record)
            </label>
            <Textarea
              id="sync-payload"
              value={syncPayload}
              onChange={(e) => setSyncPayload(e.target.value)}
              disabled={createWriteback.isPending}
              className="font-mono text-xs"
              rows={6}
            />
          </div>
          {syncJsonError && <p className="text-xs text-destructive">{syncJsonError}</p>}
          {syncError && (
            <p role="alert" className="text-xs text-destructive" data-testid="mutation-error">
              {syncError.message}
            </p>
          )}
        </div>
      </ConfirmDialog>
    </div>
  );
}
