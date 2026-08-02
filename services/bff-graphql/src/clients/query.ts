/** query-service REST client (BRD 06, Go service on :8085). Backs: SavedQuery,
 * ad-hoc SQL execution + results.
 *
 * Pure passthrough — the caller's JWT is forwarded verbatim by ServiceClient and
 * query-service enforces every `query.*` action guard (query.query.read,
 * query.execution.execute, ...). The BFF makes no authz/business decision here
 * (BFF-FR-003/010/011). */
import { ServiceClient } from "./base.js";
import { unwrap, type Page } from "./types.js";

export interface SavedQueryDTO {
  id: string;
  workspace_id?: string | null;
  name: string;
  description?: string | null;
  current_version_no?: number;
  version_no?: number;
  tags?: string[];
  module_names?: string[];
  sql_text?: string;
  variables?: unknown;
  dataset_refs?: unknown;
  created_by?: string;
  created_at?: string;
  updated_at?: string;
}

/** An execution resource (POST /sql/run, POST /queries/{id}/run). */
export interface ExecutionDTO {
  id?: string;
  execution_id?: string;
  status?: string;
  engine?: string;
  cache_hit?: boolean;
  saved_query_id?: string | null;
  query_version_no?: number | null;
  routing_reason?: string | null;
  trace_id?: string;
  created_at?: string;
  started_at?: string | null;
  finished_at?: string | null;
  error?: unknown;
  stats?: {
    actual_scan_bytes?: number | null;
    result_rows?: number | null;
    result_bytes?: number | null;
    duration_ms?: number | null;
  } | null;
  plan?: Record<string, unknown> | null;
  warnings?: unknown;
}

/** A page of tabular results (GET /executions/{id}/results). */
export interface ResultsDTO {
  columns?: { name?: string; type?: string }[] | string[];
  rows?: unknown[][];
  page?: { next_cursor?: string | null; has_more?: boolean };
  stats?: {
    result_rows?: number | null;
    actual_scan_bytes?: number | null;
    duration_ms?: number | null;
    engine?: string | null;
    cache_hit?: boolean | null;
  } | null;
  warnings?: unknown;
}

/** One immutable saved-query version (GET /queries/{id}/versions). */
export interface SavedQueryVersionDTO {
  id: string;
  saved_query_id?: string;
  version_no: number;
  sql_text?: string;
  variables?: unknown;
  dataset_refs?: unknown;
  created_by?: string;
  created_at?: string;
}

/** Typed variable declaration (query-service domain.VariableDecl, QRY-FR-002). */
export interface VariableDeclBody {
  name: string;
  type: string; // string | integer | decimal | boolean | date | timestamp | string_list | integer_list
  required?: boolean;
  default?: unknown;
  allowed_values?: unknown[];
  min?: number;
  max?: number;
}

/** POST /queries and PATCH /queries/{id} body (handlers_queries.go savedQueryReq).
 * All fields are pointers server-side; PATCH omissions leave fields unchanged. */
export interface SavedQueryBody {
  name?: string;
  description?: string;
  workspace_id?: string;
  sql_text?: string;
  variables?: VariableDeclBody[];
  tags?: string[];
  module_names?: string[];
}

/** One row of GET /stats/queries (store.QueryStat, QRY-FR-081). */
export interface QueryStatDTO {
  sql_fingerprint: string;
  executions: number;
  total_scan_bytes: number;
  failures: number;
  top_user?: string;
}

export interface ExecutionListParams {
  limit: number;
  cursor?: string;
  status?: string;
  savedQueryId?: string;
  since?: string;
  sort?: string;
}

export interface SavedQueryListParams {
  limit: number;
  cursor?: string;
  workspaceId?: string;
}

export interface RunSQLBody {
  sql: string;
  /** sync returns 200 with a terminal execution; async returns 202. */
  mode?: "sync" | "async";
  limit?: number;
  workspace_id?: string;
  engine_hint?: string;
  cache?: boolean;
}

/** Effective execution ceilings (query-service domain.Ceilings). */
export interface CeilingsDTO {
  max_scan_bytes?: number;
  max_runtime_s?: number;
  max_result_bytes?: number;
  max_result_rows?: number;
}

/** Tenant override row (query-service domain.TenantLimits) — every field is a
 * pointer server-side; absent = platform default applies. */
export interface TenantLimitsDTO {
  max_scan_bytes?: number | null;
  max_runtime_s?: number | null;
  max_result_bytes?: number | null;
  max_result_rows?: number | null;
  concurrent_slots?: number | null;
  warehouse_primary?: boolean;
  updated_by?: string;
}

