"use client";
import { useMemo, useState } from "react";
import { Brain, Database, ScrollText, Search, ShieldAlert, X } from "lucide-react";
import { PageHeader } from "@/components/shell/PageHeader";
import { DataTable, type Column } from "@/components/primitives/DataTable";
import { AsyncBoundary } from "@/components/primitives/AsyncBoundary";
import { ConfirmDialog } from "@/components/primitives/ConfirmDialog";
import { Can } from "@/components/authz/Can";
import { Badge, Card, CardHeader, CardTitle, CardContent, Input, Textarea } from "@/components/ui/primitives";
import { Button } from "@/components/ui/button";
import { FEATURE_GATES } from "@/lib/authz/registry";
import {
  useMemories, useMemory, useMemoryStats, useRequestMemoryErasure, useErasure,
  useUpdateMemory, useDeleteMemory, useUnquarantineMemory, useMemoryRetrievalTest,
  useCorpusStatus, useUpdateCorpus, useRebuildCorpus, useRegisterCorpus,
  useMemoryPolicy, useSetMemoryPolicy,
} from "@/lib/graphql/hooks";
import { GraphQLRequestError } from "@/lib/graphql/client";
import type { MemoryRecord, MemoryRetrievalResult } from "@/lib/graphql/types";
import { t } from "@/lib/i18n/messages";
import { formatLocal } from "@/lib/utils";

const SCOPES = ["", "session", "user", "workspace", "tenant"];
const STATUSES = ["", "active", "quarantined", "expired", "deleted"];
const STATUS_VARIANT: Record<string, "success" | "warning" | "secondary" | "destructive"> = {
  active: "success",
  quarantined: "warning",
  expired: "secondary",
  deleted: "destructive",
};

export default function AdminMemoryPage() {
  return (
    <div>
      <PageHeader title={t("memory.title")} description={t("memory.subtitle")} />
      <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
        <div className="space-y-4">
          <MemoryBrowseCard />
          <RetrievalTesterCard />
        </div>
        <div className="space-y-4">
          <ErasureCard />
          <StatsCard />
        </div>
      </div>
      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <CorpusCard />
        <PolicyCard />
      </div>
    </div>
  );
}

function MemoryBrowseCard() {
  const [scope, setScope] = useState("");
  const [scopeRef, setScopeRef] = useState("");
  const [status, setStatus] = useState("");
  const [selected, setSelected] = useState<MemoryRecord | null>(null);

  const query = useMemories({
    scope: scope || undefined,
    scopeRef: scopeRef.trim() || undefined,
    status: status || undefined,
  });
  const rows = useMemo(() => query.data?.pages.flatMap((p) => p.nodes) ?? [], [query.data]);

  const columns: Column<MemoryRecord>[] = [
    { id: "scope", header: "Scope", width: 100, cell: (m) => <span className="font-mono text-xs">{m.scope}</span> },
    { id: "scopeRef", header: "Scope ref", width: 160, cell: (m) => <span className="truncate font-mono text-xs">{m.scopeRef}</span> },
    { id: "content", header: "Content", cell: (m) => <span className="truncate">{m.content}</span> },
    { id: "status", header: "Status", width: 110, cell: (m) => <Badge variant={STATUS_VARIANT[m.status] ?? "secondary"}>{m.status}</Badge> },
    { id: "confidence", header: "Confidence", width: 100, cell: (m) => m.confidence != null ? m.confidence.toFixed(2) : "—" },
    { id: "retrieved", header: "Retrieved", width: 90, cell: (m) => m.retrievalCount ?? 0 },
    { id: "ttl", header: "TTL expires", width: 170, cell: (m) => formatLocal(m.ttlExpiresAt) },
  ];

  return (
    <Can gate={FEATURE_GATES.browseMemory} fallback={<PermissionNotice />}>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm"><Brain className="size-4" aria-hidden />{t("memory.browse.title")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-end gap-2">
            <label className="flex flex-col gap-1 text-xs">
              <span className="text-muted-foreground">Scope</span>
              <select value={scope} onChange={(e) => setScope(e.target.value)} aria-label="Scope" className="h-8 rounded-md border border-input bg-background px-2 text-xs">
                {SCOPES.map((s) => <option key={s} value={s}>{s || "any"}</option>)}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-xs">
              <span className="text-muted-foreground">Scope ref (e.g. workspace id)</span>
              <Input value={scopeRef} onChange={(e) => setScopeRef(e.target.value)} aria-label="Scope ref" className="h-8 w-56 text-xs" />
            </label>
            <label className="flex flex-col gap-1 text-xs">
              <span className="text-muted-foreground">Status</span>
              <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status" className="h-8 rounded-md border border-input bg-background px-2 text-xs">
                {STATUSES.map((s) => <option key={s} value={s}>{s || "any"}</option>)}
              </select>
            </label>
          </div>

          <div className="grid gap-3 lg:grid-cols-[1fr_320px]">
            <AsyncBoundary
              isLoading={query.isLoading}
              isError={query.isError}
              error={query.error}
              isEmpty={rows.length === 0}
              emptyTitle={t("memory.browse.empty")}
              onRetry={() => query.refetch()}
            >
              <DataTable
                ariaLabel={t("memory.browse.title")}
                rows={rows}
                columns={columns}
                rowId={(m) => m.id}
                onRowActivate={(m) => setSelected(m)}
                hasMore={query.hasNextPage}
                isFetchingMore={query.isFetchingNextPage}
                onLoadMore={() => query.fetchNextPage()}
              />
            </AsyncBoundary>
            <MemoryDetail id={selected?.id ?? null} onClose={() => setSelected(null)} />
          </div>
        </CardContent>
      </Card>
    </Can>
  );
}

