/** agent-runtime REST client (BRD 14). Backs: Proposal, AgentRun, TraceNode.
 * NB: agent-runtime paths already include the /api/v1 prefix. */
import { ServiceClient } from "./base.js";
import { unwrap, type Page } from "./types.js";

export interface ProposalDTO {
  id: string;
  run_id?: string;
  agent_key?: string;
  agent_version?: string;
  /** The proposed tool call: proposal_view serializes `tool_id` (+ tool_version). */
  tool_id?: string;
  tool_version?: string;
  /** Legacy field name, kept for defensiveness during contract transition. */
  tool?: string;
  /** The proposed tool arguments: proposal_view serializes `args`. */
  args?: unknown;
  /** Legacy field name, kept for defensiveness during contract transition. */
  args_diff?: unknown;
  rationale?: string;
  /** "llm" (real model call) or "fallback_template" (canned sentence
   * substituted when the LLM call failed/was empty) — agent-runtime
   * proposal_view. */
  rationale_source?: string;
  affected_urns?: string[];
  predicted_effect?: string;
  expires_at?: string;
  status?: string; // pending|approved|rejected|edited_approved|responded|expired
  decision?: unknown;
  /** The single resource this proposal targets (being added to proposal_view;
   * honored by filter[resource_urn]). */
  resource_urn?: string;
  created_at?: string;
  /** Tool-plane risk tier: read|write-proposal|write-direct|admin (agent-runtime proposal_view). */
  tier?: string;
  risk_tier?: string;
  /** Side-effect class: none|reversible|destructive. */
  side_effects?: string;
}

export interface AgentRunDTO {
  id: string;
  session_id?: string;
  agent_key?: string;
  agent_version?: string;
  status?: string;
  /** run_view serializes token counts under `usage` {input_tokens, output_tokens,
   * model, deployment} (and cost fields if/when the runtime adds them). */
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    model?: string;
    deployment?: string;
    cost_usd?: number;
    cost?: number;
  };
  /** Legacy field names, kept for defensiveness during contract transition. */
  token_usage?: { input_tokens?: number; output_tokens?: number };
  cost_usd?: number;
  citations?: unknown[];
  error?: unknown;
  created_at?: string;
}

export interface DecideBody {
  action: "approve" | "reject" | "edit_args" | "respond";
  message?: string;
  edited_args?: Record<string, unknown>;
}

/** One rollout record (agent-runtime rollouts table; GET /registry/rollouts).
 * mode: direct|canary|shadow · status: active|promoted|rolled_back. */
export interface AgentRolloutDTO {
  rollout_id: string;
  agent_key: string;
  cell?: string;
  mode: string;
  candidate_version: number;
  baseline_version: number;
  pct?: number;
  tenant_filter?: Record<string, unknown>;
  status: string;
}

/** POST /registry/rollouts body (create_rollout, registry.py). candidate/
 * baseline are the version ints being compared; pct only matters for canary. */
export interface StartAgentRolloutBody {
  agent_key: string;
  mode: string;
  candidate_version: number;
  baseline_version: number;
  pct?: number;
  cell?: string;
  tenant_filter?: Record<string, unknown>;
}

/** One retrain watch (registry.py _watch_view — BRD 52 inc3 drift thresholds
 * that open four-eyes retrain proposals via the governance agent). */
export interface RetrainWatchDTO {
  id: string;
  model_urn: string;
  watched_agent_key: string;
  workspace_id?: string | null;
  cadence_seconds: number;
  correction_window_hours: number;
  drift_threshold: number;
  min_corrections: number;
  enabled: boolean;
  last_checked_at?: string | null;
  last_signal?: Record<string, unknown>;
  created_by?: string | null;
}

export interface CreateRetrainWatchBody {
  model_urn: string;
  watched_agent_key: string;
  workspace_id?: string;
  cadence_seconds?: number;
  correction_window_hours?: number;
  drift_threshold?: number;
  min_corrections?: number;
  enabled?: boolean;
}

