# Service → BFF → UI gap analysis

**Scope:** every HTTP route registered by the 21 domain services, classified by how — or whether —
it reaches the user. **Generated:** 2026-08-02 (rev 2, post-closures) against `claude/datacern-ai-capabilities-p7q6a7`.

Companion to [`PLATFORM_ARCHITECTURE.md`](PLATFORM_ARCHITECTURE.md) §3. This is a *coverage* audit, not a
defect list: an endpoint in the GAP column is built and tested downstream — it simply has no path to a user.

---

## 1. Summary

**663 routes.** 464 reach the browser through the GraphQL BFF, 18 through a
same-origin Next.js route handler, 65 are service-to-service or machine surfaces that
*should* not be fronted — and **116 have no path to a user at all.**

Of the 598 user-facing routes, **81% are reachable.**

The gap is not spread evenly. It clusters almost entirely in **write, lifecycle and admin control planes**;
read paths are well covered. Three services carry over half of it: agent-runtime, identity-service and
memory-service. The recurring shape is: **the read is exposed, the control is not.**

| Service | BFF | UI-direct | Internal | **Gap** | User-facing coverage |
|---|---:|---:|---:|---:|---:|
| `identity-service` | 28 | 8 | 20 | **26** | 58% |
| `agent-runtime` | 32 | 1 | 6 | **23** | 59% |
| `memory-service` | 5 | 0 | 1 | **13** | 28% |
| `chart-service` | 17 | 0 | 1 | **7** | 71% |
| `usage-service` | 20 | 0 | 0 | **6** | 77% |
| `experiment-service` | 30 | 0 | 3 | **5** | 86% |
| `query-service` | 13 | 0 | 1 | **5** | 72% |
| `ai-gateway` | 20 | 0 | 2 | **4** | 83% |
| `audit-service` | 11 | 0 | 1 | **4** | 73% |
| `notification-service` | 31 | 0 | 1 | **4** | 89% |
| `pipeline-orchestrator` | 25 | 0 | 2 | **4** | 86% |
| `ingestion-service` | 39 | 1 | 2 | **3** | 93% |
| `semantic-service` | 26 | 0 | 4 | **3** | 90% |
| `case-service` | 37 | 3 | 2 | **2** | 95% |
| `dataset-service` | 22 | 0 | 8 | **2** | 92% |
| `rbac-service` | 31 | 0 | 6 | **2** | 94% |
| `tool-plane` | 16 | 0 | 0 | **2** | 89% |
| `pack-service` | 10 | 0 | 0 | **1** | 91% |
| `eval-service` | 33 | 0 | 1 | **0** | 100% |
| `inference-service` | 18 | 0 | 1 | **0** | 100% |
| `realtime-hub` | 0 | 5 | 3 | **0** | 100% |
| **total** | **464** | **18** | **65** | **116** | **81%** |

---

## 2. Method

| Layer | Source of truth |
|---|---|
| Service routes | chi-nesting-aware parse of `r.Route`/`r.Get(...)` in Go; FastAPI decorators plus `APIRouter(prefix=)` and `include_router(prefix=)` in Python |
| BFF reach | `this.http.<verb>(path)` in `services/bff-graphql/src/clients/*.ts`, with runtime ternaries and union-typed path segments expanded |
| UI-direct reach | `fetch()` targets in `services/ui-web/src/app/api/**/route.ts` |
| Schema | root fields of `type Query` / `type Mutation` in `services/bff-graphql/schema.graphql` |
| UI usage | root selections across the 431 documents in `services/ui-web/src/lib/graphql/operations.ts` |

**Caveats.** Path matching is static, so a client that composes a path in a way the extractor cannot see
would show as a false gap. Two such patterns were found and handled (inline ternaries such as
`` `/notifications/${id}/${read ? "read" : "unread"}` ``, and union-typed segments such as
`` `/byo/${id}/${decision}` ``). Every entry in §4 was then re-verified by keyword search across all BFF
clients — absence of the distinctive path segment anywhere in `src/clients/` is direct evidence the route
is never called. Wildcard artifact routes (`/exports/*`) are matched by prefix.

---

## 3. What is deliberately *not* a gap

