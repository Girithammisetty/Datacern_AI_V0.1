# BRD 15 — memory-service

**Service:** memory-service · **Language:** Python 3.12 (FastAPI + async workers) · **Phase:** 4 (session+user scopes land with Phase 4 agents; workspace/tenant scopes + full RAG corpora Phase 5)
**Inherits:** `00_MASTER_BRD.md`. Architecture refs: `WINDROSE_PLATFORM_ARCHITECTURE.md` §8.7, §9.1, §10.3; `WINDROSE_V3_AGENTIC_ARCHITECTURE.md` §5.7.

---

## 1. Overview

**Purpose.** memory-service is the governed store for everything agents remember and retrieve: **scoped memories** (session → user → workspace → tenant) and **RAG corpora** (CDC-fed collections of schemas, dashboards, resolved cases, docs). It owns the write path (injection screening before persist, dedup/merge), the retrieval API (scope-filtered, hard tenant filter, top-k + recency blend), corpus chunking/embedding pipelines (embeddings via ai-gateway), right-to-erasure cascades (≤ 24h SLA with verification report), retention/expiry jobs, and tenant-facing memory browsing/admin APIs.

**Business value.** Fixes the deployed agent's "no memory" gap (chat-agent-service passes history inline per request) with governance built in from day one: provenance on every record, TTLs per scope, poisoning defense, and GDPR erasure — so agent memory is an asset, not a liability. RAG over resolved cases is the grounding for the highest-value agent (case-triage copilot).

**In scope:** memory record model + scopes; storage (session→Redis; user/workspace/tenant→Postgres+pgvector schema-per-tenant); write path with injection screening + dedup/merge; retrieval API; RAG corpus management (registration, CDC ingestion, chunking, embedding, refresh); right-to-erasure; retention/expiry/re-validation jobs; browsing/admin APIs; confidence lifecycle.
**Out of scope:** which memories an agent *chooses* to write/read (agent graphs, BRD 14 — the runtime declares `memory_policy` per agent version; this service enforces it); embedding model hosting (ai-gateway); semantic-layer definitions (semantic-service — a RAG corpus may index them, it never defines them); the dedicated Qdrant scale tier (upgrade path documented, not built now).

## 2. Actors & user stories

Personas: **Agent Runtime** (sole write/read path for agents), **End User**, **Tenant Admin**, **Data Protection Officer (DPO)**, **Platform Operator**, **CDC Pipeline** (Kafka consumers).

- **US-1** As the agent-runtime, at the end of an analytics session I persist a user-scope memory "prefers quarterly granularity, EMEA region focus" with provenance `{run_id, agent:analytics@v14}` so the next session starts smarter.
- **US-2** As the agent-runtime, before answering a triage question I retrieve top-8 memories across `[session, user, workspace]` scopes plus top-5 chunks from the `resolved-cases` corpus, in a single call, tenant-hard-filtered.
- **US-3** As an End User, I can view every memory the platform holds about me and delete any of them, immediately affecting future agent behavior.
- **US-4** As a Tenant Admin, I browse workspace/tenant-scope memories, correct or delete wrong ones, and set per-scope TTL policies within platform bounds.
- **US-5** As a DPO, when a user invokes right-to-erasure, all their memories and user-attributable RAG chunks are provably gone within 24h, and I receive a verification report.
- **US-6** As the CDC pipeline, when a case is resolved, a chunk of its (anonymized) resolution narrative lands in the `resolved-cases` corpus within 5 minutes, embedded and retrievable.
- **US-7** As a Security Engineer, a prompt-injection payload smuggled into a tool output cannot be persisted as a memory — the write path screens and quarantines it.
- **US-8** As the agent-runtime, duplicate learnings ("user prefers USD" written 30 times) are merged, not accumulated, so retrieval stays sharp and storage bounded.
- **US-9** As a Platform Operator, I register a new corpus (`docs`) with its source topic, chunking config, and embedding model, and re-embed it when the embedding model version bumps.
- **US-10** As the eval-service, I can pin retrieval to a corpus snapshot version so eval runs are reproducible.
- **US-11** As a Tenant Admin, low-confidence memories that were never retrieved within their re-validation window expire automatically — my agents don't act on stale beliefs.
- **US-12** As the agent-runtime, session-scope working memory (scratch context, tool-result digests) lives in Redis with the session and is wiped at termination per BRD 14's sanitization contract.

