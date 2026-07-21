# BRD 38 — `mortgage-loss-mitigation` capability pack

**Deliverable type:** Capability Pack (BRD 23) · **Publisher:** Datacern · **Initial version:** 1.0.0
**Horizon:** 3 pack wave (post-BRD-32). Reference pattern: BRD 24/30/32.
**Status:** v1.0.0 authored, install pending (Core-neutral via packctl); pack-service-tier components declared `deferred` in the manifest.

---

## 1. Overview

**Purpose.** Loss-mitigation decisioning AI for US mortgage servicing: RESPA Reg X (12 CFR 1024.39–.41) application evaluation with regulatory-clock awareness (30-day complete-application evaluation, 5-business-day acknowledgment), dual-tracking hold enforcement, investor-waterfall-ordered workout evaluation (GSE/FHA/VA/portfolio), denial-appeal handling with independent review, and doc-chase governance. Sells to mortgage servicers and subservicers, banks, and credit unions.

**Why this vertical.** Reg X loss mitigation carries hard regulatory clocks (5-business-day acknowledgment, 30-day complete-application evaluation, 14-day appeal window with 30-day appeal decisions) plus the dual-tracking prohibitions whose breach means CFPB enforcement and wrongful-foreclosure litigation; delinquency cycles push volume in waves servicers can't staff for. Every determination is documented, appealable, and evidence-driven — the exact governed human-in-the-loop decision shape of the Datacern Core, and the clock-driven adjudication pattern is already proven by BRD 32 (card-disputes).

**Business value.** Deadline-breach elimination (Reg X clock watch), zero dual-tracking violations (hold detection before referral), specialist throughput (triage pre-routing + doc-chase automation), denial quality (specific-reasons discipline defeats appeal churn and exam findings), redefault reduction (repeat-request analytics), and exam-ready decision files (every denial carries its findings + provenance).

**In scope.** Application intake triage copilot, Reg X clock / dual-track tracking, investor-waterfall evaluation workflow, document-chase management, denial-appeal handling, loss-mit KPI semantic model + dashboards, investor-workout network analytics, Reg X + waterfall grounding, loan-anomaly + workout-outcome pipelines.

**Out of scope.** Foreclosure-process execution (attorney/trustee management); escrow analysis and servicing-transfer operations; origination underwriting; bankruptcy workflow; MSR valuation; investor remittance accounting.

## 2. Actors & user stories

**Personas:** Loss Mitigation Specialist (LMS), Underwriting Reviewer (UR), SPOC Coordinator (SC), Loss Mitigation Manager (LMM), Servicing Compliance Auditor (SCA), Tenant Admin (TA).

- **US-1** As an LMS, my queue ranks open applications by deadline runway × arrearage × severity (never FIFO); each case shows the loan and borrower evidence, the application history, and the copilot's proposed disposition with cited evidence.
- **US-2** As an LMS on a complete application, I see the Reg X 30-day evaluation clock (12 CFR 1024.41(c)) and the copilot evaluates for ALL investor-available options in waterfall order — not just the option the borrower asked for.
- **US-3** As an SC, incomplete applications surface with the exact missing documents, the 5-business-day acknowledgment status, and the logged follow-up attempts; stale borrower contact flags my SPOC (1024.40) outreach duty.
- **US-4** As a UR, dual-tracking exposures land in my review queue the moment a timely complete application coexists with a foreclosure referral — the hold is proposed before any first filing (1024.41(f)) or sale motion (1024.41(g)).
- **US-5** As an LMM, denials and final Reg X determinations come to me four-eyes: the specialist proposes, I approve; every denial's note must contain the specific reasons (and investor requirement, if that is the basis) the borrower is entitled to.
- **US-6** As a UR, denial appeals route to me only when I was not involved in the original decision, with the new evidence (updated income docs) diffed against the original denial reasons.
- **US-7** As an LMM, I see workout approval rate, denial rate, doc-completion rate, deadline runway, dual-track holds, workout mix, repeat-request share, and arrearage exposure — sliceable by request type, hardship, investor, delinquency bucket, and month.
- **US-8** As an SCA, I export an exam bundle showing every AI-assisted disposition with reviewer identity, findings, and timestamps (Reg X 1024.38 records + servicing-file readiness); as a TA, the pack lands as tenant-scoped content only — zero Core changes.

