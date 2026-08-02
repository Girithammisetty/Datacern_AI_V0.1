"use client";
import { useState } from "react";
import { Activity } from "lucide-react";
import { DataTable, type Column } from "@/components/primitives/DataTable";
import { AsyncBoundary } from "@/components/primitives/AsyncBoundary";
import { ConfirmDialog } from "@/components/primitives/ConfirmDialog";
import { Can } from "@/components/authz/Can";
import { Badge, Card, CardHeader, CardTitle, CardDescription, CardContent, Input } from "@/components/ui/primitives";
import { Button } from "@/components/ui/button";
import { FEATURE_GATES } from "@/lib/authz/registry";
import { useRetrainWatches, useCreateRetrainWatch, useDeleteRetrainWatch } from "@/lib/graphql/hooks";
import type { RetrainWatch } from "@/lib/graphql/types";
import { useToasts } from "@/stores/ui";
import { formatLocal } from "@/lib/utils";

/**
 * BRD 52 inc3: scheduled drift watches on deployed models. The runtime's
 * scheduler counts human corrections to the watched agent's proposals on the
 * cadence and, past the drift threshold, opens a four-eyes RETRAIN proposal
 * via the governance agent — this card manages those thresholds. Everything
 * here (list included) needs ai.agent.admin downstream, so the whole card is
 * gated on that capability.
 */
export function RetrainWatchesCard() {
  const query = useRetrainWatches();
  const create = useCreateRetrainWatch();
  const del = useDeleteRetrainWatch();
  const push = useToasts((s) => s.push);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<RetrainWatch | null>(null);
  const rows = query.data ?? [];

  const columns: Column<RetrainWatch>[] = [
    { id: "model", header: "Model", cell: (w) => <span className="font-mono text-xs font-medium">{w.modelUrn}</span> },
    { id: "agent", header: "Watched agent", width: 150, cell: (w) => <span className="font-mono text-xs">{w.watchedAgentKey}</span> },
    { id: "threshold", header: "Drift threshold", width: 110, cell: (w) => `${Math.round(w.driftThreshold * 100)}%` },
    { id: "minCorrections", header: "Min corrections", width: 110, cell: (w) => w.minCorrections },
    { id: "cadence", header: "Cadence", width: 90, cell: (w) => `${Math.round(w.cadenceSeconds / 3600)}h` },
    { id: "window", header: "Window", width: 80, cell: (w) => `${w.correctionWindowHours}h` },
    {
      id: "enabled", header: "State", width: 90,
      cell: (w) => <Badge variant={w.enabled ? "success" : "secondary"}>{w.enabled ? "enabled" : "disabled"}</Badge>,
    },
    { id: "lastChecked", header: "Last checked", width: 160, cell: (w) => w.lastCheckedAt ? formatLocal(w.lastCheckedAt) : <span className="text-muted-foreground">never</span> },
    {
      id: "actions", header: "", width: 90,
      cell: (w) => (
        <Button
          variant="ghost" size="sm" className="text-destructive"
          disabled={del.isPending}
          onClick={(e) => { e.stopPropagation(); setDeleting(w); }}
        >
          Delete
        </Button>
      ),
    },
  ];

  return (
    <Can gate={FEATURE_GATES.manageRetrainWatches}>
      <Card>
        <CardHeader className="flex-row items-start justify-between space-y-0">
          <div className="space-y-1.5">
            <CardTitle className="flex items-center gap-2 text-sm">
              <Activity className="size-4" aria-hidden /> Retrain watches
            </CardTitle>
            <CardDescription>
              Drift thresholds on deployed models. Past the threshold, a four-eyes retrain proposal is opened automatically — never an unattended retrain.
            </CardDescription>
          </div>
          <Button size="sm" onClick={() => setCreating((v) => !v)}>
            {creating ? "Cancel" : "New watch"}
          </Button>
        </CardHeader>
        <CardContent className="space-y-3">
          {creating && (
            <NewWatchForm
              pending={create.isPending}
              error={create.error}
              onCreate={(input) =>
                create.mutate(input, {
                  onSuccess: () => { setCreating(false); push({ title: "Retrain watch created", variant: "success" }); },
                })
              }
            />
          )}
          <AsyncBoundary
            isLoading={query.isLoading} isError={query.isError} error={query.error}
            isEmpty={rows.length === 0} emptyTitle="No retrain watches." onRetry={() => query.refetch()}
          >
            <DataTable
              ariaLabel="Retrain watches"
              rows={rows}
              columns={columns}
              rowId={(w) => w.id}
            />
          </AsyncBoundary>
        </CardContent>

        <ConfirmDialog
          open={deleting !== null}
          onOpenChange={(o) => !o && setDeleting(null)}
          title="Delete this retrain watch?"
          description={`Drift on ${deleting?.modelUrn ?? ""} will no longer be watched, and no retrain proposals will be opened for it.`}
          confirmLabel="Delete watch"
          destructive
          onConfirm={() => {
            if (deleting) {
              del.mutate(deleting.id, {
                onSuccess: () => push({ title: "Retrain watch deleted", variant: "success" }),
                onError: (e) => push({ title: e.message, variant: "error" }),
              });
            }
            setDeleting(null);
          }}
        />
      </Card>
    </Can>
  );
}

