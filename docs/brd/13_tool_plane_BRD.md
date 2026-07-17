# BRD 13 — tool-plane (tool-registry + MCP gateway)

**Service:** tool-plane — two deployables sharing one DB/bounded context: `tool-registry` (catalog + admin) and `mcp-gateway` (per-call enforcement + MCP hosting/federation) · **Language:** Go (gateway hot path) + Go (registry); Python permitted for the embedding worker · **Phase:** 2
**Inherits:** `00_MASTER_BRD.md`. Architecture refs: `WINDROSE_PLATFORM_ARCHITECTURE.md` §8.2, §8.6, §10; `WINDROSE_V3_AGENTIC_ARCHITECTURE.md` §5.3.

---

## 1. Overview

**Purpose.** The tool-plane makes tools **governed catalog objects** and is the *only* path by which agents touch the platform. Every domain service ships an MCP facade (dataset-mcp, query-mcp, semantic-mcp, chart-mcp, case-mcp, experiment-mcp, pipeline-mcp, inference-mcp, identity/platform-mcp); the tool-registry catalogs every tool with JSON Schema I/O, ownership, semantic description, versioning + deprecation windows, permission tier, cost weight, and per-tenant enablement. The mcp-gateway hosts/federates those MCP servers behind one endpoint and runs the per-call enforcement pipeline: OPA policy (agent × OBO-user × tenant × tier × argument constraints) → rate limit → schema validation → invoke → audit (`ai.tool_invoked.v1`). Third-party/BYO tools onboard through the same registry with approval — nothing side-loads.

**Business value.** One choke point turns "agents can do anything a user can" into an auditable, revocable, per-tenant-tunable capability surface; tool health/SLA tracking and kill switches make agent incidents a one-flag fix; semantic discovery keeps agent context windows small (load only relevant tools).

**In scope:** tool registration model + lifecycle; MCP server hosting/federation (pinned spec version, stateless-core-ready); semantic tool discovery API; enforcement pipeline; write-tier proposal handoff (creates proposals via agent-runtime — the gateway never executes write-proposal tools directly); BYO/third-party onboarding with approval; health/SLA tracking; per-tool and per-tool-version kill switches; per-tenant enablement.
**Out of scope:** proposal decision UX and lifecycle (agent-runtime, BRD 14); the domain logic inside each MCP facade (owned by each domain service); OPA policy *content* for domain resources (rbac-service projections); LLM calls (tools never call ai-gateway through this plane).

## 2. Actors & user stories

Personas: **Domain Service Team** (tool owner), **Platform Operator**, **Tenant Admin**, **Agent Runtime** (caller on behalf of agents), **Security Engineer**, **Third-party Integrator**.

- **US-1** As a domain service team, I register `case.assign` v1.2.0 with its JSON Schema I/O, semantic description, tier `write-proposal`, and cost weight 3, so agents can discover and (via proposals) use it under governance.
- **US-2** As the agent-runtime, I call `POST /discovery/search` with "find tools to change who owns an anomaly case" and get `case.assign` ranked first with its schema, so the agent loads only relevant tools into context.
- **US-3** As the agent-runtime, I invoke `dataset.get_profile` over MCP with an OBO token; the gateway authorizes the (agent × user × tenant × tier) tuple, validates arguments, invokes dataset-mcp, and audits the call — all in <50ms overhead.
- **US-4** As a Tenant Admin, I disable the `query.run_sql` tool for my tenant (or cap it to tier `read` agents) so my data is only reachable through semantic-layer tools.
- **US-5** As a Security Engineer, I flip the kill switch on `pipeline.launch_run` v2 platform-wide when it misbehaves, and every in-flight agent receives a structured `TOOL_KILLED` error within seconds.
- **US-6** As a tool owner, I deprecate `chart.create_draft` v1 with a 90-day window; agents calling it get deprecation warnings in tool results, and the registry blocks new agent-version pinning to it.
- **US-7** As a Third-party Integrator, I submit a Jira BYO tool (external HTTPS MCP endpoint + schema + scopes); it enters `pending_approval` and only becomes callable after platform-operator approval and tenant-admin enablement.
- **US-8** As a Platform Operator, I watch per-tool health (error rate, p95 latency vs declared SLA) and get alerts when a tool burns its SLA, so I can drain or kill it before agents degrade.
- **US-9** As an auditor, every tool invocation — allowed or denied — is queryable with agent, OBO user, tenant, arguments digest, decision, and latency.
- **US-10** As the agent-runtime, when an agent calls a `write-proposal` tool, the gateway returns a `PROPOSAL_REQUIRED` structured response containing the validated args and tool metadata so the runtime can create a Proposal instead of executing.
- **US-11** As a Tenant Admin, I set per-tool argument constraints (e.g., `case.assign.args.bulk_limit ≤ 50`) that OPA enforces on every call.
- **US-12** As a Domain Service Team, my MCP facade registers itself at deploy time (manifest-driven) so the catalog never drifts from what is deployed.

