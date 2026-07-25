# BRD 69 — Value & ROI Reporting

**Status:** design — 2026-07-25
**Related:** [BRD 69](../brd/69_value_roi_reporting_BRD.md) (value & ROI reporting), [BRD 67](../brd/67_value_metering_billing_export_BRD.md) (value metering & billing export — dependency), [BRD 55](../brd/55_decision_outcome_monitoring_BRD.md) (decision outcome monitoring — future enrichment), [BRD 17](../brd/17_usage_service_BRD.md) (usage-service), [`00_MASTER_BRD.md`](../brd/00_MASTER_BRD.md), roadmap [`DATACERN_COMPETITIVE_LANDSCAPE_AND_GTM_ROADMAP.md`](../DATACERN_COMPETITIVE_LANDSCAPE_AND_GTM_ROADMAP.md) §6 B5

---

## 1. Analysis

### 1a. Platform / product

Datacern's pricing and renewal story is "cost per governed decision, and it goes
down over time" (the ai-gateway routing-ladder/distillation flywheel). That
story is currently **invisible to the buyer**: there is no dashboard, no
export, and no number anywhere in the product that says "here is what this
platform did for you this month and what it cost." Renewal and expansion
conversations (the Copilot Analytics / Glean-TEI pattern the roadmap names)
run on screenshots and sales narrative instead of live, tenant-owned evidence.

The honesty rule inherited from `/welcome` — no invented numbers — is the hard
constraint on this initiative. A dashboard that shows "$740K saved" with no
visible assumption behind it is worse than no dashboard: it invites a CFO to
ask "says who?" and there is no good answer. So the product shape here is not
just "add a value tab" — it is "add a value tab where every derived figure is
either traceable to a rollup + a disclosed customer-set assumption, or it is
visibly absent." That constraint is what makes this BRD hard, and it is what
this design optimizes for throughout: null is a legitimate, expected value on
this page, not a bug.

The dashboard also underwrites two adjacent motions the roadmap names: POC
success dashboards (BRD 70) and trial-conversion snapshots (CPL-FR-024) both
consume the same summary API this BRD defines — so the API contract matters
more than the page.

### 1b. Technical

**What exists today (verified in code).**

- The meter catalog is infra-shaped only, exactly as BRD 67's own overview
  states: seven meters — `api_calls`, `query_bytes_scanned`,
  `pipeline_minutes`, `storage_gb_month`, `llm_input_tokens`,
  `llm_output_tokens`, `agent_tasks_completed`
  ([services/usage-service/internal/domain/types.go:47-86](../../services/usage-service/internal/domain/types.go)).
  There is **no** `governed_decision`, `case_resolved`, or
  `auto_executed_action` meter. `MeterRecord`
  ([types.go:99-112](../../services/usage-service/internal/domain/types.go))
  carries `WorkspaceID/UserID/AgentID/Model/Cloud/ResourceURN` dimensions —
  no `decision_urn`, `proposal_kind`, `decision`, `pack_name`, or `rung`.
- Rollups exist and are real: `usage_raw → usage_hourly → usage_daily →
  usage_monthly`, keyed by `(tenant_id, meter_key, bucket, workspace_id,
  user_id, agent_id, model, cloud)`
  ([migrations/000001_init.up.sql:48-79](../../services/usage-service/migrations/000001_init.up.sql),
  refreshed by
  [internal/store/rollups.go:19-61](../../services/usage-service/internal/store/rollups.go)).
  `GET /reports/usage` (`handleReportUsage`,
  [internal/api/handlers_reports.go:28-98](../../services/usage-service/internal/api/handlers_reports.go))
  reads `usage_daily` only — `store.QueryUsage`
  ([internal/store/rollups.go:118-192](../../services/usage-service/internal/store/rollups.go))
  — and layers USD by resolving the active rate card
  (`ResolvePrices`,
  [internal/store/ratecards.go:179](../../services/usage-service/internal/store/ratecards.go))
  at request time; it never scans `usage_raw`. This is the precedent
  ROI-NFR-001 ("no raw scans") must follow.
- **No decision-cost or ROI surface exists at all.** `usage_decisions`,
  `decisions`, `billing_periods`, `billing_exports` tables; `governed_decision`
  meter; `decision_urns[]`; `savings_usd_est`; `GET /api/v1/reports/decisions`;
  `GET /api/v1/decisions/costs` — none of USG-FR-080..086 or BRD 67's
  VMB-FR-00x are present anywhere in `services/`. Repo-wide search for
  `usage_decisions`, `governed_decision`, `decision_urns`, `savings_usd_est`,
  `billing_periods` returns zero matches outside the BRD text itself. **BRD 67
  is 0% built** — this is not a partial dependency, it is a full one, and this
  design treats it that way rather than assuming any of it exists.
- **ai-gateway** does track per-call routing rung (`RequestLog.rung: int`,
  [app/domain/entities.py:143-160](../../services/ai-gateway/app/domain/entities.py))
  and exposes a cost breakdown by provider/model/request-class
  (`GET /admin/spend/breakdown` →
  `AiCostBreakdownDTO.by_model/by_request_class`,
  [services/bff-graphql/src/clients/aigateway.ts](../../services/bff-graphql/src/clients/aigateway.ts)),
  and ladders/rungs are real, versioned config
  (`AiLadderDTO{rungs, max_rung}`, same file). **But there is no
  `savings_usd_est` field anywhere** — not on `RequestLog`, not on the cost
  breakdown, not on any event. The "model-ladder savings" figure ROI-FR-010
  asks for (`ladder_savings_usd`) and the "distilled-rung share" annotation
  ROI-FR-011 asks for have a data source that is *plausible* (rung is tracked
  per call) but **not built and not wired to usage-service** — cite this
  honestly rather than assuming BRD 67's mention of `savings_usd_est` means it
  exists; it does not.
