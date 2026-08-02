/** usage-service REST client (BRD 17). Backs: UsageReport, Budget, BudgetState,
 * CostPanel, RateCard, Anomaly, UsageMeter, ChargebackLine, Reconciliation,
 * UsageAdjustment (BRD 67 billing depth). */
import { ServiceClient } from "./base.js";
import { unwrap, type Envelope, type Page } from "./types.js";

export interface UsageRowDTO {
  [dimension: string]: unknown;
  meter_key?: string;
  quantity?: number;
  /** RollupRow serializes the dollar figure as `usd` today; `cost_usd` is the
   * incoming contract name — readers accept both. */
  usd?: number;
  cost_usd?: number;
}

export interface UsageReportDTO {
  data?: UsageRowDTO[];
  rows?: UsageRowDTO[];
  page?: { next_cursor?: string | null; has_more: boolean };
}

/** budgetView scope: a nested dimension object (most-specific field wins). */
export interface BudgetScopeDTO {
  tenant_id?: string;
  workspace_id?: string;
  user_id?: string;
  agent_id?: string;
}

/** usage-service budgetView: the limit is `limit_value` and the exhaustion
 * behavior is `action_at_100` (NOT limit/action — those live on the STATE view).
 * `limit`/`action` are filled in by the client as normalized aliases. */
export interface BudgetDTO {
  id: string;
  name?: string;
  scope?: string | BudgetScopeDTO;
  meter_key?: string;
  window?: string;
  limit_value?: number;
  thresholds?: number[];
  action_at_100?: string;
  status?: string;
  created_at?: string | null;
  updated_at?: string | null;
  /** Normalized alias of limit_value (filled by the client). */
  limit?: number;
  /** Normalized alias of action_at_100 (filled by the client). */
  action?: string;
}

/** usage-service budgetStateView: {budget_id, window_start, consumed, limit,
 * last_threshold, action, exhausted_at?}. `scope` is the incoming contract
 * (today the state carries only budget_id). */
export interface BudgetStateDTO {
  budget_id?: string;
  scope?: string | BudgetScopeDTO;
  window_start?: string;
  consumed?: number;
  limit?: number;
  /** Defensive alias: the BUDGET view's name for the same figure. */
  limit_value?: number;
  last_threshold?: number;
  action?: string;
  exhausted_at?: string | null;
}

/** Normalize a budget scope — a plain string ("workspace/<id>") or the nested
 * dimension object — to the SDL's String scope (most-specific wins). */
export function budgetScopeString(scope: string | BudgetScopeDTO | null | undefined): string | null {
  if (scope == null) return null;
  if (typeof scope === "string") return scope;
  if (scope.agent_id) return `agent/${scope.agent_id}`;
  if (scope.user_id) return `user/${scope.user_id}`;
  if (scope.workspace_id) return `workspace/${scope.workspace_id}`;
  if (scope.tenant_id) return `tenant/${scope.tenant_id}`;
  return null;
}

/** POST /budgets body (usage-service createBudgetBody). */
export interface CreateBudgetBody {
  scope: { workspace_id?: string; user_id?: string; agent_id?: string };
  meter_key: string;
  window: string;
  limit_value: number;
  action_at_100?: string;
}

/** PATCH /budgets/{id} body — partial update, limit and/or degrade action only. */
export interface UpdateBudgetBody {
  limit_value?: number;
  action_at_100?: string;
}

/** usage-service RateCard (domain.RateCard): items maps meter_key -> price_per_unit_usd. */
export interface RateCardDTO {
  id: string;
  tenant_id?: string | null;
  version?: number;
  effective_from?: string;
  status?: string;
  items?: Record<string, number>;
  created_at?: string | null;
}

/** POST /rate-cards body (usage-service createRateCardBody). effective_from is YYYY-MM-DD. */
export interface CreateRateCardBody {
  tenant_id?: string;
  version: number;
  effective_from: string;
  items: Record<string, number>;
}