## 3. Functional requirements

### Tool registration model
- **TPL-FR-001 (Must)** Tool record: `{tool_id (namespaced name e.g. case.assign), display_name, owner_service, owner_team, semantic_description (≤ 2,000 chars, embedding-indexed), input_schema (JSON Schema 2020-12), output_schema, permission_tier: read|write-proposal|write-direct|admin, cost_weight int 1–10, declared_sla {p95_ms, error_rate_pct}, side_effects: none|reversible|destructive, examples[]}`. Versioned semver; each version immutable once `published`.
- **TPL-FR-002 (Must)** Version lifecycle: `draft → published → deprecated(deprecation_ends_at) → retired`. Deprecation window minimum 30 days (default 90). `retired` versions return `TOOL_RETIRED` on invoke. Only one `published` + any `deprecated` versions callable concurrently.
- **TPL-FR-003 (Must)** Registration paths: (a) **manifest-driven** — domain services POST a signed tool manifest at deploy (SPIFFE mTLS identity must match `owner_service`); (b) **admin UI/API** for BYO tools. Manifest re-registration with identical content is idempotent; schema changes require a version bump (CI-checkable diff endpoint `POST /tools/:id/diff`).
- **TPL-FR-004 (Must)** Per-tenant enablement matrix: `{tenant_id, tool_id, enabled bool, max_tier_override?, argument_constraints jsonb, rate_limit_override?}`. Default: platform-defined per-tool default (`enabled_by_default` flag; `admin`-tier tools default disabled). Destructive tools (`side_effects=destructive`) can never be tier `write-direct` (BR-2).
- **TPL-FR-005 (Must)** `write-direct` tier requires: platform-operator approval flag on the tool AND explicit tenant admin opt-in AND `side_effects != destructive`. The default for all write tools is `write-proposal`.

**Example — tool manifest (registered by case-service at deploy):**
```json
{"tool_id": "case.assign", "version": "1.2.0", "display_name": "Assign case",
 "owner_service": "case-service", "owner_team": "triage-domain",
 "semantic_description": "Assign an anomaly case to a user or group. Use when a case needs an owner or the current owner is wrong. Not for bulk reassignment (use case.bulk_assign).",
 "permission_tier": "write-proposal", "cost_weight": 3, "side_effects": "reversible",
 "declared_sla": {"p95_ms": 250, "error_rate_pct": 0.5},
 "input_schema": {"$schema": "https://json-schema.org/draft/2020-12/schema", "type": "object",
   "additionalProperties": false, "required": ["case_id", "assignee_id"],
   "properties": {
     "case_id": {"type": "string", "x-windrose-urn": "wr:{tenant}:case:case/{value}"},
     "assignee_id": {"type": "string"},
     "note": {"type": "string", "maxLength": 2000}}},
 "output_schema": {"type": "object", "properties": {"case_id": {"type": "string"}, "assignee_id": {"type": "string"}, "assigned_at": {"type": "string", "format": "date-time"}}},
 "examples": [{"input": {"case_id": "c-01H8", "assignee_id": "u-9a"}, "description": "reassign a duplicate-invoice case"}]}
```