/** agent-runtime KillSwitch (ART-FR-073). scope: agent|agent_version|agent_version_tenant. */
/** One rollout record (agent-runtime rollouts table; GET /registry/rollouts).
 * mode: direct|canary|shadow · status: active|promoted|rolled_back. */
export interface AgentRolloutDTO {
  rollout_id: string;
  agent_key: string;
  cell?: string;
  mode: string;
  candidate_version: number;
  baseline_version: number;
  pct?: number;
  tenant_filter?: Record<string, unknown>;
  status: string;
}

export interface AgentKillSwitchDTO {
  kill_id: string;
  scope: string;
  agent_key: string;
  version?: number | null;
  tenant_id?: string | null;
  active: boolean;
  reason: string;
  set_by: string;
  created_at?: string | null;
}

export interface CreateAgentKillBody {
  agent_key: string;
  scope?: string;
  version?: number;
  tenant_id?: string;
  reason: string;
}

// ============================================================================
// Tier 2b: agent catalog/registry browse + per-tenant agent config + run
// history. Shapes mirror app/api/routes/registry.py (_definition_view /
// _version_view / _tenant_config_view) and app/api/schemas.py run_view.
// ============================================================================

export interface AgentDefinitionDTO {
  agent_key: string;
  display_name: string;
  description?: string;
  owner_team?: string;
  default_write_mode?: string;
  status?: string;
  latest_published_version?: number | null;
}

export interface AgentVersionDTO {
  agent_key: string;
  version: number;
  status: string;
  graph_ref?: string;
  graph_digest?: string;
  guardrail_profile?: string;
  eval_gate_result_id?: string | null;
  toolset?: unknown[];
  model_config?: Record<string, unknown>;
}

export interface TenantAgentConfigDTO {
  agent_key: string;
  configured: boolean;
  enabled: boolean;
  pinned_version?: number | null;
  prompt_params?: Record<string, unknown>;
  auto_execute_policy?: Record<string, unknown>;
  self_approval: boolean;
  /** _tenant_config_view (registry.py) already returns this — {data_scope,
   * budget, pii} per app/domain/guardrail.py — but it wasn't previously read
   * by any BFF field. BRD 68 slice 1 (AgentFleetGuardrails) is the first
   * consumer. */
  guardrail_policy?: {
    data_scope?: { workspaces?: string[]; dataset_urns?: string[] };
    budget?: { max_tokens_per_session?: number };
    pii?: { block_pii_egress?: boolean; redact?: boolean };
  };
}

export interface PutTenantAgentConfigBody {
  enabled?: boolean;
  pinned_version?: number | null;
  prompt_params?: Record<string, unknown>;
  auto_execute_policy?: Record<string, unknown>;
  self_approval?: boolean;
}

/** BRD 53 inc2b: author a custom agent + its guardrail envelope (inc2). Mirrors
 * app/api/routes/registry.py create_custom_agent — server validates + clamps. */
export interface CreateCustomAgentBody {
  display_name: string;
  persona: string;
  system_prompt?: string;
  allowed_tools: string[];
  propose_tool?: string | null;
  data_scope?: { workspaces?: string[]; dataset_urns?: string[] };
  budget?: { max_tokens_per_session?: number };
  pii?: { block_pii_egress?: boolean; redact?: boolean };
}

export interface CustomAgentResultDTO {
  agent_key: string;
  status: string;
  graph_ref: string;
  allowed_tools: string[];
  persona: string;
  owner_tenant: string;
  guardrail_policy?: Record<string, unknown>;
}

export interface AgentCeilingsDTO {
  max_budget_tokens: number;
  max_tier: string;
  updated_at?: string | null;
  updated_by?: string | null;
}

/** run_view row on the Tier 2b GET /runs list (adds created_at). */
export interface AgentRunListItemDTO {
  id: string;
  session_id?: string;
  agent_key?: string;
  agent_version?: number;
  status?: string;
  principal_type?: string;
  usage?: Record<string, unknown>;
  error?: unknown;
  final_text?: string | null;
  created_at?: string;
}

// ---- BRD 54 inc2: decision-model DTOs (agent-runtime decision_view) --------

