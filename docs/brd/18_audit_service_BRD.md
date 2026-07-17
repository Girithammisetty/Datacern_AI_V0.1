# BRD 18 — audit-service

**Service:** audit-service · **Language:** Go · **Phase:** 1 · **Status:** Approved for build
**Inherits:** `00_MASTER_BRD.md` (all MASTER-FR requirements). Architecture: `../../WINDROSE_PLATFORM_ARCHITECTURE.md` §6, §1.2 (7y WORM retention), `../../WINDROSE_V3_AGENTIC_ARCHITECTURE.md` §5.13 (EU AI Act evidence trail).

---

## 1. Overview

**Purpose.** audit-service is the platform's immutable system of record for "who did what, when, to which resource, via which agent." It consumes every domain event topic (`*.events.v1`) and every AI topic (`ai.tool_invoked.v1`, `ai.agent_run.v1`, `ai.proposal.v1`), writes them to an append-only ClickHouse store, exports daily WORM batches to object storage with integrity manifests, provides an admin search API with dual-attribution queries, maintains per-tenant per-day hash chains for tamper evidence, and produces compliance evidence packs (SOC 2, EU AI Act decision logs).

**Business value.** SOC 2 / ISO 27001 controls and the master NFR "audit retention 7y WORM" are contractual requirements for enterprise tenants. EU AI Act Article 50 and the case-triage decision surface require a defensible evidence trail of agent actions and human oversight decisions. A single, uniform audit plane removes per-service audit reinvention.

**In scope.** Ingestion of all envelope-conformant events; ClickHouse append-only schema with payload digests; 7-year retention; daily WORM S3 export with hash manifests; admin-only search API (actor, via_agent, URN, action, time range) with export; dual-attribution queries; per-tenant per-day hash chaining with verification endpoint; SOC 2 / EU AI Act compliance report endpoints; PII schema enforcement on ingest; DLQ handling.

**Out of scope.** Being a source of truth for domain state (services own their data); real-time alerting on audit content (notification-service/SIEM consume the same topics directly); log aggregation for application logs (Grafana stack); legal-hold workflow tooling (export supports it, workflow is manual v1); analytics dashboards (BI reads the WORM exports).

## 2. Actors & user stories

Personas: **Tenant Security Admin**, **Platform Compliance Officer**, **Auditor** (external, read-only pack consumer), **SRE**, **Incident Responder**.

- **US-1** As a Tenant Security Admin, I want to search all actions by a specific user in a time range, so I can investigate a security report.
- **US-2** As a Tenant Security Admin, I want to see everything agent X did on behalf of user Y last week, so I can review agent behavior against user intent.
- **US-3** As an Incident Responder, I want every event touching resource URN `wr:t-42:dataset:dataset/ds-9f2` ordered by time, so I can reconstruct an incident timeline.
- **US-4** As a Platform Compliance Officer, I want a SOC 2 evidence pack for a control period (access changes, permission denials, admin actions), so annual audits need no ad-hoc queries.
- **US-5** As a Platform Compliance Officer, I want an EU AI Act decision log of all agent proposals with their human approve/reject/edit decisions, so Article-50/oversight evidence is one export away.
- **US-6** As an Auditor, I want to verify that a day's audit batch has not been tampered with, so the trail is trustworthy.
- **US-7** As an SRE, I want poison events quarantined to a DLQ with reasons, so ingestion never stalls platform-wide.
- **US-8** As a Tenant Security Admin, I want to export search results as CSV/NDJSON, so I can attach them to an investigation ticket.
- **US-9** As a Platform Compliance Officer, I want assurance no raw PII values are stored in audit records, so the audit store is not itself a privacy liability.
- **US-10** As a Tenant Security Admin, I want to find all `security.cross_tenant_denied` and `PERMISSION_DENIED` audit events for my tenant, so I can spot probing behavior.
- **US-11** As an Incident Responder, I want to pivot by `trace_id` from an application error to every audit event in that request, so cross-service reconstruction is one query.
- **US-12** As a Platform Compliance Officer, I want weekly automated integrity self-checks with alerting, so tampering is detected without waiting for an audit.