### MCP hosting & federation
- **TPL-FR-010 (Must)** mcp-gateway exposes a single MCP endpoint per cell (`/mcp`, Streamable HTTP transport), federating registered backend MCP servers (each domain facade registered with its internal URL + SPIFFE ID). MCP spec version **pinned** (constant in one shared module; currently 2025-06-18, adapter layer isolated for the 2026 stateless core migration). Sessions are optional: the gateway must operate stateless per-request (session id treated as opaque passthrough, no server-side session state required for correctness).
- **TPL-FR-011 (Must)** `tools/list` responses are **caller-scoped**: only tools that pass (tenant enablement × agent toolset × tier × not killed × not retired) appear. List results include deprecation warnings.
- **TPL-FR-012 (Must)** Backend routing: `tool_id` prefix → owning MCP server; gateway ↔ backend over SPIFFE mTLS; per-backend connection pools, timeouts from declared SLA (default timeout = 3 × declared p95, cap 60s).
- **TPL-FR-013 (Must)** BYO/external MCP servers: outbound calls only to registry-allowlisted hosts through the egress proxy; response size cap 1MB; secrets (API keys) held in Vault per-tenant, injected by the gateway, never visible to agents.
- **TPL-FR-014 (Should)** Protocol conformance tests against the pinned MCP spec run in CI for the gateway and for every registered facade (contract test hook).

### Discovery
- **TPL-FR-020 (Must)** `POST /api/v1/discovery/search {query, top_k ≤ 20, tier_filter?, tags?}` → ranked tools with scores. Ranking: embedding similarity over `semantic_description + examples` (embeddings via ai-gateway `embed` class, computed at publish time) blended with usage-frequency prior. Results are caller-scoped exactly like `tools/list` (never reveal disabled/unauthorized tools).
- **TPL-FR-021 (Must)** Re-embedding job on description change and on embedding-model version bump; embedding model version stored per row.
- **TPL-FR-022 (Should)** `GET /api/v1/tools/:id/schema?version=` fast path (Redis-cached) for runtime schema fetch.

### Enforcement pipeline (per invocation, strict order)
- **TPL-FR-030 (Must)** (1) **AuthN:** verify platform JWT (`typ=agent_obo|agent_autonomous`), extract `{agent_id, agent_version, obo_sub?, tenant_id, scopes}`.
- **TPL-FR-031 (Must)** (2) **Kill/enablement gate:** tool version not killed/retired; tenant enablement on; agent's pinned toolset includes tool@version-range.
- **TPL-FR-032 (Must)** (3) **OPA check:** input `{subject: agent principal, obo_sub, tenant, action: tool.invoke, resource: tool URN, tier, args}` → OPA sidecar evaluates: agent toolset scope ∩ OBO user grant on affected resource URNs (args declare URN-bearing fields via schema annotation `x-windrose-urn`) ∩ tenant tier policy ∩ **argument constraints** (tenant matrix + tool-declared bounds). p99 ≤ 10ms (MASTER-FR-012). Deny → 404-shaped MCP error for cross-tenant resources (MASTER-FR-003), `PERMISSION_DENIED` otherwise; both audited.
- **TPL-FR-033 (Must)** (4) **Rate limit:** token buckets at (tenant × tool) and (agent_principal × tool), defaults from cost weight (weight 1 → 120/min, weight 10 → 6/min; overridable per tenant). Exceeded → `RATE_LIMITED` + retry-after.
- **TPL-FR-034 (Must)** (5) **Schema validation:** args validated against `input_schema` (fail → `VALIDATION_FAILED` with per-field details, audited, backend never called). Unknown fields rejected (`additionalProperties: false` enforced at publish).
- **TPL-FR-035 (Must)** (6) **Tier gate:** `read`/`write-direct`(where permitted) → invoke backend. `write-proposal`/`admin` from an agent → **do not invoke**; return structured `PROPOSAL_REQUIRED {tool_id, version, validated_args, affected_urns, side_effects}` for the runtime's proposal flow (BRD 14). A proposal-execution call (runtime presents `proposal_execution` claim referencing an approved proposal id, verified via signed grant from agent-runtime) passes this gate and invokes.
- **TPL-FR-036 (Must)** (7) **Invoke:** call backend with deadline; output validated against `output_schema` (invalid → `TOOL_OUTPUT_INVALID`, counted against tool health).
- **TPL-FR-037 (Must)** (8) **Audit:** every attempt (allow/deny/error) emits `ai.tool_invoked.v1` with args **digest** (SHA-256) + URN list, never raw arg values for PII safety (full args go to the proposal object or backend audit, not this event).
- **TPL-FR-038 (Must)** Pipeline overhead (steps 1–5 + 8) p95 ≤ 25ms, p99 ≤ 50ms excluding backend time.

