# BRD 40 — `background-screening` capability pack

**Deliverable type:** Capability Pack (BRD 23) · **Publisher:** Datacern · **Initial version:** 1.0.0
**Horizon:** 3 pack wave 2 (post-BRD-32/33). Reference pattern: BRD 32 (card-disputes).
**Status:** v1.0.0 authored, install pending; pack-service-tier components declared `deferred` in the manifest.

---

## 1. Overview

**Purpose.** Employment background-screening adjudication and adverse-action AI under the FCRA: screening-hit triage with accuracy (607(b)) and obsolescence (605(a) 7-year rule) awareness, identity resolution for common-name/mixed-file hits, the pre-adverse/adverse-action two-step with clock tracking, and EEOC individualized-assessment routing (Green factors). Sells to consumer reporting agencies (CRAs), large employers' talent-compliance teams, and gig platforms running continuous monitoring.

**Why this vertical.** Screening hits carry hard consumer-protection duties (maximum possible accuracy, 7-year obsolescence, the two-step adverse-action sequence with a customary ~5-business-day response window, 30-day dispute reinvestigations) and mixed-file/common-name errors are a leading FCRA class-action and CFPB enforcement source; gig continuous monitoring multiplies volumes. Every hit is documented, disputable, and evidence-driven — the exact governed human-in-the-loop decision shape of the Datacern Core, and the alert-adjudication pattern is already proven by BRD 30/32.

**Business value.** Accuracy-save lift (obsolete and mismatched records suppressed before they reach a report), adverse-action clock breach elimination, adjudicator throughput (triage pre-routing), consistent EEOC-defensible individualized assessments, and exam-ready decision files (every adverse finding carries its verification evidence + provenance).

**In scope.** Hit-adjudication triage copilot, identity resolution (common-name matching standard), pre-adverse/adverse-action clock tracking, individualized-assessment routing, screening-ops KPI semantic model + dashboards, applicant-employer network analytics, FCRA/EEOC/ban-the-box grounding, order-anomaly + hit-outcome pipelines.

**Out of scope.** Primary-source record retrieval (court runners, DMV integrations — connector tier); drug testing and occupational health; I-9/E-Verify; credit-score-based tenant screening (separate pack); form generation for jurisdiction-specific notices.

## 2. Actors & user stories

**Personas:** Screening Adjudicator (SA), Identity Resolution Specialist (IRS), Adverse Action Coordinator (AAC), Screening Operations Manager (SOM), FCRA Compliance Auditor (FCA), Tenant Admin (TA).

- **US-1** As an SA, my queue ranks open hits by deadline runway × severity × identity risk (never FIFO); each case shows the record evidence, the applicant's screening history, and the copilot's proposed disposition with cited row ids.
- **US-2** As an SA, the copilot applies the 605(a) obsolescence screen automatically — a dismissed 8-year-old arrest is flagged suppress-candidate before I read the record, with the jurisdiction caveat for old convictions.
- **US-3** As an IRS, common-name hits with middle-name or DOB mismatches land in my escalation queue with the identity evidence assembled (name parts, DOB, address-history overlap) and the corroboration still needed listed.
- **US-4** As an AAC, I see every pre-adverse response window and dispute-reinvestigation clock; a window closing in ≤3 days is top of queue, and a dispute-in-flight blocks the final notice.
- **US-5** As a SOM, adverse findings and final determinations come to me four-eyes: the adjudicator proposes, I approve; every adverse finding's note must contain the source-verification evidence the pre-adverse packet rests on.
- **US-6** As a SOM, I see clear rate, adverse-finding rate, suppression rate, identity-escalation share, backlog aging, deadline runway, and turnaround — sliceable by check type, hit type, record age, position, industry, and month.
- **US-7** As an FCA, I export an exam bundle showing every AI-assisted disposition with reviewer identity, findings, and timestamps, plus pattern-level adverse-rate trends (disparate-impact watch).
- **US-8** As a TA, the pack lands as tenant-scoped content only — datasets, model, dashboards, roles, agents — with zero Core changes.

## 3. Functional requirements

### 3.1 Pack manifest (BS-FR-001)