## 3. Functional requirements

### Ingestion
- **AUD-FR-001 (Must)** Consume ALL topics matching `*.events.v1` (identity, rbac, ingestion, dataset, query, semantic, experiment, pipeline, inference, chart, case, usage, notification) plus `ai.tool_invoked.v1`, `ai.agent_run.v1`, `ai.proposal.v1`, and `security.*` audit emissions. Topic list is config-driven with a regex subscription; adding a new domain topic requires zero code change.
- **AUD-FR-002 (Must)** Validate each event against the master envelope schema (MASTER-FR-031: `event_id`, `event_type`, `tenant_id`, `actor{type,id}`, `via_agent?`, `resource_urn`, `occurred_at`, `trace_id`, `payload`). Invalid envelopes → DLQ with reason `ENVELOPE_INVALID`.
- **AUD-FR-003 (Must)** Store the envelope fields as first-class columns and the payload as: (a) `payload_digest` = SHA-256 of canonical-JSON payload — always; (b) `payload_json` String — only if the payload passes the PII policy (AUD-FR-040) and is ≤ 64KB; otherwise `payload_json` is empty and `payload_ref` points to the source topic/partition/offset.
- **AUD-FR-004 (Must)** Idempotent ingest: ClickHouse `ReplacingMergeTree` keyed on `(tenant_id, event_id)` + Redis `SETNX event_id` pre-filter; replays never duplicate search results (queries use `FINAL`-safe patterns or GROUP BY event_id).
- **AUD-FR-005 (Must)** Ingest lag p95 ≤ 30s publish→queryable; lag metric + alert at > 5 min for 10 min. Throughput: 100K events/s per cell (matches bus NFR).
- **AUD-FR-006 (Must)** DLQ per consumer group (`<topic>.audit-ingest.dlq`), 5 retries exponential backoff, depth alert at > 0 for 15 min (MASTER-FR-033). A redrive CLI/endpoint (`POST /api/v1/admin/dlq/redrive`) re-processes after fix; redrive itself is audited.

### Storage & retention
- **AUD-FR-010 (Must)** ClickHouse table `audit_events`, append-only (no UPDATE/DELETE grants to the service role; mutations are administratively blocked). Schema in §4. Partitioned by month (`toYYYYMM(occurred_at)`); ORDER BY `(tenant_id, occurred_at, event_id)`.
- **AUD-FR-011 (Must)** Retention 7 years enforced by partition TTL; partitions older than 7y are dropped only after verifying their WORM export manifest exists and validates.
- **AUD-FR-012 (Must)** Materialized views maintain search accelerators: by `actor_id`, by `via_agent_id`, by `resource_urn`, by `action/event_type` (see §4 indexes).

### WORM export
- **AUD-FR-020 (Must)** Daily batch job (02:00 UTC for the prior UTC day): export per tenant per day to object storage with **object-lock compliance mode, 7-year retention** (S3 Object Lock / Azure immutable blob / GCS bucket lock): `s3://<audit-bucket>/tenant=<id>/date=YYYY-MM-DD/events-<seq>.parquet` (zstd, ≤ 512MB per file).
- **AUD-FR-021 (Must)** Each daily batch ships a `manifest.json`: file list with per-file SHA-256, row counts, min/max `occurred_at`, the day's hash-chain head (AUD-FR-050), the previous day's manifest hash (chaining manifests), and the exporter version. Manifest is written last; a day is "sealed" only when the manifest lands. Example:

```json
{"tenant_id":"t-42","date":"2026-07-08","revision":1,
 "files":[{"name":"events-0001.parquet","sha256":"ab12…","rows":183211,
           "occurred_at_min":"2026-07-08T00:00:00.003Z","occurred_at_max":"2026-07-08T23:59:58.911Z"}],
 "chain_head":"9f3c…","chain_seq_range":[1,183211],
 "prev_manifest_sha256":"77aa…","exporter_version":"1.3.0","sealed_at":"2026-07-09T02:14:31Z"}
```
- **AUD-FR-022 (Must)** Export is idempotent and re-runnable; re-export after late events writes a new sequence-numbered supplement file + updated manifest revision (originals are never overwritten — WORM).
- **AUD-FR-023 (Should)** `GET /api/v1/exports?date=&tenant_id=` lists sealed batches with signed download URLs (auditor access).

### Search API
- **AUD-FR-030 (Must)** `GET /api/v1/audit/search` — admin-only (`audit.event.read`, granted to tenant security-admin role; platform operators additionally require break-glass scope for cross-tenant). Filters: `actor_id`, `actor_type`, `via_agent_id`, `resource_urn` (exact or prefix), `action`/`event_type`, `from`, `to` (time range mandatory, ≤ 92 days per query), `trace_id`. Cursor-paginated (limit ≤ 200), sorted `-occurred_at`.
- **AUD-FR-031 (Must)** Dual-attribution query: `via_agent_id=X&actor_id=Y` returns everything agent X did on behalf of user Y (rows where `actor.type='user' AND actor.id=Y AND via_agent.agent_id=X`), plus `include_autonomous=true` adds `actor.type='agent' AND actor.id=X` rows. A convenience endpoint `GET /api/v1/audit/agent-activity?agent_id=&obo_user_id=` wraps this shape for the UI trace views.
- **AUD-FR-032 (Must)** Export of search results: `Accept: text/csv` or `application/x-ndjson` streams up to 1M rows; larger → `202 {operation_id}` async export to signed URL. Every search and export is itself audited (`audit.searched` with filter digest — auditors are audited).
- **AUD-FR-033 (Should)** `GET /api/v1/audit/events/:event_id` returns a single record incl. chain position and verification status.

### Tamper evidence
- **AUD-FR-050 (Must)** Hash chaining per tenant per day: each ingested event gets `chain_hash = SHA-256(prev_chain_hash || event_id || payload_digest || occurred_at)`, sequenced by a per-(tenant, day) monotonic counter (Redis INCR with Postgres-backed checkpoint; single writer per tenant partition guarantees order). Day 1's `prev` = SHA-256(tenant_id || date). Each day's head hash is stored in `chain_heads` and embedded in the WORM manifest (AUD-FR-021).
- **AUD-FR-051 (Must)** `POST /api/v1/audit/verify {tenant_id, date}` recomputes the chain from stored rows and compares to the sealed head + manifest; returns `{valid, events_checked, first_mismatch_seq?}`. Scheduled weekly self-verification over a random 1% sample of sealed days; mismatch → P1 alert + `audit.integrity_violation` event.
- **AUD-FR-052 (Should)** Chain heads are additionally anchored by writing the daily head hash into the next day's first event and into the manifest chain — removing any single point of silent rewrite.

### Compliance reports
- **AUD-FR-060 (Must)** `POST /api/v1/compliance/soc2-pack {from, to}` → async job producing an evidence pack (zip on signed URL). Pack contents:

| File | Contents (period-scoped) |
|---|---|
| `access_changes.csv` | rbac grant/role/group mutations with actor + before/after digests |
| `permission_denials.csv` | `PERMISSION_DENIED` + `security.cross_tenant_denied` events |
| `admin_actions.csv` | tenant/workspace/service-account/config mutations |
| `user_lifecycle.csv` | user created/deactivated/role-changed |
| `agent_governance.csv` | agent principal changes, kill-switch toggles, toolset scope changes |
| `integrity.json` | chain-verification results covering the period |
| `pack_manifest.json` | query params, generation time, chain heads, pack SHA-256 per file |

