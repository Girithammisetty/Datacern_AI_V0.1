/**
 * memory-service REST client (MEM-FR-010/011/020/030/031/033/040/050/051/052).
 * Backs: memory browse/search, single-record view, governed memory writes/edits
 * (write, batch, edit, delete, unquarantine), the scope-filtered retrieval
 * tester, RAG corpus admin (register/patch/status/rebuild/doc push), the tenant
 * memory policy (get/put), right-to-be-forgotten erasure (start + status poll),
 * and tenant memory stats. Pure passthrough — the caller's JWT is forwarded
 * verbatim and memory-service enforces memory.memory.{create,read,update,delete}
 * / memory.corpus.admin / memory.policy.{read,update} /
 * memory.erasure.{create,read} / memory.stats.read.
 */
import { ServiceClient } from "./base.js";
import { unwrap, type Page } from "./types.js";

/** memory-service _memory_view row. status: active|quarantined|expired|deleted.
 * scope: session|user|workspace|tenant. `merged_from`/`revalidate_at` are only
 * present on the single-record (full=True) GET, not the browse list. */
export interface MemoryRecordDTO {
  memory_id: string;
  scope: string;
  scope_ref: string;
  content: string;
  confidence?: number | null;
  status: string;
  tags: string[];
  provenance?: unknown;
  retrieval_count?: number;
  classifier_score?: number | null;
  ttl_expires_at?: string | null;
  merged_from?: string[] | null;
  revalidate_at?: string | null;
}

export interface BrowseMemoriesParams {
  scope?: string;
  scopeRef?: string;
  status?: string;
  tags?: string[];
  limit: number;
  cursor?: string;
}

/** admin-service ErasureRequest. status: received|running|verifying|completed|failed. */
export interface ErasureRequestDTO {
  operation_id: string;
  status: string;
  report?: Record<string, unknown> | null;
  completed_at?: string | null;
}

/** memory-service ProvenanceIn. source_type: agent_run|user_explicit|tool_output|admin. */
export interface MemoryProvenanceDTO {
  source_type: string;
  run_id?: string | null;
  agent_key?: string | null;
  agent_version?: string | null;
  user_id?: string | null;
  tool_id?: string | null;
}

export interface WriteMemoryParams {
  scope: string;
  scopeRef: string;
  content: string;
  provenance: MemoryProvenanceDTO;
  confidence?: number;
  tags?: string[];
}

/** WriteResult from POST /memories (status: active|quarantined|queued; `queued`
 * means embedding was unavailable and the write is degraded-queued). Batch rows
 * add status "rejected" with `code`/`message` and omit `session`. */
export interface MemoryWriteResultDTO {
  memory_id?: string | null;
  status: string;
  merged?: boolean;
  session?: boolean;
  code?: string;
  message?: string;
}

export interface RetrieveParams {
  queryText?: string;
  scopes: string[];
  /** scope -> scope_ref (only `workspace` needs one; user/tenant refs are
   * server-resolved from the caller's principal). */
  scopeRefs?: Record<string, string>;
  corpora?: string[];
  topK?: number;
  minConfidence?: number;
  tags?: string[];
  snapshotVer?: string;
  includeDebug?: boolean;
}

/** One ranked hit from POST /retrieve. kind "memory" carries scope/memory_id/
 * provenance; kind "chunk" carries corpus/chunk_id/source_urn/snapshot_ver.
 * content_disposition is always "untrusted" (BR-12). */
export interface RetrievalItemDTO {
  kind: string;
  content: string;
  score: number;
  content_disposition: string;
  scope?: string;
  memory_id?: string;
  provenance?: unknown;
  corpus?: string;
  chunk_id?: string;
  source_urn?: string;
  snapshot_ver?: string | null;
  debug?: unknown;
}

export interface RetrieveResultDTO {
  data: RetrievalItemDTO[];
  degraded?: boolean;
}

/** corpus-route _corpus_view. status: active|paused|rebuilding. */
export interface RagCorpusDTO {
  corpus_key: string;
  source?: Record<string, unknown> | null;
  chunking?: Record<string, unknown> | null;
  active_embedding_ver: string;
  refresh?: Record<string, unknown> | null;
  anonymization_profile?: Record<string, unknown> | null;
  status: string;
}

export interface RegisterCorpusParams {
  corpusKey: string;
  source?: Record<string, unknown>;
  chunking?: Record<string, unknown>;
  embeddingModelVer?: string;
  refresh?: Record<string, unknown>;
  anonymizationProfile?: Record<string, unknown>;
}

export interface PatchCorpusParams {
  source?: Record<string, unknown>;
  chunking?: Record<string, unknown>;
  refresh?: Record<string, unknown>;
  anonymizationProfile?: Record<string, unknown>;
  status?: string;
}

/** CorpusService.status dict (GET /corpora/{key}/status). */
export interface CorpusStatusDTO {
  corpus_key: string;
  status: string;
  active_embedding_ver: string;
  chunk_count: number;
}

