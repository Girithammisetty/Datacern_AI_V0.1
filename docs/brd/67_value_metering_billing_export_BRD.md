# BRD 67 — Value Metering & Billing Export

**Service:** usage-service (owner) + agent-runtime/case-service (emitters) · **Language:** Go (+Py emitters) · **Phase:** GTM-1 · **Status:** Approved for build
**Inherits:** `00_MASTER_BRD.md`; extends `17_usage_service_BRD.md` (implements the design-only USG-FR-080..086 per-decision attribution and adds value meters + billing export). Origin: `../DATACERN_COMPETITIVE_LANDSCAPE_AND_GTM_ROADMAP.md` §5 A2, §6 B2.

---

## 1. Overview

**Purpose.** Close the pitch-vs-code gap: pricing is sold as "per governed decision" (`DATACERN_PARTNER_BRIEFING.md` §6) but the meter catalog is infra-shaped only (`usage-service/internal/domain/types.go:47-86` — tokens, bytes, minutes; no decision meter). This BRD adds **value-shaped meters**, wires the already-specified per-decision cost attribution (USG-FR-080..086), and adds a **billing export pipeline** so an external rating/billing system (Lago or Stripe/Metronome) can invoice — usage-service still never collects money (BRD 17 out-of-scope stands).

**Business value.** The `governed_decision` meter is the pricing unit, the ROI-dashboard substrate (BRD 69), and the trial-conversion evidence (BRD 66). Billing export turns 80%-built metering into revenue capture. Buyers in 2026 expect transparent unit economics; decision-denominated pricing is objective and already observable in the proposal spine.

**In scope.** New meters `governed_decision`, `case_resolved`, `auto_executed_action` with value dimensions; emission points in agent-runtime (proposal decided) and case-service (case closed); implementation of USG-FR-080..086 (`usage_decisions` attribution); billable-period close (month-end snapshot per tenant: meter totals × rate card, allowance drawdown from BRD 66 entitlements); export as versioned, immutable billing artifacts (JSONL + CSV) to object storage + `billing.export_ready.v1` event; optional push adapter interface for Lago/Stripe-Metronome (adapter behind a typed port, honest `BillingPushNotConfigured` when unwired — GpuTrainer pattern).

**Out of scope.** Invoice rendering, payment collection, dunning, tax (external billing system); outcome-based pricing (needs BRD 55 outcome labels — future); credit-wallet purchase flows; changes to budget enforcement semantics (BRD 17 owns).

## 2. Actors & user stories

Personas: **Platform Operator/Finance-ops**, **Tenant Admin**, **agent-runtime/case-service** (emitters), **External billing system** (consumer), **Sales** (via exports).

- **US-1** As a Platform Operator, I want every four-eyes decision metered with agent/pack/workspace/disposition dimensions, so pricing, showback, and ROI all share one truth.
- **US-2** As a Tenant Admin, I want to see governed decisions this month next to cost, so cost-per-decision is a number, not a slide.
- **US-3** As Finance-ops, I want a month-end billable snapshot per tenant (meters × rate card − included allowances), exported immutably, so the billing system can rate and invoice without re-deriving usage.
- **US-4** As the external billing system, I want a `billing.export_ready.v1` webhook/event with a fetch URL, so ingestion is pull-based and replayable.
- **US-5** As a Platform Operator, I want per-agent-run decision cost (USG-FR-080) visible on the run detail page, so expensive workflows are attributable.
- **US-6** As Sales, I want trial-period decision counts and cost-per-decision in the conversion snapshot (CPL-FR-024), so renewal/expansion conversations are evidence-based.

## 3. Functional requirements

### Value meters
- **VMB-FR-001 (Must)** New catalog meters (versioned additions per USG-FR-004, canonical units per USG-FR-005):

| meter_key | Unit | Aggregation | Source event | Emitter |
|---|---|---|---|---|
| `governed_decision` | count | sum | `ai.proposal_decided.v1 · proposal.decided` | agent-runtime |
| `case_resolved` | count | sum | `case.events.v1 · case.closed` | case-service |
| `auto_executed_action` | count | sum | `ai.proposal_decided.v1 · proposal.auto_executed` | agent-runtime |

- **VMB-FR-002 (Must)** `governed_decision` dimensions (beyond USG-FR-002 standard): `agent_id`, `agent_version`, `pack_name?` (from agent config origin), `proposal_kind`, `decision(approved|edited|rejected)`, `decision_latency_ms`, `edit_distance_bucket?(none|minor|major)`. Decisions are metered once per proposal terminal decision (supersede/expiry are not metered).
- **VMB-FR-003 (Must)** Emission is transactional-outbox from the proposal decision commit (agent-runtime `proposals/service.py` decide path) — a decision that commits always meters exactly once (idempotent on `proposal_id` downstream per USG-FR-011).
- **VMB-FR-004 (Should)** `case_resolved` carries `disposition`, `pack_name?`, `had_agent_assist(bool)` so pure-manual vs agent-assisted resolution is distinguishable (ROI denominator, BRD 69).