- **AUD-FR-061 (Must)** `POST /api/v1/compliance/ai-decision-log {from, to, agent_id?}` → EU AI Act pack: all `ai.proposal.v1` lifecycle events (proposed → approved/rejected/edited/expired) joined with executing tool calls (`ai.tool_invoked.v1` correlated by proposal_id/trace_id) and dual attribution — one row per decision with decision actor, timestamp, rejection reason and edit-diff digest, plus a per-agent summary (proposal counts by outcome, median decision latency). This is the human-oversight evidence per V3 §5.13.
- **AUD-FR-062 (Should)** Packs are reproducible: pack manifest records query parameters + chain heads covering the period; re-running with identical params yields byte-identical CSVs (deterministic ordering).

### PII policy
- **AUD-FR-070 (Must)** Enforce MASTER-FR-042 at ingest: payloads are validated against per-event-type Schema Registry schemas annotated with `pii=false` guarantees; unannotated/unknown event types get pattern-scanning (email, phone, national-ID regex set, high-entropy secrets) — hits cause the payload body to be dropped (digest kept) and a `audit.pii_rejected` metric+event with the producing service named. Raw PII is never persisted in ClickHouse or exports.
- **AUD-FR-071 (Must)** No payload bodies at INFO logs; search API never regex-scans payload contents for tenant queries (payload is filterable only by digest equality).

## 4. Domain model & data

ClickHouse (audit store) + small Postgres DB (service metadata: export manifests, chain checkpoints, async jobs — standard columns + RLS).

`audit_events` (ClickHouse, ReplacingMergeTree, PARTITION BY toYYYYMM(occurred_at), ORDER BY (tenant_id, occurred_at, event_id)):

| Column | Type | Notes |
|---|---|---|
| `event_id` | UUID | dedup key |
| `event_type` | LowCardinality(String) | e.g. `case.assigned` |
| `source_topic` | LowCardinality(String) | |
| `tenant_id` | UUID | |
| `actor_type` | Enum(user, service, agent) | |
| `actor_id` | String | |
| `via_agent_id` / `via_agent_version` | String / String | empty when direct |
| `obo_user_id` | String | denormalized from actor when OBO |
| `resource_urn` | String | + `resource_service`, `resource_type` derived cols |
| `action` | LowCardinality(String) | `<service>.<resource>.<verb>` when present |
| `occurred_at` / `ingested_at` | DateTime64(3) | |
| `trace_id` | String | |
| `payload_digest` | FixedString(64) | SHA-256 hex, always set |
| `payload_json` | String | PII-clean, ≤ 64KB, may be empty |
| `payload_ref` | String | topic/partition/offset when body withheld |
| `chain_seq` | UInt64 | per (tenant, day) |
| `chain_hash` | FixedString(64) | |

Skip/bloom indexes: `resource_urn` (tokenbf), `actor_id`, `via_agent_id`, `trace_id`. Materialized views: `audit_by_actor`, `audit_by_agent`, `audit_by_urn_prefix`. Retention: 7y TTL post-export-verification. DDL sketch:

```sql
CREATE TABLE audit_events (
  event_id UUID, event_type LowCardinality(String), source_topic LowCardinality(String),
  tenant_id UUID, actor_type Enum8('user'=1,'service'=2,'agent'=3), actor_id String,
  via_agent_id String, via_agent_version String, obo_user_id String,
  resource_urn String, resource_service LowCardinality(String), resource_type LowCardinality(String),
  action LowCardinality(String), occurred_at DateTime64(3), ingested_at DateTime64(3),
  trace_id String, payload_digest FixedString(64), payload_json String CODEC(ZSTD(3)),
  payload_ref String, chain_seq UInt64, chain_hash FixedString(64),
  INDEX ix_urn resource_urn TYPE tokenbf_v1(8192,3,0) GRANULARITY 4,
  INDEX ix_actor actor_id TYPE bloom_filter GRANULARITY 4,
  INDEX ix_agent via_agent_id TYPE bloom_filter GRANULARITY 4,
  INDEX ix_trace trace_id TYPE bloom_filter GRANULARITY 4
) ENGINE = ReplicatedReplacingMergeTree(ingested_at)
PARTITION BY toYYYYMM(occurred_at)
ORDER BY (tenant_id, occurred_at, event_id)
TTL toDateTime(occurred_at) + INTERVAL 7 YEAR;
```

