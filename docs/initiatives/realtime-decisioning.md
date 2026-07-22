# Real-time decisioning — filling the R1–R4 gaps with the existing Core → BFF → UI stack

**Status:** design — 2026-07-21
**Commits:** — (analysis/design only; no code yet)
**Related:** `docs/DATACERN_REALTIME_HEALTHCARE_POSITION.md` (the market-facing gap list R1–R5) · BRD 09 (ingestion) · BRD 54 (decision modeling) · BRD 57 (standards interop) · memory: realtime topic grammar, component config pattern, rbac catalog gotchas

---

## 1. Analysis

### 1a. Platform / product

Healthcare buyers will object that the platform "acts on offline datasets" while their world is
event-driven (ADT feeds, ePA requests, denial streams). The position doc answers the *positioning*
half; this initiative answers the *engineering* half: every identified gap lands on an existing
extension point in the current three-tier stack (Go/Python core services → bff-graphql → ui-web).
No new services, no re-architecture. Outcome when done: an external event (webhook, Kafka message,
SFTP drop, HL7v2 message) becomes an open, triaged, live-updating case in seconds, and a
synchronous scoring/rules API lets the platform sit inline at claim creation.

### 1b. Technical — current state, with evidence

The stack is already event-native; the gaps are enumerable and local:

| Fact | Evidence |
|---|---|
| Connector-type registry is a closed tuple with catalog auto-exposure to the UI wizard | `services/ingestion-service/app/domain/connectors.py:261` (`CONNECTOR_TYPES`), `:580` (`connector_catalog_entry` → `GET /api/v1/connector-types`) |
| `sftp`, `ftp`, `http_api` types **already defined** (config + secret fields) but the runner never polls them | `connectors.py:197` (sftp model); `grep sftp app/domain/runner.py` → no hits (unwired) |
| Webhook push intake exists with per-source signed secrets | `services/ingestion-service/app/domain/secrets.py:23` (`webhook_secret_path`) |
| Wire-format decoders for X12/FHIR/HL7v2 already in the ingestion format set | BRD 57 implementation (530 tests); format picker in the upload/ingestion UI |
| Decision tables live in agent-runtime with **synchronous single-evaluate already built** (returns the same governed proposal as batch) | `services/agent-runtime/app/api/routes/decisions.py:161` ("Build the SAME governed proposal single-evaluate does, for one case") |
| Model scoring is batch-only (MLflow model load → parquet in MinIO) | `services/inference-service/app/adapters/executor.py:50` (`run(model, dataset, job)`); submit at `app/api/routes/inferences.py:44` |
| Every service consumes/publishes Kafka through go-common/py-common with group-namespaced Redis dedup (idempotent consumption solved) | `libs/go-common/kafka` (dedup fix), `libs/py-common/datacern_common/kafka.py` |
| Case materialization from data rows exists (worklist-from-rows, chart-drill → create cases) but is human-initiated — **no event-rule auto-trigger** | case-service + ui-web dashboard drill feature |
| UI already receives live row/status updates for list pages via realtime-hub `list:<type>` topics | realtime-hub + `useHubTopics` bridge (initiative #80/#81 fixes) |

So: R1 is "wire transports into an existing connector framework", R2 is "add a trigger-rule entity
in front of existing case creation", R3 is "add one synchronous route next to an existing batch
route (+ an advisory mode flag on an evaluate that already exists)". R4 is metrics on plumbing that
already emits RED metrics.

---

## 2. Architecture & Design

### INC-1 · Event-rule case triggers (R2) — highest demo value

The piece that makes "event lands → case opens on a live screen" true end-to-end.

- **Core (case-service, Go):**
  - New table + domain entity `case_triggers` (tenant-scoped, RLS like every other table):
    `{id, tenant_id, workspace_id, name, source {topic | ingestion_id}, filter (field/op/value
    conjunctions over the event payload), mapping (event fields → case title/severity/due-offset/
    display_projection), enabled, created_by}`.
  - A consumer (existing go-common Kafka consumer pattern + Redis dedup) subscribes to
    `ingestion.events.v1` / `dataset.events.v1` row-level events; on match, calls the existing
    case-creation domain path (same code the worklist-from-rows flow uses — no second write path).
  - Idempotency: dedup key = `trigger_id + event_id` via the group-namespaced dedup store.
  - RBAC: register `case.trigger.read|create|update|delete` in case-service's action MANIFEST
    (catalog is merge-only — the `SeedCatalogActions` invariant).
- **BFF:** `caseTriggers` query + `createCaseTrigger` / `updateCaseTrigger` / `deleteCaseTrigger`
  mutations in `src/schema/typeDefs.ts` + `resolvers/index.ts`, forwarding to a new
  `clients/case.ts` method set (same shape as every other CRUD).
- **UI:** new "Triggers" tab on the existing `/cases/settings` page (`src/app/(app)/cases/settings/`),
  gated by `cap("case.trigger.read")` through the existing registry. No realtime work needed —
  the `list:case` broadcast already pushes the auto-created case onto any open worklist.
- **Governance invariant:** triggers only *create work*; they never decide. AI proposals on the
  created case still flow through four-eyes untouched.

### INC-2 · Wire the dormant pull transports (R1a)

- **Core (ingestion-service, Python):**
  - `sftp`/`ftp`: implement the poll step in `app/domain/runner.py` (list → filter new by
    control/dedup state → download → existing `_attempt_file` path, which already handles X12
    duplicate-ISA guards). Libraries: `asyncssh`/`aioftp`.
  - `kafka_source`: new connector type in `CONNECTOR_TYPES` + `SECRET_FIELDS` (sasl password);
    a consumer loop (py-common Kafka client + dedup) feeding the same record path as webhooks.
  - Schedule: reuse the existing recurring-ingestion scheduler (WS3 batch scheduling) for poll
    cadence — nothing new.
- **BFF/UI:** **zero work** — the connector wizard is catalog-driven from `GET /connector-types`,
  so new types appear with their config/secret fields automatically.

### INC-3 · Healthcare listeners (R1b)

- **FHIR Subscriptions (rest-hook):** this is the existing webhook endpoint + the existing FHIR
  decoder; the only new code is a small subscription-registration helper (store the criteria,
  verify the handshake header). Ingestion-service only.
- **HL7v2 MLLP:** an asyncio TCP listener task inside ingestion-service (started per configured
  `mllp_listener` connection; MLLP framing is ~30 lines), emitting each message into the existing
  HL7v2 decode → record path, ACKing per the standard. Port exposure is a deploy concern
  (`docker-compose` / Helm service), not an architecture one.
- **X12 real-time 278/270-271 (request/response):** defer to INC-5/partner scope — response
  semantics need the outbound-writeback rails (276 outbound exists as the template).

### INC-4 · Online decision API (R3)

- **Scoring (inference-service):** new `POST /api/v1/score` — body `{model_urn, rows[]}` →
  synchronous predictions. Reuses `mlflow_registry.py` resolution + a per-version LRU model cache
  (the batch executor already loads models; extract the load into a shared cached loader).
  Promoted-stage policy enforced exactly like batch submit. RBAC action `inference.score.execute`
  registered in the MANIFEST.
- **Rules (agent-runtime):** the synchronous evaluate exists (`decisions.py:161`) but produces a
  governed proposal. Add an `advisory=true` mode returning `{decision, trace}` without writing a
  proposal — for inline scrubbing where the caller (practice-management system) applies the edit
  itself. The governed path remains the default.
- **BFF:** `scoreRecords` + `evaluateDecisionAdvisory` mutations (thin passthroughs).
- **UI:** "Test" drawer on the `/decisions` model page and on the ML model page — paste a record,
  see score/decision + trace. Reuses the existing per-decision trace renderer.

### INC-5 · Latency SLOs (R4)

- Stamp `event_received_at` on ingestion records → propagate through case-creation event →
  histogram `event_to_case_seconds` and `event_to_proposal_seconds` via the existing metricsx
  RED-metrics plumbing. Surface p50/p95 on the admin observability panel. Target: p95 < 60s
  event→triage-proposal, published once measured honestly.

### Out of scope (unchanged from the position doc)

POS pharmacy switching (sub-second NCPDP adjudication), CMS-0057/Da Vinci PAS conformance packs
(R5 — partner workstream on top of these rails), streaming analytics/CEP (the platform triggers
cases; it is not a stream processor).

### Sequencing & sizing (single-engineer-days, honest ranges)

| Inc | Scope | Size | Layer split |
|---|---|---|---|
| 1 | Case triggers | 4–6 d | core 3d · bff 0.5d · ui 1.5d |
| 2 | SFTP/FTP wire-up + kafka_source | 3–5 d | core only |
| 3 | FHIR rest-hook + MLLP listener | 4–6 d | core only (+deploy port) |
| 4 | Online score + advisory evaluate | 4–6 d | core 3d · bff 0.5d · ui 1.5d |
| 5 | SLO metrics + panel | 2–3 d | core 1.5d · ui 1d |

INC-2/3 are the connector lanes suitable for the SI partner once INC-1 establishes the pattern;
INC-4 stays in-house (touches Core decision paths).

---

## 3. Implementation & Test

### INC-1 — Event-rule case triggers: DONE (built, tested, live-verified 2026-07-21)

What was built (core → BFF → UI, no mocks in runtime paths):

- **case-service core** — migration `000006_case_triggers` (RLS + FORCE, `case_app` grant);
  `domain.CaseTrigger` (conditions whitelist eq/neq/contains/gt/gte/lt/lte, severity/due/cap
  validation, URN-wins-over-name source matching); PG store CRUD + `TouchTriggerFired`;
  `triggers.Applier` consuming `ingestion.events.v1` `ingestion.completed` → matches enabled
  triggers → fetches rows from dataset-service with **filter pushdown** (`filter=col:op:value`)
  under a minted least-privilege service token (`typ=service`, scope `dataset.dataset.read`) →
  materializes rows as cases via the same `CreateCases` path as the inference auto-case consumer,
  idempotent via `DedupKey(dataset_urn,row_pk)`. Triggers create **work, never decisions** —
  four-eyes is untouched.
- **CRUD API** `/api/v1/case-triggers` (GET/POST/PATCH/DELETE) behind new RBAC actions
  `case.trigger.read|create|update|delete` (registered in the service manifest).
- **BFF** — `caseTriggers` query + create/update/delete mutations (`CaseTrigger` SDL type,
  snake→camel mapper, patch-style input forwarding only defined fields).
- **UI** — Triggers tab on `/cases/settings`: list (source, conditions, severity, due, status),
  create dialog with conditions builder, pause/enable, delete; gated by the new capabilities.

Hardening found by the live run (all fixed):

1. **Registration race** — dataset-service registers the dataset asynchronously from the *same*
   event; first fetch can 404. The applier waits it out in-handler (6 attempts × 3s on 404)
   instead of leaning on Kafka redelivery pacing.
2. **Numeric filters on CSV datasets** — CSV uploads land every column as string, and
   dataset-service degraded `gt/gte/lt/lte` on non-numeric columns to a substring match, so
   `amount gt 5000` silently matched nothing. Fixed in `dataset-service/app/domain/browse_sql.py`:
   an ordering op with a numeric value on a string column now compares via
   `try_cast(col AS DOUBLE)` (this also fixes numeric grid filters on any CSV dataset).
3. **Silent zero-row path** — a matched trigger that fetches nothing now logs
   ("case trigger matched but no rows passed conditions") so condition/type mismatches are
   diagnosable instead of invisible.

Known platform limitation surfaced (pre-existing, not INC-1): re-ingesting with
`new_dataset` under an **existing** dataset name DLQs the registration
("iceberg snapshot … not committed/readable") because dataset-service resolves the old dataset
by name while the new snapshot lives in a new bronze table. Recurring feeds must append to the
same dataset (or use fresh names); tracked as a separate fix.

Verification evidence:

- Unit: `internal/domain/trigger_test.go` (validation/normalize/source-match) — PASS.
- Integration (real Postgres testcontainer): `test/integration/triggers_test.go` — CRUD under
  RLS, apply → 2 `case.created` outbox events, **replayed event creates nothing** (dedup),
  non-matching source never fetches, disable/delete — PASS. dataset-service
  `tests/unit/test_browse_sql.py` extended with the try_cast case — 10/10 PASS.
- UI: `cases/settings/triggers.test.tsx` (list render, create-dialog mutation payload, pause) —
  PASS (suite green).
- **Live e2e** (real UI-created trigger "High-value trigger demo", conditions `amount gt 5000`,
  severity high, due 72h): real CSV file-upload ingestion of 4 claim rows → `ingestion.completed`
  → trigger fired → **exactly the 2 high-value rows became cases** (#92 TRG-001 $9,000,
  #93 TRG-003 $7,500), visible on the live `/cases` worklist with domain titles, high severity,
  72h due dates. case-service log: `case trigger created cases … created=2`. Re-run of the same
  rows created no duplicates.

Planned verification for the remaining increments (per the platform's no-mock rule):
- **INC-2:** live SFTP container (testcontainers) drop → ingested dataset → rows; kafka_source
  round-trip through Redpanda.
- **INC-3:** MLLP framing golden tests + live socket test (send ADT^A01, assert ACK + decoded
  record); FHIR rest-hook handshake + notification test.
- **INC-4:** score endpoint against the really-promoted demo model (registry stage enforced);
  advisory evaluate returns trace and writes **no** proposal row.
- **INC-5:** metrics scrape asserted in integration; measured p95 recorded here.
