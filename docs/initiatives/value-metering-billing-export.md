# Value metering & billing export — the `governed_decision` meter and a billing export pipeline

**Status:** design — 2026-07-25
**Commits:** — (analysis/design only; no code yet)
**Related:** BRD 67 (`docs/brd/67_value_metering_billing_export_BRD.md`) · BRD 17 §3.8 (`docs/brd/17_usage_service_BRD.md`) · roadmap `docs/DATACERN_COMPETITIVE_LANDSCAPE_AND_GTM_ROADMAP.md` §5 A2 / §6 B2

---

## 1. Analysis

### 1a. Platform / product

Datacern is sold on "per governed decision" pricing (`DATACERN_PARTNER_BRIEFING.md` §6, roadmap §5 A2), but nothing in the code today counts a decision. The meter catalog only knows infra units — tokens, bytes, minutes, API calls. A prospect who asks "what does one approved claim-triage decision cost me" gets no answer usage-service can produce; a finance-ops buyer who wants a monthly invoice has no export to hand a billing system. This is the single biggest gap between the pitch and the product: everything needed to *compute* the answer already flows through the platform (every decision is a Proposal that terminates in approve/edit/reject; every case resolves with a disposition; every LLM call is already metered with tenant/agent dims) — it is simply never counted as a business event, only as infrastructure consumption.

Closing this unlocks three things at once, which is why roadmap §5 A2 calls it "critical, small": (1) the pricing unit becomes real and auditable, not a slide; (2) it is the direct substrate for the ROI dashboard (BRD 69 / roadmap B5 — "governed decisions this month next to cost"); (3) it is the evidence trial-conversion snapshots need (BRD 66 CPL-FR-024). Billing export (roadmap §6 B2) then turns the counted decisions into something an external rating engine (Lago, Stripe Billing/Metronome) can actually invoice against — usage-service still never touches money, it hands over a checksummed, versioned, replayable artifact and lets the billing system do the rest.

Who is affected: Finance-ops today has no month-end billable snapshot at all (no `billing_periods` table exists); Tenant Admins can see infra usage but not "governed decisions this month"; Sales has no cost-per-decision number for renewal conversations. Once this ships, all three read from one usage-service truth instead of three different guesses.

### 1b. Technical

**Meter catalog is infra-shaped only, and why.** The catalog is a hard-coded Go slice:

```go
// services/usage-service/internal/domain/types.go:47-86
const (
    MeterAPICalls            = "api_calls"
    MeterQueryBytesScanned   = "query_bytes_scanned"
    MeterPipelineMinutes     = "pipeline_minutes"
    MeterStorageGBMonth      = "storage_gb_month"
    MeterLLMInputTokens      = "llm_input_tokens"
    MeterLLMOutputTokens     = "llm_output_tokens"
    MeterAgentTasksCompleted = "agent_tasks_completed"
)
func Catalog() []Meter { … }
```

Every entry maps to a `usage.metering.v1`/`query.events.v1`/`pipeline.events.v1`/`ai.token_usage.v1`/`ai.agent_run.v1` source event via a declarative mapping table (`services/usage-service/internal/ingest/mapping.go:49-113`, `ValidateCatalog` at :117-128). `agent_tasks_completed` is the closest thing to a "decision" meter today, and it only counts a *run* finishing, filtered on `status=='succeeded'` (`mapping.go:102-111`) — it says nothing about whether a human approved, edited, or rejected anything. There is no meter keyed on a proposal's terminal decision or a case's resolution. This is exactly BRD 67's diagnosis and it is confirmed, not assumed.

**Where a proposal decision commits, and what events exist today.** `services/agent-runtime/app/proposals/service.py`:
- `decide()` (lines 212–286) is the single commit point for a human decision. The state transition is atomic and race-safe: `self._store.decide_proposal(...)` (line 253) does the actual status flip; if it returns `None` the caller lost the race (BR-12 first-wins, line 256-259) and gets a `Conflict`.
- Immediately after a successful commit, `_emit()` is called (line 285) which builds the envelope and writes to the **transactional outbox** in the same request (`self._store.enqueue_outbox`, `_emit()` body at lines 375-390) before publishing — so "decision commits" and "event queued" are atomic today; there is no separate step to add.
- The topic is `TOPIC_PROPOSAL = "ai.proposal.v1"` (`services/agent-runtime/app/constants.py:24`), **not** `ai.proposal_decided.v1` as BRD 67's VMB-FR-001 table names it — that topic/event type does not exist anywhere in code (confirmed by repo-wide grep). The real terminal event types, built from `new_status` (`decide()` line 283-284), are `proposal.approved`, `proposal.edited_approved`, `proposal.rejected`, `proposal.cancelled` (the `respond` action). The Avro contract for the payload is `services/agent-runtime/events/ai_proposal.avsc:1-30` — fields are `proposal_id, agent_key, agent_version, tool_id, affected_urns, decision{action, actor, message?, diff?, decided_at}`. There is **no** `proposal.decided` unifying event type and **no** `decision_latency_ms`, `edit_distance_bucket`, `pack_name`, or `proposal_kind` field anywhere in this schema or its emission code.
- Auto-execute path: `create_from_intent()` (lines 53-151) calls `decide_proposal(..., new_status="approved", decision={"actor": "policy:auto", ...})` (lines 142-145) and then emits `"proposal.approved"` (line 149) — **the exact same event type as a human approval.** There is no `proposal.auto_executed` event type in code, contrary to what BRD 61 §"Emitted" narratively claims. The only way to distinguish an auto-executed decision from a human one downstream is `payload.decision.actor == "policy:auto"`.
- `Proposal` (dataclass, `services/agent-runtime/app/domain/entities.py:158-184`) *does* carry `created_at`/`updated_at` (lines 183-184) even though the DB migration also has them (`services/agent-runtime/migrations/versions/0001_initial.py:177-199`), so `decision_latency_ms` is computable (`decision.decided_at − prop.created_at`) without a schema change to `proposals`. There is **no** `pack_name` anywhere on `Proposal`, `AgentVersion` (`entities.py:52-67`), or `TenantAgentConfig` (`entities.py:70-…`) — confirmed by grep across `services/agent-runtime`. Pack-service's materialization contract *does* stamp an `origin: pack:<pack_urn>@<version>:<identity>` marker on objects it creates (`docs/brd/23_pack_service_BRD.md` PKG-FR-032), but agent-runtime never reads or stores that marker on agent config — so `pack_name` is a genuine gap requiring new plumbing, not just a new column.

