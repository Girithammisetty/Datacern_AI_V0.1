"use client";
import { useState } from "react";
import { PageHeader } from "@/components/shell/PageHeader";
import { AsyncBoundary } from "@/components/primitives/AsyncBoundary";
import { StatusChip } from "@/components/primitives/StatusChip";
import { ConfirmDialog } from "@/components/primitives/ConfirmDialog";
import { Card, CardHeader, CardTitle, CardDescription, Badge, Input } from "@/components/ui/primitives";
import { Button } from "@/components/ui/button";
import {
  useSiemConfig, useProposeSiemConfig, useApproveSiemConfig, useRejectSiemConfig, useDeleteSiemConfig,
} from "@/lib/graphql/hooks";
import { useSession } from "@/lib/session/SessionContext";
import { GraphQLRequestError } from "@/lib/graphql/client";
import type { SiemConfig } from "@/lib/graphql/types";
import { formatLocal } from "@/lib/utils";

/**
 * BRD 59 WS2 — self-service SIEM export destination. Four-eyes gated, same
 * shape as the decision write-back screen: propose creates a pending row that
 * a DISTINCT admin must approve before it starts receiving events; the
 * currently-active destination keeps delivering unaffected until then.
 */
export default function AuditExportPage() {
  const { userId } = useSession();
  const query = useSiemConfig();
  const propose = useProposeSiemConfig();
  const approve = useApproveSiemConfig();
  const reject = useRejectSiemConfig();
  const del = useDeleteSiemConfig();

  const [endpoint, setEndpoint] = useState("");
  const [format, setFormat] = useState<"JSON" | "CEF" | "LEEF">("JSON");
  const [authRef, setAuthRef] = useState("");
  const [toDecide, setToDecide] = useState<{ cfg: SiemConfig; action: "approve" | "reject" } | null>(null);
  const [toDelete, setToDelete] = useState<SiemConfig | null>(null);

  const decideMutation = toDecide?.action === "reject" ? reject : approve;
  const decideError = decideMutation.error instanceof GraphQLRequestError ? decideMutation.error : null;
  const proposeError = propose.error instanceof GraphQLRequestError ? propose.error : null;

  const active = query.data?.active ?? null;
  const pending = query.data?.pending ?? null;
  const history = query.data?.history ?? [];

  return (
    <div>
      <PageHeader
        title="SIEM export destination"
        description="Stream this tenant's audit trail (WORM events) to an external SIEM as CEF, LEEF, or JSON lines. Changing the destination is four-eyes gated — a second admin must approve before it takes effect."
      />

      <AsyncBoundary isLoading={query.isLoading} isError={query.isError} error={query.error} onRetry={() => query.refetch()}>
        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center justify-between">
                Active destination
                {active && <Badge variant="success">delivering</Badge>}
              </CardTitle>
              <CardDescription>Events post here in real time as they&apos;re written to the audit trail.</CardDescription>
            </CardHeader>
            <div className="px-4 pb-4">
              {active ? (
                <div className="space-y-2 text-sm">
                  <DetailRow label="Endpoint" value={active.endpoint} mono />
                  <DetailRow label="Format" value={active.format} />
                  <DetailRow label="Approved by" value={active.approvedBy ?? "—"} />
                  <DetailRow label="Since" value={formatLocal(active.updatedAt)} />
                  <Button
                    size="sm" variant="outline" className="mt-2"
                    onClick={() => setToDelete(active)}
                  >
                    Stop delivery
                  </Button>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">No destination is currently active — nothing is being exported.</p>
              )}
            </div>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Propose a new destination</CardTitle>
              <CardDescription>
                {pending
                  ? "A proposal is already awaiting approval below — resolve it before proposing another."
                  : "Creates a pending proposal. It does not take effect until a different admin approves it."}
              </CardDescription>
            </CardHeader>
            <div className="space-y-3 px-4 pb-4">
              <label className="flex flex-col gap-1 text-xs">
                <span className="text-muted-foreground">Endpoint (https://)</span>
                <Input
                  value={endpoint} onChange={(e) => setEndpoint(e.target.value)}
                  placeholder="https://siem.example.com/ingest" disabled={!!pending}
                />
              </label>
              <label className="flex flex-col gap-1 text-xs">
                <span className="text-muted-foreground">Format</span>
                <select
                  value={format} onChange={(e) => setFormat(e.target.value as typeof format)} disabled={!!pending}
                  className="h-9 rounded-md border border-input bg-background px-2 text-sm"
                >
                  <option value="JSON">JSON</option>
                  <option value="CEF">CEF (ArcSight)</option>
                  <option value="LEEF">LEEF (QRadar)</option>
                </select>
              </label>
              <label className="flex flex-col gap-1 text-xs">
                <span className="text-muted-foreground">Auth reference (optional)</span>
                <Input
                  value={authRef} onChange={(e) => setAuthRef(e.target.value)}
                  placeholder="secret ref, if the collector requires auth" disabled={!!pending}
                />
              </label>
              <Button
                size="sm" disabled={!endpoint.trim() || !!pending || propose.isPending}
                onClick={() =>
                  propose.mutate(
                    { endpoint: endpoint.trim(), format, authRef: authRef.trim() || undefined },
                    { onSuccess: () => { setEndpoint(""); setAuthRef(""); } },
                  )
                }
              >
                {propose.isPending ? "Proposing…" : "Propose"}
              </Button>
              {proposeError && (
                <p role="alert" className="text-xs text-destructive" data-testid="propose-error">{proposeError.message}</p>
              )}
            </div>
          </Card>
        </div>

        {pending && (
          <Card className="mt-4">
            <CardHeader>
              <CardTitle className="flex items-center justify-between">
                Pending approval
                <StatusChip status={pending.status} />
              </CardTitle>
            </CardHeader>
            <div className="space-y-2 px-4 pb-4 text-sm">
              <DetailRow label="Endpoint" value={pending.endpoint} mono />
              <DetailRow label="Format" value={pending.format} />
              <DetailRow label="Requested by" value={pending.requestedBy} />
              <DetailRow label="Requested" value={formatLocal(pending.createdAt)} />
              <div className="mt-2 flex items-center gap-1.5">
                <Button
                  size="sm" variant="outline"
                  disabled={pending.requestedBy === userId}
                  title={pending.requestedBy === userId ? "Four-eyes: you cannot approve your own proposal" : undefined}
                  onClick={() => setToDecide({ cfg: pending, action: "approve" })}
                >
                  Approve
                </Button>
                <Button size="sm" variant="outline" onClick={() => setToDecide({ cfg: pending, action: "reject" })}>
                  Reject
                </Button>
              </div>
            </div>
          </Card>
        )}

        {history.length > 0 && (
          <Card className="mt-4">
            <CardHeader>
              <CardTitle>Decision history</CardTitle>
            </CardHeader>
            <div className="divide-y px-4 pb-2">
              {history.map((h) => (
                <div key={h.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                  <span className="truncate font-mono text-xs">{h.endpoint}</span>
                  <span className="text-xs text-muted-foreground">{h.format}</span>
                  <StatusChip status={h.status} />
                  <span className="whitespace-nowrap text-xs text-muted-foreground">{formatLocal(h.updatedAt)}</span>
                  {h.status !== "pending_approval" && (
                    <Button size="sm" variant="ghost" onClick={() => setToDelete(h)}>Delete</Button>
                  )}
                </div>
              ))}
            </div>
          </Card>
        )}
      </AsyncBoundary>

      <ConfirmDialog
        open={!!toDecide}
        onOpenChange={(o) => !o && setToDecide(null)}
        title={toDecide?.action === "reject" ? "Reject proposal?" : "Approve destination?"}
        description={
          toDecide?.action === "reject"
            ? "This proposal will be declined; the currently active destination (if any) is unaffected."
            : `This will start streaming audit events to "${toDecide?.cfg.endpoint}" and deactivate any previously active destination.`
        }
        confirmLabel={toDecide?.action === "reject" ? "Reject" : "Approve"}
        destructive={toDecide?.action === "reject"}
        onConfirm={() => {
          if (!toDecide) return;
          if (toDecide.action === "reject") {
            reject.mutate({ id: toDecide.cfg.id }, { onSuccess: () => setToDecide(null) });
          } else {
            approve.mutate(toDecide.cfg.id, { onSuccess: () => setToDecide(null) });
          }
        }}
      >
        {decideError && (
          <p role="alert" className="mt-2 text-xs text-destructive" data-testid="decide-error">{decideError.message}</p>
        )}
      </ConfirmDialog>

      <ConfirmDialog
        open={!!toDelete}
        onOpenChange={(o) => !o && setToDelete(null)}
        title="Delete destination?"
        description={
          toDelete?.active
            ? "This is the active destination — deleting it stops delivery immediately."
            : "This removes a decided (approved/rejected) destination row from history."
        }
        confirmLabel="Delete"
        destructive
        onConfirm={() => {
          if (!toDelete) return;
          del.mutate(toDelete.id, { onSuccess: () => setToDelete(null) });
        }}
      />
    </div>
  );
}

function DetailRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-muted-foreground">{label}</span>
      <span className={mono ? "truncate font-mono text-xs" : "font-medium"}>{value}</span>
    </div>
  );
}
