# Windrose Platform — Master BRD (Shared Requirements & Conventions)

**Date:** 2026-07-09 · **Status:** Approved for build
**Read this first.** Every per-service BRD in this directory inherits everything in this document. A coding agent implementing any service MUST comply with the master requirements below in addition to the service's own BRD. Architecture context: `../../WINDROSE_PLATFORM_ARCHITECTURE.md`.

---

## 1. Platform context (one paragraph)

Windrose is a multi-tenant, multi-cloud (AWS/Azure/GCP) ML platform: ingest → manage/profile → train → infer → visualize → triage, with an agentic-AI layer across every stage. Services are independently deployable (K8s), own their data (one Postgres DB per service), communicate synchronously only within a bounded context (gRPC) or from the BFF, and asynchronously across contexts via Kafka. AI agents access services exclusively through governed MCP tool facades. Writes by agents are proposals requiring human approval.

## 2. Global requirements (apply to EVERY service)

### 2.1 Multi-tenancy — MASTER-FR-001..004
- **001** Every table carries `tenant_id UUID NOT NULL`; Postgres **row-level security** enabled with policy `tenant_id = current_setting('app.tenant_id')::uuid`. The service sets `app.tenant_id` per request from the verified JWT — never from request parameters or bodies.
- **002** Tenant ID in any request payload/query param MUST be ignored for authorization purposes.
- **003** Cross-tenant access attempts return `404` (not `403`) to avoid resource-existence leaks, and emit an audit event `security.cross_tenant_denied`.
- **004** Isolation tests are part of the service test suite: authenticated requests with tenant A's token against tenant B's resources must fail for every endpoint.

### 2.2 Authentication & authorization — MASTER-FR-010..016
- **010** All external requests carry an RS256 JWT (issued by identity-service via Keycloak; 5-min TTL). Services verify signature via cached JWKS (refresh ≤ 5 min) and validate `exp`, `iss`, `aud`.
- **011** JWT claims: `sub` (user or agent principal), `tenant_id`, `typ` (`user` | `service` | `agent_obo` | `agent_autonomous`), `agent_id`+`agent_version` (when `typ` starts with `agent`), `obo_sub` (original user for `agent_obo`), `scopes`.
- **012** Authorization decisions call the local OPA sidecar (`POST localhost:8181/v1/data/windrose/authz/allow`) with `{subject, action, resource_urn, tenant}`; OPA reads the Redis `permissions_flat` projection. Target p99 ≤ 10ms. **Never** call rbac-service synchronously in the request path.
- **013** Resource URNs: `wr:<tenant_id>:<service>:<resource_type>/<resource_id>` (e.g., `wr:t-42:dataset:dataset/ds-9f2`). All permission checks, audit events, and lineage references use URNs.
- **014** Service-to-service calls use SPIFFE mTLS identities; no shared secrets, no unsigned tokens. **JWT `alg=none` is forbidden; CI lint rejects it.**
- **015** Agent-originated requests (`typ=agent_obo`) are authorized as intersection(user grants, agent toolset scopes). Services treat them like user requests plus audit attribution (§2.5).
- **016** Actions are named `<service>.<resource>.<verb>`: e.g., `dataset.dataset.read`, `case.case.assign`, `chart.dashboard.delete`.

### 2.3 API standards — MASTER-FR-020..028
- **020** REST, JSON, `Content-Type: application/json`. Base path `/api/v1`. Breaking changes require `/api/v2` — never mutate v1 semantics.
- **021** Resource IDs are UUIDv7 (time-ordered), exposed as opaque strings.
- **022** **Pagination is mandatory** on every collection endpoint: cursor-based (`?limit=` default 50, max 200; `?cursor=`); response envelope `{data: [...], page: {next_cursor, has_more}}`. Count queries are opt-in (`?with_count=true`) and may be estimates.
- **023** Filtering `?filter[field]=value`, sorting `?sort=-created_at`. Only indexed fields are filterable/sortable; document the list per endpoint.
- **024** Errors: `{error: {code, message, details?, trace_id}}` with stable machine-readable `code` (e.g., `VALIDATION_FAILED`, `NOT_FOUND`, `PERMISSION_DENIED`, `BUDGET_EXHAUSTED`, `CONFLICT`, `RATE_LIMITED`). HTTP status matches semantics. Validation errors list per-field problems in `details`.
- **025** Idempotency: all POST endpoints that create side effects accept `Idempotency-Key` header; duplicate keys within 24h return the original response with `Idempotency-Replayed: true`.
- **026** Mutations return the full updated resource. Timestamps ISO-8601 UTC. Soft-delete (`deleted_at`) for user-facing resources; hard-delete only via retention jobs.
- **027** Long-running operations return `202 {operation_id}` and progress via SSE from realtime-hub and/or `GET .../operations/:id`. **No client polling loops against list endpoints.**
- **028** Every response includes `X-Trace-Id`. Rate limiting per tenant at the edge; services also enforce per-tenant concurrency caps on expensive endpoints (documented per BRD).

