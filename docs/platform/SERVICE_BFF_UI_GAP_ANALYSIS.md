# Service → BFF → UI gap analysis

**Scope:** every HTTP route registered by the 21 domain services, classified by how — or whether —
it reaches the user. **Generated:** 2026-08-02 (rev 4 — end of gap-closure campaign) against `claude/datacern-ai-capabilities-p7q6a7`.

Companion to [`PLATFORM_ARCHITECTURE.md`](PLATFORM_ARCHITECTURE.md) §3. This is a *coverage* audit, not a
defect list: an endpoint in the GAP column is built and tested downstream — it simply has no path to a user.

---

## 1. Summary

**663 routes.** 552 reach the browser through the GraphQL BFF, 23 through a
same-origin Next.js route handler, 68 are service-to-service or machine surfaces that
*should* not be fronted — and **20 have no path to a user at all.**

Of the 595 user-facing routes, **97% are reachable.**

The gap is not spread evenly. It clusters almost entirely in **write, lifecycle and admin control planes**;
read paths are well covered. Three services carry over half of it: agent-runtime, identity-service and
memory-service. The recurring shape is: **the read is exposed, the control is not.**

| Service | BFF | UI-direct | Internal | **Gap** | User-facing coverage |
|---|---:|---:|---:|---:|---:|
| `notification-service` | 31 | 0 | 1 | **4** | 89% |
| `pipeline-orchestrator` | 25 | 0 | 2 | **4** | 86% |
| `ingestion-service` | 39 | 1 | 2 | **3** | 93% |
| `case-service` | 37 | 3 | 2 | **2** | 95% |
| `dataset-service` | 22 | 0 | 8 | **2** | 92% |
| `experiment-service` | 34 | 0 | 3 | **1** | 97% |
| `pack-service` | 10 | 0 | 0 | **1** | 91% |
| `rbac-service` | 32 | 0 | 6 | **1** | 97% |
| `semantic-service` | 27 | 0 | 5 | **1** | 96% |
| `tool-plane` | 17 | 0 | 0 | **1** | 94% |
| `agent-runtime` | 53 | 1 | 8 | **0** | 100% |
| `ai-gateway` | 24 | 0 | 2 | **0** | 100% |
| `audit-service` | 14 | 1 | 1 | **0** | 100% |
| `chart-service` | 23 | 1 | 1 | **0** | 100% |
| `eval-service` | 33 | 0 | 1 | **0** | 100% |
| `identity-service` | 53 | 9 | 20 | **0** | 100% |
| `inference-service` | 18 | 0 | 1 | **0** | 100% |
| `memory-service` | 18 | 0 | 1 | **0** | 100% |
| `query-service` | 17 | 1 | 1 | **0** | 100% |
| `realtime-hub` | 0 | 5 | 3 | **0** | 100% |
| `usage-service` | 25 | 1 | 0 | **0** | 100% |
| **total** | **552** | **23** | **68** | **20** | **97%** |

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

**23 routes reached by a Next.js route handler rather than the BFF.** This is an intentional
second path for multipart, binary and streaming traffic that GraphQL cannot carry, implemented as
zero-business-logic proxies that attach the httpOnly session bearer a browser `fetch` cannot:

- **agent-runtime** — `POST /api/v1/agents/{}/chat/completions`
- **audit-service** — `GET /api/v1/audit/export`
- **case-service** — `GET /api/v1/cases/{}/evidence/{}/download`, `GET /api/v1/operations/{}/download`, `POST /api/v1/cases/{}/evidence`
- **chart-service** — `GET /api/v1/exports/*`
- **identity-service** — `GET /api/v1/poc-report-artifacts/*`, `GET /api/v1/tenants/self/branding/logo`, `GET /api/v1/tenants/self/walkthrough`, `POST /api/v1/public/demo-signup`, `POST /api/v1/public/demo-signup/claim`, `POST /api/v1/tenants/self/branding/logo`, `POST /api/v1/token/embed`, `POST /api/v1/token/embed/oidc`, `POST /api/v1/token/oidc`
- **ingestion-service** — `PUT /api/v1/uploads/{}/parts/{}`
- **query-service** — `GET /api/v1/downloads/{}`
- **realtime-hub** — `GET /api/v1/stream`, `GET /api/v1/ws`, `POST /api/v1/stream-tickets`, `POST /api/v1/stream/{}/token`, `POST /api/v1/stream/{}/topics`
- **usage-service** — `GET /api/v1/value-report-artifacts/*`

