# fhir-bridge (Go)

A **stateless FHIR R4 proxy** that gives platform agents governed access to
external FHIR backends (Epic / Cerner / OpenEMR / HAPI-class) **through the
tool-plane only**. Request in → resolve the tenant's backend config (Postgres,
RLS) → attach upstream auth (secret material from **Vault KV v2**) → forward
to the FHIR server → relay the response. **No PHI is stored** and **no
response bodies are logged** — only resource type, id, status, latency,
tenant and backend id. Inherits `docs/brd/00_MASTER_BRD.md`.

Two planes:

- **Admin plane** (`/api/v1/fhir-backends`, JWT-guarded, OPA `fhir.backend.*`
  actions): register / list / update / delete the tenant's FHIR servers, plus
  a `/test` connectivity probe (`GET {base_url}/metadata`). Secrets submitted
  here are written to Vault at
  `secret/data/tenants/<tenant>/fhir-backends/<id>` and **never** stored in
  Postgres (the row keeps only `vault_ref`).
- **MCP facade** (`POST /internal/v1/mcp/invoke`): the backend the tool-plane
  dispatcher federates to for `fhir.read_resource`, `fhir.search_resources`,
  `fhir.create_resource` and `fhir.update_resource`. Peer identity is the
  mesh-injected `X-Spiffe-Id` checked against `FHIR_FACADE_ALLOWED_SPIFFE`
  (**empty = fail closed 403**), and every call re-checks the effective human
  (`obo_sub`) against the real OPA sidecar for the mapped `fhir.resource.*`
  action — the backend never trusts the gateway.

Upstream auth methods: `none`, `bearer`, `basic`, `oauth2_client_credentials`
and `smart_backend_services` (SMART Backend Services / RFC 7523 — an RS384
client assertion with `iss=sub=client_id`, `aud=token_url`, signed with the
Vault-held private key). Minted access tokens are cached in-memory per backend
until expiry−60s. Guardrails: 30s timeout, 4 MiB response cap, resource
type/id grammar validation (no path traversal), and redirects off the
backend's host are refused.

## Run

```bash
# dev infra (do not edit the compose file)
docker compose -f ../../deploy/docker-compose.dev.yml up -d postgres redis opa

make build          # go build ./cmd/server
make test-unit      # unit tier (no infra; test doubles only)
make vet
make run            # runs the server (see env below)
```

### Environment

| Var | Default | Purpose |
|---|---|---|
| `LISTEN_ADDR` | `:8325` | HTTP listener |
| `DATABASE_URL` | — | **required**; `fhir_bridge` DB as the `fhirbridge_app` role (NOSUPERUSER NOBYPASSRLS so FORCE RLS binds) |
| `MIGRATE_DATABASE_URL` | `DATABASE_URL` | privileged role for migrations |
| `VAULT_ADDR` / `VAULT_TOKEN` | — | Vault KV v2 for backend secret material; unset + `REQUIRE_REAL_ADAPTERS=true` refuses to boot |
| `REQUIRE_REAL_ADAPTERS` | `false` | set in every real deploy: refuse to boot on any missing real adapter |
| `OPA_URL` | `http://localhost:8281` | authorization sidecar (MASTER-FR-012) |
| `REDIS_ADDR` | `localhost:6379` | rbac `permissions_flat` projection reads |
| `JWKS_URL` / `JWT_ISSUER` / `JWT_AUDIENCE` | — | RS256 verification (identity-service) |
| `FHIR_FACADE_ALLOWED_SPIFFE` | — | comma-separated SPIFFE allowlist for the MCP facade; **empty = facade disabled (fail closed)** |
| `RBAC_URL` / `REGISTER_SIGNING_KEY_PEM` / `REGISTER_SIGNING_KID` / `REGISTER_TENANT_ID` | — | deploy-time action-catalog registration; while pending/failed `/readyz` is 503 |

## Architecture (top 2 levels)

```
fhir-bridge/
├── cmd/server/            wiring (real adapters only)
├── internal/
│   ├── api/               chi router, JWT middleware, backend CRUD + probe, MCP facade, health
│   ├── authz/             action constants + manifest, real OPA sidecar client
│   ├── fhirclient/        outbound FHIR ops (read/search/create/update/metadata) + auth attachment + token cache
│   ├── register/          deploy-time rbac action-catalog registration
│   └── store/             pgx + Postgres RLS (fhir_backends), embedded migrations runner
├── migrations/            forward-only SQL (schema, RLS+FORCE, fhirbridge_app role)
├── api/openapi.yaml       admin-plane HTTP contract
├── Dockerfile             distroless/static (pure Go, CGO_ENABLED=0)
└── Makefile
```

## rbac actions

Registered at startup (RBC-FR-022), all tenant-scoped:
`fhir.backend.{create,read,list,update,delete}` (admin plane) and
`fhir.resource.{read,list,create,update}` (facade data plane). Seed bindings:
backend admin on **Admin**; resource read/list on **Case Analyst** and **Case
Manager**; resource create/update on **Case Manager**
(`services/rbac-service/seed/roles_actions.yaml`).

## Adapter inventory (every adapter is real; no runtime stubs)

| Capability | Real adapter | Where |
|---|---|---|
| OLTP + tenant isolation | PostgreSQL + **RLS (FORCE)**, non-superuser `fhirbridge_app` role | `internal/store`, `migrations/000002_rls`, `migrations/000003_app_role` |
| Secret material | **Vault KV v2** over real net/http (`X-Vault-Token`) | go-common `secrets`, wired in `cmd/server` |
| Upstream FHIR access | **real `net/http`** client — 30s timeout, 4 MiB cap, same-host-only redirects | `internal/fhirclient` |
| Upstream auth | bearer / basic / OAuth2 client-credentials / **SMART Backend Services RS384 (RFC 7523)** | `internal/fhirclient/auth.go` |
| Authorization | **OPA sidecar** over the Redis `permissions_flat` projection | `internal/authz/opa_client.go`, go-common `opaclient` |
| AuthN | **RS256 JWT** via go-common `authjwt` (JWKS/static) | go-common |
| Observability | metricsx RED metrics + OTel traces + structured slog | `internal/api`, `cmd/server` |

The only fakes are in-memory doubles inside `*_test.go` (unit tier) — never
reachable from `cmd/`.

## Test

```bash
make test-unit      # fhirclient (httptest FHIR + token endpoints, SMART assertion
                    # verification, size cap, traversal rejection, redirect refusal),
                    # facade (SPIFFE fail-closed, OPA re-check, tool dispatch,
                    # no-body-leak), CRUD (vault-not-postgres secret handling)
make race           # -race on the token cache
```