- **UI.** `CostPanel`
  ([services/ui-web/src/components/usage/CostPanel.tsx](../../services/ui-web/src/components/usage/CostPanel.tsx))
  is workspace-scoped (not tenant-exec-scoped), shows spend-by-meter and
  budget bars only — no decisions, no hours-saved, no trend, no chart. It is
  plain divs/bars, not the SVG chart primitives. `/admin/usage`
  ([services/ui-web/src/app/(app)/admin/usage/page.tsx](<../../services/ui-web/src/app/(app)/admin/usage/page.tsx>))
  composes `CostPanel` + budget/rate-card/anomaly admin tables via
  `useCostPanel`/`useBudgets`/etc.
  ([services/bff-graphql/src/clients/usage.ts](../../services/bff-graphql/src/clients/usage.ts)
  → `ctx.clients.usage.*` in
  [services/bff-graphql/src/resolvers/index.ts:1385-1435](../../services/bff-graphql/src/resolvers/index.ts)).
  No tenant-exec value page exists.
- **Chart primitives exist and are reusable**, dependency-free inline SVG
  under `{columns, rows}` props:
  [`LineChart.tsx`](../../services/ui-web/src/components/charts/LineChart.tsx),
  [`BarChart.tsx`](../../services/ui-web/src/components/charts/BarChart.tsx),
  [`GaugeChart.tsx`](../../services/ui-web/src/components/charts/GaugeChart.tsx),
  [`MetricChart.tsx`](../../services/ui-web/src/components/charts/MetricChart.tsx)
  (the latter is tied to chart-service's `artifact` blob shape and is not a
  fit here). There is no standalone "stat tile" component; the established
  pattern for a headline number is `Card`/`CardHeader`/`CardTitle`/`CardContent`
  with `text-3xl font-bold`, e.g. the pending-decisions tile at
  [services/ui-web/src/app/(app)/page.tsx:83-96](<../../services/ui-web/src/app/(app)/page.tsx>).
- **Export/object-storage patterns.** Two real precedents, different weight
  classes. (1) audit-service's WORM day export
  ([internal/export/export.go](../../services/audit-service/internal/export/export.go))
  — SHA256 per file, chained manifests, S3 Object-Lock immutability
  ([internal/worm/worm.go](../../services/audit-service/internal/worm/worm.go)),
  listed via `GET /exports` → `handleListExports`
  ([internal/api/handlers.go:357-382](../../services/audit-service/internal/api/handlers.go))
  with presigned download URLs. This is compliance-grade (regulatory
  retention, hash-chained). (2) chart-service's on-demand CSV export
  ([internal/export/export.go](../../services/chart-service/internal/export/export.go))
  — `WriteCSV` (RFC 4180 + UTF-8 BOM), an `ObjectStore` interface
  (`Put(ctx, key, data, ttl) → signed URL`), `FSStore` as the real local/dev
  object store, HMAC-signed time-limited URLs. This is a periodic
  business-report weight class, not WORM. §2 picks the second pattern and
  borrows only the checksum + listing idea from the first — a value report is
  not a regulatory record.
- **Authz.** `usage-service`'s action set today is
  `usage.report.read`, `usage.budget.{read,create,update,delete}`,
  `usage.ratecard.{read,create,update}`, `usage.anomaly.{read,update}`
  ([internal/authz/authz.go:48-62](../../services/usage-service/internal/authz/authz.go)),
  mirrored in ui-web's `FEATURE_GATES`
  ([lib/authz/registry.ts:257-287](../../services/ui-web/src/lib/authz/registry.ts)).
  **`usage.report.manage`, the action ROI-FR-002 requires for assumption
  edits, does not exist yet** — it needs to be added, not assumed.

**Root-cause summary.** This is not a bug-fix BRD; the gap is total. The
metrics substrate this BRD wants to sit on top of (BRD 67's decision-shaped
meters) has not been built, and the design below has to be honest about that
in the API contract itself, not just in prose — degrading gracefully rather
than silently faking decision counts from an unrelated meter.

---

## 2. Architecture & Design

### 2.0 Dependency contract with BRD 67 — what must exist, and what ships without it

BRD 69 depends on exactly two BRD 67 pieces, not the whole BRD:

| Needed for | BRD 67 requirement | Status |
|---|---|---|
| `decisions.total/by_decision/by_kind/by_agent/by_pack` | `governed_decision` meter + dims (VMB-FR-001/002) | Not built |
| `cost_per_decision` at true per-decision (not blended) grain, `ladder_savings_usd` | `usage_decisions` hypertable + `savings_usd_est` (VMB-FR-010, and an ai-gateway-side savings estimate that doesn't exist even in BRD 67's own text — see §1b) | Not built |

Everything else this BRD needs — `ai_cost_usd` (existing LLM token meters ×
rate card), `adoption.active_users` (existing `user_id` dimension on any
meter) — is computable **today** from the rollups that already exist. The
design below is explicit about which response fields come from which tier, so
slice 1 can ship without waiting on BRD 67 and without lying about what it
knows.

**Three data-availability tiers**, carried in the response itself via a
`provenance.meter_gap` string (present = "here's what's missing and why"; null
= fully available) plus a `basis` tag on `cost_per_decision`:

- **Tier 0 (today — BRD 67 unbuilt).** `decisions` is `null` with
  `provenance.meter_gap = "governed_decision meter not emitted yet (BRD 67
  VMB-FR-001)"`. `ai_cost_usd` and `adoption` still populate from existing
  rollups. **Rejected alternative:** proxy `decisions.total` from
  `agent_tasks_completed` (which exists today). Rejected because an agent task
  and a governed decision are not the same thing by definition — one agent run
  can produce zero or many proposal decisions — so this would be exactly the
  kind of invented number the honesty charter forbids, dressed up as a
  "reasonable estimate." Absence is the honest answer until VMB-FR-001 ships.
- **Tier 1 (BRD 67 ships `governed_decision` meter only, no `usage_decisions`).**
  `decisions.*` populate from `governed_decision` rollups.
  `cost_per_decision = ai_cost_usd / decisions.total` (blended average across
  the whole tenant/period), tagged `"basis": "blended"`.
- **Tier 2 (BRD 67 ships `usage_decisions` too).** `cost_per_decision` comes
  from `usage_decisions` aggregates (mean/p50 per USG-FR-082), tagged
  `"basis": "attributed"`. `ladder_savings_usd` still requires an
  ai-gateway-side savings estimate that is a genuine open gap beyond BRD 67 as
  currently written — flagged, not silently assumed to arrive for free.

