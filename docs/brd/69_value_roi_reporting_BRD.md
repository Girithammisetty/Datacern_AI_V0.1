# BRD 69 — Value & ROI Reporting

**Service:** usage-service (metrics) + bff-graphql/ui-web (surface) · **Language:** Go + TS · **Phase:** GTM-1 · **Status:** Approved for build
**Inherits:** `00_MASTER_BRD.md`. Depends on BRD 67 (value meters, per-decision cost); complements BRD 55 (outcome monitoring — future enrichment). Origin: `../DATACERN_COMPETITIVE_LANDSCAPE_AND_GTM_ROADMAP.md` §6 B5.

---

## 1. Overview

**Purpose.** An exec-facing **value dashboard** and exportable board-ready report per tenant: governed decisions completed, approval/edit/reject mix, estimated hours saved (customer-editable per-task-time assumptions × decisions), cost-per-decision vs a customer-set human-baseline rate, model-ladder savings (distillation story), adoption by workspace/team. The Copilot-Analytics/Glean-TEI pattern: renewals and expansion are won with in-product value evidence, and the same instrumentation is the backbone for any future outcome-based pricing.

**Business value.** Datacern's unique margin narrative — cost-per-decision *declines* with tenure — is currently invisible. This BRD makes it a chart. It also powers POC success dashboards (BRD 70) and trial-conversion snapshots (CPL-FR-024). Honesty rule inherited from `/welcome` ("no invented numbers"): every derived figure displays its inputs, and customer-editable assumptions are labeled as assumptions.

**In scope.** Assumption objects (per tenant, versioned): minutes-per-decision by proposal kind, loaded hourly rate; value metrics API aggregating BRD 67 meters + per-decision costs + ladder-savings (from ai-gateway `savings_usd_est`, USG-FR-080 schema); dashboard page (tenant-admin scope) with period selector; exportable report (PDF-ready JSON + CSV) via the audit-export storage path; trend of cost-per-decision over tenure.

**Out of scope.** Outcome-verified value (needs BRD 55 labels — the dashboard gains an "outcome-verified" tier later; v1 figures are assumption-based and labeled so); benchmarking across tenants (privacy); any pricing/billing math (BRD 67); marketing-site claims.

## 2. Actors & user stories

- **US-1** As a Tenant Exec, I want a one-page value view — decisions, hours saved, cost per decision vs human baseline — so the renewal case is self-evident.
- **US-2** As a Tenant Admin, I want to edit the assumptions (minutes per decision kind, hourly rate), so figures reflect our operation, and I want the edit history visible.
- **US-3** As a CSM/Operator, I want the same view read-only per account, so QBRs use live data.
- **US-4** As a Tenant Exec, I want cost-per-decision trended since go-live, showing ladder/distillation savings, so "gets cheaper over time" is evidenced.
- **US-5** As a Tenant Admin, I want a board-ready export (period, totals, assumptions disclosed), so I can circulate it without screenshots.
- **US-6** As a POC sponsor, I want this view scoped to the POC window with agreed success metrics highlighted (BRD 70 consumes).

## 3. Functional requirements

### Assumptions
- **ROI-FR-001 (Must)** Tenant-scoped `value_assumptions` (versioned, audited): `{minutes_per_decision: {proposal_kind → minutes}, loaded_hourly_rate_usd, effective_from}`. Defaults ship null — the dashboard shows "set assumptions to see hours saved," never a fabricated default rate.
- **ROI-FR-002 (Must)** Assumption edits require `usage.report.manage` (or tenant-admin), keep full history, and recompute forward only (historical periods pin the assumption version active at period close).

### Metrics API
- **ROI-FR-010 (Must)** `GET /api/v1/value/summary?period=…&workspace?=` returns: `{decisions{total, by_decision, by_kind, by_agent, by_pack}, hours_saved_est?, labor_value_est_usd?, ai_cost_usd, cost_per_decision, human_baseline_cost_usd?, net_value_est_usd?, ladder_savings_usd, adoption{active_users, by_workspace}}`. Estimation fields are null when assumptions unset; every `*_est` field carries the assumption version used.
- **ROI-FR-011 (Must)** Tenure trend: `GET /api/v1/value/trend?metric=cost_per_decision&granularity=month` from rollups; includes model-mix annotation (share of calls served by distilled rung, from ai-gateway dims) to narrate *why* cost declined.
- **ROI-FR-012 (Should)** Agent-assist lift: where `case_resolved.had_agent_assist` exists (VMB-FR-004), compare cycle-time and touch-count assisted vs unassisted (computed from case-service timeline aggregates exposed to usage-service via event dims — no new sync coupling).

### Surface & export
- **ROI-FR-020 (Must)** `/admin/value` (or `/reports/value`) page: headline tiles (decisions, hours saved, cost/decision, net value), decision-mix chart, tenure trend chart, adoption table, assumptions panel with edit + history. Capability-gated `usage.report.read`; assumption edit gated per ROI-FR-002. AsyncBoundary empty/degraded states; no polling (SSE patch on period close events is a Could).
- **ROI-FR-021 (Must)** Export: `POST /exports/value-report` → JSON (schema `value-report.v1`) + CSV, disclosing assumptions inline; stored/ checksummed/ listed like audit exports; generation audited.
- **ROI-FR-022 (Could)** Scheduled monthly export to notification-service (email/webhook) recipients.

## 4. Non-functional requirements

- **ROI-NFR-001** Summary p95 ≤ 800ms from rollups (no raw scans at request time).
- **ROI-NFR-002** All figures reproducible: response embeds meter/rollup versions + assumption version; export immutable + checksummed.
- **ROI-NFR-003** RLS + capability gating per MASTER-FR; CSM/operator cross-tenant read follows the platform-admin read-only pattern (no drill past the wall).
- **ROI-NFR-004** Honesty invariant: no estimation field ever renders without its assumption provenance; unset assumptions → explicit empty-state, never defaults.

## 5. Acceptance criteria (selection)

- **AC-1** Tenant with 12,340 July decisions, assumptions {claims_disposition: 20 min, $180/hr} → hours_saved_est = 4,113.3, labor_value_est = $740,400, both tagged with assumption v1; with assumptions unset → both null and the UI shows the set-assumptions empty state.
- **AC-2** Cost-per-decision trend over 6 months shows decline correlated with distilled-rung share annotation; each point reproducible from pinned rollup + assumption versions.
- **AC-3** Assumption edit → history row with actor + before/after; July (closed) figures unchanged; August uses v2.
- **AC-4** Export → `value-report.v1` JSON + CSV with assumptions disclosed, checksummed, listed in exports, audited.
- **AC-5** User with `usage.report.read` but not manage → sees dashboard, cannot edit assumptions (403).
