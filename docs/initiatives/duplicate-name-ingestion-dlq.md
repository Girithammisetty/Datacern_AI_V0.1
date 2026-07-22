# Duplicate-name new_dataset upload lands in the DLQ (orphaned data)

**Status:** done — 2026-07-21
**Commits:** (uncommitted; this change set)  ·  **Related:** realtime-decisioning.md (found live-verifying INC-1), memory `project_windrose_task71_track_a_bugs` URN-single-source-of-truth fix

---

## 1. Analysis

### 1a. Platform / product
Uploading a file with `new_dataset {name: X}` when a dataset named X already
exists in the workspace silently loses the upload: the ingestion reports
**completed**, but the dataset never appears — nothing downstream (browse, case
triggers, pipelines) can see the rows. The user gets no error at any point; the
only trace is a DLQ message an operator would have to go digging for. Duplicate
names are an everyday occurrence (re-uploading a refreshed CSV with the same
natural name), so this is a routine-path data-loss bug, not an edge case.

### 1b. Technical
ingestion-service pre-mints a dataset id for `new_dataset` targets
(`app/domain/services/ingestions.py::_resolve_target`), embeds it in the bronze
table name (`bronze.<tenant>.ds_<id>`) and in the `dataset_urn`/`dataset_id` it
emits on `ingestion.completed` (`runner.py` completed-event payload). The rows
were committed to the NEW bronze table before the event fires.

dataset-service's consumer (`app/events/consumer.py::_resolve_dataset`) looked
up the payload id, and on a miss **fell back to resolve-by-(workspace, name)** —
returning the pre-existing dataset X. `VersionService.register` then validated
the event's snapshot against the OLD dataset's `iceberg_table` (BR-1), where it
does not exist → `Conflict("iceberg snapshot ... is not committed/readable")` →
5 retries → `ingestion.events.v1.dataset-service.ingestion.dlq`
(`max_retries_exceeded`). Evidence: DLQ event_id
`019f8741-c193-7546-86f7-f644deb47529`, tenant
`019f856d-5a9b-7c19-8a58-e90b0ace9880`.

The name fallback exists for legacy events that predate the enriched payload
(no `dataset_id`); applying it when the payload *does* carry an id contradicts
the documented invariant that the event id is the single source of truth for
the dataset row.

---

## 2. Architecture & Design
Options considered:

- **(a) Reject duplicate `new_dataset` names at ingestion-create time (400).**
  Rejected as the primary fix: ingestion-service has no datasets store and no
  dataset-service client — the check would add a new synchronous cross-service
  dependency, is inherently TOCTOU (name can be taken between create and
  complete, e.g. by a concurrent upload or a schedule fire), and still leaves
  the consumer able to orphan data on the race. Possible later as UX polish.
- **(b) Consumer honors the payload id (chosen).** The name fallback now runs
  ONLY when the payload carries no dataset id (legacy events — behavior
  unchanged). With an id present and no row, the consumer creates the dataset
  under that exact id. Since (workspace, name) is unique
  (`DatasetService._check_name_free`), a taken name is de-conflicted
  deterministically to `"<name> (2)"`, `"<name> (3)"`, … (bounded at 99, then
  the event surfaces to retry/DLQ) with a WARN log. Data preservation beats
  name fidelity: the rows are already committed to this ingestion's own bronze
  table, and renaming is the standard convention (file managers, Docs).
- **(c) Append to the existing dataset.** Already exists as a first-class path:
  create the ingestion with `dataset_urn` instead of `new_dataset` (XOR-
  validated) — the runner then writes into the existing dataset's bronze table.
  The consumer cannot retro-append here because the snapshot lives in a
  different physical table than the existing dataset's.

Invariants kept: RLS/tenancy (all lookups inside the tenant-scoped UoW; foreign
tenant URNs still ignored per MASTER-FR-003), idempotency (event-id dedup +
`produced_by_urn` natural dedup both run before creation, so redeliveries never
mint `"<name> (3)"`), no mocks in verification.

---

## 3. Implementation & Test
- `services/dataset-service/app/events/consumer.py` — `_resolve_dataset`:
  name-fallback gated to id-less payloads; create-under-event-id with
  deterministic name de-confliction on `Conflict`; WARN log on rename.
- `services/dataset-service/tests/unit/test_consumer.py` —
  `TestDuplicateNameNewDataset`: repro (existing "Orders" + event with minted
  id/own bronze table → second dataset under the event id named "Orders (2)",
  version registered with the event snapshot, original untouched, re-keyed
  redelivery idempotent) and suffix-skips-taken-names ("Orders (3)").

Verified:
- Unit: full dataset-service suite green — 235 passed (16 in test_consumer.py,
  2 new).
- Live (no mocks): real stack via the e2e harness — two file uploads with the
  same `new_dataset` name; upload #2 registered as `dup-claims-1784682910 (2)`
  under the event's minted id with a real Iceberg snapshot version
  (`snapshot=950548931263748791`), DLQ high-watermark unchanged, dataset #1
  still at version 1. Consumer WARN observed in `deploy/e2e/logs/dataset.log`.

Deferred: optional 400/409 duplicate-name pre-check at ingestion create or in
the upload wizard (pure UX; requires an ingestion→dataset-service client).