### 2.4 Events — MASTER-FR-030..035
- **030** Every state change emits an event to the service's topic `<ctx>.events.v1` (Kafka, Avro, Schema Registry; backward-compatible evolution enforced in CI).
- **031** Envelope (all events): `{event_id: uuidv7, event_type, tenant_id, actor: {type, id}, via_agent: {agent_id, version}|null, resource_urn, occurred_at, trace_id, payload}`. Partition key = `tenant_id`.
- **032** Producers are idempotent (Kafka idempotent producer + `event_id` dedup). Consumers dedup via Redis (`SETNX event_id`, 24h TTL) and are safe to replay.
- **033** Each consumer group has a DLQ (`<topic>.<group>.dlq`); poison messages route there after 5 retries with exponential backoff; DLQ depth alerts at >0 for 15 min.
- **034** **Transactional outbox pattern** for DB-write + event-emit atomicity (outbox table + Debezium or poller). Never emit before commit.
- **035** Event names: `<resource>.<past_tense_verb>` (`dataset.created`, `case.assigned`, `proposal.approved`).

### 2.5 Audit — MASTER-FR-040..042
- **040** Every mutation and every permission denial emits an audit event (consumed by audit-service). Audit payload includes before/after digests for updates.
- **041** Agent attribution is dual: `actor={type:'user',id}` + `via_agent={agent_id,version}` for OBO; `actor={type:'agent',...}` for autonomous runs.
- **042** No PII in event payloads beyond resource references; PII fields are referenced by URN + field name, not value.

### 2.6 Observability — MASTER-FR-050..053
- **050** OTel instrumentation: traces on all inbound/outbound calls (propagate `traceparent`), RED metrics (`http_server_duration`, error rate) per route, structured JSON logs with `{tenant_id, trace_id, actor}`. Log levels: no payload bodies at INFO.
- **051** Health endpoints: `GET /healthz` (liveness, no deps), `GET /readyz` (checks DB/Kafka/Redis). Prometheus `/metrics`.
- **052** LLM-touching services additionally emit OTel GenAI semconv spans (`invoke_agent`, `chat`, `execute_tool`) with `gen_ai.usage.input_tokens/output_tokens` attributes. Pin semconv version in one shared constant.
- **053** SLO defaults unless overridden per BRD: availability 99.95%, p95 latency 300ms (read), 500ms (write); error budget alerts at 2% burn/hour.

### 2.7 Data & migrations — MASTER-FR-060..063
- **060** Schema migrations are forward-only, applied via CI (golang-migrate / alembic). Every table: `id`, `tenant_id`, `created_at`, `updated_at`, (`deleted_at`). FKs within the service DB only — cross-service references are URNs, never FKs.
- **061** No JSONB as primary relational storage. JSONB is allowed only for genuinely schemaless payloads ≤ 64KB (document per use in BRD); anything larger goes to object storage with a pointer row.
- **062** High-volume tables (events, histories, cases, usage) are partitioned by month from day one; retention policy documented per table.
- **063** All list queries must be covered by an index; BRDs enumerate expected indexes.

### 2.8 Testing & delivery — MASTER-FR-070..073
- **070** Coverage gates: unit + integration (Testcontainers for PG/Kafka/Redis) ≥ 80% on business logic; contract tests for every published event schema and every consumed API.
- **071** Isolation test suite (§2.1-004) and authz matrix test (every endpoint × role) required.
- **072** Each service ships: Dockerfile (distroless), Helm chart (HPA, PDB, resources, netpol), dashboards-as-code, runbook (`RUNBOOK.md`: failure modes, DLQ drain, rollback).
- **073** Feature flags via OpenFeature for any behavior change touching existing tenants.

