"use client";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, CalendarClock, Plus } from "lucide-react";
import * as Dialog from "@radix-ui/react-dialog";
import { PageHeader } from "@/components/shell/PageHeader";
import { DataTable, type Column } from "@/components/primitives/DataTable";
import { AsyncBoundary } from "@/components/primitives/AsyncBoundary";
import { StatusChip } from "@/components/primitives/StatusChip";
import { ConfirmDialog } from "@/components/primitives/ConfirmDialog";
import { Can } from "@/components/authz/Can";
import { Button } from "@/components/ui/button";
import { Badge, Input, Label } from "@/components/ui/primitives";
import { BatchRunTimeline } from "@/components/pipelines/BatchRunTimeline";
import { FEATURE_GATES } from "@/lib/authz/registry";
import {
  useBatchJobs,
  useBatchJobRuns,
  useBatchJobRun,
  useCreateBatchJob,
  usePauseBatchJob,
  useResumeBatchJob,
  useRunBatchJobNow,
  useDeleteBatchJob,
  useRetryBatchJobRun,
  useTerminateBatchJobRun,
  usePipelineTemplates,
  useConnections,
} from "@/lib/graphql/hooks";
import type { BatchJob, BatchJobRun, BatchJobBinding } from "@/lib/graphql/types";
import { formatLocal } from "@/lib/utils";
import { t } from "@/lib/i18n/messages";

/** BatchRunStatus values that are terminal (enums.py BATCH_TERMINAL_STATUSES). */
const TERMINAL = new Set(["succeeded", "failed", "cancelled"]);

/** `connectionBindings` is served as JSON (the backend stores V1's `connections`
 * blob), so it is narrowed here rather than trusted. A non-array means the
 * backend sent something this UI does not understand — report 0 rather than
 * crash the row. */
function bindingCount(v: unknown): number {
  return Array.isArray(v) ? v.length : 0;
}

/**
 * Batch jobs (BRD 73): a job pulls its bound sources, waits for every ingestion
 * to land, then runs the bound pipeline over exactly that batch. This page lists
 * the jobs and, per run, the `trigger → ingestion → pipeline` phase timeline
 * with the per-binding ingestion outcomes and the dataset URNs the run pinned.
 */