**OPA input document (normative shape for step 3):**
```json
{"input": {
  "subject": {"type": "agent", "agent_id": "case-triage", "agent_version": 3, "principal": "agent:case-triage@v3"},
  "obo_sub": "user:u-77",
  "tenant": "t-42",
  "action": "tool.invoke",
  "resource_urn": "wr:t-42:tool-plane:tool/case.assign@1.2.0",
  "tier": "write-proposal",
  "affected_urns": ["wr:t-42:case:case/c-01H8"],
  "args": {"case_id": "c-01H8", "assignee_id": "u-9a"},
  "constraints_ref": "tenant:t-42:case.assign",
  "proposal_execution": null}}
```
OPA policy composition: `allow = agent_toolset_scope ∧ (obo_sub == null ∨ obo_grant_on_all(affected_urns)) ∧ tenant_tier_allows ∧ constraints_satisfied(args)`. For proposal executions, `proposal_execution` carries the signed grant `{proposal_id, decided_by, args_digest}` and the args-digest must match.

**Error-code mapping (MCP JSON-RPC → platform codes):**

| Stage | Platform code | HTTP analog | MCP behavior |
|---|---|---|---|
| authN | `KEY_INVALID` / `TOKEN_INVALID` | 401 | JSON-RPC error -32001 |
| kill/enablement | `TOOL_KILLED` / `TOOL_RETIRED` / `TOOL_DISABLED` | 423/410 | tool result `isError=true`, structured code |
| OPA deny | `PERMISSION_DENIED` (404-shaped cross-tenant) | 403/404 | tool result `isError=true` |
| rate limit | `RATE_LIMITED` (+retry_after_s) | 429 | tool result `isError=true` |
| schema | `VALIDATION_FAILED` (per-field details) | 422 | tool result `isError=true` |
| tier gate | `PROPOSAL_REQUIRED` | 200 | tool result `isError=false`, structured |
| backend | `TOOL_BACKEND_TIMEOUT` / `TOOL_BACKEND_ERROR` / `TOOL_OUTPUT_INVALID` | 502/504 | tool result `isError=true` |
| policy infra | `POLICY_UNAVAILABLE` | 503 | JSON-RPC error -32002 |

### Onboarding & approval (BYO / third-party)
- **TPL-FR-040 (Must)** BYO submission: `{manifest, endpoint_url, auth_method: api_key|oauth2 (Vault refs), requested_tier, data_egress_description}` → state `pending_approval`. Platform operator approves/rejects with message; approval requires tier ≤ `write-proposal` for external tools (external `write-direct` forbidden).
- **TPL-FR-041 (Must)** Approved BYO tools still require per-tenant enablement; tenant admins see the egress description before enabling.
- **TPL-FR-042 (Should)** Automated checks at submission: schema lint, endpoint reachability probe, TLS validation, response-shape probe against examples.

### Health, SLA, kill switch
- **TPL-FR-050 (Must)** Per tool-version rolling health: success rate, error taxonomy (backend_error, timeout, output_invalid), p50/p95/p99 latency, calls/min — 1-min resolution in Redis, hourly rollups in Postgres, exported metrics.
- **TPL-FR-051 (Must)** SLA breach detection: declared SLA violated for 10 consecutive minutes → `tool.sla_breached` event + alert; auto-quarantine option (`auto_quarantine: true` → tool moves to `quarantined`, behaves like killed, operator ack required to restore).
- **TPL-FR-052 (Must)** **Kill switch:** per tool, per tool-version, and per (tool × tenant). Set/unset via admin API, effective ≤ 5s across all gateway replicas (Redis pub/sub). Killed invocations return `TOOL_KILLED {reason, killed_by}`. Kill state survives restarts (Postgres-backed).
- **TPL-FR-053 (Must)** Every kill/unkill/quarantine is itself audited with actor + reason (required field).

### Admin & introspection
- **TPL-FR-060 (Must)** Catalog APIs: tool CRUD (per paths in FR-003), version publish/deprecate/retire, enablement matrix CRUD, kill-switch API, health/SLA query, invocation log query (digest-level; full audit in audit-service).
- **TPL-FR-061 (Should)** `GET /api/v1/tools/:id/usage?window=` — per-tenant/per-agent usage aggregates for capacity and pricing analysis.

## 4. Domain model & data

Postgres `tool_plane` DB; standard columns + RLS (platform-scoped catalog rows use the reserved platform tenant; tenant matrix rows carry real tenant_id).