### 2.9 End-user simplicity charter — MASTER-FR-090..099

The platform's primary user is a **domain analyst** (adjuster, underwriter, fraud investigator, planner), NOT a data engineer. Every UI-adjacent BRD (21 bff-graphql, 22 ui-web) and any admin surface exposed by another BRD MUST comply with this charter. Deviations require a documented exception approved by the platform product lead and are reviewed quarterly. The charter is testable via the **Simplicity Acceptance Suite** (§below), which every UI-touching BRD ships an entry in.

- **090 Chat is the primary interface, not the config panel.** Every workspace opens on a single conversational surface that accepts a natural-language question, a document drop, or a data upload. Configuration screens exist as secondary tabs — a first-time user never lands on one. Chat may execute deterministic actions (via §MASTER-FR-025 idempotency) and initiate agent proposals.
- **091 Zero-config defaults; ask, don't configure.** Every tenant, workspace, dashboard, model, budget, and pack ships with a sensible default. New objects are creatable with ≤ 3 required fields (name + primary source + one choice); everything else is derived, defaulted, or hidden behind an "Advanced" affordance that is collapsed by default. Setup wizards are forbidden — replaced by opinionated defaults + one-touch reversal.
- **092 Progressive disclosure.** The default view of every entity shows ≤ 6 attributes. "More details" reveals the full schema. "Expert mode" (per-user preference, remembered) unhides technical primitives (URNs, versions, JSON payloads, span attributes). Non-expert copy hides internal identifiers entirely.
- **093 One action per screen; the next step is always named.** Every page state has ONE primary CTA labeled with a domain verb ("Approve installation", "Assign to me", "Resolve claim"); secondary actions are text buttons, not equal-weight primaries. Empty states show exactly one CTA plus one link to a related pack/template.
- **094 Plain English only in default mode.** Technical platform terms (URN, semantic model, workflow id, MCP tool, request class, rung) are permitted only in expert mode or as hover-tooltip explanations. UI copy uses domain nouns from the installed pack ("claim", "policy", "adjuster") in preference to platform nouns ("resource", "workspace item"). BFF (BRD 21) resolves platform identifiers to human labels via a per-pack `display_labels` map shipped in every capability pack (BRD 23).
- **095 Undo everywhere for reversible actions.** Delete, archive, install, assign/unassign, and status transitions surface an inline "Undo" toast valid for ≥ 30s. Actions with permanent effects (purge uninstall, model deregistration, credential revocation) use a **typed-confirmation** dialog (user types the object name) and never a plain OK button.
- **096 No modals for reversible actions.** Confirmation modals are permitted only for destructive/irreversible operations. Every other decision uses inline affordances (toggles, chips, autosave). Autosave is the default; explicit "Save" buttons appear only when a step is transactional (submit-for-approval, publish, install).
- **097 Cost + provenance inline, not buried.** Any AI-produced answer, prediction, chart, or agent proposal shows, as a small footer (not a hidden panel): (a) source citations — dataset/model version URNs rendered as human-legible chips ("`Claims v42` · `Fraud model v3.1`"); (b) cost of producing this answer (from usage-service `usage.get_decision_cost`); (c) confidence or eval score if available. Absence of any of these on an AI-touched surface is a release-blocker.
- **098 Real-time updates without polling.** Every list/detail surface auto-updates via realtime-hub subscriptions (BRD 20); users never click "Refresh". Latency budget ≤ 2s event→render. Client polling of list endpoints is CI-lint-forbidden.
- **099 Search is navigation.** A global command palette (Cmd/Ctrl-K) finds any object (case, dashboard, dataset, agent, pack, doc, run) by name, tag, URN, or NL description across the user's permitted scope, and offers the top action inline ("Open", "Assign to me", "Share"). Category navigation exists but is the fallback path, not the primary one.

**Simplicity Acceptance Suite (SAS).** Every UI-touching BRD ships one scripted user journey demonstrating time-to-first-value for a **new tenant admin** with **zero documentation read**:
- **SAS-A** Install a pack from the marketplace → ≤ 5 min (BRD 22 + 23 + 21).
- **SAS-B** Resolve their first case → ≤ 5 min (BRD 22 + 08 + 21).
- **SAS-C** Publish a chart from a natural-language question → ≤ 5 min (BRD 22 + 06 + 07 + 21).

