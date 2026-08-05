/** chart-service REST client (BRD 07). Backs: Dashboard, Chart, ChartData, and
 * the no-code editor's authoring + catalog surface (ChartType, chartPreview).
 *
 * Pure passthrough — the caller's JWT is forwarded verbatim by ServiceClient and
 * chart-service enforces every `chart.*` action guard. The BFF makes no
 * authz/business decision here; it only reshapes the REST payloads (snake→camel)
 * for the UI (BFF-FR-003/010/011). */
import { ServiceClient } from "./base.js";
import { unwrap, type Page } from "./types.js";

export interface DashboardDTO {
  id: string;
  workspace_id?: string;
  /** chart-service dashboardView serializes the dashboard label as `name`;
   * older read paths referenced `title` (mapDashboard falls back name→title). */
  name?: string;
  title?: string;
  module?: string;
  description?: string;
  layout?: unknown;
  meta?: unknown;
  tags?: string[];
  status?: string;
  archived?: boolean;
  chart_ids?: string[];
  charts?: ChartDTO[];
  created_at?: string;
  updated_at?: string;
}

export interface ChartSourceDTO {
  position?: number;
  source_type?: string;
  source_urn?: string;
}

export interface ChartDTO {
  id: string;
  dashboard_id?: string;
  name?: string;
  description?: string;
  spec?: unknown;
  chart_type?: string;
  config?: unknown;
  display_meta?: unknown;
  sources?: ChartSourceDTO[];
  chart_version?: number;
  provenance?: unknown;
  version?: number;
}

/** One hit from GET /charts (chart-service `chartSearchView`, BRD 74 D2): the
 * chart plus the parent-dashboard context that makes a cross-dashboard result
 * actionable ("which dashboard has the denial-rate chart"). */
export interface ChartSearchHitDTO extends ChartDTO {
  dashboard_name?: string;
  dashboard_module?: string;
  dashboard_tags?: string[];
}

export interface ChartSearchParams {
  /** REQUIRED — chart-service 422s without it (workspace-scoped authz). */
  workspaceId: string;
  q?: string;
  module?: string;
  tag?: string;
  dashboardId?: string;
  includeArchived?: boolean;
  limit: number;
  cursor?: string;
}

export interface ChartDataDTO {
  chart_id?: string;
  rows?: unknown[];
  columns?: unknown[];
  /** {nodes, edges} object shape for network-family charts (chart-service Shape). */
  graph?: unknown;
  /** Resolved artifact blob for the metric/parameter (dataset/run) family
   * (chart-service ShapedResult.artifact). */
  artifact?: unknown;
  meta?: { cache?: unknown; [k: string]: unknown };
  error?: { code?: string; message?: string };
}

/** One entry in the chart-type catalog (GET /chart-types). */
export interface ChartTypeDTO {
  name: string;
  family: string; // axis | y_only | heatmap | network | grid | metric
  data_class?: string; // query | dataset | run
  config_schema?: Record<string, unknown>; // JSON Schema
  required_fields?: string[];
}

/** ShapedResult from POST /charts/preview and GET /charts/{id}/data. */
export interface ChartShapedDataDTO {
  chart_id?: string;
  chart_type?: string;
  chart_version?: number;
  aggregated?: boolean;
  columns?: unknown;
  rows?: unknown;
  graph?: unknown;
  artifact?: unknown;
  row_count?: number;
  truncated?: boolean;
  resolved_at?: string;
}

export interface CreateDashboardBody {
  name: string;
  module?: string;
  workspace_id: string;
  description?: string;
  layout?: unknown;
  meta?: unknown;
  tags?: string[];
}

export interface UpdateDashboardBody {
  name?: string;
  description?: string;
  layout?: unknown;
  meta?: unknown;
  tags?: string[];
}

export interface ChartSourceInputBody {
  position: number;
  source_type: string;
  source_urn: string;
}

export interface CreateChartBody {
  name: string;
  chart_type: string;
  description?: string;
  config: Record<string, unknown>;
  display_meta?: Record<string, unknown>;
  sources?: ChartSourceInputBody[];
}

export interface UpdateChartBody {
  name?: string;
  chart_type?: string;
  config?: Record<string, unknown>;
  display_meta?: Record<string, unknown>;
  sources?: ChartSourceInputBody[];
}

export interface PreviewChartBody {
  chart_type: string;
  config: Record<string, unknown>;
  display_meta?: Record<string, unknown>;
  sources?: ChartSourceInputBody[];
}

/** POST /charts/{id}/drilldown body (chart-service resolve.DrilldownRequest,
 * CHART-FR-040): the clicked dimension is injected as a bind predicate over the
 * chart's drilldown saved query. */