Standard v1. Categories: `screening, employment, hr_compliance, gig_platforms, adjudication`. Regulatory: `fcra, eeoc_title_vii, ban_the_box, state_screening_laws, cfpb`. Clouds: all.

### 3.2 Ontology (BS-FR-010) — deferred to pack-service

`Applicant`, `ScreeningOrder`, `Package`, `ScreeningCheck`, `Hit`, `SourceRecord`, `Court`, `Employer`, `Position`, `AdverseActionNotice`, `ResponseWindow`, `Dispute`, `Reinvestigation`. Carried today by the `screening_core` semantic model + dataset schemas.

### 3.3 Semantic model — screening-ops KPI catalog (BS-FR-020) — authored as `screening_core`

| Measure | Definition |
|---|---|
| `clear_rate` | cleared closures / all closures |
| `adverse_finding_rate` | verified reportable findings / all closures |
| `suppression_rate` | obsolete/mismatched suppressions / all closures (accuracy saves) |
| `identity_escalation_share` | identity-verification escalations / all closures |
| `criminal_hit_share` | criminal-search hits / all hits |
| `avg_review_age_days` | adjudication backlog aging / cycle time |
| `avg_turnaround_days`, `delayed_order_count` | order SLA posture |
| deadline runway | open hits by `deadline_bucket` (0-3 / 4-10 / over-10 days) |

Entities: reviews / orders / applicants (chain: reviews→orders→applicants, many_to_one). Grammar: categorical dims, cast-to-double measures, equality measure filters, expr_metric with nullif.

### 3.4 Agents (BS-FR-030..060) — proposal-mode

1. **Hit Adjudication Copilot (BS-FR-030)** — authored as case-triage TenantAgentConfig: evidence-grounded disposition proposal (clear_report_eligible / report_adverse_finding / suppress_not_reportable / request_identity_verification / individualized_assessment_review), accuracy-and-clock-first reasoning, never sends notices or promises outcomes. Bespoke LangGraph recipe deferred.
2. **Identity Resolution Assistant (BS-FR-040)** — deferred recipe: name-part/DOB/address corroboration assembly + mixed-file risk score; interim: low-identity-confidence measures + accuracy verified query.
3. **Adverse Action Clock Sentinel (BS-FR-050)** — deferred recipe; interim: deadline_bucket dashboards + priority saved query.
4. **Individualized Assessment Builder (BS-FR-060)** — deferred recipe: Green-factor file assembly; interim: disposition route + grounding memories.
5. **Analytics agent** — authored: screening_core-grounded KPI Q&A.

Autonomous notice-sending or report release is forbidden — proposal-mode with human approval always (`BS_AUTONOMOUS_ADVERSE_ACTION_FORBIDDEN` at pack-service tier).

### 3.5 Connectors (BS-FR-080) — deferred to pack-service

**Read:** court-record aggregators + county/state repositories, DMV/MVR rails, education clearinghouses and registrar services, employment-verification bureaus, sanctions/registry lists, ATS/HRIS order intake. **Write adapters (proposal-mode):** pre-adverse packet (report copy + Summary of Rights), final adverse-action notice, report publish to ATS, consumer-file update after 611 reinvestigation, furnisher dispute. Pack ships seed datasets in the landing shape; production connectors configure via Data > Connections.

### 3.6 Regulatory guardrails (BS-FR-090)

- **FCRA 605(a)/(b)** — 7-year bar on non-conviction arrests and most adverse items, 10 years on bankruptcies; convictions federally unlimited but state limits vary; high-salary exemption.
- **FCRA 604(b)(3)/615(a)** — pre-adverse packet + customary ~5-business-day response window, then the adverse-action notice with CRA contact + dispute rights.
- **FCRA 607(b)/611/613** — maximum possible accuracy; 30-day dispute reinvestigation; strict-procedures vs contemporaneous-notice rails for public-record info.
- **EEOC / ban-the-box** — Green-factor targeted screens + individualized assessment; jurisdiction-specific inquiry timing and notice rules.

### 3.7 Roles & case schemas (BS-FR-100) — roles authored, schemas deferred