Postgres: `chain_heads (tenant_id, date, head_hash, events_count, sealed_at)` UNIQUE(tenant_id,date) · `export_manifests (tenant_id, date, revision, uri, manifest_sha256, status pending|sealed|supplemented)` · `async_jobs (id, kind, params_digest, status, result_uri)` · `dlq_redrives (id, topic, count, actor, reason)`.

**State machine — daily batch:** `open → exported → sealed → (late events) supplemented → sealed` ; guard: seal requires manifest hash verification; supplement never mutates prior objects.

## 5. API specification

Base `/api/v1`. All endpoints admin-only per §3 actions; every call audited.

| Method & path | Purpose | Errors |
|---|---|---|
| `GET /audit/search` | filtered search (AUD-FR-030) | `VALIDATION_FAILED` (range > 92d, no range), `PERMISSION_DENIED` |
| `GET /audit/agent-activity` | dual-attribution convenience | same |
| `GET /audit/events/:event_id` | single record + verification | `NOT_FOUND` |
| `POST /audit/verify` | chain verification for tenant+date | `NOT_FOUND` (unsealed day → `CONFLICT`) |
| `GET /exports` | sealed WORM batches + signed URLs | `PERMISSION_DENIED` |
| `POST /compliance/soc2-pack` | async evidence pack → `202 {operation_id}` | `VALIDATION_FAILED` |
| `POST /compliance/ai-decision-log` | async EU AI Act pack → `202` | `VALIDATION_FAILED` |
| `GET /operations/:id` | async job status/result URL | `NOT_FOUND` |
| `POST /admin/dlq/redrive` | redrive DLQ (platform operator) | `PERMISSION_DENIED` |

Example — search request/response:
```
GET /api/v1/audit/search?actor_id=u-77&via_agent_id=triage-copilot
    &from=2026-07-01T00:00:00Z&to=2026-07-08T23:59:59Z&limit=50
```
```json
{"data":[
 {"event_id":"018f…","event_type":"case.assigned","tenant_id":"t-42",
  "actor":{"type":"user","id":"u-77"},"via_agent":{"agent_id":"triage-copilot","version":"1.4.0"},
  "resource_urn":"wr:t-42:case:case/c-123","action":"case.case.assign",
  "occurred_at":"2026-07-08T10:31:22.114Z","trace_id":"4bf9…",
  "payload_digest":"9c1e…","payload":{"assignee":"u-91"},"chain_seq":18231}],
 "page":{"next_cursor":"…","has_more":true}}
```

Example — verify response:
```json
POST /api/v1/audit/verify {"tenant_id":"t-42","date":"2026-07-08"}
→ {"valid":true,"events_checked":183211,"chain_head":"9f3c…",
   "manifest_match":true,"duration_ms":8410}
```

## 6. Events

**Emitted** (`audit.events.v1` — meta-audit only; audit-service does not re-emit consumed events): `audit.searched` (filter digest, actor), `audit.export_sealed` (tenant, date, manifest hash), `audit.integrity_violation` (tenant, date, first_mismatch_seq), `audit.pii_rejected` (source service, event_type), `audit.dlq_redriven`.

**Consumed:** all `*.events.v1` + `ai.tool_invoked.v1` + `ai.agent_run.v1` + `ai.proposal.v1`. Handler: envelope-validate → PII-gate → digest → chain → insert → (idempotent, replay-safe). Consumption is at-least-once; dedup per AUD-FR-004.

## 7. Business rules & edge cases