/** usage-service domain.Meter (USG-FR-001/003): one seeded catalog entry.
 * Units are canonical and never change post-launch (USG-FR-005). */
export interface MeterDTO {
  meter_key: string;
  unit: string;
  /** sum | time_weighted_avg */
  aggregation: string;
  description: string;
  dimensions: string[];
  deprecated: boolean;
}

/** usage-service store.ChargebackLine (USG-FR-043): one priced monthly row.
 * `usd` is quantity*price; `total_usd` folds in `adjustments_usd`. */
export interface ChargebackLineDTO {
  tenant_id: string;
  workspace_id?: string | null;
  month: string;
  meter_key: string;
  quantity: number;
  /** Empty string when no rate card resolved for the meter. */
  rate_card_id: string;
  price_per_unit_usd: number;
  usd: number;
  adjustments_usd: number;
  total_usd: number;
}

/** usage-service domain.BillingPeriodRecord (BRD 67 slice 3, VMB-FR-023): a
 * persisted, closed billing period joined with its export artifact record.
 * `export` is null when the period is closed but its artifacts haven't been
 * recorded yet. Gross is the priced total; net_billable folds in adjustments. */
export interface BillingExportDTO {
  jsonl_key: string;
  jsonl_sha256: string;
  csv_key: string;
  csv_sha256: string;
  pushed_status?: string | null;
  pushed_reference?: string | null;
  pushed_at?: string | null;
  created_at: string;
}

export interface BillingPeriodDTO {
  id: string;
  tenant_id: string;
  period: string;
  version: number;
  rate_card_id: string;
  rate_card_version: number;
  gross_usd: number;
  net_billable_usd: number;
  status: string;
  closed_at: string;
  closed_by: string;
  export?: BillingExportDTO | null;
}

/** usage-service domain.Reconciliation (USG-FR-070): monthly provider-bill vs
 * metered comparison. status: pending | matched | variance | adjusted |
 * acknowledged. */
export interface ReconciliationDTO {
  id: string;
  /** YYYY-MM */
  month: string;
  provider: string;
  status: string;
  report_uri: string;
  created_at: string;
}

/** POST /adjustments body (usage-service adjustmentBody). month must be a
 * FINALIZED YYYY-MM (an open month 409s with reason month_open, BR-5). */
export interface CreateAdjustmentBody {
  meter_key: string;
  month: string;
  quantity_delta: number;
  usd_delta: number;
  reason: string;
}

/** POST /adjustments 201 echo — the handler returns only these six fields
 * (no tenant/actor/created_at echoed; see handlers_recon.go). */
export interface AdjustmentDTO {
  id: string;
  month: string;
  meter_key: string;
  quantity_delta: number;
  usd_delta: number;
  reason: string;
}

/** usage-service domain.Anomaly (USG-FR-050/051). status: open | dismissed. */
export interface AnomalyDTO {
  id: string;
  tenant_id: string;
  meter_key: string;
  day: string;
  observed: number;
  mean: number;
  stddev: number;
  z: number;
  status: string;
  dismissed_by?: string | null;
  suppressed_reason?: string | null;
  created_at: string;
}

export class UsageClient {
  constructor(private readonly http: ServiceClient) {}

  usageReport(params: {
    groupBy: string[];
    from: string;
    to: string;
    workspaceId?: string;
    meterKey?: string;
    limit: number;
    cursor?: string;
  }): Promise<UsageReportDTO> {
    return this.http.get<UsageReportDTO>("/api/v1/reports/usage", {
      query: {
        group_by: params.groupBy.join(","),
        from: params.from,
        to: params.to,
        workspace_id: params.workspaceId,
        meter_key: params.meterKey,
        limit: params.limit,
        cursor: params.cursor,
      },
    });
  }

  /** GET /meters — the seeded platform meter catalog (USG-FR-003; needs
   * usage.meter.read). Not paginated downstream (page is always empty-cursor). */
  meters(): Promise<Page<MeterDTO>> {
    return this.http.get<Page<MeterDTO>>("/api/v1/meters");
  }

