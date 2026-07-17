# BRD 14 — agent-runtime + agent-registry

**Service:** agent-runtime (execution) + agent-registry (definitions, versions, principals, A2A cards) — one bounded context, two deployables, shared DB · **Language:** Python 3.12 (FastAPI + LangGraph 1.x + Temporal Python SDK) · **Phase:** 2–4
**Inherits:** `00_MASTER_BRD.md`. Architecture refs: `WINDROSE_PLATFORM_ARCHITECTURE.md` §8.3–8.6, §8.9; `WINDROSE_V3_AGENTIC_ARCHITECTURE.md` §5.5–5.6, §5.8–5.10. Domain lineage: `chat-agent-service` (production analytics agent this rebuild evolves).

---

## 1. Overview

**Purpose.** agent-runtime executes agents: LangGraph graphs wrapped in Temporal workflows (durability, retries, timers, HITL signals), with a strict session model, gVisor-sandboxed code execution, and OpenAI-compatible chat APIs streaming via realtime-hub. agent-registry is the system of record for agent definitions, **immutable versions** (graph ref + prompt refs + toolset + model + eval gate), agent principals (identity), per-tenant version pinning, canary/shadow deploys, kill switches, and signed A2A agent cards. The **Proposal framework** — the only path for agent writes — lives here: write-tier tool intents become proposal objects awaiting durable human decision signals.

**Lineage.** The analytics agent evolves from `chat-agent-service`. **Preserved:** the LangGraph shape (query-analyzer node → tool node → reflection loop with `max_reflections`, reflection-skip for trivial queries and non-data answers), chart-context tools (dashboard chart summaries, chart detail lookup, chart-data analysis), state fields (`original_user_query`, `reflection_count`, `reflection_notes`, `used_data_tool`), the injected-context tool pattern. **Fixed:** direct Azure OpenAI calls → ai-gateway (BRD 12); inline per-request history → memory-service (BRD 15); unsandboxed PandasAI over raw rows → semantic-layer aggregation pushdown, with any generated code in gVisor; `algorithm='none'` CURRENT_CONTEXT JWT → RS256 OBO tokens; hardcoded financial-analyst persona → per-tenant prompt configuration in the agent version; no evals → eval-gated releases (BRD 16); direct IDO/config HTTP calls → MCP tools via tool-plane (BRD 13).

**In scope:** agent definition/version model + lifecycle; run execution (Temporal per run, LangGraph checkpointer → Postgres); session model; sandbox execution; the 8-agent catalog; proposal framework incl. per-tenant auto-execute policy; A2A cards + meta-agent delegation; canary/shadow/pinning/rollback/kill switch; chat API + SSE via realtime-hub; per-tenant session pools & fair-share queueing.
**Out of scope:** model routing/budgets (BRD 12), tool policy enforcement (BRD 13), memory storage (BRD 15), eval scoring (BRD 16 — the registry only *enforces* eval gates), approval-inbox UI (ui-web/bff), OBO token *minting* (identity-service; runtime requests and uses them).

## 2. Actors & user stories

Personas: **End User** (analyst/investigator), **Approver** (case supervisor/workspace admin), **Tenant Admin**, **Agent Engineer** (platform team), **Platform Operator**, **Meta-agent** (internal), **Scheduler** (Temporal cron for autonomous runs).

- **US-1** As an End User, I open the copilot on a dashboard and ask "why did Q3 revenue dip?"; the analytics agent answers with cited, semantic-layer-grounded data, streamed token-by-token.
- **US-2** As an End User, I resume yesterday's session and the agent retains conversation context (until session lifetime limits apply).
- **US-3** As an Approver, when the case-triage copilot proposes "assign case c-91 to Dana, severity high", I see the proposal with rationale, affected URNs, and predicted effect in my approval inbox, and I approve, reject-with-message, edit-args, or respond — and my decision executes or records durably even if I take 3 days.
- **US-4** As a Tenant Admin, I configure that `write-proposal` tools with `side_effects=reversible` auto-execute for the dashboard-designer agent, but destructive actions can never auto-execute.
- **US-5** As an Agent Engineer, I publish analytics-agent v15 (new prompt + toolset); publish is blocked unless the eval-service gate passes vs v14's baseline.
- **US-6** As an Agent Engineer, I canary v15 at 10% of tenant traffic (or shadow it on 100% with no user-visible output) and promote only when canary eval scores ≥ baseline.
- **US-7** As a Tenant Admin, I pin my tenant to analytics-agent v14 until my team validates v15; as a Platform Operator I can roll every unpinned tenant back to v14 in one action.
- **US-8** As a Platform Operator, I flip the kill switch for (case-triage@v3 × tenant t-42) and all its sessions terminate gracefully within seconds with a clear user message.
- **US-9** As the Meta-agent, I receive "onboard this S3 bucket and build a quality dashboard", discover capable agents via A2A cards, delegate reads in parallel and writes serially, and return a consolidated result.
- **US-10** As a Governance Scheduler, the governance agent runs nightly under its **agent principal** (never a borrowed user identity) and opens retrain proposals when drift exceeds thresholds.
- **US-11** As an End User, when the model-training agent needs custom feature code, the code runs in a gVisor sandbox with no network and resource caps — and I can see that in the run trace.
- **US-12** As a Compliance Officer, every run records `actor=user via agent@version` (or `actor=agent` for autonomous), every proposal decision has actor+timestamp, and chat surfaces carry AI-disclosure labels (EU AI Act Art. 50).
- **US-13** As an End User, if the agent is mid-answer and my connection drops, reconnecting to the session replays the missed stream from realtime-hub and the run itself never dies (Temporal durability).