export interface DecisionConditionDTO {
  column: string;
  op: string;
  value?: unknown;
}
export interface DecisionOutcomeDTO {
  disposition_code: string;
  severity: string;
}
export interface DecisionRuleDTO {
  when: DecisionConditionDTO[];
  then: DecisionOutcomeDTO | null;
  note?: string;
}
export interface DecisionModelDTO {
  id: string;
  name: string;
  version: number;
  status: string;
  workspace_id?: string | null;
  dataset_urn?: string | null;
  created_by?: string | null;
  approved_by?: string | null;
  approved_at?: string | null;
  rules: DecisionRuleDTO[];
  default_outcome?: DecisionOutcomeDTO | null;
}
export interface CreateDecisionModelBody {
  name: string;
  workspace_id?: string;
  rules: DecisionRuleDTO[];
  default_outcome?: DecisionOutcomeDTO | null;
}
export interface BatchEvaluateRowDTO {
  case_id: string;
  matched: boolean;
  rule_index: number | null;
  explanation: string;
  outcome: DecisionOutcomeDTO | null;
  proposal_id?: string;
  proposal_status?: string;
  executed?: boolean;
}
export interface BatchEvaluateDTO {
  model_id: string;
  proposed: boolean;
  summary: {
    cases: number;
    matched: number;
    unmatched: number;
    proposals_created: number;
    by_outcome: Record<string, number>;
  };
  results: BatchEvaluateRowDTO[];
}

/** POST /entity-merges response (BRD 56) — the pending four-eyes proposal. */
export interface EntityMergeProposalDTO {
  proposal_id: string;
  status: string;
  executed?: boolean;
  run_id?: string;
}

export class AgentClient {
  constructor(private readonly http: ServiceClient) {}

  proposals(params: {
    status?: string;
    agentKey?: string;
    limit: number;
    cursor?: string;
  }): Promise<Page<ProposalDTO>> {
    return this.http.get<Page<ProposalDTO>>("/api/v1/proposals", {
      query: {
        "filter[status]": params.status,
        "filter[agent_key]": params.agentKey,
        limit: params.limit,
        cursor: params.cursor,
      },
    });
  }

  /** proposalByCaseId / resource loader: GET /proposals?filter[resource_urn]=… */
  async proposalsByResourceUrns(urns: string[]): Promise<ProposalDTO[]> {
    const res = await this.http.get<Page<ProposalDTO>>("/api/v1/proposals", {
      query: { "filter[resource_urn]": urns.join(","), limit: 200 },
    });
    return res.data ?? [];
  }

  async proposal(id: string): Promise<ProposalDTO> {
    const r = await this.http.get<{ data: ProposalDTO } | ProposalDTO>(
      `/api/v1/proposals/${encodeURIComponent(id)}`,
    );
    return unwrap<ProposalDTO>(r);
  }

  /** POST /entity-merges (BRD 56) — open a four-eyes proposal to confirm a
   * reviewed merge candidate. The caller must hold dataset.entity.merge; a
   * DIFFERENT user approves via /proposals/{id}/decide. Returns the pending
   * proposal ref. */
  async proposeEntityMerge(
    body: {
      dataset_id: string;
      run_id: string;
      candidate_id: string;
      left_pk?: string;
      right_pk?: string;
      score?: number;
      workspace_id?: string;
      rationale?: string;
    },
    idempotencyKey?: string,
  ): Promise<EntityMergeProposalDTO> {
    const r = await this.http.post<{ data: EntityMergeProposalDTO } | EntityMergeProposalDTO>(
      "/api/v1/entity-merges",
      { body, idempotencyKey },
    );
    return unwrap<EntityMergeProposalDTO>(r);
  }

  /** POST /proposals/{id}/decide — mutation passthrough (idempotent, first-wins). */
  async decide(id: string, body: DecideBody, idempotencyKey?: string): Promise<ProposalDTO> {
    const r = await this.http.post<{ data: ProposalDTO } | ProposalDTO>(
      `/api/v1/proposals/${encodeURIComponent(id)}/decide`,
      { body, idempotencyKey },
    );
    return unwrap<ProposalDTO>(r);
  }

