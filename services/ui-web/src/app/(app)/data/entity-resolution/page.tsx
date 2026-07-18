"use client";
import { useMemo, useState } from "react";
import { PageHeader } from "@/components/shell/PageHeader";
import { AsyncBoundary } from "@/components/primitives/AsyncBoundary";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/primitives";
import { EntityResolutionRunCard } from "@/components/data/EntityResolutionRunCard";
import {
  useDatasets, useDatasetSchema, useResolutionRuns, useResolveEntities,
} from "@/lib/graphql/hooks";
import { useCapabilities } from "@/lib/authz/useCapabilities";
import { FEATURE_GATES } from "@/lib/authz/registry";
import { GraphQLRequestError } from "@/lib/graphql/client";
import type { Dataset, ResolveEntitiesResult, ScoringFieldInput } from "@/lib/graphql/types";

/**
 * Entity Resolution steward surface (BRD 56). A data steward runs first-party
 * resolution over a dataset (deterministic keys + probabilistic scoring),
 * reviews below-auto merge candidates and confirms them through the same
 * governed four-eyes proposal every write uses, browses the resolved-entity
 * view with member lineage, and materializes the golden-record dataset. The
 * source of record is NEVER mutated — resolution is a link/view layer.
 */
export default function EntityResolutionPage() {
  const { can } = useCapabilities();
  const canRun = can(FEATURE_GATES.runEntityResolution);
  const canPropose = can(FEATURE_GATES.proposeEntityMerge);

  const datasetsQ = useDatasets();
  const datasets = useMemo<Dataset[]>(
    () => (datasetsQ.data?.pages ?? []).flatMap((p) => p.nodes),
    [datasetsQ.data],
  );

  const [datasetId, setDatasetId] = useState("");
  const schema = useDatasetSchema(datasetId, undefined, { enabled: !!datasetId });
  const columns = useMemo(() => (schema.data ?? []).map((c) => c.name), [schema.data]);

  const runs = useResolutionRuns(datasetId, !!datasetId);

  return (
    <div>
      <PageHeader
        title="Entity Resolution"
        description="Resolve records that refer to the same real-world entity across a dataset, review merges under four-eyes governance, and publish a governed golden-record dataset. Resolution links records — it never edits the source of record."
      />

      <div className="mb-4 rounded-lg border p-4" data-testid="er-run-form">
        <div className="mb-3">
          <Label htmlFor="er-dataset">Dataset</Label>
          <select id="er-dataset"
            className="mt-1 block h-9 w-full max-w-md rounded-md border border-input bg-background px-2 text-sm"
            value={datasetId}
            onChange={(e) => setDatasetId(e.target.value)}>
            <option value="">Select a dataset…</option>
            {datasets.map((d) => (
              <option key={d.id} value={d.id}>{d.name}</option>
            ))}
          </select>
        </div>

        {datasetId && canRun && (
          <ResolveForm datasetId={datasetId} columns={columns}
            onDone={() => runs.refetch()} />
        )}
        {datasetId && !canRun && (
          <p className="text-xs text-muted-foreground">
            You can review existing runs; running a new resolution needs the execute capability.
          </p>
        )}
      </div>

      {datasetId && (
        <AsyncBoundary
          isLoading={runs.isLoading}
          isError={runs.isError}
          error={runs.error}
          isEmpty={!runs.isLoading && (runs.data ?? []).length === 0}
          emptyTitle="No resolution runs yet for this dataset."
          onRetry={() => runs.refetch()}
        >
          <div className="flex flex-col gap-3">
            {(runs.data ?? []).map((r) => (
              <EntityResolutionRunCard key={r.runId} run={r} columns={columns}
                canPropose={canPropose} canRun={canRun} />
            ))}
          </div>
        </AsyncBoundary>
      )}
    </div>
  );
}

// ---- the resolution config form ---------------------------------------------

