# BRD 21 — bff-graphql

**Service:** bff-graphql · **Language:** TypeScript (Node 22) · **Runtime:** Apollo Router (federation v2) + per-domain subgraphs · **Phase:** 0–5 · **Status:** Approved for build
**Inherits:** `00_MASTER_BRD.md`. Architecture: `../../DATACERN_PLATFORM_ARCHITECTURE.md` §6 (bff-graphql row: "GraphQL federation over the above for the UI; owns UI-shaped queries, no business logic").

---

## 1. Overview

**Purpose.** bff-graphql is the single GraphQL endpoint for ui-web. It federates UI-shaped read models and mutation passthroughs over the domain services' REST/gRPC APIs. It exists to solve exactly one problem: the UI needs cross-service, page-shaped data (a case detail page needs case + dataset + chart + agent-run data) without the browser issuing 12 REST calls or any domain service growing UI-specific endpoints.

**Business value.** One schema contract for the frontend team; N+1 and fan-out handled server-side; page loads within latency budgets; domain services stay UI-agnostic.

**In scope.** Apollo Router supergraph; one subgraph per domain cluster (BFF-owned subgraph services, each calling its domain services); JWT passthrough auth; dataloader-based batching; persisted queries (production-only allowlist); depth/complexity limits; error mapping to the master error envelope; schema-composition and breaking-change CI gates; delegation of all streaming to realtime-hub.