/** CorpusService.rebuild report (POST /corpora/{key}/rebuild, 202). */
export interface CorpusRebuildReportDTO {
  corpus_key: string;
  active_embedding_ver: string;
  chunks_reembedded: number;
  old_chunks_dropped: number;
}

/** Tenant memory policy (GET/PUT /policies/self). */
export interface MemoryPolicyDTO {
  ttl_overrides: Record<string, string>;
  pii_classes: string[];
  injection_profile: string;
  corpus_flags: Record<string, boolean>;
}

export class MemoryClient {
  constructor(private readonly http: ServiceClient) {}

  /** GET /memories — browse/search (the "what does the agent know about this
   * workspace" surface). Needs memory.memory.read. */
  browse(p: BrowseMemoriesParams): Promise<Page<MemoryRecordDTO>> {
    return this.http.get<Page<MemoryRecordDTO>>("/api/v1/memories", {
      query: {
        scope: p.scope,
        scope_ref: p.scopeRef,
        "filter[status]": p.status,
        "filter[tags]": p.tags?.join(","),
        limit: p.limit,
        cursor: p.cursor,
      },
    });
  }

  /** GET /memories/{id} — single record, full detail. Needs memory.memory.read. */
  async memory(id: string): Promise<MemoryRecordDTO> {
    const r = await this.http.get<{ data: MemoryRecordDTO } | MemoryRecordDTO>(
      `/api/v1/memories/${encodeURIComponent(id)}`,
    );
    return unwrap<MemoryRecordDTO>(r);
  }

  /** POST /erasure (202) — start a right-to-be-forgotten erasure for a subject
   * (default subject_type "user"). Needs memory.erasure.create. */
  async startErasure(subjectId: string, subjectType = "user"): Promise<ErasureRequestDTO> {
    const r = await this.http.post<{ data: ErasureRequestDTO } | ErasureRequestDTO>(
      "/api/v1/erasure",
      { body: { subject_type: subjectType, subject_id: subjectId } },
    );
    return unwrap<ErasureRequestDTO>(r);
  }

  /** GET /erasure/{request_id} — poll erasure status/report. Needs memory.erasure.read. */
  async erasure(requestId: string): Promise<ErasureRequestDTO> {
    const r = await this.http.get<{ data: ErasureRequestDTO } | ErasureRequestDTO>(
      `/api/v1/erasure/${encodeURIComponent(requestId)}`,
    );
    return unwrap<ErasureRequestDTO>(r);
  }

  /** GET /stats — tenant memory stats (opaque dict; passed through as JSON).
   * Needs memory.stats.read. */
  async stats(): Promise<Record<string, unknown>> {
    const r = await this.http.get<{ data: Record<string, unknown> } | Record<string, unknown>>(
      "/api/v1/stats",
    );
    return unwrap<Record<string, unknown>>(r);
  }

  /** POST /memories — governed single write. Needs memory.memory.create;
   * tenant-scope writes additionally need memory.corpus.admin downstream. */
  async writeMemory(p: WriteMemoryParams): Promise<MemoryWriteResultDTO> {
    const r = await this.http.post<{ data: MemoryWriteResultDTO } | MemoryWriteResultDTO>(
      "/api/v1/memories",
      {
        body: {
          scope: p.scope, scope_ref: p.scopeRef, content: p.content,
          provenance: p.provenance, confidence: p.confidence, tags: p.tags ?? [],
        },
      },
    );
    return unwrap<MemoryWriteResultDTO>(r);
  }

  /** POST /memories/batch — per-item results (rejected items carry code/message
   * instead of failing the batch). Needs memory.memory.create. */
  async writeMemoryBatch(items: WriteMemoryParams[]): Promise<MemoryWriteResultDTO[]> {
    const r = await this.http.post<{ data: MemoryWriteResultDTO[] }>(
      "/api/v1/memories/batch",
      {
        body: {
          items: items.map((p) => ({
            scope: p.scope, scope_ref: p.scopeRef, content: p.content,
            provenance: p.provenance, confidence: p.confidence, tags: p.tags ?? [],
          })),
        },
      },
    );
    return r.data;
  }

  /** PATCH /memories/{id} — edit a record's content (audited downstream);
   * returns the full record. Needs memory.memory.update. */
  async editMemory(id: string, content: string): Promise<MemoryRecordDTO> {
    const r = await this.http.patch<{ data: MemoryRecordDTO } | MemoryRecordDTO>(
      `/api/v1/memories/${encodeURIComponent(id)}`,
      { body: { content } },
    );
    return unwrap<MemoryRecordDTO>(r);
  }

  /** DELETE /memories/{id} (204). Needs memory.memory.delete. */
  async deleteMemory(id: string): Promise<void> {
    await this.http.delete<void>(`/api/v1/memories/${encodeURIComponent(id)}`);
  }

  /** POST /memories/{id}/unquarantine — release a quarantined record back to
   * active; `reason` is REQUIRED downstream. Needs memory.memory.update. */
  async unquarantine(id: string, reason: string): Promise<MemoryRecordDTO> {
    const r = await this.http.post<{ data: MemoryRecordDTO } | MemoryRecordDTO>(
      `/api/v1/memories/${encodeURIComponent(id)}/unquarantine`,
      { body: { reason } },
    );
    return unwrap<MemoryRecordDTO>(r);
  }