## 3. Functional requirements

### Agent registry: definitions, versions, principals
- **ART-FR-001 (Must)** AgentDefinition: `{agent_key (analytics|case-triage|onboarding|dashboard-designer|model-training|inference|governance|meta-router|…), display_name, description, owner_team, default_write_mode: read_only|proposal, status}`.
- **ART-FR-002 (Must)** AgentVersion (immutable once published): `{agent_key, version int, graph_ref (registered graph module id + code digest), prompt_refs[] (versioned prompt artifact ids + digests), toolset[] {tool_id, version_range}, model_config {request_class, max_rung, temperature, per-node overrides}, guardrail_profile, memory_policy {scopes_readable, scopes_writable}, eval_gate {suite_id, baseline_version, thresholds}, a2a_card jsonb, status: draft→published→deprecated→retired}`. Any field change ⇒ new version. Publish **requires** a passing eval-service gate result id (ART-FR-060).
- **ART-FR-003 (Must)** Each published version gets an **AgentPrincipal** in identity-service (SPIFFE workload identity + platform principal `agent:<key>@v<N>`); registry orchestrates creation via identity-service API and stores the principal ref.
- **ART-FR-004 (Must)** Per-tenant agent config: `{tenant_id, agent_key, enabled, pinned_version?, prompt_params jsonb (tenant persona/domain hints — replaces the hardcoded financial-analyst persona), auto_execute_policy (ART-FR-042), budget_scope_ref}`.
- **ART-FR-005 (Must)** Toolset validation at publish: every `{tool_id, version_range}` must resolve to a published tool version in tool-plane; write-tier tools require the definition's write mode = `proposal`.

### Execution model (LangGraph-in-Temporal)
- **ART-FR-010 (Must)** One Temporal **workflow per agent run** (`AgentRunWorkflow`, task queue per tenant tier/pool). LangGraph node executions are Temporal activities; LangGraph checkpointer persists graph state to Postgres after every super-step keyed `(run_id, checkpoint_id)`. Workflow provides: activity retries (default 3, exponential backoff, non-retryable for guardrail/budget errors), timers (idle/lifetime/SLA), signals (user message, proposal decision, cancel, kill).
- **ART-FR-011 (Must)** Run lifecycle: `queued → running → awaiting_input (user turn) → awaiting_approval (proposal) → running → completed | failed | cancelled | killed | expired`. Every transition emits `ai.agent_run.v1` events and OTel `invoke_agent` spans.
- **ART-FR-012 (Must)** All LLM calls go through ai-gateway with a per-run virtual key (minted at run start, TTL = session lifetime); all tool calls go through tool-plane MCP with the run's OBO token (user-initiated) or agent-principal token (autonomous). Direct provider or direct domain-service calls are forbidden (netpol enforced).
- **ART-FR-013 (Must)** **Analytics agent graph v1** (evolved from chat-agent-service): nodes `query_analyzer` (LLM + bound tools) → `call_tool` → `reflection`; conditional routing preserved: tool_calls → call_tool; trivial-query and no-data-tool-used paths skip reflection; reflection evaluates draft answer completeness (structured JSON verdict), loops back with feedback up to `max_reflections` (default 1, per-tenant configurable ≤ 3), then forces final synthesis. Tools: `chart.get_dashboard_charts` (formatted chart summaries + shared-dataset hints), `chart.get_chart_details` (metadata/config), `semantic.compile_and_run` (metric+dims+filters → governed SQL, replacing raw-row PandasAI), `semantic.list_metrics`, `query.dry_run` — all via MCP.
**Analytics agent graph (normative shape, preserved from chat-agent-service):**
```
            ┌──────────────────────┐   tool_calls    ┌───────────┐
 entry ───► │  query_analyzer      │ ──────────────► │ call_tool │
            │  (LLM + bound tools) │ ◄────────────── │ (MCP)     │
            └─────────┬────────────┘   results       └───────────┘
                      │ no tool_calls
        trivial query │ or no data tool used ────────────► END
                      ▼
            ┌──────────────────────┐  incomplete + suggested_action
            │  reflection          │ ────────────► query_analyzer (feedback injected)
            │  (JSON verdict)      │  complete | max_reflections → final synthesis → END
            └──────────────────────┘
```
Reflection verdict schema (structured output via gateway schema validation): `{is_complete: bool, reasoning: string, missing_aspects: string[], suggested_action: string|"none", specific_tool_call_needed: string|null}`. State fields carried per run: `original_user_query, reflection_count, max_reflections, reflection_notes[], used_data_tool` (names preserved for replay compatibility with harvested V1 traces).

