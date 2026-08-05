"use client";
/**
 * The shared core of "working one case" — extracted from the /cases/[id]
 * detail page so the SAME components render in two hosts:
 *
 *  - the Case Workbench's right-hand pane on /cases (no navigation), and
 *  - the full /cases/[id] page (deep links keep working; it imports
 *    EvidenceCard / LatestProposalCard / SlaChip / Field / headlineOf from
 *    here instead of defining private copies).
 *
 * The pane fetches its own case (useCaseDetail) and subscribes to the case's
 * real-time topic exactly like the full page, so lifecycle changes stream in
 * whichever host is mounted. `onAfterTransition` bubbles the actions bar's
 * successful transition up so the workbench can auto-advance to the next case.
 *
 * The latest-proposal card decides IN PLACE (useDecideProposal — the same
 * mutation the approvals inbox uses) instead of only linking out to /inbox:
 * before this, deciding an AI recommendation forced leaving the case. The
 * inbox link remains for the full review surface (evidence pack, edit-args).
 */
import { useState } from "react";
import Link from "next/link";
import { useQueryClient } from "@tanstack/react-query";
import { Clock } from "lucide-react";
import { AsyncBoundary } from "@/components/primitives/AsyncBoundary";
import { StatusChip } from "@/components/primitives/StatusChip";
import { UrnLink } from "@/components/primitives/UrnLink";
import { ProvenanceBadge } from "@/components/primitives/ProvenanceBadge";
import { AiLabel } from "@/components/primitives/AiLabel";
import { DiffView } from "@/components/primitives/DiffView";
import { Can } from "@/components/authz/Can";
import { FEATURE_GATES } from "@/lib/authz/registry";
import { Card, CardContent, CardHeader, CardTitle, Textarea } from "@/components/ui/primitives";
import { Button } from "@/components/ui/button";
import { CaseActionsBar, type CaseTransitionKind } from "@/components/cases/CaseActionsBar";
import { summarizeProjection, DeadlineChip } from "@/components/cases/projection";
import { useCaseDetail, useDecideProposal } from "@/lib/graphql/hooks";
import { qk } from "@/lib/graphql/keys";
import { useHubTopics } from "@/lib/realtime/useHubTopics";
import { useToasts } from "@/stores/ui";
import { GraphQLRequestError } from "@/lib/graphql/client";
import { formatLocal } from "@/lib/utils";
import type { Case } from "@/lib/graphql/types";

/** Domain headline: the projection's subject when present, else the title. */
export function headlineOf(c: Case): string {
  const s = summarizeProjection(c.displayProjection);
  if (!s?.headline) return c.title ?? `Case #${c.caseNumber}`;
  return s.reference ? `${s.headline} · ${s.reference}` : s.headline;
}

export function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-muted-foreground">{label}</p>
      <p className="font-medium">{value}</p>
    </div>
  );
}

