"use client";
import { useMemo, useState } from "react";
import * as Tabs from "@radix-ui/react-tabs";
import {
  ArrowDownToLine, ArrowUpToLine, Database, GraduationCap, Layers, Plus, ShieldCheck,
} from "lucide-react";
import { PageHeader } from "@/components/shell/PageHeader";
import { AsyncBoundary } from "@/components/primitives/AsyncBoundary";
import { Button } from "@/components/ui/button";
import {
  Input, Label, Badge, Card, CardHeader, CardTitle, CardDescription, CardContent,
} from "@/components/ui/primitives";
import {
  useSftDatasets, useSftDataset, useSftDatasetExamples,
  useTrainingJobs, useTrainingJob, useSlmAdapters, useSlmAdapter,
  useCreateSftDataset, useSubmitTrainingJob, usePromoteSlmAdapter, useDemoteSlmAdapter,
} from "@/lib/graphql/hooks";
import type { SftExample, SlmAdapter, TrainingJob } from "@/lib/graphql/operations";
import { useCapabilities } from "@/lib/authz/useCapabilities";
import { FEATURE_GATES } from "@/lib/authz/registry";
import { formatLocal } from "@/lib/utils";

/**
 * SLM distillation cockpit (BRD 14 §6.5, PLATFORM_ARCHITECTURE §5 M2-M4): the
 * correction->retrain learning loop as a working surface, not just counters.
 * Curate the consented transcript corpus into versioned SFT datasets (M2),
 * submit LoRA distillation jobs against them (M3), and promote/demote the
 * distilled adapters onto the tenant's cheapest ladder rung, eval-gated (M4).
 * Failure reasons from agent-runtime (e.g. gpu_trainer_not_configured when no
 * GPU executor is wired) are rendered VERBATIM — never softened.
 */

/** Mirrors agent-runtime app/domain/archetypes.py KNOWN_BASE_MODELS — the
 * allowlisted open student bases; anything else fails closed downstream. */
const KNOWN_BASE_MODELS = [
  "meta-llama/Llama-3.2-1B-Instruct",
  "meta-llama/Llama-3.2-3B-Instruct",
  "Qwen/Qwen2.5-1.5B-Instruct",
  "Qwen/Qwen2.5-3B-Instruct",
  "microsoft/Phi-3.5-mini-instruct",
  "mistralai/Ministral-3B-Instruct",
];
const DEFAULT_BASE_MODEL = "meta-llama/Llama-3.2-3B-Instruct";

const selectClass =
  "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm";

function statusBadgeVariant(status: string | null | undefined): "default" | "secondary" | "outline" | "destructive" {
  switch (status) {
    case "failed":
    case "demoted":
      return "destructive";
    case "succeeded":
    case "promoted":
    case "ready":
      return "default";
    default:
      return "secondary";
  }
}

function contentText(content: unknown): string {
  return typeof content === "string" ? content : JSON.stringify(content, null, 2);
}

/** The honest downstream failure, verbatim (reason code + detail). */
function JobError({ error }: { error: TrainingJob["error"] }) {
  if (!error) return null;
  return (
    <div role="alert" className="space-y-1 rounded-md border border-destructive/40 bg-destructive/10 p-3">
      <p className="font-mono text-xs font-semibold text-destructive">{error.reason ?? "unknown_error"}</p>
      {error.detail && <p className="text-xs text-destructive">{error.detail}</p>}
    </div>
  );
}

// ============================ SFT datasets (M2) ==============================

/** One gold pair: the final assistant message is the human-corrected output;
 * everything before it is the input context. Derived from the roles verbatim —
 * an example with no assistant turn shows an honest gap. */
function ExampleCard({ example, index }: { example: SftExample; index: number }) {
  const messages = example.messages ?? [];
  let goldIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "assistant") { goldIdx = i; break; }
  }
  const inputs = goldIdx >= 0 ? messages.slice(0, goldIdx) : messages;
  const gold = goldIdx >= 0 ? messages[goldIdx] : null;
  return (
    <div className="space-y-2 rounded-md border p-3">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Example {index + 1}</p>
      {inputs.map((m, i) => (
        <div key={i} className="rounded-md bg-muted/50 p-2">
          <p className="text-xs font-medium text-muted-foreground">{m.role ?? "message"}</p>
          <pre className="whitespace-pre-wrap break-words font-mono text-xs">{contentText(m.content)}</pre>
        </div>
      ))}
      {gold ? (
        <div className="rounded-md border border-primary/40 bg-primary/5 p-2">
          <p className="text-xs font-medium text-primary">corrected output (gold)</p>
          <pre className="whitespace-pre-wrap break-words font-mono text-xs">{contentText(gold.content)}</pre>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">No assistant turn in this example.</p>
      )}
    </div>
  );
}

