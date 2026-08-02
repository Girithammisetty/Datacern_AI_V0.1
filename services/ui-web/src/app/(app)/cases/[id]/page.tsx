"use client";
import { use, useMemo, useState } from "react";
import * as Tabs from "@radix-ui/react-tabs";
import { Clock } from "lucide-react";
import { PageHeader } from "@/components/shell/PageHeader";
import { AsyncBoundary } from "@/components/primitives/AsyncBoundary";
import { StatusChip } from "@/components/primitives/StatusChip";
import { UrnLink } from "@/components/primitives/UrnLink";
import { ProvenanceBadge } from "@/components/primitives/ProvenanceBadge";
import { AiLabel } from "@/components/primitives/AiLabel";
import { DiffView } from "@/components/primitives/DiffView";
import { Can } from "@/components/authz/Can";
import { CaseActionsBar } from "@/components/cases/CaseActionsBar";
import { FEATURE_GATES, cap } from "@/lib/authz/registry";
import { Card, CardContent, CardHeader, CardTitle, Input, Label, Textarea } from "@/components/ui/primitives";
import { Button } from "@/components/ui/button";
import { useCaseDetail, useUpdateCase, useCaseTimeline, useCaseComments,
  useAddCaseComment, useUpdateCaseComment, useDeleteCaseComment } from "@/lib/graphql/hooks";
import { useHubTopics } from "@/lib/realtime/useHubTopics";
import { useSession } from "@/lib/session/SessionContext";
import { useToasts } from "@/stores/ui";
import { GraphQLRequestError } from "@/lib/graphql/client";
import { formatLocal } from "@/lib/utils";
import { summarizeProjection, DeadlineChip } from "@/components/cases/projection";
import type { Case, CaseActivity, CaseEvidence, Severity } from "@/lib/graphql/types";


