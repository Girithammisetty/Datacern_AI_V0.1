# BRD 32 — `card-disputes` capability pack

**Deliverable type:** Capability Pack (BRD 23) · **Publisher:** Windrose · **Initial version:** 1.0.0
**Horizon:** 3 pack #1 (first post-BRD-24-31 wave). Reference pattern: BRD 24/30.
**Status:** v1.0.0 SHIPPED Core-neutral via packctl (tenant `wr-disputes`); pack-service-tier components declared `deferred` in the manifest.

---

## 1. Overview

**Purpose.** Card dispute and chargeback adjudication AI for US issuers: Reg E (debit) / Reg Z (credit) error-resolution with regulatory-clock awareness, provisional-credit governance, first-party fraud escalation, and network chargeback recovery (Visa/Mastercard reason-code grounded). Sells to banks, credit unions, and fintech card program managers / issuer-processors.

**Why this vertical.** Reg E/Reg Z disputes carry hard statutory deadlines (10-business-day provisional-credit decisions, 45/90-day investigations, 2-billing-cycle Reg Z resolution) and CFPB examination exposure; volumes are enormous and rising with CNP fraud and first-party ("friendly") fraud. Every determination is documented, disputable, and evidence-driven — the exact governed human-in-the-loop decision shape of the Windrose Core, and the alert-adjudication pattern is already proven by BRD 30 (banking-aml).

**Business value.** Deadline-breach elimination (Reg E clock watch), analyst throughput (triage pre-routing), chargeback recovery lift (reason-code + compelling-evidence fit, CE 3.0 pre-screen), first-party fraud loss reduction, and exam-ready decision files (every denial carries its findings + provenance).

**In scope.** Dispute intake triage copilot, deadline/provisional-credit tracking, chargeback recovery workflow, first-party fraud watch (repeat disputers, card-testing, dispute rings), dispute-ops KPI semantic model + dashboards, cardholder-merchant network analytics, Reg E/Z + network-rule grounding, transaction-anomaly + dispute-outcome pipelines.

**Out of scope.** Real-time transaction fraud scoring (authorization-stream decisioning is an issuer-processor product); merchant-side representment (see the merchant `chargeback-representment` pack, BRD 44); card production/reissue logistics; collections.

## 2. Actors & user stories

**Personas:** Dispute Intake Analyst (DIA), Fraud Investigator (FI), Chargeback Specialist (CS), Dispute Operations Manager (DOM), Dispute Compliance Auditor (DCA), Tenant Admin (TA).

- **US-1** As a DIA, my queue ranks open disputes by deadline runway × dollar × severity (never FIFO); each case shows the transaction evidence, the cardholder's dispute history, and the copilot's proposed disposition with cited evidence.
- **US-2** As a DIA on a Reg E dispute, I see the provisional-credit clock (10 business days; 20 for new accounts) and can never let investigation quality justify blowing the deadline — the copilot reminds me credit is issued on time and reversed later with notice if no error is found.
- **US-3** As an FI, repeat disputers with prior delivery-confirmed denials, card-testing bursts (micro-auths then a large CNP charge), and dispute rings land in my escalation queue with the pattern evidence assembled.
- **US-4** As a CS, when evidence fits a network reason code I get a drafted chargeback with the code (Visa 10.4/12.6.1/13.1/13.7, MC 4837/4853/4834/4860) and the compelling evidence cited — pre-screened for Visa CE 3.0 exposure.
- **US-5** As a DOM, denials and final Reg E determinations come to me four-eyes: the analyst proposes, I approve; every denial's note must contain findings the cardholder can be told.
- **US-6** As a DOM, I see cardholder-favor rate, denial rate, chargeback win rate, recovery rate, provisional-credit exposure, and backlog aging — sliceable by dispute type, reason code, network, regime, and month.
- **US-7** As a DCA, I export an exam bundle showing every AI-assisted disposition with reviewer identity, findings, and timestamps (Reg E 2-year retention, 12 CFR 1005.13).
- **US-8** As a TA, the pack lands as tenant-scoped content only — datasets, model, dashboards, roles, agents — with zero Core changes.