  async run(id: string): Promise<AgentRunDTO> {
    const r = await this.http.get<{ data: AgentRunDTO } | AgentRunDTO>(
      `/api/v1/runs/${encodeURIComponent(id)}`,
    );
    return unwrap<AgentRunDTO>(r);
  }

  /** GET /runs/{id}/trace — tool-call tree for the visualizer. */
  async runTrace(id: string): Promise<unknown> {
    return this.http.get(`/api/v1/runs/${encodeURIComponent(id)}/trace`);
  }

  /** GET /registry/rollouts — rollout records (platform-scoped, like the data
   * the fleet's rollout column describes). Needs ai.agent.read (same gate as
   * the kill-switch list). Filters optional. */
  async rollouts(params?: { agentKey?: string; status?: string; cell?: string }): Promise<AgentRolloutDTO[]> {
    const r = await this.http.get<{ data: AgentRolloutDTO[] }>("/api/v1/registry/rollouts", {
      query: { agent_key: params?.agentKey, status: params?.status, cell: params?.cell },
    });
    return r.data ?? [];
  }

  /** POST /registry/rollouts — start a direct|canary|shadow rollout (operator-
   * only downstream, registry.py _require_operator). Response is thin
   * ({rollout_id, status: "active"}). */
  async startRollout(body: StartAgentRolloutBody, idempotencyKey?: string): Promise<{ rollout_id: string; status: string }> {
    const r = await this.http.post<{ data: { rollout_id: string; status: string } }>(
      "/api/v1/registry/rollouts",
      { body, idempotencyKey },
    );
    return r.data;
  }

  /** POST /registry/rollouts/{id}/promote — candidate wins (operator-only). */
  async promoteRollout(rolloutId: string, idempotencyKey?: string): Promise<{ rollout_id: string; status: string }> {
    const r = await this.http.post<{ data: { rollout_id: string; status: string } }>(
      `/api/v1/registry/rollouts/${encodeURIComponent(rolloutId)}/promote`,
      { idempotencyKey },
    );
    return r.data;
  }

  /** POST /registry/rollouts/{id}/rollback — back to baseline (operator-only). */
  async rollbackRollout(rolloutId: string, idempotencyKey?: string): Promise<{ rollout_id: string; status: string }> {
    const r = await this.http.post<{ data: { rollout_id: string; status: string } }>(
      `/api/v1/registry/rollouts/${encodeURIComponent(rolloutId)}/rollback`,
      { idempotencyKey },
    );
    return r.data;
  }

  /** GET /registry/kill-switches — active kills (operator: all tenants; tenant
   * admin: own tenant + global). Needs operator or tenant.admin JWT scope. */
  async killSwitches(): Promise<AgentKillSwitchDTO[]> {
    const r = await this.http.get<{ data: AgentKillSwitchDTO[] }>("/api/v1/registry/kill-switches");
    return r.data ?? [];
  }

  /** POST /registry/kill-switches — set a kill (200; needs operator, or tenant
   * admin for the caller's own tenant scope). Response is thin ({kill_id,
   * active}); the resolver re-reads the list to return the full row. */
  async createKillSwitch(body: CreateAgentKillBody, idempotencyKey?: string): Promise<{ kill_id: string; active: boolean }> {
    const r = await this.http.post<{ data: { kill_id: string; active: boolean } }>(
      "/api/v1/registry/kill-switches",
      { body, idempotencyKey },
    );
    return r.data;
  }

  /** DELETE /registry/kill-switches/{id} — lift a kill (200; authN only). */
  async deleteKillSwitch(killId: string): Promise<{ kill_id: string; active: boolean }> {
    const r = await this.http.delete<{ data: { kill_id: string; active: boolean } }>(
      `/api/v1/registry/kill-switches/${encodeURIComponent(killId)}`,
    );
    return r.data;
  }

  // ---- Tier 2b: agent catalog browse (GET routes; operator/tenant.admin) ----

  async agentDefinitions(): Promise<AgentDefinitionDTO[]> {
    const r = await this.http.get<{ data: AgentDefinitionDTO[] }>("/api/v1/registry/agents");
    return r.data ?? [];
  }