export default function BatchJobsPage() {
  const router = useRouter();
  const query = useBatchJobs();
  const jobs = useMemo(() => query.data?.pages.flatMap((p) => p.nodes) ?? [], [query.data]);

  const templatesQuery = usePipelineTemplates({});
  const templateName = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of templatesQuery.data?.pages ?? []) for (const tpl of p.nodes) m.set(tpl.id, tpl.name);
    return m;
  }, [templatesQuery.data]);

  const pauseMutation = usePauseBatchJob();
  const resumeMutation = useResumeBatchJob();
  const runNowMutation = useRunBatchJobNow();
  const deleteMutation = useDeleteBatchJob();

  const [banner, setBanner] = useState<string | null>(null);
  const [selectedJobId, setSelectedJobId] = useState("");
  const [toDelete, setToDelete] = useState<BatchJob | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const selectedJob = useMemo(
    () => jobs.find((j) => j.id === selectedJobId) ?? null,
    [jobs, selectedJobId],
  );
  const setSelectedJob = (j: BatchJob | null) => setSelectedJobId(j?.id ?? "");

  const columns: Column<BatchJob>[] = [
    { id: "name", header: t("pipelines.batchJobs.name"), cell: (j) => <span className="font-medium">{j.name}</span> },
    {
      id: "pipeline",
      header: t("pipelines.batchJobs.pipeline"),
      width: 200,
      cell: (j) =>
        templateName.get(j.pipelineTemplateId) ?? (
          <span className="font-mono text-xs">{j.pipelineTemplateId.slice(0, 8)}</span>
        ),
    },
    {
      id: "bindings",
      header: t("pipelines.batchJobs.bindings"),
      width: 110,
      cell: (j) => t("pipelines.batchJobs.bindingCount", { count: bindingCount(j.connectionBindings) }),
    },
    {
      id: "cadence",
      header: t("pipelines.batchJobs.cadence"),
      width: 170,
      cell: (j) =>
        j.cron ? (
          <span className="font-mono text-xs">
            {j.cron}
            {j.timezone && j.timezone !== "UTC" ? ` (${j.timezone})` : ""}
          </span>
        ) : (
          <span className="text-muted-foreground">{t("pipelines.batchJobs.manualOnly")}</span>
        ),
    },
    {
      id: "status",
      header: t("pipelines.batchJobs.status"),
      width: 110,
      cell: (j) => (
        <Badge variant={j.paused ? "secondary" : "success"}>
          {j.paused ? t("pipelines.batchJobs.paused") : t("pipelines.batchJobs.scheduled")}
        </Badge>
      ),
    },
    { id: "nextFire", header: t("pipelines.batchJobs.nextFire"), width: 160, cell: (j) => formatLocal(j.nextFireAt) },
    {
      id: "actions",
      header: t("pipelines.batchJobs.actions"),
      width: 320,
      cell: (j) => (
        <div className="flex justify-end gap-1" onClick={(e) => e.stopPropagation()}>
          <Button variant="ghost" size="sm" onClick={() => setSelectedJob(j)}>
            {t("pipelines.batchJobs.viewRuns")}
          </Button>
          <Can gate={FEATURE_GATES.executeBatchJob}>
            <Button
              variant="outline"
              size="sm"
              disabled={runNowMutation.isPending}
              onClick={() =>
                runNowMutation.mutate(j.id, {
                  onSuccess: () => {
                    setSelectedJob(j);
                    setBanner(t("pipelines.batchJobs.fired"));
                  },
                  onError: (e) => setBanner((e as Error).message),
                })
              }
            >
              {t("pipelines.batchJobs.runNow")}
            </Button>
          </Can>
          <Can gate={FEATURE_GATES.updateBatchJob}>
            {j.paused ? (
              <Button
                variant="ghost"
                size="sm"
                disabled={resumeMutation.isPending}
                onClick={() =>
                  resumeMutation.mutate(j.id, {
                    onSuccess: () => setBanner(t("pipelines.batchJobs.resumedNotice")),
                    onError: (e) => setBanner((e as Error).message),
                  })
                }
              >
                {t("pipelines.batchJobs.resume")}
              </Button>
            ) : (
              <Button
                variant="ghost"
                size="sm"
                disabled={pauseMutation.isPending}
                onClick={() =>
                  pauseMutation.mutate(j.id, {
                    onSuccess: () => setBanner(t("pipelines.batchJobs.pausedNotice")),
                    onError: (e) => setBanner((e as Error).message),
                  })
                }
              >
                {t("pipelines.batchJobs.pause")}
              </Button>
            )}
          </Can>
          <Can gate={FEATURE_GATES.deleteBatchJob}>
            <Button variant="ghost" size="sm" onClick={() => setToDelete(j)}>
              {t("pipelines.batchJobs.delete")}
            </Button>
          </Can>
        </div>
      ),
    },
  ];

  return (
    <div>
      <PageHeader
        title={t("pipelines.batchJobs.title")}
        description={t("pipelines.batchJobs.subtitle")}
        actions={
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={() => router.push("/data/pipelines")}>
              <ArrowLeft /> {t("pipelines.back")}
            </Button>
            <Can gate={FEATURE_GATES.createBatchJob}>
              <Button onClick={() => setFormOpen(true)}>
                <Plus /> {t("pipelines.batchJobs.new")}
              </Button>
            </Can>
          </div>
        }
      />

      {banner && (
        <div role="status" className="mb-3 rounded-md border bg-muted/40 px-3 py-2 text-sm" data-testid="notice-banner">
          {banner}
        </div>
      )}

      <AsyncBoundary
        isLoading={query.isLoading}
        isError={query.isError}
        error={query.error}
        isEmpty={jobs.length === 0}
        emptyTitle={t("pipelines.batchJobs.empty")}
        emptyHint={t("pipelines.batchJobs.emptyHint")}
        emptyCta={
          <Can gate={FEATURE_GATES.createBatchJob}>
            <Button variant="outline" size="sm" className="mt-2" onClick={() => setFormOpen(true)}>
              <Plus /> {t("pipelines.batchJobs.new")}
            </Button>
          </Can>
        }
        onRetry={() => query.refetch()}
      >
        <DataTable
          ariaLabel={t("pipelines.batchJobs.title")}
          rows={jobs}
          columns={columns}
          rowId={(j) => j.id}
          onRowActivate={(j) => setSelectedJob(j)}
          activeRowId={selectedJob?.id}
          hasMore={query.hasNextPage}
          isFetchingMore={query.isFetchingNextPage}
          onLoadMore={() => query.fetchNextPage()}
          emptyState={
            <div className="flex flex-col items-center gap-2 p-10 text-muted-foreground">
              <CalendarClock className="size-8" />
              <p>{t("pipelines.batchJobs.emptyHint")}</p>
            </div>
          }
        />
      </AsyncBoundary>

      {jobs.length > 0 && (
        <>
          {/* The jobs grid above is windowed, so this is also the keyboard- and
              screen-reader-reachable way to choose which job's runs to inspect. */}
          <label className="mt-6 flex items-center gap-2 text-sm">
            <span className="text-muted-foreground">{t("pipelines.batchJobs.pickJob")}</span>
            <select
              aria-label={t("pipelines.batchJobs.pickJob")}
              className="h-9 rounded-md border border-input bg-background px-2 text-sm"
              value={selectedJobId}
              onChange={(e) => setSelectedJobId(e.target.value)}
            >
              <option value="">{t("pipelines.batchJobs.pickJobPlaceholder")}</option>
              {jobs.map((j) => (
                <option key={j.id} value={j.id}>
                  {j.name}
                </option>
              ))}
            </select>
          </label>
          {selectedJob ? (
            <BatchJobRunsPanel job={selectedJob} onNotice={setBanner} />
          ) : (
            <p className="mt-3 text-sm text-muted-foreground">{t("pipelines.batchJobs.selectHint")}</p>
          )}
        </>
      )}

      <ConfirmDialog
        open={!!toDelete}
        onOpenChange={(o) => !o && setToDelete(null)}
        title={t("pipelines.batchJobs.delete")}
        description={t("pipelines.batchJobs.deleteConfirm")}
        confirmLabel={t("pipelines.batchJobs.delete")}
        destructive
        onConfirm={() => {
          if (toDelete)
            deleteMutation.mutate(toDelete.id, {
              onSuccess: () => {
                if (selectedJob?.id === toDelete.id) setSelectedJob(null);
                setBanner(t("pipelines.batchJobs.deletedNotice"));
              },
              onError: (e) => setBanner((e as Error).message),
              onSettled: () => setToDelete(null),
            });
        }}
      />

      <BatchJobDialog
        open={formOpen}
        onOpenChange={setFormOpen}
        onSaved={(msg) => {
          setFormOpen(false);
          setBanner(msg);
        }}
      />
    </div>
  );
}