| Table | Key columns | Indexes / notes |
|---|---|---|
| `tools` | tool_id text unique, display_name, owner_service, owner_team, enabled_by_default bool, side_effects enum(none,reversible,destructive), tags text[] | idx tool_id; platform-scoped |
| `tool_versions` | tool_id FK, version semver, status enum(draft,published,deprecated,retired,quarantined), input_schema jsonb (≤64KB, documented — genuinely schemaless), output_schema jsonb, semantic_description text, permission_tier enum, cost_weight smallint, declared_sla jsonb (≤1KB), examples jsonb (≤32KB), embedding vector(1536), embedding_model_ver text, deprecation_ends_at, published_at | unique (tool_id, version); partial idx status='published'; ivfflat embedding |
| `tenant_tool_settings` | tenant_id, tool_id, enabled bool, max_tier_override enum?, argument_constraints jsonb (≤8KB), rate_limit_override jsonb (≤1KB) | unique (tenant_id, tool_id); RLS |
| `mcp_backends` | name, internal_url, spiffe_id, kind enum(internal,external), egress_allowlist text[], vault_auth_ref, status enum(active,disabled) | platform-scoped |
| `byo_submissions` | manifest jsonb, endpoint_url, requested_tier, egress_description text, status enum(pending_approval,approved,rejected), decided_by, decision_message | idx status |
| `kill_switches` | scope enum(tool,tool_version,tool_tenant), tool_id, version?, tenant_id?, active bool, reason text NOT NULL, set_by | unique (scope, tool_id, version, tenant_id); loaded to Redis on change |
| `tool_health_hourly` | tool_id, version, tenant_id?, hour, calls, errors_by_kind jsonb, p50/p95/p99_ms | partitioned by month; retention 13 months |
| `invocation_log` | request digest rows (agent, obo_sub, tool, version, decision, latency_ms, error_code?, args_digest, urns text[], trace_id) | partitioned by month; retention 90 days (long-term in audit-service) |
| `outbox` | standard | |

**State machines.**
- Tool version: `draft → published → deprecated → retired`; `published|deprecated → quarantined → (published|deprecated)` on operator restore. Guards: publish requires valid schemas + embedding computed + owner mTLS identity match; deprecate requires `deprecation_ends_at ≥ now+30d`; retire requires window elapsed OR operator `force` with reason.
- BYO submission: `pending_approval → approved|rejected` (terminal; resubmission = new row).

**Index & retention summary.**

| Table | Hot-path indexes | Partitioning / retention |
|---|---|---|
| `tool_versions` | (tool_id, version) unique; partial status='published'; ivfflat(embedding) | none / retired rows permanent (catalog history) |
| `tenant_tool_settings` | (tenant_id, tool_id) unique | none / soft-delete |
| `kill_switches` | (scope, tool_id, version, tenant_id) unique; partial active=true | none / inactive rows kept 25 months |
| `tool_health_hourly` | (tool_id, version, hour) | monthly / 13 months |
| `invocation_log` | (tenant_id, created_at); (tool_id, decision, created_at) | monthly / 90 days |

**Redis keyspace.** `tp:kill` pub/sub + `tp:kill:set` (active kill tuples) · `tp:sch:{tool_id}:{ver}` schema cache (TTL 10 min, push-invalidated) · `tp:ena:{tenant}:{tool_id}` enablement cache · `tp:rl:{tenant}:{tool_id}` and `tp:rl:agent:{principal}:{tool_id}` token buckets · `tp:health:{tool_id}:{ver}` 1-min rolling counters.

**Per-tenant enablement example:**
```json
PUT /api/v1/tenants/self/tools/case.assign
{"enabled": true, "argument_constraints": {"note": {"maxLength": 500}},
 "rate_limit_override": {"per_min": 30}}
```

## 5. API specification

Base `/api/v1` (REST admin/registry) + `/mcp` (MCP Streamable HTTP data plane).