  /** POST /retrieve — scope-filtered ANN retrieval ("what would the agent
   * recall"). Returns the raw envelope because the top-level `degraded` flag
   * rides beside `data`. Needs memory.memory.read. */
  retrieve(p: RetrieveParams): Promise<RetrieveResultDTO> {
    return this.http.post<RetrieveResultDTO>("/api/v1/retrieve", {
      body: {
        query_text: p.queryText, scopes: p.scopes, scope_refs: p.scopeRefs ?? {},
        corpora: p.corpora ?? [], top_k: p.topK ?? 8,
        min_confidence: p.minConfidence, tags: p.tags,
        snapshot_ver: p.snapshotVer, include_debug: p.includeDebug ?? false,
      },
    });
  }

  /** POST /corpora (201) — register a RAG corpus. Needs memory.corpus.admin. */
  async registerCorpus(p: RegisterCorpusParams): Promise<RagCorpusDTO> {
    const r = await this.http.post<{ data: RagCorpusDTO } | RagCorpusDTO>("/api/v1/corpora", {
      body: {
        corpus_key: p.corpusKey, source: p.source, chunking: p.chunking,
        embedding_model_ver: p.embeddingModelVer, refresh: p.refresh,
        anonymization_profile: p.anonymizationProfile,
      },
    });
    return unwrap<RagCorpusDTO>(r);
  }

  /** PATCH /corpora/{key} — patch source/chunking/refresh/anonymization/status.
   * Needs memory.corpus.admin. */
  async patchCorpus(corpusKey: string, p: PatchCorpusParams): Promise<RagCorpusDTO> {
    const r = await this.http.patch<{ data: RagCorpusDTO } | RagCorpusDTO>(
      `/api/v1/corpora/${encodeURIComponent(corpusKey)}`,
      {
        body: {
          source: p.source, chunking: p.chunking, refresh: p.refresh,
          anonymization_profile: p.anonymizationProfile, status: p.status,
        },
      },
    );
    return unwrap<RagCorpusDTO>(r);
  }

  /** GET /corpora/{key}/status — status + chunk count. Needs memory.corpus.admin. */
  async corpusStatus(corpusKey: string): Promise<CorpusStatusDTO> {
    const r = await this.http.get<{ data: CorpusStatusDTO } | CorpusStatusDTO>(
      `/api/v1/corpora/${encodeURIComponent(corpusKey)}/status`,
    );
    return unwrap<CorpusStatusDTO>(r);
  }

  /** POST /corpora/{key}/rebuild (202) — re-embed under a NEW embedding model
   * version (409 if unchanged or already rebuilding). Needs memory.corpus.admin. */
  async rebuildCorpus(corpusKey: string, embeddingModelVer: string): Promise<CorpusRebuildReportDTO> {
    const r = await this.http.post<{ data: CorpusRebuildReportDTO } | CorpusRebuildReportDTO>(
      `/api/v1/corpora/${encodeURIComponent(corpusKey)}/rebuild`,
      { body: { embedding_model_ver: embeddingModelVer } },
    );
    return unwrap<CorpusRebuildReportDTO>(r);
  }

  /** POST /corpora/docs/documents (201) — push a document into the "docs"
   * corpus (replaces prior chunks for the source_urn). Needs memory.corpus.admin. */
  async pushDocument(sourceUrn: string, content: string): Promise<{ source_urn: string; chunks: number }> {
    const r = await this.http.post<
      { data: { source_urn: string; chunks: number } } | { source_urn: string; chunks: number }
    >("/api/v1/corpora/docs/documents", { body: { source_urn: sourceUrn, content } });
    return unwrap<{ source_urn: string; chunks: number }>(r);
  }

  /** GET /policies/self — the tenant's memory PII/retention policy.
   * Needs memory.policy.read. */
  async policy(): Promise<MemoryPolicyDTO> {
    const r = await this.http.get<{ data: MemoryPolicyDTO } | MemoryPolicyDTO>(
      "/api/v1/policies/self",
    );
    return unwrap<MemoryPolicyDTO>(r);
  }

  /** PUT /policies/self — replace the tenant policy (full-document PUT, not a
   * merge: omitted fields reset to downstream defaults). Needs memory.policy.update. */
  async setPolicy(p: {
    ttlOverrides?: Record<string, string>;
    piiClasses?: string[];
    injectionProfile?: string;
    corpusFlags?: Record<string, boolean>;
  }): Promise<MemoryPolicyDTO> {
    const r = await this.http.put<{ data: MemoryPolicyDTO } | MemoryPolicyDTO>(
      "/api/v1/policies/self",
      {
        body: {
          ttl_overrides: p.ttlOverrides ?? {},
          pii_classes: p.piiClasses ?? [],
          injection_profile: p.injectionProfile ?? "standard",
          corpus_flags: p.corpusFlags ?? {},
        },
      },
    );
    return unwrap<MemoryPolicyDTO>(r);
  }
}