/** GET /limits response (handlers_stats.go handleGetLimits, QRY-FR-042/044). */
export interface QueryLimitsDTO {
  overrides?: TenantLimitsDTO | null;
  effective_user?: CeilingsDTO;
  effective_agent?: CeilingsDTO;
  platform_maxima?: CeilingsDTO;
}

/** POST /sql/dry-run response (handlers_sql.go handleDryRun, QRY-FR-041). */
export interface DryRunDTO {
  engine?: string;
  routing_reason?: string;
  estimated_scan_bytes?: number;
  estimated_rows?: number;
  /** "pruned/total" partition summary string (exec.Estimate). */
  partitions_pruned?: string;
  /** high | low. */
  confidence?: string;
  /** ok | exceeded. */
  ceiling_verdict?: string;
  ceilings?: CeilingsDTO;
  warnings?: unknown;
}

/** POST /executions/{id}/export response (handlers_executions.go, QRY-FR-062).
 * `url` is the service-relative signed download path /api/v1/downloads/{token}. */
export interface ExecutionExportDTO {
  format?: string;
  url?: string;
  expires_at?: string;
}

export class QueryClient {
  constructor(private readonly http: ServiceClient) {}

  /** GET /queries — saved queries, cursor-paginated. */
  savedQueries(p: SavedQueryListParams): Promise<Page<SavedQueryDTO>> {
    return this.http.get<Page<SavedQueryDTO>>("/api/v1/queries", {
      query: {
        limit: p.limit,
        cursor: p.cursor,
        "filter[workspace_id]": p.workspaceId,
      },
    });
  }

  /** GET /queries/{id} — a single saved query WITH its current version SQL. */
  async savedQuery(id: string): Promise<SavedQueryDTO> {
    const r = await this.http.get<{ data: SavedQueryDTO } | SavedQueryDTO>(
      `/api/v1/queries/${encodeURIComponent(id)}`,
    );
    return unwrap<SavedQueryDTO>(r);
  }

  /** POST /sql/run — ad-hoc execution. In sync mode the returned execution is
   * already terminal, so its id can be fed straight to results(). */
  async runSQL(body: RunSQLBody): Promise<ExecutionDTO> {
    const r = await this.http.post<{ data: ExecutionDTO } | ExecutionDTO>("/api/v1/sql/run", {
      body,
    });
    return unwrap<ExecutionDTO>(r);
  }

  /** POST /queries/{id}/run — run a saved query (sync). */
  async runSaved(id: string, body: { mode?: "sync" | "async"; limit?: number }): Promise<ExecutionDTO> {
    const r = await this.http.post<{ data: ExecutionDTO } | ExecutionDTO>(
      `/api/v1/queries/${encodeURIComponent(id)}/run`,
      { body },
    );
    return unwrap<ExecutionDTO>(r);
  }

  /** GET /executions/{id}/results — paginated JSON rows for a succeeded execution. */
  async results(executionId: string, limit: number): Promise<ResultsDTO> {
    const r = await this.http.get<{ data: ResultsDTO } | ResultsDTO>(
      `/api/v1/executions/${encodeURIComponent(executionId)}/results`,
      { query: { limit } },
    );
    return unwrap<ResultsDTO>(r);
  }

  // ---- saved-query authoring (QRY-FR-001/002) --------------------------------

  /** POST /queries — create a saved query (201; needs query.query.create).
   * 422 VARIABLE_INVALID carries per-variable problems in details. */
  async createQuery(body: SavedQueryBody, idempotencyKey?: string): Promise<SavedQueryDTO> {
    const r = await this.http.post<{ data: SavedQueryDTO } | SavedQueryDTO>("/api/v1/queries", {
      body,
      idempotencyKey,
    });
    return unwrap<SavedQueryDTO>(r);
  }

  /** PATCH /queries/{id} — every update creates an immutable new version
   * (needs query.query.update). Optimistic concurrency runs on the server's
   * current version when no If-Match is sent. */
  async patchQuery(id: string, body: SavedQueryBody): Promise<SavedQueryDTO> {
    const r = await this.http.patch<{ data: SavedQueryDTO } | SavedQueryDTO>(
      `/api/v1/queries/${encodeURIComponent(id)}`,
      { body },
    );
    return unwrap<SavedQueryDTO>(r);
  }