function MemoryDetail({ id, onClose }: { id: string | null; onClose: () => void }) {
  const query = useMemory(id);
  const m = query.data;

  if (!id) {
    return (
      <Card className="h-fit">
        <CardContent className="flex flex-col items-center gap-2 py-6 text-center text-sm text-muted-foreground">
          <Brain className="size-6" aria-hidden />
          <p>Select a memory record to view it.</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="h-fit">
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <CardTitle className="text-sm">Memory record</CardTitle>
        <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close"><X className="size-4" /></Button>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        {query.isLoading && <p className="text-muted-foreground">Loading…</p>}
        {m && (
          <>
            <p className="text-xs text-muted-foreground">
              {m.scope}/{m.scopeRef} · <Badge variant={STATUS_VARIANT[m.status] ?? "secondary"}>{m.status}</Badge>
            </p>
            {/* content is UNTRUSTED model input (BR-12) — rendered as plain text only. */}
            <p className="whitespace-pre-wrap rounded-md border bg-muted/30 p-2 text-xs">{m.content}</p>
            {m.tags.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {m.tags.map((tg) => <Badge key={tg} variant="secondary">{tg}</Badge>)}
              </div>
            )}
            {m.mergedFrom && m.mergedFrom.length > 0 && (
              <p className="text-xs text-muted-foreground">merged from {m.mergedFrom.length} record(s)</p>
            )}
            <p className="text-xs text-muted-foreground">retrieved {m.retrievalCount ?? 0} time(s)</p>
            {m.ttlExpiresAt && <p className="text-xs text-muted-foreground">expires {formatLocal(m.ttlExpiresAt)}</p>}
            <MemoryActions memory={m} onDeleted={onClose} />
          </>
        )}
      </CardContent>
    </Card>
  );
}

