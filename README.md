# Datacern

Multi-tenant, multi-cloud, **agentic-AI-native** ML platform for governed
insurance-claims decisioning. Built as ~23 independently-deployable services
behind one GraphQL BFF and one web app, with a governance fabric (RLS tenancy,
RBAC/OPA, four-eyes proposals, immutable audit) woven through every plane.

- Architecture: [`docs/platform/PLATFORM_ARCHITECTURE.md`](docs/platform/PLATFORM_ARCHITECTURE.md)
- Service specs (BRDs): [`docs/brd/`](docs/brd/) — start with [`00_MASTER_BRD.md`](docs/brd/00_MASTER_BRD.md)
- Feature design notes: [`docs/design/`](docs/design/)
- Repo-specific engineering rules: [`CONVENTIONS.md`](docs/platform/CONVENTIONS.md) · agent workflow: [`AGENTS_GUIDE.md`](docs/platform/AGENTS_GUIDE.md)

## Services

Each service has its own `README.md` with run instructions, architecture, an
adapter/stub inventory, and FR/AC traceability. `deploy/services.yaml` is the
single source of truth for the CI build/test matrix and the Helm chart.

### Platform & control plane

| Service | Lang | Port | What it owns |
|---|---|---|---|
| [identity-service](services/identity-service/README.md) | Go | 8301 | Tenants, users, agent principals, OBO tokens, JWKS (root of trust) |
| [rbac-service](services/rbac-service/README.md) | Go | 8302 | Workspaces, groups, roles, grants, the `permissions_flat` projection |
| [audit-service](services/audit-service/README.md) | Go | 8322 | Immutable, hash-chained audit log — who did what, when |
| [usage-service](services/usage-service/README.md) | Go | 8321 | Metering, cost attribution, budget enforcement |
| [notification-service](services/notification-service/README.md) | Go | 8323 | Event → human/external fan-out (email, webhooks) |
| [realtime-hub](services/realtime-hub/README.md) | Go | 8305 | Single push channel to browsers (SSE primary, WebSocket) |

### Data plane

| Service | Lang | Port | What it owns |
|---|---|---|---|
| [ingestion-service](services/ingestion-service/README.md) | Py | 8303 | Source connections + streaming ingestion jobs |
| [dataset-service](services/dataset-service/README.md) | Py | 8304 | Datasets, versions (Iceberg), profiles, lineage |
| [query-service](services/query-service/README.md) | Go | 8085 | SQL execution broker (saved queries, typed params) |
| [semantic-service](services/semantic-service/README.md) | Py | 8086 | Governed per-workspace semantic layer |
| [chart-service](services/chart-service/README.md) | Go | 8320 | Dashboards and charts |

### ML plane

| Service | Lang | Port | What it owns |
|---|---|---|---|
| [experiment-service](services/experiment-service/README.md) | Py | 8314 | Experiments, runs, registered models, governed promotion |
| [pipeline-orchestrator](services/pipeline-orchestrator/README.md) | Py | 8313 | Training / retrain pipelines (the learning loop) |
| [inference-service](services/inference-service/README.md) | Py | 8316 | Batch inference / scoring against registered models |
| [eval-service](services/eval-service/README.md) | Py | 8324 | Versioned golden datasets + scorer framework |

### Agentic plane

| Service | Lang | Port | What it owns |
|---|---|---|---|
| [agent-runtime](services/agent-runtime/README.md) | Py | 8306 | Agent graphs, runs, proposal emission |
| [ai-gateway](services/ai-gateway/README.md) | Py | 8312 | The single choke point for every LLM/embedding call |
| [memory-service](services/memory-service/README.md) | Py | 8307 | Governed, scoped agent memory + retrieval |
| [tool-plane](services/tool-plane/README.md) | Go | 8310/8311 | Tool registry + MCP gateway (two deployables, one context) |

### Casework, packs & edge

| Service | Lang | Port | What it owns |
|---|---|---|---|
| [case-service](services/case-service/README.md) | Go | 8308 | Row-reference triage cases + lifecycle |
| [pack-service](services/pack-service/README.md) | Py | 8309 | Governed in-cluster capability-pack install service |
| [bff-graphql](services/bff-graphql/README.md) | Node | 4000 | The single GraphQL endpoint for ui-web |
| [ui-web](services/ui-web/README.md) | Node | 3000 | The web application |

## Repository layout

```
Datacern_AI_V0.1/
  services/       one directory per service (see the tables above)
  libs/           shared libraries (go-common, py-common)
  packs/          capability packs (vertical bundles) + packctl (materializer CLI)
  deploy/
    services.yaml           source of truth for CI matrix + Helm chart
    docker-compose.dev.yml  local dev infrastructure
    local/                  up.sh / down.sh — boot the full stack locally
    e2e/                    end-to-end journey driver
    terraform/, helm/       per-cloud (AWS/GCP/Azure) deploy
  docs/           brd/ (service specs), design/ (feature notes), platform/ (architecture)
  Makefile
```

## Local development

```bash
make dev-up        # start Postgres, Redis, Redpanda (Kafka), Keycloak, Temporal, OTel, MinIO, …
make dev-down
make test          # run all service test suites
```

Boot the full application stack (all services + BFF + UI, seeded, real local
Ollama for LLM inference) with `deploy/local/up.sh` (and `down.sh` to tear down).
Each service is also independently runnable — see its own `README.md` + `Makefile`.

## Conventions

Every service implements the shared requirements in
[`docs/brd/00_MASTER_BRD.md`](docs/brd/00_MASTER_BRD.md): tenancy/RLS, JWT claims,
the URN scheme `wr:<tenant>:<service>:<type>/<id>`, the error envelope, cursor
pagination, outbox events, and OTel. Repo-specific rules live in
[`CONVENTIONS.md`](docs/platform/CONVENTIONS.md).

## Build status

The platform has grown well past the original 22 Core services (BRDs 01–22): all
23 services above are built, and capability delivery now extends through the
vertical packs and later BRDs (24–56 — ML-engineer agent, custom agents, decision
modeling, outcome monitoring, entity resolution, and the pack ecosystem). See
[`docs/brd/`](docs/brd/) for the current spec set and [`docs/design/`](docs/design/)
for feature design notes.

The release-gating end-to-end journey lives in [`deploy/e2e/`](deploy/e2e/) and
the live-stack Playwright suite in `services/ui-web/tests-live/` — both exercise
the real stack (RS256 JWTs, OPA, MinIO/Iceberg, OpenSearch, Postgres RLS,
Redpanda, a real local Ollama, Temporal), no mocks. CI (`.github/workflows/ci.yml`)
runs per-service test/lint/build derived from `deploy/services.yaml`.