## 3. Functional requirements

### Record model & scopes
- **MEM-FR-001 (Must)** MemoryRecord: `{memory_id uuidv7, tenant_id, scope: session|user|workspace|tenant, scope_ref (session_id | user_id | workspace_id | tenant_id), content text (≤ 8KB), embedding vector, provenance {source_type: agent_run|user_explicit|tool_output|admin, run_id?, agent_key?, agent_version?, user_id?, tool_id?}, confidence float 0–1, ttl_expires_at, revalidate_at, tags text[] (≤ 16), status: active|quarantined|expired|deleted, retrieval_count, last_retrieved_at}`.
- **MEM-FR-002 (Must)** Storage by scope: **session** → Redis only (hash per session, TTL = session lifetime + 1h, no embedding required, wiped on BRD 14 sanitization call); **user/workspace/tenant** → Postgres + pgvector, **schema-per-tenant** (`mem_t_<tenant_id>`), embeddings computed via ai-gateway `embed` class at write time.
- **MEM-FR-003 (Must)** Default TTLs (platform bounds, tenant-tunable within them): session = session lifetime; user = 180d (max 400d); workspace = 365d; tenant = 730d. Every record MUST have a TTL; "no expiry" is not representable.
- **MEM-FR-004 (Must)** Scope caps: max active records per scope_ref — user 2,000; workspace 10,000; tenant 20,000. At cap, writes evict lowest (confidence × recency) records after merge attempt (BR-4).