- **ART-FR-014 (Must)** Run inputs are sanitized state: injected context (`workspace_id`, resource URN of the page, tenant params) is server-derived, never client-supplied identity (MASTER-FR-002 analog to the old injected `current_context`).
- **ART-FR-015 (Must)** Replay: any historical run is re-executable against a specified agent version from stored inputs + checkpoints (eval and debugging use), in a no-side-effect mode (write tools stubbed).
- **ART-FR-016 (Must)** Fair-share admission: per-tenant session pools (pool/bridge/silo tiers); queue depth per tenant with weighted fair scheduling; over-capacity → 429 + Retry-After. Concurrent stream caps delegated to ai-gateway; run-start admission here.

### Session model
- **ART-FR-020 (Must)** Session: `{session_id, tenant_id, user_id, agent_key, agent_version (resolved at creation), context_urn?, status: active→idle→terminated|expired, created_at, last_activity_at}`. One session ↔ many runs (one per user turn or delegated task).
- **ART-FR-021 (Must)** **Idle timeout 15 min** (no user message or run activity) → session `idle`; resumable within lifetime. **Max lifetime 8 h** from creation → `expired`, non-resumable; user gets a fresh session (memory-service preserves durable context). Timers implemented as Temporal timers, not cron sweeps.
- **ART-FR-022 (Must)** **Sanitization at termination/expiry:** session working state (messages, checkpoints, tool outputs, sandbox scratch) is purged from Redis and sandbox volumes within 60s; Postgres checkpoints retained 30 days for replay/eval then hard-deleted; anything worth keeping must have been explicitly written to memory-service under its governance.
- **ART-FR-023 (Must)** Session resume validates: same user, session `active|idle`, agent version not killed; version upgrades never happen mid-session.

### Sandbox execution
- **ART-FR-030 (Must)** Any LLM-generated code (pandas analysis, python_expression features, chart transforms) executes only in **gVisor-sandboxed pods** on the `agents-sandbox` node pool: no network by default (egress netpol deny-all; explicit per-tool allowlist possible, operator-approved), resource caps (default 1 vCPU, 2GiB RAM, 4GiB ephemeral disk, 120s wall clock), read-only input mount, no service account token.
- **ART-FR-031 (Must)** Sandbox I/O contract: inputs passed as files/Arrow buffers; outputs captured as files + stdout (1MB cap); executor returns `{exit_code, outputs, resource_usage, truncated flags}`. Sandbox pod per execution (no reuse across tenants; warm pool per tenant tier allowed).
- **ART-FR-032 (Must)** Sandbox executions are audited (`ai.code_executed.v1`: code digest, agent, run, resource usage, exit) and visible in the run trace.

### Agent catalog (initial 8 — each ships as an AgentDefinition + versions)
- **ART-FR-040 (Must)** Catalog per architecture §8.4, each with declared grounding sources and write mode:
  | Agent key | Grounding | Write mode |
  |---|---|---|
  | `analytics` | semantic layer + verified queries first; generated SQL fallback with dry-run EXPLAIN + cost ceiling + row limits | read-only |
  | `case-triage` | case row refs + RAG over resolved cases (memory-service corpora) + SHAP explanations | proposals: severity, assignee, disposition |
  | `onboarding` | connection schemas + profiling output | proposals: ingestion configs, mappings |
  | `dashboard-designer` | semantic layer + chart type catalog | proposals: draft dashboards |
  | `model-training` | algorithm component templates + MLflow history | proposals: filled pipeline templates |
  | `inference` | model registry + dataset compatibility | proposals: inference jobs |
  | `governance` | drift metrics, run metadata | proposals: retrain (Temporal HITL) |
  | `meta-router` | agent-registry A2A cards | delegates only; no direct writes |
  Phasing: analytics (Phase 2); case-triage, onboarding, dashboard-designer, model-training (Phase 4); inference, governance, meta-router (Phase 5). The runtime itself must be agent-agnostic: adding an agent = new definition + graph module, no runtime code fork.

### Proposal framework
- **ART-FR-041 (Must)** Proposal object: `{proposal_id, tenant_id, session_id, run_id, agent_key, agent_version, obo_user?, tool_id, tool_version, args (validated by tool-plane), rationale (agent's stated reasoning, ≤ 4,000 chars), affected_urns[], predicted_effect {summary, reversibility: reversible|irreversible, blast_radius: item_count}, expires_at (default 7 d), status: pending → approved|rejected|edited_approved|expired|superseded|cancelled, decision {actor, action, message?, edited_args?, decided_at}}`.
- **ART-FR-042 (Must)** Flow: agent's write-tier tool call → tool-plane returns `PROPOSAL_REQUIRED` → runtime creates Proposal, emits `ai.proposal.v1 {proposal.created}`, notifies (notification-service event), and the Temporal workflow **awaits a decision signal** durably (days-long OK). Decisions: **approve** (execute with original args), **reject-with-message** (message returned to the agent as a tool result; agent may continue/replan), **edit-args** (approver modifies args; re-validated by tool-plane schema+policy; executes edited args; diff stored), **respond** (free-text guidance, no execution; agent continues). Execution uses a signed proposal-execution grant presented to tool-plane (BRD 13 TPL-FR-035).
- **ART-FR-043 (Must)** **Per-tenant auto-execute policy matrix:** `{agent_key × tool tier × side_effects} → auto|manual`, editable by tenant admin. Hard rules: `destructive` **never** auto (immutable); `admin` tier never auto; default everything manual. Auto-executed proposals still create the proposal record with `decision.actor = policy:auto` for audit.
**Proposal object example:**
```json
{"proposal_id": "p-01H8Z3", "tenant_id": "t-42", "run_id": "r-01H8Y9",
 "agent_key": "case-triage", "agent_version": 3, "obo_user": "u-77",
 "tool_id": "case.assign", "tool_version": "1.2.0",
 "args": {"case_id": "c-91", "assignee_id": "u-dana", "severity": "high"},
 "rationale": "Vendor pattern matches 14 resolved duplicate-invoice cases (91% assigned to Dana's team); amount variance exceeds tenant threshold, supporting severity high.",
 "affected_urns": ["wr:t-42:case:case/c-91"],
 "predicted_effect": {"summary": "Case c-91 assigned to Dana; SLA timer restarts; severity high triggers escalation notification", "reversibility": "reversible", "blast_radius": 1},
 "expires_at": "2026-07-16T09:00:00Z", "status": "pending"}
```