**realtime-hub is fronted by nothing, by design.** The UI opens SSE directly; only the single-use ticket
mint goes through a Next route (`src/app/api/rt/ticket/route.ts`).

---

## 4. The gap: 20 endpoints with no path to a user

Ordered by product impact. Each row is an endpoint that exists, is authorized, and is tested downstream.

### Catalog by-id reads — 14 endpoints

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
| `GET /api/v1/roles/{}` | rbac-service | One role. The role list IS exposed. |

### Other — 6 endpoints

Individually small; listed for completeness.

| Endpoint | Service | What it does |
|---|---|---|
| `POST /api/v1/cases/{}/apply-proposal` | case-service | Reachable from nothing — not the BFF, not a Next route, and no service calls it (agents apply through the MCP facade in `handlers_facade.go`). Looks superseded. |
| `POST /api/v1/lineage/edges` | dataset-service | Assert a lineage edge manually; the lineage graph is read-only in the UI. |
| `POST /api/v1/providers/{}/status` | notification-service | Email-provider health probe (operator diagnostic). |
| `GET /api/v1/packs/{}/lint` | pack-service | Pack coherence lint — CI runs it; an operator cannot. |
| `POST /api/v1/compile/chart` | semantic-service | Chart-shaped compile. **No caller anywhere** — chart-service uses `/api/v1/compile`. Likely dead or reserved. |
| `POST /api/v1/tools/{}/diff` | tool-plane | Diff two tool versions before enabling an upgrade. |

---

## 5. Layer B — schema fields with no UI consumer

The BFF exposes **218 queries** and **322 mutations**. After the campaign, 12 queries and 13 mutations
have no UI consumer:

**Queries (14)** — `workspace`, `group`, `chart`, `verifiedQuery`, `pipelineRun`, `evalDataset`, `evalCase`,
`evalGatesByDigest`, `caseStream`, `ingestionSchedule`, `inferenceSchedule`, `reportSubscription`, `budget`,
`aiBudget`

**Queries (12)** — `pocCriteria`, `caseStream`, `ingestionSchedule`, `reportSubscription`,
`verifiedQuery`, `inferenceSchedule`, `budget`, `pipelineRun`, `evalDataset`, `evalCase`,
`evalGatesByDigest`, `aiBudget` — mostly singular by-id fetches whose list sibling is used.

**Mutations (13)** — two pre-campaign (`bindCaseStreamTrigger`, `bulkCreateInferenceJobs`) plus eleven
added this campaign as deliberate API-parity without a button: `patchTenant`, `deleteTenant` (destroy is
deliberately not a button), `activateUser`, `cloneDemoTenant`, `setPocCriteria`, `extendTrial`,
`registerAgentDefinition`, `createAgentVersion`, `writeMemory`, `writeMemoryBatch`,
`pushCorpusDocument`. Each is one hook away from a surface; none blocks a user journey.

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

## 7. Campaign outcome

The 2026-08-02 gap-closure campaign took user-facing coverage from **73% (119 gaps)** to **97%
(20 gaps)**. Landed: both reverse gaps; decision outcome monitoring; external-agent console; audit
depth (dual attribution, event deep-link, raw + WORM exports); memory & RAG corpus administration;
billing depth; spend kill-switch + cache purge; decision-table dry-run; session terminate; run
annotation; tenant lifecycle console; demo/POC/trial commercial plane; agent registry lifecycle
(rollouts + retrain watches); query governance + chart depth; semantic tool discovery; the action
catalog; and the learning-loop cockpit (/ml/distillation). The 20 remaining rows above are
low-impact by-id reads and operator diagnostics, plus the two annotated caller-less removal
candidates.

---

*Regenerate by re-running the extraction described in §2 against the current tree; the counts in §1 are the
audit's own baseline and should be updated in the same commit as any change that moves them.*