### Write path
- **MEM-FR-010 (Must)** `POST /api/v1/memories` (agent-runtime via mTLS + run's token, or user JWT for `user_explicit`). Pipeline, strict order: (1) authz — writer's agent version `memory_policy.scopes_writable` must include the scope; users may write only their own user scope; (2) **injection screening** — content passes the injection/poisoning classifier (same model family as ai-gateway's, threshold configurable); score ≥ block threshold → record stored as `quarantined` (not retrievable), audit event; (3) PII policy — content scanned; disallowed PII classes per tenant policy are rejected (`PII_REJECTED`) — memories reference URNs, not raw sensitive values; (4) **dedup/merge** — embed content, search same scope_ref for similarity ≥ 0.92: if found, **merge** (keep older memory_id, union tags, max confidence, refresh TTL, append provenance entry, replace content if new confidence higher) instead of insert; (5) persist + emit `memory.written`.
**Write pipeline (normative order):**
```
write → authz (scope writable by caller) → injection screening (block→quarantine)
      → PII policy scan (reject disallowed classes) → embed (ai-gateway, batched)
      → dedup search (same scope_ref, sim ≥ 0.92) → merge | insert
      → cap check (evict per BR-4 if needed) → persist + outbox → memory.written
```

- **MEM-FR-011 (Must)** Batch write (`POST /memories/batch`, ≤ 50) with per-item results; used at session termination for end-of-session distillation.
- **MEM-FR-012 (Must)** Every write is attributed (provenance mandatory, validated: `agent_run` sources must reference a real run of the calling principal).
- **MEM-FR-013 (Should)** Confidence defaults: user_explicit 0.95; agent_run 0.7; tool_output 0.6. Retrieval hits raise confidence (+0.02, cap 0.99) via async counter; re-validation lowers it (BR-7).

### Retrieval
- **MEM-FR-020 (Must)** `POST /api/v1/retrieve`: `{query_text | query_embedding, scopes[] (subset of caller's readable scopes), scope_refs (server-verified: user scope_ref must equal OBO user; workspace must be a workspace the OBO user belongs to), corpora[]?, top_k ≤ 24 per source, min_confidence?, tags?}` → ranked results `{content, score, scope, memory_id|chunk_id, provenance, corpus?, source_urn?}`.
- **MEM-FR-021 (Must)** **Hard tenant filter:** every query executes inside the tenant schema (search_path pinned per request from JWT tenant) AND carries `tenant_id` predicate — two independent layers; cross-tenant retrieval is structurally impossible and covered by the isolation suite.
- **MEM-FR-022 (Must)** Ranking = `w_sim × cosine_similarity + w_rec × recency_decay(half_life per scope) + w_conf × confidence` (default 0.65/0.2/0.15, per-corpus/per-scope tunable). Quarantined/expired/deleted records never surface.
- **MEM-FR-023 (Must)** Retrieval latency p95 ≤ 120ms for ≤ 24 results across ≤ 3 scopes + 2 corpora (HNSW/ivfflat indexes per tenant schema).
- **MEM-FR-024 (Should)** `include_debug=true` (operator/eval only) returns per-component scores for ranking diagnostics.

### RAG corpora
- **MEM-FR-030 (Must)** Corpus registry: `{corpus_key (schemas|dashboards|resolved_cases|docs|…), tenant-scoped, source: {kind: cdc|api_push, topics[] | none}, chunking {strategy: semantic|fixed, max_tokens, overlap}, embedding_model_ver, refresh: {mode: streaming|scheduled}, anonymization_profile?, status: active|paused|rebuilding}`. Platform ships the four standard corpora; operators may add more.
- **MEM-FR-031 (Must)** CDC ingestion: consumers on `cdc.<service>.<table>` + domain events (`case.events.v1: case.resolved`, `chart.events.v1: dashboard.updated`, `dataset.events.v1: dataset.profiled`, `semantic.events.v1: model.updated`) → transform (per-corpus mapper) → **anonymization** (resolved-cases: Presidio pass + configured field drops before chunking) → chunk → embed (ai-gateway, batched) → upsert chunks keyed `(corpus, source_urn, chunk_seq)`. Source record update/delete ⇒ chunk replace/delete (tombstone handling).
- **MEM-FR-032 (Must)** Chunk model: `{chunk_id, corpus_key, source_urn, chunk_seq, content (≤ 2KB), embedding, source_updated_at, embedding_model_ver, snapshot_ver}`; freshness lag target ≤ 5 min p95 (streaming corpora).
**Standard corpora (shipped with the platform):**

| corpus_key | Sources (events/CDC) | Mapper output (chunk content) | Anonymization | Refresh |
|---|---|---|---|---|
| `schemas` | `dataset.events.v1: dataset.profiled`, `cdc.dataset.dataset_versions` | dataset name/description + column names/types + profile highlights (row counts, distincts) | none (metadata only) | streaming |
| `dashboards` | `chart.events.v1: dashboard.updated`, `cdc.chart.dashboards` | dashboard title/description + chart titles + semantic measure/dimension refs | none | streaming |
| `resolved_cases` | `case.events.v1: case.resolved` | resolution narrative + disposition + evidence summary + case-type features | Presidio pass + configured field drops (names, free-text identifiers) **before** chunking | streaming |
| `docs` | api_push (`POST /corpora/docs/documents`) | tenant-uploaded runbooks/docs, semantic-chunked | Presidio scan (flag, not drop) | on push |

- **MEM-FR-033 (Must)** Re-embedding: embedding model version bump triggers a background rebuild per corpus (dual-write to new version, atomic switch of `active_embedding_ver`, old vectors dropped after switch); retrieval never mixes embedding versions.
- **MEM-FR-034 (Should)** Corpus snapshots: nightly `snapshot_ver` tag enabling eval-service pinning (retrieval with `snapshot_ver=` serves only chunks ≤ that version's cut).

### Right-to-erasure & retention
- **MEM-FR-040 (Must)** `POST /api/v1/erasure {subject_type: user, subject_id}` (DPO/tenant-admin or automatic on `identity.events.v1: user.deleted`) starts a Temporal erasure workflow: (1) hard-delete all user-scope memories of the subject; (2) hard-delete/redact memories in any scope whose provenance references the subject where content is user-attributable (provenance user_id match + content re-scan); (3) delete RAG chunks whose source_urn is user-attributable or whose anonymization profile marks user-derived fields (e.g., case comments authored by the user → re-chunk source without their content); (4) purge Redis session memories; (5) verify — re-run subject-linked queries across all stores, assert zero hits; (6) produce a signed **verification report** `{request_id, counts_deleted per store, verification_queries, completed_at}` retained 7y (audit export). **SLA ≤ 24h** end-to-end; breach alerts.
**Erasure workflow steps (Temporal activities, each idempotent and individually retried):**

| # | Activity | Store | Verification probe |
|---|---|---|---|
| 1 | delete user-scope memories (subject as scope_ref) | Postgres tenant schema | count by scope_ref = 0 |
| 2 | delete/redact provenance-linked memories in other scopes | Postgres | provenance user_id hits = 0 |
| 3 | delete/re-chunk user-attributable RAG chunks | Postgres (chunks) + source re-fetch | source_urn linkage scan = 0 |
| 4 | purge session-scope entries | Redis | SCAN by subject = 0 |
| 5 | verification sweep (re-run all probes + sampled embedding-space search on subject identifiers) | all | all probes green |
| 6 | sign + store report; emit `erasure.completed` | Postgres + audit WORM | report retrievable |

- **MEM-FR-041 (Must)** Retention jobs (hourly): expire records past `ttl_expires_at` (status→expired, hard-delete after 30-day grace); enforce scope caps; purge quarantined records after 90d (kept for security forensics until then).
- **MEM-FR-042 (Must)** Re-validation job (daily): records past `revalidate_at` (default: 50% of TTL) with `retrieval_count=0` since last validation → confidence −0.15; confidence < 0.3 → expired. Records with recent retrievals get `revalidate_at` pushed out.

### Browsing & admin
- **MEM-FR-050 (Must)** Browsing APIs (paginated, filterable by scope/tags/provenance/status): users see their user-scope records (`GET /memories?scope=user`); tenant admins see workspace/tenant scopes (+ user scope only with explicit `tenant_dpo` role); edit content (re-embeds, resets provenance to `admin`), delete (immediate hard delete), un-quarantine (security role, reason required).
- **MEM-FR-051 (Must)** Tenant memory policy API: per-scope TTL overrides (within platform bounds), PII rejection classes, injection threshold profile, corpus enable/disable per tenant.
- **MEM-FR-052 (Should)** Stats API: per-scope record counts, growth, merge rate, quarantine rate, top tags — feeds tenant admin console.

## 4. Domain model & data

Postgres `memory` DB. **Tenant data lives in per-tenant schemas** `mem_t_<tenant>` (created by tenant-provisioning consumer); control tables in `public` with RLS. Standard columns everywhere.

| Table (schema) | Key columns | Indexes / notes |
|---|---|---|
| `memories` (per-tenant) | scope enum, scope_ref, content text, embedding vector(1536), provenance jsonb (≤2KB, documented), confidence real, ttl_expires_at, revalidate_at, tags text[], status enum, retrieval_count int, last_retrieved_at, merged_from uuid[] | HNSW (embedding) partial WHERE status='active'; idx (scope, scope_ref, status); idx ttl_expires_at; idx GIN tags |
| `rag_chunks` (per-tenant) | corpus_key, source_urn, chunk_seq, content, embedding vector(1536), embedding_model_ver, snapshot_ver, source_updated_at | HNSW per corpus (partial by corpus_key + active ver); unique (corpus_key, source_urn, chunk_seq, embedding_model_ver); idx source_urn |
| `corpora` (public) | corpus_key, tenant_id, source jsonb, chunking jsonb, active_embedding_ver, refresh jsonb, anonymization_profile jsonb, status | unique (tenant_id, corpus_key) |
| `tenant_policies` (public) | ttl_overrides jsonb, pii_classes text[], injection_profile, corpus_flags jsonb | unique (tenant_id) |
| `erasure_requests` (public) | subject_type, subject_id, status enum(received,running,verifying,completed,failed), temporal_workflow_id, report jsonb (≤64KB), completed_at | idx (tenant_id, status); retention 7y (report exported to audit WORM) |
| `write_audit` (public) | memory_id, action enum(write,merge,quarantine,edit,delete,expire), actor, reason?, trace_id | partitioned by month; retention 25 months |
| `outbox` (public) | standard | |

Redis: `mem:sess:<tenant>:<session_id>` hash (session scope), TTL-managed; `mem:policy:<tenant>` cache.

**State machines.**
- MemoryRecord: `active → expired` (TTL/re-validation) → hard-deleted (30d grace); `→ quarantined` (screening) → `active` (security un-quarantine) | hard-deleted (90d); `→ deleted` (user/admin/erasure, immediate hard delete). Merge is an update on the surviving record, never a state change.
- ErasureRequest: `received → running → verifying → completed | failed(retryable via Temporal)`; guard: `completed` requires verification queries returning zero hits.
- Corpus: `active ↔ paused`; `active → rebuilding → active` (re-embed switch is atomic on `active_embedding_ver`).

**Index & retention summary.**

| Table | Hot-path indexes | Partitioning / retention |
|---|---|---|
| `memories` (per-tenant) | HNSW(embedding) partial status='active'; (scope, scope_ref, status); ttl_expires_at; GIN(tags) | none / TTL-driven + 30d grace; quarantined 90d |
| `rag_chunks` (per-tenant) | HNSW(embedding) partial (corpus, active ver); (corpus_key, source_urn, chunk_seq, ver) unique | none / replaced on source change; dropped on ver switch |
| `erasure_requests` | (tenant_id, status) | none / 7y (report exported to WORM) |
| `write_audit` | (tenant_id, created_at) | monthly / 25 months |

**Redis keyspace.** `mem:sess:{tenant}:{session_id}` session-scope hash (TTL = session lifetime + 1h) · `mem:policy:{tenant}` policy cache (push-invalidated) · `mem:pend` pending-embed queue (BR-2, capped 1h).

**Tenant memory policy example:**
```json
PUT /api/v1/policies/self
{"ttl_overrides": {"user": "P90D", "workspace": "P365D"},
 "pii_classes": ["CREDIT_CARD", "SSN", "IBAN"],
 "injection_profile": "strict",
 "corpus_flags": {"docs": true, "resolved_cases": true}}
```

## 5. API specification

Base `/api/v1`. Agents call via agent-runtime with OBO/agent tokens (memory-service verifies `memory_policy` claims embedded in the runtime-forwarded context token); humans via user JWT.

| Method & path | Purpose | Auth | Notable errors |
|---|---|---|---|
| `POST /memories` · `POST /memories/batch` | write (screened, deduped) | runtime mTLS + run token; user JWT (user scope) | 403 SCOPE_DENIED, 422 PII_REJECTED, 200-with-status `quarantined` |
| `POST /retrieve` | scoped memory + corpus retrieval | runtime / user JWT | 403 SCOPE_DENIED, VALIDATION_FAILED |
| `GET /memories?scope=&filter[tags]=&filter[status]=` | browse (paginated) | user (own), tenant admin/DPO | — |
| `PATCH /memories/:id` · `DELETE /memories/:id` | edit / hard delete | owner user / tenant admin | 404 |
| `POST /memories/:id/unquarantine` | restore quarantined | security role | reason required |
| `POST /erasure` · `GET /erasure/:id` | right-to-erasure + report | DPO/tenant admin/system | 202 {operation_id} |
| `GET/PUT /policies/self` | tenant memory policy | tenant admin | 422 (outside platform bounds) |
| `POST /corpora` · `PATCH /corpora/:key` · `POST /corpora/:key/rebuild` | corpus admin | operator (platform corpora), tenant admin (enable/disable) | 409 (rebuild in progress) |
| `GET /corpora/:key/status` | freshness lag, chunk counts, snapshot vers | operator/tenant admin | — |
| `DELETE /sessions/:session_id/memory` | session-scope wipe (BRD 14 sanitization hook) | runtime mTLS | idempotent 204 |
| `GET /stats` | per-scope stats | tenant admin | — |

**Example — retrieve request/response:**
```json
POST /api/v1/retrieve
{"query_text": "how were similar duplicate-invoice cases resolved?",
 "scopes": ["user", "workspace"], "corpora": ["resolved_cases"], "top_k": 8}
→ 200 {"data": [
 {"kind": "chunk", "corpus": "resolved_cases", "chunk_id": "…", "score": 0.87,
  "content": "Case resolved as duplicate-vendor-entry; disposition=confirmed…",
  "source_urn": "wr:t-42:case:case/c-7f1", "snapshot_ver": "2026-07-08"},
 {"kind": "memory", "scope": "user", "memory_id": "…", "score": 0.71,
  "content": "User triages EMEA invoice cases; prefers evidence-first summaries",
  "provenance": {"source_type": "agent_run", "agent_key": "case-triage", "run_id": "…"}}]}
```

## 6. Events

**Emitted** (`memory.events.v1`):
- `memory.written {memory_id, scope, provenance.source_type, merged: bool}` · `memory.quarantined {classifier_score}` · `memory.deleted|expired {reason}` · `memory.edited`.
- `erasure.completed {subject_id digest, counts, report_ref}` · `erasure.sla_breached`.
- `corpus.chunk_upserted` (sampled/metrics only, not per-chunk fan-out), `corpus.rebuild_started|completed`, `corpus.freshness_degraded {lag_s}`.

**Consumed:**
- `identity.events.v1`: `tenant.provisioned` → create tenant schema + default policies + standard corpora rows; `user.deleted` → auto-start erasure workflow; `tenant.deleted` → schema drop workflow (after retention hold).
- `case.events.v1: case.resolved` → resolved-cases corpus mapper; `chart.events.v1`, `dataset.events.v1`, `semantic.events.v1` per corpus source config; `cdc.*` topics as registered.
- `agent.events.v1: session.terminated|expired` → defensive session-memory wipe (belt-and-braces with the sync hook).

## 7. Business rules & edge cases

- **BR-1** Fail-closed writes: if the injection classifier is unavailable, writes are **rejected** (`SCREENING_UNAVAILABLE`, 503), never persisted unscreened; retrieval remains available (read path independent).
- **BR-2** Embedding outage (ai-gateway down): memory writes queue in the outbox-style pending table (≤ 1h, then fail); retrieval falls back to recency+tag ranking over scope with `degraded: true` in the response envelope — never silent quality loss.
- **BR-3** Session scope never touches pgvector: no embeddings, no persistence beyond Redis TTL; distillation to durable scopes is an explicit runtime write at termination, subject to the full write pipeline.
- **BR-4** Cap eviction picks candidates by `confidence × exp(−age/half_life)` ascending, skips records retrieved in the last 7 days; eviction emits `memory.expired {reason: cap}`.
- **BR-5** Merge conflicts: concurrent writes with similarity ≥ 0.92 both matching the same target serialize on a per-scope_ref advisory lock; merge is idempotent (re-merge of identical content is a no-op that refreshes TTL).
- **BR-6** Contradiction handling: similarity in 0.75–0.92 with opposing polarity is *not* merged; both persist and ranking surfaces the newer/higher-confidence one; re-validation decays the loser. (Semantic contradiction detection is Future.)
- **BR-7** A memory whose provenance run is later marked as a failed/poisoned run (security event `run.flagged`) is auto-quarantined by consumer.
- **BR-8** Erasure vs. legal hold: tenants under audit hold (flag from audit-service) still erase content but the verification report records the hold; WORM audit copies are out of scope of erasure by design (documented lawful basis).
- **BR-9** Anonymized chunks are irreversibly anonymized *before* embedding — erasure of the anonymization subject does not require chunk deletion where no user linkage remains; the erasure verifier proves non-linkage by provenance, not by content guesswork (URN-based).
- **BR-10** Cross-workspace leakage: workspace scope_ref membership is validated against the rbac projection at *retrieval time* (not write time) — a user removed from a workspace immediately loses retrieval to its memories.
- **BR-11** Corpus rebuild backpressure: rebuild embedding batches are rate-limited to the platform system budget (BRD 12) and yield to live traffic; rebuild of the largest corpus (resolved-cases at 100M-case tenants) must sustain ≥ 500 chunks/s without degrading retrieval p95.
- **BR-12** Retrieval result content is data, not instructions: responses include `content_disposition: untrusted` so the runtime wraps chunks in guarded prompt sections (contract with BRD 14; poisoning defense layer 2).
- **BR-13** Idempotency: writes accept `Idempotency-Key` (MASTER-FR-025); CDC upserts are naturally idempotent by chunk key.
- **BR-14** Tenant schema creation failure during provisioning → provisioning workflow retries; memory-service readiness for a tenant is gated (`GET /readyz?tenant=` used by provisioning verification).
- **BR-15** `user_explicit` writes ("remember that I …" surfaced by the agent as a confirmed memory action) still pass injection screening and PII policy — user intent does not bypass governance; the user is told when content was rejected and why.
- **BR-16** Recency half-lives (ranking): session n/a · user 30d · workspace 90d · tenant 180d — decay constants are per-scope config, documented so ranking changes are reviewable.
- **BR-17** Chunk content caps: any single source producing > 2,000 chunks (runaway dashboard/doc) is truncated at the cap with `corpus.freshness_degraded {reason: chunk_cap}` — protects index quality and rebuild time.
- **BR-18** Snapshot retention: nightly snapshots kept 35 days; eval pins to older snapshots fail with `SNAPSHOT_EXPIRED` (eval-service re-baselines rather than serving unreproducible results).

## 8. Dependencies

- **Calls:** ai-gateway (`embed` class — all embeddings; injection classifier via gateway guardrail endpoint or co-packaged model, pinned either way), identity-service (JWKS), rbac Redis projection (workspace membership at retrieval).
- **Consumed by:** agent-runtime (write/retrieve/sanitize), eval-service (snapshot-pinned retrieval), ui-web memory browser via bff.
- **Consumes:** Kafka CDC + domain events per §6; Temporal (erasure + rebuild workflows).
- **Infra:** Postgres + pgvector (schema-per-tenant), Redis, Kafka, Temporal, OPA sidecar, Vault. Upgrade path: Qdrant per-tenant collections at scale tier (retrieval API is store-agnostic; store adapter interface required in implementation).

## 9. NFRs (deltas from master)

| Metric | Target |
|---|---|
| Retrieval p95 (≤3 scopes + 2 corpora, top-24) | ≤ 120ms |
| Write path p95 (incl. screening + embed) | ≤ 800ms; batch of 50 ≤ 5s |
| CDC → retrievable chunk lag p95 | ≤ 5 min |
| Erasure SLA | ≤ 24h end-to-end, verification included |
| Session wipe after sanitization hook | ≤ 60s |
| Scale | 10K memory writes/min per cell; 200 retrievals/s per cell; 50M chunks per tenant schema before Qdrant tier |
| Isolation | schema-per-tenant + tenant predicate (two layers); zero cross-tenant retrievals (release gate) |

## 10. Acceptance criteria

- **AC-1** Given the runtime writes a user-scope memory with valid provenance, When written, Then it is embedded, persisted in `mem_t_<tenant>`, retrievable in the same scope within 2s, and a `memory.written` event is emitted.
- **AC-2** Given a write whose content contains a known injection payload (test corpus), When submitted, Then it persists as `quarantined`, never appears in any retrieval, emits `memory.quarantined`, and appears in the security browse view with its classifier score.
- **AC-3** Given "user prefers USD currency" is written twice (verbatim) and once paraphrased at similarity ≥ 0.92, When written, Then exactly one active record exists with refreshed TTL, merged provenance entries, and `merged_from` populated.
- **AC-4** Given identical retrieve queries from tenant A and tenant B where only tenant A has matching data, Then tenant B receives zero results; direct SQL inspection confirms the query executed in `mem_t_B` only (isolation suite; runs per release).
- **AC-5** Given a retrieval across `[user, workspace]` + `resolved_cases`, Then results are ranked by the blend formula, exclude quarantined/expired records, respect `top_k`, and p95 ≤ 120ms at 200 req/s in the perf suite.
- **AC-6** Given a case transitions to resolved with PII in its narrative, When CDC processes it, Then within 5 min a chunk exists in `resolved_cases` with PII anonymized (Presidio assertions), keyed to the case URN; When the case is later edited, Then chunks are replaced, not duplicated.
- **AC-7** Given a user erasure request for a user with memories in 3 scopes, chunks referencing their authored comments, and an active session, When the workflow completes, Then all are deleted/redacted, Redis session memory is purged, verification queries return zero hits, a signed report with per-store counts exists, and completion is ≤ 24h (clock-asserted in test with compressed timers).
- **AC-8** Given a record past `revalidate_at` with zero retrievals, When the daily job runs, Then confidence drops by 0.15; Given confidence falls below 0.3, Then status becomes `expired` and it stops surfacing; Given a record with recent retrievals, Then `revalidate_at` is extended.
- **AC-9** Given a user removed from workspace W, When they (via agent) retrieve with scope workspace/W, Then 403 SCOPE_DENIED immediately (rbac projection freshness within its 5s SLO).
- **AC-10** Given the embedding model version is bumped and a corpus rebuild is triggered, When it completes, Then retrieval switches atomically to the new vectors (no mixed-version results at any point, verified by version tagging assertions) and old vectors are removed.
- **AC-11** Given ai-gateway embeddings are unavailable, When a retrieval is requested, Then a degraded recency+tag-ranked result returns with `degraded: true`; When a write is requested, Then it is queued and, if the outage exceeds 1h, fails with a clear error — it is never persisted unembedded-and-unscreened.
- **AC-12** Given the BRD 14 sanitization hook `DELETE /sessions/:id/memory`, When invoked (twice), Then session-scope Redis data is gone within 60s and the second call is an idempotent 204.
- **AC-13** Given a tenant admin sets user-scope TTL to 999 days (above the 400d platform bound), Then 422; Given 90 days, Then new writes carry the override and existing records are unaffected.
- **AC-14** Given eval-service retrieves with `snapshot_ver=2026-07-08`, Then only chunks at or before that snapshot are returned, byte-stable across repeated calls while newer chunks continue landing live.
- **AC-15** Given a write at the user-scope cap (2,000 active records), When a non-mergeable new memory arrives, Then the lowest confidence×recency record not retrieved in 7 days is evicted with `memory.expired {reason: cap}`, and the write succeeds.
- **AC-16** Given two memories written at similarity 0.85 with opposing content ("prefers USD" / "prefers EUR"), Then both persist (no merge below 0.92), retrieval ranks the newer/higher-confidence one first, and re-validation decays the unretrieved one over time (BR-6 simulated clock test).
- **AC-17** Given a `run.flagged` security event referencing run R, When consumed, Then every active memory with provenance run_id = R becomes `quarantined` and disappears from retrieval (BR-7).

**Worked ranking example (retrieval debug output):** query "duplicate invoice resolution" → chunk A: sim 0.84, recency 0.9 (2d old, 90d half-life), conf n/a → `0.65×0.84 + 0.20×0.9 + 0.15×0.5(default) = 0.801`; memory B: sim 0.71, recency 0.4, conf 0.9 → `0.65×0.71 + 0.20×0.4 + 0.15×0.9 = 0.677` → A ranks first. `include_debug=true` returns exactly these components.

## 11. Out of scope / future

Qdrant scale-tier implementation (adapter designed now); semantic contradiction detection/resolution between memories; cross-session memory summarization/compaction agents; user-facing "why does the agent know this" explanations beyond provenance display; federated memory across cells; workspace/tenant scope UI beyond browse/edit (analytics on memory usage); memory export API for tenant offboarding (tracked with tenant-deletion program).