| Method & path | Purpose | Auth | Notable errors |
|---|---|---|---|
| `POST /api/v1/tools` / `POST /api/v1/tools/:id/versions` | register tool / new version (manifest) | service mTLS or operator | 409 CONFLICT (version exists), VALIDATION_FAILED |
| `POST /api/v1/tools/:id/versions/:v/publish` · `/deprecate` · `/retire` | lifecycle | owner service / operator | 422 (guards) |
| `POST /api/v1/tools/:id/diff` | schema diff vs published (CI) | owner service | — |
| `GET /api/v1/tools?filter[tier]=&filter[owner_service]=` | catalog list (paginated) | any platform principal | — |
| `POST /api/v1/discovery/search` | semantic discovery | agent/service JWT | — |
| `GET /api/v1/tools/:id/schema?version=` | cached schema fetch | agent/service | 404 |
| `PUT /api/v1/tenants/self/tools/:id` | tenant enablement + constraints | tenant admin | 422 (destructive→write-direct) |
| `POST /api/v1/kill-switches` · `DELETE /:id` | kill/unkill | operator (tool/tool_version), tenant admin (tool_tenant) | reason required |
| `POST /api/v1/byo` · `POST /api/v1/byo/:id/approve|reject` | BYO onboarding | integrator / operator | — |
| `GET /api/v1/tools/:id/health` · `/usage` | health/SLA, usage | operator/tenant admin | — |
| `POST /mcp` (initialize, tools/list, tools/call) | MCP data plane | agent JWT (typ=agent_*) | MCP errors mapping: PERMISSION_DENIED, RATE_LIMITED, VALIDATION_FAILED, TOOL_KILLED, TOOL_RETIRED, PROPOSAL_REQUIRED, TOOL_OUTPUT_INVALID |

**Example — semantic discovery request:**
```json
POST /api/v1/discovery/search
{"query": "find tools to change who owns an anomaly case", "top_k": 5, "tier_filter": ["read", "write-proposal"]}
→ 200 {"data": [
  {"tool_id": "case.assign", "version": "1.2.0", "score": 0.91, "tier": "write-proposal",
   "description": "Assign an anomaly case to a user or group…", "deprecation": null},
  {"tool_id": "case.get", "version": "2.0.1", "score": 0.74, "tier": "read",
   "description": "Fetch case detail including current assignee…", "deprecation": null}]}
```

**Example — kill switch:**
```json
POST /api/v1/kill-switches
{"scope": "tool_version", "tool_id": "pipeline.launch_run", "version": "2.0.0",
 "reason": "INC-2231: duplicate Argo submissions under retry"}
→ 201 {"data": {"id": "ks-01J9", "active": true, "set_by": "user:ops-lead"}}
```

**Example — `tools/call` on a write-proposal tool (MCP result, isError=false, structured):**
```json
{"content": [{"type": "text", "text": "PROPOSAL_REQUIRED"}],
 "structuredContent": {"status": "proposal_required", "tool_id": "case.assign", "version": "1.2.0",
   "validated_args": {"case_id": "c-01H…", "assignee_id": "u-9a…"},
   "affected_urns": ["wr:t-42:case:case/c-01H…"], "side_effects": "reversible"}}
```
**Example — discovery response item:** `{"tool_id":"case.assign","version":"1.2.0","score":0.91,"tier":"write-proposal","description":"Assign an anomaly case to a user…","input_schema":{…},"deprecation":null}`.

## 6. Events

**Emitted:**
- `ai.tool_invoked.v1` (dedicated topic) — `{invocation_id, tenant_id, agent_id, agent_version, obo_sub?, tool_id, tool_version, tier, decision: allowed|denied_policy|denied_rate|denied_schema|killed, error_code?, args_digest, affected_urns[], latency_ms, backend_ms?, trace_id}` — one per attempt.
- `tool.events.v1`: `tool.registered`, `tool.version_published`, `tool.deprecated`, `tool.retired`, `tool.quarantined`, `tool.killed`, `tool.unkilled`, `tool.sla_breached`, `tenant_tool.enabled|disabled`, `byo.submitted|approved|rejected`.

**Consumed:**
- `identity.events.v1: tenant.provisioned` → seed default `tenant_tool_settings` from `enabled_by_default`; `tenant.suspended` → treat as tenant-wide kill.
- `agent.events.v1: agent_version.published` (from agent-registry) → validate that the version's pinned toolset references only published/deprecated tool versions; emit `tool.toolset_validation_failed` if not.

## 7. Business rules & edge cases