**65 internal / machine surfaces.** MCP tool facades, `/internal/*` and `/external/*`,
A2A cards, JWKS, token exchanges, `/v1/chat/completions`, webhook receivers, `POST /ci/evaluate`
(the machine CI gate), `POST /authz/check` (the OPA sidecar path), projection rebuild/verify, and the
service-to-service reads whose caller is named in the source — `GET /rows` (case-service),
`GET /datasets/resolve` (query-service), `GET /artifacts` (chart-service), `POST /replay` (eval-service),
and semantic-service's `/api/v1/tools/*` MCP facade.

**18 routes reached by a Next.js route handler rather than the BFF.** This is an intentional
second path for multipart, binary and streaming traffic that GraphQL cannot carry, implemented as
zero-business-logic proxies that attach the httpOnly session bearer a browser `fetch` cannot:

- **agent-runtime** — `POST /api/v1/agents/{}/chat/completions`
- **case-service** — `GET /api/v1/cases/{}/evidence/{}/download`, `GET /api/v1/operations/{}/download`, `POST /api/v1/cases/{}/evidence`
- **identity-service** — `GET /api/v1/tenants/self/branding/logo`, `GET /api/v1/tenants/self/walkthrough`, `POST /api/v1/public/demo-signup`, `POST /api/v1/public/demo-signup/claim`, `POST /api/v1/tenants/self/branding/logo`, `POST /api/v1/token/embed`, `POST /api/v1/token/embed/oidc`, `POST /api/v1/token/oidc`
- **ingestion-service** — `PUT /api/v1/uploads/{}/parts/{}`
- **realtime-hub** — `GET /api/v1/stream`, `GET /api/v1/ws`, `POST /api/v1/stream-tickets`, `POST /api/v1/stream/{}/token`, `POST /api/v1/stream/{}/topics`

**realtime-hub is fronted by nothing, by design.** The UI opens SSE directly; only the single-use ticket
mint goes through a Next route (`src/app/api/rt/ticket/route.ts`).

---

## 4. The gap: 116 endpoints with no path to a user

Ordered by product impact. Each row is an endpoint that exists, is authorized, and is tested downstream.

### Learning loop / SLM distillation control plane — 11 endpoints

*BRD 14 §6.5, PLATFORM_ARCHITECTURE §5 M2–M4*

The decision→correction→retrain→cheaper-rung loop is the platform's stated differentiator. The schema surfaces it as counters only; nothing can be driven from the product.

| Endpoint | Service | What it does |
|---|---|---|
| `GET /api/v1/sft-datasets/{}` | agent-runtime | Dataset detail (checksum, archetype, example count). The *list* IS exposed. |
| `GET /api/v1/sft-datasets/{}/examples` | agent-runtime | The gold input→corrected-output pairs. Nothing can inspect training data. |
| `GET /api/v1/slm-adapters` | agent-runtime | Candidate + promoted adapters per archetype. |
| `GET /api/v1/slm-adapters/{}` | agent-runtime | Adapter detail and eval-gate evidence. |
| `GET /api/v1/training-jobs` | agent-runtime | List distillation jobs and their lifecycle state. |
| `GET /api/v1/training-jobs/{}` | agent-runtime | Job detail — status, failure reason (incl. `GpuTrainerNotConfigured`). |
| `GET /api/v1/transcripts/{}` | agent-runtime | A captured agent-run transcript (M1) — the raw learning signal. |
| `POST /api/v1/sft-datasets` | agent-runtime | Curate a versioned SFT dataset from consented transcripts. |
| `POST /api/v1/slm-adapters/{}/demote` | agent-runtime | Rollback — demote a rung. No UI path to undo a bad promotion. |
| `POST /api/v1/slm-adapters/{}/promote` | agent-runtime | Eval-gated promotion to the tenant's cheapest ladder rung. |
| `POST /api/v1/training-jobs` | agent-runtime | Submit a LoRA distillation job against a versioned SFT dataset. |

### Agent registry lifecycle (publish / rollout / retrain watch) — 8 endpoints

*BRD 14, BRD 68*

The Control Tower can kill an agent but cannot publish, canary, promote or roll one back.