**case-service close/disposition path.** `services/case-service/internal/api/handlers_transitions.go`:
- `resolveMutation()` (lines 130-164), called from `handleResolve()` (lines 102-125), is the commit point for a disposition. It emits `events.EvResolved` (`"case.resolved"`) with payload `{case_number, disposition_code, disposition_category, resolution_note, authored_by}` (lines 149-152), and separately `events.EvDispositionApplied` (`"case.disposition_applied"`) carrying the learning-loop `correction` map (lines 140-144, 153). When the resolution came from an approved copilot proposal it *also* emits `events.EvCorrectionRecorded` (lines 155-162) — and that branch's condition, `proposalURN != ""`, is exactly the boolean BRD 67's `had_agent_assist` needs; it already exists as a local variable, just isn't on the emitted payload.
- `handleClose()` (lines 190-229) is a **separate**, later transition (`case.closed`, `events.EvClosed`) with payload `{case_number, snapshot_ref}` (line 224) — confirms VMB-FR-001's mapping (`case.closed`) is the right source event for `case_resolved`, distinct from `case.resolved`.
- Event type constants: `services/case-service/internal/events/events.go:53-73` (`EvResolved="case.resolved"`, `EvClosed="case.closed"`, `EvDispositionApplied`, `EvCorrectionRecorded`). Topic: `Topic = "case.events.v1"` (`events.go:16`).
- `recovered_value_usd`, `pack_name`, `had_agent_assist` — **confirmed absent.** Grep for `recovered_value|RecoveredValue|pack_name|PackName|had_agent_assist` across all of `services/case-service/*.go` returns zero matches. BRD 17 USG-FR-081's claim that `case.resolved` "carries `recovered_value_usd` for insurance/AML/collections packs" is design-only; the field does not exist in the emitted payload today.
- Transactional outbox is real and already the pattern here too: `services/case-service/internal/store/pg.go:72-90` (`insertOutboxTx`, same-transaction outbox insert), relay described at `internal/events/publisher.go:58`, wired via the shared `go-common/outbox` package in `cmd/server/main.go:190,204`.

**`decision_urns[]` propagation — confirmed not implemented anywhere.** Three independent greps (`decision_urn`, `x-datacern-decision-urn`, case-insensitive) across `services/ai-gateway` and `services/agent-runtime` return zero matches in payload structs, Avro schemas, header lists, or request-context code. Specifically:
- `ai.token_usage.v1` is emitted from `services/ai-gateway/app/domain/pipeline.py:_record_and_meter()` (lines 828-892). The payload dict (lines 839-869) has `request_id, tenant_id, workspace_id, principal, agent_id, agent_version, tool, feature, request_class, model_alias, provider, model, deployment, rung, input_tokens, output_tokens, cached, cost_usd, latency_ms, first_token_ms, guardrail_flags, degraded, price_version, price_source, trace_id` — no `decision_urns` field, matching the Avro contract `services/ai-gateway/events/ai_token_usage.avsc:6-30`. The outbox write itself (lines 886-892) is already atomic with the `RequestLog` insert (lines 876-885) inside `async with self.uow_factory(...)`.
- The attribution fields come from `Attribution` (`services/ai-gateway/app/domain/entities.py:176-185`: `workspace_id, user_id, agent_id, agent_version, tool, feature` — no `decision_urns` slot) built in `_build_ctx()` (`services/ai-gateway/app/api/routes/data_plane.py:22-72`) from headers `x-datacern-workspace-id`, `x-datacern-agent-id`, `x-datacern-agent-version`, `x-datacern-tool`, `x-datacern-feature`, `x-datacern-request-class`, `x-datacern-min-rung`, `x-datacern-escalate`, `x-datacern-prior-request-id` (same list independently confirmed in `services/ai-gateway/api/openapi.yaml:21-28`) — `x-datacern-decision-urn` is not among them.
- On the caller side, agent-runtime's gateway client — `services/agent-runtime/app/adapters/llm.py`, class `AiGatewayLlmClient.chat()` (lines 26-92) — sends only `X-Datacern-JWT` and `x-datacern-request-class` (lines 70-73); it does not even forward `agent_id`/`workspace_id` as headers today (those ride the OBO JWT claims instead, minted at `proposals/service.py:361-364`). A graph that already knows the active decision — e.g. `services/agent-runtime/app/graphs/triage.py:123` calls `deps.llm.chat(...)`, and the same function already computes `case_urn(state["tenant_id"], state["case_id"])` at line 160 for the proposal's `affected_urns` — has no way today to tell `chat()` "this call is in service of case X". AIG-FR-089 is a **Must** in BRD 12 but is entirely unimplemented; this is the load-bearing gap the whole USG-FR-080..086 cost-attribution story depends on, and it sits in two services, not one.

**Existing rate-card and rollup machinery (real, reusable).** `services/usage-service/internal/store/rollups.go`: `RefreshRollups()` (lines 19-61) recomputes raw→hourly→daily→monthly on a `GROUP BY` over a fixed 8-column dimension tuple (`tenant_id, meter_key, workspace_id, user_id, agent_id, model, cloud` + bucket); `FinalizeMonth()` (lines 65-74) marks monthly buckets immutable and is idempotent/re-runnable (BR-10); `Chargeback()` (lines 217-262) already does the "meter totals × rate card" computation BRD 67's period close needs, resolving prices via `ResolvePrices()` (`store/ratecards.go:179-204`, tenant-override-wins-else-default at usage time, BR-5). None of this needs to be reinvented for billing close — it needs a snapshot step layered on top plus an allowance drawdown.