**Auto-execute policy matrix example (tenant config):**
```json
{"auto_execute_policy": {
   "dashboard-designer": {"write-proposal": {"none": "auto", "reversible": "auto", "destructive": "manual"}},
   "case-triage":        {"write-proposal": {"none": "manual", "reversible": "manual", "destructive": "manual"}},
   "*":                  {"write-proposal": {"*": "manual"}, "admin": {"*": "manual"}}}}
```
`destructive` and `admin` cells are display-only — the API rejects any attempt to set them to `auto` (422), and the evaluator hard-codes `manual` for them regardless of stored config.

- **ART-FR-044 (Must)** Approver eligibility: OPA check — decision actor must hold the underlying action's permission on every affected URN (an approver cannot approve what they couldn't do themselves); the proposing agent's OBO user may approve only if tenant policy `self_approval=true` (default false).
- **ART-FR-045 (Must)** Expiry: `expires_at` reached → status `expired`, signal delivered to workflow (agent informed, run continues or completes gracefully). Superseded: a newer proposal from the same run for the same tool+URNs marks earlier pending ones `superseded`.
- **ART-FR-046 (Must)** Rejection reasons and edit-diffs are emitted in `ai.proposal.v1` for eval-service dataset harvesting (BRD 16).

### A2A & meta-agent
- **ART-FR-050 (Must)** Every published agent version exposes an **A2A v1.0 agent card** (capabilities, skills, endpoint, auth requirements), **signed** with the registry's key; cards served at `GET /api/v1/a2a/cards/:agent_key` and via A2A discovery. Spec version pinned.
- **ART-FR-051 (Must)** Meta-router delegates via A2A task semantics to internal agents only (federation off): **parallelize read-only tasks, serialize any task that can produce proposals**; child runs are linked (`parent_run_id`), inherit session budget scope and OBO token; recursion depth ≤ 2; total child fan-out ≤ 5 per parent run.
- **ART-FR-052 (Could)** Cross-org A2A federation — registry-ready (cards signed, endpoints versioned), disabled by flag.

**A2A agent card example (signed, served per version):**
```json
{"name": "windrose-analytics", "version": "14", "protocolVersion": "1.0",
 "description": "Conversational analytics over governed semantic-layer data. Read-only.",
 "url": "https://agent-runtime.<cell>.windrose.internal/a2a/analytics",
 "capabilities": {"streaming": true, "pushNotifications": false},
 "skills": [
   {"id": "answer_data_question", "description": "Answer NL questions about dashboards/datasets with citations", "tags": ["analytics", "read-only"]},
   {"id": "explain_chart", "description": "Explain a chart's configuration and drivers", "tags": ["charts"]}],
 "securitySchemes": {"windrose-obo": {"type": "http", "scheme": "bearer"}},
 "x-windrose": {"agent_key": "analytics", "write_mode": "read_only", "eval_score_ref": "gr-01HX"},
 "signature": {"alg": "RS256", "kid": "agent-registry-2026-1", "value": "…"}}
```

### Versioning: canary, shadow, pinning, rollback, kill
- **ART-FR-060 (Must)** Publish gate: `POST /versions/:v/publish` requires an eval-service gate result (`gate_passed=true` vs `eval_gate.baseline_version`) newer than the version's last content change. No gate, no publish (operator `force` requires reason + emits compliance event).
- **ART-FR-061 (Must)** Rollout modes per (agent_key, cell): `direct` (all unpinned tenants), `canary {pct 1–50, tenant allow/deny list}` (fraction of *sessions* routed to candidate; deterministic by session hash), `shadow` (candidate runs on a copy of live inputs, outputs discarded — never user-visible, write tools stubbed, marked in traces). Canary/shadow comparison scores come from eval-service (BRD 16 canary API); promotion is manual or auto-on-threshold.
- **ART-FR-062 (Must)** Tenant pinning wins over rollout: pinned tenants never receive canary or new defaults. Rollback = set cell default back to prior version (one API call); in-flight sessions finish on their resolved version, new sessions get the rollback target.
- **ART-FR-063 (Must)** **Kill switch per (agent_version × tenant)**, plus agent-version-wide and agent-wide: active sessions receive kill signal → runs cancel gracefully (current LLM stream allowed ≤ 10s to close), user message "This assistant is temporarily unavailable", state sanitized; new sessions refused `AGENT_KILLED`. Propagation ≤ 5s; Postgres-backed, Redis pub/sub pushed.