| Endpoint | Service | What it does |
|---|---|---|
| `DELETE /api/v1/registry/retrain-watches/{}` | agent-runtime | Remove a retrain watch. |
| `GET /api/v1/registry/retrain-watches` | agent-runtime | Drift/correction thresholds that trigger retrain proposals. |
| `POST /api/v1/registry/agents` | agent-runtime | Register a new agent definition. |
| `POST /api/v1/registry/agents/{}/versions` | agent-runtime | Publish an immutable agent version. The version *list* IS exposed. |
| `POST /api/v1/registry/retrain-watches` | agent-runtime | Create a retrain watch. |
| `POST /api/v1/registry/rollouts` | agent-runtime | Start a canary/shadow/pinned rollout. |
| `POST /api/v1/registry/rollouts/{}/promote` | agent-runtime | Promote a canary to stable. |
| `POST /api/v1/registry/rollouts/{}/rollback` | agent-runtime | Roll a rollout back. |

### Decision-table evaluation — 1 endpoint

*BRD 54*

Decision tables can be authored and listed from the UI but never dry-run against a case, so the fired-rule explainability the BRD sells cannot be demonstrated.

| Endpoint | Service | What it does |
|---|---|---|
| `POST /api/v1/decision-models/{}/evaluate` | agent-runtime | Evaluate a decision table against a case; `dry_run=true` returns outcome + fired rule. |

### Agent session lifecycle — 3 endpoints

*BRD 14*

Sessions are created implicitly by the chat path; explicit create/read/terminate is API-only.

| Endpoint | Service | What it does |
|---|---|---|
| `GET /api/v1/sessions/{}` | agent-runtime | Session detail. |
| `POST /api/v1/sessions` | agent-runtime | Open an agent session explicitly. |
| `POST /api/v1/sessions/{}/terminate` | agent-runtime | Terminate a session — no UI way to cut off a running agent conversation. |

### Memory & RAG corpus administration — 13 endpoints

*BRD 15*

`/admin/memory` reads memories, erasure requests and stats. Corpus management, the tenant memory policy and every memory write are absent — the governance half of BRD 15.

| Endpoint | Service | What it does |
|---|---|---|
| `DELETE /api/v1/memories/{}` | memory-service | Delete a memory. `/admin/memory` can list but not remove one. |
| `GET /api/v1/corpora/{}/status` | memory-service | Chunk/embed pipeline status. |
| `GET /api/v1/policies/self` | memory-service | The tenant's memory PII/retention policy. |
| `PATCH /api/v1/corpora/{}` | memory-service | Edit corpus config. |
| `PATCH /api/v1/memories/{}` | memory-service | Edit a memory. |
| `POST /api/v1/corpora` | memory-service | Create a RAG corpus. |
| `POST /api/v1/corpora/docs/documents` | memory-service | Ingest a document into the docs corpus. |
| `POST /api/v1/corpora/{}/rebuild` | memory-service | Re-chunk and re-embed a corpus. |
| `POST /api/v1/memories` | memory-service | Write a scoped memory. |
| `POST /api/v1/memories/batch` | memory-service | Bulk memory write. |
| `POST /api/v1/memories/{}/unquarantine` | memory-service | Release a memory quarantined by injection screening — a governance action with no button. |
| `POST /api/v1/retrieve` | memory-service | Scope-filtered ANN retrieval — no way to test what an agent would actually recall. |
| `PUT /api/v1/policies/self` | memory-service | Set that policy. A stated governance control with no surface. |

### Commercial plane / POC / demo sandbox — 14 endpoints

*BRD 66, 69, 70*

Plans and entitlements are readable (`tenantCommercial`), but trials, POC criteria/progress/reports and demo-tenant provisioning are operator-API only. BRD 70 US-5's live POC dashboard does not exist.

| Endpoint | Service | What it does |
|---|---|---|
| `GET /api/v1/poc-report-artifacts/*` | identity-service | Download a generated report artifact (needs a link/proxy, not a resolver). |
| `GET /api/v1/tenants/{}/poc-reports` | identity-service | List POC reports. |
| `GET /api/v1/tenants/{}/poc/criteria` | identity-service | Read those criteria. |
| `GET /api/v1/tenants/{}/poc/progress` | identity-service | Live POC progress — the sponsor dashboard of BRD 70 US-5. |
| `PATCH /api/v1/tenants/{}/poc/criteria/{}/manual-value` | identity-service | Record a manually-measured criterion. |
| `POST /api/v1/demo-tenants` | identity-service | Provision a demo sandbox (DSP-FR-010). |
| `POST /api/v1/demo-tenants/{}/clone` | identity-service | Clone a sibling sandbox with fresh persona credentials. |
| `POST /api/v1/demo-tenants/{}/reset` | identity-service | Reset to the post-seed snapshot (DSP-FR-012). |
| `POST /api/v1/poc-tenants` | identity-service | Create a POC tenant. |
| `POST /api/v1/tenants/{}/convert` | identity-service | Convert trial → paid. |
| `POST /api/v1/tenants/{}/poc-reports` | identity-service | Generate a POC report. |
| `POST /api/v1/tenants/{}/trial` | identity-service | Start a trial (CPL-FR-020). |
| `POST /api/v1/tenants/{}/trial/extend` | identity-service | Extend a trial. |
| `PUT /api/v1/poc-tenants/{}/criteria` | identity-service | Set agreed POC success criteria. |