function MemoryActions({ memory, onDeleted }: { memory: MemoryRecord; onDeleted: () => void }) {
  const [editing, setEditing] = useState(false);
  const [content, setContent] = useState("");
  const [reason, setReason] = useState("");
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const update = useUpdateMemory();
  const remove = useDeleteMemory();
  const unquarantine = useUnquarantineMemory();
  const error = [update.error, remove.error, unquarantine.error].find(
    (e) => e instanceof GraphQLRequestError,
  ) as GraphQLRequestError | undefined;

  return (
    <div className="space-y-2 border-t pt-2">
      <Can gate={FEATURE_GATES.editMemory}>
        {editing ? (
          <form
            className="space-y-2"
            onSubmit={(e) => {
              e.preventDefault();
              update.mutate(
                { id: memory.id, content: content.trim() },
                { onSuccess: () => setEditing(false) },
              );
            }}
          >
            <Textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              aria-label="Memory content"
              className="min-h-20 text-xs"
            />
            <div className="flex gap-2">
              <Button type="submit" size="sm" disabled={!content.trim() || update.isPending}>Save</Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(false)}>Cancel</Button>
            </div>
          </form>
        ) : (
          <Button size="sm" variant="outline" onClick={() => { setContent(memory.content); setEditing(true); }}>
            Edit content
          </Button>
        )}
      </Can>

      {/* unquarantine only exists for quarantined rows; the downstream requires a reason. */}
      {memory.status === "quarantined" && (
        <Can gate={FEATURE_GATES.editMemory}>
          <form
            className="space-y-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (reason.trim()) {
                unquarantine.mutate({ id: memory.id, reason: reason.trim() }, { onSuccess: () => setReason("") });
              }
            }}
          >
            <label className="flex flex-col gap-1 text-xs">
              <span className="text-muted-foreground">Unquarantine reason (required, audited)</span>
              <Input value={reason} onChange={(e) => setReason(e.target.value)} aria-label="Unquarantine reason" className="h-8 text-xs" />
            </label>
            <Button type="submit" size="sm" variant="outline" disabled={!reason.trim() || unquarantine.isPending}>
              Unquarantine
            </Button>
          </form>
        </Can>
      )}

      <Can gate={FEATURE_GATES.deleteMemory}>
        <Button size="sm" variant="destructive" onClick={() => setConfirmingDelete(true)} disabled={remove.isPending}>
          Delete record
        </Button>
        <ConfirmDialog
          open={confirmingDelete}
          onOpenChange={setConfirmingDelete}
          title={t("memory.delete.confirmTitle")}
          description={t("memory.delete.confirmDescription")}
          confirmLabel="Delete record"
          destructive
          onConfirm={() => {
            setConfirmingDelete(false);
            remove.mutate(memory.id, { onSuccess: onDeleted });
          }}
        />
      </Can>

      {error && <p className="text-xs text-destructive">{error.message}</p>}
    </div>
  );
}

function ErasureCard() {
  const [subjectId, setSubjectId] = useState("");
  const [subjectType, setSubjectType] = useState("user");
  const [confirming, setConfirming] = useState(false);
  const [operationId, setOperationId] = useState<string | null>(null);
  const erase = useRequestMemoryErasure();
  const error = erase.error instanceof GraphQLRequestError ? erase.error : null;
  const status = useErasure(operationId, {
    refetchInterval: (q) => {
      const s = q.state.data?.status;
      return s === "received" || s === "running" || s === "verifying" ? 2000 : false;
    },
  });

  return (
    <Can gate={FEATURE_GATES.requestMemoryErasure} fallback={<PermissionNotice compact />}>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm"><ShieldAlert className="size-4" aria-hidden />{t("memory.erasure.title")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <p className="text-xs text-muted-foreground">{t("memory.erasure.description")}</p>
          <form
            className="space-y-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (subjectId.trim()) setConfirming(true);
            }}
          >
            <label className="flex flex-col gap-1 text-xs">
              <span className="text-muted-foreground">Subject type</span>
              <select value={subjectType} onChange={(e) => setSubjectType(e.target.value)} aria-label="Subject type" className="h-8 rounded-md border border-input bg-background px-2 text-xs">
                <option value="user">user</option>
              </select>
            </label>
            <label className="flex flex-col gap-1 text-xs">
              <span className="text-muted-foreground">Subject id</span>
              <Input value={subjectId} onChange={(e) => setSubjectId(e.target.value)} aria-label="Subject id" className="h-8 text-xs" />
            </label>
            <Button type="submit" size="sm" variant="destructive" disabled={!subjectId.trim() || erase.isPending}>
              {t("memory.erasure.request")}
            </Button>
            {error && <p className="text-xs text-destructive">{error.message}</p>}
          </form>

          {operationId && (
            <div className="rounded-md border p-2 text-xs">
              <p>
                operation <span className="font-mono">{operationId}</span> ·{" "}
                <Badge variant={status.data?.status === "completed" ? "success" : status.data?.status === "failed" ? "destructive" : "warning"}>
                  {status.data?.status ?? "…"}
                </Badge>
              </p>
              {status.data?.completedAt && <p className="mt-1 text-muted-foreground">completed {formatLocal(status.data.completedAt)}</p>}
            </div>
          )}
        </CardContent>

        <ConfirmDialog
          open={confirming}
          onOpenChange={setConfirming}
          title={t("memory.erasure.confirmTitle")}
          description={t("memory.erasure.confirmDescription")}
          confirmLabel={t("memory.erasure.request")}
          confirmPhrase={subjectId.trim()}
          destructive
          onConfirm={() => {
            setConfirming(false);
            erase.mutate(
              { subjectId: subjectId.trim(), subjectType },
              { onSuccess: (r) => setOperationId(r.operationId) },
            );
          }}
        />
      </Card>
    </Can>
  );
}