  /** GET /reports/chargeback?month=YYYY-MM — priced monthly rollups for a
   * finalized month (USG-FR-043; needs usage.report.read). 409s with details
   * {reason:"reconciliation_variance"} while that month's reconciliation
   * variance is unresolved (AC-9) — surfaced verbatim, never faked. */
  chargebackReport(month: string): Promise<Page<ChargebackLineDTO>> {
    return this.http.get<Page<ChargebackLineDTO>>("/api/v1/reports/chargeback", {
      query: { month },
    });
  }

  /** GET /billing/periods — a tenant's closed billing periods, newest first,
   * each joined with its export record (BRD 67 slice 3; needs
   * usage.report.read). Optional `period` (YYYY-MM) filter; `limit` default 50,
   * max 200 downstream. Empty until the B2 close job runs for a month. */
  billingPeriods(period?: string, limit?: number): Promise<Page<BillingPeriodDTO>> {
    return this.http.get<Page<BillingPeriodDTO>>("/api/v1/billing/periods", {
      query: { period, limit },
    });
  }

  /** GET /budgets — rows normalized so `limit`/`action` always read the real
   * downstream fields (budgetView serializes limit_value / action_at_100). */
  async budgets(limit: number, cursor?: string): Promise<Page<BudgetDTO>> {
    const page = await this.http.get<Page<BudgetDTO>>("/api/v1/budgets", { query: { limit, cursor } });
    return {
      ...page,
      data: (page.data ?? []).map((b) => ({
        ...b,
        limit: b.limit ?? b.limit_value,
        action: b.action ?? b.action_at_100,
      })),
    };
  }

  /** GET /budget-states — bulk budget states (budgetStateByScope loader). */
  async budgetStates(scope?: string): Promise<BudgetStateDTO[]> {
    const res = await this.http.get<{ data?: BudgetStateDTO[] } | BudgetStateDTO[]>(
      "/api/v1/budget-states",
      { query: { scope } },
    );
    if (Array.isArray(res)) return res;
    return res.data ?? [];
  }

  /** GET /budgets/{id} — single budget (needs usage.budget.read). */
  async budget(id: string): Promise<BudgetDTO> {
    const r = await this.http.get<Envelope<BudgetDTO> | BudgetDTO>(`/api/v1/budgets/${encodeURIComponent(id)}`);
    return unwrap<BudgetDTO>(r);
  }

  /** POST /budgets — create (201; needs usage.budget.create). */
  async createBudget(body: CreateBudgetBody, idempotencyKey?: string): Promise<BudgetDTO> {
    const r = await this.http.post<Envelope<BudgetDTO> | BudgetDTO>("/api/v1/budgets", { body, idempotencyKey });
    return unwrap<BudgetDTO>(r);
  }

  /** PATCH /budgets/{id} — partial update (200; needs usage.budget.update). */
  async updateBudget(id: string, body: UpdateBudgetBody, idempotencyKey?: string): Promise<BudgetDTO> {
    const r = await this.http.patch<Envelope<BudgetDTO> | BudgetDTO>(
      `/api/v1/budgets/${encodeURIComponent(id)}`,
      { body, idempotencyKey },
    );
    return unwrap<BudgetDTO>(r);
  }

  /** DELETE /budgets/{id} — soft-delete (204; needs usage.budget.delete). */
  async deleteBudget(id: string): Promise<void> {
    await this.http.delete<void>(`/api/v1/budgets/${encodeURIComponent(id)}`);
  }

  /** GET /budgets/{id}/state — a single budget's live spend state. */
  async budgetState(id: string): Promise<BudgetStateDTO> {
    const r = await this.http.get<Envelope<BudgetStateDTO> | BudgetStateDTO>(
      `/api/v1/budgets/${encodeURIComponent(id)}/state`,
    );
    return unwrap<BudgetStateDTO>(r);
  }

