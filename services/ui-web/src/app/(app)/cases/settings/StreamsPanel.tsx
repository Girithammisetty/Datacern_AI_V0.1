"use client";
import { useMemo, useState } from "react";
import { DataTable, type Column } from "@/components/primitives/DataTable";
import { AsyncBoundary } from "@/components/primitives/AsyncBoundary";
import { ConfirmDialog } from "@/components/primitives/ConfirmDialog";
import { Can } from "@/components/authz/Can";
import { FEATURE_GATES } from "@/lib/authz/registry";
import { Badge, Card, CardContent, CardHeader, CardTitle, Input, Label } from "@/components/ui/primitives";
import { Button } from "@/components/ui/button";
import {
  useCaseStreams, useCreateCaseStream, usePauseCaseStream, useResumeCaseStream,
  useDeleteCaseStream, useConnections,
} from "@/lib/graphql/hooks";
import { GraphQLRequestError } from "@/lib/graphql/client";
import { useToasts } from "@/stores/ui";
import type { CaseStream } from "@/lib/graphql/types";

const STREAM_SEVERITIES = ["low", "medium", "high", "critical"];
const WATERMARK_TYPES = ["timestamp", "date", "int", "decimal", "string"];

/**
 * Streams (realtime-case-streams add-on): named bindings of a source
 * connection + watermark-incremental schedule + the case trigger they feed.
 * Create/resume are entitlement-gated server-side — a refusal is shown
 * verbatim (the 403 names the SKU; the 503 says the commercial plane could
 * not be consulted), never softened into a generic error. RBAC rides the
 * existing ingestion.schedule.* gates because a stream IS a governed schedule.
 */
