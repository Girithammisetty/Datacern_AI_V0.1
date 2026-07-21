# BRD 46 — `benefits-appeals` capability pack

**Deliverable type:** Capability Pack (BRD 23) · **Publisher:** Datacern · **Initial version:** 1.0.0
**Horizon:** 3 pack wave (post-BRD-32 pattern). Reference pattern: BRD 24/30/32.
**Status:** v1.0.0 authored, install pending; pack-service-tier components declared `deferred` in the manifest.

---

## 1. Overview

**Purpose.** Government benefits eligibility adjudication and appeals AI for state/county agencies: due-process-grounded determination triage across unemployment insurance, SNAP, Medicaid eligibility, TANF, and state disability — processing-deadline awareness (SNAP 7-day expedited / 30-day, UI first-payment promptness), appeal-hearing packet preparation, overpayment establishment and waiver review, and identity-fraud watch balanced against false-positive harm. Sells to state workforce and human-services agencies, county eligibility offices, and government BPO contractors that operate eligibility and appeals workloads.

**Why this vertical.** Eligibility determinations are the canonical governed human-decision workload: every adverse action carries constitutional due-process requirements (Goldberg v. Kelly pre-termination hearing rights, reasoned written notice, appeal rights), hard processing standards (SNAP expedited 7-day, UI promptness measures), and federal improper-payment measurement exposure — while the pandemic proved both historic identity-fraud losses AND the harm of blunt automation (the MiDAS-style false-fraud debacles). Backlogs are chronic, appeals volumes are rising, and agencies are under explicit human-in-the-loop mandates for automated eligibility systems — the exact governed decision shape of the Datacern Core, proven by the alert/dispute-adjudication packs (BRD 30/32).

**Business value.** Deadline-breach elimination (expedited SNAP and hearing-packet clocks), examiner throughput (evidence-first triage pre-routing), overpayment recovery discipline with waiver fairness (agency-error fault analysis), false-positive reduction on identity flags (verification pathways instead of freezes), appeal-overturn reduction (notice/evidence quality), and audit-ready decision files (every adverse action carries findings + provenance).

**In scope.** Determination triage copilot, timeliness/deadline tracking, appeal-hearing packet workflow, overpayment establishment + waiver review, identity-ring watch (shared-address clusters, cross-program fans), adjudication KPI semantic model + dashboards, claimant-program network analytics, due-process + program-rule grounding, claim-anomaly + determination-outcome pipelines.

**Out of scope.** Benefit payment processing and banking rails; claimant-facing portals and application intake UX; child-support/child-welfare casework; SSA federal disability adjudication (state supplementary programs only); tax-intercept and collections execution.

## 2. Actors & user stories

**Personas:** Eligibility Examiner (EE), Appeals Hearing Preparer (AHP), Overpayment Analyst (OA), Program Integrity Manager (PIM), Program Audit Lead (PAL), Tenant Admin (TA).

- **US-1** As an EE, my queue ranks open determinations by deadline runway × severity × due-process exposure (never FIFO); each case shows the claim evidence, verification-document status, the claimant's history, and the copilot's proposed disposition with cited evidence.
- **US-2** As an EE on an expedited SNAP application, I see the 7-day clock and the copilot reminds me that outstanding non-identity verification is postponable — benefits issue on time, verification completes after.
- **US-3** As an EE on a wage-match income mismatch, the copilot distinguishes payroll-reporting lag from misreporting by citing current pay stubs and the household's prior cleared mismatch before proposing anything adverse.
- **US-4** As an AHP, a hearing 3 days out gets an assembled packet checklist — determination notice, records relied upon, examiner file — with defects flagged (a notice missing specific reasons is an independent reversal ground).
- **US-5** As an OA, overpayments arrive with a fault analysis: agency-error origin plus correct claimant reporting is flagged as an equity-and-good-conscience waiver candidate with the precedent cases cited.
- **US-6** As a PIM, denials, fraud referrals, and final determinations come to me four-eyes: the examiner proposes, I approve; every denial's note must contain claimant-tellable findings. I see approval/denial rates, verification-request share, fraud-referral share, appeal-overturn share, and deadline runway — sliceable by program, issue, county, and month.
- **US-7** As a PAL, I export an audit bundle showing every AI-assisted disposition with reviewer identity, findings, and timestamps for improper-payment (BAM/QC-style) and fair-hearing reviews.
- **US-8** As a TA, the pack lands as tenant-scoped content only — datasets, model, dashboards, roles, agents — with zero Core changes.