## 3. Functional requirements

### 3.1 Pack manifest (CD-FR-001)

Standard v1. Categories: `banking, cards, disputes, chargebacks, fraud`. Regulatory: `reg_e, reg_z, cfpb, visa_rules, mastercard_rules`. Clouds: all.

### 3.2 Ontology (CD-FR-010) — deferred to pack-service

`Cardholder`, `Account`, `Card`, `Transaction`, `Dispute`, `Chargeback`, `Representment`, `ProvisionalCredit`, `Merchant`, `ReasonCode`, `DeadlineClock`, `ResolutionLetter`. Carried today by the `disputes_core` semantic model + dataset schemas.

### 3.3 Semantic model — dispute-ops KPI catalog (CD-FR-020) — SHIPPED as `disputes_core`

| Measure | Definition |
|---|---|
| `cardholder_favor_rate` | cardholder-favor closures / all closures |
| `dispute_denial_rate` | no-error denials / all closures |
| `chargeback_win_rate` | chargebacks won / chargebacks filed |
| `recovery_rate` | dollars recovered / dollars disputed |
| `fraud_dispute_share` | unauthorized-transaction claims / all disputes |
| `avg_dispute_age_days` | backlog aging / cycle time |
| `provisional_credit_issued/due` | Reg E credit exposure counts |
| deadline runway | open disputes by `deadline_bucket` (0-5 / 6-15 / over-15 days) |

Entities: disputes / transactions / cardholders (star, many_to_one to cardholders). Grammar: categorical dims, cast-to-double measures, equality measure filters, expr_metric with nullif.

### 3.4 Agents (CD-FR-030..060) — proposal-mode

1. **Dispute Intake Copilot (CD-FR-030)** — SHIPPED as case-triage TenantAgentConfig: evidence-grounded disposition proposal (resolve_cardholder_favor / deny_no_error_found / file_chargeback / escalate_fraud_review / close_merchant_credited), deadline-first reasoning, never posts credits or promises outcomes. Bespoke LangGraph recipe deferred.
2. **Chargeback Representment Builder (CD-FR-040)** — deferred recipe: reason-code selection + evidence assembly + CE 3.0 pre-screen.
3. **First-Party Fraud Scorer (CD-FR-050)** — deferred recipe; interim: xgboost dispute-outcome pipeline + repeat-disputer verified query.
4. **Provisional Credit Clock Sentinel (CD-FR-060)** — deferred recipe; interim: deadline_bucket dashboards + priority saved query.
5. **Analytics agent** — SHIPPED: disputes_core-grounded KPI Q&A.

Autonomous credit movement or network filing is forbidden — proposal-mode with human approval always (`CD_AUTONOMOUS_CREDIT_FORBIDDEN` at pack-service tier).

### 3.5 Connectors (CD-FR-080) — deferred to pack-service

**Read:** core processors (FIS, Fiserv, TSYS, Marqeta, Galileo), network dispute rails (Visa Resolve Online, Mastercom), fraud platforms, ATM operator journals, carrier tracking APIs (delivery-confirmation evidence). **Write adapters (proposal-mode):** provisional credit post/reverse, chargeback/representment submission, card reissue order, Reg E/Z letters. Pack ships seed datasets in the landing shape; production connectors configure via Data > Connections.

### 3.6 Regulatory guardrails (CD-FR-090)

- **Reg E (12 CFR 1005.11/.6/.13)** — 10-business-day resolution or provisional credit (20 for new accounts), 45/90-day extended windows, liability tiers ($50/$500/unlimited), reversal notice + 5-business-day honor period, 2-year records.
- **Reg Z (12 CFR 1026.13)** — 60-day billing-error notice, 30-day acknowledgment, 2-cycle/90-day resolution, no collection/adverse reporting on disputed amounts.
- **Network rules** — 120-day filing windows, reason-code families, Visa CE 3.0 liability shift.
- **UDAAP/CFPB** — pattern-of-denial monitoring; denial letters reflect actual findings; documents-relied-upon on request.

