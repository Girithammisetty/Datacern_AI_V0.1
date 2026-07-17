# BRD 43 — `underwriting-intake` capability pack

**Deliverable type:** Capability Pack (BRD 23) · **Publisher:** Windrose · **Initial version:** 1.0.0
**Horizon:** 3 pack wave (post-BRD-32/33). Reference pattern: BRD 24/30/32.
**Status:** v1.0.0 authored, install pending (Core-neutral via packctl); pack-service-tier components declared `deferred` in the manifest.

---

## 1. Overview

**Purpose.** Commercial insurance underwriting submission intake and triage AI: clearance-first duplicate blocking (first-in broker holds the market), appetite-fit and completeness triage, broker needed-by deadline awareness with renewal-defense prioritization, E&S specialty referral on documented admitted-market declination, and declination hygiene with risk-based reasons. Sells to commercial P&C carriers, MGAs/MGUs, wholesale brokers, and E&S markets.

**Why this vertical.** Commercial-lines intake desks drown in broker submissions where speed to first touch is a leading driver of quote-to-bind hit ratio, yet every decision is governed: clearance disputes are broker-relations landmines, declinations must carry documented risk-based reasons (some states require them for certain lines), E&S referral rests on a documented admitted-market declination, and AI-assisted underwriting now sits squarely under the NAIC AI model bulletin. Evidence-driven, deadline-clocked, human-approved triage is the exact governed decision shape of the Windrose Core, proven by BRD 24/30/32.

**Business value.** Hit-ratio lift (deadline-ranked queues, renewal-defense expedite), underwriter capacity protection (only cleared, in-appetite, workable files get routed), declination-hygiene and fair-underwriting exam readiness (every decline carries stated reasons + provenance), broker-relationship protection (clearance conflicts resolved on received-order evidence), and cyber-controls discipline (no appetite call without the attestations).

**In scope.** Submission triage copilot (clearance → appetite → completeness → priority), needed-by deadline tracking, clearance-conflict handling, habitual out-of-appetite broker management, E&S referral workflow, submission-funnel KPI semantic model + dashboards, broker-line network analytics, clearance/appetite/E&S/cyber/fair-underwriting grounding, account-anomaly + triage-outcome pipelines.

**Out of scope.** Rating, quoting, and binding (policy-admin/rating-engine products); coverage and form analysis; premium audit; renewal book rolls; medical/life underwriting; reinsurance submissions.

## 2. Actors & user stories

**Personas:** Submission Intake Analyst (SIA), Underwriting Assistant (UA), Appetite & Clearance Specialist (ACS), Underwriting Operations Manager (UOM), Underwriting Audit Lead (UAL), Tenant Admin (TA).

- **US-1** As a SIA, my queue ranks open submissions by needed-by runway × priority band × premium band (never FIFO); each case shows the account and insured evidence, broker history, and the copilot's proposed disposition with cited row ids.
- **US-2** As a SIA on a duplicate submission, clearance runs first: I see which broker was first-in on the account, and the copilot proposes decline-or-hold-pending-BOR with the received-order evidence — never an appetite call on a blocked risk.
- **US-3** As a UA, incomplete files (missing loss runs, SOV/COPE, applications or cyber-controls attestations) surface with the exact documents to chase and the broker's responsiveness history.
- **US-4** As an ACS, marginal risks get an evidence-assembled appetite call: loss history, TIV band, cat-state exposure, prior referrals on the same insured, and the E&S referral path with the admitted-market declination documented.
- **US-5** As a UOM, declinations and specialty referrals come to me four-eyes: the analyst proposes, I approve; every declination note must carry specific risk-based reasons an examiner could read.
- **US-6** As a UOM, I see accept-to-underwriter rate, declination rate, info-request share, triage aging, deadline runway, appetite/completeness mix, and broker-tier funnel — sliceable by line, segment, month, broker, and premium band.
- **US-7** As a UAL, I export an exam bundle showing every AI-assisted disposition with reviewer identity, stated reasons, and timestamps (fair-underwriting / NAIC AI-bulletin documentation expectations).
- **US-8** As a TA, the pack lands as tenant-scoped content only — datasets, model, dashboards, roles, agents — with zero Core changes.

