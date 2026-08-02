# Service → BFF → UI gap analysis

**Scope:** every HTTP route registered by the 21 domain services, classified by how — or whether —
it reaches the user. **Generated:** 2026-08-02 (rev 3) against `claude/datacern-ai-capabilities-p7q6a7`.

Companion to [`PLATFORM_ARCHITECTURE.md`](PLATFORM_ARCHITECTURE.md) §3. This is a *coverage* audit, not a
defect list: an endpoint in the GAP column is built and tested downstream — it simply has no path to a user.

---

## 1. Summary

**663 routes.** 499 reach the browser through the GraphQL BFF, 19 through a
same-origin Next.js route handler, 68 are service-to-service or machine surfaces that
*should* not be fronted — and **77 have no path to a user at all.**

Of the 595 user-facing routes, **87% are reachable.**

The gap is not spread evenly. It clusters almost entirely in **write, lifecycle and admin control planes**;
read paths are well covered. Three services carry over half of it: agent-runtime, identity-service and
memory-service. The recurring shape is: **the read is exposed, the control is not.**

| Service | BFF | UI-direct | Internal | **Gap** | User-facing coverage |
|---|---:|---:|---:|---:|---:|
| `identity-service` | 31 | 8 | 20 | **23** | 63% |
| `agent-runtime` | 34 | 1 | 8 | **19** | 65% |
| `chart-service` | 17 | 0 | 1 | **7** | 71% |
| `query-service` | 13 | 0 | 1 | **5** | 72% |
| `notification-service` | 31 | 0 | 1 | **4** | 89% |
| `pipeline-orchestrator` | 25 | 0 | 2 | **4** | 86% |
| `ingestion-service` | 39 | 1 | 2 | **3** | 93% |
| `case-service` | 37 | 3 | 2 | **2** | 95% |
| `dataset-service` | 22 | 0 | 8 | **2** | 92% |
| `rbac-service` | 31 | 0 | 6 | **2** | 94% |
| `tool-plane` | 16 | 0 | 0 | **2** | 89% |
| `experiment-service` | 34 | 0 | 3 | **1** | 97% |
| `pack-service` | 10 | 0 | 0 | **1** | 91% |
| `semantic-service` | 27 | 0 | 5 | **1** | 96% |
| `usage-service` | 25 | 0 | 0 | **1** | 96% |
| `ai-gateway` | 24 | 0 | 2 | **0** | 100% |
| `audit-service` | 14 | 1 | 1 | **0** | 100% |
| `eval-service` | 33 | 0 | 1 | **0** | 100% |
| `inference-service` | 18 | 0 | 1 | **0** | 100% |
| `memory-service` | 18 | 0 | 1 | **0** | 100% |
| `realtime-hub` | 0 | 5 | 3 | **0** | 100% |
| **total** | **499** | **19** | **68** | **77** | **87%** |

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

**68 internal / machine surfaces.** MCP tool facades, `/internal/*` and `/external/*`,
A2A cards, JWKS, token exchanges, `/v1/chat/completions`, webhook receivers, `POST /ci/evaluate`
(the machine CI gate), `POST /authz/check` (the OPA sidecar path), projection rebuild/verify, and the
service-to-service reads whose caller is named in the source — `GET /rows` (case-service),
`GET /datasets/resolve` (query-service), `GET /artifacts` (chart-service), `POST /replay` (eval-service),
and semantic-service's `/api/v1/tools/*` MCP facade. Rev 3 adds: `POST /verified-queries/candidates`
(the SEM-FR-042 machine harvest path — requires agent_run_urn provenance), and explicit agent-session
create/read (`POST/GET /sessions*`) — sessions are created implicitly by the copilot chat path and the
explicit surface is the external SDK's; terminate IS user-facing and wired. Three earlier gap rows were
alias false-positives (the BFF calls a sibling registration of the same handler): 
`GET /verified-queries/search` (BFF uses `:search`) and `POST`/`PATCH /runs/{}/note` (BFF uses `PUT`).

**19 routes reached by a Next.js route handler rather than the BFF.** This is an intentional
second path for multipart, binary and streaming traffic that GraphQL cannot carry, implemented as
zero-business-logic proxies that attach the httpOnly session bearer a browser `fetch` cannot:

- **agent-runtime** — `POST /api/v1/agents/{}/chat/completions`
- **audit-service** — `GET /api/v1/audit/export`
- **case-service** — `GET /api/v1/cases/{}/evidence/{}/download`, `GET /api/v1/operations/{}/download`, `POST /api/v1/cases/{}/evidence`
- **identity-service** — `GET /api/v1/tenants/self/branding/logo`, `GET /api/v1/tenants/self/walkthrough`, `POST /api/v1/public/demo-signup`, `POST /api/v1/public/demo-signup/claim`, `POST /api/v1/tenants/self/branding/logo`, `POST /api/v1/token/embed`, `POST /api/v1/token/embed/oidc`, `POST /api/v1/token/oidc`
- **ingestion-service** — `PUT /api/v1/uploads/{}/parts/{}`
- **realtime-hub** — `GET /api/v1/stream`, `GET /api/v1/ws`, `POST /api/v1/stream-tickets`, `POST /api/v1/stream/{}/token`, `POST /api/v1/stream/{}/topics`

**realtime-hub is fronted by nothing, by design.** The UI opens SSE directly; only the single-use ticket
mint goes through a Next route (`src/app/api/rt/ticket/route.ts`).

---

## 4. The gap: 77 endpoints with no path to a user

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

### Value metering: chargeback, adjustments, reconciliation — 1 endpoint

*BRD 67*

Showback reads are covered. Chargeback reporting, billing adjustments and provider-bill reconciliation are not.

| Endpoint | Service | What it does |
|---|---|---|
| `GET /api/v1/value-report-artifacts/*` | usage-service | Download a generated value/ROI report (ROI-FR-021). |

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

The BFF exposes **199 queries** and **285 mutations**. The original sixteen orphan root fields remain
unconsumed, and the memory-governance merge added three more:

**Queries (14)** — `workspace`, `group`, `chart`, `verifiedQuery`, `pipelineRun`, `evalDataset`, `evalCase`,
`evalGatesByDigest`, `caseStream`, `ingestionSchedule`, `inferenceSchedule`, `reportSubscription`, `budget`,
`aiBudget`

**Mutations (2)** — `bindCaseStreamTrigger`, `bulkCreateInferenceJobs`

**New this revision (3)** — `writeMemory`, `writeMemoryBatch`, `pushCorpusDocument`: wired to real
downstream routes but no UI operation selects them yet (the memory console consumes edit/delete/
unquarantine/retrieve/corpora/policy). Schema-ahead-of-UI, flagged per this audit's own hygiene rule.

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
| 4 | Memory corpora + policy admin | **DONE** — corpus/policy/retrieval-tester console on /admin/memory. |
| 5 | Agent registry lifecycle | The Control Tower can kill but not publish, canary or roll back. |
| 6 | Learning-loop cockpit | The largest gap and the closest to the product thesis. Worth sequencing after the GPU leg lands — promote/demote without a trainer is a half-page. |
| 7 | Prune the 14 orphan queries; build the 2 orphan mutations | Small, and keeps the schema honest. |

---

*Regenerate by re-running the extraction described in §2 against the current tree; the counts in §1 are the
audit's own baseline and should be updated in the same commit as any change that moves them.*
