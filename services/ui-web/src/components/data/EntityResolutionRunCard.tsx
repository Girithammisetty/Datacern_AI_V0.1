"use client";
import { useMemo, useState } from "react";
import Link from "next/link";
import { StatusChip } from "@/components/primitives/StatusChip";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/primitives";
import {
  useResolutionRun, useMergeCandidates, useProposeEntityMerge,
  useMaterializeResolvedEntities,
} from "@/lib/graphql/hooks";
import { GraphQLRequestError } from "@/lib/graphql/client";
import type {
  ResolutionRun, MergeCandidate, ResolvedCluster, MaterializeResolvedResult,
} from "@/lib/graphql/types";

const AGGS = ["first", "sum", "max", "min", "avg", "count_distinct"];
type Tab = "merges" | "entities" | "materialize";

/**
 * One persisted resolution run (BRD 56): its counts, the merge-candidate review
 * queue (four-eyes), the resolved-entity view with member lineage, and the
 * materialize action that turns the run into a governed golden-record dataset.
 * A LINK layer — nothing here mutates the source of record.
 */
export function EntityResolutionRunCard({
  run, columns, canPropose, canRun,
}: {
  run: ResolutionRun;
  columns: string[];
  canPropose: boolean;
  canRun: boolean;
}) {
  const [tab, setTab] = useState<Tab>("merges");

  return (
    <div className="rounded-lg border p-4" data-testid="er-run-card">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold">
            {run.entityType} · run {String(run.runId).slice(0, 8)}
          </h3>
          <p className="text-xs text-muted-foreground">
            {run.recordCount} records → {run.resolvedEntityCount} entities ·{" "}
            {run.mergedClusterCount} merged · {run.reviewCandidateCount} to review
            {run.createdBy ? ` · by ${run.createdBy}` : ""}
          </p>
        </div>
        <StatusChip status={run.status} />
      </div>

      <div className="mb-3 flex flex-wrap gap-1 border-b text-sm">
        <TabButton active={tab === "merges"} onClick={() => setTab("merges")}>
          Review merges{run.reviewCandidateCount ? ` (${run.reviewCandidateCount})` : ""}
        </TabButton>
        <TabButton active={tab === "entities"} onClick={() => setTab("entities")}>
          Resolved entities
        </TabButton>
        <TabButton active={tab === "materialize"} onClick={() => setTab("materialize")}>
          Materialize
        </TabButton>
      </div>

      {tab === "merges" && <MergeReview run={run} canPropose={canPropose} />}
      {tab === "entities" && <ResolvedEntities runId={run.runId} />}
      {tab === "materialize" && <MaterializePanel run={run} columns={columns} canRun={canRun} />}
    </div>
  );
}

function TabButton({ active, onClick, children }:
  { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`-mb-px border-b-2 px-2 py-1.5 ${active
        ? "border-primary font-medium text-foreground"
        : "border-transparent text-muted-foreground hover:text-foreground"}`}
    >
      {children}
    </button>
  );
}

// ---- merge-candidate review (four-eyes) -------------------------------------

