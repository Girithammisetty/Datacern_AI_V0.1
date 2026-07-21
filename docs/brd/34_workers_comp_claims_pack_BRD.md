# BRD 34 — `workers-comp-claims` capability pack

**Deliverable type:** Capability Pack (BRD 23) · **Publisher:** Datacern · **Initial version:** 1.0.0
**Horizon:** 3 pack #3 (post-BRD-24-31 wave). Reference pattern: BRD 24/30/32.
**Status:** v1.0.0 authored, install pending (Core-neutral via packctl); pack-service-tier components declared `deferred` in the manifest.

---

## 1. Overview

**Purpose.** Workers' compensation claims adjudication AI for the payer side: FNOL triage with statutory compensability-clock awareness (state accept/deny decision windows), AOE/COE compensability grounding, SIU fraud red-flag escalation, medical bill review against state fee schedules, reserve adequacy and return-to-work tracking. Sells to WC carriers, third-party administrators (TPAs), and self-insured employers.

**Why this vertical.** Workers' comp is state-law-driven with hard statutory decision deadlines (accept/deny windows commonly 14-30 days, penalties and waived defenses on lapse), heavy medical-cost leakage (fee-schedule variance, provider clusters), and a well-defined fraud typology (Monday-morning claims, post-layoff filings) — while every determination is a documented, disputable, evidence-driven human decision. That is exactly the governed human-in-the-loop decision shape of the Datacern Core, and the adjudication pattern is already proven by BRD 24 (insurance-claims-payer) and BRD 32 (card-disputes).

**Business value.** Deadline-breach elimination (compensability clock watch), adjuster throughput (FNOL triage pre-routing), medical-spend control (fee-schedule variance + provider-cluster bill review), fraud loss reduction (SIU red-flag escalation with benefits-continue discipline), reserve adequacy (documented rationale, fast-riser flags), and audit-ready decision files (every denial carries its AOE/COE findings + provenance).

**In scope.** Claim intake triage copilot, compensability-clock/deadline tracking, SIU red-flag watch, medical bill review vs fee schedule (provider-cluster analytics), reserve + RTW tracking, claim-ops KPI semantic model + dashboards, provider-claim network analytics, state-law/MSA/NAIC-governance grounding, bill-anomaly + compensability-outcome pipelines.

**Out of scope.** Underwriting/pricing and experience-mod calculation; premium audit; state EDI (FROI/SROI) filing execution; medical case-management clinical decisions; structured-settlement/annuity administration; employer-side (insured) portals.

## 2. Actors & user stories

**Personas:** WC Claims Adjuster (CA), WC Nurse Case Manager (NCM), WC Medical Bill Reviewer (MBR), WC Claims Manager (CM), WC Compliance Auditor (AUD), Tenant Admin (TA).

- **US-1** As a CA, my queue ranks open claims by decision-deadline runway × reserve × severity (never FIFO); each case shows the injury evidence, bill history, employer context, and the copilot's proposed disposition with cited evidence.
- **US-2** As a CA on a claim near its statutory window, I see the compensability clock and can never let an open investigation item justify a silent lapse — the copilot reminds me to decide on the file or issue the jurisdiction's delay notice.
- **US-3** As a CA, red-flag clusters (Monday-morning unwitnessed injuries, claims filed right after a layoff notice) surface with the pattern evidence assembled — and the copilot insists red flags justify SIU referral, not denial, while benefits continue.
- **US-4** As an MBR, providers billing far above the state fee schedule across claims surface as clusters (bill ids, billed vs allowed variance) feeding utilization-review referrals.
- **US-5** As a CM, denials and final compensability determinations come to me four-eyes: the adjuster proposes, I approve; every denial's note must contain the findings the denial notice will cite.
- **US-6** As a CM, I see acceptance rate, denial rate, SIU referral share, litigation rate, average reserve, fee-schedule variance, and deadline runway — sliceable by injury type, jurisdiction, claim type, employer industry, and month.
- **US-7** As an AUD, I export an exam bundle showing every AI-assisted disposition with reviewer identity, findings, and timestamps (market-conduct / state-audit readiness).
- **US-8** As a TA, the pack lands as tenant-scoped content only — datasets, model, dashboards, roles, agents — with zero Core changes.