### Chat API & streaming
- **ART-FR-070 (Must)** OpenAI-compatible chat endpoint `POST /api/v1/agents/:agent_key/chat/completions` (messages[], stream, metadata: {session_id?, context_urn?}): creates/resumes a session, starts a run, streams via SSE. Streaming is relayed through **realtime-hub** (`stream_topic = agent_run:<run_id>`): runtime publishes chunks; clients consume from realtime-hub (supports reconnect/replay from last event id). Direct SSE from the runtime allowed for service-to-service callers only.
- **ART-FR-071 (Must)** Stream event types: `token`, `tool_call_started {tool_id}`, `tool_call_result {digest, citation_refs}`, `proposal_created {proposal_id}`, `reflection {iteration}`, `run_completed {usage, citations[]}`, `error`. UI renders trace + citations from these (agent-run visualizer contract).
- **ART-FR-072 (Must)** Responses carry AI-disclosure metadata (`x-windrose-ai-generated: true` + `run_completed.provenance`) for Art. 50 labeling; generated artifacts (draft dashboards, triage notes) get provenance fields `{agent_key, agent_version, run_id}` in their proposals.
- **ART-FR-073 (Must)** Proposal APIs: `GET /api/v1/proposals?filter[status]=pending` (approval inbox, paginated), `GET /:id`, `POST /:id/decide {action, message?, edited_args?}` (idempotent per proposal — first decision wins, later attempts 409 CONFLICT).

## 4. Domain model & data

Postgres `agent_runtime` DB; standard columns + RLS. Temporal is the workflow store (its own persistence); this DB holds domain state.

| Table | Key columns | Indexes / notes |
|---|---|---|
| `agent_definitions` | agent_key unique, display_name, owner_team, default_write_mode, status | platform-scoped |
| `agent_versions` | agent_key, version int, graph_ref, graph_digest, prompt_refs jsonb (≤8KB), toolset jsonb (≤16KB), model_config jsonb (≤4KB), guardrail_profile text, memory_policy jsonb, eval_gate jsonb, eval_gate_result_id?, a2a_card jsonb (≤16KB), card_signature, status | unique (agent_key, version); immutable after publish (DB trigger blocks UPDATE on content columns) |
| `tenant_agent_configs` | tenant_id, agent_key, enabled, pinned_version?, prompt_params jsonb (≤8KB), auto_execute_policy jsonb (≤4KB), self_approval bool default false | unique (tenant_id, agent_key); RLS |
| `rollouts` | agent_key, cell, mode enum(direct,canary,shadow), candidate_version, baseline_version, pct, tenant_filter jsonb, status enum(active,promoted,rolled_back) | partial idx status='active' |
| `sessions` | session_id uuidv7, user_id?, agent_key, agent_version, context_urn, status enum(active,idle,terminated,expired), last_activity_at, expires_hard_at | idx (tenant_id, user_id, status); idx expires_hard_at |
| `runs` | run_id uuidv7, session_id FK, temporal_workflow_id, status enum(per ART-FR-011), parent_run_id?, obo_sub?, principal_type enum(user_obo,agent_autonomous), usage jsonb {tokens,cost_usd,tool_calls}, error jsonb? | partitioned by month; idx (tenant_id, session_id); retention: rows 13 months |
| `checkpoints` | run_id, checkpoint_id, seq, state_ref (inline jsonb ≤64KB else object-storage pointer) | partitioned by month; retention 30 days (ART-FR-022) |
| `proposals` | proposal_id uuidv7, run_id FK, agent_key, agent_version, tool_id, tool_version, args jsonb (≤64KB, documented), rationale text, affected_urns text[], predicted_effect jsonb (≤4KB), status enum, expires_at, decision jsonb {actor, action, message, edited_args, decided_at} | partitioned by month; idx (tenant_id, status, expires_at); idx GIN affected_urns; retention 7y via audit export, local 25 months |
| `kill_switches` | scope enum(agent,agent_version,agent_version_tenant), agent_key, version?, tenant_id?, active, reason NOT NULL, set_by | pushed to Redis |
| `sandbox_executions` | run_id, code_digest, exit_code, resource_usage jsonb, duration_ms | partitioned by month; retention 13 months |
| `outbox` | standard | |

**State machines.**
- AgentVersion: `draft → published → deprecated → retired`; guard on publish = eval gate + toolset validation + principal created. No transition mutates content.
- Session: `active ↔ idle` (15-min timer) → `terminated` (user/kill) | `expired` (8h). Guards: resume only from active/idle by owning user.
- Run: `queued → running ↔ awaiting_input ↔ awaiting_approval → completed|failed|cancelled|killed|expired`; awaiting_approval entered per pending proposal; kill from any non-terminal state.
- Proposal: `pending → approved|rejected|edited_approved|expired|superseded|cancelled` (all terminal). Guard: decide only from pending; decision idempotent (first wins).

**Index & retention summary.**