**Existing export/checksum machinery to reuse.** `services/audit-service/internal/export/export.go` is the strongest precedent: `ExportDay()` (lines 87-183) computes `fileSHA := domain.SHA256Hex(pq)` (line 110, SHA-256 impl at `internal/domain/domain.go:169`), writes via `WORM.PutWORM()` (line 111), then builds and seals a JSON `Manifest` (struct at lines 49-59: `TenantID, Date, Revision, Files[]{Name,SHA256,Rows,OccurredAtMin,OccurredAtMax}, ChainHead, ChainSeqRange, PrevManifestSHA256, ExporterVersion, SealedAt`) whose own bytes are also SHA-256'd and written last (lines 157-164, "the day is sealed only when the manifest lands"). Revisioning is explicit: `revision := latest.Revision + 1` when a prior manifest for the same day exists (lines 96-102), object keys are `tenant=<t>/date=<d>/events-%04d.parquet` (line 108-109) — never overwritten, a new revision is written instead. Underlying storage is real S3/MinIO Object-Lock **compliance mode** (`internal/worm/worm.go:71-86`, `minio.Compliance` + `RetainUntilDate`). This is precisely the versioning/immutability shape VMB-FR-021/AC-5 (re-export on correction → new version, old version untouched) needs; billing artifacts are JSONL+CSV, not Parquet, but the manifest+SHA-256+revision-on-correction pattern transfers directly. A lighter secondary reference exists in `services/chart-service/internal/export/export.go`: an `ObjectStore` interface (lines 66-68) + `FSStore` (lines 73-114, HMAC-signed time-limited URLs over a local MinIO-compatible filesystem store) — useful for the signed-URL-serving half if usage-service doesn't already have an object-storage client (it doesn't; grep for `S3|MinIO|ObjectStore` in `services/usage-service` returns nothing).

**Honest-stub port pattern (for `BillingPusher`).** `services/agent-runtime/app/domain/ports.py`: `GpuTrainer` is a `Protocol` (lines 143-149) with one method (`train`); the "not wired" case is a typed exception, `GpuTrainerNotConfigured(RuntimeError)` (lines 113-119), whose docstring states the rule explicitly: "a training job is ACCEPTED by the control plane... but running it fails honestly with a typed, non-retryable error... never a silent fake-trained adapter" — and cross-references `ai-gateway`'s `ProviderNotConfigured` (`services/ai-gateway/app/domain/ports.py:212`) as the same rule applied elsewhere. The stub adapter, `services/agent-runtime/app/adapters/trainer.py:25-36` (`UnconfiguredGpuTrainer`), does nothing but raise that typed error with a specific remediation string; `build_trainer()` (lines 53-76) defaults to it unless a real backend is explicitly configured. This triad — `Protocol` port, `<Thing>NotConfigured` sentinel error, `Unconfigured<Thing>` stub that always raises — is the pattern `BillingPusher` should follow. It is a Python pattern; usage-service is Go, and there is no existing Go "NotConfigured" example anywhere in the repo (grep confirms), so §2 below translates the triad to Go idiom rather than citing a Go precedent that doesn't exist.

---

## 2. Architecture & Design

### 2.1 Event/schema changes — extend `ai.proposal.v1`, do not mint `ai.proposal_decided.v1`

**Decision:** extend the existing `ai.proposal.v1` payload (agent-runtime) and `case.resolved`/`case.closed` payloads (case-service) with new fields, rather than create the `ai.proposal_decided.v1` topic BRD 67's VMB-FR-001 table names.

**Why:** that topic doesn't exist, and there's no correctness reason to add it. `decide()`'s commit and `_emit()`'s outbox-enqueue are already one atomic step (`service.py:253-286`); a second envelope would mean either a second outbox write in the same transaction (fine, but duplicates the terminal-state information two ways that can drift) or a derived event minted later from a stream processor (adds a lag source and a second place decisions can be lost). Every existing consumer of `ai.proposal.v1` (audit-service's EU AI Act evidence pack, `docs/brd/18_audit_service_BRD.md` AUD-FR-061; eval-service's flywheel, `docs/brd/16_eval_service_BRD.md` §3.8c) already keys off this topic's terminal event types — adding fields is additive and safe; adding a topic means every one of those consumers needs a second subscription for the same information twice-modeled. New fields, at the exact points already cited in §1b:

- `service.py` `decide()` (line 230 area, before `_emit`): compute `decision_latency_ms = int((decided_at - prop.created_at).total_seconds() * 1000)`, and for `edit_args`, `edit_distance_bucket` from `len(decision["diff"])` (already computed at `_diff()`, line 398-403) bucketed `none(0)|minor(1-2 fields)|major(3+ fields)`.
- `_emit()` payload (line 376-378): add `decision_latency_ms`, `edit_distance_bucket` (edited-approve only), `proposal_kind` (derived — see below), `pack_name` (nullable — see below).
- `proposal_kind`: no existing field maps to this cleanly. Design choice: derive it from `tool_id`'s leading namespace segment (e.g. `case.apply_disposition` → `case`, `chart.create` → `chart`) via a small static lookup, not a new stored column — it's a pure function of `tool_id`, which is already on every proposal.
- `pack_name`: **out of reach without new plumbing.** No object in agent-runtime carries a pack origin marker today (confirmed §1b). Options: (a) add `origin_pack` to `TenantAgentConfig` when pack-service materializes a per-tenant agent install (pack-service already stamps `origin=pack:<urn>@<version>:<identity>` on objects it creates per PKG-FR-032 — case-service and others already accept this marker; agent-runtime's materialization target would need to persist it too) and thread it onto `Proposal` at creation (`create_from_intent`, `service.py:100-112`); or (b) leave `pack_name` null until the run originates from a pack-installed agent and resolve it later via a join at query time in the BFF. **Decision: (a)**, because (b) means the `governed_decision` meter's `pack_name` dimension — needed for BRD 69 ROI-by-pack and roadmap B5 — is permanently unpopulated for a platform whose entire pitch is packs. This is new work in agent-runtime's (currently nonexistent) pack-materialization target, tracked as a dependency of slice 1, not assumed already done.
- **Auto-execute distinguishability:** do **not** add a new `proposal.auto_executed` event type — that would change what `proposal.approved` means for every existing consumer keyed on event_type. Instead, the `auto_executed_action` meter's ingest mapping filters on `payload.decision.actor == "policy:auto"`, exactly mirroring the existing `agent_run.completed` → `status=='succeeded'` filter pattern already in the codebase (`ingest/mapping.go:107-110`). Zero emission-side changes needed for this one.
- `case.resolved` (`handlers_transitions.go:149-152`): add `pack_name?` (same open question as agent-runtime — case-service has the identical gap, needs the identical `origin` plumbing on whatever installs the disposition catalog), `had_agent_assist` (trivial: `proposalURN != ""`, the exact boolean `resolveMutation` already branches on at line 155 — just also put it on the `EvResolved` payload, not only used to decide whether to emit `EvCorrectionRecorded`), and `recovered_value_usd?` (genuinely new: no source of this value exists anywhere in case-service today; it requires a new optional field on the resolve request/disposition metadata that only insurance/AML/collections packs populate — out of scope for slice 1/2, tracked as a follow-on once a pack actually needs it, never fabricated as 0).

### 2.2 Meter catalog additions and dimension columns

Add three entries to `domain.Catalog()` (`types.go`):

| meter_key | unit | agg | dims (beyond std) | source |
|---|---|---|---|---|
| `governed_decision` | count | sum | `pack_name?, decision, proposal_kind` (rollup); `decision_latency_ms, edit_distance_bucket` (raw-only) | `ai.proposal.v1 · proposal.approved\|edited_approved\|rejected` |
| `case_resolved` | count | sum | `pack_name?, disposition` (rollup); `had_agent_assist` (raw-only) | `case.events.v1 · case.closed` |
| `auto_executed_action` | count | sum | same as `governed_decision` | `ai.proposal.v1 · proposal.approved` filtered `decision.actor=='policy:auto'` |

`Meter.Dimensions []string` already supports a per-meter dimension list (`types.go:69`), so the catalog *description* layer needs no schema change. The **storage** layer does: `usage_raw`/`usage_hourly`/`usage_daily`/`usage_monthly` today have a fixed 7-column dimension tuple (`workspace_id, user_id, agent_id, model, cloud, resource_urn` + the rollups' `GROUP BY 1..8` in `rollups.go:24,28,36,40,49,53`). Two kinds of new dimension:

- **Rollup-worthy** (need cross-tenant/cross-period GROUP BY for showback/ROI, per US-1 "agent/pack/workspace/disposition dimensions... share one truth"): `pack_name TEXT`, `decision TEXT` (`approved|edited|rejected`, governed_decision only), `disposition TEXT` (case_resolved only). These become new nullable columns on `usage_raw` **and** all three rollup tables, added to every `GROUP BY`/`ON CONFLICT`/index tuple. This is a real migration (`000004_value_meters.up.sql`), not free — it widens every rollup row for every existing meter too (columns default NULL for infra meters, no behavior change there).
- **Raw-detail-only** (point-lookup fields that no showback query groups by — `decision_latency_ms`, `edit_distance_bucket`, `proposal_kind`, `had_agent_assist`): carried in a new bounded `meta JSONB` column on `usage_raw` only, never rolled up. This stays inside the MASTER-FR-061 carve-out ("JSONB allowed only for genuinely schemaless payloads ≤ 64KB, documented per use") — these are four short scalar fields per row, nowhere near the limit, and rollups never read `meta`, so continuous-aggregate correctness is unaffected. `proposal_kind` doubles as a rollup candidate later if ROI-by-tool-category becomes a real showback need; not adding it to rollups now keeps the migration to three new columns instead of four.

**Options weighed:** (1) put everything in `meta JSONB`, no new rollup columns — rejected, because `decision`/`disposition`/`pack_name` are exactly the cuts the ROI dashboard (BRD 69) and per-pack benchmarking (USG-FR-084) need pre-aggregated; forcing every showback query to unpack JSONB across a whole month of raw rows defeats the point of the rollup tables. (2) a separate `value_meter_raw` table parallel to `usage_raw` with its own dimension set — rejected, it forks the ingest/rollup/retention/RLS machinery that already works for every other meter, doubling the surface for no benefit since value meters are low-cardinality count meters, not a different shape. (3) widen `usage_raw`/rollups with the three new columns + a bounded `meta` column — **chosen**, smallest diff on proven machinery.

### 2.3 Idempotency

No new mechanism needed. USG-FR-011's existing guarantee — Redis `SETNX(event_id)` dedup one layer up (go-common consumer group) plus the unique constraint `(tenant_id, event_id, meter_key, time)` on `usage_raw` (`000001_init.up.sql:34`) — already makes any replay of `proposal.approved`/`case.closed` a no-op. What makes `governed_decision` specifically safe from double-counting is upstream: `decide_proposal()`'s atomic status transition (`service.py:253-259`, BR-12) guarantees at most one terminal decision per `proposal_id`, so at most one outbox row, so at most one `event_id` ever exists for that decision — the same discipline that already makes case-service's `resolveMutation` single-shot. AC-1's "replay of the Kafka event is a no-op" falls directly out of the existing constraint; nothing new to build here beyond making sure the new mapping entries participate in the same `ingest.Pipeline.Handle()` path (`ingest/pipeline.go:57-125`), which they do automatically once registered in `ingest.Catalog()`.

### 2.4 `usage_decisions` (USG-FR-080)

Hypertable-style, same partitioning convention as `usage_raw` (`000001_init.up.sql:19-39`):

```sql
CREATE TABLE usage_decisions (
    time            TIMESTAMPTZ NOT NULL,
    tenant_id       UUID NOT NULL,
    decision_urn    TEXT NOT NULL,
    decision_kind   TEXT NOT NULL,           -- case|chart|proposal|other, derived from URN prefix
    workspace_id    TEXT,
    agent_id        TEXT,
    model           TEXT,
    cost_usd        NUMERIC(14,8) NOT NULL,
    input_tokens    BIGINT NOT NULL DEFAULT 0,
    output_tokens   BIGINT NOT NULL DEFAULT 0,
    savings_usd_est NUMERIC(14,8),
    cached          BOOLEAN NOT NULL DEFAULT false,
    handler         TEXT,
    event_id        UUID NOT NULL,           -- the ai.token_usage.v1 event this row split from
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- K decision_urns on one event => K rows; unique per (event, urn) makes replay a no-op.
    UNIQUE (tenant_id, event_id, decision_urn, time)
) PARTITION BY RANGE (time);
CREATE TABLE usage_decisions_default PARTITION OF usage_decisions DEFAULT;
CREATE INDEX usage_decisions_urn_idx ON usage_decisions (tenant_id, decision_urn, time DESC);
CREATE INDEX usage_decisions_kind_idx ON usage_decisions (tenant_id, decision_kind, time DESC);
```

Cost split: BR-15's even-split-with-banker's-rounding-residual-to-first-URN rule applies at insert time in the same ingest handler that maps `ai.token_usage.v1` → `usage_raw`'s token meters — a new mapping-adjacent step (not a `Mapping` entry, since it fans out K rows from one event with a computed, not path-extracted, quantity) reads `payload.decision_urns[]` and `payload.cost_usd`, splits, and inserts via a new `InsertDecisions(ctx, recs)` on `store.PG` following `InsertRaw`'s exact shape (`store/raw.go:15-39`: same `ON CONFLICT ... DO NOTHING`, same per-tenant transaction). `decisions` fact table (USG-FR-081) is out of scope for this initiative's slices (tracked separately) — `usage_decisions` alone satisfies VMB-FR-010/011's cost-per-decision aggregation; ROI (which needs `decisions.value_usd`) needs that fact table but VMB-FR does not require ROI computation, only cost attribution.

### 2.5 `decision_urns[]` propagation: agent-runtime → ai-gateway

Two services change, at the exact chokepoints identified in §1b:

**ai-gateway** (contract side, AIG-FR-089):
1. `Attribution` (`entities.py:176-185`) gains `decision_urns: list[str] | None = None`.
2. `_build_ctx()` (`data_plane.py:22-72`) parses a new header `x-datacern-decision-urn` (comma-separated, matching AIG-FR-089's `<urn>[, <urn>...]` shape), splits, and syntactically validates each against the platform URN shape (`wr:<tenant>:<domain>:<type>/<id>`, same convention as `services/usage-service/internal/domain/urn.go:5`) — invalid entries are dropped with a warning metric, never a 400 (a malformed decision URN must not block an LLM call).
3. `_record_and_meter()` payload (`pipeline.py:839-869`) adds `"decision_urns": ctx.attribution.decision_urns or []`.
4. `ai_token_usage.avsc` gains the field (array of string, default empty).

**agent-runtime** (propagation side):
1. `AiGatewayLlmClient.chat()` (`llm.py:52-92`) gains an optional `decision_urns: list[str] | None = None` param, sent as the new header when non-empty (same style as the existing `x-datacern-request-class` header at line 72).
2. The harder part is *what* a graph passes. LLM calls happen before a proposal exists (the LLM call is often what produces the proposal's args), so "the proposal URN" isn't always known yet. Concretely: the run's originating resource *is* known — `triage.py:123`'s `deps.llm.chat(...)` call already sits next to `case_urn(state["tenant_id"], state["case_id"])` computed three lines later (line 160) for `affected_urns`. Design: a `decision_urns` accumulator lives on the per-run `state`/deps object graphs already thread (the same `state` dict `triage.py` reads `case_id` from), seeded at run start from whatever resource the run is *about* (the case being triaged, the chart being generated) and passed to every `llm.chat()` call in that graph. Once `create_from_intent()` mints a proposal (`service.py:100`, `pid = new_uuid()`), any *subsequent* LLM call in the same run (repair loops, judge calls) additionally carries `proposal_urn(tenant_id, pid)` so post-proposal cost attributes to the specific decision, not just its parent case.
3. This is additive per-graph work — each of the five graphs (`persona_copilot`, `triage`, `meta_router`, `dashboard_designer`, `data_pipeline_builder`) needs its own `decision_urns` wiring since each computes its subject resource differently; slice 1 only needs `triage` (the case-flow graph) wired end-to-end for the E2E assertion, the rest follow as the same pattern is copied.

**Options weighed:** propagate via the JWT (mint a `decision_urns` claim into the OBO token at `mint_agent_obo`, `service.py:361-364`) instead of a header — rejected, because the JWT is minted once per proposal execution grant and a single run makes many LLM calls before any proposal exists (the JWT for LLM calls isn't even the proposal-execution grant, it's a separate OBO token per `llm.py`'s `jwt_provider`), so the claim would be stale for exactly the calls that most need it (the ones proposing the write). A per-call header is the only shape that tracks the run's evolving "what am I deciding right now" state.

### 2.6 `billing_periods` / `billing_exports` DDL and close-job design

```sql
CREATE TABLE billing_periods (
    id                 UUID PRIMARY KEY,
    tenant_id          UUID NOT NULL,
    period             TEXT NOT NULL,             -- YYYY-MM
    version            INT NOT NULL DEFAULT 1,     -- corrections bump this, never update in place
    rate_card_id       UUID NOT NULL,
    rate_card_version  INT NOT NULL,
    meter_totals       JSONB NOT NULL,             -- {meter_key: {quantity, gross_usd}}, bounded (<20 meters)
    allowance_drawdown JSONB NOT NULL DEFAULT '{}',-- {meter_key: {included_qty, drawn, overage_qty}}
    gross_usd          NUMERIC(14,2) NOT NULL,
    net_billable_usd   NUMERIC(14,2) NOT NULL,
    status             TEXT NOT NULL DEFAULT 'closed', -- closed|exported|export_failed
    closed_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    closed_by          TEXT NOT NULL DEFAULT 'system', -- close-job leader identity, audited
    UNIQUE (tenant_id, period, version)
);
CREATE INDEX billing_periods_tenant_idx ON billing_periods (tenant_id, period DESC, version DESC);

CREATE TABLE billing_exports (
    id             UUID PRIMARY KEY,
    billing_period_id UUID NOT NULL REFERENCES billing_periods(id),
    tenant_id      UUID NOT NULL,
    period         TEXT NOT NULL,
    version        INT NOT NULL,
    jsonl_key      TEXT NOT NULL,     -- billing/<tenant>/<period>/<version>/meters.jsonl
    jsonl_sha256   TEXT NOT NULL,
    csv_key        TEXT NOT NULL,     -- billing/<tenant>/<period>/<version>/summary.csv
    csv_sha256     TEXT NOT NULL,
    pushed_status  TEXT,              -- null|pushed|BillingPushNotConfigured|push_failed
    pushed_at      TIMESTAMPTZ,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, period, version)
);
```

Both tables carry `tenant_id`/RLS per the standard `tenant_isolation` policy (`000002_rls.up.sql:12-30`); `billing_periods`/`billing_exports` rows are **never UPDATEd** past `status`/`pushed_*` — a correction is a brand-new row at `version+1` (mirrors audit-service's `Revision` field exactly, `export.go:52,97-102`).

**Close job.** No leader election exists anywhere in usage-service today — `jobs.Runner` (`jobs.go:20-31`) is a set of plain per-replica loops (`RefreshRollups`, `SweepBudgets`, `AnomalyScan`, `EnforceRetention`) that are all naturally idempotent/re-runnable so running them on every replica is harmless. Billing close is different: `FinalizeMonth` + snapshot-into-`billing_periods` is not idempotent in the same way (a naive re-run at `version+1` on every replica would mint duplicate versions), so this is the first job in the service that needs real leader election. Design: a Postgres advisory lock (`pg_try_advisory_lock(hashtext('billing-close:'||tenant||':'||period))`), acquired by whichever replica's cron fires first; losers skip the tick. This is the cheapest option given usage-service is already Postgres-resident and has no other coordination service (etcd/Consul) in its dependency list (`BRD 17 §8`) — introducing one for a once-a-month job is not justified.

**Ordering:** the close job for period P only runs once P's rollups are past the 48h late-event window (USG-FR-014) *and* `usage_monthly.finalized_at` is set for P (`FinalizeMonth`, `rollups.go:65-74`) *and* reconciliation status for P is `matched|adjusted|acknowledged`, not `variance` (BRD 17 §4 state machine, reused verbatim — chargeback export is already blocked on this exact condition, `handlers_reports.go`/`Chargeback()` callers). Concretely: close job = `FinalizeMonth(P)` (idempotent, already exists) → reconciliation gate check → `Chargeback(tenant, P)` (already exists, `rollups.go:217-262`) to get priced meter totals → read allowance snapshot from identity-service's `entitlements_flat:<tenant>` Redis projection (BRD 66 §6) → compute drawdown/net billable → insert `billing_periods` row → hand off to export (§2.7).

### 2.7 Artifact format

**JSONL** (`billing/<tenant>/<period>/<version>/meters.jsonl`) — one line per (meter_key × dimension tuple) rollup row for the period, so the file is the same shape as a `usage_monthly` query result, not a re-derivation:
```json
{"tenant_id":"t-42","period":"2026-07","version":1,"meter_key":"governed_decision","workspace_id":"ws-7","agent_id":"triage-v3","pack_name":"claims-fnol","decision":"approved","quantity":842,"unit":"count","price_per_unit_usd":0.08,"gross_usd":67.36,"rate_card_id":"rc-t42-v3"}
```

**CSV** (`billing/<tenant>/<period>/<version>/summary.csv`), RFC 4180 (same convention as `services/usage-service/internal/api/handlers_reports.go`'s existing CSV export and `services/chart-service/internal/export/export.go:24-48`'s `WriteCSV`), one row per meter (no dimension breakdown — the JSONL is the detail file, the CSV is the invoice-line summary): `meter_key, unit, quantity, price_per_unit_usd, gross_usd, allowance_included_qty, allowance_drawn, overage_qty, overage_usd`.

Both files land via a new `ObjectStore` port in usage-service — reuse `services/chart-service/internal/export/export.go`'s `ObjectStore` interface shape (`Put(ctx, key, data, ttl) (url, expires, err)`, lines 66-68) rather than inventing a new one, with the production adapter wrapping S3/MinIO the way `audit-service/internal/worm` does (Object-Lock compliance mode for the immutability NFR, VMB-NFR-002), and a local `FSStore`-equivalent for dev/tests. Checksums: SHA-256 over each file's bytes (`domain.SHA256Hex` equivalent, matching `audit-service/internal/domain/domain.go:169`), recorded on `billing_exports.jsonl_sha256`/`csv_sha256` and included in the `billing.export_ready.v1` payload so a consumer can verify before ingesting.

### 2.8 `BillingPusher` port + adapter stubs

Go translation of the `GpuTrainer`/`GpuTrainerNotConfigured`/`UnconfiguredGpuTrainer` triad (`agent-runtime/app/domain/ports.py:113-149`, `agent-runtime/app/adapters/trainer.py:25-76`) — no existing Go example in the repo, so this is the first Go instance of the pattern, built to the same rule ("accepted at the control plane, fails honestly at execution, never a fabricated success"):

```go
// internal/domain/billing_pusher.go
type BillingPusher interface {
    Push(ctx context.Context, period BillingPeriod, jsonlURL, csvURL string) error
}

// ErrBillingPushNotConfigured is returned by every stub pusher's Push method.
// Mirrors agent-runtime's GpuTrainerNotConfigured / ai-gateway's
// ProviderNotConfigured: the export (file path) always succeeds independently;
// push is a best-effort, honestly-failing secondary path.
var ErrBillingPushNotConfigured = errors.New("billing_push_not_configured")

type BillingPushNotConfiguredError struct {
    Adapter string // "lago" | "stripe_metronome"
    Reason  string
}
func (e *BillingPushNotConfiguredError) Error() string { return "billing_push_not_configured: " + e.Adapter + ": " + e.Reason }
func (e *BillingPushNotConfiguredError) Is(target error) bool { return target == ErrBillingPushNotConfigured }

// UnconfiguredPusher is the default for both lago and stripe_metronome until
// wired: a real object, an honest failure, never a fake "pushed" status.
type UnconfiguredPusher struct{ Adapter, Reason string }
func (p *UnconfiguredPusher) Push(ctx context.Context, _ domain.BillingPeriod, _, _ string) error {
    return &domain.BillingPushNotConfiguredError{Adapter: p.Adapter, Reason: p.Reason}
}
```

`BuildPusher(adapter string) BillingPusher` returns `&UnconfiguredPusher{Adapter: "lago", Reason: "set LAGO_API_URL + LAGO_API_KEY to enable"}` / same for `stripe_metronome` unless real credentials are configured, matching `build_trainer()`'s selection shape (`trainer.py:53-76`). Per VMB-FR-022/AC-6: the close job **always** writes the file export (§2.7) regardless of pusher configuration; `Push()` is called after, its failure only sets `billing_exports.pushed_status = 'BillingPushNotConfigured'` and never blocks the period from being `exported` — "file path is truth" (AC-6) is enforced by making `Push` genuinely optional in the close-job control flow, not merely best-effort in name.

### 2.9 Error / correction / versioning semantics

- A closed period is immutable (`billing_periods` rows never UPDATEd past status). A late correction (reconciliation adjustment landing after close, or a genuinely late event past the 48h window that the existing `late=true` flag caught) triggers a **new** `billing_periods` row at `version+1` for the same `(tenant, period)`, computed by re-running the same close pipeline — never a patch to `version` 1's numbers. `usage.month_refinalized` (already emitted by `FinalizeMonth`'s caller path per BR-10) is the upstream trigger; the close job additionally emits `billing.events.v1 :: period_corrected` alongside the existing `usage.month_refinalized`.
- Export re-run on correction: new JSONL/CSV at `billing/<tenant>/<period>/<version+1>/...`, version 1's artifacts untouched (AC-5) — this is a direct copy of audit-service's revision-on-correction discipline (`export.go:96-102`), not a new invention.
- `billing.export_ready.v1` is re-emitted with the new version; a consumer dedups on `(tenant, period, version)` per VMB-FR-021 — the same idempotency shape as everything else in this design (unique constraint + replay-safe emit).

### 2.10 Out of scope

Invoice rendering, payment collection, dunning, tax (external billing system, unchanged from BRD 17's stance); outcome-based pricing (needs BRD 55 outcome labels); credit-wallet purchase flows; changes to budget enforcement semantics (BRD 17 owns); the `decisions` fact table and ROI computation (USG-FR-081/082, needs `value_usd` sourcing that doesn't exist yet — tracked separately, not blocking cost attribution); ML-based cost anomaly detection for decisions (USG-FR-085, Should, layered on the same z-score machinery already in `internal/anomaly` once `governed_decision` has enough history); pack ROI benchmark publishing (USG-FR-084); wiring a *real* Lago/Stripe-Metronome adapter (only the honest stub ships here, per VMB-FR-022's own scope).

---

## 3. Implementation & Test

**Status: slice 1 (`governed_decision` meter end-to-end) implemented and unit-tested; slices 2-4 not started.** §2 remains the design for slices 2-4.

### Slice 1 — what was built (2026-07-25)

**agent-runtime** (extends `ai.proposal.v1`, no new topic, per §2.1):
- `services/agent-runtime/app/domain/metering.py` (new) — pure helpers: `proposal_kind(tool_id)` (leading namespace segment), `decision_label(status)` (approved/edited_approved/rejected → approved/edited/rejected, `None` for anything else — the terminal-human-decision gate), `edit_distance_bucket(diff)` (none/minor/major), `decision_latency_ms(created_at, decided_at)`.
- `services/agent-runtime/app/proposals/service.py` — `decide()` now computes metering fields via a new `_governed_decision_metering()` helper and passes them into `_emit()`, which merges them into the SAME outbox-enqueued envelope (`_emit()`/`enqueue_outbox()` were already atomic with the decision commit before this change — VMB-FR-003 required no new transaction, only new fields). The auto-execute branch in `create_from_intent()` computes the same fields for `decision.actor=='policy:auto'` approvals. Metering fields are named `decision_label` (not `decision`) on the payload to avoid colliding with the existing `decision` object (actor/action/diff/decided_at) — usage-service's ingest mapping reads `payload.decision_label`.
- `services/agent-runtime/events/ai_proposal.avsc` — added nullable `proposal_kind`, `pack_name`, `decision_label`, `decision_latency_ms`, `edit_distance_bucket` fields (all default `null`).
- **`pack_name` is deferred, as the design explicitly allows for slice 1** — agent-runtime has no pack-origin plumbing on `TenantAgentConfig`/`AgentVersion` (confirmed absent, §1b/§2.1), so it is emitted as `null` on every decision. Building that plumbing (design §2.1 option (a)) is tracked as a slice-1 follow-on, not fabricated here.
- **Design interpretation made explicit:** the design's governed_decision source filter (`proposal.approved|edited_approved|rejected`) carries no actor exclusion, so an auto-executed approval (`decision.actor=='policy:auto'`) is counted by BOTH `governed_decision` (it is still a decision made under the governed proposal framework — the auto-execute policy IS the governance) AND, separately, `auto_executed_action` (via its own actor filter). This is a reading of an internally ambiguous design table (row 87 vs. the BRD's per-meter framing) made explicitly and tested (`test_auto_executed_approval_also_carries_metering_fields`); flag for confirmation before slice 2 if the intent was actually exclusive.
- Supersede (`store.supersede_pending`) and proposal expiry (Temporal `finalize_run` on the run) were confirmed to never call `_emit()` at all — VMB-FR-002's "supersede/expiry are not metered" falls out of the existing call graph, nothing new was added to enforce it. `respond` (→ `cancelled`) DOES call `_emit()` (via `decide()`) but `decision_label("cancelled")` returns `None`, so no metering fields are attached and no `governed_decision` row is producible downstream.

**usage-service** (catalog + ingest + rollups, per §2.2):
- `internal/domain/types.go` — added `MeterGovernedDecision`/`MeterAutoExecutedAction` catalog entries (dims documented per VMB-FR-002: `pack_name?, decision, proposal_kind, decision_latency_ms, edit_distance_bucket?` beyond std); widened `MeterRecord` with `PackName *string`, `Decision *string`, `Meta map[string]any`.
- `internal/events/events.go` — added `TopicAIProposal = "ai.proposal.v1"` to `ConsumedTopics()` (usage-service did not consume this topic before this change).
- `internal/ingest/mapping.go` — three `governed_decision` mappings (`proposal.approved|edited_approved|rejected`) + one `auto_executed_action` mapping (`proposal.approved` filtered on `decision.actor=='policy:auto'`, mirroring the existing `agent_run.completed`/`status=='succeeded'` filter pattern); new `MetaPaths` field on `Mapping` for raw-detail-only fields.
- `internal/ingest/pipeline.go` — extracts `pack_name`/`decision` dims and builds the `meta` map from `MetaPaths`.
- `internal/store/raw.go` — `InsertRaw` persists `pack_name`, `decision`, `meta` (defaults `meta` to `{}` for every meter, never `NULL`).
- `internal/store/rollups.go` — `RefreshRollups` widened to `GROUP BY`/`ON CONFLICT` on `pack_name, decision` in addition to the existing 8-column tuple, for all three rollup tables (hourly/daily/monthly); `COALESCE(...,'')` sentinel convention matches the pre-existing dims, so every infra meter's rollup rows are unaffected (both new columns are always `''` for them).
- `migrations/000004_value_meters.up.sql` / `.down.sql` (new) — adds `pack_name`, `decision` (nullable) + `meta JSONB NOT NULL DEFAULT '{}'` to `usage_raw`; adds `pack_name`, `decision` (`NOT NULL DEFAULT ''`) to `usage_hourly`/`usage_daily`/`usage_monthly` and widens each table's PRIMARY KEY. No catalog-row `INSERT` needed — `store.SeedMeters()` already upserts from `domain.Catalog()` on every boot.
- **`disposition` (the `case_resolved`-only rollup column) and `case_resolved` itself are deliberately NOT added** — case_resolved needs `case-service` payload changes (`case.closed`: `disposition`, `pack_name?`, `had_agent_assist`) that are out of scope for slice 1 per the design's own slice plan below. Verified: `case_resolved` is not present in `domain.CatalogKeys()` (pinned by `TestCatalog_GovernedDecisionMetersRegistered`).
- Idempotency (USG-FR-011): no new mechanism — the existing Redis `SETNX(event_id)` dedup + the unique constraint `(tenant_id, event_id, meter_key, time)` on `usage_raw` (unchanged by this migration) already make a replayed `proposal.approved`/`edited_approved`/`rejected` event a no-op, exactly as designed in §2.3.

**deploy/e2e:**
- `deploy/e2e/lib/common.py` — added `USAGE` (`USAGE_URL`, default `http://localhost:8321`, matching `config.env`'s existing `PORT_USAGE=8321` — usage-service was already booted by `boot_services.sh` but never referenced from the driver).
- `deploy/e2e/driver.py` — added step E4 to `step_e_grant_and_apply()`: after the real HITL approve (E2) and federated-write assertion (E3), poll `usage_raw` directly in usage-service's own Postgres (mirroring this driver's existing pattern of asserting ground truth via direct DB queries, e.g. the case-service disposition check immediately above it) for a `governed_decision` row with `meter_key='governed_decision', agent_id='case-triage', decision='approved'`, up to the VMB-NFR-001 p95 30s ingest-lag budget. Matches BRD 67 AC-1 ("approve a proposal → meter row exists"). `GET /api/v1/reports/decisions` does not exist (never specified) and `GET /api/v1/reports/usage` reads rollups (refreshed on a job cadence, not on ingest), so this uses the "raw meter" fallback the design's test-plan text anticipated.

### Verified vs. written-but-not-run vs. deferred (honesty per the template)

**Verified (executed in this environment, results below):**
- `cd services/agent-runtime && uv run pytest tests/unit -q` → **329 passed** (includes the 11 new tests in `tests/unit/test_value_metering.py`: pure-helper tests for `proposal_kind`/`decision_label`/`edit_distance_bucket`/`decision_latency_ms`, and emission-integration tests proving approve/reject/edit-approve carry the right fields, `respond`→cancelled and `proposal.created` carry none, supersede emits no event at all, and auto-executed approvals carry metering fields too). No pre-existing test broken.
- `cd services/agent-runtime && uv run ruff check .` → clean.
- `cd services/usage-service && go build ./... && go vet ./...` → clean.
- `cd services/usage-service && go test -short -count=1 ./...` → **all packages ok**, including the 7 new tests in `internal/ingest/governed_decision_test.go` (mapping correctness for agent_id-from-agent_key, pack_name/decision dims, meta extraction, auto-executed double-counting into both meters, edit/reject variants, `proposal.created`/`cancelled` staying unmapped, replay determinism, and catalog registration — including a pinned assertion that `case_resolved` is NOT yet registered). No pre-existing test broken.
- `cd services/usage-service && make nostub` → passed.
- `python3 -m py_compile deploy/e2e/driver.py deploy/e2e/lib/common.py` → clean (syntax only — see below for why the journey itself wasn't run).

**Written but NOT executed (infra unavailable in this environment — honest per CONVENTIONS' testing-tiers rule, auto-skip confirmed rather than assumed):**
- `services/usage-service/test/integration/governed_decision_test.go` (new: `TestAC1_ApprovedProposal_MetersGovernedDecision`, `TestAC2_EditRejectDecisions`, `TestAC_AutoExecuted_CountsBothMeters`, `TestAC_ProposalCreatedAndCancelled_NeverMeter`) — needs real Postgres/Kafka/Redis/OPA (`deploy/docker-compose.dev.yml`). Ran `cd services/usage-service && go test -count=1 -timeout 60s ./test/integration/... -run 'TestAC1_ApprovedProposal_MetersGovernedDecision|TestAC2_EditRejectDecisions|TestAC_AutoExecuted|TestAC_ProposalCreated' -v` in this environment: all four **SKIP** with `integration tests skipped: real infra unavailable: pg ping: ... connection refused` — confirmed via `go vet ./test/integration/...` (clean) that the file compiles correctly; only the runtime infra is missing here (`docker info` fails — no daemon in this sandbox).
- `services/agent-runtime/tests/integration/test_value_metering_kafka.py` (new: `test_approve_metering_fields_round_trip_real_kafka`) — needs real Redpanda. Ran `uv run pytest tests/integration/test_value_metering_kafka.py -q -m integration`: **1 skipped** (`require_kafka` fixture correctly detected Kafka unreachable at `localhost:9092`).
- The `deploy/e2e/driver.py` step E4 addition — needs the full compose stack (Postgres, Kafka, OPA, Keycloak, MinIO, Ollama, every service) via `boot_services.sh`/`run.sh`, which this environment cannot boot. Only syntax-checked (`py_compile`), not run. **Pending live verification.**
- `golangci-lint` (`make lint`): fails in this environment with a tool/Go-version mismatch (`golangci-lint` built with go1.25, module targets go1.26.5) — a pre-existing environment issue unrelated to this change (confirmed: same failure on `main` before any edits). `go vet` (the Makefile's own documented fallback) was used instead and is clean.

**Deferred to a later slice (not attempted, per the design's own slice plan):**
- `case_resolved` meter (VMB-FR-001/004) — the design's slice plan (below) scopes slice 1 to `governed_decision` only; `case_resolved` needs `case-service` changes (`case.closed` payload: `disposition`, `pack_name?`, `had_agent_assist`) that were not touched. The `disposition` rollup column was likewise NOT added ahead of its meter (adding an unused column would be exactly the kind of fabricated readiness `CONVENTIONS.md` forbids).
- `pack_name` population — deferred per the design's explicit slice-1 allowance ("`pack_name` deferred if the pack-origin plumbing isn't ready, nullable is acceptable for slice 1"); the column and payload field exist and are wired end-to-end, only the source value is unpopulated.
- Slices 2-4 (`usage_decisions` attribution, `decision_urns[]` propagation, billing period close/export, `BillingPusher` adapters) — **not started**, per the slice plan below.

### Slice plan

1. ✅ **Slice 1 — `governed_decision` meter end-to-end** (this pass). Catalog entry + `usage_raw`/rollup migration (§2.2) → agent-runtime payload fields (`decision_latency_ms`, `edit_distance_bucket`, `proposal_kind`; `pack_name` deferred, nullable) → ingest mapping entries (§2.1's filter-based `auto_executed_action` included) → rollup verification (unit-level; integration written, not run — see above). Emission→catalog→ingest→rollup proven on the cheapest meter (no cross-service propagation needed).
2. **Slice 2 — `usage_decisions` attribution.** `decision_urns[]` propagation (§2.5, both services) + `usage_decisions` DDL + split-insert logic (§2.4) + `GET /api/v1/decisions/costs` (VMB-FR-011). Not started.
3. **Slice 3 — period close + export.** `billing_periods`/`billing_exports` DDL, advisory-lock close job (§2.6), JSONL/CSV export with checksums (§2.7), `billing.export_ready.v1`. Not started.
4. **Slice 4 — pusher adapters.** `BillingPusher` port + `UnconfiguredPusher` stubs (§2.8) wired into the close job's post-export step; `GET /api/v1/billing/periods` (VMB-FR-023). Not started.

### Test plan

- **Unit:** ingest mapping filter predicates (auto-execute detection mirrors the existing `agent_run.completed` filter test pattern in `ingest/pipeline_test.go`); `decision_latency_ms`/`edit_distance_bucket` computation in `proposals/service.py`. *(Slice 1: done, see above.)* BR-15 cost-split rounding (banker's rounding, residual to first URN) as a pure function, unit-tested the way `budget/window_test.go` tests `CrossedThresholds` in isolation from infra — slice 2, not started.
- **Integration (real Kafka/Postgres, per repo convention — `usage-service/test/integration/*_test.go` uses real local infra today, same pattern for new tests):** end-to-end `governed_decision` ingest through `RefreshRollups` *(slice 1: written, not executed — see above)*; `usage_decisions` split-insert idempotency (replay a `decision_urns`-bearing `ai.token_usage.v1` twice, assert row count unchanged); close-job advisory-lock contention (two "replicas" racing `pg_try_advisory_lock` for the same tenant/period, assert exactly one `billing_periods` row); export checksum verification (write, re-read, verify SHA-256 matches); `BillingPushNotConfigured` returned and period still reaches `exported` status (AC-6) — all slice 2/3/4, not started.
- **E2E (`deploy/e2e/driver.py`):** the existing journey already exercises the exact commit point this meter is keyed on — `step_e_grant_and_apply()` approves a proposal via `POST {agent_runtime}/api/v1/proposals/{proposal_id}/decide` and records `EVID["proposal_id"]`/`EVID["proposal_urn"]`. *(Slice 1: step E4 added — polls the raw meter directly, since `GET /api/v1/reports/decisions` was never built and `/reports/usage` reads rollups on a job cadence, not on ingest. Written, not run — see above, pending live verification.)*
