# BRD 12 — ai-gateway

**Service:** ai-gateway · **Language:** Python 3.12 (LiteLLM proxy core + FastAPI admin plane) · **Phase:** 2
**Inherits:** `00_MASTER_BRD.md` (all MASTER-FR requirements apply). Architecture refs: `DATACERN_PLATFORM_ARCHITECTURE.md` §3, §8.1, §10; `DATACERN_V3_AGENTIC_ARCHITECTURE.md` §5.2.

---

## 1. Overview

**Purpose.** ai-gateway is the single choke point for **every** LLM/embedding call made anywhere on the platform. No service, agent, or job may call a model provider directly; CI lint + egress network policy enforce this. The gateway provides provider routing with per-cloud affinity, model ladders per request class, hierarchical hard budgets, virtual key management, a tenant-scoped semantic cache, gateway-tier guardrails (PII redaction, injection classification, output schema validation), token metering to usage-service, OTel GenAI tracing, and SSE streaming passthrough.

**Business value.** (a) FinOps enforcement point — hard budgets prevent LLM cost blowout (the #1 platform economic risk); (b) governance — PII never leaves the platform unredacted, prompts are injection-screened once, centrally; (c) portability — providers (Azure OpenAI, Bedrock, Vertex, Anthropic API) are swappable behind one API, satisfying the 3-cloud commitment; (d) observability — every token is attributed to `{tenant, workspace, user|agent, agent_version, tool, feature}`.

**In scope:** OpenAI-compatible completion/chat/embedding proxy; provider registry & health; model ladders (chat / sql-gen / judge / embed request classes); escalation + degradation rules; hierarchical budgets with stacked daily+monthly windows and threshold events; virtual keys; semantic cache; gateway guardrails; metering events; streaming; failover/retry; admin APIs.
**Out of scope:** agent orchestration (agent-runtime, BRD 14), per-agent/usage-point guardrails (agent-runtime), eval scoring (eval-service, BRD 16), showback report rendering (usage-service, BRD 17), self-hosted vLLM serving (future).

## 2. Actors & user stories

Personas: **Platform Operator** (SRE/FinOps admin), **Tenant Admin**, **Agent Runtime** (service caller), **Domain Service** (e.g., semantic-service embedding calls), **Eval Service** (judge calls), **End User** (indirect, via agents).

- **US-1** As the agent-runtime, I call `POST /v1/chat/completions` with a virtual key and request class `chat` so my agent's model call is routed, budgeted, guarded, cached, metered, and traced without me knowing which provider serves it.
- **US-2** As a Platform Operator, I register a new provider deployment (e.g., Claude on Bedrock in `us-east-1`) with priority and cloud tag, so tenants on AWS cells route to it first for residency and egress cost.
- **US-3** As a Tenant Admin, I set a monthly budget of $2,000 and a daily budget of $150 for my tenant, and per-workspace sub-budgets, so spend can never exceed what I approved.
- **US-4** As a Tenant Admin, I receive events at 80% and 95% of any budget window so I can act before exhaustion.
- **US-5** As an End User whose tenant budget is exhausted, I get a clear `BUDGET_EXHAUSTED` error (after the gateway has already tried cheaper ladder rungs), not a silent degradation or a hung stream.
- **US-6** As the agent-runtime, repeated semantically-identical questions within a tenant are served from the semantic cache so latency drops and spend falls, and I can see `x-datacern-cache: hit` on the response.
- **US-7** As a Platform Operator, I configure the sql-gen ladder as `[haiku-class → sonnet-class → opus-class]` with escalation on low confidence, so cheap models handle easy queries and hard ones escalate automatically.
- **US-8** As a Compliance Officer, every prompt is PII-redacted (Presidio) before leaving the platform boundary, per my tenant's guardrail policy, and every redaction is countable on a dashboard.
- **US-9** As the eval-service, I request the `judge` request class so judge calls use the pinned judge ladder at temperature 0 and are metered under the `eval` feature tag.
- **US-10** As a Platform Operator, when a provider region degrades, calls fail over to the next provider in ≤ 2 retries without client involvement, and I can drain a provider via admin API.
- **US-11** As a Tenant Admin, I create and revoke virtual keys scoped to a user or agent, with their own budget caps and allowed request classes.
- **US-12** As a Security Engineer, prompts classified as injection attempts above the block threshold are rejected with `GUARDRAIL_BLOCKED` and audited, per tenant-configurable mode (block/flag/off).

## 3. Functional requirements

### Request classes (normative definitions)

| Class | Used by | Ladder semantics | Special rules |
|---|---|---|---|
| `chat` | agent conversational turns, reflection calls | 3 rungs, escalate on explicit request | default class |
| `sql-gen` | analytics agent NL→SQL generation | 3 rungs, auto-escalate on schema-invalid output | responses expected structured; schema validation on by default |
| `judge` | eval-service scorers, guardrail groundedness checks | 2 rungs, temperature forced to 0 | draws platform system budget; never cached; never degraded (correctness > cost) |
| `embed` | memory-service, tool-plane discovery, semantic cache tier | 1 rung | batch endpoint support (≤ 256 inputs/call) |

### Proxy & routing
- **AIG-FR-001 (Must)** Expose OpenAI-compatible endpoints `POST /v1/chat/completions`, `POST /v1/completions`, `POST /v1/embeddings` (LiteLLM proxy semantics), authenticated by virtual key (`Authorization: Bearer nk-…`) **plus** the platform RS256 JWT for caller identity (MASTER-FR-010).
- **AIG-FR-002 (Must)** Every request carries `x-datacern-request-class: chat|sql-gen|judge|embed` (default `chat`) and attribution headers `x-datacern-tenant-id` is **ignored**; tenant is taken from the verified JWT only (MASTER-FR-001/002). Attribution tags `{workspace_id, user_id, agent_id, agent_version, tool, feature}` come from headers and are validated against JWT claims where overlapping.
- **AIG-FR-003 (Must)** Provider registry: CRUD over provider deployments `{provider: azure_openai|bedrock|vertex|anthropic, model_family, deployment_name, region, cloud: aws|azure|gcp, endpoint_ref (Vault path for creds), tpm_limit, rpm_limit, priority, status: active|draining|disabled}`.
- **AIG-FR-004 (Must)** **Per-cloud affinity routing:** resolve the tenant's cell cloud (from JWT claim `cell_cloud`, projected from identity-service events); candidate deployments sorted by (same-cloud first, then priority). Cross-cloud routing allowed only if no same-cloud deployment serves the requested ladder rung, and is recorded on the span as `datacern.routing.cross_cloud=true`.
- **AIG-FR-005 (Must)** **Model ladders:** per request class, an ordered list of rungs `[{model_alias, max_tokens, temperature_default, cost_tier}]`, configurable platform-wide with per-tenant overrides. Defaults: `chat: [fast-small, balanced, frontier]`, `sql-gen: [fast-small, balanced, frontier]`, `judge: [balanced(temp=0), frontier(temp=0)]`, `embed: [embed-standard]`.
- **AIG-FR-006 (Must)** **Escalation:** a caller may re-request with `x-datacern-escalate: true` + prior `request_id` (used by agents on low-confidence/reflection failure); the gateway serves the next rung up. Automatic escalation triggers: provider returned malformed/schema-invalid output (after 1 retry at same rung); explicit `min_rung` in request. Escalation above a tenant's `max_rung` setting is denied with `LADDER_CAP`.
- **AIG-FR-007 (Must)** **Degradation:** when a governing budget window crosses its degrade threshold (default 95%), new requests are served at the lowest rung of the ladder regardless of requested rung; responses carry `x-datacern-degraded: budget`. Escalation requests are denied during degradation.
- **AIG-FR-008 (Must)** **Failover/retry:** per rung, try same-cloud deployments in priority order; on `429/5xx/timeout` retry once on same deployment (jittered backoff 250ms–1s), then next deployment, max 3 total attempts spanning ≤ 2 providers; then return `UPSTREAM_UNAVAILABLE` (503). Timeouts: connect 5s; first-token 30s (streaming); total 120s non-streaming. Retries never repeat after any bytes streamed to the client.
- **AIG-FR-009 (Should)** Circuit breaker per deployment: open after 5 consecutive failures or >50% error rate over 1 min; half-open probe every 30s; state visible in admin API and metrics.
- **AIG-FR-009a (Should)** Active provider health probes: 60s-interval synthetic 1-token completion per active deployment; consecutive probe failures mark the deployment `unhealthy` in routing (skipped like draining) without changing its persisted status; recovery restores it automatically.
- **AIG-FR-009b (Must)** Deterministic routing trace: every response includes `x-datacern-deployment` (opaque deployment id) and the span records the full candidate-evaluation order, so any routing decision is reconstructible from the trace alone.
- **AIG-FR-010 (Must)** **Streaming:** SSE passthrough for `stream: true` with first-token p95 ≤ 200ms added latency over provider; usage chunk (`stream_options.include_usage`) always requested from provider and forwarded; guardrail-redacted streams are re-chunked, never buffered whole.
- **AIG-FR-011 (Must)** Per-tenant admission control: concurrent LLM streams cap (default 50/tenant pool tier, configurable), TPM/RPM caps; over-cap returns 429 + `Retry-After` (backpressure, no queuing at gateway).

### Budgets
- **AIG-FR-020 (Must)** Hierarchical budget scopes: `platform → tenant → workspace → principal (user|agent) → virtual_key`. Each scope may define **both** a `daily` and a `monthly` window (USD limits, computed from provider price tables versioned in config). A request must fit **every** ancestor window (stacked evaluation); the first exhausted scope governs.
- **AIG-FR-021 (Must)** Budget check is pre-flight (reserve estimated cost = prompt tokens + `max_tokens` upper bound at rung price) and post-flight (settle actual). Reservations expire after 180s if unsettled. Redis-backed counters with Postgres as source of truth; counters rebuilt from Postgres on Redis loss.
- **AIG-FR-022 (Must)** Threshold events at **80%, 95%, 100%** of every window: emit `budget.threshold` / `budget.exhausted` to `ai.events.v1` (payload: scope, window, limit, spend, pct) exactly once per window crossing (Redis SETNX guard).
- **AIG-FR-023 (Must)** On exhaustion behavior, in order: (1) if request rung > lowest rung → serve lowest rung (**ladder-degrade**, only while the governing scope is between degrade-threshold and 100%); (2) at ≥100% of any governing hard window → **fail closed**: HTTP 402, error code `BUDGET_EXHAUSTED`, message naming the exhausted scope + window + reset time. No exceptions, including platform-internal callers except the `judge`/`guardrail` system class which draws from a reserved platform system budget.
- **AIG-FR-024 (Must)** Budget CRUD APIs with RBAC: platform scope = platform operator only; tenant/workspace/principal/key scopes = tenant admin. Child limits may not exceed parent remaining limit at creation time (soft warning, not hard, since parents can change).
- **AIG-FR-025 (Should)** Spend anomaly detection: >3× trailing-7-day same-hour spend rate for a tenant emits `budget.anomaly` event.

### Virtual keys
- **AIG-FR-030 (Must)** Virtual key lifecycle: create/rotate/revoke/list. Key record: `{id, tenant_id, principal_type: user|agent|service, principal_id, allowed_request_classes[], max_rung, budget refs, expires_at, status}`. Secret shown once at creation; stored hashed (SHA-256).
- **AIG-FR-031 (Must)** Key revocation takes effect ≤ 30s (Redis pub/sub invalidation). Expired/revoked key → 401 `KEY_INVALID`.
- **AIG-FR-032 (Must)** agent-runtime mints per-run virtual keys via service API (scoped to agent principal, run TTL); these inherit the agent's budget scope.

### Semantic cache
- **AIG-FR-040 (Must)** Cache key = `(tenant_id, prompt_hash, context_hash)` where `prompt_hash` = SHA-256 of normalized messages and `context_hash` = SHA-256 of `{model_alias, request_class, tools schema, temperature, system-prompt version, guardrail policy version}`. Exact-match tier (Redis) plus semantic tier (embedding similarity ≥ 0.97 within same tenant + same context_hash, pgvector).
- **AIG-FR-041 (Must)** **Never cross-tenant**: tenant_id is a hard component of both tiers; isolation covered by the MASTER isolation test suite.
- **AIG-FR-042 (Must)** TTL default 24h (per-tenant configurable 0–7d; 0 disables). No caching when: `stream=true` with tools, temperature > 0.2, request class `judge`, or response was guardrail-flagged.
- **AIG-FR-043 (Must)** Invalidation: tenant admin API (`DELETE /admin/cache?scope=tenant|workspace`), automatic on tenant guardrail-policy change and on ladder config change (context_hash changes naturally); cache hits emit metering events with `cached=true` and $0 provider cost.

### Guardrails (gateway tier)
- **AIG-FR-050 (Must)** **PII redaction:** Presidio analyzer on inbound prompt text; entities per tenant policy (default: EMAIL, PHONE, CREDIT_CARD, SSN/national-id, IBAN, PERSON optional). Modes per tenant: `redact` (replace with typed placeholders, default), `block`, `off` (requires platform-operator approval flag). Redaction map retained in-memory only for de-redaction of the response when tenant policy sets `deredact_response=true`; never persisted.
- **AIG-FR-051 (Must)** **Injection classifier:** score inbound user-role content; per tenant thresholds `flag` (default 0.65) and `block` (default 0.85). Block → 422 `GUARDRAIL_BLOCKED` + audit event; flag → header `x-datacern-guardrail-flags` + span attribute, request proceeds.
- **AIG-FR-052 (Must)** **Output schema validation:** when request includes `response_format: json_schema`, validate provider output; on failure retry once at same rung, then auto-escalate one rung (AIG-FR-006), then return 502 `OUTPUT_SCHEMA_INVALID`.
- **AIG-FR-053 (Must)** Guardrail policy per tenant: `{pii: {mode, entities[], deredact_response}, injection: {flag_threshold, block_threshold, mode}, schema_validation: on|off}`, versioned; policy version stamped on every span and metering event.
- **AIG-FR-054 (Should)** Guardrail latency budget: PII+injection combined p95 ≤ 120ms; run in parallel.

### Metering, events, observability
- **AIG-FR-060 (Must)** Every completed (or failed-after-provider-call) request emits `ai.token_usage.v1` to Kafka: `{request_id, tenant_id, workspace_id, principal, agent_id?, agent_version?, tool?, feature?, request_class, model_alias, provider, deployment, rung, input_tokens, output_tokens, cached, cost_usd, latency_ms, first_token_ms?, guardrail_flags[], degraded?, trace_id}`. usage-service consumes for showback/chargeback.
- **AIG-FR-061 (Must)** OTel GenAI semconv spans (`chat`, `embeddings`) with `gen_ai.usage.input_tokens/output_tokens`, `gen_ai.request.model`, `gen_ai.response.model`, plus `datacern.*` attributes for tenant/rung/cache/budget-state; semconv version pinned per MASTER-FR-052. Traces exported to OTel collector; also forwarded to Langfuse.
- **AIG-FR-062 (Must)** Metrics: per-tenant token/spend counters, cache hit rate, guardrail hit rates, ladder rung distribution, provider error/latency histograms, budget saturation gauges.

**Span attribute contract (every data-plane span, in addition to GenAI semconv):**

| Attribute | Example | Notes |
|---|---|---|
| `datacern.tenant_id` | `t-42` | from JWT |
| `datacern.request_class` | `sql-gen` | |
| `datacern.rung` / `datacern.escalated` | `1` / `true` | with `datacern.escalation_reason` |
| `datacern.deployment` | `dep-azoai-eus2-4o` | opaque id |
| `datacern.cache` | `hit_exact` \| `hit_semantic` \| `miss` \| `skip` | |
| `datacern.budget_state` | `ok` \| `degrading` \| `exhausted` | most-constrained governing scope |
| `datacern.guardrail_flags` | `["pii_redacted"]` | kinds only, never values |
| `datacern.rejected_stage` | `budget_preflight` | only on rejections |
| `datacern.price_version` | `2026-07-01` | settlement price table |

### Admin APIs
- **AIG-FR-070 (Must)** Admin plane (`/api/v1/admin/*`, platform-operator or tenant-admin scoped as noted): providers CRUD + drain (operator), ladders CRUD (operator; tenant overrides by tenant admin), budgets CRUD, keys CRUD, guardrail policy CRUD (tenant admin), cache invalidation, live spend query (`GET /admin/spend?scope=…&window=…`).
- **AIG-FR-071 (Could)** Config export/import (YAML) for GitOps management of platform-level ladders and providers.

### Cost-reduction routing (deterministic-first, cascade, SLM, batch, decision attribution)

The gateway is the single choke point where the platform enforces its cost thesis: **don't call a model when a compiler works; call the cheapest tier that meets eval; and prove every decision's cost per outcome.** Requirements below stack on top of ladders (§AIG-FR-005) and budgets (§AIG-FR-020..025), not replace them.

- **AIG-FR-080 (Must)** **Deterministic-first pre-router.** Before ladder resolution, every `chat`/`sql-gen` request runs a ≤ 15ms intent step (rule table + tiny on-prem SLM classifier at "rung −1") to decide whether the task can be served by a **deterministic handler** instead of an LLM. Handlers registered in a config table `deterministic_handlers` — v1 ships: `semantic-compile` (metric+dimension requests via semantic-service `/compile`), `verified-query-hit` (NL match against approved verified queries), `memory-recall` (identical prior task via memory-service), `rules-route` (case routing / role assignment). If a handler returns a confident answer (schema-valid, ≥ handler-specific confidence), the gateway responds with `x-datacern-handler: deterministic:<kind>`, **zero provider tokens**, no ladder call. Handler unit cost (config) is written to the metering event under `provider_cost_usd=0, handler_cost_usd=<n>`.
- **AIG-FR-081 (Must)** Deterministic-first policy per tenant per class: `enforce` (refuse LLM if a handler was confident), `prefer` (default: handler when confident, LLM otherwise), `off` (bypass). Enforced by `guardrail_policies.deterministic_first`; audited on change.
- **AIG-FR-082 (Must)** **Auto-cascade (eval-gated).** Beyond caller-driven and schema-invalid escalation (§AIG-FR-006), the router observes a rolling 500-request quality signal per `(tenant, class, workspace, rung)` from eval-service async scoring on a 5% sample of served requests. If the rung's rolling pass rate falls below `promote_threshold` (default 92%), the router **promotes** the next request in-class one rung; if pass rate at rung N ≥ `demote_threshold` (default 99%) for 24h, the router **demotes** one rung. Shifts recorded in `rung_policies` and emit `cascade.rung_shifted` audit events. Bounded by tenant `max_rung`/`min_rung`; a pinned rung disables auto-shift for its scope.
- **AIG-FR-083 (Should)** Equivalence classes: eval-service publishes `equivalence_class` labels per (class, rung, deployment); when two active deployments share an equivalence class, the router prefers the one with the lower current-day effective rate (§AIG-FR-088). Never applies to `judge`.
- **AIG-FR-084 (Must)** **Self-hosted SLM tier.** Add provider class `self_hosted` (vLLM/TGI/Ollama endpoints registered as regular deployments with `cost_tier: 0`, `cloud: any`, mandatory `gpu_pool_ref`). Once at least one healthy self-hosted deployment exists in the cell, it becomes the default rung 0 of every class except `judge`. Ladder falls through to hosted rung 1 if all self-hosted deployments are unhealthy (span records `datacern.routing.slm_fallback=true`).
- **AIG-FR-085 (Should)** **Distillation lifecycle hook.** `POST /api/v1/admin/distillation/candidates?class=&window=` (platform operator) streams a sanitized training set — `{prompt_masked, tools_signature, response_masked, reward, decision_urn?}` — assembled by joining `request_log` (this service) with case-service resolution ledger and eval-service scores. Consumed by an experiment-service pipeline that fine-tunes and re-registers the resulting model as a self-hosted deployment; promotion into the active ladder gated by eval-service acceptance (BRD 16). Zero PII (Presidio pre-mask required on every field).
- **AIG-FR-086 (Must)** **Batch tier.** New endpoints `POST /v1/batches {inputs[], model_alias, request_class_base, sla_hours ≤ 24}` → `202 {batch_id}`; served via provider batch APIs (Anthropic Batch, OpenAI Batch, Bedrock Batch, self-hosted queue) at their discounted rates (~50%). Progress via SSE from realtime-hub; results via `GET /v1/batches/:id`. Metered with `batch=true` and the discounted price version. Batch tier refuses inputs whose caller marks `sla_hours < 1` (403 `INTERACTIVE_TOO_SHORT`).
- **AIG-FR-087 (Should)** **Provider price ledger.** `provider_prices` table versions per-provider USD/token rates + committed-use discount overrides + effective date range. A daily job computes `effective_rate` per (deployment, class) and stores it. Router uses effective rate when picking between deployments within an equivalence class (§AIG-FR-083). Never applied to `judge`.
- **AIG-FR-088 (Must)** **Workflow-level budgets (agent run caps).** Every request accepts `x-datacern-workflow-id` (minted by agent-runtime per agent run). Gateway tracks per workflow: total LLM calls, total input+output tokens, reflection count (`x-datacern-reflection-index`). Class defaults (tenant-overridable): `chat` 30 calls / 60K in-tokens / 3 reflections; `sql-gen` 8 / 20K / 1; `judge` unbounded (bounded by eval budgets). Exceeded → 429 `WORKFLOW_BUDGET_EXHAUSTED` with the exceeded metric; agent-runtime treats this as a terminal signal and aborts the run.
- **AIG-FR-089 (Must)** **Decision URN attribution.** Every request accepts `x-datacern-decision-urn: <urn>[, <urn>…]` (case, chart, proposal, or other decision-bearing resource). URNs validated syntactically; included on every `ai.token_usage.v1` event as `decision_urns[]`. Contract with usage-service BRD 17 §3.8: enables cost-per-decision and ROI aggregation.
- **AIG-FR-090 (Should)** **Cross-tier savings ceiling.** Router computes an estimated savings figure per response (`baseline_frontier_cost_usd - actual_cost_usd`) and adds it to the metering event as `savings_usd_est`. Marketing/finance reporting flows through usage-service, never surfaced to end users as savings (avoids Goodhart-ing the gate).
- **AIG-FR-091 (Should)** **Semantic-cache upgrade.** Cache lookup precedence: (1) memory-service task-recall tool (identical prior workflow output for the same principal), (2) exact-match tier, (3) semantic tier (§AIG-FR-040). Memory-service tier only when caller supplies `x-datacern-memory-key`; hits emit metering with `cached=memory` and $0.
- **AIG-FR-092 (Should)** **Kill switch by class.** Per-tenant `class_disabled: [chat|sql-gen|judge|embed|batch]` config; requests to a disabled class return 403 `CLASS_DISABLED`. Enables staged rollout / incident response without touching budgets.

## 4. Domain model & data

Postgres `ai_gateway` DB. All tables carry `id uuidv7 PK, tenant_id uuid NOT NULL (platform rows use the reserved platform tenant uuid), created_at, updated_at, deleted_at` + RLS per MASTER-FR-001.

| Table | Key columns | Notes / indexes |
|---|---|---|
| `provider_deployments` | provider enum, model_family text, deployment_name text, region text, cloud enum(aws,azure,gcp), endpoint_vault_ref text, tpm_limit int, rpm_limit int, priority int, status enum(active,draining,disabled) | idx (cloud, status, priority); platform-scoped |
| `model_ladders` | request_class enum(chat,sql_gen,judge,embed), scope enum(platform,tenant), rungs jsonb (≤8KB: ordered rung array — documented JSONB use per MASTER-FR-061), version int | unique (tenant_id, request_class); idx (request_class) |
| `budgets` | scope_type enum(platform,tenant,workspace,principal,virtual_key), scope_ref text, window enum(daily,monthly), limit_usd numeric(12,4), degrade_pct smallint default 95, status enum(active,disabled) | unique (tenant_id, scope_type, scope_ref, window) |
| `budget_spend` | budget_id FK, window_start date, spend_usd numeric(14,6), reserved_usd numeric(14,6) | partitioned by month (MASTER-FR-062); unique (budget_id, window_start); retention 24 months |
| `virtual_keys` | key_hash char(64) unique, principal_type enum, principal_id text, allowed_request_classes text[], max_rung smallint, expires_at, status enum(active,revoked) | idx (tenant_id, principal_id), idx key_hash |
| `guardrail_policies` | policy jsonb (≤8KB, documented), version int | unique (tenant_id); history kept via version rows |
| `semantic_cache_entries` | prompt_hash char(64), context_hash char(64), embedding vector(1536), response_ref text (object storage pointer if >64KB else inline jsonb), expires_at | idx (tenant_id, prompt_hash, context_hash); ivfflat on embedding filtered by tenant; TTL job hourly |
| `request_log` | request_id uuidv7, principal, request_class, model_alias, rung, tokens in/out, cost_usd, cache bool, guardrail_flags text[], status, latency_ms, trace_id | partitioned by month; retention 90 days (full detail lives in ClickHouse via audit/usage) |
| `outbox` | standard transactional outbox (MASTER-FR-034) | poller → Kafka |

**State machines.**
- Provider deployment: `active → draining → disabled` (drain finishes in-flight, accepts none); `disabled → active` re-enable. Guard: cannot disable the last active deployment of a rung that has live tenant ladders without `force=true`.
- Virtual key: `active → revoked` (terminal); `active → expired` (by clock).
- Budget window: `open → threshold_80 → threshold_95(degrading) → exhausted → reset(next window)`; transitions emit events exactly once.

**Index & retention summary.**

| Table | Hot-path indexes | Partitioning / retention |
|---|---|---|
| `provider_deployments` | (cloud, status, priority) | none / permanent |
| `budgets` | (tenant_id, scope_type, scope_ref, window) unique | none / soft-delete |
| `budget_spend` | (budget_id, window_start) unique | monthly / 24 months |
| `virtual_keys` | key_hash unique; (tenant_id, principal_id) | none / revoked rows kept 13 months |
| `semantic_cache_entries` | (tenant_id, prompt_hash, context_hash); ivfflat(embedding) | TTL job hourly / max 7d |
| `request_log` | (tenant_id, created_at); request_id | monthly / 90 days |

**Redis keyspace (hot state).** `bud:{budget_id}:{window_start}` remaining-cents counter (atomic DECRBY reserve / INCRBY refund) · `budthr:{budget_id}:{window}:{pct}` SETNX threshold-emission guard · `keyrev` pub/sub channel for key/policy invalidation · `adm:{tenant}:streams` concurrent-stream gauge · `cache:{tenant}:{prompt_hash}:{context_hash}` exact-tier entries.

## 5. API specification

Base `/api/v1` (admin) + OpenAI-compatible `/v1/*` (data plane). All errors per MASTER-FR-024.

| Method & path | Purpose | Auth | Notable errors |
|---|---|---|---|
| `POST /v1/chat/completions` | proxy chat (stream or not) | virtual key + JWT | 401 KEY_INVALID, 402 BUDGET_EXHAUSTED, 403 LADDER_CAP, 422 GUARDRAIL_BLOCKED, 429 RATE_LIMITED, 502 OUTPUT_SCHEMA_INVALID, 503 UPSTREAM_UNAVAILABLE |
| `POST /v1/embeddings` | proxy embeddings | virtual key + JWT | as above |
| `GET /api/v1/admin/providers` · `POST` · `PATCH /:id` · `POST /:id/drain` | provider registry | operator | 409 CONFLICT (last-deployment guard) |
| `GET/PUT /api/v1/admin/ladders/:request_class` | ladder config (platform or tenant override) | operator / tenant admin | VALIDATION_FAILED |
| `GET/POST /api/v1/admin/budgets` · `PATCH/DELETE /:id` | budget CRUD | tenant admin (operator for platform scope) | VALIDATION_FAILED |
| `GET /api/v1/admin/spend?scope_type=&scope_ref=&window=` | live spend | tenant admin | — |
| `POST /api/v1/admin/keys` · `POST /:id/revoke` · `GET` | virtual keys | tenant admin; service mint via SPIFFE mTLS | — |
| `GET/PUT /api/v1/admin/guardrails` | tenant guardrail policy | tenant admin | — |
| `DELETE /api/v1/admin/cache?scope=` | cache invalidation | tenant admin | — |

**Example — data-plane chat request (agent-runtime caller):**
```http
POST /v1/chat/completions
Authorization: Bearer nk-8f2…            # virtual key (per-run, minted by agent-runtime)
X-Datacern-JWT: eyJhbGciOiJSUzI1NiI…      # platform RS256 JWT (typ=agent_obo)
x-datacern-request-class: sql-gen
x-datacern-feature: analytics_agent
x-datacern-agent-id: analytics
x-datacern-agent-version: 14
traceparent: 00-4bf9…-01

{"model": "datacern-auto", "stream": true, "stream_options": {"include_usage": true},
 "messages": [{"role": "system", "content": "…"}, {"role": "user", "content": "revenue by region, Q3"}],
 "response_format": {"type": "json_schema", "json_schema": {…}}}
```
Notes: `model: datacern-auto` delegates rung selection to the ladder; a concrete `model_alias` is allowed but capped by the key's `max_rung`. Tenant identity comes exclusively from the JWT.

**Example — budget creation:**
```json
POST /api/v1/admin/budgets
{"scope_type": "workspace", "scope_ref": "ws-7f3", "window": "monthly", "limit_usd": 150.0, "degrade_pct": 95}
→ 201 {"data": {"id": "b-01H…", "scope_type": "workspace", "scope_ref": "ws-7f3",
   "window": "monthly", "limit_usd": 150.0, "degrade_pct": 95, "status": "active"}}
```

**Example — ladder config (platform default for `sql-gen`):**
```json
PUT /api/v1/admin/ladders/sql-gen
{"rungs": [
  {"model_alias": "fast-small",  "max_tokens": 4096,  "temperature_default": 0.1, "cost_tier": 1},
  {"model_alias": "balanced",    "max_tokens": 8192,  "temperature_default": 0.1, "cost_tier": 2},
  {"model_alias": "frontier",    "max_tokens": 16384, "temperature_default": 0.1, "cost_tier": 3}]}
```

**Example — exhausted budget response (402):**
```json
{"error": {"code": "BUDGET_EXHAUSTED", "message": "Monthly budget for workspace ws-7f3 exhausted ($150.00/$150.00). Resets 2026-08-01T00:00:00Z.",
  "details": {"scope_type": "workspace", "scope_ref": "ws-7f3", "window": "monthly", "reset_at": "2026-08-01T00:00:00Z"}, "trace_id": "…"}}
```
**Example — degraded streaming response headers:** `x-datacern-degraded: budget`, `x-datacern-rung: 0`, `x-datacern-cache: miss`, `X-Trace-Id: …`.

## 6. Events

**Emitted** (topic `ai.events.v1` unless noted; envelope per MASTER-FR-031):
- `ai.token_usage.v1` (dedicated topic, high volume) — fields per AIG-FR-060.
- `budget.threshold` `{scope_type, scope_ref, window, pct: 80|95, limit_usd, spend_usd}` · `budget.exhausted` (pct:100) · `budget.anomaly`.
- `guardrail.triggered` `{kind: pii|injection|schema, mode, action: redacted|flagged|blocked, policy_version, request_id}` (no PII values — MASTER-FR-042).
- `provider.state_changed` `{deployment_id, from, to, reason}`.
- `key.created|revoked`, `ladder.updated`, `guardrail_policy.updated` (audit-consumed).

**Consumed:**
- `identity.events.v1: tenant.provisioned` → create default tenant budget (platform default limits), default guardrail policy, default ladder inheritance row. `tenant.suspended` → disable all tenant keys ≤ 30s.
- `usage.events.v1: budget.adjusted` (if usage-service is the budget UI writer) → reconcile limits.

## 7. Business rules & edge cases

- **BR-1** Fail-closed ordering: guardrail block > budget exhaustion > rate limit > upstream failure — the first applicable rejection wins and later stages never execute (no provider call after a block).
- **BR-2** A streaming response that crosses a budget threshold mid-stream is **not** cut off; settlement happens post-stream and the *next* request sees the new budget state. A stream is only refused pre-flight.
- **BR-3** Reservation vs. concurrency: two concurrent requests may together over-reserve a nearly-exhausted window; reservations are atomic Redis DECRBY on remaining-cents — the second reservation fails pre-flight if remaining < estimate. Post-settlement refunds unused reservation.
- **BR-4** Clock windows: daily = tenant-local midnight (tenant timezone from identity-service, default UTC); monthly = 1st of month tenant-local. Window boundaries computed server-side, never client-supplied.
- **BR-5** Price table changes apply to new requests only; in-flight settle at reservation-time prices. Price table is versioned config; every metering event records the price version.
- **BR-6** Cache poisoning defense: responses that carried guardrail flags are never cached; cache writes only for 2xx, schema-valid responses.
- **BR-7** Judge/system reserved budget (AIG-FR-023) is platform-scoped and sized so eval/guardrail internals never starve; it does not draw from tenant budgets, but judge calls are still metered with tenant attribution for cost accounting.
- **BR-8** Draining provider: in-flight completes, new requests skip it; if all rung deployments drain, requests fall through to next rung *up* (never silently down) and span records `datacern.routing.rung_fallback=up`.
- **BR-9** Multi-window stacking: a request must fit tenant-daily AND tenant-monthly AND workspace-daily … evaluation order is top-down (platform first); the error names the **most specific** exhausted scope.
- **BR-10** Presidio false positives: `redact` mode never blocks; `block` mode only for tenants that opt in; placeholders are deterministic per request (`<PII:EMAIL:1>`) so the LLM can reason about redacted entities consistently.
- **BR-11** Idempotency: `/v1/*` data-plane calls are not idempotent (streaming); retries are internal only. Admin POSTs honor `Idempotency-Key` per MASTER-FR-025.
- **BR-12** Tenant with zero configured budget inherits platform default tenant budget; a tenant can never be *unbudgeted*.
- **BR-13** Concurrency cap per tenant applies to streams only; non-streaming requests are capped by RPM. Both return 429 with `Retry-After` seconds computed from token-bucket refill.
- **BR-14** If Redis is unavailable: budget checks fall back to Postgres (degraded latency, alert fires); if Postgres is also unavailable the gateway fails closed (503) — never fail-open on budgets.
- **BR-15** Semantic-tier cache lookups run only when the exact tier misses and prompt length ≥ 64 tokens (short prompts produce false-positive similarity); similarity threshold is platform-tunable but never below 0.95.
- **BR-16** Escalation audit: every rung escalation (manual or automatic) records `{from_rung, to_rung, reason}` on the span and in the metering event — rung-distribution drift is a first-class cost signal.
- **BR-17** Embedding batches: a batch of ≤ 256 inputs is budget-reserved as one unit; partial provider failure fails the whole batch (callers retry idempotently) — no partial settlement complexity.
- **BR-18** Tenant offboarding (`tenant.suspended`/`tenant.deleted`): keys disabled ≤ 30s, cache entries dropped by tenant prefix, budget rows retained for final invoicing then archived per retention policy.
- **BR-19** Deterministic handler failure is silent to the caller: on handler exception or low confidence the router falls through to the LLM path with `datacern.handler=fallback:<kind>` on the span. Handler outages never surface to the end user.
- **BR-20** Auto-cascade never demotes a rung whose eval sample size < 100 for the current window; small samples cannot cause premature demotion. Auto-cascade is disabled when eval-service is unavailable; router stays at last decided rung and logs `cascade.paused` with reason.
- **BR-21** Self-hosted SLM tier is subject to the same guardrails (PII redaction, injection classification) as hosted providers — running on our own GPUs does not exempt the request. Guardrail policy version continues to gate the cache.
- **BR-22** Distillation candidates exclude any request whose `guardrail_flags` contain `pii_redacted` unless the placeholders are preserved and the payload is proven de-referenced (Presidio round-trip validation); on doubt, the sample is dropped.
- **BR-23** Batch tier does not evaluate tenant workflow budgets (§AIG-FR-088) — batches are backgrounded work; enforcement remains at the tenant/workspace scopes. A single batch that would exceed the workspace daily/monthly budget is refused pre-submission with `BUDGET_EXHAUSTED`.
- **BR-24** Decision URNs in `x-datacern-decision-urn` are trusted for attribution only; the gateway does NOT check the caller has permission to charge cost to that URN (usage-service reconciles ownership). A malformed URN causes the header to be silently dropped and metered without decision attribution — never a hard 4xx (avoids breaking mid-run agents on a metadata mistake).

### Enforcement pipeline order (normative)
```
request → authN (key + JWT) → attribution validation → admission (streams/RPM/TPM)
        → guardrails-in (PII redact ∥ injection classify) → semantic cache lookup
        → budget pre-flight (reserve, stacked windows, top-down)
        → ladder resolve (class → rung → cloud-affinity deployment)
        → provider call (retry/failover per AIG-FR-008)
        → guardrails-out (schema validation; de-redaction if configured)
        → cache write (if eligible) → budget settle → metering event → response
```
A rejection at any stage short-circuits all later stages; the stage that rejected is recorded on the span (`datacern.rejected_stage`).

## 8. Dependencies

- **Upstream callers:** agent-runtime (BRD 14), eval-service (BRD 16, judge ladder), memory-service (BRD 15, embed class), semantic-service, bff (none directly — UI never calls the gateway).
- **Downstream:** provider endpoints (Azure OpenAI, Bedrock, Vertex, Anthropic API) with creds from Vault; usage-service (consumes `ai.token_usage.v1`); audit-service (consumes guardrail/key/policy events); Langfuse + OTel collector.
- **Infra:** Postgres, Redis Cluster (budget counters, exact cache, key invalidation pub/sub), Kafka + Schema Registry, Vault, OPA sidecar (admin API authz), pgvector (semantic cache tier).
- **Contracts:** `ai.token_usage.v1` Avro schema is owned by ai-gateway; usage-service contract-tests against it. identity-service must include `cell_cloud` claim.

## 9. NFRs (deltas from master)

| Metric | Target |
|---|---|
| Added latency, non-streaming p95 (cache miss, guardrails on) | ≤ 150ms over provider |
| First-token added latency p95 (streaming) | ≤ 200ms |
| Budget check p99 | ≤ 15ms (Redis path) |
| Exact-cache hit p95 total latency | ≤ 60ms |
| Concurrent streams per cell | 2,000 (admission-controlled) |
| Availability | 99.95%; budget enforcement correctness is release-gating (no fail-open) |
| Metering completeness | 100% of provider-billed tokens appear in `ai.token_usage.v1` (reconciled daily against provider invoices, alert at >1% drift) |

## 10. Acceptance criteria

- **AC-1** Given a valid virtual key and JWT for tenant A, When `POST /v1/chat/completions` (class `chat`) is called, Then the response succeeds, carries `X-Trace-Id`, `x-datacern-rung`, and an `ai.token_usage.v1` event with matching `request_id` and correct token counts is on Kafka within 5s.
- **AC-2** Given tenant A's monthly workspace budget at 100%, When any principal in that workspace sends a request, Then the gateway returns HTTP 402 `BUDGET_EXHAUSTED` naming scope `workspace`, window `monthly`, and reset time, and no provider call is made.
- **AC-3** Given tenant budget spend crossing 95% during settlement, When the crossing occurs, Then exactly one `budget.threshold {pct:95}` event is emitted (verified under concurrent settlements) and subsequent requests are served at rung 0 with `x-datacern-degraded: budget` until reset.
- **AC-4** Given a request whose prompt contains an email address and tenant PII mode `redact`, When proxied, Then the provider receives `<PII:EMAIL:1>` in place of the address (verified via provider mock), a `guardrail.triggered {kind:pii, action:redacted}` event is emitted, and the raw email never appears in logs, spans, or events.
- **AC-5** Given a prompt scoring above the tenant's injection block threshold, When submitted, Then the gateway returns 422 `GUARDRAIL_BLOCKED`, no provider call occurs, and an audit event is recorded.
- **AC-6** Given two identical prompts from tenant A and tenant B, When the second tenant's request arrives after the first is cached, Then tenant B gets a cache **miss** (isolation), while an identical repeat from tenant A within TTL gets `x-datacern-cache: hit` and a $0-cost metering event with `cached=true`.
- **AC-7** Given the primary same-cloud deployment returns 500 twice, When a request is routed, Then it fails over to the next deployment within 3 total attempts and succeeds, and the span records the retry chain; Given all deployments of all rungs fail, Then 503 `UPSTREAM_UNAVAILABLE` is returned in ≤ (timeout budget).
- **AC-8** Given a request with `response_format: json_schema` and a provider mock returning invalid JSON at rung 0 and valid at rung 1, When called, Then the gateway retries at rung 0 once, escalates to rung 1, and returns the valid output with `x-datacern-rung: 1`.
- **AC-9** Given a revoked virtual key, When used ≥ 30s after revocation, Then the gateway returns 401 `KEY_INVALID` on every instance of a multi-replica deployment.
- **AC-10** Given a tenant on a GCP cell and active deployments on both GCP (priority 10) and AWS (priority 1), When a chat request is routed, Then the GCP deployment is chosen (cloud affinity beats priority) and `datacern.routing.cross_cloud` is absent/false.
- **AC-11** Given `stream: true`, When the provider streams, Then the client receives SSE chunks with added first-token latency p95 ≤ 200ms in the perf suite, and the final usage chunk matches the metering event.
- **AC-12** Given tenant A's token attempting `GET /api/v1/admin/budgets` filtered to tenant B via any parameter, When called, Then only tenant A rows return; direct fetch of a tenant B budget id returns 404 and emits `security.cross_tenant_denied` (MASTER-FR-003).
- **AC-13** Given Redis is stopped in the integration environment, When requests continue, Then budget checks succeed via Postgres fallback with alert fired; When Postgres is also stopped, Then data-plane requests return 503 (fail-closed proven).
- **AC-14** Given a `judge`-class request from eval-service, When served, Then temperature is forced to 0, the judge ladder is used, spend draws from the platform system budget, and the metering event carries `feature: eval` with tenant attribution.
- **AC-15** Given a tenant exceeding its concurrent-stream cap, When an additional streaming request arrives, Then 429 with `Retry-After` is returned before any provider call, and a stream slot freed by a completing request admits the next request.
- **AC-16** Given the daily reconciliation job comparing `ai.token_usage.v1` totals against provider-reported usage for the prior day, When drift exceeds 1%, Then an alert fires with per-deployment attribution (verified with an injected synthetic gap in the test environment).
- **AC-17** Given a `sql-gen` request naming a governed metric available via semantic-service, When the deterministic-first pre-router runs with policy `prefer`, Then the response returns from `semantic-compile` with `x-datacern-handler: deterministic:semantic-compile`, zero provider tokens are billed, and metering records `provider_cost_usd=0` with `handler_cost_usd > 0`.
- **AC-18** Given policy `deterministic_first: enforce` and a confident handler match, When the caller also sends `x-datacern-escalate: true`, Then escalation is refused (403 `DETERMINISTIC_ENFORCED`) and the handler answer is returned.
- **AC-19** Given a rung whose rolling 500-sample eval pass rate drops from 96% to 88% over 24h, When the next in-class request arrives, Then the router promotes to rung N+1, `cascade.rung_shifted {from:N, to:N+1, reason:eval_promote}` is emitted, and the `rung_policies` row reflects the new pinning.
- **AC-20** Given a healthy self-hosted SLM deployment for `chat`, When a class-`chat` request arrives without pinning, Then rung 0 serves it from the self-hosted deployment; When the self-hosted deployment goes unhealthy, Then the next request routes to hosted rung 1 with `datacern.routing.slm_fallback=true`.
- **AC-21** Given an agent-runtime workflow that has already made 30 class-`chat` calls under `x-datacern-workflow-id: wf-abc`, When call 31 arrives, Then the gateway returns 429 `WORKFLOW_BUDGET_EXHAUSTED` with `exceeded_metric: calls, limit: 30`, and no provider call occurs; agent-runtime's next run under a new workflow id succeeds.
- **AC-22** Given `POST /v1/batches` with 4,000 inputs and `sla_hours: 12`, When the batch is served, Then the metering event carries `batch=true` and the discounted price version; When the same batch is submitted with `sla_hours: 0.25`, Then it is rejected 403 `INTERACTIVE_TOO_SHORT`.
- **AC-23** Given a request with `x-datacern-decision-urn: wr:t-42:case:case/c-9,wr:t-42:proposal:proposal/p-4`, When served, Then `ai.token_usage.v1` carries `decision_urns:["wr:t-42:case:case/c-9","wr:t-42:proposal:proposal/p-4"]`; a malformed URN in the header is silently dropped and the request still succeeds.
- **AC-24** Given a distillation candidate stream requested by a platform operator over the last 30 days for class `sql-gen`, When streamed, Then each row's prompt and response are Presidio-masked (round-trip verified in an integration test on injected fixture PII), rewards join from eval-service scores, and `decision_urn` is preserved.

## 11. Out of scope / future

Self-hosted vLLM provider class; provider-side prompt-caching optimization tuning; per-usage-point guardrails (agent-runtime BRD 14); fine-grained per-model-version pinning for tenants (silo tier); Slack budget notifications (notification-service consumes events already — UI/channel work is theirs); multi-currency budgets; GPU capacity brokering.