| Table | Hot-path indexes | Partitioning / retention |
|---|---|---|
| `sessions` | (tenant_id, user_id, status); expires_hard_at | none / terminated rows 90 days |
| `runs` | (tenant_id, session_id); temporal_workflow_id unique | monthly / 13 months |
| `checkpoints` | (run_id, seq) | monthly / 30 days hard-delete |
| `proposals` | (tenant_id, status, expires_at); GIN(affected_urns) | monthly / 25 months local, 7y via audit WORM |
| `agent_versions` | (agent_key, version) unique | none / permanent (compliance: model cards derive from these rows) |
| `sandbox_executions` | (run_id) | monthly / 13 months |

**Redis keyspace.** `ar:sess:{tenant}:{session_id}` session index + working refs (TTL-managed) · `ar:kill` pub/sub + `ar:kill:set` · `ar:queue:{tenant}` fair-share queue metadata · `ar:pool:{tier}` session-pool gauges.

**Temporal design notes (normative).** One namespace per cell (`windrose-agents-<cell>`); task queues `agents-pool`, `agents-bridge`, `agents-silo-<tenant>`; workflow id = `run:{run_id}` (dedup guarantee); signals: `user_message`, `proposal_decision:{proposal_id}`, `cancel`, `kill`; timers: idle (15m, reset on activity), hard lifetime (8h), proposal expiry (per proposal); activity heartbeats on LLM/tool calls ≥ 10s intervals; workflow history capped by continuing-as-new after 50 turns.

## 5. API specification

Base `/api/v1`. All errors per MASTER-FR-024; long-running per MASTER-FR-027.

| Method & path | Purpose | Auth | Notable errors |
|---|---|---|---|
| `POST /agents/:agent_key/chat/completions` | chat (OpenAI-compatible; stream via realtime-hub topic returned in header `x-windrose-stream-topic`) | user JWT | 402 BUDGET_EXHAUSTED (surfaced), 409 SESSION_EXPIRED, 423 AGENT_KILLED, 429 |
| `POST /sessions` · `GET /sessions/:id` · `POST /sessions/:id/terminate` | session mgmt | user JWT | 404, 409 |
| `GET /runs/:id` · `GET /runs/:id/trace` | run status + trace (tool tree, citations) | user JWT / operator | 404 |
| `POST /runs/:id/cancel` | cancel signal | owning user / tenant admin | 409 (terminal) |
| `GET /proposals?filter[status]=&filter[agent_key]=` | approval inbox | user JWT (scoped to approvable) | — |
| `POST /proposals/:id/decide` | approve/reject/edit/respond | approver (OPA per ART-FR-044) | 403, 404, 409 CONFLICT (decided), 410 (expired), VALIDATION_FAILED (edited args) |
| `POST /registry/agents` · `POST /registry/agents/:key/versions` | define agents/versions | agent engineer (operator scope) | 409 |
| `POST /registry/agents/:key/versions/:v/publish` | publish (eval-gated) | operator | 422 EVAL_GATE_FAILED |
| `POST /registry/rollouts` · `POST /rollouts/:id/promote|rollback` | canary/shadow lifecycle | operator | 409 |
| `PUT /registry/tenants/self/agents/:key` | tenant config (pin, enable, auto-exec policy, prompt params) | tenant admin | 422 (destructive-auto attempt) |
| `POST /registry/kill-switches` · `DELETE /:id` | kill/unkill | operator; tenant admin for own-tenant scope | reason required |
| `GET /a2a/cards/:agent_key` · A2A endpoints (`message/send`, `tasks/get`) | agent cards + delegation | agent JWT (internal) | — |

**Example — chat request (OpenAI-compatible):**
```json
POST /api/v1/agents/analytics/chat/completions
{"messages": [{"role": "user", "content": "why did Q3 revenue dip in EMEA?"}],
 "stream": true,
 "metadata": {"session_id": "s-01H8", "context_urn": "wr:t-42:chart:dashboard/d-33"}}
→ 200, headers: x-windrose-stream-topic: agent_run:r-01H9, x-windrose-ai-generated: true
```
The client subscribes to realtime-hub `GET /stream?topics=agent_run:r-01H9` (with `Last-Event-ID` on reconnect); non-streaming callers receive the full OpenAI-shape response body when the run completes.

**Example — decide with edit-args:**
```json
POST /api/v1/proposals/p-01H8/decide
{"action": "edit_args", "message": "Cap severity at medium pending review",
 "edited_args": {"case_id": "c-91", "assignee_id": "u-dana", "severity": "medium"}}
→ 200 {"data": {"id": "p-01H8", "status": "edited_approved",
   "decision": {"actor": "user:u-super", "action": "edit_args", "decided_at": "…",
                "diff": [{"field": "severity", "from": "high", "to": "medium"}]}}}
```
**Example — SSE stream events (via realtime-hub):** `event: token\ndata: {"delta":"Q3 revenue…"}` · `event: proposal_created\ndata: {"proposal_id":"p-01H8","tool_id":"case.assign"}` · `event: run_completed\ndata: {"usage":{"input_tokens":8123,"output_tokens":642,"cost_usd":0.031},"citations":[{"urn":"wr:t-42:semantic:measure/rev_q"}]}`.

## 6. Events