## 3. Functional requirements

### 3.1 Pack manifest (WC-FR-001)

Standard v1. Categories: `insurance, workers_comp, claims, siu, bill_review`. Regulatory: `state_wc_acts, state_fee_schedules, medicare_secondary_payer, naic_ai_governance, state_fraud_bureaus`. Clouds: all.

### 3.2 Ontology (WC-FR-010) — deferred to pack-service

`Claim`, `Claimant`, `Employer`, `Policy`, `BodyPart`, `InjuryCause`, `MedicalBill`, `Provider`, `ReserveChange`, `RTWPlan`, `SIUReferral`, `IME`, `ImpairmentRating`, `Jurisdiction`, `DeadlineClock`, `BenefitPayment`. Carried today by the `wc_claims_core` semantic model + dataset schemas.

### 3.3 Semantic model — claim-ops KPI catalog (WC-FR-020) — `wc_claims_core`

| Measure | Definition |
|---|---|
| `compensability_acceptance_rate` | accepted-compensable closures / all closures |
| `denial_rate` | not-compensable denials / all closures |
| `siu_referral_share` | SIU escalations / all claims |
| `litigation_rate` | attorney-represented claims / all claims |
| `fee_schedule_variance_rate` | above-schedule bills / all bills |
| `avg_claim_age_days` | backlog aging / cycle time |
| `total/avg_incurred_reserve`, `total_paid_to_date` | reserve + paid exposure |
| deadline runway | open claims by `deadline_bucket` (0-7 / 8-21 / over-21 days) |

Entities: medical_bills → claims → employers (chain, many_to_one both hops). Grammar: categorical dims, cast-to-double measures, equality measure filters, expr_metric with nullif.

### 3.4 Agents (WC-FR-030..060) — proposal-mode

1. **Claim Adjudication Copilot (WC-FR-030)** — SHIPPED as case-triage TenantAgentConfig: evidence-grounded disposition proposal (accept_compensable / deny_not_compensable / refer_utilization_review / escalate_siu_fraud / close_return_to_work), deadline-first reasoning, red-flags-mean-SIU-not-denial discipline, reserve-rationale + MSA awareness, never decides or pays. Bespoke LangGraph recipe deferred.
2. **Compensability Clock Sentinel (WC-FR-040)** — deferred recipe; interim: deadline_bucket dashboards + deadline verified query.
3. **Medical Bill Review Auditor (WC-FR-050)** — deferred recipe; interim: isolation_forest bill-anomaly pipeline + provider-variance verified query + provider-claim network edges.
4. **SIU Red-Flag Scorer (WC-FR-060)** — deferred recipe; interim: xgboost compensability-outcome pipeline + SIU-watch verified query.
5. **Analytics agent** — SHIPPED: wc_claims_core-grounded KPI Q&A.

Autonomous benefit decisions, payments, reserve changes, or state filings are forbidden — proposal-mode with human approval always (`WC_AUTONOMOUS_DETERMINATION_FORBIDDEN` at pack-service tier).

### 3.5 Connectors (WC-FR-080) — deferred to pack-service

**Read:** claims administration systems (Guidewire ClaimCenter, Origami Risk), state EDI rails (IAIABC FROI/SROI), bill-review platforms, pharmacy/PBM feeds, ISO ClaimSearch prior-claim matching, wage/payroll systems. **Write adapters (proposal-mode):** accept/deny/delay determinations, reserve changes, indemnity payment initiation, FROI/SROI filings, statutory claimant notices. Pack ships seed datasets in the landing shape; production connectors configure via Data > Connections.

### 3.6 Regulatory guardrails (WC-FR-090)

- **State WC acts** — AOE/COE compensability standard; statutory accept/deny windows (commonly 14-30 days, state-varying, delay-notice regimes); no-fault + exclusive remedy; denial notices state specific grounds.
- **Medical cost control** — state fee schedules (no balance-billing in schedule states), utilization review under adopted treatment guidelines, IME process.
- **Benefits** — waiting periods, medical-only vs indemnity conversion, MMI + impairment ratings (AMA Guides, state-adopted editions), RTW/modified-duty rules.
- **MSP/MSA** — Medicare Set-Aside consideration on settlements involving Medicare beneficiaries.
- **Fraud** — SIU/anti-fraud plan expectations, state fraud-bureau reporting; red flags are signals, not proof; benefits continue during referral.
- **AI governance** — NAIC model bulletin: written governance program, provenance, human determination.