## 3. Functional requirements

### 3.1 Pack manifest (GB-FR-001)

Standard v1. Categories: `government, benefits, eligibility, appeals, program_integrity`. Regulatory: `due_process, ui_dol_standards, snap_rules, tanf_rules, improper_payments`. Clouds: all.

### 3.2 Ontology (GB-FR-010) — deferred to pack-service

`Claimant`, `Household`, `Claim`, `Determination`, `Issue`, `VerificationDocument`, `WageRecord`, `Appeal`, `Hearing`, `Notice`, `OverpaymentDebt`, `WaiverRequest`. Carried today by the `benefits_core` semantic model + dataset schemas.

### 3.3 Semantic model — adjudication KPI catalog (GB-FR-020) — authored as `benefits_core`

| Measure | Definition |
|---|---|
| `approval_rate` | benefit approvals / all closures |
| `denial_rate` | denials with findings / all closures |
| `verification_request_share` | verification-document deferrals / all closures |
| `fraud_referral_share` | fraud referrals / all closures |
| `appeal_overturn_share` | overturned appeal rows / appeal-type rows |
| `avg_determination_age_days` | backlog aging / cycle time |
| `total_overpayment_amount` / `overpayment_case_count` | integrity exposure |
| deadline runway | open determinations by `deadline_bucket` (0-7 / 8-20 / over-20 days) |

Entities: determinations / claims / claimants (chain, many_to_one determinations→claims→claimants). Grammar: categorical dims, cast-to-double measures, equality measure filters, expr_metric with nullif.

### 3.4 Agents (GB-FR-030..060) — proposal-mode

1. **Eligibility Determination Copilot (GB-FR-030)** — authored as case-triage TenantAgentConfig: evidence-grounded disposition proposal (approve_benefits / deny_with_findings / request_verification_documents / refer_fraud_investigation / close_withdrawn), deadline-first + due-process-first reasoning, never issues/denies/terminates benefits or communicates outcomes. Bespoke LangGraph recipe deferred.
2. **Appeal Hearing Packet Builder (GB-FR-040)** — deferred recipe: exhibit assembly + notice-defect detection; interim: hearing-prep queue cases + due-process grounding memories.
3. **Overpayment Waiver Analyzer (GB-FR-050)** — deferred recipe; interim: xgboost determination-outcome pipeline + overpayment verified query + waiver grounding.
4. **Identity Verification Router (GB-FR-060)** — deferred recipe; interim: shared-address measures, claimant-program edge query, and identity-flag queue cases with never-auto-deny instructions.
5. **Analytics agent** — authored: benefits_core-grounded KPI Q&A.

Autonomous adverse action (denial, termination, overpayment establishment, fraud penalty) or payment movement is forbidden — proposal-mode with human approval always (`GB_AUTONOMOUS_ADVERSE_ACTION_FORBIDDEN` at pack-service tier).

### 3.5 Connectors (GB-FR-080) — deferred to pack-service

**Read:** state benefits mainframes / eligibility systems, UI tax-and-wage systems, quarterly wage-record and new-hire cross-matches, SSA/DMV identity verification, vital records, document management (claimant evidence). **Write adapters (proposal-mode):** post determination to the system of record, issue/release payment holds, establish overpayment debts, send adverse-action + appeal-rights notices, docket fair hearings. Pack ships seed datasets in the landing shape; production connectors configure via Data > Connections.

### 3.6 Regulatory guardrails (GB-FR-090)

- **Due process (Goldberg v. Kelly)** — pre-termination evidentiary hearing for ongoing benefits; timely written notice with specific reasons and appeal rights; impartial decision on the record; aid-paid-pending on timely appeal.
- **UI promptness (DOL standards)** — first-payment timeliness (14/21-day concept) and nonmonetary-determination promptness; payment "when due" outranks investigation completeness.
- **SNAP processing** — 30-day standard, 7-day expedited with postponable non-identity verification.
- **Integrity with fairness** — identity flags route to verification, never auto-denial (MiDAS lesson); non-fraud overpayment waiver on equity-and-good-conscience; language/equitable access (Title VI LEP) on every notice; improper-payment measurement (BAM/SNAP QC/PERM) readiness.

### 3.7 Roles & case schemas (GB-FR-100) — roles authored, schemas deferred