### Tenant lifecycle — 9 endpoints

*BRD 01, BRD 66*

`/admin/tenants` runs one read query and the schema declares no tenant lifecycle mutation at all. Provisioning, suspend/reactivate and conversion are CLI-only.

| Endpoint | Service | What it does |
|---|---|---|
| `DELETE /api/v1/tenants/{}` | identity-service | Delete a tenant. |
| `GET /api/v1/tenants/{}/provisioning` | identity-service | Provisioning saga state — no way to see why onboarding stalled. |
| `PATCH /api/v1/tenants/{}` | identity-service | Edit tenant attributes. |
| `POST /api/v1/tenants` | identity-service | Provision a tenant. |
| `POST /api/v1/tenants/{}/provisioning/retry` | identity-service | Retry a failed provisioning step. |
| `POST /api/v1/tenants/{}/publish` | identity-service | Publish a provisioned tenant. |
| `POST /api/v1/tenants/{}/reactivate` | identity-service | Reactivate a suspended tenant. |
| `POST /api/v1/tenants/{}/suspend` | identity-service | Suspend (the `suspended_commercial` state of CPL-FR-030). |
| `POST /api/v1/users/{}/activate` | identity-service | Activate a user. Invite/deactivate ARE exposed — this one is not. |

### External agent governance — 3 endpoints

*BRD 60 — marked `COMPLETE`*

BRD 68 ACT-FR-003 requires external agents in the Control Tower badged with allow-list scope and an auto-execute-denied posture. They can only be registered by API.

| Endpoint | Service | What it does |
|---|---|---|
| `DELETE /api/v1/tenants/self/external-agents/{}` | identity-service | Revoke one. |
| `GET /api/v1/tenants/self/external-agents` | identity-service | List registered external agents. |
| `POST /api/v1/tenants/self/external-agents` | identity-service | Register one, with its enforced tool allow-list. |

### Value metering: chargeback, adjustments, reconciliation — 6 endpoints

*BRD 67*

Showback reads are covered. Chargeback reporting, billing adjustments and provider-bill reconciliation are not.

| Endpoint | Service | What it does |
|---|---|---|
| `GET /api/v1/meters` | usage-service | The meter catalog (units, aggregations) behind every usage number. |
| `GET /api/v1/reconciliations` | usage-service | Metered-vs-provider-bill reconciliation runs. |
| `GET /api/v1/reports/chargeback` | usage-service | Chargeback report — showback IS exposed, chargeback is not. |
| `GET /api/v1/value-report-artifacts/*` | usage-service | Download a generated value/ROI report (ROI-FR-021). |
| `POST /api/v1/adjustments` | usage-service | Post a billing adjustment/credit. |
| `POST /api/v1/reconciliations/{}/acknowledge` | usage-service | Acknowledge a reconciliation discrepancy. |

### Audit depth: agent attribution and raw export — 4 endpoints

*BRD 18, BRD 68*

Audit reaches the UI through search, chain verify and two compliance-pack jobs. The dual-attribution agent-activity view — an audit-service headline capability — has no surface.

| Endpoint | Service | What it does |
|---|---|---|
| `GET /api/v1/audit/agent-activity` | audit-service | Dual-attribution agent activity — which agent acted on whose behalf. |
| `GET /api/v1/audit/events/{}` | audit-service | Single audit event by id (deep-link from an alert or export). |
| `GET /api/v1/audit/export` | audit-service | Raw audit export. The UI exports only via the two compliance-pack jobs. |
| `GET /api/v1/exports` | audit-service | List previously generated exports. |

### Query governance and cost preview — 5 endpoints

*BRD 05*

Per-tenant concurrency limits and the dry-run cost ceiling exist downstream and are invisible.