  async agentVersions(agentKey: string): Promise<AgentVersionDTO[]> {
    const r = await this.http.get<{ data: AgentVersionDTO[] }>(
      `/api/v1/registry/agents/${encodeURIComponent(agentKey)}/versions`,
    );
    return r.data ?? [];
  }

  /** POST /registry/agents — register an agent definition, status "draft"
   * (operator-only downstream, registry.py _require_operator). Response is
   * thin ({agent_key, status}). */
  async registerAgentDefinition(
    body: { agent_key: string; display_name: string; description?: string; owner_team?: string; default_write_mode?: string },
    idempotencyKey?: string,
  ): Promise<{ agent_key: string; status: string }> {
    const r = await this.http.post<{ data: { agent_key: string; status: string } }>(
      "/api/v1/registry/agents",
      { body, idempotencyKey },
    );
    return r.data;
  }

  /** POST /registry/agents/{key}/versions — create an immutable draft version
   * (operator-only; 409 if the version already exists). Publish it separately
   * via publishAgentVersion. Response is thin ({agent_key, version, status}). */
  async createAgentVersion(
    agentKey: string,
    body: {
      version: number;
      graph_ref: string;
      prompt_refs?: unknown[];
      toolset?: unknown[];
      model_config?: Record<string, unknown>;
      eval_gate?: Record<string, unknown>;
      eval_gate_result_id?: string;
    },
    idempotencyKey?: string,
  ): Promise<{ agent_key: string; version: number; status: string }> {
    const r = await this.http.post<{ data: { agent_key: string; version: number; status: string } }>(
      `/api/v1/registry/agents/${encodeURIComponent(agentKey)}/versions`,
      { body, idempotencyKey },
    );
    return r.data;
  }

  /** POST /registry/agents/{key}/versions/{v}/publish — eval-gate-guarded
   * (operator; force requires a reason). */
  async publishAgentVersion(
    agentKey: string,
    version: number,
    force?: boolean,
    reason?: string,
    idempotencyKey?: string,
  ): Promise<{ agent_key: string; version: number; status: string }> {
    const r = await this.http.post<{ data: { agent_key: string; version: number; status: string } }>(
      `/api/v1/registry/agents/${encodeURIComponent(agentKey)}/versions/${version}/publish`,
      { body: force ? { force, reason } : {}, idempotencyKey },
    );
    return r.data;
  }

  // ---- Tier 2b: per-tenant agent config (tenant.admin) ----------------------

  async tenantAgentConfig(agentKey: string): Promise<TenantAgentConfigDTO> {
    const r = await this.http.get<{ data: TenantAgentConfigDTO }>(
      `/api/v1/registry/tenants/self/agents/${encodeURIComponent(agentKey)}`,
    );
    return r.data;
  }

  /** PUT /registry/tenants/self/agents/{key}. The PUT response is thin
   * ({agent_key, enabled, pinned_version}); the resolver re-reads the config
   * for the full row. */
  async putTenantAgentConfig(
    agentKey: string,
    body: PutTenantAgentConfigBody,
    idempotencyKey?: string,
  ): Promise<{ agent_key: string; enabled: boolean; pinned_version?: number | null }> {
    const r = await this.http.put<{ data: { agent_key: string; enabled: boolean; pinned_version?: number | null } }>(
      `/api/v1/registry/tenants/self/agents/${encodeURIComponent(agentKey)}`,
      { body, idempotencyKey },
    );
    return r.data;
  }

  /** POST /registry/tenants/self/agents — author a tenant CUSTOM agent (BRD 53)
   * as governed configuration + its guardrail envelope (inc2: data_scope,
   * budget, pii). Needs ai.agent.admin; validated + clamped server-side. */
  async createCustomAgent(body: CreateCustomAgentBody): Promise<CustomAgentResultDTO> {
    const r = await this.http.post<{ data: CustomAgentResultDTO }>(
      "/api/v1/registry/tenants/self/agents",
      { body },
    );
    return r.data;
  }