export function SlaChip({ due }: { due?: string | null }) {
  if (!due) return null;
  const overdue = new Date(due).getTime() < Date.now();
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${
        overdue ? "bg-destructive/15 text-destructive" : "bg-muted text-muted-foreground"
      }`}
    >
      <Clock className="size-3" aria-hidden />
      {overdue ? "Overdue" : `Due ${formatLocal(due)}`}
    </span>
  );
}

/**
 * The decision cockpit's evidence surface: the pack/dataset display projection
 * — investigator briefing first, then every projected field. Renders nothing
 * for cases without a projection (manual/draft cases stay as before).
 */
export function EvidenceCard({ c }: { c: Case }) {
  const s = summarizeProjection(c.displayProjection);
  if (!s) return null;
  const detailFields = s.fields.filter(([k]) => k !== "note");
  return (
    <Card className="mb-4">
      <CardHeader>
        <CardTitle className="text-sm">Evidence</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {s.note && (
          <p className="rounded-md border-l-2 border-primary bg-muted/50 p-3 leading-relaxed">{s.note}</p>
        )}
        {detailFields.length > 0 && (
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 md:grid-cols-3">
            {detailFields.map(([k, v]) => (
              <div key={k} className="min-w-0">
                <dt className="truncate text-xs text-muted-foreground">{k.replaceAll("_", " ")}</dt>
                <dd className="truncate font-medium" title={v}>{v}</dd>
              </div>
            ))}
          </dl>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * Surfaces the newest open AI proposal so the decision-maker sees the
 * recommendation without hunting through tabs — and can now DECIDE it here.
 * Approve/reject run the real decideProposal mutation (four-eyes is enforced
 * server-side; a self-decision or concurrent decision surfaces as its true
 * error, never a fake success). The inbox link remains the full review path.
 */
export function LatestProposalCard({ c }: { c: Case }) {
  const decide = useDecideProposal();
  const client = useQueryClient();
  const push = useToasts((s) => s.push);
  const [mode, setMode] = useState<"view" | "reject">("view");
  const [reason, setReason] = useState("");

  const pending = c.proposals.filter((p) => p.status === "PENDING");
  const latest = (pending.length ? pending : c.proposals)[0];
  if (!latest) return null;
  const decidable = latest.status === "PENDING";

  const onDone = (label: string) => {
    push({ title: label, variant: "success" });
    setMode("view");
    setReason("");
    // Case.proposals is resolved from agent-runtime — refetch the case so the
    // card reflects the decision (the inbox cache is patched by the hook).
    void client.invalidateQueries({ queryKey: qk.case(c.id) });
  };
  const onErr = (err: unknown) => {
    const g = err instanceof GraphQLRequestError ? err : null;
    if (g?.code === "CONFLICT") {
      // BR-4: already decided elsewhere — resolve softly, no raw error.
      push({ title: "Already decided by someone else", variant: "default", traceId: g.traceId });
      setMode("view");
      void client.invalidateQueries({ queryKey: qk.case(c.id) });
      return;
    }
    push({ title: "Decision failed", description: g?.message, traceId: g?.traceId, variant: "error" });
  };

  return (
    <Card className="mb-4 border-ai/40">
      <CardHeader className="flex-row items-center gap-2">
        <AiLabel />
        <CardTitle className="text-sm">Recommended: {latest.tool}</CardTitle>
        <ProvenanceBadge
          provenance={{ agentKey: latest.agentKey ?? undefined, sourceRunId: undefined, createdAt: latest.createdAt ?? undefined }}
          className="ml-auto"
        />
      </CardHeader>
      <CardContent className="space-y-2">
        {latest.rationale && <p className="text-sm text-muted-foreground">{latest.rationale}</p>}
        <DiffView argsDiff={latest.argsDiff} />
        {mode === "reject" && (
          <div className="space-y-1.5">
            <label htmlFor={`reject-reason-${latest.id}`} className="text-xs text-muted-foreground">
              Rejection reason (required)
            </label>
            <Textarea
              id={`reject-reason-${latest.id}`}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              disabled={decide.isPending}
              placeholder="Why this recommendation is wrong…"
            />
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2">
          {decidable && (
            <Can gate={FEATURE_GATES.approveProposal}>
              {mode === "view" ? (
                <>
                  <Button
                    size="sm"
                    variant="ai"
                    disabled={decide.isPending}
                    onClick={() =>
                      decide.mutate(
                        { id: latest.id, decision: { kind: "APPROVE" } },
                        { onSuccess: () => onDone("Proposal approved"), onError: onErr },
                      )
                    }
                  >
                    {decide.isPending ? "Deciding…" : "Approve"}
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => setMode("reject")}>
                    Reject
                  </Button>
                </>
              ) : (
                <>
                  <Button
                    size="sm"
                    variant="destructive"
                    disabled={decide.isPending || !reason.trim()}
                    onClick={() =>
                      decide.mutate(
                        { id: latest.id, decision: { kind: "REJECT", reason: reason.trim() } },
                        { onSuccess: () => onDone("Proposal rejected"), onError: onErr },
                      )
                    }
                  >
                    {decide.isPending ? "Rejecting…" : "Confirm reject"}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => { setMode("view"); setReason(""); }}>
                    Cancel
                  </Button>
                </>
              )}
            </Can>
          )}
          <Button asChild size="sm" variant="ghost">
            <a href={`/inbox?p=${latest.id}`}>{decidable ? "Full review in inbox" : "View in inbox"}</a>
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * The right-hand work pane of the Case Workbench: summary chips, lifecycle
 * actions (incl. the resolve-with-disposition dialog), evidence, latest AI
 * recommendation, and the key facts — everything needed to disposition a case
 * without leaving /cases. Activity/attachments/edit stay on the full page.
 */
export function CaseWorkPane({
  caseId,
  onAfterTransition,
}: {
  caseId: string;
  onAfterTransition?: (kind: CaseTransitionKind) => void;
}) {
  const query = useCaseDetail(caseId);
  const c = query.data?.case;
  // Same single-case realtime topic the full page uses (run-status:<case-urn>).
  useHubTopics(c?.urn ? [`run-status:${c.urn}`] : []);

  return (
    <AsyncBoundary
      isLoading={query.isLoading}
      isError={query.isError}
      error={query.error}
      isEmpty={!query.isLoading && !c}
      emptyTitle="Case not found"
      onRetry={() => query.refetch()}
    >
      {c && (
        <div data-testid="case-work-pane">
          <div className="mb-3">
            <h2 className="truncate text-lg font-semibold" title={headlineOf(c)}>
              {headlineOf(c)}
            </h2>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              {c.caseNumber != null && (
                <span className="font-mono text-xs text-muted-foreground">#{c.caseNumber}</span>
              )}
              <DeadlineChip days={summarizeProjection(c.displayProjection)?.deadlineDays} />
              <SlaChip due={c.dueDate} />
              <StatusChip status={c.status} live />
              <StatusChip status={c.severity} />
            </div>
          </div>

          <CaseActionsBar c={c} onAfterTransition={onAfterTransition} />

          <EvidenceCard c={c} />
          <LatestProposalCard c={c} />

          <Card>
            <CardContent className="grid grid-cols-2 gap-4 pt-4 text-sm">
              <Field label="Assignee" value={c.assignee?.fullName ?? c.assignee?.email ?? "Unassigned"} />
              <Field label="Due" value={formatLocal(c.dueDate)} />
              <Field label="Created" value={formatLocal(c.createdAt)} />
              {c.resolvedAt && <Field label="Resolved" value={formatLocal(c.resolvedAt)} />}
              {c.closedAt && <Field label="Closed" value={formatLocal(c.closedAt)} />}
              {c.resolutionNote && (
                <div className="col-span-2">
                  <p className="mb-1 text-muted-foreground">Resolution note</p>
                  <p className="font-medium">{c.resolutionNote}</p>
                </div>
              )}
              <div className="col-span-2">
                <p className="mb-1 text-muted-foreground">Source dataset</p>
                {c.sourceDataset ? <UrnLink urn={c.sourceDataset.urn} label={c.sourceDataset.name} /> : "—"}
              </div>
              <div className="col-span-2 text-xs text-muted-foreground">
                Activity, comments and attachments live on the{" "}
                <Link href={`/cases/${c.id}`} className="text-primary hover:underline">
                  full case page
                </Link>
                .
              </div>
            </CardContent>
          </Card>
        </div>
      )}
    </AsyncBoundary>
  );
}