export interface ChartDrilldownBody {
  clicked: { dimension: string; value?: unknown };
  dataseries_value?: unknown;
  filters?: Array<{ field: string; op: string; value: unknown }>;
  cursor?: string;
  limit?: number;
}

/** POST /charts/{id}/drilldown response — a {data,page} envelope of raw rows. */
export interface ChartDrilldownDTO {
  data?: { columns?: unknown; rows?: unknown };
  page?: { next_cursor?: string | null; has_more?: boolean };
}

/** An async export operation (chart-service domain.Operation, CHART-FR-041).
 * status: pending | running | completed | failed; artifact_url is a signed
 * download link once completed (FSStore: service-relative /api/v1/exports/…;
 * S3Store: absolute presigned URL). */
export interface ChartOperationDTO {
  id: string;
  chart_id?: string | null;
  kind?: string;
  format?: string;
  status?: string;
  artifact_url?: string;
  artifact_urn?: string;
  error?: string;
  expires_at?: string | null;
  created_at?: string;
  updated_at?: string;
}

/** POST /charts/{id}/export body (chart-service exportReq). */
export interface ChartExportBody {
  format: string; // csv | png (png is infra-gated on the renderer sidecar)
  width?: number;
  height?: number;
  theme?: string;
  request?: Record<string, unknown>;
}

/** The portable dashboard bundle (chart-service handlers_bundle.go, CHART-FR-005). */
export interface DashboardBundleDTO {
  dashboard?: {
    name?: string;
    module?: string;
    description?: string;
    layout?: unknown;
    meta?: unknown;
    tags?: string[];
  };
  charts?: Array<{
    name?: string;
    chart_type?: string;
    description?: string;
    config?: unknown;
    display_meta?: unknown;
    sources?: ChartSourceDTO[];
  }>;
}

/** PUT /charts/{id}/link body (chart-service linkWrite). */
export interface ChartLinkBody {
  child_chart_id: string;
  linked_columns?: Array<{ parent_col: string; child_col: string }>;
  /** 0 = shared-source, 1 = main-secondary (default). */
  link_type?: number;
}

/** PUT /charts/{id}/link response. */
export interface ChartLinkDTO {
  parent_chart_id?: string;
  child_chart_id?: string;
  link_type?: number;
  linked_columns?: unknown;
}

export class ChartClient {
  constructor(private readonly http: ServiceClient) {}

  // ---- read paths ----------------------------------------------------------
  async dashboard(id: string): Promise<DashboardDTO> {
    const r = await this.http.get<{ data: DashboardDTO } | DashboardDTO>(
      `/api/v1/dashboards/${encodeURIComponent(id)}`,
    );
    return unwrap<DashboardDTO>(r);
  }

  /** GET /dashboards?workspace_id=…&q=…&filter[archived]=true|false. workspace_id
   * is REQUIRED server-side (chart-service 400s without it); `archived` is a strict
   * equality filter, not "include archived too" (defaults to false = live only).
   * `q` (BRD 74 D3) is chart-service's own case-insensitive contains over the
   * dashboard name + description — the server-side search that replaced the
   * palette's fetch-50-and-filter-locally. */
  dashboards(
    workspaceId: string,
    limit: number,
    cursor?: string,
    archived?: boolean,
    q?: string,
  ): Promise<Page<DashboardDTO>> {
    return this.http.get<Page<DashboardDTO>>("/api/v1/dashboards", {
      query: {
        workspace_id: workspaceId, q, limit, cursor,
        "filter[archived]": archived ? "true" : undefined,
      },
    });
  }

  /** GET /charts — the cross-dashboard chart search (BRD 74 D2). workspace_id is
   * REQUIRED: `chart.chart.read` is a workspace-scoped grant, so chart-service
   * cannot authorize a search spanning workspaces with one decision. */
  searchCharts(p: ChartSearchParams): Promise<Page<ChartSearchHitDTO>> {
    return this.http.get<Page<ChartSearchHitDTO>>("/api/v1/charts", {
      query: {
        workspace_id: p.workspaceId,
        q: p.q,
        module: p.module,
        tag: p.tag,
        dashboard_id: p.dashboardId,
        include_archived: p.includeArchived ? "true" : undefined,
        limit: p.limit,
        cursor: p.cursor,
      },
    });
  }

  async chart(id: string): Promise<ChartDTO> {
    const r = await this.http.get<{ data: ChartDTO } | ChartDTO>(
      `/api/v1/charts/${encodeURIComponent(id)}`,
    );
    return unwrap<ChartDTO>(r);
  }