- **BR-1** Deny-by-default: any pipeline step failure (OPA unreachable, Redis rate-limit store down, schema not loadable) results in denial, never invocation. OPA sidecar unavailability → 503 `POLICY_UNAVAILABLE` and alert.
- **BR-2** `side_effects=destructive` tools can never be `write-direct` and can never be auto-executed by tenant policy — enforced at publish time and re-checked at invoke.
- **BR-3** Args digests: `args_digest = SHA-256(canonical JSON)`; raw args appear only in the backend call and (for write tools) in the proposal object — never in `ai.tool_invoked.v1` (MASTER-FR-042).
- **BR-4** Toolset pinning race: if an agent version pins `case.assign@^1.0` and 1.3.0 publishes mid-session, in-flight sessions keep the version resolved at session start; new sessions resolve the newest in-range published version.
- **BR-5** A deprecated version continues serving until `deprecation_ends_at`; results append a `_meta.deprecation` warning. Retirement with in-range pinned agent versions requires operator `force` and emits per-affected-agent alerts.
- **BR-6** Rate limits apply per (tenant × tool) *and* (agent_principal × tool); the stricter bucket wins; proposal-execution calls bypass the agent bucket (already human-approved) but not the tenant bucket.
- **BR-7** Backend timeout → error counted to health, response `TOOL_BACKEND_TIMEOUT`; the gateway never retries **non-read** tools (side-effect safety); `read`-tier calls retry once.
- **BR-8** External tool secrets: injected server-side from Vault; any tool output containing the injected secret value is redacted before return (string match scrub) and flagged.
- **BR-9** Concurrency: kill-switch check happens both at step 2 and immediately before backend dispatch (a kill landing mid-pipeline still blocks).
- **BR-10** `tools/list` result size cap 100 tools; callers with larger scopes must use discovery search (protects agent context windows).
- **BR-11** Argument constraints language: JSON per-field bounds (`max`, `maxLength`, `enum_subset`, `maxItems`) compiled into OPA data — no free-form Rego from tenants.
- **BR-12** Cross-tenant URN in args (any `x-windrose-urn` field whose tenant segment ≠ caller tenant) → 404-shaped denial + `security.cross_tenant_denied` audit (MASTER-FR-003).
- **BR-13** Registry writes are strongly consistent; gateway caches (schemas, enablement, kill state) are Redis-invalidated with ≤ 5s propagation SLO; correctness-critical state (kill, revocation) uses pub/sub push, enablement may lag up to 5s.
- **BR-14** Manifest identity binding: a manifest's `owner_service` must equal the SPIFFE identity of the registering workload; mismatch → 403 and a security audit event (prevents one service registering tools that impersonate another's domain).
- **BR-15** Semantic description quality gate: publish rejects descriptions < 40 chars or lacking a usage sentence ("Use when …") — discovery quality depends on it; lint messages are actionable.
- **BR-16** Eval mode (`x-windrose-eval: true`, claim-verified as eval-service/runtime replay): `read` tools invoke normally against fixture-backed facades; `write-proposal`/`write-direct`/`admin` calls short-circuit to a stub result `{status:"stubbed"}` before step 6 and are audited with `decision: stubbed` — eval can never mutate tenant data through this plane.
- **BR-17** Gateway statelessness: no per-session server state is required for correctness (MCP session ids passthrough); any replica can serve any call — horizontal scaling and zero-downtime deploys depend on this invariant (tested by mid-session replica kill).

## 8. Dependencies

- **Upstream callers:** agent-runtime (all agent tool calls + proposal executions), eval-service (replaying tool calls in eval sandbox mode — invokes with `x-windrose-eval: true` which routes `read` tools normally and stubs write tiers).
- **Backends:** every domain service MCP facade (contract: MCP pinned spec + registered manifest); external BYO endpoints via egress proxy.
- **Infra:** Postgres, Redis (rate limits, caches, kill pub/sub), Kafka, OPA sidecar (+ rbac `permissions_flat` Redis projection), Vault (BYO creds), ai-gateway (`embed` class for discovery embeddings), SPIFFE/SPIRE mesh.
- **Downstream consumers:** audit-service (`ai.tool_invoked.v1`), agent-registry (toolset validation), usage-service (cost-weight usage aggregates via `tool.events`/usage query).

## 9. NFRs (deltas from master)

| Metric | Target |
|---|---|
| Enforcement overhead (steps 1–5+8) | p95 ≤ 25ms, p99 ≤ 50ms |
| Kill-switch propagation | ≤ 5s to 100% of replicas |
| Discovery search p95 | ≤ 150ms |
| Gateway throughput per cell | 2,000 tool calls/s sustained |
| Availability | 99.95%; policy fail-closed is release-gating |
| Audit completeness | 100% of attempts produce `ai.tool_invoked.v1` (reconciliation job alerts on gaps) |

## 10. Acceptance criteria

