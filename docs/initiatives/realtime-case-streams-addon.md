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
| 5 | ui-web Streams tab (wizard + live tiles) | pending |
| 6 | Live e2e journey: seeded source → stream → department worklist gains a case with evidence; cross-department user cannot see it | pending |

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