function ResolveForm({ datasetId, columns, onDone }:
  { datasetId: string; columns: string[]; onDone: () => void }) {
  const resolve = useResolveEntities();
  const [entityType, setEntityType] = useState("entity");
  const [pkColumn, setPkColumn] = useState("");
  const [detKeys, setDetKeys] = useState<string[]>([""]); // each = comma-separated columns
  const [scoring, setScoring] = useState<{ column: string; weight: string }[]>([]);
  const [blocking, setBlocking] = useState("");
  const [autoThr, setAutoThr] = useState("0.85");
  const [reviewThr, setReviewThr] = useState("0.60");
  const [result, setResult] = useState<ResolveEntitiesResult | null>(null);
  const err = resolve.error instanceof GraphQLRequestError ? resolve.error : null;

  const parsedDetKeys = detKeys
    .map((k) => k.split(",").map((c) => c.trim()).filter(Boolean))
    .filter((k) => k.length > 0);
  const parsedScoring: ScoringFieldInput[] = scoring
    .filter((s) => s.column.trim())
    .map((s) => ({ column: s.column.trim(), weight: Number(s.weight) || 1.0 }));
  const parsedBlocking = blocking.split(",").map((c) => c.trim()).filter(Boolean);
  const canSubmit = !!pkColumn.trim() && (parsedDetKeys.length > 0 || parsedScoring.length > 0);

  const submit = () =>
    resolve.mutate(
      {
        datasetId,
        input: {
          pkColumn: pkColumn.trim(),
          config: {
            entityType: entityType.trim() || "entity",
            deterministicKeys: parsedDetKeys,
            scoringFields: parsedScoring,
            blockingFields: parsedBlocking,
            autoMergeThreshold: Number(autoThr) || 0.85,
            reviewThreshold: Number(reviewThr) || 0.6,
          },
        },
      },
      { onSuccess: (r) => { setResult(r); onDone(); } },
    );

  const colHint = columns.length ? `e.g. ${columns.slice(0, 3).join(", ")}` : "column names";

  return (
    <div className="flex flex-col gap-3 border-t pt-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <Label htmlFor="er-entity-type">Entity type</Label>
          <Input id="er-entity-type" value={entityType}
            onChange={(e) => setEntityType(e.target.value)} placeholder="claimant" />
        </div>
        <div>
          <Label htmlFor="er-pk">Primary key column</Label>
          <ColumnSelect id="er-pk" columns={columns} value={pkColumn} onChange={setPkColumn}
            placeholder="claim_id" />
        </div>
      </div>

      <div>
        <Label>Deterministic keys — records sharing an exact key always merge</Label>
        {detKeys.map((k, i) => (
          <div key={i} className="mt-1 flex items-center gap-2">
            <Input value={k} className="max-w-md"
              placeholder={colHint}
              onChange={(e) => setDetKeys((xs) => xs.map((x, j) => j === i ? e.target.value : x))} />
            {detKeys.length > 1 && (
              <button className="text-xs text-muted-foreground"
                onClick={() => setDetKeys((xs) => xs.filter((_, j) => j !== i))}>×</button>
            )}
          </div>
        ))}
        <button className="mt-1 text-xs text-primary"
          onClick={() => setDetKeys((xs) => [...xs, ""])}>+ deterministic key</button>
        <p className="mt-1 text-xs text-muted-foreground">
          One key per line; comma-separate columns for a composite key (all must match).
        </p>
      </div>

      <div>
        <Label>Scoring fields — weighted fuzzy match for probabilistic candidates</Label>
        {scoring.map((s, i) => (
          <div key={i} className="mt-1 flex items-center gap-2">
            <ColumnSelect columns={columns} value={s.column}
              onChange={(v) => setScoring((xs) => xs.map((x, j) => j === i ? { ...x, column: v } : x))}
              placeholder="claimant_name" />
            <Input type="number" step="0.1" className="w-24" aria-label="weight"
              value={s.weight}
              onChange={(e) => setScoring((xs) => xs.map((x, j) => j === i ? { ...x, weight: e.target.value } : x))} />
            <button className="text-xs text-muted-foreground"
              onClick={() => setScoring((xs) => xs.filter((_, j) => j !== i))}>×</button>
          </div>
        ))}
        <button className="mt-1 text-xs text-primary"
          onClick={() => setScoring((xs) => [...xs, { column: columns[0] ?? "", weight: "1.0" }])}>
          + scoring field
        </button>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <div>
          <Label htmlFor="er-blocking">Blocking fields</Label>
          <Input id="er-blocking" value={blocking} placeholder="optional"
            onChange={(e) => setBlocking(e.target.value)} />
        </div>
        <div>
          <Label htmlFor="er-auto">Auto-merge ≥</Label>
          <Input id="er-auto" type="number" step="0.05" value={autoThr}
            onChange={(e) => setAutoThr(e.target.value)} />
        </div>
        <div>
          <Label htmlFor="er-review">Review ≥</Label>
          <Input id="er-review" type="number" step="0.05" value={reviewThr}
            onChange={(e) => setReviewThr(e.target.value)} />
        </div>
      </div>

      <div>
        <Button size="sm" disabled={!canSubmit || resolve.isPending} onClick={submit}>
          {resolve.isPending ? "Resolving…" : "Run resolution"}
        </Button>
      </div>

      {err && <p role="alert" className="text-xs text-destructive" data-testid="er-run-error">{err.message}</p>}
      {result && (
        <p className="text-xs text-muted-foreground" data-testid="er-run-result">
          Run {String(result.runId).slice(0, 8)}: {result.recordCount} records →{" "}
          {result.resolvedEntityCount} entities · {result.mergedClusterCount} merged ·{" "}
          {result.reviewCandidateCount} candidate{result.reviewCandidateCount === 1 ? "" : "s"} to review.
        </p>
      )}
    </div>
  );
}

/** A column dropdown that falls back to a free-text input when the dataset's
 * schema hasn't been captured (older ingests expose an empty schema). */
function ColumnSelect({ id, columns, value, onChange, placeholder }:
  { id?: string; columns: string[]; value: string; onChange: (v: string) => void; placeholder?: string }) {
  if (columns.length === 0) {
    return (
      <Input id={id} className="max-w-xs" value={value} placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)} />
    );
  }
  return (
    <select id={id}
      className="h-9 max-w-xs rounded-md border border-input bg-background px-2 text-sm"
      value={value}
      onChange={(e) => onChange(e.target.value)}>
      <option value="">{placeholder ? `${placeholder}…` : "column…"}</option>
      {columns.map((c) => <option key={c} value={c}>{c}</option>)}
    </select>
  );
}