| Endpoint | Service | What it does |
|---|---|---|
| `GET /api/v1/downloads/{}` | query-service | Fetch an exported result by token. |
| `GET /api/v1/limits` | query-service | Per-tenant query concurrency + cost ceilings. |
| `POST /api/v1/executions/{}/export` | query-service | Export a result set. |
| `POST /api/v1/sql/dry-run` | query-service | Cost/row estimate before running — the guard against a runaway query. |
| `PUT /api/v1/limits` | query-service | Set them. Governance config with no admin surface. |

### Chart drilldown, export and dashboard portability — 7 endpoints

*BRD 07*

Charts render, but drilldown, image/CSV export and dashboard import/export bundles do not.

| Endpoint | Service | What it does |
|---|---|---|
| `DELETE /api/v1/charts/{}/link` | chart-service | Unlink it. |
| `GET /api/v1/exports/*` | chart-service | Download the exported artifact. |
| `POST /api/v1/charts/{}/drilldown` | chart-service | Drill from an aggregate into its rows. |
| `POST /api/v1/charts/{}/export` | chart-service | CSV/PNG export of a chart. |
| `POST /api/v1/dashboards/import` | chart-service | Import a dashboard bundle. |
| `POST /api/v1/dashboards/{}/export-bundle` | chart-service | Export one — dashboards cannot be moved between workspaces/tenants from the UI. |
| `PUT /api/v1/charts/{}/link` | chart-service | Link a chart to a case/query for cross-navigation. |

### Verified-query approval funnel — 2 endpoints

*BRD 06*

Verified queries can be listed and decided, but candidates cannot be generated or searched, so the funnel has no intake in the UI.

| Endpoint | Service | What it does |
|---|---|---|
| `GET /api/v1/verified-queries/search` | semantic-service | Semantic search across verified queries. |
| `POST /api/v1/verified-queries/candidates` | semantic-service | Generate verified-query candidates — the intake of the approval funnel. |

### ai-gateway spend freeze — 4 endpoints

*BRD 12*

Budgets and ladders are visible; the emergency spend-freeze brake is not.

| Endpoint | Service | What it does |
|---|---|---|
| `DELETE /api/v1/admin/cache` | ai-gateway | Invalidate the tenant-scoped semantic cache. |
| `DELETE /api/v1/admin/spend-freezes` | ai-gateway | Lift a freeze. |
| `GET /api/v1/admin/spend-freezes` | ai-gateway | Active spend freezes. |
| `POST /api/v1/admin/spend-freezes` | ai-gateway | Freeze LLM spend for a tenant — the emergency brake. |

### Experiment run annotation and cleanup — 4 endpoints

*BRD 10*

Run notes, edits and deletes are API-only.

| Endpoint | Service | What it does |
|---|---|---|
| `DELETE /api/v1/runs/{}` | experiment-service | Delete a run. |
| `PATCH /api/v1/runs/{}` | experiment-service | Edit run metadata. |
| `PATCH /api/v1/runs/{}/note` | experiment-service | Edit the note. |
| `POST /api/v1/runs/{}/note` | experiment-service | Annotate a run. |

### Catalog by-id reads — 15 endpoints

*BRD 09, 03, 19, 02*

List endpoints are wired; the single-item detail read is not. Low impact — the UI mostly renders from the list payload — but it caps drill-in pages.

| Endpoint | Service | What it does |
|---|---|---|
| `GET /api/v1/case-schemas/{}` | case-service | One case schema. List/create/update/delete ARE exposed. |
| `GET /api/v1/ontology/entities/{}` | dataset-service | One ontology entity. List/create/delete ARE exposed. |
| `GET /api/v1/archetypes/{}` | experiment-service | Archetype detail. `/ml/archetypes` list + create + delete ARE exposed. |
| `DELETE /api/v1/uploads/{}` | ingestion-service | Abort a resumable upload. |
| `GET /api/v1/connector-types/{}` | ingestion-service | One connector type's config schema. |
| `GET /api/v1/ingestions/{}/progress` | ingestion-service | Live ingestion progress (the UI patches status over SSE instead). |
| `GET /api/v1/notifications/{}` | notification-service | One notification. |
| `GET /api/v1/rules/{}` | notification-service | One subscription rule. |
| `GET /api/v1/webhooks/{}` | notification-service | One webhook endpoint. |
| `GET /api/v1/algorithm-templates/{}` | pipeline-orchestrator | One algorithm template's schema. |
| `GET /api/v1/components/{}` | pipeline-orchestrator | One pipeline operator's spec. |
| `GET /api/v1/pipeline-schedules/{}` | pipeline-orchestrator | One schedule's detail. |
| `POST /api/v1/algorithm-templates/{}/pipelines` | pipeline-orchestrator | Materialize a pipeline from a template — the model-training agent's own tool, unavailable to a human. |
| `GET /api/v1/actions` | rbac-service | The platform action catalog — the vocabulary behind every role editor. |
| `GET /api/v1/roles/{}` | rbac-service | One role. The role list IS exposed. |