  /** POST /registry/tenants/self/personas/autobind — bind persona copilots for
   * pack roles (BRD 53 inc3, PA-FR-010). Idempotent; needs ai.agent.admin. */
  async autobindPersonaCopilots(
    roles: string[],
    proposeTool?: string | null,
  ): Promise<{ created: { role: string; agent_key: string }[]; skipped: { role: string; agent_key: string }[] }> {
    const r = await this.http.post<{
      data: { created: { role: string; agent_key: string }[]; skipped: { role: string; agent_key: string }[] };
    }>("/api/v1/registry/tenants/self/personas/autobind", {
      body: { roles, propose_tool: proposeTool ?? undefined },
    });
    return r.data;
  }

  /** GET /registry/platform/agent-ceilings — operator-only platform ceilings. */
  async agentCeilings(): Promise<AgentCeilingsDTO> {
    const r = await this.http.get<{ data: AgentCeilingsDTO }>("/api/v1/registry/platform/agent-ceilings");
    return r.data;
  }

  /** PUT /registry/platform/agent-ceilings — set them (operator-only). */
  async setAgentCeilings(maxBudgetTokens: number, maxTier: string): Promise<AgentCeilingsDTO> {
    const r = await this.http.put<{ data: AgentCeilingsDTO }>(
      "/api/v1/registry/platform/agent-ceilings",
      { body: { max_budget_tokens: maxBudgetTokens, max_tier: maxTier } },
    );
    return r.data;
  }

  // ---- BRD 52 inc3: scheduled drift/retrain watches (ai.agent.admin) --------

  /** GET /registry/retrain-watches — the caller-tenant's watches. */
  async retrainWatches(): Promise<RetrainWatchDTO[]> {
    const r = await this.http.get<{ data: RetrainWatchDTO[] }>("/api/v1/registry/retrain-watches");
    return r.data ?? [];
  }

  /** POST /registry/retrain-watches — register a drift watch on a deployed
   * model; over the threshold it opens a four-eyes retrain proposal. Returns
   * the full stored row (_watch_view). Needs ai.agent.admin. */
  async createRetrainWatch(body: CreateRetrainWatchBody, idempotencyKey?: string): Promise<RetrainWatchDTO> {
    const r = await this.http.post<{ data: RetrainWatchDTO }>(
      "/api/v1/registry/retrain-watches",
      { body, idempotencyKey },
    );
    return r.data;
  }

  /** DELETE /registry/retrain-watches/{id} — remove a watch (404 if not the
   * caller-tenant's). Needs ai.agent.admin. */
  async deleteRetrainWatch(watchId: string): Promise<{ id: string; deleted: boolean }> {
    const r = await this.http.delete<{ data: { id: string; deleted: boolean } }>(
      `/api/v1/registry/retrain-watches/${encodeURIComponent(watchId)}`,
    );
    return r.data;
  }

  // ---- Tier 2b: run history (any tenant principal; tenant-scoped by RLS) ----

  agentRuns(params: { agentKey?: string; limit: number }): Promise<Page<AgentRunListItemDTO>> {
    return this.http.get<Page<AgentRunListItemDTO>>("/api/v1/runs", {
      query: { "filter[agent_key]": params.agentKey, limit: params.limit },
    });
  }

  // ---- SLM distillation (BRD 12 M1/M2): transcript corpus + curated SFT ----

  /** List transcript-corpus rows (service caps the page at 200 — callers must
   * treat a full page as "200+", never fabricate a total). */
  transcripts(params: { decided?: boolean; limit: number }): Promise<Page<TranscriptDTO>> {
    return this.http.get<Page<TranscriptDTO>>("/api/v1/transcripts", {
      query: { "filter[decided]": params.decided || undefined, limit: params.limit },
    });
  }

  sftDatasets(params: { agentKey?: string; limit: number }): Promise<Page<SftDatasetDTO>> {
    return this.http.get<Page<SftDatasetDTO>>("/api/v1/sft-datasets", {
      query: { "filter[agent_key]": params.agentKey, limit: params.limit },
    });
  }

  // ---- BRD 54 inc2: governed decision tables (authoring + batch) ------------