function DatasetDetail({ datasetId }: { datasetId: string }) {
  const q = useSftDataset(datasetId);
  const examples = useSftDatasetExamples(datasetId, 50);
  const d = q.data;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Database className="size-4 text-muted-foreground" />
          Dataset detail
        </CardTitle>
        {d && (
          <CardDescription>
            <code className="text-xs">{d.datasetId}</code>
          </CardDescription>
        )}
      </CardHeader>
      <CardContent className="space-y-4">
        <AsyncBoundary
          isLoading={q.isLoading}
          isError={q.isError}
          error={q.error}
          isEmpty={!q.isLoading && !d}
          emptyTitle="Dataset not found"
          onRetry={() => q.refetch()}
        >
          {d && (
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-3">
              <div><dt className="text-xs text-muted-foreground">Archetype</dt><dd className="font-mono text-xs">{d.agentKey ?? "—"}</dd></div>
              <div><dt className="text-xs text-muted-foreground">Version</dt><dd>v{d.version ?? "—"}</dd></div>
              <div><dt className="text-xs text-muted-foreground">Status</dt><dd><Badge variant={statusBadgeVariant(d.status)}>{d.status ?? "—"}</Badge></dd></div>
              <div><dt className="text-xs text-muted-foreground">Rows</dt><dd>{d.rowCount ?? "—"}</dd></div>
              <div><dt className="text-xs text-muted-foreground">Source transcripts</dt><dd>{d.sourceCount ?? "—"}</dd></div>
              <div><dt className="text-xs text-muted-foreground">Consent verified</dt><dd>{d.consentVerified == null ? "—" : d.consentVerified ? "yes" : "no"}</dd></div>
              <div className="col-span-2 sm:col-span-3"><dt className="text-xs text-muted-foreground">Checksum</dt><dd className="break-all font-mono text-xs">{d.checksum ?? "—"}</dd></div>
              <div><dt className="text-xs text-muted-foreground">Created by</dt><dd className="font-mono text-xs">{d.createdBy ?? "—"}</dd></div>
              <div><dt className="text-xs text-muted-foreground">Created</dt><dd>{formatLocal(d.createdAt)}</dd></div>
            </dl>
          )}
        </AsyncBoundary>

        <div>
          <p className="mb-2 text-sm font-medium">Gold examples (input → corrected output)</p>
          <AsyncBoundary
            isLoading={examples.isLoading}
            isError={examples.isError}
            error={examples.error}
            isEmpty={(examples.data ?? []).length === 0}
            emptyTitle="No frozen examples in this dataset"
            onRetry={() => examples.refetch()}
          >
            <div className="max-h-96 space-y-3 overflow-y-auto pr-1">
              {(examples.data ?? []).map((ex, i) => (
                <ExampleCard key={i} example={ex} index={i} />
              ))}
            </div>
          </AsyncBoundary>
        </div>
      </CardContent>
    </Card>
  );
}