  // ---- rate cards ------------------------------------------------------------
  /** GET /rate-cards — no server-side pagination today (needs usage.ratecard.read). */
  rateCards(): Promise<Page<RateCardDTO>> {
    return this.http.get<Page<RateCardDTO>>("/api/v1/rate-cards");
  }

  /** POST /rate-cards — create a draft card (201; PLATFORM-ONLY, needs
   * usage.ratecard.create + a platform-operator token — a tenant admin token
   * gets a real 403 here, surfaced verbatim, never faked). */
  async createRateCard(body: CreateRateCardBody, idempotencyKey?: string): Promise<RateCardDTO> {
    const r = await this.http.post<Envelope<RateCardDTO> | RateCardDTO>("/api/v1/rate-cards", {
      body,
      idempotencyKey,
    });
    return unwrap<RateCardDTO>(r);
  }

  /** POST /rate-cards/{id}/activate (200; PLATFORM-ONLY, needs usage.ratecard.update). */
  async activateRateCard(id: string): Promise<RateCardDTO> {
    const r = await this.http.post<Envelope<RateCardDTO> | RateCardDTO>(
      `/api/v1/rate-cards/${encodeURIComponent(id)}/activate`,
    );
    return unwrap<RateCardDTO>(r);
  }

  // ---- anomaly detection review (USG-FR-050/051) -----------------------------
  /** GET /anomalies — needs usage.anomaly.read. No real cursor pagination
   * server-side (limit is hardcoded to 100, next_cursor is always "" /
   * has_more always false) — surfaced as-is, not faked into a real page. */
  anomalies(status?: string): Promise<Page<AnomalyDTO>> {
    return this.http.get<Page<AnomalyDTO>>("/api/v1/anomalies", { query: { status } });
  }

  /** POST /anomalies/{id}/dismiss (200; needs usage.anomaly.update). Response
   * is thin ({id, status}) — the resolver re-reads the list for the full row. */
  async dismissAnomaly(id: string): Promise<{ id: string; status: string }> {
    const r = await this.http.post<Envelope<{ id: string; status: string }> | { id: string; status: string }>(
      `/api/v1/anomalies/${encodeURIComponent(id)}/dismiss`,
    );
    return unwrap<{ id: string; status: string }>(r);
  }

  // ---- reconciliation + billing adjustments (USG-FR-070/072) -----------------
  /** GET /reconciliations — PLATFORM-ONLY (needs usage.reconciliation.read).
   * No server-side pagination (fixed 100-row cap downstream, next_cursor
   * always "") — surfaced as-is, not faked into a real page. */
  reconciliations(): Promise<Page<ReconciliationDTO>> {
    return this.http.get<Page<ReconciliationDTO>>("/api/v1/reconciliations");
  }

  /** POST /reconciliations/{id}/acknowledge (200; PLATFORM-ONLY, needs
   * usage.reconciliation.update). Only a variance row can be acknowledged —
   * anything else 404s downstream. Response is thin ({id, status}) — the
   * resolver re-reads the list for the full row. */
  async acknowledgeReconciliation(id: string): Promise<{ id: string; status: string }> {
    const r = await this.http.post<Envelope<{ id: string; status: string }> | { id: string; status: string }>(
      `/api/v1/reconciliations/${encodeURIComponent(id)}/acknowledge`,
    );
    return unwrap<{ id: string; status: string }>(r);
  }

  /** POST /adjustments — record a signed billing adjustment/credit on a CLOSED
   * month (201; USG-FR-072; PLATFORM-ONLY, needs usage.reconciliation.update).
   * An open month 409s with details {reason:"month_open"} (BR-5). No
   * Idempotency-Key replay downstream (unlike budgets) — none is sent. */
  async createAdjustment(body: CreateAdjustmentBody): Promise<AdjustmentDTO> {
    const r = await this.http.post<Envelope<AdjustmentDTO> | AdjustmentDTO>("/api/v1/adjustments", {
      body,
    });
    return unwrap<AdjustmentDTO>(r);
  }
}