function MergeReview({ run, canPropose }: { run: ResolutionRun; canPropose: boolean }) {
  const candidates = useMergeCandidates(run.runId);
  const rows = candidates.data ?? [];

  if (candidates.isLoading) return <p className="text-xs text-muted-foreground">Loading candidates…</p>;
  if (candidates.isError) {
    return <p role="alert" className="text-xs text-destructive">Could not load merge candidates.</p>;
  }
  if (rows.length === 0) {
    return (
      <p className="text-xs text-muted-foreground" data-testid="er-no-candidates">
        No merge candidates to review — every match above the auto-merge threshold merged
        automatically, and nothing fell in the review band.
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-2" data-testid="er-candidates">
      {rows.map((c) => (
        <MergeCandidateRow key={c.id} candidate={c} canPropose={canPropose}
          onChanged={() => candidates.refetch()} />
      ))}
    </div>
  );
}

function MergeCandidateRow({ candidate, canPropose, onChanged }:
  { candidate: MergeCandidate; canPropose: boolean; onChanged: () => void }) {
  const propose = useProposeEntityMerge();
  const [proposalId, setProposalId] = useState<string | null>(candidate.proposalId ?? null);
  const err = propose.error instanceof GraphQLRequestError ? propose.error : null;
  const pending = candidate.status?.toLowerCase() === "pending";
  const score = candidate.score != null ? candidate.score.toFixed(3) : "—";

  const onPropose = () =>
    propose.mutate(
      {
        input: {
          datasetId: candidate.datasetId,
          runId: candidate.runId,
          candidateId: candidate.id,
          leftPk: candidate.leftPk,
          rightPk: candidate.rightPk,
          score: candidate.score ?? undefined,
        },
      },
      { onSuccess: (r) => { setProposalId(r.proposalId); onChanged(); } },
    );

  return (
    <div className="rounded-md border p-3 text-xs" data-testid="er-candidate">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="font-mono">{candidate.leftPk}</span>
          <span className="text-muted-foreground">≈</span>
          <span className="font-mono">{candidate.rightPk}</span>
          <span className="rounded bg-muted px-1.5 py-0.5">score {score}</span>
        </div>
        <StatusChip status={candidate.status} />
      </div>

      {candidate.evidence != null && (
        <pre className="mt-2 max-h-24 overflow-auto rounded bg-muted/40 p-2 text-[11px] leading-tight">
          {JSON.stringify(candidate.evidence, null, 2)}
        </pre>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-2">
        {pending && !proposalId && canPropose && (
          <Button size="sm" disabled={propose.isPending} onClick={onPropose}>
            {propose.isPending ? "Proposing…" : "Propose merge (four-eyes)"}
          </Button>
        )}
        {pending && !proposalId && !canPropose && (
          <span className="text-muted-foreground">
            You need the merge capability to propose this merge.
          </span>
        )}
        {proposalId && (
          <span className="flex items-center gap-2" data-testid="er-proposed">
            <StatusChip status="pending" />
            Proposal {String(proposalId).slice(0, 8)} opened —{" "}
            <Link href="/inbox" className="text-primary underline">
              a different user approves it in the inbox
            </Link>
          </span>
        )}
        {!pending && candidate.decidedBy && (
          <span className="text-muted-foreground">decided by {candidate.decidedBy}</span>
        )}
      </div>

      {err && <p role="alert" className="mt-2 text-destructive">{err.message}</p>}
    </div>
  );
}

// ---- resolved-entity view (clusters + member lineage) -----------------------

function ResolvedEntities({ runId }: { runId: string }) {
  const detail = useResolutionRun(runId);
  const clusters = detail.data?.clusters ?? [];

  if (detail.isLoading) return <p className="text-xs text-muted-foreground">Loading resolved entities…</p>;
  if (detail.isError) {
    return <p role="alert" className="text-xs text-destructive">Could not load resolved entities.</p>;
  }
  if (clusters.length === 0) {
    return <p className="text-xs text-muted-foreground">No resolved entities in this run.</p>;
  }
  // Show merged clusters first — those are the interesting ones for a steward.
  const sorted = [...clusters].sort((a, b) => b.memberCount - a.memberCount);
  return (
    <div className="flex flex-col gap-2" data-testid="er-clusters">
      {sorted.map((c) => <ClusterRow key={c.resolvedEntityId} cluster={c} />)}
    </div>
  );
}

function ClusterRow({ cluster }: { cluster: ResolvedCluster }) {
  const [open, setOpen] = useState(false);
  const merged = cluster.memberCount > 1;
  return (
    <div className="rounded-md border p-2 text-xs" data-testid="er-cluster">
      <button className="flex w-full items-center justify-between gap-2 text-left"
        onClick={() => setOpen((v) => !v)}>
        <span className="flex items-center gap-2">
          <span className="font-mono">{cluster.resolvedEntityId}</span>
          {merged && (
            <span className="rounded bg-primary/10 px-1.5 py-0.5 text-primary">
              merged ×{cluster.memberCount}
            </span>
          )}
        </span>
        <span className="text-muted-foreground">
          {cluster.method}{cluster.confidence != null ? ` · conf ${cluster.confidence.toFixed(2)}` : ""}
        </span>
      </button>
      {open && (
        <table className="mt-2 w-full text-left">
          <thead className="text-muted-foreground">
            <tr><th className="py-1">Record</th><th>Method</th></tr>
          </thead>
          <tbody className="font-mono">
            {cluster.members.map((m) => (
              <tr key={m.memberPk} className="border-t">
                <td className="py-1 pr-2">{m.memberPk}</td>
                <td>{m.method ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ---- materialize the governed golden-record dataset -------------------------

interface AttrDraft { column: string; agg: string }

function MaterializePanel({ run, columns, canRun }:
  { run: ResolutionRun; columns: string[]; canRun: boolean }) {
  const materialize = useMaterializeResolvedEntities();
  const [name, setName] = useState(`resolved_${run.entityType}`);
  const [attrs, setAttrs] = useState<AttrDraft[]>([{ column: columns[0] ?? "", agg: "first" }]);
  const [result, setResult] = useState<MaterializeResolvedResult | null>(null);
  const err = materialize.error instanceof GraphQLRequestError ? materialize.error : null;
  const colChoices = useMemo(() => (columns.length ? columns : [""]), [columns]);

  const submit = () =>
    materialize.mutate(
      {
        runId: run.runId,
        input: {
          name: name.trim() || undefined,
          attributes: attrs.filter((a) => a.column).map((a) => ({ column: a.column, agg: a.agg })),
        },
      },
      { onSuccess: setResult },
    );

  if (!canRun) {
    return (
      <p className="text-xs text-muted-foreground">
        You need the run capability to materialize the resolved-entity dataset.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-3 text-xs" data-testid="er-materialize">
      <p className="text-muted-foreground">
        Build a governed dataset with one golden row per resolved entity. Numeric rollups
        (sum, max…) combine attributes across the records that merged — a figure no single
        source row reaches. It becomes a normal, semantic-bindable dataset.
      </p>
      <div>
        <Label htmlFor={`mat-name-${run.runId}`}>Dataset name</Label>
        <Input id={`mat-name-${run.runId}`} value={name}
          onChange={(e) => setName(e.target.value)} className="max-w-xs" />
      </div>

      <div className="flex flex-col gap-2">
        <span className="font-medium text-muted-foreground">Golden-record attributes</span>
        {attrs.map((a, i) => (
          <div key={i} className="flex flex-wrap items-center gap-2">
            <select aria-label="attribute column"
              className="h-9 rounded-md border border-input bg-background px-2"
              value={a.column}
              onChange={(e) => setAttrs((xs) => xs.map((x, j) => j === i ? { ...x, column: e.target.value } : x))}>
              {colChoices.map((c) => <option key={c} value={c}>{c || "(pick a column)"}</option>)}
            </select>
            <span className="text-muted-foreground">rolled up by</span>
            <select aria-label="aggregation"
              className="h-9 rounded-md border border-input bg-background px-2"
              value={a.agg}
              onChange={(e) => setAttrs((xs) => xs.map((x, j) => j === i ? { ...x, agg: e.target.value } : x))}>
              {AGGS.map((g) => <option key={g} value={g}>{g}</option>)}
            </select>
            {attrs.length > 1 && (
              <button className="text-muted-foreground"
                onClick={() => setAttrs((xs) => xs.filter((_, j) => j !== i))}>×</button>
            )}
          </div>
        ))}
        <button className="self-start text-primary"
          onClick={() => setAttrs((xs) => [...xs, { column: colChoices[0], agg: "first" }])}>
          + attribute
        </button>
      </div>

      <div>
        <Button size="sm" disabled={materialize.isPending} onClick={submit}>
          {materialize.isPending ? "Materializing…" : "Materialize governed dataset"}
        </Button>
      </div>

      {err && <p role="alert" className="text-destructive" data-testid="er-materialize-error">{err.message}</p>}
      {result && (
        <div className="rounded-md border bg-muted/40 p-3" data-testid="er-materialize-result">
          <p className="mb-1 font-medium">Materialized ✓</p>
          <p className="text-muted-foreground">
            {result.rowCount} golden rows · v{result.versionNo} · columns: {result.columns.join(", ")}
          </p>
          <Link href={`/data/datasets/${result.resolvedDatasetId}`}
            className="mt-1 inline-block text-primary underline">
            Open “{result.name}” →
          </Link>
        </div>
      )}
    </div>
  );
}