- **AC-1** Given a published `read` tool enabled for tenant A and an agent OBO token whose user has the resource grant, When `tools/call` is invoked with valid args, Then the backend receives the call, the result returns, and an `ai.tool_invoked.v1 {decision: allowed}` event with args digest and URNs appears within 5s.
- **AC-2** Given the same call but the OBO user lacks the grant on the referenced URN, When invoked, Then the backend is **not** called, the MCP error maps to PERMISSION_DENIED (404-shaped if cross-tenant), and a `denied_policy` audit event is emitted.
- **AC-3** Given args violating the tenant's argument constraint (`bulk_limit: 100` where constraint max is 50), When invoked, Then OPA denies before schema/backend and the audit event records the constraint id.
- **AC-4** Given an agent calls a `write-proposal` tool, When invoked, Then the gateway returns `PROPOSAL_REQUIRED` structured content with validated args + affected URNs and the backend is not called; Given the runtime re-calls with a valid signed proposal-execution grant for an approved proposal, Then the backend executes.
- **AC-5** Given a platform-wide kill switch set on `pipeline.launch_run@2.0.0`, When any tenant invokes it within 5s, Then `TOOL_KILLED {reason}` returns from every gateway replica (multi-replica test), and unkilling restores calls within 5s.
- **AC-6** Given `POST /discovery/search {"query": "reassign an anomaly case"}` from an agent whose tenant has `case.assign` enabled and `case.bulk_close` disabled, Then `case.assign` appears ranked in results and `case.bulk_close` never appears.
- **AC-7** Given a tool version published with an invalid JSON Schema, When publish is attempted, Then it fails `VALIDATION_FAILED` and status remains `draft`; Given valid schemas, Then publish succeeds and the embedding row is populated before the tool is discoverable.
- **AC-8** Given a deprecated version past `deprecation_ends_at` moved to `retired`, When invoked, Then `TOOL_RETIRED` returns; Given within the window, Then the call succeeds with a `_meta.deprecation` warning in the result.
- **AC-9** Given a BYO Jira tool in `pending_approval`, When an agent attempts to call it, Then it is not listed and not callable; When approved by an operator and enabled by tenant A's admin, Then it is callable by tenant A and still not visible to tenant B.
- **AC-10** Given a backend that exceeds 3× its declared p95, When invoked, Then the gateway times out, records a `timeout` health error, and does not retry (write tool) / retries once (read tool); Given 10 minutes of continuous SLA breach with `auto_quarantine: true`, Then the version moves to `quarantined`, a `tool.sla_breached` event fires, and calls return `TOOL_KILLED`.
- **AC-11** Given the rate limit for (tenant × tool) is exhausted, When called, Then `RATE_LIMITED` with retry-after returns, the backend is not called, and a `denied_rate` audit event is emitted.
- **AC-12** Given the OPA sidecar is stopped in integration tests, When any tool is invoked, Then the gateway returns 503 `POLICY_UNAVAILABLE` (deny, fail-closed) and an alert metric increments.
- **AC-13** Given tenant A's agent submits args containing a URN of tenant B, When invoked, Then the response is 404-shaped, `security.cross_tenant_denied` is emitted, and the backend is not called (isolation suite, every registered tool).
- **AC-14** Given a `tools/list` request from an agent with a 12-tool pinned toolset in tenant A, Then exactly the intersection (pinned ∩ enabled ∩ published/deprecated ∩ not killed) is returned.
- **AC-15** Given a manifest registration where the SPIFFE identity does not match `owner_service`, When submitted, Then 403 with a security audit event, and the catalog is unchanged (BR-14).
- **AC-16** Given a gateway replica is terminated mid-`tools/call` sequence from one client session, When the client retries against surviving replicas, Then calls succeed with no session-affinity requirement (BR-17 statelessness chaos test).
- **AC-17** Given an eval-mode invocation (`x-windrose-eval: true`, claim-verified) of a `write-proposal` tool, Then the result is `{status:"stubbed"}`, the backend receives nothing, and the audit event records `decision: stubbed`.

## 11. Out of scope / future

Proposal decision lifecycle (BRD 14); MCP resources/prompts primitives beyond tools (later); cross-org A2A tool federation; tool marketplace/monetization; automatic tool generation from OpenAPI specs (Could-level backlog); per-tool response caching; MCP stateless-core migration execution (designed-for now, executed when spec finalizes).