### 2.1 `value_assumptions` — table, versioning, pinning

Mirrors the existing `rate_cards` versioning idiom (`domain.RateCard`,
[types.go:178-186](../../services/usage-service/internal/domain/types.go)):
append-only versions, immutable once active, resolved "as of" a date — same
shape as `ResolvePrices(tenant, at)`
([ratecards.go:179](../../services/usage-service/internal/store/ratecards.go)).
The key difference from rate cards: there is **no platform default row**. A
tenant with zero rows *is* the "assumptions unset" state (ROI-FR-001) — no
sentinel, no zero-value default, because a present-but-zero row is
indistinguishable from a deliberate zero and would violate the honesty
invariant.

```sql
-- usage-service migration 000004_value_assumptions.up.sql
CREATE TABLE value_assumptions (
    id                      UUID PRIMARY KEY,
    tenant_id               UUID NOT NULL,
    version                 INT NOT NULL,
    minutes_per_decision    JSONB NOT NULL DEFAULT '{}',  -- proposal_kind -> minutes; schemaless, <64KB (MASTER-FR-061)
    loaded_hourly_rate_usd  NUMERIC(10,2) NOT NULL,
    effective_from          DATE NOT NULL,
    status                  TEXT NOT NULL DEFAULT 'active', -- active | superseded (no draft state — edits apply immediately, forward-only)
    created_by              TEXT NOT NULL,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, version)
);
CREATE INDEX value_assumptions_tenant_active_idx ON value_assumptions (tenant_id, status, effective_from DESC);
```

**Versioning/pinning semantics (ROI-FR-002):**

1. First `PUT /value/assumptions` on a tenant with zero rows inserts version 1,
   `status=active`, `effective_from = today`.
2. Every subsequent edit inserts version N+1, `status=active`,
   `effective_from = today`, and in the same transaction flips version N to
   `status=superseded` — never an in-place update of N's values (rows are
   immutable once written, same discipline as `usage_monthly.finalized_at`
   rows).
3. Resolution: `ResolveAssumptions(tenant, at time) → (*ValueAssumptions,
   bool)` picks `MAX(version) WHERE effective_from <= at` — the same
   "as-of" lookup shape as `ResolvePrices`. A closed period (`usage_monthly`
   bucket with `finalized_at` set) always resolves against the version active
   at that bucket's close, so recomputing July after an August assumption edit
   reproduces July's original figures exactly (AC-3).
4. The version rows themselves **are** the audit history — no separate
   history table needed, since nothing is ever overwritten. `GET
   /value/assumptions/history` returns all versions for a tenant ordered by
   version, each already carrying `created_by`/`created_at`; the API layer
   diffs adjacent versions for "before/after" display. A
   `value_assumptions.updated` audit event (MASTER-FR-040) fires on every
   insert with `{before: <version N summary or null>, after: <version N+1>}`.

### 2.2 Assumption-provenance invariant, enforced at the type level (ROI-NFR-004)

The existing precedent for "this field may legitimately be absent" is
`RollupRow.USD *float64`
([types.go:255](../../services/usage-service/internal/domain/types.go)),
populated only `if p, ok := prices[meterKey]; ok` in the handler
([handlers_reports.go:78-84](../../services/usage-service/internal/api/handlers_reports.go)).
This BRD needs a stronger guarantee than "a pointer that happens to be nil
today": every `*_est` figure must be *inseparable* from the assumption version
that produced it, so a future refactor can't accidentally serialize a number
without its provenance. Design: a dedicated type with no zero-value
constructor.

```go
// EstimatedValue pairs a derived figure with the assumption version that
// produced it. The zero value is unusable (no exported fields, no default
// JSON) — the only way to get a non-nil *EstimatedValue is NewEstimatedValue,
// which requires both the value AND the version. Any code path that has an
// assumption-derived number but no version (should never happen) fails to
// compile, not fails silently at render time. This is what ROI-NFR-004 asks
// for enforced structurally rather than by convention.
type EstimatedValue struct {
    value             float64
    assumptionVersion int
}

func NewEstimatedValue(value float64, assumptionVersion int) *EstimatedValue {
    return &EstimatedValue{value: value, assumptionVersion: assumptionVersion}
}

func (e *EstimatedValue) MarshalJSON() ([]byte, error) {
    if e == nil {
        return []byte("null"), nil
    }
    return json.Marshal(struct {
        Value             float64 `json:"value"`
        AssumptionVersion int     `json:"assumption_version"`
    }{e.value, e.assumptionVersion})
}
```

`ValueSummary.HoursSavedEst *EstimatedValue` etc. are only ever assigned
inside `if assumptions, ok := store.ResolveAssumptions(ctx, tenant, periodEnd);
ok { ... }` — when assumptions are unset the field stays a nil pointer, which
`MarshalJSON` renders as `null` and Go's `omitempty` drops from the wire
payload for CSV/summary alike. This reproduces AC-1 exactly (assumptions set →
both figures populated with `assumption_version`; unset → both `null`) without
a runtime branch anyone could forget in a future call site.

### 2.3 `GET /api/v1/value/summary`

`GET /api/v1/value/summary?period=2026-07&workspace_id=?` — reads only
finalized `usage_monthly` rollups (or `usage_daily` within an open month for a
"month to date" view — same freshness contract as existing showback) plus, once
BRD 67 ships, a dedicated `governed_decision_daily`/`governed_decision_monthly`
rollup pair (see §2.5 for why this is a *new* rollup, not a widened
`usage_daily`). No raw-table scan at request time, matching
`QueryUsage`'s existing precedent (ROI-NFR-001).

```json
{
  "period": "2026-07",
  "workspace_id": null,
  "decisions": {
    "total": 12340,
    "by_decision": {"approved": 11800, "edited": 420, "rejected": 120},
    "by_kind": {"claims_disposition": 9000, "underwriting_review": 3340},
    "by_agent": {"claims-copilot": 12340},
    "by_pack": {"insurance-claims-payer": 12340}
  },
  "hours_saved_est": {"value": 4113.3, "assumption_version": 1},
  "labor_value_est_usd": {"value": 740400.0, "assumption_version": 1},
  "ai_cost_usd": 812.44,
  "cost_per_decision": {"value": 0.0658, "basis": "attributed"},
  "human_baseline_cost_usd": {"value": 740400.0, "assumption_version": 1},
  "net_value_est_usd": {"value": 739587.56, "assumption_version": 1},
  "ladder_savings_usd": null,
  "adoption": {"active_users": 84, "by_workspace": {"ws-7": 40, "ws-9": 44}},
  "provenance": {
    "rollup_version": "usage_monthly@2026-07-finalized",
    "assumption_version": 1,
    "meter_gap": null
  }
}
```