### 3.7 Roles & case schemas (WC-FR-100) — roles shipped, schemas deferred

Roles: `WC Claims Adjuster`, `WC Nurse Case Manager`, `WC Medical Bill Reviewer`, `WC Claims Manager` (sole disposition approver), `WC Compliance Auditor` (read+audit only). Case schemas (deferred): `fnol_intake`, `compensability_review`, `siu_investigation`, `medical_bill_audit`, `rtw_planning`, `litigation_management`.

## 4. Domain model & data

Materialization: 3 datasets (claims 26 / medical bills 30 / employers 12 — seed rows encode a Monday-morning unwitnessed post-layoff strain, a claim 2 days from its statutory decision deadline, a catastrophic scaffold fall with fast-rising reserves, a medical-only-to-indemnity conversion, a pain-management provider billing above fee schedule across four claims, and a litigated repetitive-stress claim) · 1 semantic model · 5 verified queries · 2 saved queries (incl. provider→claim network edges) · 3 dashboards (WC Claims Command Center, Compensability Clock & Reserves, Medical Bill Review — 15 charts) · 5 dispositions · 6-case seeded queue · 5 roles · 2 agent configs · 10 grounding memories · 2 pipelines (isolation_forest bill anomaly, xgboost compensability-outcome scorer). Deferred: guardrails, agent recipes, connectors, write adapters, eval sets, ontology, case schemas, model archetypes, display labels.

## 5. Business rules (WC-BR-*)

- **BR-1** No autonomous compensability determination, benefit payment, reserve change, or state filing — proposal-mode with human decision, CM four-eyes on denials and final determinations.
- **BR-2** Statutory decision deadlines outrank investigation completeness: decide on the file or issue the jurisdiction's delay notice — never a silent lapse.
- **BR-3** Fraud red flags justify SIU referral, never denial; benefits and statutory clocks continue during the referral.
- **BR-4** Denial notes must contain the specific AOE/COE findings the denial notice will cite.
- **BR-5** Every reserve change carries a documented rationale; fast-rising reserves are flagged for management review.
- **BR-6** Systematic above-fee-schedule billing by a provider across claims triggers a bill-review audit + UR referral.
- **BR-7** Litigated claims: all claimant contact through counsel; contested causation is an IME candidate.
- **BR-8** Settlements involving Medicare beneficiaries flag MSA/MSP review; every AI-assisted disposition preserves provenance (data/model/prompt/reviewer/timestamp) per NAIC AI-governance expectations.

## 6. Dependencies

Datacern Core (BRDs 01–23), unmodified. External (deferred connectors): claims administration system of record, state EDI credentials, bill-review platform, ISO ClaimSearch.

## 7. NFRs (deltas)

| Metric | Target |
|---|---|
| Triage proposal p95 latency | ≤ 10s |
| Statutory-deadline breach rate (post-install) | 0 |
| Fee-schedule leakage reduction (6mo) | ≥ 15% on flagged provider clusters |
| Dashboard chart warm render | 100% real data at install |
| Idempotent re-install | all no-ops |

## 8. Acceptance criteria

- **AC-1** `packctl validate` passes; install exits 0 with 0 failed actions.
- **AC-2** All 15 dashboard charts resolve real rows at install.
- **AC-3** 6-case queue seeded from open claims; severities/deadlines match the dataset.
- **AC-4** 5 roles bound to permission groups with differentiated live capabilities.
- **AC-5** Re-install is fully idempotent.
- **AC-6** Disposition taxonomy uses only the Core's closed category set.
- **AC-7** Pack installs on unmodified Core — zero service/helm/roles_actions.yaml diffs.
- **AC-8** Pack-service-tier capabilities appear verbatim in the `deferred` ledger, never faked.

## 9. Out of scope / future

Underwriting/pricing and experience-mod computation; premium audit; state EDI filing execution until write adapters ship; clinical case-management decision support; structured settlements; employer/insured self-service portal; multi-state benefit-rate tables as governed reference data (natural v2 extension).