/**
 * One job's run history with the selected run's phase timeline. Rendered as a
 * plain list (not the windowed DataTable) because the timeline lives inline
 * under the selected run rather than in a row cell.
 */
function BatchJobRunsPanel({ job, onNotice }: { job: BatchJob; onNotice: (m: string) => void }) {
  const query = useBatchJobRuns(job.id);
  const runs = useMemo(() => query.data?.pages.flatMap((p) => p.nodes) ?? [], [query.data]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);

  const retryMutation = useRetryBatchJobRun();
  const terminateMutation = useTerminateBatchJobRun();

  // Switching jobs must not leave the previous job's run selected.
  useEffect(() => setSelectedRunId(null), [job.id]);

  return (
    <section className="mt-6" data-testid="batch-runs-panel">
      <h3 className="mb-2 text-base font-semibold">{t("pipelines.batchRuns.title", { name: job.name })}</h3>
      <AsyncBoundary
        isLoading={query.isLoading}
        isError={query.isError}
        error={query.error}
        isEmpty={runs.length === 0}
        emptyTitle={t("pipelines.batchRuns.empty")}
        emptyHint={t("pipelines.batchRuns.emptyHint")}
        onRetry={() => query.refetch()}
      >
        <ul className="space-y-2">
          {runs.map((r) => (
            <li key={r.id} className="rounded-lg border" data-testid={`batch-run-${r.id}`}>
              <div className="flex flex-wrap items-center gap-3 px-3 py-2">
                <button
                  type="button"
                  className="text-sm font-medium underline-offset-2 hover:underline"
                  aria-expanded={selectedRunId === r.id}
                  onClick={() => setSelectedRunId(selectedRunId === r.id ? null : r.id)}
                >
                  {formatLocal(r.startedAt ?? r.createdAt)}
                </button>
                <span className="text-xs text-muted-foreground">
                  {t("pipelines.batchRuns.phase")}: {r.phase}
                </span>
                <StatusChip status={String(r.status).toUpperCase()} />
                <span className="text-xs text-muted-foreground">
                  {t("pipelines.batchRuns.trigger")}: {r.trigger}
                </span>
                <span className="ml-auto flex gap-1">
                  {String(r.status).toLowerCase() === "failed" && (
                    <Can gate={FEATURE_GATES.executeBatchJob}>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={retryMutation.isPending}
                        onClick={() =>
                          retryMutation.mutate(r.id, {
                            onSuccess: () => onNotice(t("pipelines.batchRuns.retriedNotice")),
                            onError: (e) => onNotice((e as Error).message),
                          })
                        }
                      >
                        {t("pipelines.batchRuns.retry")}
                      </Button>
                    </Can>
                  )}
                  {!TERMINAL.has(String(r.status).toLowerCase()) && (
                    <Can gate={FEATURE_GATES.executeBatchJob}>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={terminateMutation.isPending}
                        onClick={() =>
                          terminateMutation.mutate(r.id, {
                            onSuccess: () => onNotice(t("pipelines.batchRuns.terminatedNotice")),
                            onError: (e) => onNotice((e as Error).message),
                          })
                        }
                      >
                        {t("pipelines.batchRuns.terminate")}
                      </Button>
                    </Can>
                  )}
                </span>
              </div>
              {selectedRunId === r.id && <BatchRunDetail runId={r.id} />}
            </li>
          ))}
        </ul>
        {query.hasNextPage && (
          <Button
            variant="outline"
            size="sm"
            className="mt-2"
            disabled={query.isFetchingNextPage}
            onClick={() => query.fetchNextPage()}
          >
            {t("action.loadMore")}
          </Button>
        )}
      </AsyncBoundary>
    </section>
  );
}