  /**
   * GET /dashboards/{id}/charts — enumerate a dashboard's child charts as full
   * chartView objects (id, name, chart_type, config, display_meta, sources).
   * This is the metadata list the Dashboard.charts resolver pairs with the
   * batch /data call (one list call + one batch call — no N+1).
   */
  async dashboardCharts(dashboardId: string): Promise<ChartDTO[]> {
    const r = await this.http.get<{ data: ChartDTO[] } | ChartDTO[]>(
      `/api/v1/dashboards/${encodeURIComponent(dashboardId)}/charts`,
    );
    return Array.isArray(r) ? r : (r.data ?? []);
  }

  /**
   * POST /dashboards/{id}/data — batch-resolve every chart of a dashboard in a
   * single downstream call (AC-1: <=2 calls, not one per chart). Per-chart
   * isolation is preserved: each entry carries its own result or error.
   * `filters` carries cross-filter predicates (CHART-FR-041): the chart-service
   * batch handler applies each to same-model sibling charts, skipping the origin.
   */
  dashboardData(
    dashboardId: string,
    filters?: Array<{ field: string; op: string; value: unknown; origin?: string }>,
  ): Promise<{ data: ChartDataDTO[] } | ChartDataDTO[]> {
    const body = filters && filters.length ? { filters } : undefined;
    return this.http.post(
      `/api/v1/dashboards/${encodeURIComponent(dashboardId)}/data`,
      body ? { body } : undefined,
    );
  }

  /** GET /charts/{id}/data — single chart data (used outside a dashboard batch). */
  chartData(chartId: string): Promise<ChartDataDTO> {
    return this.http.get<ChartDataDTO>(`/api/v1/charts/${encodeURIComponent(chartId)}/data`);
  }

  // ---- catalog -------------------------------------------------------------
  /** GET /chart-types — the chart-type catalog (auth only, no tenant data).
   * Powers the no-code editor's type picker + per-type config forms. */
  async chartTypes(): Promise<ChartTypeDTO[]> {
    const r = await this.http.get<{ data: ChartTypeDTO[] }>("/api/v1/chart-types");
    return r.data ?? [];
  }

  // ---- dashboard authoring -------------------------------------------------
  /** POST /dashboards — create a dashboard (201). workspace_id is sourced from
   * the caller's JWT claim by the resolver (the SDL input omits it). */
  async createDashboard(body: CreateDashboardBody, idempotencyKey?: string): Promise<DashboardDTO> {
    const r = await this.http.post<{ data: DashboardDTO } | DashboardDTO>("/api/v1/dashboards", {
      body,
      idempotencyKey,
    });
    return unwrap<DashboardDTO>(r);
  }

  /** PATCH /dashboards/{id} — partial update (200). */
  async updateDashboard(id: string, body: UpdateDashboardBody, idempotencyKey?: string): Promise<DashboardDTO> {
    const r = await this.http.patch<{ data: DashboardDTO } | DashboardDTO>(
      `/api/v1/dashboards/${encodeURIComponent(id)}`,
      { body, idempotencyKey },
    );
    return unwrap<DashboardDTO>(r);
  }

  /** DELETE /dashboards/{id} — delete (204). */
  async deleteDashboard(id: string): Promise<void> {
    await this.http.delete<void>(`/api/v1/dashboards/${encodeURIComponent(id)}`);
  }

  /** POST /dashboards/{id}/archive — soft-archive (authorized as chart.dashboard.update,
   * the canonical verb for a flag flip; not a distinct archive action). Cascades
   * to the dashboard's documentation rows server-side. */
  async archiveDashboard(id: string): Promise<DashboardDTO> {
    const r = await this.http.post<{ data: DashboardDTO } | DashboardDTO>(
      `/api/v1/dashboards/${encodeURIComponent(id)}/archive`,
    );
    return unwrap<DashboardDTO>(r);
  }

  /** PATCH /dashboards/{id}/restore — clear the archived flag (also chart.dashboard.update). */
  async restoreDashboard(id: string): Promise<DashboardDTO> {
    const r = await this.http.patch<{ data: DashboardDTO } | DashboardDTO>(
      `/api/v1/dashboards/${encodeURIComponent(id)}/restore`,
    );
    return unwrap<DashboardDTO>(r);
  }

  // ---- chart authoring -----------------------------------------------------
  /** POST /dashboards/{id}/charts — create a chart on a dashboard (201). */
  async createChart(dashboardId: string, body: CreateChartBody, idempotencyKey?: string): Promise<ChartDTO> {
    const r = await this.http.post<{ data: ChartDTO } | ChartDTO>(
      `/api/v1/dashboards/${encodeURIComponent(dashboardId)}/charts`,
      { body, idempotencyKey },
    );
    return unwrap<ChartDTO>(r);
  }