  /** DELETE /queries/{id} — soft delete (204; needs query.query.delete). */
  async deleteQuery(id: string): Promise<void> {
    await this.http.delete<void>(`/api/v1/queries/${encodeURIComponent(id)}`);
  }

  /** GET /queries/{id}/versions — immutable version history, newest first. */
  versions(id: string, limit: number, cursor?: string): Promise<Page<SavedQueryVersionDTO>> {
    return this.http.get<Page<SavedQueryVersionDTO>>(
      `/api/v1/queries/${encodeURIComponent(id)}/versions`,
      { query: { limit, cursor } },
    );
  }

  // ---- execution history (QRY-FR-080/081) ------------------------------------

  /** GET /executions — execution history, cursor-paginated (needs query.execution.read). */
  executions(p: ExecutionListParams): Promise<Page<ExecutionDTO>> {
    return this.http.get<Page<ExecutionDTO>>("/api/v1/executions", {
      query: {
        limit: p.limit,
        cursor: p.cursor,
        status: p.status,
        saved_query_id: p.savedQueryId,
        since: p.since,
        sort: p.sort,
      },
    });
  }

  /** GET /executions/{id} — one execution WITH its sql_text. */
  async execution(id: string): Promise<ExecutionDTO> {
    const r = await this.http.get<{ data: ExecutionDTO } | ExecutionDTO>(
      `/api/v1/executions/${encodeURIComponent(id)}`,
    );
    return unwrap<ExecutionDTO>(r);
  }

  /** POST /executions/{id}/cancel — cancel a queued/running execution (needs
   * query.execution.execute — cancel rides the execute capability). */
  async cancelExecution(id: string): Promise<ExecutionDTO> {
    const r = await this.http.post<{ data: ExecutionDTO } | ExecutionDTO>(
      `/api/v1/executions/${encodeURIComponent(id)}/cancel`,
    );
    return unwrap<ExecutionDTO>(r);
  }

  /** GET /stats/queries — top queries by scan bytes over a window (needs
   * query.stats.read). */
  async stats(since?: string, limit?: number): Promise<{ since?: string; top_queries?: QueryStatDTO[] }> {
    const r = await this.http.get<{ data: { since?: string; top_queries?: QueryStatDTO[] } }>(
      "/api/v1/stats/queries",
      { query: { since, limit } },
    );
    return r.data ?? {};
  }

  // ---- tenant governance: ceilings + concurrency (QRY-FR-042/044) ------------

  /** GET /limits — the tenant's overrides + effective user/agent ceilings +
   * platform maxima (needs query.limits.read). */
  async limits(): Promise<QueryLimitsDTO> {
    const r = await this.http.get<{ data: QueryLimitsDTO } | QueryLimitsDTO>("/api/v1/limits");
    return unwrap<QueryLimitsDTO>(r);
  }

  /** PUT /limits — a TA lowers ceilings/concurrency; overrides above the
   * platform maxima 422 (needs query.limits.update). Returns only {overrides} —
   * callers wanting the recomputed effective view re-read limits(). */
  async putLimits(body: TenantLimitsDTO): Promise<{ overrides?: TenantLimitsDTO }> {
    const r = await this.http.put<{ data: { overrides?: TenantLimitsDTO } }>("/api/v1/limits", {
      body,
    });
    return r.data ?? {};
  }

  // ---- dry-run + result export (QRY-FR-041/062) ------------------------------

  /** POST /sql/dry-run — plan + cost estimate WITHOUT executing (needs
   * query.execution.execute). A 422 COST_CEILING_EXCEEDED carries the estimate
   * in the error details and bubbles as DownstreamError. */
  async dryRun(body: RunSQLBody): Promise<DryRunDTO> {
    const r = await this.http.post<{ data: DryRunDTO } | DryRunDTO>("/api/v1/sql/dry-run", {
      body,
    });
    return unwrap<DryRunDTO>(r);
  }

  /** POST /executions/{id}/export — mint a signed CSV download link for a
   * SUCCEEDED execution (201; needs query.execution.export). parquet is a
   * documented 501 stub downstream; expired results answer 410 with a
   * re-run hint. */
  async exportExecution(id: string, format: string): Promise<ExecutionExportDTO> {
    const r = await this.http.post<{ data: ExecutionExportDTO } | ExecutionExportDTO>(
      `/api/v1/executions/${encodeURIComponent(id)}/export`,
      { body: { format } },
    );
    return unwrap<ExecutionExportDTO>(r);
  }
}