**Emitted:**
- `ai.agent_run.v1`: `run.started|state_changed|completed|failed|killed` `{run_id, session_id, agent_key, agent_version, principal_type, obo_sub?, status, usage?, error_code?}`.
- `ai.proposal.v1`: `proposal.created|approved|rejected|edited_approved|expired|superseded|cancelled` `{proposal_id, agent_key, agent_version, tool_id, affected_urns, decision{action, actor, message?, diff?}}` — rejection messages + edit diffs consumed by eval-service (flywheel).
- `ai.code_executed.v1` (sandbox audit).
- `agent.events.v1`: `agent_version.published|deprecated|retired`, `rollout.started|promoted|rolled_back`, `agent.killed|unkilled`, `session.created|expired|terminated` (low-volume lifecycle only).

**Consumed:**
- `eval.events.v1: gate.completed` → attach gate result to draft version (enables publish); `canary.scored` → auto-promote/halt rollouts configured with thresholds.
- `identity.events.v1: tenant.provisioned` → seed tenant_agent_configs defaults; `tenant.suspended` → tenant-wide kill; `user.deleted` → terminate user's sessions, redact `obo_sub` display references (memory cascade is BRD 15's).
- `tool.events.v1: tool.killed|retired` → warn/flag affected published agent versions; sessions get tool errors naturally via tool-plane.
- `usage.events.v1 / ai.events.v1: budget.exhausted` → pause run admission for exhausted scope with clear user messaging.

## 7. Business rules & edge cases