Roles: `Screening Adjudicator`, `Identity Resolution Specialist`, `Adverse Action Coordinator`, `Screening Operations Manager` (sole disposition approver), `FCRA Compliance Auditor` (read+audit only). Case schemas (deferred): `hit_adjudication`, `identity_resolution`, `adverse_action_tracking`, `applicant_dispute`, `individualized_assessment`.

## 4. Domain model & data

Authored materialization: 3 datasets (reviews 26 / orders 30 / applicants 12 — seed rows encode a common-name felony middle-name mismatch, an obsolete non-conviction arrest, a pending charge on an active gig driver via continuous monitoring, a 12-year-old conviction routed to individualized assessment, a pre-adverse window at 2 days, and a registrar-error education discrepancy) · 1 semantic model · 5 verified queries · 2 saved queries (incl. applicant→employer network edges) · 3 dashboards (Screening Adjudication Center, Adverse Action & Clocks, Accuracy & Identity Watch — 15 charts) · 5 dispositions · 6-case seeded queue · 5 roles · 2 agent configs · 9 grounding memories · 2 pipelines (isolation_forest order anomaly, xgboost hit-outcome scorer). Deferred: guardrails, agent recipes, connectors, write adapters, eval sets, ontology, case schemas, model archetypes, display labels.

## 5. Business rules (BS-BR-*)

- **BR-1** No autonomous adverse action — no notice sent, report released, or consumer file changed by an agent; proposal-mode with human decision, SOM four-eyes on adverse findings and final determinations.
- **BR-2** Accuracy outranks speed: a hit below the 607(b) identity-match standard or past 605(a) obsolescence is suppressed or escalated, never reported.
- **BR-3** Common-name flag raises the matching standard (full middle name + full DOB corroboration minimum) — it never lowers it.
- **BR-4** The pre-adverse response window runs in full; a dispute in flight pauses the final notice pending 611 reinvestigation (30 days).
- **BR-5** Pending charges are not convictions: job-relatedness analysis against the specific role, never a reflex adverse finding.
- **BR-6** Old convictions route through the adjudication matrix + jurisdiction rules; decade-old convictions get an EEOC individualized assessment (Green factors + rehabilitation evidence).
- **BR-7** Every adverse finding's note carries the source-verification evidence the pre-adverse packet rests on (documents-relied-upon standard).
- **BR-8** Every AI-assisted disposition preserves provenance (data/model/prompt/reviewer/timestamp); pattern-level adverse-rate disparities are monitored (disparate-impact defense).

## 6. Dependencies

Datacern Core (BRDs 01–23), unmodified. External (deferred connectors): court-record aggregators, DMV rails, verification bureaus, customer ATS/HRIS credentials.

## 7. NFRs (deltas)

| Metric | Target |
|---|---|
| Triage proposal p95 latency | ≤ 10s |
| Adverse-action window breach rate (post-install) | 0 |
| Mixed-file reports released (post-install) | 0 |
| Suppression precision on obsolete/mismatched hits | ≥ 95% human agreement |
| Dashboard chart warm render | 100% real data at install |
| Idempotent re-install | all no-ops |

## 8. Acceptance criteria

- **AC-1** `packctl validate` passes; install exits 0 with 0 failed actions.
- **AC-2** All 15 dashboard charts resolve real rows at install.
- **AC-3** 6-case queue seeded from open reviews; severities/deadlines match the dataset.
- **AC-4** 5 roles bound to permission groups with differentiated live capabilities.
- **AC-5** Re-install is fully idempotent.
- **AC-6** Disposition taxonomy uses only the Core's closed category set (one code per category).
- **AC-7** Pack installs on unmodified Core — zero service/helm/roles_actions.yaml diffs.
- **AC-8** Pack-service-tier capabilities appear verbatim in the `deferred` ledger, never faked.

## 9. Out of scope / future

Primary-source retrieval automation (court runners, registrar APIs) until connectors ship; jurisdiction-specific notice-form generation; drug/occupational-health screening; I-9/E-Verify; tenant screening (separate pack); international (non-US) screening regimes — natural v2 extension alongside state-law rule packs.
