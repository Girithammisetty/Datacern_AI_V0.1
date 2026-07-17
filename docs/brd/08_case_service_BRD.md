# BRD 08 — case-service (Go)

**Date:** 2026-07-09 · **Status:** Approved for build · **Phase:** 4
**Inherits:** `00_MASTER_BRD.md`. Architecture: `../../WINDROSE_PLATFORM_ARCHITECTURE.md` §6 (case-service row), §5 (Triage domain), §8.4/§8.5 (case-triage copilot, proposals).

---

## 1. Overview

**Purpose.** case-service owns the triage workflow: cases generated from query/inference result rows, assignment, SLA enforcement, dispositions, comments/activity, bulk operations, and OpenSearch-backed list/search.

**Business value.** V1 (`case-manager` Rails) stored a **full row snapshot** as JSON in every case (`cases.row json NOT NULL`), duplicating warehouse data, going stale the moment the dataset changed, and bloating Postgres. Reporting was served by per-query Postgres views (`analyst_cases`, `view_cases`) rebuilt by jobs — fragile and unsearchable at scale. V1 also once pre-created an "unassigned" case per dataset row (`CaseUnassignedCreator`), producing phantom cases that inflated case IDs and polluted reports (the class was lobotomized to return `[]` — the pre-creation pattern is explicitly designed out). The rebuild stores **row references** (dataset URN + row PK + small display projection), replaces view rebuilds with an OpenSearch projection, and adds real SLA timers via Temporal.

**In scope:** case CRUD + generation from query/inference rows; lifecycle state machine (statuses mined from V1: `draft, in_progress, resolved, unassigned`); assignment + SLA timers (Temporal) with auto-unassign and escalation; dispositions; per-workspace custom case fields; comments & activity timeline; bulk operations; OpenSearch projection for list/search/facets/export; dedup via `dataset_guid`; triage-copilot integration (read fields + proposal application endpoints); closure snapshot archival.

**Out of scope:** running the queries that produce candidate rows (query-service / inference-service); the triage-copilot agent itself (agent-runtime); proposal approval UX (ui-web/agent-runtime, per master §8.5 — case-service only exposes the apply endpoints); notification delivery (notification-service consumes `case.events.v1`).

## 2. Actors & user stories

Personas: **Analyst** (works cases), **Case Manager** (assigns, oversees SLAs), **Workspace Admin** (configures fields/SLA policy), **Triage copilot** (agent, proposals), **Inference pipeline** (system producer).

- **US-1** As a Case Manager, I select rows from a query result grid and create cases referencing those rows, so analysts triage live data instead of stale copies.
- **US-2** As a Case Manager, I assign a case to an analyst with a due date; if it isn't worked before the SLA breach, it auto-unassigns back to the pool and I'm notified.
- **US-3** As an Analyst, I see my queue (`assigned to me`, sorted by due date), open a case, view the live row plus display projection, add notes, and resolve with a disposition.
- **US-4** As a Case Manager, I bulk-assign 500 cases to an analyst and bulk-resolve a filtered set, with clear reporting of which items failed.
- **US-5** As an Analyst, I search cases by free text, filter by status/assignee/disposition/severity, and facet counts update in ≤5s after changes.
- **US-6** As a Workspace Admin, I define custom case fields (name, data type, create/update/both purpose) per query or workspace-wide, and they appear on case forms.
- **US-7** As a Triage copilot, I read a case's row reference, prior similar dispositions, and custom fields, then submit severity/assignee/disposition **proposals**; an approved proposal is applied with dual attribution.
- **US-8** As an Analyst, when the same underlying row (by `dataset_guid`) is produced by a second query, I see one case linked to both queries — never a duplicate.
- **US-9** As a Case Manager, I export the current filtered case list to CSV for compliance review.
- **US-10** As an auditor, I read a closed case months later and see the archived row snapshot exactly as it was at closure, even if the dataset has since changed.

## 3. Functional requirements