function DatasetsPanel({ canCurate }: { canCurate: boolean }) {
  const q = useSftDatasets();
  const create = useCreateSftDataset();
  const datasets = q.data ?? [];
  const [selected, setSelected] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [agentKey, setAgentKey] = useState("");
  const [err, setErr] = useState<string | null>(null);

  const curate = async () => {
    setErr(null);
    const key = agentKey.trim();
    if (!key) { setErr("Archetype (agent key) is required."); return; }
    try {
      const ds = await create.mutateAsync({ agentKey: key });
      setAgentKey("");
      setFormOpen(false);
      setSelected(ds.datasetId);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to curate dataset.");
    }
  };

  return (
    <div className="space-y-4">
      {canCurate && (
        <div>
          <Button size="sm" onClick={() => setFormOpen((v) => !v)}>
            <Plus className="size-4" /> Curate new dataset
          </Button>
        </div>
      )}
      {formOpen && canCurate && (
        <Card>
          <CardContent className="space-y-3 pt-6">
            <div className="space-y-1">
              <Label htmlFor="sft-agent-key">Archetype (agent key)</Label>
              <Input
                id="sft-agent-key"
                value={agentKey}
                placeholder="case-triage"
                onChange={(e) => setAgentKey(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Freezes the consented, human-decided transcripts for this archetype into a new
                immutable, versioned SFT dataset.
              </p>
            </div>
            {err && <p role="alert" className="text-sm text-destructive">{err}</p>}
            <div className="flex gap-2">
              <Button size="sm" onClick={curate} disabled={create.isPending}>
                {create.isPending ? "Curating…" : "Curate dataset"}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => { setFormOpen(false); setErr(null); }}>
                Cancel
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <AsyncBoundary
        isLoading={q.isLoading}
        isError={q.isError}
        error={q.error}
        isEmpty={datasets.length === 0}
        emptyTitle="No SFT datasets yet"
        emptyHint="Curate one from the decided transcript corpus above."
        onRetry={() => q.refetch()}
      >
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
          {datasets.map((d) => (
            <button
              key={d.datasetId}
              type="button"
              onClick={() => setSelected((s) => (s === d.datasetId ? null : d.datasetId))}
              className={`rounded-lg border p-3 text-left transition-colors hover:bg-muted/50 ${selected === d.datasetId ? "border-primary" : ""}`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="truncate font-mono text-xs">{d.agentKey ?? "—"}</span>
                <Badge variant={statusBadgeVariant(d.status)}>{d.status ?? "—"}</Badge>
              </div>
              <p className="mt-1 text-sm">
                v{d.version ?? "—"} · {d.rowCount ?? 0} rows
              </p>
              <p className="text-xs text-muted-foreground">{formatLocal(d.createdAt)}</p>
            </button>
          ))}
        </div>
      </AsyncBoundary>

      {selected && <DatasetDetail datasetId={selected} />}
    </div>
  );
}

// ============================ training jobs (M3) =============================

function JobDetail({ jobId }: { jobId: string }) {
  const q = useTrainingJob(jobId);
  const j = q.data;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Layers className="size-4 text-muted-foreground" />
          Job detail
        </CardTitle>
        {j && <CardDescription><code className="text-xs">{j.jobId}</code></CardDescription>}
      </CardHeader>
      <CardContent className="space-y-3">
        <AsyncBoundary
          isLoading={q.isLoading}
          isError={q.isError}
          error={q.error}
          isEmpty={!q.isLoading && !j}
          emptyTitle="Training job not found"
          onRetry={() => q.refetch()}
        >
          {j && (
            <>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-3">
                <div><dt className="text-xs text-muted-foreground">Archetype</dt><dd className="font-mono text-xs">{j.archetype ?? "—"}</dd></div>
                <div><dt className="text-xs text-muted-foreground">Status</dt><dd><Badge variant={statusBadgeVariant(j.status)}>{j.status ?? "—"}</Badge></dd></div>
                <div><dt className="text-xs text-muted-foreground">SFT dataset</dt><dd className="break-all font-mono text-xs">{j.sftDatasetId ?? "—"}</dd></div>
                <div className="col-span-2 sm:col-span-3"><dt className="text-xs text-muted-foreground">Student base model</dt><dd className="font-mono text-xs">{j.baseModel ?? "—"}</dd></div>
                <div><dt className="text-xs text-muted-foreground">MLflow run</dt><dd className="break-all font-mono text-xs">{j.mlflowRunRef ?? "—"}</dd></div>
                <div><dt className="text-xs text-muted-foreground">Adapter</dt><dd className="break-all font-mono text-xs">{j.adapterId ?? "—"}</dd></div>
                <div><dt className="text-xs text-muted-foreground">Submitted</dt><dd>{formatLocal(j.createdAt)}</dd></div>
                <div><dt className="text-xs text-muted-foreground">Finished</dt><dd>{formatLocal(j.finishedAt)}</dd></div>
              </dl>
              <JobError error={j.error} />
            </>
          )}
        </AsyncBoundary>
      </CardContent>
    </Card>
  );
}

function JobsPanel({ canSubmit }: { canSubmit: boolean }) {
  const q = useTrainingJobs();
  const datasetsQ = useSftDatasets();
  const submit = useSubmitTrainingJob();
  const jobs = q.data ?? [];
  const datasets = datasetsQ.data ?? [];
  const [selected, setSelected] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [datasetId, setDatasetId] = useState("");
  const [baseModel, setBaseModel] = useState(DEFAULT_BASE_MODEL);
  const [err, setErr] = useState<string | null>(null);

  const submitJob = async () => {
    setErr(null);
    const ds = datasets.find((d) => d.datasetId === datasetId);
    if (!ds) { setErr("Pick an SFT dataset to distill against."); return; }
    if (!ds.agentKey) { setErr("The chosen dataset has no archetype key."); return; }
    try {
      const job = await submit.mutateAsync({
        agentKey: ds.agentKey,
        sftDatasetId: ds.datasetId,
        baseModel,
      });
      setFormOpen(false);
      setSelected(job.jobId);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to submit training job.");
    }
  };

  return (
    <div className="space-y-4">
      {canSubmit && (
        <div>
          <Button size="sm" onClick={() => setFormOpen((v) => !v)}>
            <Plus className="size-4" /> Submit distillation run
          </Button>
        </div>
      )}
      {formOpen && canSubmit && (
        <Card>
          <CardContent className="space-y-3 pt-6">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="job-dataset">SFT dataset</Label>
                <select
                  id="job-dataset"
                  className={selectClass}
                  value={datasetId}
                  onChange={(e) => setDatasetId(e.target.value)}
                >
                  <option value="">Pick a dataset…</option>
                  {datasets.map((d) => (
                    <option key={d.datasetId} value={d.datasetId}>
                      {d.agentKey ?? "—"} v{d.version ?? "—"} ({d.rowCount ?? 0} rows)
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="job-base">Student base model</Label>
                <select
                  id="job-base"
                  className={selectClass}
                  value={baseModel}
                  onChange={(e) => setBaseModel(e.target.value)}
                >
                  {KNOWN_BASE_MODELS.map((m) => <option key={m} value={m}>{m}</option>)}
                </select>
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              LoRA-distills the archetype onto the chosen open student base. Without a GPU
              executor wired, the job records an honest failure (gpu_trainer_not_configured)
              instead of a fabricated adapter.
            </p>
            {err && <p role="alert" className="text-sm text-destructive">{err}</p>}
            <div className="flex gap-2">
              <Button size="sm" onClick={submitJob} disabled={submit.isPending}>
                {submit.isPending ? "Submitting…" : "Submit run"}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => { setFormOpen(false); setErr(null); }}>
                Cancel
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <AsyncBoundary
        isLoading={q.isLoading}
        isError={q.isError}
        error={q.error}
        isEmpty={jobs.length === 0}
        emptyTitle="No training jobs yet"
        emptyHint="Submit a distillation run against a curated SFT dataset."
        onRetry={() => q.refetch()}
      >
        <div className="space-y-2">
          {jobs.map((j) => (
            <button
              key={j.jobId}
              type="button"
              onClick={() => setSelected((s) => (s === j.jobId ? null : j.jobId))}
              className={`flex w-full items-center justify-between gap-3 rounded-lg border p-3 text-left transition-colors hover:bg-muted/50 ${selected === j.jobId ? "border-primary" : ""}`}
            >
              <div className="min-w-0">
                <p className="truncate font-mono text-xs">{j.archetype ?? "—"} · {j.jobId}</p>
                <p className="text-xs text-muted-foreground">
                  {j.baseModel ?? "—"} · {formatLocal(j.createdAt)}
                </p>
                {j.error?.reason && (
                  <p className="truncate font-mono text-xs text-destructive">{j.error.reason}</p>
                )}
              </div>
              <Badge variant={statusBadgeVariant(j.status)}>{j.status ?? "—"}</Badge>
            </button>
          ))}
        </div>
      </AsyncBoundary>

      {selected && <JobDetail jobId={selected} />}
    </div>
  );
}

// ============================ adapters (M4) ==================================

function AdapterDetail({
  adapterId, canPromote, canDemote,
}: { adapterId: string; canPromote: boolean; canDemote: boolean }) {
  const q = useSlmAdapter(adapterId);
  const promote = usePromoteSlmAdapter();
  const demote = useDemoteSlmAdapter();
  const [evalRef, setEvalRef] = useState("");
  const [confirming, setConfirming] = useState<"promote" | "demote" | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const a = q.data;

  const doPromote = async () => {
    setErr(null);
    try {
      await promote.mutateAsync({ id: adapterId, evalResultRef: evalRef.trim() || undefined });
      setConfirming(null);
      setEvalRef("");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Promotion failed.");
      setConfirming(null);
    }
  };
  const doDemote = async () => {
    setErr(null);
    try {
      await demote.mutateAsync({ id: adapterId });
      setConfirming(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Demotion failed.");
      setConfirming(null);
    }
  };

  const promotable = a?.promotionStatus === "candidate" || a?.promotionStatus === "gated";
  const demotable = a?.promotionStatus === "promoted";

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <ShieldCheck className="size-4 text-muted-foreground" />
          Adapter detail
        </CardTitle>
        {a && <CardDescription><code className="text-xs">{a.adapterId}</code></CardDescription>}
      </CardHeader>
      <CardContent className="space-y-3">
        <AsyncBoundary
          isLoading={q.isLoading}
          isError={q.isError}
          error={q.error}
          isEmpty={!q.isLoading && !a}
          emptyTitle="Adapter not found"
          onRetry={() => q.refetch()}
        >
          {a && (
            <>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-3">
                <div><dt className="text-xs text-muted-foreground">Archetype</dt><dd className="font-mono text-xs">{a.archetype ?? "—"}</dd></div>
                <div><dt className="text-xs text-muted-foreground">Status</dt><dd><Badge variant={statusBadgeVariant(a.promotionStatus)}>{a.promotionStatus ?? "—"}</Badge></dd></div>
                <div><dt className="text-xs text-muted-foreground">Ladder alias</dt><dd className="font-mono text-xs">{a.modelAlias ?? "—"}</dd></div>
                <div className="col-span-2 sm:col-span-3"><dt className="text-xs text-muted-foreground">Base model</dt><dd className="font-mono text-xs">{a.baseModel ?? "—"}</dd></div>
                <div className="col-span-2 sm:col-span-3"><dt className="text-xs text-muted-foreground">Artifact</dt><dd className="break-all font-mono text-xs">{a.adapterUri ?? "— (no trained artifact)"}</dd></div>
                <div><dt className="text-xs text-muted-foreground">Training job</dt><dd className="break-all font-mono text-xs">{a.trainingJobId ?? "—"}</dd></div>
                <div><dt className="text-xs text-muted-foreground">Created</dt><dd>{formatLocal(a.createdAt)}</dd></div>
              </dl>

              <div className="rounded-md bg-muted/50 p-3">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Eval-gate evidence
                </p>
                {a.evalResultRef ? (
                  <p className="mt-1 break-all font-mono text-xs">
                    {a.evalResultRef}
                    {a.targetRungAlias && (
                      <span className="ml-2 text-muted-foreground">→ serving as {a.targetRungAlias}</span>
                    )}
                  </p>
                ) : (
                  <p className="mt-1 text-xs text-muted-foreground">
                    No eval-gate result recorded for this adapter yet.
                  </p>
                )}
              </div>

              {err && <p role="alert" className="text-sm text-destructive">{err}</p>}

              {canPromote && promotable && (
                <div className="space-y-2">
                  <div className="space-y-1">
                    <Label htmlFor="adapter-eval-ref">Eval-gate result ref (evidence)</Label>
                    <Input
                      id="adapter-eval-ref"
                      value={evalRef}
                      placeholder="eval gate/run id that cleared this adapter"
                      onChange={(e) => setEvalRef(e.target.value)}
                    />
                  </div>
                  {confirming === "promote" ? (
                    <div className="flex items-center gap-2">
                      <p className="text-sm">Promote to the tenant&apos;s cheapest ladder rung?</p>
                      <Button size="sm" onClick={doPromote} disabled={promote.isPending}>
                        {promote.isPending ? "Promoting…" : "Confirm promote"}
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setConfirming(null)}>Cancel</Button>
                    </div>
                  ) : (
                    <Button size="sm" onClick={() => setConfirming("promote")}>
                      <ArrowUpToLine className="size-4" /> Promote
                    </Button>
                  )}
                </div>
              )}

              {canDemote && demotable && (
                confirming === "demote" ? (
                  <div className="flex items-center gap-2">
                    <p className="text-sm">Roll this adapter back off the ladder rung?</p>
                    <Button size="sm" variant="destructive" onClick={doDemote} disabled={demote.isPending}>
                      {demote.isPending ? "Demoting…" : "Confirm demote"}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setConfirming(null)}>Cancel</Button>
                  </div>
                ) : (
                  <Button size="sm" variant="outline" onClick={() => setConfirming("demote")}>
                    <ArrowDownToLine className="size-4" /> Demote (rollback)
                  </Button>
                )
              )}
            </>
          )}
        </AsyncBoundary>
      </CardContent>
    </Card>
  );
}

function AdaptersPanel({ canPromote, canDemote }: { canPromote: boolean; canDemote: boolean }) {
  const q = useSlmAdapters();
  const adapters = q.data ?? [];
  const [selected, setSelected] = useState<string | null>(null);

  return (
    <div className="space-y-4">
      <AsyncBoundary
        isLoading={q.isLoading}
        isError={q.isError}
        error={q.error}
        isEmpty={adapters.length === 0}
        emptyTitle="No distilled adapters yet"
        emptyHint="A SUCCEEDED training job produces an adapter candidate here. Without a GPU trainer wired, jobs fail honestly and no adapter is fabricated."
        onRetry={() => q.refetch()}
      >
        <div className="space-y-2">
          {adapters.map((a: SlmAdapter) => (
            <button
              key={a.adapterId}
              type="button"
              onClick={() => setSelected((s) => (s === a.adapterId ? null : a.adapterId))}
              className={`flex w-full items-center justify-between gap-3 rounded-lg border p-3 text-left transition-colors hover:bg-muted/50 ${selected === a.adapterId ? "border-primary" : ""}`}
            >
              <div className="min-w-0">
                <p className="truncate font-mono text-xs">{a.archetype ?? "—"} · {a.modelAlias ?? a.adapterId}</p>
                <p className="truncate text-xs text-muted-foreground">{a.baseModel ?? "—"} · {formatLocal(a.createdAt)}</p>
              </div>
              <Badge variant={statusBadgeVariant(a.promotionStatus)}>{a.promotionStatus ?? "—"}</Badge>
            </button>
          ))}
        </div>
      </AsyncBoundary>

      {selected && (
        <AdapterDetail adapterId={selected} canPromote={canPromote} canDemote={canDemote} />
      )}
    </div>
  );
}

// ============================ page ===========================================

export default function DistillationPage() {
  const { can } = useCapabilities();
  const canCurate = can(FEATURE_GATES.curateSftDataset);
  const canSubmit = can(FEATURE_GATES.submitTrainingJob);
  const canPromote = can(FEATURE_GATES.promoteSlmAdapter);
  const canDemote = can(FEATURE_GATES.demoteSlmAdapter);

  const tabs = useMemo(
    () => [
      { value: "datasets", label: "SFT datasets" },
      { value: "jobs", label: "Training jobs" },
      { value: "adapters", label: "Adapters" },
    ],
    [],
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title="SLM distillation"
        description="The correction→retrain learning loop: curate approved/corrected transcripts into versioned SFT datasets, distill them onto small open student models (LoRA), and promote eval-gated adapters onto the tenant's cheapest model-ladder rung."
        actions={<GraduationCap className="size-5 text-muted-foreground" aria-hidden />}
      />

      <Tabs.Root defaultValue="datasets">
        <Tabs.List className="mb-3 flex gap-1 border-b" aria-label="Distillation sections">
          {tabs.map((t) => (
            <Tabs.Trigger
              key={t.value}
              value={t.value}
              className="border-b-2 border-transparent px-3 py-2 text-sm font-medium text-muted-foreground data-[state=active]:border-primary data-[state=active]:text-foreground"
            >
              {t.label}
            </Tabs.Trigger>
          ))}
        </Tabs.List>
        <Tabs.Content value="datasets">
          <DatasetsPanel canCurate={canCurate} />
        </Tabs.Content>
        <Tabs.Content value="jobs">
          <JobsPanel canSubmit={canSubmit} />
        </Tabs.Content>
        <Tabs.Content value="adapters">
          <AdaptersPanel canPromote={canPromote} canDemote={canDemote} />
        </Tabs.Content>
      </Tabs.Root>
    </div>
  );
}