export default function CaseDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const query = useCaseDetail(id);
  const c = query.data?.case;
  // Task #78: "case.status"/"case.assigned" aren't a valid realtime-hub topic
  // (grammar is scheme:identifier) — this always 422'd. The real topic for a
  // single case's lifecycle events is run-status:<case-urn>; case-service's
  // events all carry resource_urn = the case's own URN (see routing.go's
  // "case" rule). Subscribe only once the case's urn is loaded.
  useHubTopics(c?.urn ? [`run-status:${c.urn}`] : []);

  return (
    <div>
      <AsyncBoundary
        isLoading={query.isLoading}
        isError={query.isError}
        error={query.error}
        isEmpty={!query.isLoading && !c}
        emptyTitle="Case not found"
        onRetry={() => query.refetch()}
      >
        {c && (
          <>
            <PageHeader
              title={headlineOf(c)}
              description={c.caseNumber != null ? `Case #${c.caseNumber}` : undefined}
              actions={
                <div className="flex items-center gap-2">
                  <DeadlineChip days={summarizeProjection(c.displayProjection)?.deadlineDays} />
                  <SlaChip due={c.dueDate} />
                  <StatusChip status={c.status} live />
                  <StatusChip status={c.severity} />
                </div>
              }
            />

            <CaseActionsBar c={c} />

            <div className="grid gap-4 lg:grid-cols-[1fr_360px]">
              <Tabs.Root defaultValue="overview">
                <Tabs.List className="mb-3 flex gap-1 border-b" aria-label="Case sections">
                  {["overview", "details", "activity", "proposals", "attachments"].map((v) => (
                    <Tabs.Trigger
                      key={v}
                      value={v}
                      className="border-b-2 border-transparent px-3 py-2 text-sm font-medium capitalize text-muted-foreground data-[state=active]:border-primary data-[state=active]:text-foreground"
                    >
                      {v}
                      {v === "proposals" && c.proposals.length > 0 && (
                        <span className="ml-1 rounded-full bg-ai px-1.5 text-xs text-ai-foreground">
                          {c.proposals.length}
                        </span>
                      )}
                      {v === "attachments" && (c.evidence?.length ?? 0) > 0 && (
                        <span className="ml-1 rounded-full bg-muted px-1.5 text-xs text-muted-foreground">
                          {c.evidence?.length}
                        </span>
                      )}
                    </Tabs.Trigger>
                  ))}
                </Tabs.List>

                <Tabs.Content value="overview">
                  <EvidenceCard c={c} />
                  <LatestProposalCard c={c} />
                  <Card>
                    <CardContent className="grid grid-cols-2 gap-4 pt-4 text-sm">
                      <Field label="Case number" value={`#${c.caseNumber ?? "—"}`} />
                      <Field label="Created" value={formatLocal(c.createdAt)} />
                      <Field label="Assignee" value={c.assignee?.fullName ?? c.assignee?.email ?? "Unassigned"} />
                      <Field label="Due" value={formatLocal(c.dueDate)} />
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
                    </CardContent>
                  </Card>
                </Tabs.Content>

                <Tabs.Content value="details">
                  <CaseEditForm caseId={id} severity={c.severity} description={c.description} dueDate={c.dueDate} />
                </Tabs.Content>

                <Tabs.Content value="activity">
                  <ActivityPanel caseId={id} />
                </Tabs.Content>

                <Tabs.Content value="proposals">
                  <div className="space-y-3">
                    {c.proposals.length === 0 && (
                      <p className="text-sm text-muted-foreground">No AI recommendations yet.</p>
                    )}
                    {c.proposals.map((p) => (
                      <Card key={p.id}>
                        <CardHeader className="flex-row items-center gap-2">
                          <AiLabel />
                          <CardTitle className="text-sm">{p.tool}</CardTitle>
                          <ProvenanceBadge
                            provenance={{ agentKey: p.agentKey ?? undefined, sourceRunId: undefined, createdAt: p.createdAt ?? undefined }}
                            className="ml-auto"
                          />
                        </CardHeader>
                        <CardContent className="space-y-2">
                          {p.rationale && <p className="text-sm text-muted-foreground">{p.rationale}</p>}
                          <DiffView argsDiff={p.argsDiff} />
                          <Button asChild size="sm" variant="ai">
                            <a href={`/inbox?p=${p.id}`}>Review in inbox</a>
                          </Button>
                        </CardContent>
                      </Card>
                    ))}
                  </div>
                </Tabs.Content>

                <Tabs.Content value="attachments">
                  <AttachmentsPanel caseId={id} evidence={c.evidence ?? []} onChanged={() => query.refetch()} />
                </Tabs.Content>
              </Tabs.Root>

              <Card className="h-fit">
                <CardHeader>
                  <CardTitle className="text-sm">Row reference</CardTitle>
                </CardHeader>
                <CardContent className="text-sm text-muted-foreground">
                  {c.sourceDataset ? (
                    <p>
                      Backed by <UrnLink urn={c.sourceDataset.urn} label={c.sourceDataset.name} />
                      {c.sourceDataset.rowCount != null && ` · ${c.sourceDataset.rowCount} rows`}
                    </p>
                  ) : (
                    <p>No linked dataset.</p>
                  )}
                </CardContent>
              </Card>
            </div>
          </>
        )}
      </AsyncBoundary>
    </div>
  );
}


/** Domain headline: the projection's subject when present, else the title. */
function headlineOf(c: Case): string {
  const s = summarizeProjection(c.displayProjection);
  if (!s?.headline) return c.title ?? `Case #${c.caseNumber}`;
  return s.reference ? `${s.headline} · ${s.reference}` : s.headline;
}

/**
 * The decision cockpit's evidence surface: the pack/dataset display projection
 * — investigator briefing first, then every projected field. Renders nothing
 * for cases without a projection (manual/draft cases stay as before).
 */
function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const kb = n / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

/** Case evidence attachments (task #77): upload files (PDF/image/report) and
 * list/download them. Bytes go through the same-origin /api/case-evidence proxy
 * (which forwards the httpOnly session to case-service); metadata comes from the
 * CaseDetail query's `evidence` field. Upload is gated on case.evidence.create. */