## 3. Functional requirements

### 3.1 Pack manifest (LM-FR-001)

Standard v1. Categories: `mortgage, servicing, loss_mitigation, default_servicing, banking`. Regulatory: `respa_reg_x, ecoa_reg_b, cfpb, gse_servicing_guides, fha_servicing`. Clouds: all.

### 3.2 Ontology (LM-FR-010) — deferred to pack-service

`Borrower`, `Loan`, `LossMitApplication`, `HardshipClaim`, `WorkoutOffer`, `TrialPlan`, `ForbearancePlan`, `ForeclosureAction`, `DeadlineClock`, `DenialNotice`, `Appeal`, `Investor`, `SPOCAssignment`. Carried today by the `lossmit_core` semantic model + dataset schemas.

### 3.3 Semantic model — loss-mit KPI catalog (LM-FR-020) — authored as `lossmit_core`

| Measure | Definition |
|---|---|
| `workout_approval_rate` | approved workout offers / all closures |
| `denial_rate` | specific-reason denials / all closures |
| `doc_completion_rate` | complete applications / all applications |
| `repeat_request_share` | prior-workout-history applications / all applications |
| `deep_delinquency_share` | 120+-day-delinquent applications / all applications |
| `avg_application_age_days` | backlog aging / cycle time |
| `dual_track_hold_count` | foreclosure-process holds in effect (Reg X dual-tracking) |
| deadline runway | open applications by `deadline_bucket` (0-7 / 8-20 / over-20 days) |
| `total_arrearage_amount` / `total_upb_amount` | arrearage and distressed-book dollar exposure |

Entities: applications / loans / borrowers (chain: applications→loans→borrowers, many_to_one). Grammar: categorical dims, cast-to-double measures, equality measure filters, expr_metric with nullif.

### 3.4 Agents (LM-FR-030..060) — proposal-mode

1. **Loss Mit Intake Copilot (LM-FR-030)** — authored as case-triage TenantAgentConfig: evidence-grounded disposition proposal (approve_workout_offer / deny_with_specific_reasons / request_missing_documents / refer_foreclosure_alternatives / close_reinstated), clock-first + dual-track-first reasoning, waterfall-order evaluation, never advances foreclosure or promises outcomes. Bespoke LangGraph recipe deferred.
2. **Investor Waterfall Evaluator (LM-FR-040)** — deferred recipe: option sequencing per investor guide + NPV-input assembly + anti-steering check.
3. **Reg X Clock Sentinel (LM-FR-050)** — deferred recipe; interim: deadline_bucket dashboards + deadline verified query.
4. **Document Chase Coordinator (LM-FR-060)** — deferred recipe; interim: doc_status surfaces + acknowledgment/follow-up expectations in grounding memories.
5. **Analytics agent** — authored: lossmit_core-grounded KPI Q&A.

Autonomous foreclosure action, letter issuance, or investor filing is forbidden — proposal-mode with human approval always (`LM_AUTONOMOUS_FORECLOSURE_FORBIDDEN` at pack-service tier).

### 3.5 Connectors (LM-FR-080) — deferred to pack-service

**Read:** servicing systems of record (Black Knight MSP, Sagent LoanServ, FICS), default-management platforms, document intake/OCR for hardship packages, GSE servicing portals + HUD/FHA reporting rails, income/credit verification vendors. **Write adapters (proposal-mode):** acknowledgment/decision/denial letters, forbearance + trial-plan booking, foreclosure-hold place/release, investor workout-case submission. Pack ships seed datasets in the landing shape; production connectors configure via Data > Connections.

### 3.6 Regulatory guardrails (LM-FR-090)

- **Reg X 1024.41** — 30-day complete-application evaluation (>37 days pre-sale), 5-business-day acknowledgment with missing-items list, dual-tracking bars (120-day pre-filing rule; no first filing while a timely complete application pends; no judgment/sale motion when received >37 days pre-sale), appeal rights (≥90 days pre-sale; 14-day window; 30-day independent-personnel decision), denial notices with specific reasons + investor requirement identified.
- **Reg X 1024.39/.40** — early-intervention live contact by day 36 / written notice by day 45; SPOC assignment by day 45.
- **ECOA / Reg B** — modification denials are adverse action; fair-servicing consistency across similarly situated borrowers; anti-steering.
- **UDAAP/CFPB** — pattern-of-denial monitoring; records per 1024.38; servicing-file production readiness.