function StatsCard() {
  const query = useMemoryStats();
  return (
    <Can gate={FEATURE_GATES.viewMemoryStats}>
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">{t("memory.stats.title")}</CardTitle>
        </CardHeader>
        <CardContent className="text-xs">
          {query.isLoading && <p className="text-muted-foreground">Loading…</p>}
          {query.isError && <p className="text-destructive">Failed to load stats.</p>}
          {query.data && (
            <dl className="space-y-1">
              {Object.entries(query.data as Record<string, unknown>).map(([k, v]) => (
                <div key={k} className="flex justify-between gap-2">
                  <dt className="text-muted-foreground">{k}</dt>
                  <dd className="font-mono">{typeof v === "object" ? JSON.stringify(v) : String(v)}</dd>
                </div>
              ))}
            </dl>
          )}
        </CardContent>
      </Card>
    </Can>
  );
}

function RetrievalTesterCard() {
  const [queryText, setQueryText] = useState("");
  const [scopes, setScopes] = useState<string[]>(["user"]);
  const [workspaceRef, setWorkspaceRef] = useState("");
  const [corpora, setCorpora] = useState("");
  const [topK, setTopK] = useState("8");
  const [result, setResult] = useState<MemoryRetrievalResult | null>(null);
  const test = useMemoryRetrievalTest();
  const error = test.error instanceof GraphQLRequestError ? test.error : null;

  const toggleScope = (s: string) =>
    setScopes((prev) => (prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]));

  const canRun = queryText.trim().length > 0 && scopes.length + (corpora.trim() ? 1 : 0) > 0
    && (!scopes.includes("workspace") || workspaceRef.trim().length > 0);

  return (
    <Can gate={FEATURE_GATES.browseMemory}>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm"><Search className="size-4" aria-hidden />{t("memory.retrieve.title")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <p className="text-xs text-muted-foreground">
            Preview what the agent would recall for a query — scope-filtered retrieval against live memory and RAG corpora.
          </p>
          <form
            className="space-y-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (!canRun) return;
              test.mutate(
                {
                  queryText: queryText.trim(),
                  scopes,
                  scopeRefs: scopes.includes("workspace") ? { workspace: workspaceRef.trim() } : undefined,
                  corpora: corpora.trim() ? corpora.split(",").map((c) => c.trim()).filter(Boolean) : undefined,
                  topK: Number(topK) || 8,
                },
                { onSuccess: setResult },
              );
            }}
          >
            <label className="flex flex-col gap-1 text-xs">
              <span className="text-muted-foreground">Query text</span>
              <Input value={queryText} onChange={(e) => setQueryText(e.target.value)} aria-label="Query text" className="h-8 text-xs" />
            </label>
            <div className="flex flex-wrap items-end gap-3">
              <fieldset className="flex items-center gap-3 text-xs">
                <legend className="mb-1 text-muted-foreground">Scopes</legend>
                {["user", "workspace", "tenant"].map((s) => (
                  <label key={s} className="flex items-center gap-1">
                    <input type="checkbox" checked={scopes.includes(s)} onChange={() => toggleScope(s)} aria-label={`Scope ${s}`} />
                    {s}
                  </label>
                ))}
              </fieldset>
              {scopes.includes("workspace") && (
                <label className="flex flex-col gap-1 text-xs">
                  <span className="text-muted-foreground">Workspace id</span>
                  <Input value={workspaceRef} onChange={(e) => setWorkspaceRef(e.target.value)} aria-label="Workspace id" className="h-8 w-40 text-xs" />
                </label>
              )}
              <label className="flex flex-col gap-1 text-xs">
                <span className="text-muted-foreground">Corpora (comma-separated)</span>
                <Input value={corpora} onChange={(e) => setCorpora(e.target.value)} aria-label="Corpora" className="h-8 w-44 text-xs" />
              </label>
              <label className="flex flex-col gap-1 text-xs">
                <span className="text-muted-foreground">Top K</span>
                <Input type="number" min={1} max={50} value={topK} onChange={(e) => setTopK(e.target.value)} aria-label="Top K" className="h-8 w-20 text-xs" />
              </label>
              <Button type="submit" size="sm" disabled={!canRun || test.isPending}>
                {test.isPending ? "Running…" : "Run retrieval"}
              </Button>
            </div>
            {error && <p className="text-xs text-destructive">{error.message}</p>}
          </form>

          {result && (
            <div className="space-y-2">
              {result.degraded && (
                <Badge variant="warning">degraded — retrieval ran in a reduced mode</Badge>
              )}
              {result.hits.length === 0 && (
                <p className="text-xs text-muted-foreground">{t("memory.retrieve.empty")}</p>
              )}
              <ol className="space-y-2">
                {result.hits.map((h, i) => (
                  <li key={h.memoryId ?? h.chunkId ?? i} className="rounded-md border p-2 text-xs">
                    <p className="flex flex-wrap items-center gap-2">
                      <span className="font-mono">#{i + 1}</span>
                      <Badge variant={h.kind === "memory" ? "secondary" : "outline"}>{h.kind}</Badge>
                      <span className="font-mono">{h.score.toFixed(4)}</span>
                      {h.kind === "memory" ? (
                        <span className="text-muted-foreground">{h.scope} · {h.memoryId}</span>
                      ) : (
                        <span className="text-muted-foreground">{h.corpus} · {h.sourceUrn}</span>
                      )}
                    </p>
                    {/* hit content is UNTRUSTED model input (BR-12) — plain text only. */}
                    <p className="mt-1 whitespace-pre-wrap rounded-md bg-muted/30 p-2">{h.content}</p>
                  </li>
                ))}
              </ol>
            </div>
          )}
        </CardContent>
      </Card>
    </Can>
  );
}