## 3. Functional requirements

### 3.1 Pack manifest (UW-FR-001)

Standard v1. Categories: `insurance, underwriting, commercial_lines, intake, triage`. Regulatory: `state_unfair_trade_practices, surplus_lines_diligent_search, naic_ai_bulletin, fair_underwriting`. Clouds: all.

### 3.2 Ontology (UW-FR-010) — deferred to pack-service

`Insured`, `Account`, `Submission`, `Broker`, `Brokerage`, `AppetiteStatement`, `LossRun`, `StatementOfValues`, `Application`, `ClearanceRecord`, `NeededByClock`, `DeclinationLetter`. Carried today by the `underwriting_core` semantic model + dataset schemas.

### 3.3 Semantic model — submission-funnel KPI catalog (UW-FR-020) — authored as `underwriting_core`

| Measure | Definition |
|---|---|
| `accept_to_underwriter_rate` | accepted-and-routed closures / all triage closures |
| `declination_rate` | out-of-appetite declines / all triage closures |
| `info_request_share` | missing-information closures / all triage closures |
| `in_appetite_share` | in-appetite submissions / all submissions |
| `complete_submission_share` | complete files / all submissions |
| `avg_triage_age_days` | triage backlog aging / speed-to-first-touch |
| `avg_deadline_runway_days` | mean days to the broker's needed-by date |
| deadline runway | open submissions by `deadline_bucket` (0-3 / 4-10 / over-10 days) |
| mix surfaces | appetite fit, completeness, broker tier, premium band, LOB, segment |

Entities: submissions / accounts / insureds (chain: submissions→accounts→insureds, both many_to_one). Grammar: categorical dims, cast-to-double measures, equality measure filters, expr_metric with nullif.

### 3.4 Agents (UW-FR-030..060) — proposal-mode

1. **Submission Triage Copilot (UW-FR-030)** — authored as case-triage TenantAgentConfig: clearance-first, deadline-aware disposition proposal (accept_route_to_underwriter / decline_out_of_appetite / request_missing_information / refer_specialty_market / close_broker_withdrawn), risk-based-reasons discipline, never quotes/binds/communicates decisions. Bespoke LangGraph recipe deferred.
2. **Submission Clearance Checker (UW-FR-040)** — deferred recipe: received-order verification + BOR handling; interim: clearance-conflict seed case + first-in grounding memory.
3. **Appetite Fit Scorer (UW-FR-050)** — deferred recipe; interim: xgboost triage-outcome pipeline + habitual out-of-appetite verified query.
4. **Renewal-Defense Deadline Sentinel (UW-FR-060)** — deferred recipe; interim: deadline_bucket dashboards + priority saved query.
5. **Analytics agent** — authored: underwriting_core-grounded KPI Q&A.

Autonomous declination, referral, or broker communication is forbidden — proposal-mode with human approval always (`UW_AUTONOMOUS_DECLINE_FORBIDDEN` at pack-service tier).

### 3.5 Connectors (UW-FR-080) — deferred to pack-service

**Read:** agency-management/broker-portal systems (Applied Epic, Vertafore AMS360), submission email/ACORD extraction feeds, clearance systems, loss-run retrieval services, firmographic enrichment, cat-model exposure feeds. **Write adapters (proposal-mode):** clearance block/release, declination letter with reasons, broker information request, underwriting-file open in policy admin, surplus-lines broker notification. Pack ships seed datasets in the landing shape; production connectors configure via Data > Connections.

### 3.6 Regulatory & market-practice guardrails (UW-FR-090)

- **Clearance/first-in** — first complete submission holds the market; BOR letters displace the block through the documented process.
- **Declination hygiene** — documented risk-based reasons on every decline; several states require written declination reasons for certain lines.
- **Surplus lines** — E&S referral rests on a documented admitted-market declination (diligent-search requirements vary by state; NRRA home-state regulation).
- **Fair underwriting** — no unfair discrimination between risks of the same class and hazard; adverse-action-style documentation where consumer-report data is used.
- **NAIC AI bulletin** — written AI governance, human accountability, unfair-discrimination testing, decision-reconstruction documentation for AI-assisted underwriting.