### 3.7 Roles & case schemas (LM-FR-100) — roles authored, schemas deferred

Roles: `Loss Mitigation Specialist`, `Underwriting Reviewer`, `SPOC Coordinator`, `Loss Mitigation Manager` (sole disposition approver), `Servicing Compliance Auditor` (read+audit only). Case schemas (deferred): `lossmit_intake`, `document_chase`, `dual_track_review`, `denial_appeal`, `forbearance_exit_review`.

## 4. Domain model & data

Authored materialization: 3 datasets (applications 26 / loans 30 / borrowers 12 — seed rows encode a day-27 Reg X evaluation clock, a dual-tracking hold on a pending complete application, a disaster-forbearance exit needing a deferral evaluation, an incomplete application with 3 documents missing and follow-ups logged, a denial appeal with new income evidence, and a repeat modification after a broken trial plan) · 1 semantic model · 5 verified queries · 2 saved queries (incl. investor→workout network edges) · 3 dashboards (Loss Mitigation Command Center, Reg X Clock & Dual-Track Watch, Workout Outcomes — 15 charts) · 5 dispositions · 6-case seeded queue · 5 roles · 2 agent configs · 10 grounding memories · 2 pipelines (isolation_forest loan anomaly, xgboost workout-outcome scorer). Deferred: guardrails, agent recipes, connectors, write adapters, eval sets, ontology, case schemas, model archetypes, display labels.

## 5. Business rules (LM-BR-*)

- **BR-1** No autonomous foreclosure action, decision/denial letter, or investor filing — proposal-mode with human decision, LMM four-eyes on denials and final determinations.
- **BR-2** Dual-tracking bars outrank everything: a timely complete application freezes first filings and sale motions until properly resolved; holds are placed and logged immediately.
- **BR-3** The 30-day evaluation covers ALL investor-available options in waterfall order — no steering to the servicer-convenient option.
- **BR-4** Denial notes must contain borrower-tellable specific reasons, identifying any investor requirement relied upon; Reg B adverse-action duties run alongside.
- **BR-5** Appeals are decided by personnel independent of the original decision, within 30 days, weighing new evidence.
- **BR-6** Incomplete applications get the 5-business-day acknowledgment with the exact missing-items list and a documented reasonable-diligence follow-up chase.
- **BR-7** Suspected strategic default never suspends Reg X rights; each application (including repeats after broken trial plans) is evaluated on its own evidence, with investor re-eligibility rules checked first.
- **BR-8** Every AI-assisted disposition preserves provenance (data/model/prompt/reviewer/timestamp) — CFPB exam + UDAAP/ECOA pattern defense.

## 6. Dependencies

Datacern Core (BRDs 01–23), unmodified. External (deferred connectors): servicing system of record, GSE/FHA/VA portal credentials, document-intake and income-verification vendors.

## 7. NFRs (deltas)

| Metric | Target |
|---|---|
| Triage proposal p95 latency | ≤ 10s |
| Reg X deadline-breach rate (post-install) | 0 |
| Dual-tracking violations (post-install) | 0 |
| Doc-completion rate lift (6mo) | ≥ +15pp |
| Dashboard chart warm render | 100% real data at install |
| Idempotent re-install | all no-ops |

## 8. Acceptance criteria

- **AC-1** `packctl validate` passes; install exits 0 with 0 failed actions.
- **AC-2** All 15 dashboard charts resolve real rows at install.
- **AC-3** 6-case queue seeded from open applications; severities/deadlines match the dataset.
- **AC-4** 5 roles bound to permission groups with differentiated live capabilities.
- **AC-5** Re-install is fully idempotent.
- **AC-6** Disposition taxonomy uses only the Core's closed category set.
- **AC-7** Pack installs on unmodified Core — zero service/helm/roles_actions.yaml diffs.
- **AC-8** Pack-service-tier capabilities appear verbatim in the `deferred` ledger, never faked.

## 9. Out of scope / future

Foreclosure-process execution and attorney management; bankruptcy loss mitigation; escrow analysis; servicing transfers (natural v2 extension: transfer-time loss-mit continuity checks under 1024.41(k)); HELOC and reverse-mortgage (HECM) loss mitigation; investor write adapters until pack-service ships.