- **BR-1** **Destructive-never-auto** is enforced in three places: tenant policy validation (422 on write), proposal creation (policy lookup ignores auto for destructive), and tool-plane (BRD 13 BR-2). Defense in depth; all three tested.
- **BR-2** A run may hold multiple pending proposals; the workflow awaits each independently (Temporal signals keyed by proposal_id); the agent continues other branches unless the graph declares the write blocking.
- **BR-3** Version resolution order at session creation: kill switch (refuse) > tenant pin > active canary assignment (session-hash) > cell default. Recorded on the session; never re-resolved mid-session.
- **BR-4** Shadow runs: write tools stubbed at the runtime (never reach tool-plane execution), memory writes suppressed, metering tagged `shadow=true` (spend counted to a platform eval budget, not the tenant).
- **BR-5** Reflection loop cost control: reflection LLM calls use the `chat` class lowest rung; reflection skipped when no data tool was used (preserved behavior from chat-agent-service `used_data_tool`); total reflection iterations hard-capped at 3 regardless of config.
- **BR-6** OBO token lifetime < session lifetime: the runtime re-exchanges the refresh grant via identity-service on expiry; if the user's permissions changed, subsequent tool calls reflect the new intersection immediately (no caching of grants).
- **BR-7** Temporal worker crash: workflow replays from history; activities are idempotent (LLM calls re-issued — acceptable duplicate spend, capped by budget; tool `read` calls safe; write execution activities carry idempotency keys honored by domain services per MASTER-FR-025).
- **BR-8** Edited args re-validation: edit-args decisions re-run tool-plane schema + OPA (approver as subject) before execution; failure returns VALIDATION_FAILED to the approver and the proposal stays `pending`.
- **BR-9** Proposal expiry during `awaiting_approval` with no other pending work → run completes with outcome `expired_proposal`, user notified; agent's final message explains what was not executed.
- **BR-10** Meta-agent loop protection: delegation depth ≤ 2, fan-out ≤ 5, cycle detection by (agent_key ∈ ancestor chain) — violation fails the delegation, not the parent run.
- **BR-11** Session fixation/hijack: session_id alone never authorizes; every call re-verifies JWT user = session owner; cross-user resume returns 404 (existence non-leak).
- **BR-12** Concurrency on decide: `UPDATE … WHERE status='pending'` row-lock semantics; losers get 409 with the winning decision in details.
- **BR-13** Backpressure: tenant pool saturated → new chat returns 429 + Retry-After with queue-depth-derived hint; existing sessions' turns are prioritized over new sessions (weighted fair queue).
- **BR-14** Autonomous (scheduled) runs never use user identity; if a scheduled agent needs data a user asked to watch, the grant is an explicit agent-principal scope, auditable (§8.9 architecture).
- **BR-15** Checkpoint size: state over 64KB spills to object storage with pointer (MASTER-FR-061); chart-data buffers are never checkpointed — only references + digests (fixes chat-agent-service's raw-DataFrame-in-state pattern).

## 8. Dependencies

- **Calls:** ai-gateway (all LLM, per-run virtual keys), tool-plane MCP (all tools + proposal execution grants), memory-service (session/user/workspace retrieval + governed writes), identity-service (OBO exchange, agent principals), eval-service (gate results, canary scoring), realtime-hub (stream publish), notification-service (via events).
- **Consumed by:** bff-graphql (chat, inbox, traces), ui-web copilot drawer + approval inbox, eval-service (replay API), meta-router↔agents (A2A internal).
- **Infra:** Temporal (dedicated namespace per cell), Postgres, Redis (session index, kill pub/sub, fair-share queues), Kafka, gVisor node pool `agents-sandbox`, OPA sidecar, SPIFFE.
- **Contracts:** stream event schema (this BRD §5) is the UI trace-visualizer contract; `ai.proposal.v1` schema consumed by eval-service and audit-service; A2A v1.0 + LangGraph 1.x + Temporal SDK versions pinned in one constants module.

## 9. NFRs (deltas from master)

| Metric | Target |
|---|---|
| First token (user msg → first streamed token, cache-miss) p95 | ≤ 2.5s (incl. gateway + model) |
| Run durability | zero lost runs across worker/pod restarts (Temporal replay verified in chaos test) |
| Proposal decision → execution start p95 | ≤ 2s |
| Kill-switch propagation | ≤ 5s |
| Session state sanitization after termination | ≤ 60s |
| Sandbox cold start p95 | ≤ 3s (warm pool ≤ 500ms) |
| Concurrent active sessions per cell | 5,000 (pool tier) |
| Agent SLOs (per agent, dashboards + error budgets) | task completion rate, escalation rate, tool-error rate, cost/completed task — targets set per agent at publish |

## 10. Acceptance criteria

- **AC-1** Given a user opens a dashboard copilot session and asks a data question, When the analytics agent runs, Then the answer streams via realtime-hub with `tool_call_*` and `token` events, cites semantic-layer URNs, and the run trace shows query_analyzer → call_tool → reflection with zero direct provider or domain-service calls (verified by netpol test + trace inspection).
- **AC-2** Given a runtime worker pod is killed mid-run (chaos test), When Temporal reschedules, Then the run resumes from the last checkpoint and completes; no duplicate proposal or duplicate write occurs (idempotency keys verified).
- **AC-3** Given a session idle for 15 minutes, Then status becomes `idle` and is resumable; Given 8 hours since creation, Then status `expired`, resume returns 409 SESSION_EXPIRED, and Redis/sandbox state for the session is gone within 60s while Postgres checkpoints remain (until day 30).
- **AC-4** Given the case-triage agent calls `case.assign` (write-proposal), Then a Proposal with args, rationale, affected URNs, and predicted effect is created, the workflow blocks in `awaiting_approval`, and an inbox item appears; When the approver approves 2 days later, Then execution occurs within 2s of the decision, the case-service write is attributed `actor={type:user, id:<obo user>} via_agent={case-triage, vN}` (MASTER-FR-041), and the decision actor + timestamp are recorded on the proposal (both verified in audit events).
- **AC-5** Given a tenant auto-execute policy setting `case-triage × write-proposal × reversible = auto`, When such a proposal is created, Then it executes immediately with `decision.actor = policy:auto` recorded; Given an attempt to set `destructive = auto`, Then the config API returns 422 and no such execution path exists (all three enforcement layers unit/integration tested).
- **AC-6** Given a decision race (two approvers decide concurrently), Then exactly one decision wins, the other receives 409 with the winning decision, and exactly one `ai.proposal.v1` terminal event is emitted.
- **AC-7** Given analytics v15 in canary at 10% with baseline v14, Then ~10% of new unpinned sessions resolve v15 (deterministic hash, verified distribution), pinned tenants get their pin, and `POST /rollouts/:id/rollback` reverts new sessions to v14 in one call while in-flight v15 sessions finish.
- **AC-8** Given publish is attempted for a version whose eval gate result is missing or failed, Then 422 EVAL_GATE_FAILED and status stays `draft`; Given a passing gate result, Then publish succeeds, the version's content columns become immutable (UPDATE blocked by trigger test), and a signed A2A card is served.
- **AC-9** Given a kill switch on (case-triage@v3 × tenant t-42), Then within 5s new sessions for t-42 return 423 AGENT_KILLED, active t-42 sessions terminate with the user-facing message, other tenants are unaffected, and unkill restores service.
- **AC-10** Given LLM-generated pandas code in a model-training run, When executed, Then it runs in a gVisor pod with no egress (network probe fails inside), enforced CPU/memory caps (oversubscription test OOMs the sandbox, not the runtime), and an `ai.code_executed.v1` audit event exists.
- **AC-11** Given the meta-router receives a task needing dataset reads and one dashboard write, Then read delegations run in parallel, the write delegation runs only after reads complete, produces a proposal (never direct write), and the parent trace links all child runs.
- **AC-12** Given an approver lacking permission on an affected URN, When they decide, Then 403 PERMISSION_DENIED and the proposal remains pending; Given the proposing OBO user attempts self-approval with `self_approval=false`, Then 403.
- **AC-13** Given a shadow rollout of v15, Then shadow runs produce no user-visible output, no memory writes, no tool-plane write executions, and metering events carry `shadow=true` billed to the platform eval budget.
- **AC-14** Given tenant A's user attempts `GET /sessions/:id` or `GET /proposals/:id` for tenant B resources, Then 404 + `security.cross_tenant_denied` (isolation suite across all endpoints).
- **AC-15** Given a client disconnects mid-stream and reconnects to the realtime-hub topic with the last event id, Then missed events replay in order and the run was unaffected by the disconnect.

## 11. Out of scope / future

Approval inbox and copilot UI implementation (BRD 21/22); Slack approval channel; declarative end-user agent builder; cross-org A2A federation (flag off); fine-tuning/DPO from edit-diffs (data collected, training deferred); online KServe inference agent actions; voice/multimodal chat; per-session dedicated microVMs beyond gVisor (silo tier follow-up).
