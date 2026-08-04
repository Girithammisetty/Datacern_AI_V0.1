# Test coverage matrix — layers × workflows × tiers

Date: 2026-08-04 · Companion to `DATACERN_STATUS_CHECKPOINT.md` (the evidence
ledger) and `DATACERN_DEMANDING_CUSTOMER_CHECKPOINT.md` (the production gate).

This matrix answers one question the ledger's prose does not tabulate: **for
every layer and every user-facing workflow, which test tier covers it, and has
that tier ever executed?** It is the map the `validate-platform` orchestrator
walks.

## How to read it

Tiers, cheapest to most complete:

| Tier | What it proves | Cost |
|---|---|---|
| **unit** | one function/module in isolation | free, in CI |
| **integration** | one service against real infra (Testcontainers/live Postgres/Kafka) | free, in CI |
| **contract-e2e** | real Next app + real BFF against a contract server (`pnpm e2e`) | free, every PR |
| **journey** | scripted API arc on the FULL live stack, real Ollama (`make journey*`) | free (local model), path-gated CI |
| **live-ui** | Playwright against the running stack (`pnpm e2e:live`) | free, path-gated CI |
| **soak/load** | restart survival, volume, concurrency (`make soak*`, `load_test.py`) | free, not yet in CI |

Status: **PROVEN** (executed on the real stack, recorded) · **TESTED**
(unit/integration green, never live) · **PENDING** (spec authored, not yet
executed live) · **NONE** (no e2e at any tier).

**Every tier above costs zero LLM API tokens.** The journeys that exercise
agents call the platform's own ai-gateway, which the test stack routes to a
local Ollama model — not a paid endpoint. The only token-costed idea (an
LLM-driven adversarial explorer) is explicitly out of this suite.

## The orchestrator

`make validate-platform` (→ `deploy/e2e/validate_platform.py`) runs every tier
below against a live stack in dependency order and writes one machine-readable
artifact — `deploy/evidence/validation-report.{json,md}`. The nightly
`validate-platform` workflow uploads it. Its own logic is self-tested with no
stack (`--self-test`). An all-skipped run (stack down) reports **INCONCLUSIVE**,
never PASS.

## Layer coverage

| Layer | Owner services | Unit/Integration | Live e2e | Status |
|---|---|---|---|---|
| Identity / tokens / trial | identity-service | ✅ deep | smoke + indirect | PROVEN (core) |
| RBAC / OPA authorization | rbac-service + all | ✅ deep (opa-parity, projection) | journey + probe | PROVEN |
| Multi-tenant RLS isolation | all | ✅ per-service `*rls_isolation*` | `security-probe` (4–6 of 24 svcs) | PROVEN (partial breadth) |
| Ingestion + watermark/delta | ingestion-service | ✅ | journey (`e2e`, `-streams`) | PROVEN |
| Lakehouse (Iceberg) + delta browse | dataset-service | ✅ (+ new delta tests) | journey | PROVEN / TESTED (delta) |
| Query over lakehouse | query-service | ✅ (DuckDB/Trino router) | **PENDING** (`query-journeys`) | NONE→PENDING |
| Case engine + governed writes | case-service | ✅ | journey + live-ui | PROVEN |
| Agentic plane (propose→approve) | agent-runtime | ✅ 377 unit + real-LLM integ | journey + contract-e2e | PROVEN |
| Tool governance (MCP, grants) | tool-plane | ✅ + real-infra | journey (`e2e` step E) | PROVEN |
| FHIR connectivity | fhir-bridge | ✅ 36 unit | journey (`journey-fhir`, now in CI) | TESTED → live pending |
| ML plane (train/promote/infer) | experiment/inference | ✅ | journey (`-learn`) + live-ui | PROVEN |
| Memory / RAG | memory-service | ✅ (schema-per-tenant) | journey (pgvector chunk) | PROVEN (partial) |
| Realtime transport (SSE/WS) | realtime-hub | ✅ + service-e2e | contract-e2e + journey | PROVEN |
| Packs framework | pack-service | ✅ | journey (`-packs`) | PROVEN |
| Commercial / billing / usage | usage-service | ✅ (fake Stripe) | **NONE live** | TESTED |

## Workflow coverage (user-facing)

| Workflow | Tier that covers it | Status |
|---|---|---|
| Login → case → copilot → approve | contract-e2e (`journey.spec.ts`) + live-ui | PROVEN |
| Ingest → dataset → triggers open cases | journey | PROVEN |
| AI proposes → human approves → row changes | journey (`test_governed_write_loop`) | PROVEN |
| Realtime case streams + dept isolation | journey (`-streams`) | PROVEN |
| Learn flywheel end to end | journey (`-learn`) + live-ui hero | PROVEN |
| Schema-driven forms | journey (`-forms`) | PROVEN |
| Pack install / drift / uninstall | journey (`-packs`) | PROVEN |
| Governed FHIR read + proposal-gated write | journey (`-fhir`) | TESTED → live pending |
| Cases CRUD / assign / timeline / RBAC | live-ui (`cases-journeys`) | PROVEN |
| Data pipeline lifecycle | live-ui (`data-pipeline-journeys`) | PROVEN |
| Experiments / model promotion | live-ui (`ml-journeys`) | PROVEN |
| Value / ROI reporting | live-ui (`value-journeys`) | PROVEN (ran unskipped 2026-08-03) |
| Agent Control Tower fleet | live-ui (`agent-fleet-journeys`) | PENDING (un-fixme'd; live pending) |
| Demo sandbox create/reset | live-ui (`demo-journeys`) | PENDING (fixture unblocked; live pending) |
| Dashboard build / cross-filter / drill-through | live-ui (`dashboards-journeys`) | PENDING (authored) |
| Governed decision tables (`/decisions`) | live-ui (`decisions-journeys`) | PENDING (authored / fixme-tracked) |
| Governed SQL query execution | live-ui (`query-journeys`) | PENDING (authored) |
| Cross-tenant isolation attack | `security-probe` | PROVEN (partial breadth) |
| 9-agent roster over real chat path | `test_agents_chat.py` (in orchestrator) | PROVEN (matrix) |
| Restart survival / volume / concurrency | soak / load | **never in CI** (1 local run each) |
| OIDC SSO (BYO IdP) / SAML | — | NONE |
| Iframe / white-label embed | — | NONE |
| Tenant offboarding (export + purge + erase) | — | NONE (delete without purge) |
| Scheduled report subscriptions | — | NONE |

## Standing gaps this suite makes visible (not yet closed)

These remain NONE even after this pass — tracked here so they cannot hide:

1. **Concurrency/load numbers** — `load_test.py` is now in the orchestrator but
   has never run against a stack; no p95 exists.
2. **Soaks in CI** — wired into the orchestrator; the nightly workflow is their
   first path to executing in CI.
3. **OIDC SSO / SAML, embed/white-label, offboarding-with-purge, scheduled
   reports** — no e2e at any tier.
4. **security-probe breadth** — covers 4–6 of 24 services; extend per service.

The rule this matrix enforces, from the ledger: *coverage that has never
executed is not coverage.* PENDING rows are authored and ready; they become
PROVEN only when the orchestrator runs them green against a live stack and the
evidence artifact records it.
