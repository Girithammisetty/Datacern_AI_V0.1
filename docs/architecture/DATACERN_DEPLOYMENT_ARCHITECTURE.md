# Datacern — Deployment Architecture (AWS · GCP · Azure · Hetzner)

*Prepared for investor and SI diligence · 2026-07-30 · grounded at commit `54cfe2d`*

**Diagrams:**
[`diagrams/deploy-aws.svg`](diagrams/deploy-aws.svg) ·
[`diagrams/deploy-gcp.svg`](diagrams/deploy-gcp.svg) ·
[`diagrams/deploy-azure.svg`](diagrams/deploy-azure.svg)

This document describes the **shipped** deployment surface — the Terraform and
Helm that exist in this repository today (`deploy/terraform/{aws,gcp,azure,hetzner}`,
`deploy/helm/datacern`, `deploy/k8s/data-tier`) — not an aspirational target.
Where something is infra-gated (shipped but not yet exercised against a live
cloud), it says so.

---

## 1. Deployment model in one paragraph

Every service is a container; every stateful dependency is open-source. One
Helm umbrella chart deploys all 25 services plus the in-cluster platform tier;
one Terraform stack per cloud provisions the managed substrate (Kubernetes,
Postgres, Kafka, Redis, object store, secrets, registry, networking). Moving
clouds means a different `terraform` directory and a different
`values-<cloud>.yaml` — the services do not change. A Hetzner stack is included
for cost-sensitive / EU-sovereignty deployments, and the same images run in the
docker-compose parity stack used for dev and CI.

## 2. Environment tiers

| Tier | Stack | Status |
|---|---|---|
| dev / CI | `deploy/docker-compose.dev.yml` — pgvector 16, Redpanda, Redis, MinIO, Keycloak, Temporal, Trino 482, Iceberg REST, OPA, Vault, MLflow 3.14, OpenSearch, ClickHouse, otel + Tempo, Mailpit | **Executed** — this is where the 3,029-test evidence run and the e2e stack run |
| self-hosted k8s | `deploy/k8s/data-tier` (kustomize) + Helm chart | Shipped; exercised in cluster-based staging |
| AWS / GCP / Azure / Hetzner | `deploy/terraform/<cloud>` + `helm -f values-<cloud>.yaml` | **Shipped IaC, infra-gated** — reviewed code, not yet applied from the evaluation sandbox (no cloud credentials there) |

## 3. What runs where

**In the cluster, every cloud (open-source, no lock-in):** the 23 Datacern
services (one Deployment each, HPA-autoscaled, NetworkPolicy-segmented), plus
OPA, Keycloak 26, Temporal 1.25, MLflow 3.x, Trino 482 + Iceberg REST catalog,
ClickHouse (optional HA StatefulSet + Keeper), OpenSearch (where not managed),
OpenTelemetry collector + Tempo. Migrations run as Helm jobs
(`migrate-job.yaml`); heavy training runs as Jobs on a dedicated GPU pool
(`training-job.yaml`). The Argo Workflows *server* is an infra-gated add-on —
the orchestrator ships the submit/watch/terminate client and lease-based
recovery; installing the server is a deploy-time choice.

**Managed per cloud (Terraform):**

| Concern | AWS (`terraform/aws`) | GCP (`terraform/gcp`) | Azure (`terraform/azure`) |
|---|---|---|---|
| Kubernetes | EKS (`eks.tf`) | GKE private cluster (`gke.tf`) | AKS (`aks.tf`) |
| PostgreSQL (system of record, FORCE RLS) | RDS (`rds.tf`) | Cloud SQL (`cloudsql.tf`) | PostgreSQL Flexible Server (`postgres.tf`) |
| Kafka (event backbone, outbox relay) | MSK, SCRAM (`msk.tf`) | Managed Service for Apache Kafka (`kafka.tf`) | Event Hubs — Kafka protocol (`eventhubs.tf`) |
| Redis (dedup, cache, leader election) | ElastiCache (`elasticache.tf`) | Memorystore (`memorystore.tf`) | Azure Cache for Redis (`redis.tf`) |
| Object store (datasets, models, audit archive, Iceberg tables) | S3 — versioned, SSE, public-access-blocked (`s3.tf`) | GCS (`gcs.tf`) | Blob Storage (`storage.tf`) |
| Search (RAG + audit) | OpenSearch Service (`opensearch.tf`) | in-cluster OpenSearch | in-cluster OpenSearch |
| Registry | ECR + lifecycle (`ecr.tf`) | Artifact Registry | ACR (`acr.tf`) |
| Secrets & keys | Secrets Manager + KMS (`secrets.tf`) | Secret Manager + Cloud KMS (`secretmanager.tf`) | Key Vault (`keyvault.tf`) |
| Workload identity | IRSA (`iam.tf`) | Workload Identity (`iam.tf`) | Federated identity credentials (`identity.tf`) |
| Network | VPC + SGs (`vpc.tf`) | VPC + Cloud Router/NAT (`network.tf`) | VNet + **Private Endpoints + Private DNS** (`network.tf`) |
| GPU training pool (opt-in, scales to zero) | `eks.tf` (`enable_gpu_training_pool`, g5 → p4d) | `gpu_training_pool.tf` | `gpu_training_pool.tf` |
| Logs/metrics | CloudWatch + in-cluster Prometheus/Grafana/Tempo | Cloud Logging + in-cluster stack | Log Analytics + in-cluster stack |

Secrets flow: External Secrets Operator (`templates/externalsecret.yaml` +
`secrets_backend.tf` per cloud) syncs the cloud secret store into the cluster —
no secrets in images or values files.

LLM providers: agents never call a model directly; `ai-gateway` brokers
Anthropic API / Bedrock / Vertex (per-tenant config) with semantic caching,
token budgets, and cost metering. On Azure, Anthropic is reached via API
through the same gateway seam.

## 4. Production posture (encoded in the chart, not in a runbook)

- `REQUIRE_REAL_ADAPTERS=true` — a service that would boot on an in-memory/fake adapter **exits** instead.
- `DB_REQUIRE_NONSUPERUSER=true` — a database role that could bypass RLS fails the boot; tenant isolation cannot be silently disabled by a wrong connection string.
- Images are tagged by commit SHA in CI; Helm pins `global.imageTag` at deploy.
- Pipeline runs are lease-held with orphan recovery (migration 0004) — cluster autoscaling and spot/preemptible node loss cannot strand a run in `running` or double-train a model.
- Batch scoring streams in bounded chunks; training refuses datasets beyond the node's declared memory budget rather than silently truncating.

## 5. Honest status

- The four cloud stacks are **shipped, reviewed IaC** — they have not been applied from the evaluation sandbox (it has no cloud credentials), so no claim is made here that a specific cloud deployment has been executed end-to-end.
- The tier that *is* executed continuously (local/CI) runs the same images and the same service code against protocol-identical open-source infrastructure — that parity is the basis for the portability claim.
- Sizing, HA topology (multi-AZ Postgres, Kafka broker counts, ClickHouse replicas) are variable-driven in the Terraform/values files; the defaults are development-grade and would be reviewed per customer environment.