**Out of scope — hard boundaries.** **Zero business logic**: no validation beyond shape, no authorization decisions (domain services + OPA decide; BFF only forwards identity), no caching of tenant data beyond per-request dataloader memoization (v1), no direct database or Kafka access, no stream proxying (SSE/WS is realtime-hub's job), no write orchestration/sagas (a mutation maps to exactly one domain-service call), no public/partner API (internal UI contract only).

## 2. Actors & user stories

Personas: **Frontend Engineer** (primary consumer), **ui-web** (system client), **Domain Service Owner**, **Platform Operator**.

- **US-1** As a Frontend Engineer, I want one query to fetch a dashboard with its charts and each chart's data-availability status, so the dashboard page renders in one round trip.
- **US-2** As a Frontend Engineer, I want the case-detail query to include the case, its source dataset name, linked proposals, and last agent run, so the detail page needs no client-side stitching.
- **US-3** As a Domain Service Owner, I want the BFF to forward the caller's JWT untouched, so my service's authz and tenant isolation work identically for UI and non-UI callers.
- **US-4** As a Platform Operator, I want production to accept only persisted query hashes, so arbitrary query shapes can't be crafted against the graph.
- **US-5** As a Frontend Engineer, I want stable machine-readable error codes in GraphQL errors identical to REST codes, so error handling is uniform.
- **US-6** As a Platform Operator, I want depth/complexity limits, so a single query cannot fan out into thousands of downstream calls.
- **US-7** As a Frontend Engineer, I want cursor pagination semantics identical to the REST convention on every list field, so table components are generic.
- **US-8** As a Domain Service Owner, I want CI to block a subgraph change that breaks supergraph composition or an operation ui-web depends on, so deploys are safe.
- **US-9** As a Frontend Engineer, I want mutations to return the full updated resource, so TanStack Query caches update without refetch.
- **US-10** As a Frontend Engineer, I want the usage/cost panel query (spend by meter + budget states per workspace), so the AI cost panel is one query.

## 3. Functional requirements

### Topology & subgraph ownership
- **BFF-FR-001 (Must)** Apollo Router fronts five BFF-owned subgraph services (Node/Apollo Server, `@apollo/subgraph`). Subgraphs and the domain services each wraps:

| Subgraph | Wraps (REST/gRPC) | Owns types |
|---|---|---|
| `subgraph-data` | ingestion-service, dataset-service, query-service, semantic-service | Connection, IngestionJob, Dataset, DatasetVersion, Profile, LineageNode, SavedQuery, QueryRun, SemanticModel, VerifiedQuery |
| `subgraph-ml` | pipeline-orchestrator, experiment-service, inference-service | PipelineTemplate, PipelineRun, Experiment, Run, RegisteredModel, InferenceJob, Component |
| `subgraph-insights` | chart-service, case-service | Dashboard, Chart, ChartData, Case, CaseSearchResult, Disposition |
| `subgraph-agentic` | agent-runtime/agent-registry, tool-plane, memory-service, eval-service | Agent, AgentRun, ToolCall, Proposal, ProposalDecision, TraceNode, EvalScore |
| `subgraph-platform` | identity-service, rbac-service, usage-service, notification-service, audit-service | Tenant, User, Workspace, Group, Role, Grant, UsageReport, Budget, BudgetState, AuditEvent, NotificationSubscription |

- **BFF-FR-002 (Must)** Entity extension across subgraphs uses federation `@key` on URN-bearing types (e.g., `Dataset @key(fields:"id")` referenced from `Case.sourceDataset`); a subgraph never calls another subgraph — cross-domain joins happen only via router entity resolution.
- **BFF-FR-003 (Must)** Each resolver maps 1:1 onto a documented domain-service endpoint. Any resolver needing conditional logic, computed business state, or multi-service write coordination is rejected in code review — the logic moves to the owning domain service. Lint rule: subgraph packages may not import Kafka/DB clients.

### Auth passthrough
- **BFF-FR-010 (Must)** The inbound `Authorization: Bearer <JWT>` header is validated for signature/exp/iss/aud (cached JWKS, MASTER-FR-010) **only to fail fast**; the original token is forwarded verbatim on every downstream call. The BFF holds no service credentials for domain APIs and cannot mint tokens.
- **BFF-FR-011 (Must)** No authorization decisions in the BFF. Field-level "can the user see this" comes from downstream 403/404 responses mapped to null-with-error per GraphQL null-propagation rules. `tenant_id` never appears as a query argument — it exists only inside the forwarded JWT.
- **BFF-FR-012 (Must)** `traceparent` and `X-Trace-Id` propagate through every downstream call; each GraphQL operation is an OTel trace with per-resolver spans.

### Schema & pagination conventions
- **BFF-FR-020 (Must)** Every list field returns `Connection` shape mirroring REST: `{edges|nodes, pageInfo {nextCursor, hasMore}}` with `(first: Int = 50 ≤ 200, after: String)` mapping to REST `limit/cursor`. Counts only via explicit `totalCount` field which maps to `?with_count=true` (may be estimate; documented in SDL description).
- **BFF-FR-021 (Must)** Filtering/sorting arguments map 1:1 to documented REST filterable/sortable fields; the BFF adds none of its own.
- **BFF-FR-022 (Must)** IDs are the domain UUIDv7 strings; every major type exposes `urn: String!` for copilot-context, audit deep links, and cross-referencing.
- **BFF-FR-023 (Must)** Mutations mirror domain writes 1:1, accept an `idempotencyKey` argument forwarded as the `Idempotency-Key` header, and return the full resource. Long-running operations return `Operation {id, status}`; progress is consumed by the client from realtime-hub, not from the BFF.

### N+1 protection
- **BFF-FR-030 (Must)** One dataloader per downstream (service, resource) pair per request (e.g., `datasetLoader.loadMany(ids)` → `GET /datasets?filter[id]=a,b,c` batch endpoint). Every entity `__resolveReference` and every nested list resolver MUST go through a loader; direct per-item fetches in a list context fail CI (custom ESLint rule + load-test assertion).
- **BFF-FR-031 (Must)** Loader batch size ≤ 100 per downstream call (chunked); per-request memoization only — no cross-request cache in v1 (tenant-safety first; a keyed-by-tenant response cache is a flagged future). Canonical loader inventory (one per row, extended as the schema grows):

| Loader | Downstream batch endpoint |
|---|---|
| `datasetById` | `GET dataset-service /datasets?filter[id]=…` |
| `profileByDatasetId` | `GET dataset-service /profiles?filter[dataset_id]=…` |
| `chartDataByChartId` | `POST chart-service /charts/data:batch` |
| `userById` | `GET identity-service /users?filter[id]=…` |
| `agentById` | `GET agent-registry /agents?filter[id]=…` |
| `runById` | `GET experiment-service /runs?filter[id]=…` |
| `budgetStateByScope` | `GET usage-service /budget-states?scope=…` |
| `proposalByCaseId` | `GET agent-runtime /proposals?filter[resource_urn]=…` |
- **BFF-FR-032 (Must)** Per-downstream concurrency limit (default 20 in-flight per request) + 10s downstream timeout + circuit breaker (opossum: 50% error rate over 10s opens for 30s); an open circuit degrades the field to null + `SERVICE_UNAVAILABLE` error, never fails the whole operation unless the field is non-nullable at root.

### Persisted queries & limits
- **BFF-FR-040 (Must)** Production accepts **only** persisted operations: ui-web's build extracts operations to a manifest (hash → document), published to the router's persisted-query list. Unknown hashes/ad-hoc documents → `PERSISTED_QUERY_REQUIRED` (400). Dev/staging accept ad-hoc with the same validation rules. Workflow: ui-web CI step `graphql-codegen --persisted` emits `persisted-manifest.json` → published to an artifact registry keyed by ui-web release → router deploy references the union of the last 3 release manifests (BR-6). Request shape: `{"extensions":{"persistedQuery":{"sha256Hash":"…"}},"variables":{…}}`.
- **BFF-FR-041 (Must)** Static limits enforced pre-execution: max depth 10, max aliases 20, max root fields 5, cost limit 5,000 points (list fields cost `first × child-cost`); introspection disabled in production. Violation → `QUERY_TOO_COMPLEX`.
- **BFF-FR-042 (Should)** Per-tenant operation rate limits at the router (token bucket keyed on tenant_id claim; defaults 100 ops/s) returning `RATE_LIMITED`.

### Errors
- **BFF-FR-050 (Must)** Downstream master error envelopes (`{error:{code,message,details,trace_id}}`) map to GraphQL errors: `extensions = {code, details, traceId, service, httpStatus}`; message passthrough; data null per schema nullability. HTTP transport is always 200 for executable operations (errors in body), 400/401 for transport-level failures.
- **BFF-FR-051 (Must)** Code mapping is total and tested; master codes are preserved verbatim in `extensions.code`:

| Downstream (HTTP + code) | GraphQL `extensions.code` | Notes |
|---|---|---|
| 400 `VALIDATION_FAILED` | `VALIDATION_FAILED` | `extensions.details` carries per-field problems |
| 401 (any) | `UNAUTHENTICATED` | client triggers re-auth |
| 403 `PERMISSION_DENIED` | `PERMISSION_DENIED` | |
| 404 `NOT_FOUND` | `NOT_FOUND` (or silent null, BR-3) | tenant masking indistinguishable by design |
| 402/429 `BUDGET_EXHAUSTED` | `BUDGET_EXHAUSTED` | copilot/chart data paths |
| 409 `CONFLICT` | `CONFLICT` | e.g. proposal already decided |
| 429 `RATE_LIMITED` | `RATE_LIMITED` | `retryAfter` in extensions when present |
| 5xx / timeout / open circuit | `SERVICE_UNAVAILABLE` | `extensions.service` names the downstream |
| anything unmapped | `INTERNAL` | trace_id only; no downstream detail leakage |

Example error entry: `{"message":"Budget exhausted for workspace ws-7","path":["dashboard","charts",3,"data"],"extensions":{"code":"BUDGET_EXHAUSTED","service":"chart-service","httpStatus":402,"traceId":"4bf9…"}}`.
- **BFF-FR-052 (Must)** Partial success is first-class: multi-service page queries return whatever resolved; each failed subtree carries its own error entry.

### Streaming delegation
- **BFF-FR-060 (Must)** The BFF exposes **no** `Subscription` root and does not proxy SSE/WebSocket. The schema exposes stream descriptors instead: `type StreamHandle {hubUrl: String!, topics: [String!]!}` fields (e.g., `pipelineRun.statusStream`, `agentRun.tokenStream`, `notifications.stream`) that return the realtime-hub URL + topic names the client connects to directly with its JWT.

### CI & schema governance
- **BFF-FR-070 (Must)** CI on every subgraph change: (1) `rover subgraph check` composition against the current supergraph; (2) breaking-change detection against the persisted-operation manifest of the released ui-web (removing/renaming a used field, narrowing a type, adding a required arg = block); (3) SDL lint (descriptions on all public fields, naming conventions camelCase fields / PascalCase types).
- **BFF-FR-071 (Must)** Supergraph composition is published as an artifact; the router only loads CI-composed supergraphs (no runtime composition). Deprecations use `@deprecated(reason)` and live ≥ 2 ui-web release cycles before removal.

### Display labels & plain-English rendering (pack-driven)

The Simple UX Charter (MASTER-FR-094) mandates all end-user copy renders in the domain vocabulary of the installed capability pack (BRD 23), not platform primitives. The BFF is the seam where pack-provided labels attach to typed resources so ui-web renders "New claim" instead of "New case" without any vertical logic shipping into the frontend or any domain service. This subsection stays inside the BFF's stateless read-only boundary: labels are federated from pack-service exactly like any other passthrough data.

- **BFF-FR-080 (Must)** New root query `displayLabels(workspaceId: ID!, locale: String = "en"): DisplayLabels!` returns the resolved label map for the workspace — the union of platform defaults + installed-pack overrides for the requested locale. Any authenticated caller with visibility to the workspace may resolve it; cross-workspace access returns `NOT_FOUND` per master §2.1-003. TanStack Query staleTime is 5 min at the client; the server memoizes per-request via dataloader.
- **BFF-FR-081 (Must)** Every major URN-bearing type — `Dataset`, `Chart`, `Dashboard`, `Case`, `Proposal`, `Pack`, `PackInstall`, `Agent`, `AgentRun`, `PipelineRun`, `Experiment`, `Run`, `RegisteredModel`, `InferenceJob`, `Workspace`, `User`, `Budget`, `Connection`, `IngestionJob`, `SavedQuery` — exposes a computed field `displayName: String!` resolving to the object's user-visible name in the workspace's locale + pack terminology. Resolution order: (1) apply pack's `displayName` template (§BFF-FR-083 `entity_templates`) to the object's raw `name`; (2) platform default template; (3) raw `name` as-is. NEVER null (non-nullable). The raw `name` remains available on `name: String!` for expert mode.
- **BFF-FR-082 (Must)** **Pack-service integration contract.** subgraph-platform's DisplayLabels resolver calls pack-service `GET /packs/labels?workspace_id=&locale=` (new endpoint imposed on BRD 23 via §PKG-FR-041) which returns the merged label map from all installed packs' `display_labels` components plus the platform baseline. Response shape:
  ```json
  {"workspace_id":"ws-7","locale":"en","generated_at":"…",
   "keys":{"case.singular":"Claim","case.plural":"Claims","case.action.resolve":"Close claim",
           "case.column.id":"Claim ID","dashboard.action.publish":"Publish view",
           "cost.not_tracked":"Cost not tracked", …},
   "entity_templates":{"case":"Claim #{id}","dashboard":"{name}","dataset":"{name}"},
   "source_packs":[{"pack":"insurance-claims","version":"2.3.1","key_count":47}],
   "platform_default_key_count":523}
  ```
  Timeouts + circuit breaker per §BFF-FR-032 apply. Degradation: on pack-service unavailability, the resolver returns platform defaults only (never the empty map) and marks `sourcePacks` empty; a downstream error entry is NOT surfaced to the client since labels have a well-defined fallback.
- **BFF-FR-083 (Must)** `DisplayLabels` SDL surface (added to subgraph-platform):
  ```graphql
  type DisplayLabels {
    workspaceId: ID!
    locale: String!
    keys: [DisplayLabel!]!                        # complete, deduped, alpha-sorted by key
    keyed(keys: [String!]!): [DisplayLabel!]!     # hot-path bulk lookup used by primitives
    entityTemplates: [EntityTemplate!]!           # per-kind displayName templates ({id}, {name}, {slug} slots)
    sourcePacks: [SourcePack!]!                   # audit — which pack contributed how many keys
    generatedAt: DateTime! }
  type DisplayLabel  { key: String! value: String! sourcePack: String  # pack URN, or null for platform default
  }
  type EntityTemplate { kind: String! template: String! sourcePack: String }
  type SourcePack     { pack: String! version: String! keyCount: Int! }
  extend type Query { displayLabels(workspaceId: ID!, locale: String = "en"): DisplayLabels! }
  extend type Viewer { displayLabels: DisplayLabels! }   # bundled into `me` — see §BFF-FR-086
  ```
  `keys` returns the full map (~500 platform defaults + N pack keys) — cachable and typically ≤ 30KB gzip. `keyed(...)` is the hot-path variant that primitives use when they need only a handful of labels per render.
- **BFF-FR-084 (Must)** **Cache invalidation.** The BFF's in-process `LRU<workspace_id|locale, DisplayLabels>` (max 5,000 entries, TTL 5 min) is invalidated by a background listener on realtime-hub topics `pack.install_completed`, `pack.uninstall_completed`, `pack.version_published`. Simultaneously, a `displayLabels.updated {workspaceId, locale}` notification is fanned out via the standard notification-service topic so ui-web TanStack Query invalidates the client cache and re-renders labels within 5s (§UI-FR-072). No page reload required.
- **BFF-FR-085 (Should)** **Locale resolution** — precedence: `locale` arg (explicit) → `Accept-Language` header → `Workspace.defaultLocale` (identity-service) → `en`. Falls back per-key when the requested locale lacks a value: requested → pack's declared fallback locale → platform default in `en`. Fallbacks are recorded on `sourcePacks` for observability, never surfaced to end users. Ship `en` only in v1; the resolver structure supports adding locales without SDL change.
- **BFF-FR-086 (Should)** **Bulk prefetch on session start.** The existing `me: Viewer!` query is extended with `viewer.displayLabels: DisplayLabels!` returning the full map for the active workspace + resolved locale in one round trip. Combined `me` query executes p95 ≤ 400ms; ui-web renders label-complete on first paint without a second round trip.
- **BFF-FR-087 (Must)** **Isolation.** `displayLabels(workspaceId)` and every `displayName` field are workspace-scoped by hard filter in the resolver — the caller's JWT + OPA decision authorize the workspace visibility; cross-workspace queries return 404 with no data leakage (master §2.1-003). No cross-workspace label bleed even when both workspaces install the same pack.
- **BFF-FR-088 (Must)** **Canonical label-key registry.** The platform ships a versioned canonical key registry (`packages/label-registry/keys.json`) listing every valid label key + its default English value + a description of where it renders. Packs may only provide values for keys in the registry; keys not in the registry are ignored by the resolver (soft-fail) and warned in dev. **CI cross-check:** `<Label key="…">` calls in ui-web must all reference registry keys, and the pack-service label validator (BRD 23 §PKG-FR-042) rejects packs providing unknown keys. Prevents drift between UI primitives requesting keys and packs providing them.

## 4. Domain model & data

The BFF is **stateless**: no Postgres, no Kafka, no tenant data at rest. Owned state is limited to: composed supergraph SDL (artifact), persisted-query manifest (artifact, loaded to router memory/Redis), JWKS cache (memory, ≤ 5 min), circuit-breaker/ratelimit counters (memory or shared Redis — no tenant payloads). Consequently MASTER-FR-060..063 (migrations/RLS) apply as "not applicable — no database"; MASTER-FR-001 tenancy is satisfied by token passthrough (BFF-FR-010/011). No state machines; the only lifecycle is supergraph version rollout (previous supergraph kept for instant rollback).

## 5. GraphQL schema (adapted "API specification")

Endpoint: `POST /graphql` (persisted ops in prod); `GET /healthz`, `GET /readyz`, `/metrics` per master. Core SDL outline (representative, not exhaustive; all fields carry SDL descriptions):

```graphql
# ---- shared
interface Node { id: ID! urn: String! }
type PageInfo { nextCursor: String hasMore: Boolean! }
type Operation { id: ID! status: OperationStatus! }
type StreamHandle { hubUrl: String! topics: [String!]! }
scalar DateTime  scalar Date  scalar JSON
enum OperationStatus { PENDING RUNNING SUCCEEDED FAILED }
enum RunStatus { QUEUED RUNNING SUCCEEDED FAILED CANCELLED }
enum JobStatus { PENDING RUNNING SUCCEEDED FAILED }
enum ProposalStatus { PENDING APPROVED REJECTED EDITED_APPROVED RESPONDED EXPIRED }
enum CaseStatus { OPEN IN_PROGRESS RESOLVED CLOSED }
input DecisionInput { kind: DecisionKind!            # APPROVE | REJECT | EDIT_ARGS | RESPOND
  reason: String                                     # required for REJECT (enforced downstream)
  editedArgs: JSON  responseText: String }

# ---- data module (subgraph-data)
type Dataset implements Node @key(fields:"id") { id: ID! urn: String! name: String!
  status: DatasetStatus! currentVersion: DatasetVersion profile: Profile
  lineage(depth: Int = 2): [LineageNode!]! createdAt: DateTime! }
type Connection implements Node { id: ID! urn: String! type: ConnectorType! name: String! status: ConnectionStatus! }
type IngestionJob implements Node { id: ID! urn: String! dataset: Dataset status: JobStatus! progressStream: StreamHandle! }
type SavedQuery implements Node { id: ID! urn: String! name: String! sql: String! lastRun: QueryRun }
type QueryRun { id: ID! status: JobStatus! resultPage(first: Int, after: String): QueryResultPage! }

# ---- ml module (subgraph-ml)
type PipelineRun implements Node { id: ID! urn: String! template: PipelineTemplate! status: RunStatus!
  nodes: [PipelineNodeStatus!]! statusStream: StreamHandle! experimentRun: Run }
type Experiment implements Node { id: ID! urn: String! runs(first: Int, after: String): RunConnection! }
type Run implements Node { id: ID! metrics: [Metric!]! params: [Param!]! model: RegisteredModel }

# ---- insights module (subgraph-insights)
type Dashboard implements Node { id: ID! urn: String! title: String! charts: [Chart!]! }
type Chart implements Node @key(fields:"id") { id: ID! urn: String! spec: ChartSpec!
  data(filters: [FilterInput!]): ChartData!            # chart-service cached data
  provenance: Provenance }                             # AI-generated? see agentic
type Case implements Node @key(fields:"id") { id: ID! urn: String! title: String! status: CaseStatus!
  assignee: User severity: Int sourceDataset: Dataset  # federated join into subgraph-data
  proposals(first: Int, after: String): ProposalConnection!
  lastAgentRun: AgentRun }
type Query { caseSearch(q: String, filters: CaseFilterInput, first: Int, after: String): CaseConnection! … }

# ---- agentic module (subgraph-agentic)
type AgentRun implements Node { id: ID! urn: String! agent: Agent! status: RunStatus!
  trace: [TraceNode!]!        # tool-call tree for the visualizer
  citations: [Citation!]! tokenUsage: TokenUsage! costUsd: Float
  tokenStream: StreamHandle! }
type TraceNode { spanId: ID! kind: TraceKind! name: String! startedAt: DateTime!
  durationMs: Int status: SpanStatus! children: [TraceNode!]! toolArgsDigest: String }
type Proposal implements Node { id: ID! urn: String! agent: Agent! tool: String!
  argsDiff: JSON! rationale: String! affectedUrns: [String!]! predictedEffect: String
  status: ProposalStatus! decision: ProposalDecision }
type Provenance { generatedByAgent: Agent agentVersion: String proposalId: ID sourceRunId: ID
  generatedAt: DateTime }     # EU AI Act provenance badge data

# ---- platform module (subgraph-platform)
type Workspace implements Node { id: ID! urn: String! name: String! members(first:Int, after:String): UserConnection! }
type UsageReport { rows(groupBy: [UsageGroupBy!]!, from: Date!, to: Date!, first: Int, after: String): UsageRowConnection! }
type BudgetState { budget: Budget! consumed: Float! limit: Float! lastThreshold: Int! exhaustedAt: DateTime }
type AuditEvent { eventId: ID! eventType: String! actor: Actor! viaAgent: AgentRef resourceUrn: String! occurredAt: DateTime! }

# ---- root operations (representative)
type Query {
  dataset(id: ID!): Dataset  datasets(first: Int, after: String, filter: DatasetFilter): DatasetConnection!
  dashboard(id: ID!): Dashboard  case(id: ID!): Case
  pipelineRun(id: ID!): PipelineRun  experiments(first: Int, after: String): ExperimentConnection!
  proposalsInbox(status: ProposalStatus = PENDING, first: Int, after: String): ProposalConnection!
  agentRun(id: ID!): AgentRun
  workspaceCostPanel(workspaceId: ID!, from: Date!, to: Date!): CostPanel!   # usage rows + budget states, one query
  auditSearch(filter: AuditFilter!, first: Int, after: String): AuditEventConnection!
  me: Viewer! }
type Mutation {
  createDataset(input: CreateDatasetInput!, idempotencyKey: String!): Dataset!
  runPipeline(templateId: ID!, params: JSON, idempotencyKey: String!): PipelineRun!
  saveChart(input: ChartInput!, idempotencyKey: String!): Chart!
  bulkUpdateCases(ids: [ID!]!, patch: CasePatchInput!, idempotencyKey: String!): BulkCaseResult!
  decideProposal(id: ID!, decision: DecisionInput!, idempotencyKey: String!): Proposal!  # approve/reject/edit-args
  upsertBudget(input: BudgetInput!, idempotencyKey: String!): Budget! }
```

Per-endpoint errors follow BFF-FR-050 mapping; e.g., `decideProposal` on an already-decided proposal surfaces `extensions.code=CONFLICT` from agent-runtime.

## 6. Events

**Emitted:** none (stateless; no Kafka producer). **Consumed:** none directly. Rationale documented as a deliberate exception to MASTER-FR-030: the BFF performs no state changes of its own; all state-changing traffic is passthrough and the owning services emit events. Realtime updates reach the UI via realtime-hub subscriptions declared through `StreamHandle` fields (BFF-FR-060).

## 7. Business rules & edge cases

- **BR-1** A resolver may call only its own subgraph's mapped services; cross-domain data is reachable exclusively via federation keys (prevents hidden coupling).
- **BR-2** A mutation maps to exactly one downstream write. Multi-write UI flows are modeled as multiple client mutations or a domain-service workflow endpoint — never BFF orchestration.
- **BR-3** Downstream 404 on a nullable field resolves to `null` **without** an error entry when caused by tenant-isolation masking (indistinguishable by design); genuine referenced-entity 404s in list hydration are logged with trace_id for producer investigation.
- **BR-4** Timeout budget: root operation 15s hard cap; per-downstream 10s; the router cancels in-flight downstream requests on client disconnect.
- **BR-5** Loader batching must preserve per-item error isolation: one bad ID in a batch fails that edge only.
- **BR-6** Persisted-query manifest rollout is backward-compatible: router retains hashes from the previous two ui-web releases.
- **BR-7** No response data is logged at INFO; resolver logs carry `{tenant_id, trace_id, operation_hash}` only.
- **BR-8** `totalCount` requests may return estimates (`isEstimate: true` alongside) mirroring REST `with_count` semantics.
- **BR-9** Supergraph rollback must be possible in < 5 min via redeploying the previous composed artifact (no data migration by construction).
- **BR-10** JWT near-expiry (< 30s) requests proceed; the BFF never refreshes tokens (client's job); downstream 401 maps to `UNAUTHENTICATED` prompting client re-auth.
- **BR-11** Variables are the only dynamic part of a production request; variable values are size-capped (64KB total) and never logged.
- **BR-12** Every SDL field/type carries a description including the owning downstream service and endpoint — the schema is self-documenting for frontend engineers and coding agents.
- **BR-13** `DisplayLabels` resolver is read-only + idempotent per request — the label endpoint on pack-service is a `GET` and this BRD's no-authz-decisions rule (§BFF-FR-011) still applies; label content is not authorization.
- **BR-14** `displayName` (§BFF-FR-081) fallback chain resolves to the raw `name` on any failure — never returns null (schema non-nullable) — and never surfaces an error entry because the client can always render `name` if labels fail.
- **BR-15** A key requested by ui-web that is missing from the platform default registry is a build error at ui-web CI (§BFF-FR-088), not a runtime BFF error — the registry is the shared source of truth.
- **BR-16** `entity_templates` (§BFF-FR-083) slots use `{name}`, `{id}`, `{slug}` placeholders only; template execution never evaluates arbitrary expressions (no SSTI risk); unknown slots resolve to the empty string.

## 8. Dependencies

**Downstream (calls):** all 15+ domain services over REST (gRPC where offered) through SPIFFE-mTLS network identity for transport, with user JWT for authorization. **Consumed contracts:** each service's OpenAPI spec + batch-get endpoints (`?filter[id]=` list form, and `POST …:batch` where payloads are needed) — **batch endpoints are a hard prerequisite this BRD imposes on the domain BRDs**; a subgraph may not ship a list-hydrating field until its batch endpoint exists. **New contracts imposed by §BFF-FR-080..088:** (a) pack-service `GET /packs/labels?workspace_id=&locale=` returning the merged label map for a workspace (BRD 23 §PKG-FR-041); (b) pack-service `display_labels` component kind + label-key validator against the canonical key registry (§PKG-FR-042); (c) usage-service `GET /decision-costs/:urn` batch endpoint feeding `Query.decisionCost` federated field (BRD 17 §USG-FR-083); (d) realtime-hub topic subscription on `pack.install_completed`, `pack.uninstall_completed`, `pack.version_published`, `displayLabels.updated` for LRU cache invalidation. **Upstream (called by):** ui-web only (netpol-enforced; the persisted-query allowlist is the API surface). **Infra:** Apollo Router, Node 22 subgraph pods, Redis (optional shared rate-limit/PQ store — never tenant payloads), OTel collector, CI with rover + GraphQL Inspector. **Peer:** realtime-hub (stream handles reference it; no runtime dependency).

**Testing & delivery specifics (refines MASTER-FR-070..072):** contract tests per subgraph against downstream OpenAPI mocks (Prism) + one live smoke per environment; composition + breaking-change CI (BFF-FR-070); load test asserting downstream call-count ceilings for the top-10 page queries (N+1 regression gate); RUNBOOK.md covers supergraph rollback, persisted-manifest resync, and circuit-breaker manual reset.

## 9. NFRs (deltas from master)

- Operation latency: p95 ≤ 400ms for single-entity page queries; ≤ 800ms for federated multi-service page queries (composition of downstream 300ms budgets).
- Overhead: router+subgraph processing adds p95 ≤ 40ms over the slowest downstream call.
- Throughput: 5K GraphQL ops/s per cell (fan-out ≤ 4× to REST within the 20K RPS cell budget).
- Availability 99.95%; statelessness ⇒ RPO n/a, RTO < 5 min (redeploy).

## 10. Acceptance criteria

- **AC-1** Given a dashboard with 12 charts, when `dashboard(id)` with nested `charts { data }` executes, then chart-service receives ≤ 2 batched data calls (not 12) — asserted by downstream call-count in an integration test.
- **AC-2** Given a case whose `sourceDataset` lives in subgraph-data, when `case(id){ sourceDataset { name profile { rowCount } } }` executes, then the router resolves the entity across subgraphs and returns the joined shape in one response.
- **AC-3** Given a request with tenant A's JWT querying a tenant-B case ID, when executed, then `case` is `null`, no tenant-B data appears anywhere in the response, and the downstream received tenant A's original token (asserted via downstream request capture).
- **AC-4** Given production mode, when an ad-hoc (non-persisted) query document is posted, then the response is a 400-class error with `extensions.code=PERSISTED_QUERY_REQUIRED` and no execution occurs.
- **AC-5** Given a query nested 11 levels deep or exceeding 5,000 cost points, when submitted in any environment, then it is rejected pre-execution with `QUERY_TOO_COMPLEX`.
- **AC-6** Given chart-service returns `{error:{code:"BUDGET_EXHAUSTED",…}}` for one chart's data while others succeed, when the dashboard query executes, then successful charts return data and the failed chart's `data` is null with an error entry carrying `extensions.code=BUDGET_EXHAUSTED` and `extensions.traceId`.
- **AC-7** Given `decideProposal` is called twice with the same `idempotencyKey`, when the second call executes, then agent-runtime receives the same `Idempotency-Key` header and the mutation returns the original result without a second decision.
- **AC-8** Given a subgraph PR that removes a field used by ui-web's persisted-operation manifest, when CI runs, then the pipeline fails at the breaking-change gate with the offending operation named.
- **AC-9** Given `pipelineRun(id){ statusStream { hubUrl topics } }`, when queried, then the response contains a realtime-hub URL and topic list, and the BFF process holds no open stream to the client (asserted by connection inspection under load).
- **AC-10** Given case-service is down (circuit open), when a dashboard-module query not touching cases executes, then it succeeds fully; and a case query returns null data with `SERVICE_UNAVAILABLE` within 1s (no 10s hang).
- **AC-11** Given any executed operation, when traced, then one OTel trace spans router → resolver → downstream HTTP with the inbound `traceparent` propagated to every domain-service call.
- **AC-12** Given the previous supergraph artifact, when the current one is rolled back, then the router serves the prior schema within 5 minutes with zero data migration.
- **AC-13** Given `casesConnection(first: 250)`, when validated, then it is rejected with `VALIDATION_FAILED` (max 200), mirroring the REST pagination contract.
- **AC-14** Given a load test replaying the top-10 persisted page queries at 1K ops/s, when measured, then per-operation downstream call counts stay within the documented ceilings and added BFF latency is ≤ 40ms p95 over the slowest downstream span.
- **AC-15** Given an insurance-claims pack installed in workspace W with `case.singular=Claim` and `entity_templates.case="Claim #{id}"`, When `displayLabels(workspaceId: W)` is queried, Then the returned map contains `Claim` for `case.singular`, cites the pack in `sourcePacks`, and includes the entity template; a workspace without the pack returns the platform default `Case`.
- **AC-16** Given `case(id: "c-9") { displayName name urn }` for a case in workspace W, When resolved, Then `displayName` is `"Claim #c-9"` (per pack template), `name` is the raw source-of-truth from case-service, and `urn` is present — the client renders `displayName` in default mode and reveals `urn` only in expert mode.
- **AC-17** Given a `pack.install_completed` event on realtime-hub for workspace W, When published, Then the BFF's LRU DisplayLabels cache for that workspace is evicted within 5s, a `displayLabels.updated {workspaceId, locale}` notification is fanned out, and a subsequent client re-query returns the new labels without page reload.
- **AC-18** Given tenant A workspace W1 and tenant B workspace W2 both with `insurance-claims@2.3.1` installed, When A queries `displayLabels(workspaceId: W2)`, Then the response is `NOT_FOUND` (or field-level null with an error entry per BR-3) and no B-owned label appears anywhere in the response; downstream capture confirms the pack-service call carried A's original token.
- **AC-19** Given a request with `Accept-Language: fr-FR` and the workspace has `en` labels only, When resolved, Then labels return in `en` per the fallback chain, `DisplayLabels.locale` is `en`, no error is surfaced to the client, and `sourcePacks` records the fallback for observability.
- **AC-20** Given a load test replaying the top-10 persisted queries at 1K ops/s with `displayName` selected on every major type, When measured, Then per-operation added latency stays within the §BFF-FR-020 budget of 40ms p95 on the cache-hit path and per-request downstream calls to pack-service `/packs/labels` remain ≤ 1 (memoized).
- **AC-21** Given pack-service returns 503 to `GET /packs/labels`, When `displayLabels(workspaceId: W)` is resolved, Then the response returns platform defaults with `sourcePacks: []`, does NOT surface an error entry to the client, and a `pack-service` circuit-breaker event appears in the trace (asserted via OTel span capture).

## 11. Out of scope / future

`@defer/@stream` incremental delivery; cross-request entity caching with tenant-keyed invalidation; public/partner GraphQL API; GraphQL subscriptions (permanently delegated to realtime-hub); schema stitching of non-BFF third-party graphs; BFF-side field-level authorization directives (would violate the no-authz boundary); mobile-specific persisted-query variants.