  /** PATCH /charts/{id} — partial update (200). */
  async updateChart(id: string, body: UpdateChartBody, idempotencyKey?: string): Promise<ChartDTO> {
    const r = await this.http.patch<{ data: ChartDTO } | ChartDTO>(
      `/api/v1/charts/${encodeURIComponent(id)}`,
      { body, idempotencyKey },
    );
    return unwrap<ChartDTO>(r);
  }

  /** DELETE /charts/{id} — delete (204). */
  async deleteChart(id: string): Promise<void> {
    await this.http.delete<void>(`/api/v1/charts/${encodeURIComponent(id)}`);
  }

  /** POST /charts/preview — resolve an UNSAVED chart spec inline for the live
   * editor preview (never cached; row-capped server-side). */
  async preview(body: PreviewChartBody): Promise<ChartShapedDataDTO> {
    const r = await this.http.post<{ data: ChartShapedDataDTO } | ChartShapedDataDTO>(
      "/api/v1/charts/preview",
      { body },
    );
    return unwrap<ChartShapedDataDTO>(r);
  }

  // ---- drilldown: aggregate → raw rows (CHART-FR-040) ----------------------
  /** POST /charts/{id}/drilldown — paginated raw rows for a clicked aggregate
   * segment (needs chart.chart.read; side-effect free). 422 NO_DRILLDOWN when
   * the chart's display_meta declares no drilldown query. Returns the full
   * {data,page} envelope (writePage) so callers keep the cursor. */
  drilldown(chartId: string, body: ChartDrilldownBody): Promise<ChartDrilldownDTO> {
    return this.http.post<ChartDrilldownDTO>(
      `/api/v1/charts/${encodeURIComponent(chartId)}/drilldown`,
      { body },
    );
  }

  // ---- CSV/PNG export + operation polling (CHART-FR-041) -------------------
  /** POST /charts/{id}/export — start an async CSV/PNG export (202 with
   * {operation_id}; needs chart.chart.export; 429 EXPORT_LIMIT past 5
   * concurrent exports/tenant). Poll operation() until it settles. */
  async exportChart(id: string, body: ChartExportBody): Promise<{ operation_id: string }> {
    const r = await this.http.post<{ data: { operation_id: string } }>(
      `/api/v1/charts/${encodeURIComponent(id)}/export`,
      { body },
    );
    return r.data;
  }

  /** GET /operations/{id} — export operation status + artifact link. */
  async operation(id: string): Promise<ChartOperationDTO> {
    const r = await this.http.get<{ data: ChartOperationDTO } | ChartOperationDTO>(
      `/api/v1/operations/${encodeURIComponent(id)}`,
    );
    return unwrap<ChartOperationDTO>(r);
  }

  // ---- dashboard portability (CHART-FR-005) --------------------------------
  /** POST /dashboards/{id}/export-bundle — a self-contained JSON bundle of the
   * dashboard + its charts (needs chart.dashboard.export). */
  async exportBundle(dashboardId: string): Promise<DashboardBundleDTO> {
    const r = await this.http.post<{ data: DashboardBundleDTO } | DashboardBundleDTO>(
      `/api/v1/dashboards/${encodeURIComponent(dashboardId)}/export-bundle`,
    );
    return unwrap<DashboardBundleDTO>(r);
  }

  /** POST /dashboards/import — import a bundle into a workspace, remapping
   * source URNs via url_mapping; any unmapped URN fails atomically with 422
   * UNMAPPED_URN before any write (needs chart.dashboard.create). */
  async importBundle(
    body: { bundle: DashboardBundleDTO; workspace_id: string; url_mapping?: Record<string, string> },
    idempotencyKey?: string,
  ): Promise<{ dashboard_id: string; charts_created: number }> {
    const r = await this.http.post<{ data: { dashboard_id: string; charts_created: number } }>(
      "/api/v1/dashboards/import",
      { body, idempotencyKey },
    );
    return r.data;
  }

  // ---- chart↔chart cross-navigation links (CHART-FR-015) -------------------
  /** PUT /charts/{id}/link — create a parent→child link transactionally with
   * cycle detection (authorized as chart.chart.update). */
  async createLink(parentChartId: string, body: ChartLinkBody): Promise<ChartLinkDTO> {
    const r = await this.http.put<{ data: ChartLinkDTO } | ChartLinkDTO>(
      `/api/v1/charts/${encodeURIComponent(parentChartId)}/link`,
      { body },
    );
    return unwrap<ChartLinkDTO>(r);
  }

  /** DELETE /charts/{id}/link — remove a link + clear the child back-reference
   * (204; the child id rides the body, matching the downstream handler). */
  async removeLink(parentChartId: string, childChartId: string): Promise<void> {
    await this.http.delete<void>(`/api/v1/charts/${encodeURIComponent(parentChartId)}/link`, {
      body: { child_chart_id: childChartId },
    });
  }
}
