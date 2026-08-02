<!-- converted from PLATFORM_CAPABILITIES.docx by tools/docs/docx_to_md.py -->
> **Converted from Word.** This is a point-in-time snapshot: figures in it were accurate on the date stated below and have not been re-verified against the current codebase. For counts that are checked continuously, see the root [`README.md`](../../README.md).

DATACERN AI

Platform Capability Catalog

Every capability, its owning service, and its delivery status.

Status: engineering reference

Scope: 22 services · 11 capability domains

Legend: Live = built & verified on the real stack · Gated = built behind a typed boundary, needs external infra

Date: 2026-07-17

# Contents

Datacern AI is a multi-tenant, governed decision-intelligence platform. Capabilities are grouped into eleven domains below; each row names the capability, the service(s) that own it, and its delivery status. Everything is built on real infrastructure — the single genuinely gated leg (GPU LoRA training) is flagged, not stubbed.

# 1. Identity, Tenancy & Access

Who the tenant is, how users sign in, and what each principal is allowed to do.

| Capability | Owning service(s) | Notes / status |
|---|---|---|
| Multi-tenant isolation | identity · rbac · (all) | Tenant = Postgres RLS wall on app.tenant_id; workspace partitions; group = permission label. Live |
| Tenant & use-case self-service | identity · ui-web · bff | Create/switch workspaces (use cases) from the top bar; idempotent, drift-free provisioning with a real first-admin. Live |
| Token exchange | identity-service | OBO, API-key, embed, agent (SPIFFE), and OIDC login. RS256, iss=identity.datacern.ai. Live |
| Real OIDC SSO login (BYO IdP) | identity · ui-web | Auth-Code + PKCE; generic OIDC adapter (discovery + JWKS) for Keycloak/Okta/Auth0/Entra. Live |
| RBAC + OPA authorization | rbac-service · (all) | Action catalog projected into Redis; per-request OPA authz (not JWT scopes); workspace-scoped caps. Live |
| RBAC self-service & read-back | rbac · ui-web | user→role, team→roles, user→groups; invite→group; persona role templates, clone-and-customize. Live |
| Immutable audit log (WORM) | audit-service | Tamper-evident record of governed actions. Live |
| Usage metering & budgets | usage-service | Per-tenant cost/latency metering with budgets. Live |

# 2. Data & Lakehouse

Bringing data in, versioning it, querying it, and writing decisions back out.

| Capability | Owning service(s) | Notes / status |
|---|---|---|
| Data ingestion | ingestion-service | Connections, streaming decode, and file upload (CSV/JSON/Parquet/Avro/XML). Live |
| Dataset catalog | dataset-service | Versions, rows, profiling, lineage; Iceberg-backed persistence. Live |
| Server-paged dataset browser | dataset · bff · ui-web | Real rows grid with full engine pushdown. Live |
| Governed SQL over the lakehouse | query-service | Real Trino adapter (direct Iceberg-REST) + DuckDB pushdown. Live |
| Semantic layer | semantic-service | Semantic models compiled to physical queries. Live |
| Decision write-back / SoR sync | ingestion-service | Governed proposal-mode outgoing adapters (db_upsert, http_post), four-eyes. Live |

# 3. Analytics & Visualization

Turning governed data into charts, dashboards, and drill-through actions.

| Capability | Owning service(s) | Notes / status |
|---|---|---|
| Chart & dashboard builder | chart-service · ui-web | Rich builder; many families incl. heatmap, metric, network graph. Live |
| Quick-chart a dataset | chart · dataset · bff | Warehouse-aggregated charts without a semantic model. Live |
| Dashboard cross-filtering | chart-service · ui-web | Interactive chart↔grid cross-filter. Live |
| Drill-through to action | chart · case · ui-web | “Create cases” directly from a dashboard chart. Live |
| Scheduled report subscriptions | notification · chart | Recurring dashboard report delivery. Live |

# 4. Casework

The human work surface: cases anchored to real data, with evidence and assignment.

| Capability | Owning service(s) | Notes / status |
|---|---|---|
| Row-anchored cases | case-service | Anchored to (dataset_urn, version, row_pk) with display projection + provenance. Live |
| Case worklist creation | case · bff · ui-web | Create cases from query/dataset rows. Live |
| Evidence attachments | case-service | Attach/list/download real files (MinIO), case.evidence.* gated. Live |
| Assignment & timeline | case · identity | Member-safe assignable-users directory, assign dialog, disposition write-back. Live |

# 5. Agentic & AI

The differentiator: agents propose, humans approve, every action is governed.

| Capability | Owning service(s) | Notes / status |
|---|---|---|
| Governed agent engine | agent-runtime | LangGraph-style graph; agents propose, never act; proposals inert until approved. Live |
| Agent roster (9) + meta-router | agent-runtime | Incl. A2A delegation router and autonomous ml-engineer agent. Live |
| Custom tenant agents | agent-runtime | Config over shared graph; per-agent toolsets enforced at proposal time. Live |
| Role-grounded copilot | agent-runtime · ui-web | Caller-capability-aware tools, per-module routing, persona prompts. Live |
| Provider-agnostic LLM access | ai-gateway | Multi-provider adapters; cost-aware model ladder (rung select + escalation); per-model pricing. Live |
| Governed tool execution | tool-plane | Tool registry + MCP gateway, OBO-authorized; downstream 4xx = real failure. Live |
| Agent memory / RAG grounding | memory-service | Grounding store for agent reasoning. Live |
| Verified-query knowledge layer | agent-runtime · bff · ui | OKF-style verified-query search wired into agents + UI. Live |
| Safety & governance controls | multiple + ui-web | Kill switches, promotion approval, memory erasure, authz-explain, anomaly review, compliance packs. Live |

