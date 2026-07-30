# Datacern — Layered Technical Architecture

*Prepared for investor and SI diligence · 2026-07-30 · grounded at commit `54cfe2d`*

**Diagram:** [`diagrams/layered-architecture.svg`](diagrams/layered-architecture.svg)

Every claim in this document is traceable to code in this repository, and the
layer-by-layer counts and behaviours were verified by execution on 2026-07-30
(3,029 tests green across all 23 services; two live workflow proofs). The
execution record, including what could *not* be verified locally, is
[`../DATACERN_LOCAL_EVALUATION_EVIDENCE_2026-07-30.md`](../DATACERN_LOCAL_EVALUATION_EVIDENCE_2026-07-30.md).

---

## 1. What the platform is, in one paragraph

Datacern is a governed agentic-AI decisioning platform: AI agents read a
tenant's own data, draft decisions, and **propose** actions — and a human
approval chokepoint, cryptographic execution grants, and a tamper-evident audit
chain stand between every agent and every consequential write. It ships as 23
containerized services in three languages, with 28 vertical solution packs
(card disputes, AML, payer claims, pharmacovigilance, …) that configure the
same platform spine for a specific regulated workflow.

## 2. The layers

### 2.1 Experience & interop
| Component | Role |
|---|---|
| `ui-web` (Next.js) | Copilots, HITL approval queues, dashboards, guided demo walkthrough |
| `bff-graphql` | The single governed API surface the UI talks to |
| `tool-plane` (`mcp-gateway`, `tool-registry`) | MCP/A2A interop — *external* agents call governed tools and hit the same proposal chokepoint as internal ones |

### 2.2 Vertical solution packs (28)
Each pack is declarative content — ontology, agents, decision definitions,
dashboards, labels, memories, and a demo bundle — installed onto the platform
spine by `pack-service`, gated on a `pack_sku` entitlement. The fleet is linted
offline by `packctl` (manifest validation, deep lint, and C1–C11 cross-file
coherence: **28 packs + 4 demo bundles, 0 errors** on 2026-07-30). Pack
controls are mapped to EU AI Act, NIST AI RMF, and ISO/IEC 42001.

### 2.3 AI / agent plane
| Component | Role |
|---|---|
| `agent-runtime` | LangGraph agent graphs; the meta-router classifies intent across 7 routable agents with confidence gating — uncertain routes are *labelled* and clamped to the read-only analytics agent (verified live: 11/11 routing cases, including injection and off-list defenses) |
| `ai-gateway` | Multi-provider LLM broker (Anthropic API, Bedrock, Vertex as configured) with semantic cache, token budgets, and cost metering in front of every call |
| `memory-service` | RAG over pgvector + OpenSearch; answers carry their grounding evidence |
| `eval-service` | Groundedness judging, replay scoring, agent-inventory export for AI-governance audits |

Design invariant: **no agent writes directly.** An agent's write becomes a
Proposal; the four-eyes flow in `case-service` approves or rejects it;
self-approval is rejected; approval mints an RS256-signed execution grant, and
execution without a valid grant is refused.

### 2.4 ML plane
| Component | Role |
|---|---|
| `pipeline-orchestrator` | Validates/compiles DAGs (to Argo Workflows manifests), executes training. Runs are **lease-held** with orphan recovery, so autoscaled compute can't strand a run. Resource-derived row budgets refuse oversized training sets instead of silently truncating — provenance is never fabricated |
| `experiment-service` | Experiment lifecycle, MLflow mirror, four-eyes model promotion |
| `inference-service` | Batch scoring, streamed in chunks — peak memory tracks chunk size, not dataset size |
| MLflow 3.x | Tracking + model registry; outcomes are read back from the registry, never assumed from exit codes |

Verified live on 2026-07-30: a real model trained through the HTTP API and
registered in a real MLflow registry, then read back independently.

### 2.5 Data & analytics plane
| Component | Role |
|---|---|
| `ingestion-service` | Connectors, Temporal-backed workflows, schema mapping, two-phase Iceberg commits |
| `dataset-service` | Versioned datasets, DuckDB browse, parquet on object store |
| `semantic-service` | Governed metrics layer — the only vocabulary the analytics agent may answer with |
| `query-service` | Trino federation; enforces tenant suspension |
| `chart-service` | Validated chart specs and dashboards |

### 2.6 Governance & trust plane (cross-cutting)
`case-service` (four-eyes chokepoint) · `rbac-service` + OPA (policy-as-code
at every service edge) · `audit-service` (tamper-evident hash chain, WORM
archive) · `notification-service` · `realtime-hub` (WebSocket fan-out with
per-connection backpressure).

### 2.7 Platform core & commercial plane
`identity-service` (tenants, RS256 JWT, Keycloak SSO, quotas) ·
`usage-service` (metering, budgets, provider-bill reconciliation, ROI rollups)
· commercial plane (plans, five entitlement kinds, trial sweep with read-only
degradation) · `pack-service` · demo/POC plane (self-service demo tenants,
sandbox reaper, POC success-tracking).

### 2.8 Infrastructure backbone (all open-source)
PostgreSQL 16 + pgvector (FORCE ROW LEVEL SECURITY) · Kafka/Redpanda
(transactional outbox — nothing publishes before its DB commit) · Redis ·
S3/MinIO · Iceberg + Trino lakehouse · ClickHouse · OpenSearch · Temporal ·
Keycloak · OPA · Vault · MLflow · OpenTelemetry + Tempo. No proprietary
stateful dependency — this is what makes the platform cloud-portable (§ the
deployment document).

## 3. Trust invariants — enforced in code, not policy documents

1. Every agent write is a Proposal through the four-eyes chokepoint; self-approval is rejected.
2. Approval mints an RS256-signed execution grant; execution without one is refused.
3. Every state change lands in a tamper-evident audit hash chain with WORM archival.
4. Tenant isolation is Postgres-enforced (`FORCE ROW LEVEL SECURITY`) and fail-closed at boot (`DB_REQUIRE_NONSUPERUSER=true` refuses a role that could bypass RLS).
5. Uncertain AI output is labelled and clamped to read-only — the router never promotes a guess to a decision, training refuses oversized data rather than silently truncating, and scoring refuses lossy type drift rather than recording predictions the model never made.
6. Production boots fail closed on any in-memory/fake adapter (`REQUIRE_REAL_ADAPTERS=true`).

## 4. Verification status (honest)

- **Executed locally/CI (2026-07-30):** all unit tiers (3,029 tests), live train-to-registry, live 11-case routing proof, pack fleet coherence.
- **CI-gated (live infra):** Postgres RLS integration tiers, Kafka relay, MinIO, MLflow server, e2e stack.
- **Infra-gated (not yet exercised):** Argo Workflows on a real cluster; the AWS/GCP/Azure Terraform paths (shipped and reviewed, but no cloud credentials in the evaluation sandbox); real LLM completions (exercised behind the gateway seam).
