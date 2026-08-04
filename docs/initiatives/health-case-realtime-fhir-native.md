# Health Case Solution: Native Realtime Triggers + FHIR Connectivity

Status: BUILT (both parts; live journey evidence pending — see Verification)
Owner seams: dataset-service, case-service, tool-plane, agent-runtime (consumer), deploy
Predecessors: `docs/initiatives/realtime-decisioning.md` (INC-2..INC-5),
`docs/initiatives/realtime-case-streams-addon.md`,
`docs/DATACERN_REALTIME_HEALTHCARE_POSITION.md` (R1–R5)

## What this is

Two fully native builds — no external streaming engine, no third-party proxy —
that together turn the platform into a healthcare case solution with honest
realtime behavior and governed clinical-system access:

1. **Snapshot-delta trigger evaluation.** Case-stream triggers stop re-scanning
   the entire current dataset snapshot per ingestion event and instead evaluate
   their conditions over exactly the rows appended by the event's Iceberg
   snapshot. This removes the snapshot-registration catch-up poll and the
   append-fire race class documented in the addon initiative (slice 6, bugs
   2–3), and turns `MaxCasesPerEvent` from a correctness crutch into a plain
   rate limit.
2. **fhir-bridge.** A new, stateless Go service that gives agents governed
   access to any FHIR R4 backend (Epic, Cerner, OpenEMR, HAPI, GCP Healthcare
   API) through four operations — `fhir_read`, `fhir_search`, `fhir_create`,
   `fhir_update` — registered as tool-plane tools. Reads are grantable; writes
   are proposal-gated behind the existing propose→approve HITL discipline.
   The bridge stores no PHI: it resolves per-tenant backend credentials and
   forwards, nothing else.

The division of labor in one sentence: **the delta evaluator decides *when*
something happened, the platform decides *what to do about it and who may
approve it*, and fhir-bridge is *how agents touch the clinical system of
record* — always through tool-plane governance, never directly.**

This implements roadmap items this repo already wrote for itself: the
realtime-decisioning initiative's trigger-latency leg, the healthcare pack
BRDs' clinical-system connectivity, and the market-position R2/R3 gaps —
with code the platform fully owns.

## Part 1 — snapshot-delta trigger evaluation

### Current state (the defect being removed)

`case-service/internal/triggers/applier.go` reacts to `ingestion.completed`
by polling dataset-service (10×3s) until the *registered current version*
catches up to the event's `iceberg_snapshot_id`, then browsing the **entire
current snapshot** via `GET /datasets/{id}/rows?filter=...`. Correctness
leans on the catch-up poll and `row_pk` dedup; both races were live bugs.

### Target state

- **dataset-service** grows a snapshot-addressed delta read: rows from only
  the data files *added by* one specific snapshot, resolved directly against
  the Iceberg catalog — valid even before the version is registered, which
  dissolves the race rather than winning it. Same DuckDB browse machinery,
  same filter grammar (`eq|neq|contains|gt|gte|lt|lte`), same auth scope as
  the existing rows endpoint.
- **case-service** gains a flag-gated applier path that calls the delta read
  with the event's own `iceberg_snapshot_id` — no catch-up poll, only a
  short bounded retry for the dataset row itself existing. `DedupKey`
  remains as defense in depth. The legacy full-snapshot path stays behind
  the flag as fallback until the new path has soaked.
- Ingestion writes exactly one append-only snapshot per ingestion (BR-9),
  which is what makes "the delta" well-defined.

### What this does NOT give (deliberately deferred)

Log-based CDC from external clinical/claims databases and sub-second
latency. Those need a dedicated streaming engine; if/when that becomes a
requirement, it arrives as its own initiative with its own selection
decision. The delta evaluator keeps the platform honest at
seconds-per-event with none of the operational weight.

## Part 2 — fhir-bridge

### Shape

`services/fhir-bridge` (Go), following the smallest-service layout. Four
inbound operations, each an HTTP endpoint dispatched by tool-plane:

| Tool | FHIR semantics | Governance |
|---|---|---|
| `fhir_read` | `GET [base]/{type}/{id}` | grantable read |
| `fhir_search` | `GET [base]/{type}?params` | grantable read |
| `fhir_create` | `POST [base]/{type}` | proposal-gated |
| `fhir_update` | `PUT [base]/{type}/{id}` | proposal-gated |

All four are generic over FHIR R4 resource types (Patient, Coverage, Claim,
Observation, …) — resource type is a parameter, not a per-resource tool.

### Tenant backend configuration

A per-tenant FHIR backend connection: base URL + auth method, credentials in
the platform secret store (Vault), never in Postgres. Auth methods, in
build order: static bearer token, basic, OAuth2 client-credentials, and
SMART Backend Services (`private_key_jwt`, RS384) for Epic-class systems.

### Posture

- **Stateless, no PHI stored.** Request in, authenticated request out,
  response through. Logs carry resource *type* and id, never resource bodies.
- **Inbound auth**: platform service JWT (tool-plane dispatch identity),
  tenant resolved from the verified token — same discipline as every other
  internal receiver.
- **Governance**: the action-verb grammar classifies `create`/`update` as
  write verbs, so tool-plane's existing grant flow requires an approved
  proposal before dispatching them. An agent drafting a FHIR write produces
  a proposal; only human approval (four-eyes where configured) releases it.
  `ai.tool_invoked.v1` audit events flow to usage/eval/audit exactly as for
  every other tool.

### Agent usage

The case-triage agent enriches streamed cases with live clinical context
(Patient, Coverage, Claim, Observation) through `fhir_read`/`fhir_search`
instead of relying only on the intake snapshot; grounded context flows into
memory-service RAG as today. Write-backs (e.g. flagging a claim, appending
an annotation) ride the proposal loop.

## Multi-tenancy

Nothing new to design: the delta read inherits dataset-service RLS + the
dataset-scoped RBAC of the existing rows endpoint; fhir-bridge resolves the
tenant from the verified service JWT and keys backend config per tenant.
The cross-tenant authz probe grows a leg asserting tenant A's token cannot
reach tenant B's FHIR backend config or delta rows.

## Deployment

fhir-bridge follows the standard new-service pattern: `deploy/services.yaml`
entry, `boot_services.sh` boot function, CI `test-go` matrix inclusion,
no-stub-gate compliance. No new stateful infrastructure is required for
either part — that is the point of building native.

## Verification

Landed with the build:

- dataset-service: 4 hermetic delta-browse tests (unregistered-version delta,
  filters-within-delta, unknown-ingestion empty page, chunked multi-snapshot
  union) + a real-Iceberg integration test driving chunked appends
  (`tests/integration/test_real_adapters.py`).
- case-service: applier integration tests proving the delta path performs
  zero registration polls and zero full browses, dedup holds on redelivery,
  and a delta failure falls back to the legacy full browse without losing
  the fire (`test/integration/triggers_test.go`).
- fhir-bridge: 32 unit tests — all four ops, every auth method (incl. the
  SMART RS384 client assertion verified field-by-field), SPIFFE fail-closed
  facade, OPA re-check denial shapes, secret-never-in-Postgres, response
  caps, traversal and cross-host-redirect rejection.

Still owed (next slice): a `journey-fhir` script in `deploy/e2e/` asserting a
proposal-gated FHIR write lands on a sandbox FHIR backend only after human
approval — asserting on state, never on acknowledgements — and delta-path
assertions folded into `make journey-streams`.

## Out of scope (for now)

- Log-based CDC and sub-second trigger latency (dedicated streaming engine —
  future initiative, selection TBD).
- HL7v2 MLLP listener (INC-3's second half).
- FHIR Subscription rest-hook intake — the existing HMAC webhook endpoint
  already accepts these; wiring a first-class subscription manager is a
  follow-up.
- Bulk FHIR (`$export`) ingestion connector.