# 6. ML Lifecycle & the Learning Loop

Pipelines, experiments, evaluation, and the correction→retrain loop that is the product.

| Capability | Owning service(s) | Notes / status |
|---|---|---|
| Data/ML pipelines | pipeline-orchestrator | Temporal + Argo; recurring scheduling; real dataset inputs. Live |
| Experiments & model registry | experiment-service | MLflow-aligned; four-eyes promotion; MLflow→experiment auto-mirror. Live |
| Batch inference/scoring | inference-service | Batch scoring jobs. Live |
| Eval suites, scorers & gates | eval-service | Promotion gate for both models and agents; scorers, canaries. Live |
| Transcript capture (M1) | agent-runtime | Inputs + grounding + proposed + human-corrected output; PII-redacted, consent-gated. Live |
| Versioned SFT datasets (M2) | agent-runtime | Curate decided transcripts into immutable, per-archetype gold pairs. Live |
| SLM distillation control plane (M3) | agent-runtime | Training jobs, adapters, promotion lifecycle, archetypes. Control plane Live |
| GPU LoRA training compute | agent-runtime + GPU pool | Behind typed GpuTrainer port; fails honestly (GpuTrainerNotConfigured) with no GPU. Gated |
| Promote SLM as cheapest rung (M4/M5) | ai-gateway · eval | Eval-gated promote/demote; retrain on drift. Serving path Gated |

# 7. Realtime & Notifications

Live status without refresh, and event delivery to users and systems.

| Capability | Owning service(s) | Notes / status |
|---|---|---|
| Live status without refresh | realtime-hub · ui-web | Kafka→hub→SSE→cache-patch bridge; per-topic OPA authz, Redis pub/sub, replay ring. Live |
| Topic schemes | realtime-hub | run-status, list:<type> (tenant-wide), chat, agent_run, proposal, notifications. Live |
| Notifications + webhooks | notification-service | In-app + webhook delivery with rules. Live |

# 8. Decision-Intelligence Governance

Governing decision logic itself, and measuring whether decisions worked.

| Capability | Owning service(s) | Notes / status |
|---|---|---|
| Governed decision tables | agent-runtime · ui-web | No-code rules → same four-eyes proposal path; batch-evaluate; /decisions UI; pack-artifact. Live |
| Outcome monitoring | case · experiment | Realized-outcome labels joined to proposal provenance; decided-vs-realized effectiveness. Live |

# 9. Embedding & White-Label

Delivering Datacern surfaces inside a customer’s own product.

| Capability | Owning service(s) | Notes / status |
|---|---|---|
| Iframe / white-label embedding | identity · ui-web | Embed-token exchange, headless dashboard route, per-tenant frame-ancestors, theming, postMessage SDK. Live |
| Embed-federated OIDC | identity-service | Per-user embed tokens minted from the tenant’s IdP id_token (no shared secret). Live |
| Branding | ui-web | Logo, tenant-name display, pre-login marketing/welcome page. Live |

# 10. Vertical Packs

Verticals ship as packs on top of a frozen, vertical-agnostic Core.

| Capability | Owning service(s) | Notes / status |
|---|---|---|
| Pack framework | packctl · packs/ | 8-step invariant against a frozen Core (zero Core changes). Live |
| ~20 vertical packs | packs/ · all tenants | BRDs 24–51 authored + installed across 20+ tenants (claims, disputes, …). Live |
| Multi-tenant install tooling | packctl · scripts | Batch onboard / cleanup, per-role users for manual testing. Live |

# 11. Platform Engineering & Operations

How the platform is deployed, observed, secured, and kept honest.

| Capability | Owning service(s) | Notes / status |
|---|---|---|
| Cloud deployment | helm · terraform | Production Helm chart + Terraform for AWS (EKS) / Azure (AKS) / GCP (GKE). Live |
| Local dev stack | docker-compose · up.sh | Full infra plane + all services; per-service restart helpers. Live |
| BYO hardening (phased) | py/go-common · helm | OTel wiring, secrets adapters (Vault/AWS/Azure/GCP), SIEM export, generic OIDC. External IdP/SIEM egress Gated |
| Observability | all services · OTel | OpenTelemetry tracing + RED metrics across ~20 services; JSON structured logging. Live |
| Stability self-heal | deploy/local | reconcile.sh rebuilds RBAC projections after cold-Redis restarts. Live |
| Security baseline | CI | 5-tool scanning + CI gates. Live |
| Testing (4 levels) | per-service · ui-web · CI | Unit, contract, live-stack E2E (nothing mocked, Playwright), scripted live; full suite on every change. Live |
| GPU node pools | terraform · helm | Optional scale-from-zero GPU pools + gated training Job; clean without a GPU present. Gated |

| Honesty note The platform holds to a real, no-fake rule. The one genuinely gated capability is GPU LoRA training compute: the control plane (jobs, adapters, promotion, archetypes) is built and unit-tested, but actual training fails cleanly with GpuTrainerNotConfigured when no GPU executor is wired — never a fabricated adapter. External cloud IdP and SIEM egress are wired behind env switches; the point where customer infrastructure must be brought is documented, not stubbed. |
|---|