function CorpusCard() {
  const [keyInput, setKeyInput] = useState("docs");
  const [corpusKey, setCorpusKey] = useState<string | null>(null);
  const [rebuildVer, setRebuildVer] = useState("");
  const [newKey, setNewKey] = useState("");
  const [newVer, setNewVer] = useState("");
  const status = useCorpusStatus(corpusKey);
  const patch = useUpdateCorpus();
  const rebuild = useRebuildCorpus();
  const register = useRegisterCorpus();
  const error = [patch.error, rebuild.error, register.error].find(
    (e) => e instanceof GraphQLRequestError,
  ) as GraphQLRequestError | undefined;
  const s = status.data;

  return (
    <Can gate={FEATURE_GATES.manageMemoryCorpora}>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm"><Database className="size-4" aria-hidden />{t("memory.corpora.title")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <form
            className="flex items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (keyInput.trim()) setCorpusKey(keyInput.trim());
            }}
          >
            <label className="flex flex-col gap-1 text-xs">
              <span className="text-muted-foreground">Corpus key</span>
              <Input value={keyInput} onChange={(e) => setKeyInput(e.target.value)} aria-label="Corpus key" className="h-8 w-44 text-xs" />
            </label>
            <Button type="submit" size="sm" variant="outline" disabled={!keyInput.trim()}>Load status</Button>
          </form>

          {corpusKey && status.isLoading && <p className="text-xs text-muted-foreground">Loading…</p>}
          {corpusKey && !status.isLoading && !s && !status.isError && (
            <p className="text-xs text-muted-foreground">Corpus <span className="font-mono">{corpusKey}</span> is not registered.</p>
          )}
          {status.isError && <p className="text-xs text-destructive">Failed to load corpus status.</p>}

          {s && (
            <div className="space-y-2 rounded-md border p-2 text-xs">
              <p className="flex flex-wrap items-center gap-2">
                <span className="font-mono">{s.corpusKey}</span>
                <Badge variant={s.status === "active" ? "success" : s.status === "rebuilding" ? "warning" : "secondary"}>{s.status}</Badge>
                <span className="text-muted-foreground">embedding {s.activeEmbeddingVer}</span>
                <span className="text-muted-foreground">{s.chunkCount} chunk(s)</span>
              </p>
              <div className="flex flex-wrap items-end gap-2">
                {s.status !== "rebuilding" && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={patch.isPending}
                    onClick={() =>
                      patch.mutate({
                        corpusKey: String(s.corpusKey),
                        patch: { status: s.status === "paused" ? "active" : "paused" },
                      })
                    }
                  >
                    {s.status === "paused" ? "Resume ingestion" : "Pause ingestion"}
                  </Button>
                )}
                <label className="flex flex-col gap-1 text-xs">
                  <span className="text-muted-foreground">New embedding version</span>
                  <Input value={rebuildVer} onChange={(e) => setRebuildVer(e.target.value)} aria-label="New embedding version" className="h-8 w-36 text-xs" />
                </label>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!rebuildVer.trim() || rebuildVer.trim() === s.activeEmbeddingVer || rebuild.isPending}
                  onClick={() =>
                    rebuild.mutate(
                      { corpusKey: String(s.corpusKey), embeddingModelVer: rebuildVer.trim() },
                      { onSuccess: () => setRebuildVer("") },
                    )
                  }
                >
                  {rebuild.isPending ? "Rebuilding…" : "Rebuild"}
                </Button>
              </div>
              {rebuild.data && (
                <p className="text-muted-foreground">
                  Re-embedded {rebuild.data.chunksReembedded} chunk(s) under {rebuild.data.activeEmbeddingVer};
                  dropped {rebuild.data.oldChunksDropped} old vector(s).
                </p>
              )}
            </div>
          )}

          <form
            className="flex flex-wrap items-end gap-2 border-t pt-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (!newKey.trim()) return;
              register.mutate(
                { corpusKey: newKey.trim(), embeddingModelVer: newVer.trim() || undefined },
                {
                  onSuccess: (c) => {
                    setNewKey("");
                    setNewVer("");
                    setKeyInput(String(c.corpusKey));
                    setCorpusKey(String(c.corpusKey));
                  },
                },
              );
            }}
          >
            <label className="flex flex-col gap-1 text-xs">
              <span className="text-muted-foreground">Register corpus key</span>
              <Input value={newKey} onChange={(e) => setNewKey(e.target.value)} aria-label="Register corpus key" className="h-8 w-40 text-xs" />
            </label>
            <label className="flex flex-col gap-1 text-xs">
              <span className="text-muted-foreground">Embedding version (optional)</span>
              <Input value={newVer} onChange={(e) => setNewVer(e.target.value)} aria-label="Embedding version" className="h-8 w-36 text-xs" />
            </label>
            <Button type="submit" size="sm" disabled={!newKey.trim() || register.isPending}>Register</Button>
          </form>

          {error && <p className="text-xs text-destructive">{error.message}</p>}
        </CardContent>
      </Card>
    </Can>
  );
}