- **BR-1** Audit ingest must never block producers: it is a plain consumer; backpressure manifests as lag, never as producer failures.
- **BR-2** Chain ordering uses ingest sequence, not `occurred_at` (events may arrive out of order); the manifest records both min/max occurred_at and seq range, so verification is deterministic.
- **BR-3** A late event for an already-sealed day appends to the current open day's chain with `original_date` noted in payload_ref semantics, and triggers a supplement export for the original date — sealed objects are never rewritten.
- **BR-4** Cross-tenant search is impossible for tenant tokens by construction (tenant_id predicate injected from JWT); platform break-glass access requires `typ=user` + `audit.breakglass` scope and emits `audit.searched` with `breakglass=true`.
- **BR-5** Schema Registry unavailable: ingest continues using last-cached schemas; unknown event types fall to pattern-scan path (AUD-FR-070); nothing is dropped silently.
- **BR-6** ClickHouse unavailable: consumer pauses (offset not committed), buffering stays in Kafka (retention ≥ 7 days on all consumed topics is a platform requirement this service depends on).
- **BR-7** Duplicate `event_id` with differing `payload_digest` (producer bug) is stored once, flagged `audit.digest_conflict` metric, and the second variant goes to DLQ for investigation.
- **BR-8** Search result export includes only envelope + PII-clean payloads; `payload_ref`-only rows export without body and are marked `body_withheld=true`.
- **BR-9** Verification of a day currently being supplemented returns `CONFLICT` until re-sealed.
- **BR-10** Concurrency: one chain writer per (tenant, day) — Kafka partitioning by tenant_id guarantees this within a consumer group; rebalances checkpoint `chain_seq`/`chain_hash` in Postgres before partition handoff.
- **BR-11** Adding a new domain topic: the regex subscription picks it up automatically; a synthetic canary event per topic per hour verifies end-to-end ingest (missing canary → alert), so silent subscription gaps are impossible.
- **BR-12** Tenant offboarding: audit data is retained for the full 7y regardless of tenant deletion (contractual/legal basis documented); the tenant's WORM prefix is excluded from any deletion tooling by bucket policy.
- **BR-13** GDPR/erasure interplay: because payloads are PII-free by construction (AUD-FR-070) and reference subjects only by opaque IDs/URNs, erasure requests are satisfied upstream (identity-service key mapping), never by mutating the audit trail.
- **BR-14** Async compliance packs cap at 100M source rows; larger periods must be split — the API returns `VALIDATION_FAILED` with the suggested maximum range.

## 8. Dependencies

| Direction | Party | Contract |
|---|---|---|
| Upstream (Kafka in) | every event-producing service | master envelope (MASTER-FR-031) + PII-clean payload schemas in Schema Registry; ≥ 7-day topic retention (hard prerequisite this BRD imposes platform-wide) |
| Upstream | Schema Registry | envelope + per-event payload schemas with `pii` annotations |
| Upstream | identity-service | JWKS for API auth; OPA sidecar for authz |
| Downstream | bff-graphql | `/audit/search`, `/audit/agent-activity` for `/admin/audit` screens |
| Downstream | compliance consumers / auditors | signed WORM URLs, evidence packs |
| Peer | eval-service | reads proposal decisions from source topics directly (not via audit) |

**Infra:** ClickHouse cluster (3+ replicas), Postgres (metadata), Kafka, Redis (dedup pre-filter, chain counters), object storage with object-lock/immutability enabled per cloud (S3 Object Lock compliance mode / Azure immutable blob policy / GCS bucket lock), Temporal or cron for export/verification jobs. **MCP facade:** none in v1 (audit search is deliberately not exposed to agents).

**Delivery-specific (beyond MASTER-FR-072):** RUNBOOK.md must cover: DLQ triage/redrive, chain-checkpoint recovery after unclean shutdown, re-export/supplement procedure, integrity-violation incident response (P1 path), and ClickHouse replica rebuild from Kafka + WORM.

## 9. NFRs (deltas from master)