### 3.7 Roles & case schemas (CD-FR-100) — roles SHIPPED, schemas deferred

Roles: `Dispute Intake Analyst`, `Fraud Investigator`, `Chargeback Specialist`, `Dispute Operations Manager` (sole disposition approver), `Dispute Compliance Auditor` (read+audit only). Case schemas (deferred): `dispute_intake`, `fraud_investigation`, `chargeback_representment`, `atm_error_review`, `first_party_fraud_review`.

## 4. Domain model & data

SHIPPED materialization: 3 datasets (disputes 26 / transactions 30 / cardholders 12 — seed rows encode card-testing burst, serial first-party disputer, cancelled-recurring trap, ATM shortfall, duplicate capture, high-value CNP fraud on a new account) · 1 semantic model · 5 verified queries · 2 saved queries (incl. cardholder→merchant network edges) · 3 dashboards (Dispute Command Center, Regulatory Clock & Provisional Credit, Chargeback Recovery — 15 charts) · 5 dispositions · 6-case seeded queue · 5 roles · 2 agent configs · 8 grounding memories · 2 pipelines (isolation_forest txn anomaly, xgboost dispute-outcome scorer). Deferred: guardrails, agent recipes, connectors, write adapters, eval sets, ontology, case schemas, model archetypes, display labels.

## 5. Business rules (CD-BR-*)

- **BR-1** No autonomous credit posting/reversal or network filing — proposal-mode with human decision, DOM four-eyes on denials and final determinations.
- **BR-2** Reg E deadlines outrank investigation completeness: provisional credit on time, reverse later with notice if warranted.
- **BR-3** Provisional-credit reversal requires the written notice + 5-business-day honor period — a reversal without notice is itself a violation.
- **BR-4** Suspected first-party fraud never suspends Reg E rights; each claim investigated on its own evidence.
- **BR-5** Denial notes must contain cardholder-tellable findings (documents-relied-upon standard).
- **BR-6** CE 3.0 pre-screen before 10.4 filings — don't burn cycle time and network fees on defeats.
- **BR-7** Card-testing: dispute the monetizing charge and reissue; skip representment on micro-charges below fee economics.
- **BR-8** Every AI-assisted disposition preserves provenance (data/model/prompt/reviewer/timestamp) — CFPB exam + UDAAP pattern defense.

## 6. Dependencies

Windrose Core (BRDs 01–23), unmodified. External (deferred connectors): issuer processor of record, VROL/Mastercom credentials, carrier tracking APIs.

## 7. NFRs (deltas)

| Metric | Target |
|---|---|
| Triage proposal p95 latency | ≤ 10s |
| Deadline-breach rate (post-install) | 0 |
| Chargeback win-rate lift (6mo) | ≥ +10pp on CNP fraud codes |
| Dashboard chart warm render | 100% real data at install |
| Idempotent re-install | all no-ops |

## 8. Acceptance criteria

- **AC-1** `packctl validate` passes; install exits 0 with 0 failed actions. **(MET 2026-07-16)**
- **AC-2** All 15 dashboard charts resolve real rows at install. **(MET — 15/15)**
- **AC-3** 6-case queue seeded from open disputes; severities/deadlines match the dataset. **(MET, UI-verified)**
- **AC-4** 5 roles bound to permission groups with differentiated live capabilities. **(MET — 23–38 caps)**
- **AC-5** Re-install is fully idempotent. **(MET)**
- **AC-6** Disposition taxonomy uses only the Core's closed category set. **(MET)**
- **AC-7** Pack installs on unmodified Core — zero service/helm/roles_actions.yaml diffs. **(MET)**
- **AC-8** Pack-service-tier capabilities appear verbatim in the `deferred` ledger, never faked. **(MET — 9 deferred)**

## 9. Out of scope / future

Authorization-stream fraud scoring; merchant-side representment (BRD 44); collections; card logistics; Reg E for non-card EFT channels (ACH/P2P disputes — natural v2 extension); issuer-processor write adapters until pack-service ships.
