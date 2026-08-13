# Datacern

Multi-tenant, multi-cloud, **agentic-AI-native** ML platform for governed decisioning. Built as ~25 independently-deployable services
behind one GraphQL BFF and one web app, with a governance fabric (RLS tenancy,
RBAC/OPA, four-eyes proposals, immutable audit) woven through every plane.


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
| [tool-registry](services/tool-plane/README.md) | Go | 8310 | Tool catalog, versions, tenant enablement, BYO submissions |
| [mcp-gateway](services/tool-plane/README.md) | Go | 8311 | The MCP server every agent tool call passes through (spec `2025-06-18`) |

### Casework, packs & edge

| Service | Lang | Port | What it owns |
|---|---|---|---|
| [case-service](services/case-service/README.md) | Go | 8308 | Row-reference triage cases + lifecycle |
| [pack-service](services/pack-service/README.md) | Py | 8309 | Governed in-cluster capability-pack install service |
| [bff-graphql](services/bff-graphql/README.md) | Node | 4000 | The single GraphQL endpoint for ui-web |
| [ui-web](services/ui-web/README.md) | Node | 3000 | The web application |