With assumptions unset (AC-1's second case): `hours_saved_est`,
`labor_value_est_usd`, `human_baseline_cost_usd`, `net_value_est_usd` are all
`null`; `provenance.assumption_version` is `null`; `decisions`/`ai_cost_usd`/
`adoption` are unaffected (they don't depend on assumptions).

Today, before BRD 67 ships (Tier 0): `decisions`, `cost_per_decision`,
`hours_saved_est`, `labor_value_est_usd`, `human_baseline_cost_usd`,
`net_value_est_usd` are all `null`; `provenance.meter_gap` explains why;
`ai_cost_usd` and `adoption` still populate. This is what slice 1 ships.

### 2.4 `GET /api/v1/value/trend`

`GET /api/v1/value/trend?metric=cost_per_decision&granularity=month&from=&to=&workspace_id=?`

```json
{
  "metric": "cost_per_decision",
  "granularity": "month",
  "points": [
    {"period": "2026-02", "value": 0.091, "basis": "blended",
     "rollup_version": "usage_monthly@2026-02-finalized", "distilled_rung_share": null},
    {"period": "2026-07", "value": 0.0658, "basis": "attributed",
     "rollup_version": "usage_monthly@2026-07-finalized", "distilled_rung_share": 0.42}
  ]
}
```

`distilled_rung_share` (the "why it declined" narration from ROI-FR-011) is
also an honest gap today: ai-gateway tracks `rung` per call
(`RequestLog.rung`) but usage-service's `MeterRecord` has no `rung` dimension
and ai-gateway's own cost breakdown groups by model/request-class, not rung.
Closing this needs a small, additive schema change — ingest `rung` as a new
optional dimension on the LLM token meters from the existing
`ai.tool_invoked.v1` payload (ai-gateway already has the value at emit time;
this is a superset of USG-FR-002, no new coupling) — scoped as a Should-tier
follow-up, not blocking slice 3; until it lands, `distilled_rung_share` is
`null` on every point, never fabricated from ladder config alone.

### 2.5 Rollup design: a dedicated `governed_decision` rollup, not a widened `usage_*`

`usage_hourly/daily/monthly`'s dimension tuple is
`(tenant_id, meter_key, bucket, workspace_id, user_id, agent_id, model,
cloud)` — fixed at the migration
([000001_init.up.sql:48-79](../../services/usage-service/migrations/000001_init.up.sql)).
`governed_decision`'s VMB-FR-002 dimensions (`decision`, `proposal_kind`,
`pack_name`, `edit_distance_bucket`) don't fit that tuple.

**Options weighed:**

- **(a) Widen the shared `usage_*` tuple** with four more nullable dimension
  columns. Rejected: every other meter (`api_calls`, `storage_gb_month`, …)
  would carry four permanently-null columns, bloats the PK and every existing
  index, and couples an ROI-specific concern into the generic metering spine
  that BRD 17 owns.
- **(b) A dedicated `governed_decision_daily`/`governed_decision_monthly`
  rollup pair**, refreshed by the same `RefreshRollups` job alongside the
  generic ones, keyed by `(tenant_id, bucket, workspace_id, agent_id, pack_name,
  proposal_kind, decision)`. **Chosen.** This is BRD 67's table to create
  (it owns `governed_decision` emission), but the shape is specified here
  because BRD 69's summary/trend queries are the reason the extra dimensions
  need to exist at rollup grain in the first place — a raw-table `GROUP BY`
  at request time would violate ROI-NFR-001.

### 2.6 BFF: SDL + resolvers

New SDL block (placed alongside the existing `CostPanel`/`Budget`/`RateCard`
block,
[services/bff-graphql/schema.graphql:3042-3163](../../services/bff-graphql/schema.graphql)):

```graphql
type ValueDecisions {
  total: Int!
  byDecision: JSON!
  byKind: JSON!
  byAgent: JSON!
  byPack: JSON!
}

"""A derived figure that only exists paired with its assumption version
(ROI-NFR-004) — mirrors usage-service's EstimatedValue at the wire level."""
type EstimatedValue {
  value: Float!
  assumptionVersion: Int!
}

type CostPerDecision {
  value: Float!
  basis: String!  # "blended" | "attributed"
}

type ValueAdoption {
  activeUsers: Int!
  byWorkspace: JSON!
}

type ValueProvenance {
  rollupVersion: String!
  assumptionVersion: Int
  meterGap: String
}

"""Per-tenant value/ROI summary for a period (usage-service GET /api/v1/value/summary, BRD 69 ROI-FR-010)."""
type ValueSummary {
  period: String!
  workspaceId: String
  decisions: ValueDecisions
  hoursSavedEst: EstimatedValue
  laborValueEstUsd: EstimatedValue
  aiCostUsd: Float!
  costPerDecision: CostPerDecision
  humanBaselineCostUsd: EstimatedValue
  netValueEstUsd: EstimatedValue
  ladderSavingsUsd: Float
  adoption: ValueAdoption!
  provenance: ValueProvenance!
}

type ValueTrendPoint {
  period: String!
  value: Float
  basis: String
  rollupVersion: String!
  distilledRungShare: Float
}

type ValueTrend {
  metric: String!
  granularity: String!
  points: [ValueTrendPoint!]!
}

"""Tenant-scoped, versioned value-reporting assumptions (usage-service, ROI-FR-001).
Ships absent — no fabricated defaults (null means "not set", not zero)."""
type ValueAssumptions implements Node {
  id: ID!
  urn: String!
  version: Int!
  minutesPerDecision: JSON!
  loadedHourlyRateUsd: Float!
  effectiveFrom: Date!
  status: String!
  createdBy: String!
  createdAt: DateTime!
}

input UpdateValueAssumptionsInput {
  minutesPerDecision: JSON!
  loadedHourlyRateUsd: Float!
}

type ValueExport implements Node {
  id: ID!
  urn: String!
  period: String!
  workspaceId: String
  version: Int!
  jsonUrl: String!
  jsonSha256: String!
  csvUrl: String!
  csvSha256: String!
  assumptionVersion: Int
  createdAt: DateTime!
}

extend type Query {
  valueSummary(period: String!, workspaceId: String): ValueSummary!
  valueTrend(metric: String!, granularity: String = "month", from: String, to: String, workspaceId: String): ValueTrend!
  valueAssumptions: ValueAssumptions
  valueAssumptionHistory: [ValueAssumptions!]!
  valueExports(period: String): [ValueExport!]!
}

extend type Mutation {
  updateValueAssumptions(input: UpdateValueAssumptionsInput!): ValueAssumptions!
  exportValueReport(period: String!, workspaceId: String, idempotencyKey: String): ValueExport!
}
```

**Resolvers.** A new `ValueClient` in
`services/bff-graphql/src/clients/value.ts`, same shape as the existing
`UsageClient`
([clients/usage.ts](../../services/bff-graphql/src/clients/usage.ts)):
typed DTOs, `unwrap()` helper, one method per endpoint. Wired into
`ctx.clients.value` exactly like `ctx.clients.usage` is wired today
(`resolvers/index.ts:1385-1435`
[services/bff-graphql/src/resolvers/index.ts](../../services/bff-graphql/src/resolvers/index.ts)),
each resolver a thin pass-through with field-name normalization
(`camelCase` ↔ `snake_case`), the same pattern `workspaceCostPanel` follows
today.

### 2.7 Page structure: `/admin/value`

`/admin/value` (chosen over `/reports/value` to sit next to the existing
`/admin/usage` sibling
([services/ui-web/src/app/(app)/admin/usage/page.tsx](<../../services/ui-web/src/app/(app)/admin/usage/page.tsx>))
— same admin-shell nav group, same capability-gating idiom). Composed
entirely from existing primitives, no new chart library:

- `PageHeader` (`components/shell/PageHeader.tsx`) — title + period selector.
- Headline tiles: four `Card`/`CardHeader`/`CardTitle`/`CardContent` blocks
  (decisions, hours saved, cost/decision, net value), each following the
  `text-3xl font-bold` big-number pattern already used at
  `(app)/page.tsx:83-96`, wrapping `AsyncBoundary`
  (`components/primitives/AsyncBoundary.tsx`) so a `null` estimate renders the
  "set assumptions to see hours saved" empty state per ROI-NFR-004/AC-1 rather
  than a blank or a fabricated zero.
- Decision-mix chart: `BarChart` (`components/charts/BarChart.tsx`) fed
  `{columns: ["approved","edited","rejected"], rows: [[...]]}` from
  `decisions.by_decision`.
- Tenure trend chart: `LineChart` (`components/charts/LineChart.tsx`) fed
  `valueTrend.points`, with the `distilled_rung_share` annotation rendered as
  a secondary label under the chart when non-null (never a second invented
  series when null).
- Adoption table: `DataTable` (`components/primitives/DataTable.tsx`), same
  pattern as `AnomaliesCard`/`BudgetsCard` in `admin/usage/page.tsx`.
- Assumptions panel: an inline form (no modal — MASTER-FR-096, this is a
  reversible action with full history, same as `BudgetDetail`'s inline edit
  form at `admin/usage/page.tsx:237-316`) plus a history list from
  `valueAssumptionHistory`. Gated by a **new** `manageValueAssumptions`
  `FEATURE_GATES` entry mapping to `usage.report.manage` (does not exist yet
  — see §2.9). Read access to the whole page gated by the existing
  `viewCostPanel` gate (`usage.report.read`,
  [registry.ts:257](../../services/ui-web/src/lib/authz/registry.ts)), reused
  as-is per ROI-FR-020.
- Export button: triggers `exportValueReport`, links to `valueExports` list
  (same `DataTable` + presigned-URL-as-link pattern as any other export list
  in the codebase).

No polling (MASTER-FR-098 / ROI-FR-020 Could-tier SSE deferred) — the page
refetches on period-selector change and on an explicit refresh action, same
as `CostPanel` does today (its own doc comment already explains why the
`usage.events.v1` broadcast subscription was removed — no matching
realtime-hub scheme yet, `CostPanel.tsx:16-23`).

### 2.8 `value-report.v1` export

**Flow**, modeled on chart-service's `ObjectStore`/`FSStore` pattern
([internal/export/export.go](../../services/chart-service/internal/export/export.go))
for the object-storage mechanics, and on audit-service's manifest-listing
idea
([internal/api/handlers.go:357-382](../../services/audit-service/internal/api/handlers.go))
for the "checksummed + listed" requirement — but explicitly **not** WORM/
Object-Lock: a value report is a periodic business export a tenant admin can
regenerate, not a compliance record with a regulatory retention clock.
Immutability is by convention (new version, key never overwritten), the same
convention BRD 67 documents for billing exports
(`billing/<tenant>/<period>/<version>/`, VMB-FR-021) — mirrored here even
though BRD 67 itself is unbuilt, because it is the platform's one paved road
for "immutable, versioned, periodic export."

1. `POST /api/v1/value-reports` `{period, workspace_id?}` with
   `Idempotency-Key` (MASTER-FR-025).
2. Handler recomputes `/value/summary` and `/value/trend` **server-side**
   (never trusts client-supplied figures) to guarantee the export matches
   what the API would return right now for that period.
3. Builds two artifacts:
   - `report.json` — `value-report.v1` schema (below).
   - `report.csv` — RFC 4180 + UTF-8 BOM (reusing the same technique as
     chart-service's `WriteCSV`, reimplemented locally since services don't
     share Go packages across DB-per-service boundaries), assumptions
     disclosed as leading `#`-prefixed header rows so AC-4's "assumptions
     disclosed" holds even in a flat CSV.
4. SHA256 each artifact; `ObjectStore.Put(ctx, key, bytes, ttl)` writes both
   under `value-reports/<tenant>/<period>/<version>/{report.json,report.csv}`
   (`FSStore` for local/dev, S3/MinIO-compatible in prod — no Object-Lock).
5. Insert one row into a new `value_exports` table (tenant_id, period,
   workspace_id, version, json_key, json_sha256, csv_key, csv_sha256,
   assumption_version, generated_by, created_at) — this is the "listed in
   exports" requirement; `GET /api/v1/value-reports?period=` lists rows with
   presigned download URLs, same response shape as audit-service's
   `handleListExports`.
6. Emit `value.report_exported.v1` (MASTER-FR-040 audit event,
   `resource_urn` = the export row, digest = `json_sha256`).
7. Re-running export for an already-exported period inserts version N+1;
   version N's object keys and row are untouched (never overwritten).

```json
{
  "schema": "value-report.v1",
  "tenant_id": "t-42",
  "period": "2026-07",
  "workspace_id": null,
  "generated_at": "2026-08-01T02:10:00Z",
  "generated_by": {"type": "user", "id": "u-9"},
  "assumptions": {
    "version": 1,
    "effective_from": "2026-01-01",
    "loaded_hourly_rate_usd": 180.0,
    "minutes_per_decision": {"claims_disposition": 20}
  },
  "summary": { "...": "same shape as GET /api/v1/value/summary" },
  "trend": { "...": "same shape as GET /api/v1/value/trend, 12mo cost_per_decision" },
  "rollup_versions": ["usage_monthly@2026-07-finalized"],
  "checksum_sha256": "<sha256 of this document with checksum_sha256 itself zeroed>"
}
```

### 2.9 New authz action

`usage.report.manage` does not exist in
[internal/authz/authz.go:48-62](../../services/usage-service/internal/authz/authz.go)
— it must be added alongside the existing `usage.report.read`, gating
`PUT /value/assumptions` (ROI-FR-002) and `POST /value-reports` generation
stays on the existing `usage.report.read` (viewing/exporting current figures
is a read-shaped action; only *changing* the assumptions that drive future
figures needs the stronger grant). `FEATURE_GATES.manageValueAssumptions`
(new) maps to it in `ui-web/src/lib/authz/registry.ts`, following the exact
`cap("usage.report.read")` idiom already used at
[registry.ts:257](../../services/ui-web/src/lib/authz/registry.ts).

### Out of scope (per BRD 69 §1, reaffirmed here)

Outcome-verified value (needs BRD 55's SoR/drift enrichment, unbuilt per
`docs/brd/55_decision_outcome_monitoring_BRD.md` §5a — increment 1 only ships
human-labeled outcome + effectiveness, no semantic-model surfacing);
cross-tenant benchmarking; any pricing/billing computation (BRD 67's
concern); marketing-site claims; real BRD 67 implementation (a separate
initiative — this design only specifies the contract BRD 69 needs from it,
per §2.0).

---

## 3. Implementation & Test

**Status:** slices 1-3 implemented — 2026-07-25.

### Repo-state finding that changed the plan: BRD 67 slice 1 shipped mid-flight

This design's §2.0 was written when BRD 67 was 0% built. Since then, BRD 67
slice 1 (commit 417afd2) shipped the `governed_decision`/`auto_executed_action`
meters end-to-end: ingest mapping
([internal/ingest/mapping.go](../../services/usage-service/internal/ingest/mapping.go)),
catalog entries
([internal/domain/types.go:66-67](../../services/usage-service/internal/domain/types.go)),
and — critically — it widened the **generic** `usage_hourly/daily/monthly`
rollup tuple with `pack_name`/`decision` columns
([migrations/000004_value_meters.up.sql](../../services/usage-service/migrations/000004_value_meters.up.sql)),
which is **option (a)** from this design's own §2.5 ("Options weighed") —
the option §2.5 explicitly rejected in favor of a dedicated
`governed_decision_daily`/`monthly` rollup pair keyed by `proposal_kind` among
other dims. The as-shipped BRD 67 took the other fork.

Two consequences, verified against the current schema before writing slice 1:

1. **The repo is at Tier 1 today, not Tier 0.** `decisions.total`,
   `by_decision` (the `decision` column), `by_agent`, and `by_pack` are all
   computable from `usage_monthly` right now, no waiting on BRD 67.
   `cost_per_decision` is blended (`ai_cost_usd / decisions.total`).
2. **`decisions.by_kind` is a genuine, currently-open gap beyond what §2.0
   anticipated.** `proposal_kind` was kept raw-detail-only in
   `usage_raw.meta` (never rolled up — see that migration's own doc comment),
   because BRD 67 didn't ship the dedicated rollup this design's §2.5 wanted.
   Consequently `hours_saved_est`/`labor_value_est_usd`/
   `human_baseline_cost_usd`/`net_value_est_usd` — which need per-kind decision
   counts to apply `minutes_per_decision[kind]` — **cannot be honestly
   computed from the real store today**, even with assumptions set. Per the
   honesty invariant, they render `null` with `provenance.meter_gap` naming
   the gap explicitly, rather than fabricating a blended-minutes estimate
   nobody asked this design to invent. The computation logic itself (the
   per-kind formula, AC-1's exact numbers) is implemented and unit-tested
   against a synthetic by-kind fixture in `internal/valuecalc` — the design's
   own test-plan language anticipated exactly this ("Tier 1/2 behavior is
   currently only unit-testable against a synthetic fixture, not a real
   emitter"), it just didn't foresee that `by_kind` specifically would be the
   piece missing a real emitter. Closing this needs BRD 67 to add
   `proposal_kind` as a rollup-worthy dimension — tracked here as an open
   dependency, not assumed complete.

### Deviation: `usage.assumptions.update`, not `usage.report.manage`

§2.9 named the new authz action `usage.report.manage`. Verified against
`rbac-service/internal/domain/catalog.go` (`AllVerbs`, RBC-FR-022's closed verb
grammar) and `rbac-service/seed/roles_actions.yaml`'s own comment that
non-closed verbs like `eval.canary.manage` "would fail EnsureSystemRoles at
boot" if bound to a role: **`manage` is not a closed-grammar verb anywhere on
this platform.** Shipping `usage.report.manage` would register successfully
(rbac's registration endpoint validates verbs) but fail the moment any role
tried to bind it. Implemented instead as **`usage.assumptions.update`** — a
new `assumptions` resource with the canonical `update` verb, same intent,
grammar-compliant. See the doc comment on `authz.ActionAssumptionsUpdate`
([internal/authz/authz.go](../../services/usage-service/internal/authz/authz.go)).
**Follow-up, out of this task's scope (rbac-service ownership):** no seeded
role binds `usage.assumptions.update` yet in
`rbac-service/seed/roles_actions.yaml` — a Tenant Admin binding needs adding
there before a non-platform-admin persona can exercise it in a live cell.

### Slice 1 — assumptions CRUD + summary API — DONE

- Migration `services/usage-service/migrations/000005_value_assumptions.{up,down}.sql`
  (numbered 000005, not the design's illustrative 000004 — BRD 67 slice 1
  already claimed 000004). `value_assumptions` table + RLS policy, mirroring
  `rate_cards`' append-only versioning.
- `internal/domain/value.go`: `ValueAssumptions`, `EstimatedValue` (the
  §2.2 null-guarantee, verbatim), `DecisionsBreakdown`, `Adoption`,
  `ValueSummary` and view types, `CostPerDecision`, `ValueProvenance`.
- `internal/valuecalc/valuecalc.go`: pure `BuildSummary` — the tier-branch
  logic (Tier 0 / by-kind-gap / full), independent of the store.
- `internal/store/value_assumptions.go`: `PutAssumptions` (version+supersede
  in one tx), `ResolveAssumptions` (as-of lookup, AC-3 pinning),
  `AssumptionHistory`.
- `internal/store/value_summary.go`: `ValueSummaryInputs` — reads
  `usage_monthly` only (ROI-NFR-001), no raw scans.
- `internal/api/handlers_value.go`: `PUT/GET /value/assumptions`,
  `GET /value/assumptions/history`, `GET /value/summary`.
- `internal/authz/authz.go`: `usage.assumptions.update` (see deviation above).
- `internal/events/events.go`: `value_assumptions.updated`.
- `internal/domain/urn.go`: `ValueAssumptionsURN`, `ValueExportURN`.
- Routing: `internal/api/server.go` (Store interface + routes).

### Slice 2 — UI page — DONE

- `services/ui-web/src/app/(app)/admin/value/page.tsx`: headline tiles
  (decisions, hours saved, cost/decision, net value) each independently
  wrapped in `AsyncBoundary` so a `null` estimate renders its own honest empty
  state; decision-mix `BarChart`; tenure-trend `LineChart` with the
  distilled-rung-share annotation (always "not available yet" today, see
  §2.4); adoption `DataTable`; assumptions panel (inline form, no modal,
  gated by `manageValueAssumptions`) + edit-history table; exports card.
- `services/ui-web/src/lib/graphql/{types,operations,hooks,keys}.ts`:
  additive — `ValueSummary`/`ValueTrend`/`ValueAssumptions`/`ValueExport`
  types, the six query/mutation documents, `useValue*` hooks.
- `services/ui-web/src/lib/authz/registry.ts`: additive —
  `manageValueAssumptions: cap("usage.assumptions.update")`. Read access
  reuses the existing `viewCostPanel` gate per §2.7 (no new read gate).
- **Not done, deliberately out of scope:** no link was added to the
  `/admin` hub (`services/ui-web/src/app/(app)/admin/page.tsx`) — that file
  is not in this task's file-ownership list and is a shared file a
  concurrently-running BRD 70 agent may also be touching; adding a link there
  risked an edit collision on a file neither agent exclusively owns. The page
  is fully functional and gated at `/admin/value` directly. Follow-up: add
  the hub link once BRD 70's concurrent work lands.
- **bff-graphql** (`schema.graphql`/`typeDefs.ts` regenerated via
  `pnpm run schema:snapshot`, not hand-edited — this repo generates the SDL
  snapshot from `typeDefs.ts`, discovered while wiring the schema):
  `ValueClient` in `src/clients/value.ts`, wired into `ctx.clients.value`
  (same usage-service base URL as `ctx.clients.usage`), resolvers + mappers
  in `src/resolvers/index.ts` / `src/schema/map.ts`.

### Slice 3 — trend + export — DONE

- `internal/store/value_trend.go`: `ValueTrendPoints` (one point/month,
  reusing `ValueSummaryInputs`; `distilled_rung_share` always `null` today —
  the ai-gateway `rung` dimension isn't wired to usage-service's
  `MeterRecord`, exactly the gap §2.4 names as a Should-tier follow-up).
- `internal/valueexport/export.go`: `WriteCSV` (RFC 4180 + BOM, leading
  `#`-comment rows disclosing assumptions), `SHA256Hex`, `ObjectStore`/
  `FSStore` — reimplemented locally (not shared) per §2.8's own note that
  services don't share Go packages across DB-per-service boundaries, mirrored
  from chart-service's `internal/export/export.go`.
- Migration `000006_value_exports.{up,down}.sql`: `value_exports` table + RLS.
- `internal/store/value_exports.go`: `CreateValueExport` (version+1 per
  (tenant, period, workspace), never overwrites), `ListValueExports`.
- `internal/api/handlers_value.go` (`handleValueTrend`) and
  `internal/api/handlers_value_export.go` (`handleExportValueReport`,
  `handleListValueReports`, `handleDownloadValueExport` — HMAC-signed, not
  JWT, mirroring chart-service's `GET /exports/*`).
- `cmd/server/main.go`: wires a real `valueexport.FSStore` (`VALUE_EXPORT_ROOT`/
  `VALUE_EXPORT_SIGNING_SECRET` env vars, same shape as chart-service's
  `EXPORT_ROOT`/`EXPORT_SIGNING_SECRET`).
- **Explicitly deferred, as the design anticipated:** ROI-FR-022 (scheduled
  monthly export to notification-service) — Could-tier, not started. Tier 2
  (`usage_decisions`/`savings_usd_est`/true `attributed` cost basis /
  `ladder_savings_usd`) remains fully unbuilt, tracked as a BRD 67 dependency
  as before.

### Test plan — results

All commands below were actually run in this environment; pass/fail counts
are observed, not projected. Docker is unavailable in this environment (the
daemon cannot start — confirmed via `docker ps` and `service docker start`
failing with a permissions error), so the Go integration tier could not be
executed here; it auto-skips per this repo's convention
(`docs/platform/CONVENTIONS.md` "must auto-skip with a clear message when
Docker is unavailable") rather than being silently omitted.

**Go unit — VERIFIED (run):**
```
cd services/usage-service && go build ./... && go vet ./... && go test -short ./...
```
Result: build clean, vet clean, **35 tests pass, 0 fail** across
`internal/valuecalc` (7 — `TestBuildSummary_Tier0`, `_Tier1_NoByKind`,
`_Tier1_WithByKind_AC1` reproducing AC-1's exact $740,400/4,113.3 numbers,
`_AssumptionsUnset`, `_ZeroDecisions_NoCostPerDecision`,
`TestEstimatedValue_MarshalJSON_NilVsPopulated`,
`TestValueSummary_JSONRoundTrip_AllTiers`), `internal/valueexport` (4 —
CSV/BOM/leading-comments, SHA256 determinism, FSStore put/sign/read round
trip including tampered-signature and expired-link rejection, re-export
never-overwrites), plus every pre-existing package (`internal/api`'s
`drift_test.go` confirms `usage.assumptions.update` registers as a valid
`<service>.<resource>.<verb>` action) — no regressions.

**Go integration — WRITTEN, COMPILE-CHECKED, NOT RUN (Docker unavailable):**
```
cd services/usage-service && go vet ./... && go test ./test/integration/... -v -run 'TestAC1_AssumptionsSetAndUnset|TestAC2_AssumptionHistory|TestAC3_ResolveAssumptions|TestAC5_ReadOnlyUser|TestAC_RLS_ValueAssumptions|TestAC4_ExportValueReport|TestValueTrend_ReturnsMonthlyPoints'
```
Result: compiles clean; all 7 new tests print `--- SKIP` with the harness's
standard "real infra unavailable" message (22 total integration tests skip
the same way, 15 pre-existing + 7 new — none fail). New tests, in
`test/integration/value_test.go` and `value_export_test.go`:
`TestAC1_AssumptionsSetAndUnset_ValueSummary`,
`TestAC2_AssumptionHistory_RecordsVersionsWithActor`,
`TestAC3_ResolveAssumptions_PinsToVersionActiveAtPeriodClose`,
`TestAC5_ReadOnlyUser_Denied403OnAssumptionWrite` (real OPA),
`TestAC_RLS_ValueAssumptionsCrossTenantEmpty`,
`TestAC4_ExportValueReport_ChecksumAndVersionIncrement` (downloads the signed
artifact and asserts the served bytes' SHA256 matches the API's reported
checksum), `TestValueTrend_ReturnsMonthlyPoints`. The harness itself
(`harness_test.go`) was extended to wire a real `valueexport.FSStore` onto
the shared test server.

**bff-graphql unit — VERIFIED (run):**
```
cd services/bff-graphql && npm run typecheck && npx vitest run
```
Result: typecheck clean; **331 tests pass, 0 fail across 41 files** (up from
322/40 pre-existing), including the schema-snapshot drift gate (confirms
`typeDefs.ts` and the checked-in `schema.graphql` agree) and the new
`tests/unit/value.test.ts` (9 tests): field-for-field mapping of a populated
summary, and — the load-bearing assertion — a Tier-0/gap-shaped summary
round-trips through the resolver chain with every `null` staying `null`
(`decisions`, `hoursSavedEst`, `costPerDecision`, `ladderSavingsUsd`,
`provenance.assumptionVersion` all asserted `null`, never `0`/`{}`), plus
`updateValueAssumptions`/`valueAssumptionHistory`/`exportValueReport`/
`valueExports` resolver wiring.

**ui-web component tests — VERIFIED (run):**
```
cd services/ui-web && npm run typecheck && npm run lint && npx vitest run
```
Result: typecheck clean; lint clean (no new warnings); **496 tests pass, 0
fail across 80 files** (up from 488/79 pre-existing), including the new
`src/app/(app)/admin/value/value.test.tsx` (8 tests): populated-tile
rendering, the Tier-0/gap empty states (decisions tile, decision-mix chart,
hours-saved/net-value tiles all show their honest empty state, never a
fabricated `0`), the assumptions-panel empty state ("No assumptions set.",
never a default rate), `manageValueAssumptions` gating (an admin sees "Set
assumptions"; a `usage.report.read`-only viewer sees the tiles but not the
edit control — AC-5 at the UI layer), the assumption-edit submit flow, and
the export button wiring.

**Live Playwright — WRITTEN, PENDING LIVE VERIFICATION (stack not started):**
`services/ui-web/tests-live/value-journeys.spec.ts`, following
`cases-journeys.spec.ts`'s fixtures/conventions exactly: tenant admin sets
assumptions via the real mutation → the `/admin/value` page reflects them (no
fabricated defaults) → headline tiles render → exports a report through the
real UI button → the exports list's `jsonUrl` is fetched and its SHA256
verified against the API-reported `jsonSha256` (AC-4's literal "downloads and
verifies the checksum matches the served bytes"); a second test covers a
lower-privilege persona seeing the page without the edit control. Not
executed — this task did not boot `deploy/local/up.sh`, and per
`docs/platform/CONVENTIONS.md`, real infra here requires Docker, which this
environment cannot run.

### Known limits, carried forward and updated

Tier 2 (`usage_decisions`, `savings_usd_est`, true `attributed` cost basis,
`ladder_savings_usd`) remains fully unbuilt — a BRD 67 dependency, unchanged
from the original plan. **New finding this pass:** `decisions.by_kind` and
every assumption-derived `*_est` figure are ALSO blocked today, not by BRD 67
being unbuilt, but by a schema choice BRD 67 slice 1 already made (generic
rollup widening instead of this design's preferred dedicated
`governed_decision` rollup with `proposal_kind`) — see "Repo-state finding"
above. The math itself is implemented and proven correct against AC-1's exact
numbers via a synthetic fixture (`internal/valuecalc`); only the real-store
wiring for `by_kind` is pending a BRD 67 schema change.
