"use client";
import { AlertTriangle } from "lucide-react";
import { Badge } from "@/components/ui/primitives";
import { StatusChip } from "@/components/primitives/StatusChip";
import type { BatchJobRun, BatchJobRunIngestion } from "@/lib/graphql/types";
import { formatLocal } from "@/lib/utils";
import { t } from "@/lib/i18n/messages";

/** The three phases a batch job run advances through, in order
 * (pipeline-orchestrator enums.py `BatchPhase`). The ordering is load-bearing:
 * `pipeline` is only entered once every ingestion fired in `trigger` is
 * terminal, which is what stops a run scoring the PREVIOUS batch. */
export const BATCH_PHASES = ["trigger", "ingestion", "pipeline"] as const;
export type BatchPhase = (typeof BATCH_PHASES)[number];

export type PhaseState =
  | "succeeded"
  | "running"
  | "pending"
  | "failed"
  | "cancelled"
  | "not_reached";

/**
 * Derive each phase's state from the run's `phase` + `status`.
 *
 * The backend records exactly two things — where the run IS (`phase`) and how
 * it is doing there (`status`) — so per-phase state is a projection of that
 * pair, not extra data: phases before the current one completed (the machine
 * cannot advance otherwise), the current one carries the run's status, and
 * later ones were never reached.
 *
 * Returns null for a phase name the enum does not contain: the run cannot be
 * placed on the timeline, and guessing a position would misreport where it is.
 */
export function phaseStates(
  phase: string,
  status: string,
): Record<BatchPhase, PhaseState> | null {
  const idx = (BATCH_PHASES as readonly string[]).indexOf(String(phase).toLowerCase());
  if (idx < 0) return null;
  const s = String(status).toLowerCase();
  const at: PhaseState =
    s === "succeeded" ? "succeeded"
    : s === "failed" ? "failed"
    : s === "cancelled" ? "cancelled"
    : s === "pending" ? "pending"
    : "running";
  const out = {} as Record<BatchPhase, PhaseState>;
  BATCH_PHASES.forEach((p, i) => {
    // A run that SUCCEEDED cleared every phase, including the ones after the
    // one it finished in (it finishes in `pipeline`, but be explicit).
    if (s === "succeeded") out[p] = "succeeded";
    else if (i < idx) out[p] = "succeeded";
    else if (i === idx) out[p] = at;
    else out[p] = "not_reached";
  });
  return out;
}

const PHASE_LABEL: Record<BatchPhase, string> = {
  trigger: t("pipelines.batchRuns.phaseTrigger"),
  ingestion: t("pipelines.batchRuns.phaseIngestion"),
  pipeline: t("pipelines.batchRuns.phasePipeline"),
};

const PHASE_HINT: Record<BatchPhase, string> = {
  trigger: t("pipelines.batchRuns.phaseTriggerHint"),
  ingestion: t("pipelines.batchRuns.phaseIngestionHint"),
  pipeline: t("pipelines.batchRuns.phasePipelineHint"),
};

function PhaseStateChip({ state }: { state: PhaseState }) {
  if (state === "not_reached") {
    return <Badge variant="secondary">{t("pipelines.batchRuns.phaseNotReached")}</Badge>;
  }
  return <StatusChip status={state.toUpperCase()} />;
}

/**
 * The AC-9 UI half: a run's `trigger → ingestion → pipeline` timeline with each
 * phase's state, the per-binding ingestion outcomes, and the input/output
 * dataset URNs the run recorded.
 *
 * `run.ingestions` is null ONLY when the payload never carried the key (the
 * runs LIST does not serialize it) — that is rendered as an explicit
 * "not returned" note rather than as an empty timeline, because a run with two
 * bindings and a run with none must never look the same.
 */
