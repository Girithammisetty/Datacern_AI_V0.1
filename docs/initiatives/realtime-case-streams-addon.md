# Real-Time Case Streams — universal connector → streaming intake → governed cases (paid add-on)

**Status:** in-progress — 2026-07-30
**Commits:** (slice 1 below)  ·  **Related:** BRD 11 (case-service), BRD 13 (ingestion), BRD 66 (commercial plane), realtime-decisioning INC-1, docs/architecture/*

---

## 1. Analysis

### 1a. Platform / product

A business user asked for: *a universal connector across their enterprise data
sources, streaming that data in, building cases with decision evidence — with
isolation between one department and another.* This is the "system of
accountability meets system of record" ask: don't make my team export CSVs into
the case platform; watch our operational databases and queues, and when a row
that matters appears, a case exists seconds later in the right department's
worklist with the evidence already attached — and Claims can never see Fraud's
cases.

Why it sells as an add-on: the base platform is priced around *decisioning*
(cases, agents, four-eyes). Continuous enterprise-source streaming is an
infrastructure capability with its own COGS (pollers, connector maintenance,
volume) and its own buyer value (time-to-case drops from "when someone uploads
a file" to "watermark interval"). That is a classic priced-SKU boundary, and the
commercial plane already has the machinery for it (BRD 66: plans, entitlement
kinds, enforcement precedent at pack install — `CPL-FR-030`).

### 1b. Technical — what already exists (verified in code) vs. what is missing

The honest finding: **most of this capability already exists as disconnected
primitives.** The request is less "build streaming case management" than
"finish four gaps and productize the path".

Exists today:

| Piece | Evidence |
|---|---|
| Incremental, bounded streaming reads with watermark pushdown | `ingestion-service/app/domain/querysource.py` — "Streams query results in bounded batches; never materializes the full result", `:watermark` binding grammar (ING-FR-023/061) |
| Recurring scheduled ingestions | `ingestion-service/app/domain/services/ingestions.py:165` — `scheduled_run` jobs "created by schedule fires, not the API" |
| Event rule → cases | `case-service/internal/domain/trigger.go` — `CaseTrigger`: on `ingestion.completed`, rows passing `Conditions` materialize as cases via the same `CreateCases` path; dedup by `row_pk`; `MaxCasesPerEvent` cap. "Triggers only create work — they never decide", so four-eyes is untouched |
| Department scoping on every case object | `WorkspaceID` on `CaseTrigger`, `Case`, `CaseEvidence` (`case-service/internal/domain/types.go:122,138`); tenant isolation is Postgres `FORCE RLS`; workspace (=department) scoping is enforced by RBAC scopes at the API layer (live-verified by the RBAC journey spec: "adjuster gets in-scope case read/write") |
| Governed evidence | `CaseEvidence` (`types.go` task #77): object-store bytes, tenant-isolated, `StorageKey` never exposed |
| Live case updates to the UI | realtime-hub topics `case.assigned`, `case.bulk.completed`, `case.disposition_applied`, `case.events.v1` — WebSocket fan-out with per-connection backpressure |
| Add-on gating machinery | commercial plane entitlement kinds + enforcement precedent (`pack_sku` checked at pack install, trial expiry read-only degradation) |

A correction this analysis nearly got wrong (and why Rule #1 demands
code-level verification): `querysource.py`'s docstring said "Real drivers are
stubs (TODO wave-2)" — **that comment was stale.** The driver matrix exists
and is wired (`app/domain/drivers/`: real asyncpg Postgres with
injection-safe `$1` watermark binding and auth/timeout classification,
MySQL/MariaDB, SQL Server, Oracle, SFTP/FTP/HTTP/S3, plus credential-gated
Snowflake/Redshift/Databricks/BigQuery/Spanner/Salesforce/GCS/Azure — see
`wire_local_drivers`; integration-tested in
`tests/integration/test_local_drivers.py`). The stale docstring is fixed in
this commit. The "universal connector" is therefore already substantially
real; the remaining gaps are:

1. **A first-class Stream object.** Today the path is assembled by hand:
   connection + schedule + trigger, each configured separately. The business
   user's mental model is one thing — "stream this source into that
   department's worklist" — and the UX, API and entitlement should bind to that
   one thing.
2. **Evidence auto-capture.** `CaseTrigger` copies row columns into
   `display_projection`; it does not attach the source increment itself as
   `CaseEvidence`. "Cases with decision evidences" wants the triggering rows
   frozen as a governed, immutable attachment — what the row looked like *at
   intake time*, which is exactly what an examiner asks for later.
3. **The add-on gate.** No `realtime_case_streams` feature entitlement exists;
   streams must refuse (not degrade) for tenants without the SKU.

### Department isolation, stated precisely

- Tenant ↔ tenant: Postgres `FORCE ROW LEVEL SECURITY` — database-enforced.
- Department ↔ department (same tenant): `workspace_id` scoping on triggers,
  cases and evidence, enforced by RBAC scopes at every API and by
  workspace-filtered queries — application-enforced, live-tested by the RBAC
  journey. A Stream is *born* in a workspace, and every case and evidence
  object it produces inherits that workspace. This is honest to sell as
  role/scope isolation; it is **not** claimed as DB-level isolation between
  departments (that would require per-workspace RLS policies — listed as a
  hardening option in §2, not silently implied).

---

## 2. Architecture & Design

One new concept, threaded through every existing layer rather than a new
subsystem. A **Case Stream** = `(connection, statement/table, watermark column,
interval, target workspace, trigger template, evidence policy)`.

```
 enterprise source (Postgres/MySQL/SQLServer/... via query drivers; files/objects already real)
        │  watermark-incremental pull, bounded batches       [ingestion-service]
        ▼
 scheduled_run ingestion  ──ingestion.completed──▶  Kafka (outbox — publish only after commit)
        ▼                                                    [case-service]
 CaseTrigger (workspace-scoped) → CreateCases (row_pk dedup) + CaseEvidence snapshot
        ▼
 case.events.v1 ──▶ realtime-hub ──▶ department worklist updates live   [ui-web]
```

### Layer by layer

**Downstream services**
- *ingestion-service*: driver classes per connector type behind the existing
  `QuerySource` port (slice 1: Postgres/asyncpg; then MySQL, SQL Server).
  Streams API: `POST /streams` composes connection + schedule + trigger
  registration atomically; the entitlement check happens **here** — creation
  and enable are refused without the SKU (fail-closed, honest 403 with the
  SKU named), running streams pause with a surfaced reason when the
  entitlement lapses (mirrors trial read-only degradation, CPL-FR-022).
- *case-service*: extend `CaseTrigger` with `attach_evidence bool`. When set,
  the matched rows for each created case are serialized (bounded: projection
  caps apply) and stored through the existing `CaseEvidence` path with
  `uploaded_by = "stream:<stream_id>"` — evidence provenance is the stream,
  not a human, and the audit chain records it like any other write.
- *usage-service / commercial plane*: new `feature` entitlement key
  `realtime_case_streams`; per-plan `meter_allowance` for `stream_rows_month`
  so the SKU can be priced by volume tiers later. No new kinds — both already
  exist in the BRD 66 model.

**bff-graphql**: `caseStreams` query + `createCaseStream` /
`pauseCaseStream` / `resumeCaseStream` mutations; a `caseStreamStatus`
subscription proxying realtime-hub. All resolvers carry workspace scope from
the caller's token — a user without the workspace scope cannot even list that
department's streams.

**UI/UX** (`ui-web`): a "Streams" tab inside the existing Cases module — not a
new module. Create wizard: pick connection → pick table/statement + watermark
column → preview matched rows (real `browse_rows` pushdown) → choose
department (workspace) + severity/due → toggle "attach intake snapshot as
evidence" → review the entitlement/price note → enable. Live tiles per stream:
last watermark, rows/last-increment, cases created, lag. Department isolation
is visible in the UX: the workspace picker only offers workspaces the creator
holds scopes for.

**Invariants** (carried, not new): triggers create work, never decisions —
four-eyes untouched; outbox — nothing publishes before its DB commit;
`row_pk` dedup makes re-polls idempotent; refusal over silent degradation at
every gate (unsupported driver, missing entitlement, oversized increment).

**Explicitly out of scope** (named so nobody assumes them): CDC/log-based
capture (Debezium-class — the watermark poll is the v1 streaming model, and is
honest about being seconds-to-minutes, not milliseconds); per-workspace
Postgres RLS policies (hardening option if a buyer requires DB-level
department isolation); Kafka-as-a-source connector.

### Pricing shape (for the commercial doc, not code)
Add-on SKU `realtime-case-streams`: base fee per tenant + included
`stream_rows_month` allowance + overage meter. Enforced exactly like
`pack_sku` at creation and like trial degradation at lapse.

---

## 3. Implementation & Test

Slices, smallest honest increments first. Status is per-slice and updated as
commits land.

| # | Slice | Status |
|---|---|---|
| 0 | Verify the connector matrix is real; fix the stale "drivers are stubs" docstring | **done — this commit** |
| 1 | `CaseTrigger.attach_evidence` → intake-snapshot `CaseEvidence` | **done — this commit** |
| 2 | `realtime_case_streams` feature entitlement + fail-closed refusal at the attach-evidence surface | **done — this commit** |
| 3 | Case Streams API in ingestion-service (compose connection + watermark schedule; gated create/resume; pause/patch/delete) | **done — this commit** |
| 4 | bff-graphql: CaseStream schema/resolvers + composed create with compensation | **done — this commit** |
| 5 | ui-web Streams tab (wizard + live tiles) | **done — this commit** |
| 6 | Live e2e journey: seeded source → stream → department worklist gains a case with evidence; cross-department user cannot see it | **done** (CI-gated; see slice 6 notes for what ran where) |
| 7 | Learn-flywheel journey (`make journey-learn`): labels → training → four-eyes promotion → registry stage → auto_case scoring → cases — closes the score→case bridge | **done — this commit** |

**Slice 1 (this commit) — intake-snapshot evidence.** `CaseTrigger` gains
`attach_evidence` (migration `000008`, default false — existing triggers keep
byte-identical behaviour). When set, the applier freezes each created case's
matched source row as `intake_snapshot/v1` JSON: the **full** row (not the
truncated display projection — keeping what the projection may have dropped
is the point), the column list, trigger/dataset provenance, and the capture
timestamp. Bytes go to the SAME MinIO/S3 store as human evidence uploads; the
pointer goes through the SAME `InsertEvidence` path with
`uploaded_by = "trigger/<name>"`; `workspace_id` is inherited from the
trigger, so department isolation carries to the snapshot automatically.
Best-effort by design and loudly logged on failure: the cases already exist,
and `row_pk` dedup means a Kafka redelivery would not recreate them — failing
the event could never retry the snapshots into place.

Verification: `go build` / `go vet` clean; unit tests cover the snapshot
builder (full-row-not-projection, byte-stability for identical input, ragged
source rows); all case-service suites pass. The full blob+DB path and the
cross-department invisibility assertion are integration/live-tier (slice 6) —
not claimed as verified here.

**Slice 2 (this commit) — the add-on gate.** case-service gains a vendored
reader of the commercial plane's `entitlements_flat` Redis projection
(`internal/entitlements`, the same read-side contract pack-service enforces
pack_sku with, CPL-FR-030) — and unlike usage-service's surfacing-only reader,
this one enforces. Turning `attach_evidence` ON (create, or a false→true
update) requires the tenant to hold the `feature`-kind entitlement
`realtime_case_streams`:

- **Entitled** → proceeds.
- **Blocked** → 403 naming the SKU and the exact entitlement key — a refusal
  the buyer can act on, not a bare "forbidden".
- **Unavailable** (projection missing/unreadable/Redis down) → 503
  `ENTITLEMENT_UNAVAILABLE`, fail-closed (CPL-NFR-004): "could not check" is
  never reported as "not entitled" and never becomes a silent grant.

Turning the feature OFF, or editing a trigger that already has it, is never
gated — an entitlement lapse is a commercial-plane pause concern (CPL-FR-022
precedent), not a lockout from the tenant's own rule. Until the SKU is seeded
in a tenant's plan, the surface is enabled-nowhere by construction — exactly
right for an unreleased priced add-on.

Verification: unit tests cover Entitled/Blocked distinctness, kind-mismatch
(a `pack_sku` sharing the key string does not unlock the feature), every
fail-closed path (nil client, Redis error, missing key, empty and corrupt
blobs), and the gate's error mapping (403 names both SKU spellings; 503
states the refusal). The end-to-end HTTP path against real PG + Redis is
integration-tier. Seeding the SKU into plans is a pricing decision, left to
the commercial plane deliberately.

**Slice 3 (this commit) — the Case Streams API.** The grounding surprise that
shaped it: the `schedules` table already carries the watermark cursor
(`watermark_column/operator/value_type/value`) with Temporal-backed timing and
pause/resume — a watermark schedule IS the streaming engine. So slice 3
composes rather than re-implements: `CaseStream` (migration 0011,
tenant-RLS'd, partial-unique name per workspace so a soft-deleted stream frees
its name) binds connection + a REQUIRED watermark schedule (+ optionally the
case-service trigger id, patched on by the caller until the bff slice) into
one named, department-scoped object with `POST/GET/PATCH/DELETE
/api/v1/case-streams` and `/pause` `/resume`.

The gate: create and resume require `feature: realtime_case_streams`
(ingestion-service's own vendored `entitlements_flat` reader,
`app/domain/entitlements.py`) — Blocked → 403 naming the SKU, Unavailable →
503 `ENTITLEMENT_UNAVAILABLE` fail-closed. Pause and delete are never gated: a
lapsed tenant can always turn things off. Authz reuses the
`ingestion.schedule.*` action catalog deliberately — a stream is a governed
wrapper over a schedule; the add-on boundary is the entitlement, not a new
RBAC action. Ordinary schedules stay ungated base-platform functionality.

Verification: 7 unit tests through the real HTTP app (in-proc scheduler
tier) — 403-naming-the-SKU, three fail-closed paths (Redis error, missing
projection, no client), entitled create composes a live watermark schedule
queryable via the schedules API, duplicate-name 409, lapsed-tenant
pause-allowed/resume-refused/restore-resumed, trigger-id patch,
delete-frees-the-name, workspace-filtered list. Full ingestion suite 589
passed, ruff clean. Migration 0011 against live Postgres and the Temporal
tier are integration/CI; cross-service trigger auto-creation lands with the
bff slice (4).

**Slice 4 (this commit) — the bff layer, where the composition promise is
kept.** `CaseStream` joins the GraphQL schema (queries `caseStreams(workspaceId)`
/ `caseStream`; mutations create/pause/resume/bindCaseStreamTrigger/delete),
mapped from the ingestion API with the live watermark cursor surfaced for the
UX tiles. `createCaseStream(input.trigger)` is the one-call flow the design
promised: the bff creates the stream, then registers the case-service
CaseTrigger against the SAME dataset the stream writes (trigger name defaults
to the stream name; `attachEvidence` passes through to slice 1's gate), then
binds it — and if the trigger cannot be created it deletes the stream again
before surfacing the error. A half-composed stream never survives.

Two error-honesty rules enforced at this layer: entitlement refusals pass
through untouched (the 403 still names the SKU), and `ENTITLEMENT_UNAVAILABLE`
joins the bff's downstream-code passthrough list (alongside BUDGET_EXHAUSTED /
RATE_LIMITED / CONNECTION_TEST_FAILED) so the UI can distinguish "buy the SKU"
from "the commercial plane cannot be consulted right now" instead of both
flattening to a generic SERVICE_UNAVAILABLE.

The `caseStreamStatus` subscription from the original sketch is deliberately
NOT added: the UI already consumes live case events directly from realtime-hub
(`case.events.v1` WebSocket), and a bff proxy subscription would duplicate
that path without adding governance. Recorded here so the omission reads as a
decision, not a gap.

Verification: 6 unit tests at the mocked-fetch boundary with real envelopes —
camel→snake body mapping with the cursor surfaced, composed create (trigger
watches the stream's dataset, binds, attach_evidence forwarded), compensation
(trigger 500 → stream deleted → error surfaced), both entitlement refusals
pass through verbatim, workspace-filtered list + pause reflecting the disabled
schedule. Schema snapshot regenerated; full bff suite 345 passed, typecheck +
lint clean.

**Slice 5 (this commit) — the Streams tab.** Case settings gains a Streams
tab (`StreamsPanel`, between Triggers and SLA policy): the DataTable lists
each stream with its status, the live watermark cursor (the proof it reads
incrementally rather than re-scanning), next pull time, and whether a case
trigger is bound; row actions pause/resume/delete. The inline create form is
the one-call flow from slice 4 surfaced as UX: name + connection (picked from
the tenant's real connections list) + source statement + target dataset +
watermark (column/type/initial value) + pull interval, plus the case-trigger
severity and the attach-evidence checkbox — one submit drives the composed
`createCaseStream` mutation (with an idempotency key, per the panel
convention).

Error honesty carried to the last mile: a `PERMISSION_DENIED` or
`ENTITLEMENT_UNAVAILABLE` refusal renders verbatim in a `role="alert"` banner
— the 403 names the SKU and the 503 says the commercial plane could not be
consulted — never softened into a generic toast. RBAC rides the existing
`ingestion.schedule.*` `Can` gates (create/update/delete), mirroring the
service's deliberate reuse of that action catalog; no new client-side gate
invented.

Verification: 4 unit tests in the settings harness (mocked `graphqlRequest`
routed by operation) — list renders name/status/cursor/binding; create
submits the full composed input (query template + new_dataset + watermark +
trigger.attachEvidence) with an idempotency key; the SKU-naming refusal
appears verbatim in the alert; pause fires against the right stream. Full
ui-web suite 579 passed (90 files), typecheck clean, lint clean (only
pre-existing warnings in unrelated files).

**Slice 6 (this commit) — the live journey, and the two platform bugs it
caught.** `deploy/e2e/test_case_stream_journey.py` (`make journey-streams`,
wired into the e2e-live CI job right after `make journey`) drives the add-on's
full arc against the real stack and asserts on STATE — rows in Postgres,
evidence bytes, boundary 404s — never on acknowledgements. Eight phases: the
SKU gate refuses a fresh tenant (403 naming the SKU / 503 fail-closed) BEFORE
any resource checks; a platform-operator entitlement override opens the
projection (polled by watching the same refused call flip 403→404); two rbac
workspaces become departments A and B with identical grants (workspace-owner,
the verb-mapped path) — only the workspace claim differs; a real Postgres
source is seeded and connected through the real asyncpg driver probe
(`ssl_mode: "disable"` stated explicitly — secure-by-default config, lab
source without TLS); ONE bff `createCaseStream` composes stream + watermark
schedule + trigger, born in department A; `run_now` pulls only past-watermark
rows and opens cases only for rows passing the trigger condition; the intake
snapshot's bytes contain the source row; department B gets `[]` and 404s on
case/timeline/evidence; one new source row yields exactly one new case with
the cursor advanced; removing the override re-gates resume but never pause.

Writing and RUNNING it caught three real bugs no unit tier had seen — the
reason journeys exist:
1. **Case-service workspace isolation did not exist on reads.** The list
   filtered by tenant only and `/cases/{id}` routes did no workspace check —
   any tenant user holding `case.case.read` could read another department's
   case by id. Fixed: `RequireCaseWorkspace` middleware on every `/cases/{id}`
   route (mismatch → 404, cross-tenant-404 discipline one level down, distinct
   `security.cross_workspace_denied` audit event; workspace-less service
   tokens stay tenant-scoped) + a workspace term filter on the worklist search
   taken from the token claim, never a query param. Integration-tested against
   real PG.
2. **Streams were born in the nil workspace through the bff.**
   `CaseStreamCreate.workspace_id` defaulted to the nil uuid and the service
   trusted the body; the bff never sends workspace_id, so every UI-created
   stream escaped its department. Fixed claims-first (the token's workspace
   wins over any body value — a department user cannot plant a stream in
   another department), and the bind PATCH now returns the live schedule so
   the composed create's response carries the cursor. Unit tests added for
   both (a hostile body naming another workspace is overridden).
3. **Append fires could silently miss their increment.** Caught by the
   journey's FIRST full-stack CI run (26/27 checks green; "second fire opened
   exactly ONE new case — got 1"): case-service's trigger applier browses
   rows via dataset-service, which serves the *registered current version's
   pinned Iceberg snapshot* — and dataset-service bumps that version
   asynchronously from the SAME `ingestion.completed` event the applier is
   consuming. First fires were safe by accident (the dataset doesn't exist
   yet, and the applier's 404-retry loop waits out registration); append
   fires found the dataset with the PREVIOUS version current, browsed
   pre-append rows, deduped every one of them and acked — the increment
   vanished without an error anywhere. Fixed: the completed event already
   names its `iceberg_snapshot_id`, so the applier now polls the dataset
   detail until the registered current version IS the event's snapshot
   before browsing (30s cap, then browse-anyway with a loud log — never
   stricter than before). Snapshot ids are compared through a symmetric
   float64 canonicalization because the Kafka payload decodes int64 ids
   lossily while the detail API returns them exactly. Integration test
   simulates the stale-then-registered sequence and asserts the browse is
   deferred until catch-up.

Verification, stated precisely: in the network-restricted dev container
(no Docker registries; native PG16/Redis/Kafka-KRaft/MinIO/OPA/Vault stack,
LLM plane absent via the new `OLLAMA_OPTIONAL=1` escape hatch), phases 1–3
ran live end to end — 16 of 17 checks green through composed create, with
`run_now` stopping at the one piece of infra the container cannot obtain
(the Iceberg REST catalog, Docker-image-only). On the full dockerized CI
stack the journey then went 26/27 — every phase held (gate, grant, composed
create, first fire → case, evidence bytes, all four isolation checks, cursor
advance, lapse) except the append increment, which exposed bug 3 above; the
snapshot-catch-up fix makes that leg deterministic. The e2e-live run of THIS
head is the merge gate. Ingestion suite 619 passed + ruff clean; case-service
10/10 packages.

**Slice 7 (this commit) — the Learn flywheel, CI-gated, and the half-built
bridge it exposed.** The GTM narrative's Learn verb ("every signed decision
becomes a training label … high scores open their own cases") was the one
claim with no continuous journey behind it. Scoping `make journey-learn`
immediately found why: **the score→case bridge was half-built.** Case-service
ships a complete `InferenceHandler` — `inference.completed` with
`auto_case=true` → `AutoCreateFromInference` opens cases, consumer already
subscribed to `inference.events.v1` — but inference-service only ever emitted
`inference.job.succeeded`. The consumer was dead code; no producer existed.

Producer built (inference-service): `parameters["auto_case"]` — validated at
the API boundary (`AutoCaseSpec`: exactly one of numeric `threshold` /
categorical `positive_label` for classifier label outputs, `row_pk_field`,
`score_field`, ≤12 `projection_fields`, `max_cases` ≤ 500 matching
CreateCases' batch cap). The executor collects qualifying rows DURING the
scoring stream (bounded; truncation counted, never silent) and the service
emits `inference.completed` inside the run-once output-registration
transaction — exactly-once via the outbox, with the precise payload contract
the consumer parses. 14 unit tests (spec validation, both modes, cap
visibility, no-spec emits nothing, pure collector); inference suite 85
passed, ruff clean.

One planned fix turned out already fixed: the driver's step-K note ("the
harness bridges the approved stage into the MLflow registry; this belongs in
experiment-service") is stale — `_sync_mlflow_stage` runs on promotion
approval (BUG-2). The journey asserts the registry stage with NO harness
bridging, so the claim is now gated rather than assumed.

`deploy/e2e/test_learn_journey.py` (`make journey-learn`, in e2e-live after
journey-streams): fresh tenant; 24 REAL governed resolutions → pipeline
`labeled_examples` (both label categories); real random_forest training run →
succeeded; register the mirrored run; four-eyes promotion with the
requester's self-approval REJECTED (403 SELF_APPROVAL) and a different human
approving staging → production; MLflow registry reads Production; batch
scoring of 10 unseen rows with `auto_case(positive_label=true_positive)`;
final assertion state-vs-state — cases created by `agent/inference` exist for
EXACTLY the rows the output parquet says the model flagged, no more, no less.
The e2e-live run of this head is the first full-stack execution — the merge
gate, same discipline as slice 6.