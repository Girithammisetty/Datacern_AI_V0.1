/** usage-service Value & ROI reporting REST client (BRD 69 design §2.6).
 * Same shape as UsageClient (clients/usage.ts): typed DTOs, unwrap(), one
 * method per endpoint. Talks to the SAME usage-service base URL as
 * UsageClient — this is a distinct client class for readability, not a
 * distinct downstream service. */
import { ServiceClient } from "./base.js";
import { unwrap, type Envelope, type Page } from "./types.js";

/** usage-service domain.EstimatedValue (ROI-NFR-004): the JSON wire shape is
 * either null or {value, assumption_version} — never a bare number. */
export interface EstimatedValueDTO {
  value: number;
  assumption_version: number;
}

export interface CostPerDecisionDTO {
  value: number;
  basis: string; // "blended" | "attributed"
}

export interface ValueDecisionsDTO {
  total: number;
  by_decision: Record<string, number>;
  by_kind: Record<string, number>;
  by_agent: Record<string, number>;
  by_pack: Record<string, number>;
}

export interface ValueAdoptionDTO {
  active_users: number;
  by_workspace: Record<string, number>;
}

export interface ValueProvenanceDTO {
  rollup_version: string;
  assumption_version: number | null;
  meter_gap: string | null;
}

/** usage-service domain.ValueSummary (GET /api/v1/value/summary, ROI-FR-010). */
export interface ValueSummaryDTO {
  period: string;
  workspace_id?: string | null;
  decisions: ValueDecisionsDTO | null;
  hours_saved_est: EstimatedValueDTO | null;
  labor_value_est_usd: EstimatedValueDTO | null;
  ai_cost_usd: number;
  cost_per_decision: CostPerDecisionDTO | null;
  human_baseline_cost_usd: EstimatedValueDTO | null;
  net_value_est_usd: EstimatedValueDTO | null;
  ladder_savings_usd: number | null;
  adoption: ValueAdoptionDTO;
  provenance: ValueProvenanceDTO;
}

export interface ValueTrendPointDTO {
  period: string;
  value: number | null;
  basis: string | null;
  rollup_version: string;
  distilled_rung_share: number | null;
}

export interface ValueTrendDTO {
  metric: string;
  granularity: string;
  points: ValueTrendPointDTO[];
}

/** usage-service domain.ValueAssumptions (ROI-FR-001/002). */
export interface ValueAssumptionsDTO {
  id: string;
  version: number;
  minutes_per_decision: Record<string, number>;
  loaded_hourly_rate_usd: number;
  effective_from: string;
  status: string;
  created_by: string;
  created_at: string;
}

export interface UpdateValueAssumptionsBody {
  minutes_per_decision: Record<string, number>;
  loaded_hourly_rate_usd: number;
}

/** usage-service domain.ValueExport (ROI-FR-021, design §2.8). */
export interface ValueExportDTO {
  id: string;
  period: string;
  workspace_id?: string | null;
  version: number;
  json_url?: string;
  json_sha256: string;
  csv_url?: string;
  csv_sha256: string;
  assumption_version?: number | null;
  created_at: string;
}

export class ValueClient {
  constructor(private readonly http: ServiceClient) {}

  /** GET /api/v1/value/summary — needs usage.report.read. */
  async summary(period: string, workspaceId?: string): Promise<ValueSummaryDTO> {
    const r = await this.http.get<Envelope<ValueSummaryDTO> | ValueSummaryDTO>("/api/v1/value/summary", {
      query: { period, workspace_id: workspaceId },
    });
    return unwrap<ValueSummaryDTO>(r);
  }

  /** GET /api/v1/value/trend — needs usage.report.read. */
  async trend(params: {
    metric: string;
    granularity?: string;
    from?: string;
    to?: string;
    workspaceId?: string;
  }): Promise<ValueTrendDTO> {
    const r = await this.http.get<Envelope<ValueTrendDTO> | ValueTrendDTO>("/api/v1/value/trend", {
      query: {
        metric: params.metric,
        granularity: params.granularity ?? "month",
        from: params.from,
        to: params.to,
        workspace_id: params.workspaceId,
      },
    });
    return unwrap<ValueTrendDTO>(r);
  }

  /** GET /api/v1/value/assumptions — needs usage.report.read. Absent -> null
   * (ROI-FR-001 "ships absent", never a 404). */
  async assumptions(): Promise<ValueAssumptionsDTO | null> {
    const r = await this.http.get<Envelope<ValueAssumptionsDTO | null> | ValueAssumptionsDTO | null>(
      "/api/v1/value/assumptions",
    );
    if (r == null) return null;
    if (typeof r === "object" && "data" in (r as any)) return (r as Envelope<ValueAssumptionsDTO | null>).data;
    return r as ValueAssumptionsDTO;
  }

  /** GET /api/v1/value/assumptions/history — needs usage.report.read. */
  async assumptionHistory(): Promise<ValueAssumptionsDTO[]> {
    const page = await this.http.get<Page<ValueAssumptionsDTO>>("/api/v1/value/assumptions/history");
    return page.data ?? [];
  }

  /** PUT /api/v1/value/assumptions — needs usage.assumptions.update (design
   * §2.9 — the closed-verb-grammar equivalent of the design doc's literal
   * "usage.report.manage", see usage-service/internal/authz/authz.go). */
  async updateAssumptions(body: UpdateValueAssumptionsBody): Promise<ValueAssumptionsDTO> {
    const r = await this.http.put<Envelope<ValueAssumptionsDTO> | ValueAssumptionsDTO>(
      "/api/v1/value/assumptions",
      { body },
    );
    return unwrap<ValueAssumptionsDTO>(r);
  }

  /** GET /api/v1/value-reports?period= — needs usage.report.read. */
  async exports(period?: string): Promise<ValueExportDTO[]> {
    const page = await this.http.get<Page<ValueExportDTO>>("/api/v1/value-reports", { query: { period } });
    return page.data ?? [];
  }

  /** POST /api/v1/value-reports — needs usage.report.read (generation is a
   * read-shaped action per design §2.9: it discloses current figures, it
   * does not change future ones). */
  async exportReport(period: string, workspaceId?: string, idempotencyKey?: string): Promise<ValueExportDTO> {
    const r = await this.http.post<Envelope<ValueExportDTO> | ValueExportDTO>("/api/v1/value-reports", {
      body: { period, workspace_id: workspaceId },
      idempotencyKey,
    });
    return unwrap<ValueExportDTO>(r);
  }
}