### Case model & generation
- **CASE-FR-001 (M)** **Row-reference model.** Each case stores: `dataset_urn`, `dataset_version` (pinning the Iceberg snapshot), `row_pk` (value of the dataset's key column, V1 `_row_guid_` concept generalized), and `display_projection` jsonb — ≤ 12 columns × ≤ 256 chars, the grid columns chosen at creation. **Never a full row snapshot** while the case is open. Full row is fetched live via query-service on `GET /cases/:id` (`?with_row=true`).
- **CASE-FR-002 (M)** Case creation from query rows: `POST /cases` with `{query_urn, dashboard_urn?, rows: [{row_pk, display_projection}], assigned_to_id?, due_date, severity?, description?, custom_fields{}}`. Single and multi-row (bulk_create) share one endpoint; V1's separate `create`/`bulk_create` collapse.
- **CASE-FR-003 (M)** Case creation from inference results: consume `inference.events.v1 / inference.completed` where the job is flagged `auto_case=true`; create cases from output rows exceeding the configured score threshold, `created_by = agent/system` attribution.
- **CASE-FR-004 (M)** Human-readable `case_number`: per-workspace monotonic integer (V1 `case_id` via `pg_advisory_xact_lock` per workspace — reimplement as a per-workspace sequence row with `SELECT … FOR UPDATE`). Unique `(tenant_id, workspace_id, case_number)`.
- **CASE-FR-005 (M)** **Dedup (`dataset_guid` semantics).** `dedup_key = sha256(dataset_urn ‖ row_pk)`; unique per workspace where present (V1: `validates :dataset_guid, uniqueness: {scope: :workspace_id, allow_blank: true}`). Creating a case for an existing open dedup_key does **not** create a duplicate: it appends the new `query_urn` to the case's `source_query_urns[]` (V1 `ON CONFLICT … guid_query_ids` merge) and returns the existing case with `Idempotency-Replayed`-style header `X-Case-Deduplicated: true`. A **closed** case with the same key does not block a new case (recurrence), but the new case links `recurrence_of=<old case URN>`.
- **CASE-FR-006 (M)** Closure snapshot: on transition to `resolved`→`closed` (archive step), fetch the full row once and store it in object storage (`snapshots/<tenant>/<case_id>.json.gz`) with a pointer row — the only time full row data is persisted.

### Lifecycle & assignment
- **CASE-FR-010 (M)** Status enum (mined from V1 `Case.statuses`): `unassigned(3)`, `draft(0)`, `in_progress(1)`, `resolved(2)`; rebuild adds `closed` (archived terminal). Invariant (V1 validations): `assigned_to_id IS NULL ⇔ status = unassigned`. Transitions in §4.
- **CASE-FR-011 (M)** Assignment: `POST /cases/:id/assign {assignee_id}` sets `assigned_to_at` (V1 `assign_date` on every assignee change), moves `unassigned→draft`; `POST /cases/:id/unassign` clears assignee, moves to `unassigned`. Assignee must be a workspace member holding `case.case.work` (V1 fetched assignable users from config-service; rebuild checks rbac projection).
- **CASE-FR-012 (M)** **SLA via Temporal.** On assignment, start (or reset) an SLA workflow keyed `case-sla:<case_urn>`: timer to `due_date`. Policy per workspace (`sla_policies` table): `warn_before` (default 24h → `case.sla.warning` event), `on_breach ∈ {auto_unassign (default, V1 UnassignCasesJob intent), escalate, notify_only}`, `escalate_to` (manager principal), `max_reassign_count` (default 3, then always escalate). Auto-unassign performs the same transition as manual unassign with `actor={type:'system',id:'sla'}` and emits `case.sla.breached` + `case.unassigned`.
- **CASE-FR-013 (M)** Timer lifecycle: due_date change resets the timer; `in_progress→resolved` or unassign cancels it; Temporal signals are idempotent per case_version. Workflow survives service restarts (durable timers — V1 had **no** automated SLA enforcement, only a required `due_date` field; this is the formalization).
- **CASE-FR-014 (M)** Reopen: `resolved → in_progress` allowed within 30 days by `case.case.manage` holders; clears disposition to `reopened_from=<disposition_id>` history; `closed` is terminal.
- **CASE-FR-015 (S)** Escalation: `POST /cases/:id/escalate {to, reason}` — records escalation, notifies via event, bumps `severity` one level unless already `critical`.

### Dispositions, fields, collaboration
- **CASE-FR-020 (M)** Dispositions: workspace-configurable catalog `{code, label, category ∈ {true_positive, false_positive, benign, inconclusive, other}, requires_note bool, active}`. Resolving requires an active disposition; `requires_note` enforces a non-empty resolution note. Case stores `disposition_id`, `resolution_note`, `resolved_at` (V1 `resolution_date`).
- **CASE-FR-021 (M)** Severity: `low | medium | high | critical` (default `medium`), settable at creation and by `case.case.manage` or approved copilot proposal.
- **CASE-FR-022 (M)** Custom case fields (V1 `case_fields`): per workspace, optionally scoped to a `query_urn`; `{name, data_type ∈ {string,text,integer,float,boolean,date,enum}, purpose ∈ {create, update, both} (V1 enum), field_meta jsonb (label, enum options, width, required, display)}`. Unique `(workspace, query_urn, name)`. `GET /cases/form?mode=create|update&query_urn=` returns default fields (V1: assignee required, due_date required, description) + custom fields in `field_meta` UI format; query-scoped fields win over workspace-wide (V1 `fields_of` fallback).
- **CASE-FR-023 (M)** Custom field values stored in `cases.custom_fields jsonb` (≤ 16KB, documented JSONB use), validated against the field catalog on write; unknown keys rejected.
- **CASE-FR-024 (M)** Comments (V1 `notes_history` normalized): `case_comments` rows `{author_id, body ≤ 8KB markdown, created_at, edited_at}`; edit/delete by author within 15 min, soft-delete after.
- **CASE-FR-025 (M)** Activity timeline: append-only `case_events` (create/assign/unassign/status/severity/disposition/field-change/comment/sla/proposal-applied), each with actor + `via_agent`, old/new values. `GET /cases/:id/timeline` merges events + comments chronologically, paginated.

### Bulk operations
- **CASE-FR-030 (M)** `POST /cases/bulk {operation ∈ {assign, unassign, resolve, set_severity, add_comment}, case_ids[] | filter, params}`. Max **500** ids per call (larger → `422 BATCH_TOO_LARGE`); filter-based bulk resolves the filter to ids server-side, capped at 5,000, executed as an async operation (`202 {operation_id}`, progress via realtime-hub).
- **CASE-FR-031 (M)** **Partial failure semantics:** items validated independently; response `{succeeded: [ids], failed: [{id, code, message}]}`; HTTP `200` if ≥1 succeeded, `422` if all failed. Each success is individually transactional and emits its own event (V1 `update_all` skipped validations/events — designed out).
- **CASE-FR-032 (M)** Bulk operations are rate-limited: 5 concurrent bulk ops per tenant; per-item throughput target ≥ 200 items/s.

### Search projection
- **CASE-FR-040 (M)** OpenSearch index `cases-<tenant>` (alias per tenant, tenant filter enforced in every query at the service layer): fields `case_number, status, severity, assignee, created_by, disposition{code,category}, due_date, resolved_at, dataset_urn, source_query_urns, display_projection.*, custom_fields.*, comment_text (analyzed), created_at, updated_at, case_version`.
- **CASE-FR-041 (M)** Projection is event-driven from the outbox (consistency: **eventual, ≤ 5s** p95 event→searchable); every doc write is versioned by `case_version` (optimistic concurrency — stale updates discarded). Postgres remains the source of truth; `GET /cases/:id` always reads Postgres.
- **CASE-FR-042 (M)** `GET /cases` (list/search) serves from OpenSearch: free-text `?q=`, `filter[status]` (incl. V1 pseudo-filters `open`={draft,in_progress}, `closed`={resolved,closed}), `filter[assignee]=me`, `filter[severity]`, `filter[disposition_category]`, `filter[query_urn]`, `filter[due]=overdue|today|week`, facet counts via `?facets=status,severity,assignee`, cursor pagination (`search_after`).
- **CASE-FR-043 (M)** Full reindex job (`POST /admin/reindex`, admin-only): rebuilds into a new index and swaps the alias atomically; replaces V1 `ViewsRebuildJob`/`AnalystCase.rebuild` view machinery.
- **CASE-FR-044 (S)** Export: `POST /cases/export {filter, format:csv}` → async operation streaming matching cases (Postgres-joined for authoritative values) to object storage, signed URL 15 min (V1 `views#export` replacement).

### Triage-copilot integration
- **CASE-FR-050 (M)** Read surface for the agent (via MCP tools `case.get_case`, `case.search_cases`, `case.get_similar_resolved`): case core fields, display_projection, custom fields, timeline, and `similar_resolved` — top-K closed cases matching `dataset_urn` + disposition history (feeds RAG grounding per architecture §8.4).
- **CASE-FR-051 (M)** Proposal application endpoints (called by agent-runtime **after** human approval, service-to-service auth, per master §8.5): `POST /cases/:id/apply-proposal {proposal_urn, changes: {severity? | assigned_to_id? | disposition: {id, resolution_note}}}`. Validates the same rules as human mutations; writes `actor={type:'user', id:<approver>}` + `via_agent={agent_id, version}`; timeline entry links `proposal_urn`. Rejected/expired proposals never reach case-service.
- **CASE-FR-052 (M)** Fields the copilot may propose are exactly: `severity`, `assigned_to_id`, `disposition(+resolution_note)` (architecture §8.4 catalog). Any other field in `changes` → `422 PROPOSAL_FIELD_NOT_ALLOWED`.

## 4. Domain model & data

```
cases            id uuidv7 PK · tenant_id · workspace_id · case_number bigint · status smallint CHECK IN (0,1,2,3,4)
                 · severity text CHECK · assigned_to_id uuid NULL · assigned_to_at timestamptz · created_by_id
                 · dataset_urn text NOT NULL · dataset_version text · row_pk text NOT NULL · dedup_key text
                 · display_projection jsonb (≤4KB) · source_query_urns text[] · dashboard_urn text
                 · due_date timestamptz NOT NULL · description text · custom_fields jsonb (≤16KB)
                 · disposition_id FK NULL · resolution_note text · resolved_at · closed_at · snapshot_ref text
                 · recurrence_of uuid NULL · case_version int default 1 · created_at · updated_at · deleted_at
  UX (tenant_id, workspace_id, case_number) · UX (tenant_id, workspace_id, dedup_key) WHERE dedup_key IS NOT NULL AND status <> 4
  IX (tenant_id, workspace_id, status, due_date) · IX (tenant_id, assigned_to_id, status) · IX (tenant_id, dataset_urn)
  CHECK ((assigned_to_id IS NULL) = (status = 3))          -- V1 invariant, DB-enforced
  Partitioned by month on created_at (master §2.7-062); retention: closed cases purged per tenant policy (default 24 months; snapshot retained 7y in WORM tier)

case_events      id uuidv7 PK · tenant_id · case_id · event_type · actor_type · actor_id · via_agent jsonb NULL
                 · proposal_urn text NULL · old_value jsonb · new_value jsonb · occurred_at
  IX (tenant_id, case_id, occurred_at) · partitioned monthly · retention 7y

case_comments    id PK · tenant_id · case_id · author_id · body text · edited_at · created_at · deleted_at
dispositions     id PK · tenant_id · workspace_id · code · label · category · requires_note bool · active bool · UX (workspace_id, code)
case_fields      id PK · tenant_id · workspace_id · query_urn NULL · name · data_type · purpose smallint · field_meta jsonb (≤8KB)
                 · UX (tenant_id, workspace_id, coalesce(query_urn,''), name)
sla_policies     id PK · tenant_id · workspace_id UX · warn_before interval · on_breach text · escalate_to uuid · max_reassign_count int
case_sequences   workspace_id PK · last_number bigint          -- FOR UPDATE allocation (replaces V1 advisory lock)
outbox           (master standard)
```

**State machine.**
```
unassigned(3) --assign--> draft(0) --start_work--> in_progress(1) --resolve[disposition valid]--> resolved(2)
draft|in_progress --unassign (manual | SLA auto)--> unassigned
draft <--> in_progress (start_work / pause)
resolved --reopen[≤30d, case.case.manage]--> in_progress
resolved --close[snapshot stored]--> closed(4)   [terminal]
```
Guards: `resolve` requires active disposition (+note if `requires_note`); `assign` requires assignee authz; every transition bumps `case_version`, appends `case_events`, emits Kafka event, and syncs the Temporal SLA workflow (start/reset/cancel).

## 5. API specification

Base `/api/v1`. Actions `case.case.*`, `case.disposition.*`, `case.field.*`.

| Method & path | Purpose | Errors |
|---|---|---|
| `POST /cases` | create 1..500 from rows (dedup-aware) | 409 DEDUP via header, 422 |
| `GET /cases` | OpenSearch list/search/facets | 422 bad filter |
| `GET /cases/:id[?with_row=true]` | read (+ live row via query-service) | 404, 502 ROW_FETCH_FAILED (case still returned, `row:null`, `row_error` set) |
| `PATCH /cases/:id` | update description/due_date/custom_fields/severity (If-Match case_version) | 409 stale, 422 |
| `POST /cases/:id/assign` · `/unassign` · `/start` · `/resolve` · `/reopen` · `/close` · `/escalate` | transitions | 409 INVALID_TRANSITION, 422 |
| `POST /cases/bulk` | bulk ops (≤500 ids) | 422 all-failed / BATCH_TOO_LARGE |
| `GET /cases/:id/timeline` | merged events+comments | 404 |
| `POST /cases/:id/comments` · `PATCH/DELETE /comments/:cid` | comments | 403 not-author, 422 |
| `GET /cases/form?mode=&query_urn=` | form fields (defaults + custom) | — |
| `GET/POST/PATCH /dispositions` · `GET/POST/DELETE /case-fields` | admin catalogs | 409 in-use |
| `POST /cases/:id/apply-proposal` | copilot proposal application (svc auth) | 422 PROPOSAL_FIELD_NOT_ALLOWED, 409 |
| `POST /cases/export` | async CSV | 429 |

`POST /cases` example request/response:
```json
POST /api/v1/cases  (Idempotency-Key: 9c1e…)
{"query_urn":"wr:t-42:query:query/q-771","dashboard_urn":"wr:t-42:chart:dashboard/d-15",
 "due_date":"2026-07-12T17:00:00Z","assigned_to_id":"u-77","severity":"high",
 "custom_fields":{"risk_reason":"velocity"},
 "rows":[{"row_pk":"txn-889100","display_projection":{"txn_id":"txn-889100","amount":"1,250.50","merchant":"ACME"}},
         {"row_pk":"txn-889101","display_projection":{"txn_id":"txn-889101","amount":"980.00","merchant":"ZORP"}}]}

→ 201
{"data":{"created":[{"id":"01978…","case_number":1042,"status":"draft","dedup_key":"sha256:ab12…"}],
         "deduplicated":[{"id":"01977…","case_number":998,"row_pk":"txn-889101",
                          "source_query_urns":["wr:…:query/q-500","wr:…:query/q-771"]}]}}
```
`POST /cases/:id/resolve` example: `{"disposition_id":"01977…","resolution_note":"Confirmed fraud, refunded"}` → full case; error `{"error":{"code":"DISPOSITION_NOTE_REQUIRED",…}}`.

`GET /cases` search response (OpenSearch-backed):
```json
GET /api/v1/cases?q=acme&filter[status]=open&filter[severity]=high&facets=status,assignee&limit=50
→ {"data":[{"id":"01978…","case_number":1042,"status":"in_progress","severity":"high",
            "assignee":{"id":"u-77"},"due_date":"2026-07-12T17:00:00Z",
            "display_projection":{"txn_id":"txn-889100","amount":"1,250.50","merchant":"ACME"},
            "case_version":6}],
   "facets":{"status":{"draft":12,"in_progress":30},"assignee":{"u-77":8,"u-90":11}},
   "page":{"next_cursor":"c9Zk…","has_more":true},
   "meta":{"projection_lag_ms":900}}
```

`POST /cases/bulk` partial-failure response:
```json
{"succeeded":["01978…a","01978…b"],
 "failed":[{"id":"01978…c","code":"INVALID_TRANSITION","message":"case is closed"},
           {"id":"01978…d","code":"NOT_FOUND"}]}
```

**SLA Temporal workflow (normative sketch):**
```
workflow case-sla:<case_urn> (input: due_date, policy, case_version)
  timer_warn  = due_date - policy.warn_before  → emit case.sla.warning (skip if already resolved — re-read status in activity)
  timer_due   = due_date                        → activity:
                  re-fetch case; if status ∈ {resolved, closed} → complete
                  if policy.on_breach == auto_unassign and reassign_count < max → transition unassign(actor=system/sla)
                  elif escalate → escalate to policy.escalate_to, bump severity
                  else → emit case.sla.breached only
  signals: due_date_changed (reset timers) · resolved/unassigned (complete) — idempotent per case_version
```

## 6. Events

**OpenSearch index mapping (normative core; custom_fields mapped dynamically as keyword/text pairs):**
```json
{"mappings":{"properties":{
  "tenant_id":{"type":"keyword"},"workspace_id":{"type":"keyword"},
  "case_number":{"type":"long"},"status":{"type":"keyword"},"severity":{"type":"keyword"},
  "assignee_id":{"type":"keyword"},"disposition_code":{"type":"keyword"},"disposition_category":{"type":"keyword"},
  "due_date":{"type":"date"},"resolved_at":{"type":"date"},"created_at":{"type":"date"},
  "dataset_urn":{"type":"keyword"},"source_query_urns":{"type":"keyword"},
  "description":{"type":"text"},"comment_text":{"type":"text"},
  "display_projection":{"type":"flattened"},"custom_fields":{"type":"flattened"},
  "case_version":{"type":"long"}}},
 "settings":{"index.number_of_shards":1,"index.refresh_interval":"1s"}}
```
Doc writes use `_id = case id` with external versioning by `case_version`; tenant alias `cases-<tenant>` filters `tenant_id` at the alias level **and** in every service-layer query (belt and braces).

**Emitted** on `case.events.v1`: `case.created`, `case.assigned` (payload: case_urn, case_number, assignee, due_date), `case.unassigned` (reason: manual|sla_breach), `case.started`, `case.resolved` (disposition code/category), `case.reopened`, `case.closed` (snapshot_ref), `case.escalated`, `case.sla.warning`, `case.sla.breached`, `case.comment.added`, `case.severity.changed`, `case.bulk.completed` (operation_id, succeeded/failed counts). All master-enveloped, partition key tenant_id.

**Consumed:**
| Topic / type | Handler |
|---|---|
| `inference.events.v1 / inference.completed` | if `auto_case`, create cases per CASE-FR-003 (idempotent by event_id + dedup_key) |
| `dataset.events.v1 / dataset.deleted` | mark referencing open cases `row_unavailable=true` flag (case stays workable; row fetch returns 410 semantics) |
| `identity.events.v1 / user.deactivated` | unassign the user's open cases (reason: manual, actor system), emit `case.unassigned` |
| `rbac.events.v1 / workspace.member.removed` | same unassign flow for that workspace's cases |

## 7. Business rules & edge cases

- **BR-1** `assigned_to_id NULL ⇔ status=unassigned` is enforced at DB level (CHECK) and in the state machine — no API path can violate it (V1 model validation, hardened).
- **BR-2** Dedup: same `(workspace, dataset_urn, row_pk)` open case → merge query refs, never duplicate; closed case → new case with `recurrence_of`. Dedup only applies when the source grid projects the dataset's key column (V1: guid path required `select_args == [_row_guid_]`); keyless creations get `dedup_key=NULL` and are exempt.
- **BR-3** Case numbers are monotonic per workspace and never reused; allocation under row lock; gaps allowed on rollback.
- **BR-4** SLA breach with `auto_unassign` while the analyst is mid-edit: the PATCH carrying stale `case_version` gets `409`; the timeline shows the auto-unassign first. Auto-unassign never fires on `resolved/closed` cases (workflow canceled on resolve — race handled by re-checking status inside the Temporal activity).
- **BR-5** A case whose dataset version was compacted/vacuumed may fail live row fetch; `GET` still succeeds with `row_error` populated — the display_projection is always available.
- **BR-6** Bulk resolve requires the disposition params to validate per item (e.g., note requirement) — failures reported per item, no all-or-nothing.
- **BR-7** Reopen window: 30 days after `resolved_at`; afterwards only `close` is permitted. `closed` is immutable except comments (audit trail continues).
- **BR-8** Custom-field deletion is blocked (`409 FIELD_IN_USE`) if any non-closed case has a value for it; admin may force with `?orphan=true`, which strips the key from open cases and logs per-case events.
- **BR-9** Proposal application is idempotent by `proposal_urn` (unique in `case_events`); a replay returns the current case with `Idempotency-Replayed: true`.
- **BR-10** OpenSearch unavailable: list/search return `503 SEARCH_UNAVAILABLE`; single-case reads and all mutations continue (Postgres path); projection catches up from Kafka on recovery.
- **BR-11** Display projection is capped (12 cols × 256 chars) at creation; oversize values truncated with `…` marker — never rejected, never silently swallowed (flag `projection_truncated`).
- **BR-12** `due_date` must be > now at creation and on change (V1 required it non-null); past-due assignment allowed only with explicit `?allow_overdue=true` by managers.
- **BR-13** Max 10,000 open cases per workspace (soft limit → `case.limit.warning` event at 80%; hard `422 CASE_LIMIT_EXCEEDED` at 100%) to protect queues and the index.

## 8. Dependencies

**Upstream (sync):** query-service (live row fetch, export row hydration), rbac Redis projection + OPA (authz, assignable users), identity-service JWKS. **Async:** Temporal (SLA workflows `case-sla:*`, bulk/export operations); Kafka (emit + consume per §6); OpenSearch cluster (tenant-aliased indexes); object storage (closure snapshots, exports). **Downstream:** notification-service (assignment/SLA events), realtime-hub (`run-status:*` for bulk/export ops), audit-service, usage-service, triage copilot via MCP facade, bff-graphql/ui-web.

## 9. NFRs (deltas from master)

- Search p95 ≤ 300ms at 1M cases/tenant; facet queries ≤ 500ms.
- Event→searchable (projection lag) p95 ≤ 5s, alert at 30s.
- SLA timer accuracy: fires within 60s of due_date; zero missed timers across restarts (Temporal durability test).
- Bulk throughput ≥ 200 items/s; 500-item synchronous bulk ≤ 5s p95.
- Case mutation write p95 ≤ 500ms including outbox write.

## 10. Acceptance criteria

- **AC-1** Given 3 selected query rows with key column values, when `POST /cases`, then 3 cases exist with `dataset_urn`+`row_pk`+`display_projection` populated, no `row` snapshot column anywhere, and sequential `case_number`s.
- **AC-2** Given an existing open case for row R from query Q1, when case creation for R arrives from query Q2, then no new case is created, the case's `source_query_urns` contains Q1 and Q2, and the response marks R deduplicated.
- **AC-3** Given a case assigned with `due_date = now+2h` and policy `auto_unassign`, when 2h pass with no resolution, then the case is `unassigned` with `assigned_to_id=null`, a `case.sla.breached` and `case.unassigned{reason:sla_breach}` event exist, and the timeline shows actor `system/sla`.
- **AC-4** Given the same case, when the service is killed and restarted before the timer fires, then the breach still fires within 60s of due_date (Temporal durability).
- **AC-5** Given a case in `unassigned`, when `POST /resolve` is called, then `409 INVALID_TRANSITION`; when assigned then started then resolved with a disposition where `requires_note=true` and no note, then `422 DISPOSITION_NOTE_REQUIRED`.
- **AC-6** Given a bulk assign of 500 ids where 2 cases are already closed, when executed, then response lists 498 succeeded and 2 failed with per-item codes, and exactly 498 `case.assigned` events are emitted.
- **AC-7** Given 501 ids in one bulk call, when submitted, then `422 BATCH_TOO_LARGE` and nothing changed.
- **AC-8** Given a resolved case, when `POST /close`, then a gzip row snapshot exists in object storage, `snapshot_ref` is set, and subsequent dataset changes do not alter `GET /cases/:id?with_row=true` output for that case.
- **AC-9** Given a case updated at T0, when `GET /cases?q=<its description text>` at T0+5s, then the case appears with current status and facet counts include it (projection lag ≤5s).
- **AC-10** Given an approved copilot proposal changing `severity` and `disposition`, when agent-runtime calls `apply-proposal`, then the case reflects both, the timeline entry carries `proposal_urn` and `via_agent`, and the Kafka events have `actor=user(approver)` + `via_agent` per master §2.5-041.
- **AC-11** Given a proposal containing `due_date` in `changes`, when applied, then `422 PROPOSAL_FIELD_NOT_ALLOWED` and no mutation occurs.
- **AC-12** Given a query-scoped custom field `risk_reason` (purpose=update) and a workspace-wide field set, when `GET /cases/form?mode=update&query_urn=Q`, then the response contains defaults (case number, assignee, status, resolution fields) plus `risk_reason`, and query-scoped fields shadow workspace-wide ones.
- **AC-13** Given tenant A's token and tenant B's case id, when any case endpoint is called, then `404` + `security.cross_tenant_denied` audit event; OpenSearch queries are proven (test) to always carry the tenant filter.
- **AC-14** Given OpenSearch is down, when an analyst resolves a case, then the mutation succeeds; when search is called, then `503 SEARCH_UNAVAILABLE`; when OpenSearch recovers, then the resolved case is searchable without manual intervention.

## 11. Out of scope / future

Case merge/split; parent-child case hierarchies; per-case watchers/subscriptions (notification-service rules cover this); SLA business-hours calendars; ML-suggested assignee load balancing (future copilot capability, still via proposals); external ticketing sync (Jira/ServiceNow) — lands as tool-plane third-party tools.