  async decisionModels(): Promise<DecisionModelDTO[]> {
    const r = await this.http.get<{ data: DecisionModelDTO[] }>("/api/v1/decision-models");
    return r.data ?? [];
  }

  async decisionModel(id: string): Promise<DecisionModelDTO> {
    const r = await this.http.get<{ data: DecisionModelDTO } | DecisionModelDTO>(
      `/api/v1/decision-models/${encodeURIComponent(id)}`,
    );
    return unwrap<DecisionModelDTO>(r);
  }

  async createDecisionModel(body: CreateDecisionModelBody, idempotencyKey?: string): Promise<DecisionModelDTO> {
    const r = await this.http.post<{ data: DecisionModelDTO } | DecisionModelDTO>(
      "/api/v1/decision-models",
      { body, idempotencyKey },
    );
    return unwrap<DecisionModelDTO>(r);
  }

  /** All versions of one logical table, newest first — the change log. */
  async decisionModelVersions(id: string): Promise<DecisionModelDTO[]> {
    const r = await this.http.get<{ data: DecisionModelDTO[] }>(
      `/api/v1/decision-models/${encodeURIComponent(id)}/versions`,
    );
    return r.data ?? [];
  }

  /** Four-eyes approval of the logic: publish a draft (author ≠ approver). */
  async approveDecisionModel(id: string, idempotencyKey?: string): Promise<DecisionModelDTO> {
    const r = await this.http.post<{ data: DecisionModelDTO } | DecisionModelDTO>(
      `/api/v1/decision-models/${encodeURIComponent(id)}/approve`,
      { idempotencyKey },
    );
    return unwrap<DecisionModelDTO>(r);
  }

  /** Edit = a new draft version (prior version stays immutable). */
  async newDecisionModelVersion(id: string, body: { rules?: DecisionRuleDTO[]; default_outcome?: DecisionOutcomeDTO | null }, idempotencyKey?: string): Promise<DecisionModelDTO> {
    const r = await this.http.post<{ data: DecisionModelDTO } | DecisionModelDTO>(
      `/api/v1/decision-models/${encodeURIComponent(id)}/versions`,
      { body, idempotencyKey },
    );
    return unwrap<DecisionModelDTO>(r);
  }

  /** POST /decision-models/{id}/batch-evaluate — dry-run preview by default;
   * ?propose=true mints one governed four-eyes proposal per matched case. */
  async batchEvaluateDecisionModel(
    id: string,
    body: { workspace_id?: string; case_ids?: string[]; limit?: number },
    propose: boolean,
    idempotencyKey?: string,
  ): Promise<BatchEvaluateDTO> {
    const r = await this.http.post<{ data: BatchEvaluateDTO } | BatchEvaluateDTO>(
      `/api/v1/decision-models/${encodeURIComponent(id)}/batch-evaluate`,
      { body, query: { propose }, idempotencyKey },
    );
    return unwrap<BatchEvaluateDTO>(r);
  }