### Per-decision cost attribution (activate USG-FR-080..086)
- **VMB-FR-010 (Must)** Implement USG-FR-080..086 as specified in BRD 17 §3.8 (`usage_decisions` store, even cost split across `decision_urns[]`, no double-count vs `usage_raw` — AC-16 semantics), including the ai-gateway contract (`decision_urns[]` on `ai.token_usage.v1`, AIG-FR-089) and agent-runtime propagation of the active proposal/case URNs into gateway calls.
- **VMB-FR-011 (Must)** `GET /api/v1/decisions/costs?scope=…` returns cost-per-decision aggregates (by agent, pack, workspace, period) for BFF/ROI consumption; run-detail per-URN cost surfaces on `/copilot/runs/{id}`.

### Billable-period close & export
- **VMB-FR-020 (Must)** Month-end close job per tenant (leader-elected, idempotent, runs after the 48h late-event window + reconciliation, per USG-FR-014/070): snapshot `{period, tenant, meter totals, rate card version applied, gross_usd per meter, allowance drawdown (from CPL entitlements, BRD 66), net billable}` into `billing_periods` (immutable rows; corrections are new versions, never updates).
- **VMB-FR-021 (Must)** Export artifacts per closed period: JSONL (line = meter × dimensions rollup) + summary CSV, written to object storage under `billing/<tenant>/<period>/<version>/`, checksummed; `billing.export_ready.v1` emitted with URN + checksum. Re-export of a corrected period increments version and re-emits (consumer dedups on `(tenant, period, version)`).
- **VMB-FR-022 (Must)** Push adapter port `BillingPusher` with `lago` and `stripe_metronome` adapter stubs that raise typed `BillingPushNotConfigured` unless configured (honest-stub convention, no fabricated success). File export (VMB-FR-021) is the always-on path.
- **VMB-FR-023 (Should)** `GET /api/v1/billing/periods?tenant=…` lists closed periods + artifact links (platform-operator scope; tenant admins see their own net summary, not rate internals unless granted).
- **VMB-FR-024 (Could)** Draft-period preview endpoint (current month-to-date at current rate card) powering a "projected bill" panel.

## 4. Non-functional requirements

- **VMB-NFR-001** Metering lag for value meters follows USG-FR-012 (p95 ≤30s); close job completes ≤15 min per 1M decisions/tenant/month.
- **VMB-NFR-002** `billing_periods` and export artifacts are immutable + checksummed (audit-grade; disputes resolved by replay, not edit).
- **VMB-NFR-003** RLS on all new tables; exports are tenant-partitioned object keys re-keyed from verified server-side tenant (never client-supplied, MASTER-FR §4.1).
- **VMB-NFR-004** No new PII in metering dimensions (user_id allowed per USG-FR-002; no free-text).

## 5. Acceptance criteria (selection)

- **AC-1** Approve a proposal → exactly one `governed_decision` raw record with `decision=approved`, correct agent/pack dims; replay of the Kafka event is a no-op (USG-FR-011).
- **AC-2** Edit-approve a proposal → `decision=edited`, `edit_distance_bucket` populated; reject → `decision=rejected`. Expire/supersede → no meter record.
- **AC-3** An agent run touching case c-9 and proposal p-4 with a $0.008 gateway call → two `usage_decisions` rows at $0.004 (BRD 17 AC-16 passes as written).
- **AC-4** Close July for tenant t-42 with rate card v3 and a 10k `governed_decision` allowance: totals 12,340 decisions → snapshot shows drawdown 10,000, net billable 2,340 × unit price; JSONL+CSV land with checksums; `billing.export_ready.v1` emitted once.
- **AC-5** Re-close after a late correction → version 2 artifacts, version 1 untouched, event re-emitted with v2.
- **AC-6** `BillingPusher` unconfigured → push attempt fails `BillingPushNotConfigured`, period stays `exported` (file path is truth), no invoice fabricated.

## 6. Events & data

Emitters: agent-runtime `ai.proposal_decided.v1` (extend existing decision event or add metering envelope fields — decide in design), case-service `case.closed`. New tables (usage-service DB, RLS): `usage_decisions` (per BRD 17 §3.8), `billing_periods`, `billing_exports`. New topic: `billing.events.v1` (`export_ready`, `period_closed`, `period_corrected`). Config: rate-card linkage reuses BRD 17 rate cards; allowances read from BRD 66 `entitlements_flat` projection.