function NewWatchForm({
  onCreate,
  pending,
  error,
}: {
  onCreate: (input: { modelUrn: string; watchedAgentKey: string; driftThreshold?: number; minCorrections?: number; cadenceSeconds?: number; correctionWindowHours?: number }) => void;
  pending: boolean;
  error: Error | null;
}) {
  const [modelUrn, setModelUrn] = useState("");
  const [watchedAgentKey, setWatchedAgentKey] = useState("");
  const [threshold, setThreshold] = useState("30");
  const [minCorrections, setMinCorrections] = useState("20");
  const [windowHours, setWindowHours] = useState("168");

  const valid = modelUrn.trim() && watchedAgentKey.trim();

  return (
    <form
      className="flex flex-wrap items-end gap-2 rounded-md border p-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (!valid) return;
        const pct = Number(threshold);
        onCreate({
          modelUrn: modelUrn.trim(),
          watchedAgentKey: watchedAgentKey.trim(),
          driftThreshold: Number.isFinite(pct) ? pct / 100 : undefined,
          minCorrections: minCorrections.trim() ? Number(minCorrections) : undefined,
          correctionWindowHours: windowHours.trim() ? Number(windowHours) : undefined,
        });
      }}
    >
      <label className="flex flex-1 flex-col gap-1 text-xs">
        <span className="text-muted-foreground">Model URN</span>
        <Input value={modelUrn} onChange={(e) => setModelUrn(e.target.value)} placeholder="urn:dc:model:…" aria-label="Model URN" className="h-8 min-w-56 text-xs" />
      </label>
      <label className="flex flex-col gap-1 text-xs">
        <span className="text-muted-foreground">Watched agent key</span>
        <Input value={watchedAgentKey} onChange={(e) => setWatchedAgentKey(e.target.value)} aria-label="Watched agent key" className="h-8 w-40 text-xs" />
      </label>
      <label className="flex flex-col gap-1 text-xs">
        <span className="text-muted-foreground">Drift threshold %</span>
        <Input type="number" min="0" max="100" value={threshold} onChange={(e) => setThreshold(e.target.value)} aria-label="Drift threshold percent" className="h-8 w-24 text-xs" />
      </label>
      <label className="flex flex-col gap-1 text-xs">
        <span className="text-muted-foreground">Min corrections</span>
        <Input type="number" min="0" value={minCorrections} onChange={(e) => setMinCorrections(e.target.value)} aria-label="Min corrections" className="h-8 w-24 text-xs" />
      </label>
      <label className="flex flex-col gap-1 text-xs">
        <span className="text-muted-foreground">Window (hours)</span>
        <Input type="number" min="1" value={windowHours} onChange={(e) => setWindowHours(e.target.value)} aria-label="Correction window hours" className="h-8 w-24 text-xs" />
      </label>
      <Button type="submit" size="sm" disabled={pending || !valid}>Create watch</Button>
      {error && <p className="w-full text-xs text-destructive">{error.message}</p>}
    </form>
  );
}