- Ingest: 100K events/s per cell; publish→queryable p95 ≤ 30s.
- Search p95 ≤ 2s for a 31-day tenant-scoped query over 100M rows (analytical delta from 300ms).
- Durability: zero audit-event loss tolerated post-ack (RPO 0 for acked offsets; Kafka is the recovery buffer).
- Storage budget: ≤ 200 bytes/event amortized in ClickHouse (columnar + zstd).

## 10. Acceptance criteria

- **AC-1** Given a `dataset.created` event on `dataset.events.v1`, when ingested, then it is queryable via `/audit/search?resource_urn=…` within 30s with all envelope columns populated and a valid `payload_digest`.
- **AC-2** Given the same event replayed, when ingested, then search returns exactly one row for its `event_id` and the chain contains it once.
- **AC-3** Given an event whose payload contains an email address and no registered PII-clean schema, when ingested, then `payload_json` is empty, `payload_digest` is set, `payload_ref` points to the source offset, and an `audit.pii_rejected` event names the producing service.
- **AC-4** Given a malformed envelope (missing `tenant_id`), when ingested, then after 5 retries it lands on the consumer DLQ with reason `ENVELOPE_INVALID` and a DLQ-depth alert fires within 15 min.
- **AC-5** Given a sealed day for tenant T, when `POST /audit/verify {tenant_id:T, date}` runs, then it returns `valid=true` with `events_checked` equal to the manifest row count; and given any stored row's payload_digest is altered in a test copy, verification returns `valid=false` with the correct `first_mismatch_seq`.
- **AC-6** Given yesterday's events for tenant T, when the daily export job completes, then object storage contains Parquet files + `manifest.json` under object-lock, the manifest's per-file SHA-256 values match the objects, and the manifest embeds the day's chain head and previous manifest hash.
- **AC-7** Given agent `triage-copilot` performed 3 OBO actions for user u-77 and 2 autonomous actions, when `/audit/agent-activity?agent_id=triage-copilot&obo_user_id=u-77` is called, then exactly 3 rows return; with `include_autonomous=true`, 5 rows.
- **AC-8** Given proposals approved, rejected (with reason), and edited during a window, when the AI decision-log pack is generated, then it contains one row per decision with decision actor, timestamp, and rejection reason/edit digest, and re-running with identical params yields byte-identical CSVs.
- **AC-9** Given tenant A's security-admin token, when it searches with any filter, then only tenant A rows return; a direct `GET /audit/events/:id` for a tenant-B event returns `404` and emits `security.cross_tenant_denied`.
- **AC-10** Given a search or export by any admin, when it executes, then an `audit.searched` meta-event exists with the actor and filter digest.
- **AC-11** Given a consumer-group rebalance mid-day, when ingestion resumes on another instance, then `chain_seq` continues without gaps or duplicates (verified by the chain verifier over that day).
- **AC-12** Given a 10× event spike (100K events/s sustained for 10 min in staging), when it subsides, then ingest lag returns under 30s within 15 min and no events are lost (source-count vs stored-count reconciliation matches).
- **AC-13** Given a new topic `foo.events.v1` appears matching the subscription regex, when its first event publishes, then it is ingested with zero deploys and the hourly canary for the topic reports healthy.
- **AC-14** Given a search filtered only by `trace_id`, when executed, then all events across services sharing that trace return in occurred_at order within the 2s p95 budget.
- **AC-15** Given a DLQ'd envelope-invalid event whose producer is fixed, when `POST /admin/dlq/redrive` runs, then the event ingests successfully, appears in the current day's chain, and an `audit.dlq_redriven` meta-event records the redrive actor and count.

## 11. Out of scope / future

SIEM streaming connectors (Splunk/Chronicle) — consumers can tap Kafka directly in the interim; legal-hold case-management UI (WORM export supports manual holds v1); payload-content search (only digest equality in v1); cryptographic external anchoring (public transparency log / RFC 3161 timestamping) beyond manifest chaining; per-field lineage of PII references; cross-cell federated audit search; auditor self-service portal (packs are delivered via signed URLs v1).