/** The per-run detail read — the ONLY call that carries `ingestions`. A failed
 * read renders the error panel, never an empty timeline. */
function BatchRunDetail({ runId }: { runId: string }) {
  const query = useBatchJobRun(runId);
  const run: BatchJobRun | null | undefined = query.data;
  return (
    <div className="border-t px-3 py-3">
      <AsyncBoundary
        isLoading={query.isLoading}
        isError={query.isError || (!query.isLoading && run == null)}
        error={query.error}
        onRetry={() => query.refetch()}
      >
        {run && <BatchRunTimeline run={run} />}
      </AsyncBoundary>
    </div>
  );
}

/** Create form: name, the pipeline template to run, one or more source
 * connections to pull, and an optional cron cadence (empty = run on demand). */
function BatchJobDialog({
  open,
  onOpenChange,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onSaved: (msg: string) => void;
}) {
  const createMutation = useCreateBatchJob();
  const templatesQuery = usePipelineTemplates({});
  const connectionsQuery = useConnections({});
  const templates = useMemo(
    () => (templatesQuery.data?.pages.flatMap((p) => p.nodes) ?? []).filter((tpl) => !tpl.archived),
    [templatesQuery.data],
  );
  const connections = useMemo(
    () => connectionsQuery.data?.pages.flatMap((p) => p.nodes) ?? [],
    [connectionsQuery.data],
  );

  const [name, setName] = useState("");
  const [templateId, setTemplateId] = useState("");
  const [cron, setCron] = useState("");
  const [timezone, setTimezone] = useState("UTC");
  const [connectionIds, setConnectionIds] = useState<string[]>([""]);
  const [banner, setBanner] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setBanner(null);
    createMutation.reset();
    setName("");
    setTemplateId("");
    setCron("");
    setTimezone("UTC");
    setConnectionIds([""]);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reset only on open change
  }, [open]);

  const submit = () => {
    setBanner(null);
    if (!name.trim()) return setBanner(t("pipelines.batchJobs.nameRequired"));
    if (!templateId) return setBanner(t("pipelines.batchJobs.pipelineRequired"));
    const bindings: BatchJobBinding[] = connectionIds
      .filter((id) => id)
      .map((id) => ({ connectionId: id }));
    if (bindings.length === 0) return setBanner(t("pipelines.batchJobs.bindingRequired"));
    createMutation.mutate(
      {
        name: name.trim(),
        pipelineTemplateId: templateId,
        connectionBindings: bindings,
        cron: cron.trim() || null,
        timezone: timezone.trim() || undefined,
      },
      { onSuccess: () => onSaved(t("pipelines.batchJobs.createdNotice")) },
    );
  };

  const error = createMutation.error as Error | null;

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
        <Dialog.Content
          className="fixed left-1/2 top-1/2 z-50 max-h-[85vh] w-full max-w-lg -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-lg border bg-card p-5 shadow-lg focus:outline-none"
          aria-describedby={undefined}
        >
          <Dialog.Title className="text-lg font-semibold">{t("pipelines.batchJobs.new")}</Dialog.Title>
          <form
            className="mt-4 space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
          >
            <div className="space-y-1.5">
              <Label htmlFor="bj-name">{t("pipelines.batchJobs.name")}</Label>
              <Input id="bj-name" value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="bj-tpl">{t("pipelines.batchJobs.pipeline")}</Label>
              <select
                id="bj-tpl"
                className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                value={templateId}
                onChange={(e) => setTemplateId(e.target.value)}
              >
                <option value="">{t("pipelines.batchJobs.pickPipeline")}</option>
                {templates.map((tpl) => (
                  <option key={tpl.id} value={tpl.id}>
                    {tpl.name} ({tpl.pipelineType})
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label>{t("pipelines.batchJobs.bindings")}</Label>
              {connectionIds.map((cid, i) => (
                <div key={i} className="flex items-center gap-2">
                  <select
                    aria-label={`${t("pipelines.batchJobs.bindings")} ${i + 1}`}
                    className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                    value={cid}
                    onChange={(e) =>
                      setConnectionIds((prev) => prev.map((v, j) => (j === i ? e.target.value : v)))
                    }
                  >
                    <option value="">{t("pipelines.batchJobs.pickConnection")}</option>
                    {connections.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                  {connectionIds.length > 1 && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => setConnectionIds((prev) => prev.filter((_, j) => j !== i))}
                    >
                      {t("pipelines.batchJobs.removeBinding")}
                    </Button>
                  )}
                </div>
              ))}
              <Button type="button" variant="outline" size="sm" onClick={() => setConnectionIds((p) => [...p, ""])}>
                <Plus /> {t("pipelines.batchJobs.addBinding")}
              </Button>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="bj-cron">{t("pipelines.schedules.cron")}</Label>
              <Input
                id="bj-cron"
                value={cron}
                onChange={(e) => setCron(e.target.value)}
                placeholder={t("pipelines.schedules.cronPlaceholder")}
                className="font-mono"
              />
              <p className="text-xs text-muted-foreground">{t("pipelines.batchJobs.cronHint")}</p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="bj-tz">{t("pipelines.schedules.timezone")}</Label>
              <Input id="bj-tz" value={timezone} onChange={(e) => setTimezone(e.target.value)} />
            </div>
            {banner && <p className="text-xs text-destructive">{banner}</p>}
            {error && (
              <p role="alert" className="text-xs text-destructive" data-testid="mutation-error">
                {error.message}
              </p>
            )}
            <div className="flex justify-end gap-2 pt-1">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                {t("action.cancel")}
              </Button>
              <Button type="submit" disabled={createMutation.isPending}>
                {createMutation.isPending ? t("pipelines.batchJobs.creating") : t("pipelines.batchJobs.create")}
              </Button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