export function BatchRunTimeline({ run }: { run: BatchJobRun }) {
  const states = phaseStates(run.phase, run.status);

  return (
    <div className="space-y-4" data-testid="batch-run-timeline">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span>
          {t("pipelines.batchRuns.batchKey")}: <span className="font-mono">{run.batchKey}</span>
        </span>
        {run.pipelineRunId && (
          <span>
            {t("pipelines.batchRuns.pipelineRun")}:{" "}
            <span className="font-mono">{run.pipelineRunId}</span>
          </span>
        )}
        {run.retriedFromRunId && (
          <span>
            {t("pipelines.batchRuns.retriedFrom")}:{" "}
            <span className="font-mono">{run.retriedFromRunId}</span>
          </span>
        )}
        {run.phaseDeadlineAt && (
          <span>
            {t("pipelines.batchRuns.deadline")}: {formatLocal(run.phaseDeadlineAt)}
          </span>
        )}
      </div>

      <section>
        <h4 className="mb-2 text-sm font-medium">{t("pipelines.batchRuns.timelineTitle")}</h4>
        {states ? (
          <ol className="space-y-1.5">
            {BATCH_PHASES.map((p, i) => (
              <li
                key={p}
                className="flex items-center gap-3 rounded-md border px-3 py-2"
                data-testid={`batch-phase-${p}`}
              >
                <span className="w-5 text-xs text-muted-foreground">{i + 1}</span>
                <span className="w-24 text-sm font-medium">{PHASE_LABEL[p]}</span>
                <PhaseStateChip state={states[p]} />
                <span className="text-xs text-muted-foreground">{PHASE_HINT[p]}</span>
              </li>
            ))}
          </ol>
        ) : (
          // An unrecognised phase name: say so rather than draw a timeline that
          // puts the run somewhere it is not.
          <p role="alert" className="text-sm text-destructive">
            {t("pipelines.batchRuns.detailError")}
          </p>
        )}
      </section>

      {run.error != null && (
        <section>
          <h4 className="mb-1 text-sm font-medium">{t("pipelines.batchRuns.error")}</h4>
          <pre
            className="max-h-40 overflow-auto rounded-md bg-muted/40 p-3 font-mono text-xs"
            data-testid="batch-run-error"
          >
            {JSON.stringify(run.error, null, 2)}
          </pre>
        </section>
      )}

      <section>
        <h4 className="mb-2 text-sm font-medium">{t("pipelines.batchRuns.bindingsTitle")}</h4>
        {run.ingestions == null ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <AlertTriangle className="size-4" aria-hidden />
            {t("pipelines.batchRuns.timelineUnavailable")}
          </p>
        ) : run.ingestions.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("pipelines.batchRuns.noBindings")}</p>
        ) : (
          <ul className="space-y-1.5">
            {run.ingestions.map((ing) => (
              <BindingRow key={ing.bindingKey} ingestion={ing} />
            ))}
          </ul>
        )}
      </section>

      <div className="grid gap-4 sm:grid-cols-2">
        <UrnList label={t("pipelines.batchRuns.inputs")} urns={run.inputDatasetUrns} testId="batch-run-inputs" />
        <UrnList label={t("pipelines.batchRuns.outputs")} urns={run.outputDatasetUrns} testId="batch-run-outputs" />
      </div>
    </div>
  );
}

function BindingRow({ ingestion }: { ingestion: BatchJobRunIngestion }) {
  return (
    <li className="rounded-md border px-3 py-2" data-testid={`batch-binding-${ingestion.bindingKey}`}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="text-sm font-medium">
          {t("pipelines.batchRuns.bindingKey")} {ingestion.bindingKey}
        </span>
        <StatusChip status={ingestion.status.toUpperCase()} />
        {ingestion.ingestionId && (
          <span className="text-xs text-muted-foreground">
            {t("pipelines.batchRuns.ingestionId")}:{" "}
            <span className="font-mono">{ingestion.ingestionId}</span>
          </span>
        )}
      </div>
      <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {ingestion.datasetVersionUrn && (
          <span>
            {t("pipelines.batchRuns.datasetVersion")}:{" "}
            <span className="font-mono">{ingestion.datasetVersionUrn}</span>
          </span>
        )}
        {ingestion.icebergSnapshotId && (
          <span>
            {t("pipelines.batchRuns.snapshot")}:{" "}
            <span className="font-mono">{ingestion.icebergSnapshotId}</span>
          </span>
        )}
      </div>
      {ingestion.error != null && (
        <pre className="mt-1 max-h-24 overflow-auto rounded-md bg-muted/40 p-2 font-mono text-xs">
          {JSON.stringify(ingestion.error, null, 2)}
        </pre>
      )}
    </li>
  );
}

function UrnList({ label, urns, testId }: { label: string; urns: string[]; testId: string }) {
  return (
    <section data-testid={testId}>
      <h4 className="mb-1 text-sm font-medium">{label}</h4>
      {urns.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t("pipelines.batchRuns.noUrns")}</p>
      ) : (
        <ul className="space-y-0.5">
          {urns.map((u) => (
            <li key={u} className="break-all font-mono text-xs">
              {u}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