  /** POST /sessions/{id}/terminate — end an agent chat session (404 cross-
   * tenant/unknown). The copilot creates sessions implicitly via chat; this is
   * the explicit kill for a runaway/finished conversation. */
  async terminateSession(sessionId: string): Promise<AgentSessionDTO> {
    const r = await this.http.post<{ data: AgentSessionDTO } | AgentSessionDTO>(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/terminate`,
      {},
    );
    return unwrap<AgentSessionDTO>(r);
  }

  /** POST /decision-models/{id}/evaluate?dry_run= — evaluate a PUBLISHED table
   * against one case. dry_run=true returns outcome + fired rule with NO side
   * effect (DM-FR-030); dry_run=false mints a governed four-eyes proposal on
   * match (DM-FR-020). */
  async evaluateDecisionModel(
    id: string,
    body: { case_id: string; fields?: Record<string, unknown> },
    dryRun: boolean,
    idempotencyKey?: string,
  ): Promise<DecisionEvaluationDTO> {
    const r = await this.http.post<{ data: DecisionEvaluationDTO } | DecisionEvaluationDTO>(
      `/api/v1/decision-models/${encodeURIComponent(id)}/evaluate`,
      { body, query: { dry_run: dryRun }, idempotencyKey },
    );
    return unwrap<DecisionEvaluationDTO>(r);
  }

  // ---- BRD 55: decision outcome monitoring (realized outcomes on decisions) --

  /** GET /decisions/{ref}/outcome — the realized-outcome label, or 404. */
  async decisionOutcome(decisionRef: string): Promise<OutcomeLabelDTO> {
    const r = await this.http.get<{ data: OutcomeLabelDTO } | OutcomeLabelDTO>(
      `/api/v1/decisions/${encodeURIComponent(decisionRef)}/outcome`,
    );
    return unwrap<OutcomeLabelDTO>(r);
  }

  /** POST /decisions/{ref}/outcome — record the realized outcome (201). When the
   * ref is a proposal id the service joins decided_outcome/producer from its
   * provenance; otherwise decision_type must be supplied. */
  async markDecisionOutcome(
    decisionRef: string,
    body: {
      realized_outcome: string;
      label_source?: string;
      note?: string;
      decision_type?: string;
      producer?: string;
      decided_outcome?: string;
    },
    idempotencyKey?: string,
  ): Promise<OutcomeLabelDTO> {
    const r = await this.http.post<{ data: OutcomeLabelDTO } | OutcomeLabelDTO>(
      `/api/v1/decisions/${encodeURIComponent(decisionRef)}/outcome`,
      { body, idempotencyKey },
    );
    return unwrap<OutcomeLabelDTO>(r);
  }

  /** GET /decision-effectiveness — decided-vs-realized agreement grouped by
   * decision_type or producer (OM-FR-020). */
  async decisionEffectiveness(
    by: "decision_type" | "producer",
    decisionType?: string,
  ): Promise<DecisionEffectivenessDTO> {
    const r = await this.http.get<{ data: DecisionEffectivenessDTO } | DecisionEffectivenessDTO>(
      "/api/v1/decision-effectiveness",
      { query: { by, decision_type: decisionType } },
    );
    return unwrap<DecisionEffectivenessDTO>(r);
  }
}

/** One agent chat session (agent-runtime session_view). */
export interface AgentSessionDTO {
  id: string;
  agent_key?: string;
  agent_version?: number;
  context_urn?: string | null;
  status?: string; // active | idle | expired | terminated
  created_at?: string;
  last_activity_at?: string;
  expires_hard_at?: string;
}

/** POST /decision-models/{id}/evaluate result: the fired rule (or no match)
 * and, when not a dry run, the minted proposal id. */
export interface DecisionEvaluationDTO {
  matched: boolean;
  rule_index?: number | null;
  explanation?: string;
  outcome?: { disposition_code: string; severity: string } | null;
  proposal_id?: string | null;
  dry_run?: boolean;
}

/** One realized-outcome label on a decision (agent-runtime outcome_labels,
 * BRD 55). `correct` is null when there is no decided outcome to compare. */
export interface OutcomeLabelDTO {
  id: string;
  decision_ref: string;
  decision_type?: string | null;
  producer?: string | null;
  decided_outcome?: string | null;
  realized_outcome: string;
  correct?: boolean | null;
  label_source?: string;
  note?: string | null;
  labeled_by?: string | null;
}

/** GET /decision-effectiveness response (groups sorted by total desc). */
export interface DecisionEffectivenessDTO {
  by: string;
  labeled_decisions: number;
  groups: {
    key: string;
    total: number;
    correct: number;
    incorrect: number;
    unknown: number;
    effectiveness_rate: number | null;
  }[];
}

/** One captured agent-run transcript (only the fields the loop stats need). */
export interface TranscriptDTO {
  transcript_id: string;
  agent_key?: string;
  decision?: string | null;
  corrected_output?: unknown;
  created_at?: string | null;
}

/** One curated, versioned SFT dataset (agent-runtime sft_datasets). */
export interface SftDatasetDTO {
  dataset_id: string;
  agent_key?: string;
  version?: number;
  status?: string;
  row_count?: number;
  source_count?: number;
  created_at?: string | null;
}