function PolicyCard() {
  const query = useMemoryPolicy();
  const save = useSetMemoryPolicy();
  const [editing, setEditing] = useState(false);
  const [ttlOverrides, setTtlOverrides] = useState("{}");
  const [piiClasses, setPiiClasses] = useState("");
  const [injectionProfile, setInjectionProfile] = useState("standard");
  const [corpusFlags, setCorpusFlags] = useState("{}");
  const [parseError, setParseError] = useState<string | null>(null);
  const error = save.error instanceof GraphQLRequestError ? save.error : null;
  const p = query.data;

  const startEdit = () => {
    if (!p) return;
    setTtlOverrides(JSON.stringify(p.ttlOverrides ?? {}, null, 2));
    setPiiClasses((p.piiClasses ?? []).join(", "));
    setInjectionProfile(p.injectionProfile);
    setCorpusFlags(JSON.stringify(p.corpusFlags ?? {}, null, 2));
    setParseError(null);
    setEditing(true);
  };

  const submit = () => {
    let ttl: Record<string, string>;
    let flags: Record<string, boolean>;
    try {
      ttl = JSON.parse(ttlOverrides || "{}");
      flags = JSON.parse(corpusFlags || "{}");
    } catch {
      setParseError("TTL overrides and corpus flags must be valid JSON objects.");
      return;
    }
    setParseError(null);
    save.mutate(
      {
        ttlOverrides: ttl,
        piiClasses: piiClasses.split(",").map((c) => c.trim()).filter(Boolean),
        injectionProfile,
        corpusFlags: flags,
      },
      { onSuccess: () => setEditing(false) },
    );
  };

  return (
    <Can gate={FEATURE_GATES.viewMemoryPolicy}>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm"><ScrollText className="size-4" aria-hidden />{t("memory.policy.title")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          {query.isLoading && <p className="text-xs text-muted-foreground">Loading…</p>}
          {query.isError && <p className="text-xs text-destructive">Failed to load policy.</p>}

          {p && !editing && (
            <>
              <dl className="space-y-1 text-xs">
                <div className="flex justify-between gap-2">
                  <dt className="text-muted-foreground">Injection profile</dt>
                  <dd className="font-mono">{p.injectionProfile}</dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt className="text-muted-foreground">PII classes</dt>
                  <dd className="font-mono">{p.piiClasses.length > 0 ? p.piiClasses.join(", ") : "—"}</dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt className="text-muted-foreground">TTL overrides</dt>
                  <dd className="font-mono">{JSON.stringify(p.ttlOverrides ?? {})}</dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt className="text-muted-foreground">Corpus flags</dt>
                  <dd className="font-mono">{JSON.stringify(p.corpusFlags ?? {})}</dd>
                </div>
              </dl>
              <Can gate={FEATURE_GATES.editMemoryPolicy}>
                <Button size="sm" variant="outline" onClick={startEdit}>Edit policy</Button>
              </Can>
            </>
          )}

          {editing && (
            <form
              className="space-y-2"
              onSubmit={(e) => {
                e.preventDefault();
                submit();
              }}
            >
              <label className="flex flex-col gap-1 text-xs">
                <span className="text-muted-foreground">Injection profile</span>
                <select value={injectionProfile} onChange={(e) => setInjectionProfile(e.target.value)} aria-label="Injection profile" className="h-8 rounded-md border border-input bg-background px-2 text-xs">
                  <option value="standard">standard</option>
                  <option value="strict">strict</option>
                </select>
              </label>
              <label className="flex flex-col gap-1 text-xs">
                <span className="text-muted-foreground">PII classes (comma-separated)</span>
                <Input value={piiClasses} onChange={(e) => setPiiClasses(e.target.value)} aria-label="PII classes" className="h-8 text-xs" />
              </label>
              <label className="flex flex-col gap-1 text-xs">
                <span className="text-muted-foreground">TTL overrides (scope → ISO-8601 duration, JSON)</span>
                <Textarea value={ttlOverrides} onChange={(e) => setTtlOverrides(e.target.value)} aria-label="TTL overrides" className="min-h-16 font-mono text-xs" />
              </label>
              <label className="flex flex-col gap-1 text-xs">
                <span className="text-muted-foreground">Corpus flags (corpus key → enabled, JSON)</span>
                <Textarea value={corpusFlags} onChange={(e) => setCorpusFlags(e.target.value)} aria-label="Corpus flags" className="min-h-16 font-mono text-xs" />
              </label>
              <p className="text-xs text-muted-foreground">
                Saving replaces the whole policy document — omitted fields reset to defaults.
              </p>
              <div className="flex gap-2">
                <Button type="submit" size="sm" disabled={save.isPending}>{save.isPending ? "Saving…" : "Save policy"}</Button>
                <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(false)}>Cancel</Button>
              </div>
              {parseError && <p className="text-xs text-destructive">{parseError}</p>}
              {error && <p className="text-xs text-destructive">{error.message}</p>}
            </form>
          )}
        </CardContent>
      </Card>
    </Can>
  );
}

function PermissionNotice({ compact }: { compact?: boolean }) {
  return (
    <Card>
      <CardContent className={compact ? "py-3 text-xs text-muted-foreground" : "py-6 text-center text-sm text-muted-foreground"}>
        You don&apos;t have permission to view this section.
      </CardContent>
    </Card>
  );
}