The full journey (A + B + C) must complete in ≤ 15 minutes end-to-end with only the credentials mailed at tenant provisioning. Failure of any SAS journey is a P0 release blocker. Videos of the last passing SAS run are stored per release; the SAS suite runs in CI against a fresh cell before every promotion.

## 3. Shared platform SLO/NFR baseline

| Metric | Target |
|---|---|
| API availability / auth availability | 99.95% / 99.99% |
| Read p95 / write p95 | 300ms / 500ms |
| Authz check p99 (OPA+Redis) | 10ms |
| Event publish→consume p95 | 5s |
| Cell capacity | 500 tenants, 20K RPS, 100K events/s, 2K concurrent LLM streams |
| RPO / RTO | 15 min / 1 h |
| Cross-tenant incidents | 0 (release gate) |

## 4. Glossary
**Tenant** customer org, pinned to one cell/cloud · **Cell** independent deployment unit (~500 tenants) · **Workspace** collaboration space inside a tenant; RBAC boundary · **URN** global resource name (§2.2-013) · **Proposal** agent-suggested write awaiting human decision · **OBO token** scoped-down JWT letting an agent act on behalf of a user · **Semantic model** governed metrics/dimensions/joins per workspace · **Verified query** curated NL↔SQL pair · **Component** containerized pipeline step (Argo) · **Tool** MCP-registered callable exposed to agents · **Golden dataset** versioned eval cases gating agent releases · **Capability Pack** signed, versioned vertical solution bundle (ontology + semantics + charts + cases + roles + evals + guardrails + pipeline templates + model archetypes + agent recipes) installed into a workspace; managed by pack-service (BRD 23) · **Materialization target** a downstream service's contract (`apply`/`revert`/`probe`) letting pack-service create the service's resources idempotently · **Decision URN** a URN identifying a business decision (case, chart, proposal) that AI calls attribute their cost against, so ROI is measurable per outcome · **Cascade** eval-gated tier promotion/demotion in ai-gateway that picks the cheapest rung meeting quality thresholds · **SLM tier** self-hosted small-language-model deployments (vLLM/TGI/Ollama) serving as rung 0 for cost-optimal routing · **Distillation lifecycle** the flywheel that converts sanitized production traces into fine-tuned SLMs, then promotes them into the ladder subject to eval acceptance · **Windrose Claims** the first vertical product built on Windrose Core — installable via the `insurance-claims-payer` capability pack (BRD 24); ships three copilots (PA, Appeal Analyst, Denial Notice Drafter) with US-payer ontology, connectors, dashboards, guardrails, and evals · **Proposal-mode-only agent** an agent whose write tools always route through a case-service proposal awaiting human approval; the Windrose Claims agents are proposal-mode-only by permanent design (BRD 24 §BR-1) · **Shadow mode** an agent-runtime tenant policy where the agent runs on real workload and stores predictions for agreement measurement but never surfaces to end users or writes to downstream systems; gates promotion to proposal-mode via eval acceptance.

## 5. BRD template (every service BRD follows this)

1. **Overview** — purpose, business value, in/out of scope
2. **Actors & user stories** — persona-based, numbered `US-n`
3. **Functional requirements** — numbered `<SVC>-FR-nnn`, MoSCoW-tagged, testable
4. **Domain model & data** — tables with columns/types/constraints; indexes; retention; state machines (states + transitions + guards)
5. **API specification** — endpoint table + request/response examples for non-obvious shapes; errors per endpoint
6. **Events** — emitted (type + payload fields) and consumed (+ handler behavior)
7. **Business rules & edge cases** — numbered `BR-n`; includes concurrency, limits, failure behavior
8. **Dependencies** — services, infra, upstream/downstream contracts
9. **NFRs** — only deltas from master baseline
10. **Acceptance criteria** — Given/When/Then, numbered `AC-n`, minimum 10 per service
11. **Out of scope / future**

## 6. BRD index