### Other — 7 endpoints

Individually small; listed for completeness.

| Endpoint | Service | What it does |
|---|---|---|
| `POST /api/v1/cases/{}/apply-proposal` | case-service | Reachable from nothing — not the BFF, not a Next route, and no service calls it (agents apply through the MCP facade in `handlers_facade.go`). Looks superseded. |
| `POST /api/v1/lineage/edges` | dataset-service | Assert a lineage edge manually; the lineage graph is read-only in the UI. |
| `POST /api/v1/providers/{}/status` | notification-service | Email-provider health probe (operator diagnostic). |
| `GET /api/v1/packs/{}/lint` | pack-service | Pack coherence lint — CI runs it; an operator cannot. |
| `POST /api/v1/compile/chart` | semantic-service | Chart-shaped compile. **No caller anywhere** — chart-service uses `/api/v1/compile`. Likely dead or reserved. |
| `POST /api/v1/discovery/search` | tool-plane | Semantic tool discovery (Ollama embeddings + pgvector) — a built differentiator with no search box. |
| `POST /api/v1/tools/{}/diff` | tool-plane | Diff two tool versions before enabling an upgrade. |

---

## 5. Layer B — schema fields with no UI consumer

The BFF exposes **187 queries** and **264 mutations**. Sixteen root fields are never selected by the
UI operation set:

**Queries (14)** — `workspace`, `group`, `chart`, `verifiedQuery`, `pipelineRun`, `evalDataset`, `evalCase`,
`evalGatesByDigest`, `caseStream`, `ingestionSchedule`, `inferenceSchedule`, `reportSubscription`, `budget`,
`aiBudget`

**Mutations (2)** — `bindCaseStreamTrigger`, `bulkCreateInferenceJobs`

Every one of the 14 queries is a singular by-id fetch whose *list* sibling is used — the UI renders from the
list payload and never drills in. That is dead schema to prune, not a capability gap. The two mutations are
different: both are real capabilities with no button.

---

## 6. Layer C — reverse gaps: CLOSED

The first revision of this audit found two reverse gaps — places where the BFF wanted data no downstream
route provided, both documented honestly in the schema rather than papered over. Both are now closed:

1. **Live rollout state** — agent-runtime gained `GET /registry/rollouts`; the fleet resolver derives
   `PINNED`/`CANARY`/`SHADOW`/`STABLE` from the pin plus the active rollout record. `UNKNOWN` remains only
   as an honest degradation when the rollouts read itself fails.
2. **List comments** — case-service gained `GET /cases/{id}/comments`, and `PATCH /comments/{cid}` now
   echoes the full comment. `Query.caseComments` feeds the case detail page; the session-local body cache
   and its placeholder are gone.

---

## 7. Suggested sequence

| # | Work | Status / why |
|---|---|---|
| 1 | `GET /registry/rollouts` | **DONE** — Control Tower derives real rollout state. |
| 2 | `GET /cases/{id}/comments` | **DONE** — comments listable; PATCH echoes the full comment. |
| 3 | Decision outcome monitoring → BFF + UI | **DONE** — effectiveness panel on Decision Tables; outcome recording on decided proposals. |
| 4 | Memory corpora + policy admin | The erasure/PII/retention governance story is only half-clickable. |
| 5 | Agent registry lifecycle | The Control Tower can kill but not publish, canary or roll back. |
| 6 | Learning-loop cockpit | The largest gap and the closest to the product thesis. Worth sequencing after the GPU leg lands — promote/demote without a trainer is a half-page. |
| 7 | Prune the 14 orphan queries; build the 2 orphan mutations | Small, and keeps the schema honest. |

---

*Regenerate by re-running the extraction described in §2 against the current tree; the counts in §1 are the
audit's own baseline and should be updated in the same commit as any change that moves them.*