export function StreamsPanel() {
  const query = useCaseStreams();
  const connectionsQuery = useConnections();
  const connections = useMemo(
    () => connectionsQuery.data?.pages.flatMap((p) => p.nodes) ?? [],
    [connectionsQuery.data],
  );
  const create = useCreateCaseStream();
  const pauseStream = usePauseCaseStream();
  const resumeStream = useResumeCaseStream();
  const del = useDeleteCaseStream();
  const push = useToasts((s) => s.push);

  const [creating, setCreating] = useState(false);
  const [gateMsg, setGateMsg] = useState<string | null>(null);
  const [toDelete, setToDelete] = useState<CaseStream | null>(null);
  const [form, setForm] = useState({
    name: "", connectionId: "", statement: "", datasetName: "",
    watermarkColumn: "", watermarkType: "timestamp", watermarkInitial: "",
    intervalSeconds: "300", severity: "medium", attachEvidence: true,
  });
  const set = (k: string, v: unknown) => setForm((f) => ({ ...f, [k]: v }));

  const rows = query.data ?? [];

  const onMutationError = (title: string) => (err: unknown) => {
    const g = err instanceof GraphQLRequestError ? err : null;
    if (g && (g.code === "PERMISSION_DENIED" || g.code === "ENTITLEMENT_UNAVAILABLE")) {
      // The commercial refusal, verbatim — it already names the SKU or the
      // fail-closed reason, and softening it would hide what to do next.
      setGateMsg(g.message);
      return;
    }
    push({ title, description: g?.message ?? String(err), traceId: g?.traceId, variant: "error" });
  };

  const submit = () => {
    setGateMsg(null);
    create.mutate(
      {
        name: form.name.trim(),
        connectionId: form.connectionId,
        ingestionTemplate: {
          ingestion_mode: "query",
          statement: form.statement.trim(),
          new_dataset: { name: form.datasetName.trim() },
        },
        intervalSeconds: Math.max(60, Number(form.intervalSeconds) || 300),
        watermark: {
          column: form.watermarkColumn.trim(),
          valueType: form.watermarkType,
          initialValue: form.watermarkInitial.trim(),
        },
        enabled: true,
        trigger: { severity: form.severity, attachEvidence: form.attachEvidence },
      },
      {
        onSuccess: (s) => {
          setCreating(false);
          push({ title: "Stream created", description: `${s.name} is pulling from its source.`, variant: "success" });
        },
        onError: onMutationError("Create failed"),
      },
    );
  };

  const columns: Column<CaseStream>[] = useMemo(
    () => [
      { id: "name", header: "Name", cell: (s) => <span className="font-medium">{s.name}</span> },
      {
        id: "status", header: "Status", width: 100,
        cell: (s) => (
          <Badge variant={s.status === "active" ? "success" : "outline"}>{s.status}</Badge>
        ),
      },
      {
        id: "cursor", header: "Watermark cursor", width: 200,
        cell: (s) => (
          <span className="font-mono text-xs text-muted-foreground">
            {s.schedule?.watermark?.current_value ?? "—"}
          </span>
        ),
      },
      {
        id: "next", header: "Next pull", width: 180,
        cell: (s) => <span className="text-xs">{s.schedule?.next_fire_at ?? "—"}</span>,
      },
      {
        id: "trigger", header: "Case trigger", width: 110,
        cell: (s) =>
          s.caseTriggerId ? <Badge variant="outline">bound</Badge> : <span className="text-xs text-muted-foreground">none</span>,
      },
      {
        id: "actions", header: "", width: 170,
        cell: (s) => (
          <div className="flex justify-end gap-1">
            <Can gate={FEATURE_GATES.updateIngestionSchedule}>
              {s.status === "active" ? (
                <Button
                  size="sm" variant="ghost" disabled={pauseStream.isPending}
                  onClick={() =>
                    pauseStream.mutate(s.id, {
                      onSuccess: () => push({ title: "Stream paused", variant: "success" }),
                      onError: onMutationError("Pause failed"),
                    })
                  }
                >
                  Pause
                </Button>
              ) : (
                <Button
                  size="sm" variant="ghost" disabled={resumeStream.isPending}
                  onClick={() => {
                    setGateMsg(null);
                    resumeStream.mutate(s.id, {
                      onSuccess: () => push({ title: "Stream resumed", variant: "success" }),
                      onError: onMutationError("Resume failed"),
                    });
                  }}
                >
                  Resume
                </Button>
              )}
            </Can>
            <Can gate={FEATURE_GATES.deleteIngestionSchedule}>
              <Button size="sm" variant="ghost" onClick={() => setToDelete(s)}>
                Delete
              </Button>
            </Can>
          </div>
        ),
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pauseStream.isPending, resumeStream.isPending],
  );

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <p className="text-sm text-muted-foreground">
          Watch an enterprise source and turn matching rows into cases on this
          workspace&apos;s worklist, with the intake snapshot frozen as evidence.
          Part of the realtime-case-streams add-on.
        </p>
        <Can gate={FEATURE_GATES.createIngestionSchedule}>
          <Button size="sm" className="ml-auto" onClick={() => { setGateMsg(null); setCreating(true); }}>
            New stream
          </Button>
        </Can>
      </div>

      {gateMsg && (
        <div
          role="alert"
          className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200"
        >
          {gateMsg}
        </div>
      )}

      <AsyncBoundary
        isLoading={query.isLoading}
        isError={query.isError}
        error={query.error}
        isEmpty={!query.isLoading && rows.length === 0}
        emptyTitle="No streams yet"
        emptyHint="Create one to start pulling new rows from a connected source into this workspace's case worklist."
        onRetry={() => query.refetch()}
      >
        <DataTable ariaLabel="Case streams" rows={rows} columns={columns} rowId={(s) => s.id} />
      </AsyncBoundary>

      {creating && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">New stream</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid gap-3 md:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="cs-name">Name</Label>
                <Input id="cs-name" value={form.name} placeholder="high-value-orders"
                  onChange={(e) => set("name", e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="cs-conn">Connection</Label>
                <select
                  id="cs-conn"
                  className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                  value={form.connectionId}
                  onChange={(e) => set("connectionId", e.target.value)}
                >
                  <option value="">Select a connection…</option>
                  {connections.map((c) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>
              </div>
              <div className="space-y-1 md:col-span-2">
                <Label htmlFor="cs-stmt">Source statement</Label>
                <Input id="cs-stmt" placeholder="SELECT * FROM schema.table" value={form.statement}
                  className="font-mono" onChange={(e) => set("statement", e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="cs-ds">Target dataset name</Label>
                <Input id="cs-ds" value={form.datasetName} placeholder="orders-stream"
                  onChange={(e) => set("datasetName", e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="cs-int">Pull interval (seconds)</Label>
                <Input id="cs-int" type="number" min={60} value={form.intervalSeconds}
                  onChange={(e) => set("intervalSeconds", e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="cs-wm">Watermark column</Label>
                <Input id="cs-wm" placeholder="updated_at" value={form.watermarkColumn}
                  onChange={(e) => set("watermarkColumn", e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="cs-wmt">Watermark type</Label>
                <select id="cs-wmt" className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                  value={form.watermarkType} onChange={(e) => set("watermarkType", e.target.value)}>
                  {WATERMARK_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="cs-wmi">Start from (initial watermark)</Label>
                <Input id="cs-wmi" placeholder="2026-01-01T00:00:00Z" value={form.watermarkInitial}
                  onChange={(e) => set("watermarkInitial", e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="cs-sev">Case severity</Label>
                <select id="cs-sev" className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                  value={form.severity} onChange={(e) => set("severity", e.target.value)}>
                  {STREAM_SEVERITIES.map((sv) => <option key={sv} value={sv}>{sv}</option>)}
                </select>
              </div>
              <label className="flex items-center gap-2 text-sm md:col-span-2">
                <input type="checkbox" checked={form.attachEvidence}
                  onChange={(e) => set("attachEvidence", e.target.checked)} />
                Freeze each matched row as intake-snapshot evidence on the case
              </label>
            </div>
            <p className="mt-3 text-xs text-muted-foreground">
              Only rows past the watermark are pulled each interval, so the source is
              never re-read from scratch. New cases land on this workspace&apos;s
              worklist and update live.
            </p>
            <div className="mt-3 flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setCreating(false)}>Cancel</Button>
              <Button
                disabled={create.isPending || !form.name.trim() || !form.connectionId ||
                  !form.statement.trim() || !form.datasetName.trim() ||
                  !form.watermarkColumn.trim() || !form.watermarkInitial.trim()}
                onClick={submit}
              >
                {create.isPending ? "Creating…" : "Create stream"}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <ConfirmDialog
        open={toDelete != null}
        onOpenChange={(o) => { if (!o) setToDelete(null); }}
        title="Delete stream?"
        description={`"${toDelete?.name ?? ""}" stops pulling and its schedule is removed. Cases already created stay.`}
        confirmLabel={del.isPending ? "Deleting…" : "Delete"}
        destructive
        onConfirm={() => {
          const s = toDelete;
          if (!s || del.isPending) return;
          del.mutate(s.id, {
            onSuccess: () => {
              setToDelete(null);
              push({ title: "Stream deleted", variant: "success" });
            },
            onError: (err) => {
              setToDelete(null);
              onMutationError("Delete failed")(err);
            },
          });
        }}
      />
    </div>
  );
}