### 3.7 Roles & case schemas (UW-FR-100) — roles authored, schemas deferred

Roles: `Submission Intake Analyst`, `Appetite & Clearance Specialist`, `Underwriting Assistant`, `Underwriting Operations Manager` (sole disposition approver), `Underwriting Audit Lead` (read+audit only). Case schemas (deferred): `submission_triage`, `clearance_conflict_review`, `appetite_referral`, `completeness_chase`, `renewal_defense`.

## 4. Domain model & data

Authored materialization: 3 datasets (submissions 26 / accounts 30 / insureds 12 — seed rows encode an in-appetite GL renewal missing loss runs, a marginal cyber risk without MFA attestations, a large cat-exposed FL property near capacity, a clearance conflict from a second broker, a habitual out-of-appetite broker's fleet, and a renewal defense 2 days from needed-by) · 1 semantic model · 5 verified queries · 2 saved queries (incl. broker→line network edges) · 3 dashboards (Submission Intake Center, Appetite & Clearance, Broker & Funnel Performance — 15 charts) · 5 dispositions · 6-case seeded queue · 5 roles · 2 agent configs · 10 grounding memories · 2 pipelines (isolation_forest account anomaly, xgboost triage-outcome scorer). Deferred: guardrails, agent recipes, connectors, write adapters, eval sets, ontology, case schemas, model archetypes, display labels.

## 5. Business rules (UW-BR-*)

- **BR-1** No autonomous declination, specialty referral, or broker communication — proposal-mode with human decision, UOM four-eyes on declines and referrals.
- **BR-2** Clearance before appetite: a duplicate on a cleared account is resolved on received-order evidence (or BOR), never worked in parallel.
- **BR-3** Declination notes must carry specific, risk-based, examiner-readable reasons; protected characteristics are never factors.
- **BR-4** E&S referral requires the documented admitted-market declination first.
- **BR-5** Missing-information requests name the exact documents (currently-valued loss runs, SOV/COPE, ACORD apps, cyber-controls attestations).
- **BR-6** No appetite call on a cyber risk without MFA/EDR/backup attestations — chase the supplemental first.
- **BR-7** Renewal-defense submissions inside a 0-3-day runway outrank the queue; speed-to-first-touch is a funnel KPI, not a nicety.
- **BR-8** Every AI-assisted disposition preserves provenance (data/model/prompt/reviewer/timestamp) — NAIC AI-bulletin and market-conduct exam defense.

## 6. Dependencies

Windrose Core (BRDs 01–23), unmodified. External (deferred connectors): agency-management/broker-portal credentials, clearance system of record, loss-run retrieval services, cat-model exposure feeds.

## 7. NFRs (deltas)

| Metric | Target |
|---|---|
| Triage proposal p95 latency | ≤ 10s |
| Needed-by breach rate on urgent band (post-install) | 0 |
| Speed-to-first-touch (median, post-install) | ≤ 1 business day |
| Dashboard chart warm render | 100% real data at install |
| Idempotent re-install | all no-ops |

## 8. Acceptance criteria

- **AC-1** `packctl validate` passes; install exits 0 with 0 failed actions.
- **AC-2** All 15 dashboard charts resolve real rows at install.
- **AC-3** 6-case queue seeded from open submissions; severities/deadlines match the dataset.
- **AC-4** 5 roles bound to permission groups with differentiated live capabilities.
- **AC-5** Re-install is fully idempotent.
- **AC-6** Disposition taxonomy uses only the Core's closed category set.
- **AC-7** Pack installs on unmodified Core — zero service/helm/roles_actions.yaml diffs.
- **AC-8** Pack-service-tier capabilities appear verbatim in the `deferred` ledger, never faked.

## 9. Out of scope / future

Rating/quoting/binding integration; coverage and form analysis; automated ACORD/email extraction (connector tier); premium audit; renewal book-roll analytics; reinsurance submission intake; personal-lines intake (different clearance and adverse-action mechanics — natural sibling pack).