| # | File | Service | Phase |
|---|---|---|---|
| 01 | `01_identity_service_BRD.md` | identity-service | 0–1 |
| 02 | `02_rbac_service_BRD.md` | rbac-service | 1 |
| 03 | `03_ingestion_service_BRD.md` | ingestion-service | 1 |
| 04 | `04_dataset_service_BRD.md` | dataset-service | 1 |
| 05 | `05_query_service_BRD.md` | query-service | 1 |
| 06 | `06_semantic_service_BRD.md` | semantic-service | 2 |
| 07 | `07_chart_service_BRD.md` | chart-service | 2 |
| 08 | `08_case_service_BRD.md` | case-service | 4 |
| 09 | `09_pipeline_orchestrator_BRD.md` | pipeline-orchestrator | 3 |
| 10 | `10_experiment_service_BRD.md` | experiment-service | 3 |
| 11 | `11_inference_service_BRD.md` | inference-service | 3 |
| 12 | `12_ai_gateway_BRD.md` | ai-gateway | 2 |
| 13 | `13_tool_plane_BRD.md` | tool-registry + MCP gateway | 2 |
| 14 | `14_agent_runtime_BRD.md` | agent-runtime + agent-registry | 2–4 |
| 15 | `15_memory_service_BRD.md` | memory-service | 4 |
| 16 | `16_eval_service_BRD.md` | eval-service | 2–4 |
| 17 | `17_usage_service_BRD.md` | usage-service | 2–5 |
| 18 | `18_audit_service_BRD.md` | audit-service | 1 |
| 19 | `19_notification_service_BRD.md` | notification-service | 4 |
| 20 | `20_realtime_hub_BRD.md` | realtime-hub | 1 |
| 21 | `21_bff_graphql_BRD.md` | bff-graphql | 0–5 |
| 22 | `22_ui_web_BRD.md` | ui-web (frontend) | 0–5 |
| 23 | `23_pack_service_BRD.md` | pack-service (Capability Pack Registry & Installer) | 3 (marketplace = 5) |
| 24 | `24_insurance_claims_payer_pack_BRD.md` | `insurance-claims-payer` Capability Pack (Horizon 1 payer vertical — Windrose Claims product) | 4–5 |
| 25 | `25_care_management_medicare_pack_BRD.md` | `care-management-medicare` Capability Pack (Horizon 2a — first provider-side pack: CCM/PCM/TCM/BHI/CoCM/RPM/RTM/APCM) | Horizon 2a |
| 26 | `26_healthcare_provider_rcm_pack_BRD.md` | `healthcare-provider-rcm` Capability Pack (Horizon 2b — general provider revenue cycle: coding, denials, underpayments, AR, patient collections) | Horizon 2b |
| 27 | `27_payer_fwa_siu_pack_BRD.md` | `payer-fwa-siu` Capability Pack (Horizon 2b — payer fraud/waste/abuse investigation + prosecution referral) | Horizon 2b |
| 28 | `28_pharmacy_benefit_mgmt_pack_BRD.md` | `pharmacy-benefit-mgmt` Capability Pack (Horizon 2b — Rx PA, formulary alternatives, MTM, adherence, Star Ratings) | Horizon 2b |
| 29 | `29_post_acute_care_pack_BRD.md` | `post-acute-care` Capability Pack (Horizon 2c — home health OASIS+PDGM, SNF MDS+PDPM, hospice, referral triage) | Horizon 2c |
| 30 | `30_banking_aml_pack_BRD.md` | `banking-aml` Capability Pack (Horizon 2 non-healthcare #1 — **cross-industry Core-neutrality proof**: BSA + OFAC + FinCEN + GLBA alert triage, sanctions adjudication, SAR narrative, CDD/EDD, adverse media, peer anomaly) | Horizon 2 (post-healthcare sweep) |
| 31 | `31_investigation_framework_pack_BRD.md` | `investigation-framework` **LIBRARY pack** (Horizon 2 — reusable investigation primitives: 3-agent specialist pattern + graph tools + chain-of-custody guardrails + case schemas + KPIs, consumed by BRDs 27, 30, and future investigation-heavy packs via `depends_on`. First "library pack" in the ecosystem — proves pack composition.) | Horizon 2 (alongside BRDs 27+30) |

**Healthcare pack roadmap:** see [`../../HEALTHCARE_PACK_ROADMAP.md`](../../HEALTHCARE_PACK_ROADMAP.md) for the full healthcare-vertical pack roster including deferred candidates, buyer-persona map, and sales bundle patterns.
