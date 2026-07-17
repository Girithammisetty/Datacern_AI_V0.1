# Windrose AI — Platform Architecture & Workflows

*Governed decision-intelligence backbone for regulated operations.*

**Status:** engineering reference · **Audience:** engineers, architects, security & platform reviewers
**Companion diagrams:** `docs/platform/diagrams/*.drawio` (open in [draw.io](https://app.diagrams.net) / VS Code Draw.io extension)
**Companion Word doc:** `docs/platform/PLATFORM_ARCHITECTURE.docx`

---

## 1. Executive summary

Windrose AI is a multi-tenant platform that puts **AI-assisted decisions under governance**: every automated recommendation is grounded in real data, gated by human approval, attributed with provenance, and captured as a training signal that makes the next decision cheaper and better. The hero use case is **insurance claims triage**, but the Core is vertical-agnostic — verticals ship as *packs* on top of a frozen Core.

Three ideas define the platform:

1. **Governed autonomy.** Agents *propose*; humans *approve*. Every proposal carries provenance (which agent, which model rung, which evidence) and is authorized per-request against a live RBAC projection — never on trust.
2. **The learning loop is the product.** Each human correction (approve / edit / reject) becomes a labeled training pair. Those pairs curate into versioned SFT datasets, which distill into small specialized models (SLMs) that become the  rung of the model ladder — closing a **decision → correction → retrain → cheaper decision** loop.
3. **Real, no-stub, bring-your-own.** Everything runs on real infrastructure (Postgres, Kafka, OPA, MinIO, Iceberg/Trino, Temporal, MLflow, Keycloak). Cloud, identity, secrets, and observability are pluggable so a customer can bring their own.

---

## 2. Architecture at a glance

The platform is a set of ~22 independently deployable services across three planes, fronted by a single GraphQL BFF and a Next.js app.

```
  Browser ──► ui-web (Next.js) ──► bff-graphql ──► domain services ──► data & infra plane
                                        │
                        realtime-hub (SSE/WS) ◄── event bus (Kafka)
```

- **Experience plane** — `ui-web` (Next.js app, httpOnly session), `bff-graphql` (hand-written Apollo GraphQL; the *only* thing the browser talks to for data).
- **Control & governance plane** — `identity-service` (tenants, users, tokens, OIDC), `rbac-service` (roles, capability catalog, OPA policy), `audit-service`, `usage-service`.
- **Domain plane** — casework (`case-service`), data (`dataset-service`, `ingestion-service`, `query-service`, `semantic-service`, `chart-service`), ML (`experiment-service`, `inference-service`, `pipeline-orchestrator`), agentic (`agent-runtime`, `ai-gateway`, `tool-plane`, `memory-service`), platform (`realtime-hub`, `notification-service`, `eval-service`).
- **Data & infra plane** — Postgres (row-level-security per tenant), Redpanda/Kafka (event backbone), Redis (projections, rate limits, sessions, realtime bus), MinIO (blobs), Iceberg + Trino (lakehouse), OPA (authorization), Vault (secrets), MLflow (model registry), Keycloak (IdP), Temporal (durable workflows), OpenSearch (case search), ClickHouse (analytics), OTel Collector (traces/metrics).

> **See:** `diagrams/01-system-architecture.drawio`

---

## 3. Service catalog

| Service | Port | Lang | Responsibility |
|---|---|---|---|
| `ui-web` | 3000 | TS/Next.js | The app. httpOnly session cookie, per-surface capability gating, realtime patching. |
| `bff-graphql` | 4000 | TS/Apollo | Single GraphQL surface for the browser; dataloaders, JWT passthrough, per-tenant scoping. |
| `identity-service` | 8301 | Go | Tenants, users, provisioning saga, token exchange (OBO/apikey/embed/**OIDC login**), JWKS. |
| `rbac-service` | 8302 | Go | Roles + action catalog; OPA policy source of truth; permission projection into Redis. |
| `ingestion-service` | 8303 | Py | Bring-in data (connections, file upload, streaming decode), decision write-back to SoR. |
| `dataset-service` | 8304 | Py | Dataset catalog, versions, rows, profiling, lineage; Iceberg-backed. |
| `realtime-hub` | 8305 / 8315 | Go | SSE/WS fan-out from Kafka; per-topic OPA authz; `run-status`, `list`, `chat`, `notifications`. |
| `agent-runtime` | 8306 | Py | The agent engine (LangGraph-style), proposals, transcripts, **SLM distillation control plane**. |
| `memory-service` | 8307 | Py | Agent memory / RAG grounding store. |
| `case-service` | 8308 | Go | Cases (row-anchored), disposition write-back, timeline, **evidence attachments (MinIO)**. |
| `tool-plane` | 8310 / 8311 | Go | Tool registry + MCP gateway; governed, OBO-authorized tool execution. |
| `ai-gateway` | 8312 | Py | Provider-agnostic LLM access; the **cost-aware model ladder** (rung selection + escalation). |
| `pipeline-orchestrator` | 8313 | Py | Data/ML pipelines on Temporal + Argo; scheduling. |
| `experiment-service` | 8314 | Py | Experiments, runs, model registry (MLflow-aligned), four-eyes promotion. |
| `inference-service` | 8316 | Py | Batch scoring jobs. |
| `query-service` | 8085 | Py | Governed SQL over the lakehouse (Trino / DuckDB pushdown). |
| `semantic-service` | 8086 | Py | Semantic models → physical query compilation. |
| `chart-service` | 8320 | Go | Chart/dashboard definitions, aggregation, cross-filter. |
| `usage-service` | 8321 | Go | Per-tenant cost/latency metering, budgets. |
| `audit-service` | 8322 | Go | Immutable audit log (WORM). |
| `notification-service` | 8323 | Go | In-app + webhook notifications, rules. |
| `eval-service` | 8324 | Py | Eval suites, scorers, gates, canaries — the promotion gate for models & agents. |

---

## 4. Cross-cutting foundations

### 4.1 Multitenancy & isolation
- **Tenant = the RLS wall.** Every Postgres table forces Row-Level Security keyed on `app.tenant_id` (set per transaction from the verified JWT). A workspace partitions data *within* a tenant; a group is a permission label.
- **No client-supplied tenant ever reaches a key.** Realtime topics, DB queries, and object keys are all re-keyed from the verified JWT (`<tenant>/<resource>`).

### 4.2 Identity & tokens
- Platform JWTs are **RS256**, `iss=identity.windrose.ai`, `aud=windrose`, minted only by identity-service (JWKS published for every verifier).
- Token exchanges: `/token/obo` (agent-on-behalf-of user), `/token/apikey`, `/token/embed` (shared-secret embed), `/token/agent` (SPIFFE), and **`/token/oidc`** (real interactive SSO — see §6.1).
- **BYO IdP:** a generic OIDC `IdentityProvider` adapter (discovery + JWKS verify) makes Keycloak/Okta/Auth0/Entra one config of the same path.

### 4.3 Authorization (RBAC + OPA)
- rbac-service owns the **action catalog** (`<service>.<resource>.<verb>`) and role→action bindings; it projects each principal's effective capabilities into Redis (`permissions_flat`).
- Every service authorizes per-request through an **OPA sidecar** over that projection — not JWT scopes. Two rego variants (canonical `data.perm` + input-projection) keep Go and Python services consistent.
- Capabilities are **workspace-scoped**; a service principal may hold an explicitly-scoped action (exact match, never `*`).

### 4.4 Realtime
- realtime-hub consumes Kafka, routes each envelope to a topic (`run-status:<urn>`, `list:<type>`, `proposal:<id>`, `notifications:<user>`, `chat:<session>`), and fans out over **SSE** (primary) / WS with per-topic OPA authz, Redis pub/sub cross-pod, and a replay ring for resume.
- The UI subscribes via a single-use ticket; a **bridge** translates each wire frame into a TanStack-Query cache patch, so status updates land without a refetch. (See §6.3.)

### 4.5 Observability
- OpenTelemetry tracing + RED metrics across all services (env-gated, dependency-free Python shim), exported to the OTel Collector; JSON structured logging.

---

## 5. The governed decision + learning loop (the differentiator)

This is the flow that makes Windrose "self-improving." It spans casework, agentic, and ML planes.

1. **Intake.** Data is ingested (connections / upload / streaming) → landed as a versioned **dataset** in the lakehouse. A **case** is created anchored to a real row `(dataset_urn, version, row_pk)` with a display projection + provenance.
2. **Reason.** An **agent** (agent-runtime) runs a governed graph: it retrieves grounding (memory/RAG), calls the **ai-gateway** which routes to the *capable model rung*, and may call governed **tools** (tool-plane, OBO-authorized).
3. **Propose, don't act.** The agent emits a **proposal** (a write-intent + rationale + affected URNs + predicted effect), never a direct mutation. It's captured with full provenance.
4. **Human decides (four-eyes).** A reviewer **approves / edits / rejects** in the inbox. Four-eyes prevents self-approval. On approval the write-back is executed (e.g. a disposition synced to the tenant's system of record via governed ingestion adapters).
5. **Capture the signal.** The whole exchange — inputs, grounding, proposed action, the human decision, and the *corrected* output on an edit — is written to a **transcript** (M1), PII-redacted, consent-gated.
6. **Curate.** Consented, decided transcripts curate into a **versioned SFT dataset** (M2): an edited proposal becomes a gold *input → corrected-output* pair; an approval becomes an accepted-action pair. Immutable, checksummed, per **archetype** (agent persona / task shape).
7. **Distill (GPU).** A **training job** (M3) LoRA-fine-tunes a small open student on the archetype's SFT dataset → a candidate **adapter** registered in MLflow.
8. **Gate & promote.** The candidate must pass its archetype's **eval suite** (eval-service); an admin then **promotes** it (M4) as the ** bottom rung** of the tenant's ai-gateway ladder, with a confidence-based escalation threshold. Rollback = demote the rung.
9. **Save & repeat.** usage-service tracks the per-tenant spend/latency the new rung saves; rising escalation triggers **retrain** (M5). The loop closes.

> **Design note (honesty):** M1–M2 are built and live-verified; the **M3 control plane** (jobs, adapters, promotion lifecycle, archetypes, GPU node pools) is built and unit-tested, with the actual **GPU LoRA compute behind a typed port** (`GpuTrainer`) that fails honestly (`GpuTrainerNotConfigured`) when no GPU executor is wired — a submitted job lands in `failed` with a clear reason, never a fabricated adapter. M4/M5 serving + retrain are the GPU-gated follow-ons.

> **See:** `diagrams/02-decision-learning-loop.drawio`

---

## 6. Key workflows

### 6.1 Real OIDC SSO login (BYO identity)
The web tier runs the OAuth **Authorization-Code + PKCE** dance; identity-service **verifies** and mints the session — signing stays server-side.

1. User clicks *Sign in with SSO* → `ui-web /api/auth/oidc/start` discovers the IdP, generates a PKCE verifier + state (httpOnly cookies), 302-redirects to the IdP authorize endpoint.
2. User authenticates at the IdP (Keycloak locally; Okta/Auth0/Entra in prod).
3. IdP redirects to `ui-web /api/auth/callback` with a code → the callback exchanges the code (with the PKCE verifier) at the IdP token endpoint → gets an **ID token**.
4. Callback POSTs the ID token to identity-service **`/token/oidc`**, which verifies it against the IdP's JWKS (discovery), resolves the Windrose user by email within the tenant, and mints the platform **session JWT** (`typ=user`, `iss=identity.windrose.ai`).
5. The session cookie is set; the user lands authenticated. Downstream authorization runs off the RBAC projection.

**Embed federation (`/token/embed/oidc`):** the same verify path mints a *per-user, workspace-scoped embed token* from the end user's OIDC ID token (no shared secret) for an embedded Windrose surface, carrying `embed`/`surface`/`frame_ancestors` from the tenant's embed config.

> **See:** `diagrams/03-oidc-login-sequence.drawio`

### 6.2 Governed agent decision → write-back
See §5 steps 2–4. Key guarantees: proposals are inert until approved; four-eyes; tool calls are OBO-authorized and a downstream 4xx surfaces as a real failure (never a silent success); the write-back is a governed, proposal-mode SoR sync.

### 6.3 Realtime live status (no refresh)
1. A resource changes (dataset profiled, run status, case updated) → the owning service emits a Kafka envelope with `resource_urn`.
2. realtime-hub routes it to `run-status:<urn>` (detail pages) **and** additively to `list:<type>` (list pages), and fans out over SSE.
3. The UI's `useHubTopics` opens an SSE stream (via a single-use ticket), and a **bridge** translates each frame (`{event_type, payload, resource_urn}`) into the patcher contract, so the matching TanStack-Query cache row is patched in place — the status chip flips with **no refetch and no detail page open**.
4. Safe by design: patchers only mutate rows already in the caller's RBAC-scoped cache (no cross-workspace row insertion).

> **See:** `diagrams/04-realtime-live-status.drawio`

### 6.4 Case evidence
Attach/list/download real files on a case: a MinIO-backed blob store + case-service endpoints (multipart upload with a size cap, streamed download with `Content-Disposition`), gated by `case.evidence.*` capabilities, surfaced as an *Attachments* tab.

### 6.5 SLM distillation control plane
`POST /training-jobs` (against a versioned SFT dataset) → track lifecycle → `POST /slm-adapters/{id}/promote` (eval-gated) / `demote`. GPU compute behind the honest `GpuTrainer` port; GPU node pools ship as **off-by-default, scale-to-zero** Terraform for GKE/AKS/EKS + a gated Helm training Job.

---

## 7. Testing strategy

The platform is verified at four levels — the rule is *real, no-fake, e2e-testable on a laptop*.

| Level | What | Where |
|---|---|---|
| **Unit** | Pure domain logic, state machines, adapters, rego policy parity | per-service `tests/` (Go `go test`, Py `pytest`, rego `opa test`) |
| **Contract** | BFF ↔ service shapes, dataloaders, envelope contracts | `bff-graphql/tests` (vitest) |
| **Live-stack E2E** | Real UI → real BFF → real 22 services → real infra, **nothing mocked** | `ui-web/tests-live/*.spec.ts` (Playwright) |
| **Scripted live** | Direct-to-service / hub SSE + publish proofs, learning-loop hero journey | `deploy/e2e/driver.py`, ad-hoc harness |

Live E2E has repeatedly surfaced real bugs that unit tests could not (a dead SSE→cache bridge, a `dueDate` 422, an assignee-directory RBAC gap, a model-URN separator that broke all inference). The suite runs against the booted local stack (`deploy/local/up.sh`), and CI runs the whole suite on every change.

---

## 8. Deployment & bring-your-own

- **Local:** `deploy/docker-compose.dev.yml` brings up the full infra plane; `deploy/local/up.sh` boots all services; per-service `restart_*.sh` helpers for fast iteration.
- **Cloud:** production Helm chart (`deploy/helm/windrose`) + Terraform for **AWS (EKS) / Azure (AKS) / GCP (GKE)**, credentials externalized.
- **BYO hardening (phased):** P1 OTel wiring · P2 secrets adapters (Vault/AWS-KMS/Azure-KV/GCP-KMS via a `SECRETS_BACKEND` switch) · P3 SIEM/audit export · P4 generic OIDC IdP + real login. Each pluggable behind an env switch; the honest ceiling (external cloud IdP / real GPU) is documented, not faked.
- **GPU (SLM):** optional scale-from-zero GPU node pools (tainted `nvidia.com/gpu`) + a gated training Job, all `terraform fmt` / `helm lint` clean without a GPU present.

---

## 9. Diagram index

| File | Diagram |
|---|---|
| `diagrams/01-system-architecture.drawio` | Service landscape across experience / control / domain / data planes |
| `diagrams/02-decision-learning-loop.drawio` | The governed decision + learning loop (intake → propose → decide → transcript → SFT → distill → cheaper rung) |
| `diagrams/03-oidc-login-sequence.drawio` | Real OIDC SSO login (PKCE) sequence |
| `diagrams/04-realtime-live-status.drawio` | Realtime live-status data flow (Kafka → hub → SSE → cache patch) |

---

*Generated as an engineering reference. The platform runs on real infrastructure; where a leg is genuinely gated (external cloud IdP, a provisioned GPU), it is flagged behind a typed boundary rather than stubbed.*