function AttachmentsPanel({
  caseId,
  evidence,
  onChanged,
}: {
  caseId: string;
  evidence: CaseEvidence[];
  onChanged: () => void;
}) {
  const toasts = useToasts();
  const [busy, setBusy] = useState(false);

  async function upload(file: File) {
    if (busy) return;
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch(`/api/case-evidence/${encodeURIComponent(caseId)}`, {
        method: "POST",
        body: fd,
      });
      if (!res.ok) {
        const t = await res.text();
        throw new Error(t || `upload failed (${res.status})`);
      }
      toasts.push({ title: `Attached ${file.name}`, variant: "success" });
      onChanged();
    } catch (e) {
      toasts.push({ title: e instanceof Error ? e.message : "upload failed", variant: "error" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <Can gate={cap("case.evidence.create")}>
        <Card>
          <CardContent className="flex flex-wrap items-center gap-3 pt-4">
            <label className="inline-flex cursor-pointer items-center gap-2 rounded-md border border-dashed px-3 py-2 text-sm hover:bg-accent">
              <input
                type="file"
                className="sr-only"
                disabled={busy}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void upload(f);
                  e.target.value = "";
                }}
              />
              {busy ? "Uploading…" : "Attach a file"}
            </label>
            <span className="text-xs text-muted-foreground">PDF, image, report — up to 25 MB.</span>
          </CardContent>
        </Card>
      </Can>

      {evidence.length === 0 ? (
        <p className="text-sm text-muted-foreground">No attachments yet.</p>
      ) : (
        <div className="space-y-2">
          {evidence.map((e) => (
            <Card key={e.id}>
              <CardContent className="flex items-center gap-3 py-3 text-sm">
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium" title={e.filename}>{e.filename}</p>
                  <p className="text-xs text-muted-foreground">
                    {humanBytes(e.sizeBytes)} · {e.contentType}
                    {e.createdAt ? ` · ${formatLocal(e.createdAt)}` : ""}
                  </p>
                </div>
                <Button asChild size="sm" variant="outline">
                  <a href={`/api/case-evidence/${encodeURIComponent(caseId)}/${encodeURIComponent(e.id)}`}>
                    Download
                  </a>
                </Button>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

function EvidenceCard({ c }: { c: Case }) {
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
 * Surfaces the newest open AI proposal on the overview so the decision-maker
 * sees the recommendation without hunting through tabs; the full list (and
 * the four-eyes review path) stays on the Proposals tab / approval inbox.
 */
function LatestProposalCard({ c }: { c: Case }) {
  const pending = c.proposals.filter((p) => p.status === "PENDING");
  const latest = (pending.length ? pending : c.proposals)[0];
  if (!latest) return null;
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
        <Button asChild size="sm" variant="ai">
          <a href={`/inbox?p=${latest.id}`}>Review &amp; decide in inbox</a>
        </Button>
      </CardContent>
    </Card>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-muted-foreground">{label}</p>
      <p className="font-medium">{value}</p>
    </div>
  );
}

function SlaChip({ due }: { due?: string | null }) {
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
 * Severity/description editing via PATCH /cases/{id} (updateCase). Resolution
 * is deliberately NOT here — it goes through the Resolve action above (the
 * real resolveCase transition with a disposition), never a description PATCH.
 */
function CaseEditForm({
  caseId,
  severity,
  description,
  dueDate,
}: {
  caseId: string;
  severity?: Severity | null;
  description?: string | null;
  dueDate?: string | null;
}) {
  const update = useUpdateCase(caseId);
  const push = useToasts((s) => s.push);
  const [sev, setSev] = useState<Severity>(severity ?? "MEDIUM");
  const [desc, setDesc] = useState(description ?? "");
  const [due, setDue] = useState(dueDate ? dueDate.slice(0, 10) : "");

  function submit(e: React.FormEvent) {
    e.preventDefault();
    update.mutate(
      // dueDate is a GraphQL DateTime (RFC3339) — the <input type="date"> yields
      // a bare "YYYY-MM-DD", which case-service rejects with a 422 time-parse
      // error. Anchor it to end-of-day UTC, matching the createCases convention.
      { severity: sev, description: desc || undefined, dueDate: due ? `${due}T23:59:59Z` : undefined },
      {
        onError: (err) => {
          const g = err instanceof GraphQLRequestError ? err : null;
          push({
            title: "Update failed — reverted",
            description: g?.message,
            traceId: g?.traceId,
            variant: "error",
          });
        },
        onSuccess: () => push({ title: "Case updated", variant: "success" }),
      },
    );
  }

  return (
    <Card>
      <CardContent className="pt-4">
        <form onSubmit={submit} className="space-y-3">
          <div className="space-y-1">
            <Label>Severity</Label>
            <select
              value={sev}
              onChange={(e) => setSev(e.target.value as Severity)}
              className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
            >
              {(["LOW", "MEDIUM", "HIGH", "CRITICAL"] as Severity[]).map((s) => (
                <option key={s} value={s}>
                  {s.toLowerCase()}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <Label>Description</Label>
            <Textarea value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="Describe the case…" />
          </div>
          <div className="space-y-1">
            <Label>Due date</Label>
            <Input type="date" value={due} onChange={(e) => setDue(e.target.value)} />
          </div>
          <Button type="submit" disabled={update.isPending}>
            {update.isPending ? "Saving…" : "Save changes"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

/** How long the backend lets an author edit/delete their own comment. */
const COMMENT_EDIT_WINDOW_MS = 15 * 60_000;

/**
 * The real merged event+comment timeline (GET /cases/{id}/timeline), newest-
 * first, plus a comment composer. Comment bodies come from the authoritative
 * list (Query.caseComments -> case-service GET /cases/{id}/comments), with the
 * timeline's joined body as the fast path; a comment.added row with neither is
 * a since-deleted comment and says so.
 */
function ActivityPanel({ caseId }: { caseId: string }) {
  const session = useSession();
  const push = useToasts((s) => s.push);
  const timeline = useCaseTimeline(caseId);
  const comments = useCaseComments(caseId);
  const addComment = useAddCaseComment(caseId);
  const updateComment = useUpdateCaseComment(caseId);
  const deleteComment = useDeleteCaseComment(caseId);

  const [draft, setDraft] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");

  const activities = useMemo(
    () => timeline.data?.pages.flatMap((p) => p.nodes) ?? [],
    [timeline.data],
  );
  // Authoritative comment bodies keyed by id (GET /cases/{id}/comments).
  const commentById = useMemo(
    () => new Map((comments.data ?? []).map((c) => [c.id, c])),
    [comments.data],
  );

  const toastError = (title: string) => (err: unknown) => {
    const g = err instanceof GraphQLRequestError ? err : null;
    push({ title, description: g?.message ?? String(err), traceId: g?.traceId, variant: "error" });
  };

  function submitComment(e: React.FormEvent) {
    e.preventDefault();
    const body = draft.trim();
    if (!body || addComment.isPending) return;
    addComment.mutate(body, {
      onSuccess: () => setDraft(""),
      onError: toastError("Comment failed"),
    });
  }

  function commentIdOf(a: CaseActivity): string | null {
    const nv = a.newValue as { comment_id?: string } | null | undefined;
    return nv && typeof nv === "object" ? (nv.comment_id ?? null) : null;
  }

  // The timeline carries the joined live body; the authoritative list backs it
  // up (and adds edit state). Neither having it means the comment was deleted.
  function commentBodyOf(a: CaseActivity): string | undefined {
    const nv = a.newValue as { body?: string } | null | undefined;
    return nv && typeof nv === "object" && typeof nv.body === "string" ? nv.body : undefined;
  }

  return (
    <div className="space-y-3">
      <Can gate={FEATURE_GATES.manageCase}>
        <Card>
          <CardContent className="pt-4">
            <form onSubmit={submitComment} className="space-y-2">
              <Label htmlFor="case-comment">Add a comment</Label>
              <Textarea
                id="case-comment"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                maxLength={8192}
                placeholder="Share findings with the team…"
              />
              <Button type="submit" size="sm" disabled={addComment.isPending || !draft.trim()}>
                {addComment.isPending ? "Posting…" : "Comment"}
              </Button>
            </form>
          </CardContent>
        </Card>
      </Can>

      <AsyncBoundary
        isLoading={timeline.isLoading}
        isError={timeline.isError}
        error={timeline.error}
        isEmpty={!timeline.isLoading && activities.length === 0}
        emptyTitle="No activity yet"
        onRetry={() => timeline.refetch()}
      >
        <ul className="space-y-2" aria-label="Case activity">
          {activities.map((a) => {
            const isComment = a.eventType === "comment.added";
            const commentId = isComment ? commentIdOf(a) : null;
            const listed = commentId ? commentById.get(commentId) : undefined;
            const cachedBody = isComment
              ? (commentBodyOf(a) ?? listed?.body ?? undefined)
              : undefined;
            const mine = a.actorType === "user" && a.actorId === session.userId;
            const withinWindow =
              !!a.occurredAt && Date.now() - new Date(a.occurredAt).getTime() <= COMMENT_EDIT_WINDOW_MS;
            const editable = isComment && !!commentId && mine && withinWindow;

            return (
              <li key={a.id}>
                <Card>
                  <CardContent className="space-y-1 pt-3 text-sm">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{a.eventType?.replaceAll(/[._]/g, " ") ?? "event"}</span>
                      <span className="text-xs text-muted-foreground">
                        {a.actor?.fullName ?? a.actor?.email ?? a.actorId ?? a.actorType ?? "system"}
                        {a.actorType === "agent" && " (agent)"}
                      </span>
                      <span className="ml-auto text-xs text-muted-foreground">{formatLocal(a.occurredAt)}</span>
                    </div>

                    {isComment ? (
                      editingId === commentId ? (
                        <div className="space-y-2">
                          <Textarea
                            value={editDraft}
                            onChange={(e) => setEditDraft(e.target.value)}
                            maxLength={8192}
                            aria-label="Edit comment"
                          />
                          <div className="flex gap-2">
                            <Button
                              size="sm"
                              disabled={updateComment.isPending || !editDraft.trim()}
                              onClick={() =>
                                updateComment.mutate(
                                  { id: commentId!, body: editDraft.trim() },
                                  {
                                    onSuccess: () => setEditingId(null),
                                    onError: toastError("Edit failed"),
                                  },
                                )
                              }
                            >
                              Save
                            </Button>
                            <Button size="sm" variant="ghost" onClick={() => setEditingId(null)}>
                              Cancel
                            </Button>
                          </div>
                        </div>
                      ) : (
                        <div className="space-y-1">
                          {cachedBody != null ? (
                            <p className="whitespace-pre-wrap">{cachedBody}</p>
                          ) : (
                            <p className="italic text-muted-foreground">Comment deleted</p>
                          )}
                          {editable && (
                            <div className="flex gap-2">
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => {
                                  setEditingId(commentId);
                                  setEditDraft(cachedBody ?? "");
                                }}
                              >
                                Edit
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                disabled={deleteComment.isPending}
                                onClick={() =>
                                  deleteComment.mutate(commentId!, {
                                    onSuccess: () => push({ title: "Comment deleted", variant: "success" }),
                                    onError: toastError("Delete failed"),
                                  })
                                }
                              >
                                Delete
                              </Button>
                            </div>
                          )}
                        </div>
                      )
                    ) : (
                      (a.oldValue != null || a.newValue != null) && (
                        <p className="text-xs text-muted-foreground">
                          {a.oldValue != null && <>from <span className="font-mono">{summarize(a.oldValue)}</span> </>}
                          {a.newValue != null && <>to <span className="font-mono">{summarize(a.newValue)}</span></>}
                        </p>
                      )
                    )}
                  </CardContent>
                </Card>
              </li>
            );
          })}
        </ul>
        {timeline.hasNextPage && (
          <Button
            variant="outline"
            size="sm"
            disabled={timeline.isFetchingNextPage}
            onClick={() => timeline.fetchNextPage()}
          >
            {timeline.isFetchingNextPage ? "Loading…" : "Load older activity"}
          </Button>
        )}
      </AsyncBoundary>
    </div>
  );
}

/** Compact one-line rendering of an activity's old/new JSON value. */
function summarize(v: unknown): string {
  if (v == null) return "—";
  if (typeof v === "string") return v;
  const s = JSON.stringify(v);
  return s.length > 120 ? `${s.slice(0, 117)}…` : s;
}