Roles: `Eligibility Examiner`, `Appeals Hearing Preparer`, `Overpayment Analyst`, `Program Integrity Manager` (sole disposition approver), `Program Audit Lead` (read+audit only). Case schemas (deferred): `eligibility_determination`, `redetermination_review`, `appeal_hearing_prep`, `overpayment_review`, `identity_verification`, `fraud_referral`.

## 4. Domain model & data

Authored materialization: 3 datasets (determinations 26 / claims 30 / claimants 12 — seed rows encode a payroll-lag income mismatch on a vulnerable household, a contested quit-vs-layoff UI separation, an expedited SNAP application at day 5 of 7, a shared-address identity flag on a legitimate claimant beside a stolen-identity filing ring, a large agency-error overpayment waiver candidate with a granted-waiver precedent, and an appeal-hearing packet due in 3 days) · 1 semantic model · 5 verified queries · 2 saved queries (incl. claimant→program network edges) · 3 dashboards (Determinations Command Center, Timeliness & Due Process, Integrity & Overpayments — 15 charts) · 5 dispositions · 6-case seeded queue · 5 roles · 2 agent configs · 10 grounding memories · 2 pipelines (isolation_forest claim anomaly, xgboost determination-outcome scorer). Deferred: guardrails, agent recipes, connectors, write adapters, eval sets, ontology, case schemas, model archetypes, display labels.

## 5. Business rules (GB-BR-*)

- **BR-1** No autonomous adverse action or benefit/payment movement — proposal-mode with human decision, PIM four-eyes on denials, fraud referrals, overpayment establishment, and final determinations.
- **BR-2** Processing deadlines outrank investigation completeness: expedited SNAP issues on time with postponable verification; UI pays "when due" and adjusts later through lawful process.
- **BR-3** Every adverse action carries a compliant notice — specific reasons, policy citation, appeal rights, claimant's language; a defective notice is itself a due-process failure.
- **BR-4** An identity flag is a verification lead, never a denial ground; shared-address or cross-match hits on a claimant whose own documents verify route to the identity-verification pathway.
- **BR-5** Suspected fraud never suspends the claimant's rights on the pending claim; each determination is decided on its own evidence, and fraud findings require individualized human review.
- **BR-6** Overpayment fault analysis precedes recovery: agency-error overpayments with accurate claimant reporting are evaluated for equity-and-good-conscience waiver before any collection action.
- **BR-7** Appeal-hearing packets assemble the full record relied upon and are disclosed ahead of the hearing; burden allocation is respected (employer proves misconduct, claimant proves good-cause quit).
- **BR-8** Every AI-assisted disposition preserves provenance (data/model/prompt/reviewer/timestamp), with disparate-impact monitoring of denial and fraud-referral patterns across counties, languages, and vulnerable populations.

## 6. Dependencies

Datacern Core (BRDs 01–23), unmodified. External (deferred connectors): state benefits system of record, wage-record/new-hire cross-match feeds, identity-verification services, hearing-docket systems.

## 7. NFRs (deltas)

| Metric | Target |
|---|---|
| Triage proposal p95 latency | ≤ 10s |
| Processing-deadline breach rate (post-install) | 0 |
| Appeal-overturn share (12mo) | measurable decline on notice/evidence-defect grounds |
| False-positive identity freezes | 0 auto-denials; 100% routed to verification pathway |
| Dashboard chart warm render | 100% real data at install |
| Idempotent re-install | all no-ops |

## 8. Acceptance criteria

- **AC-1** `packctl validate` passes; install exits 0 with 0 failed actions.
- **AC-2** All 15 dashboard charts resolve real rows at install.
- **AC-3** 6-case queue seeded from open determinations; severities/deadlines match the dataset.
- **AC-4** 5 roles bound to permission groups with differentiated live capabilities.
- **AC-5** Re-install is fully idempotent.
- **AC-6** Disposition taxonomy uses only the Core's closed category set.
- **AC-7** Pack installs on unmodified Core — zero service/helm/roles_actions.yaml diffs.
- **AC-8** Pack-service-tier capabilities appear verbatim in the `deferred` ledger, never faked.

## 9. Out of scope / future

Payment execution and banking rails; claimant-facing application portals; SSA federal disability determination services; tax-intercept/collections execution; cross-state identity-fraud consortium feeds until pack-service connectors ship; child-support and child-welfare casework (candidate sibling packs).
