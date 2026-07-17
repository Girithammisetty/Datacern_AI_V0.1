# BRD 42 — `device-complaints` capability pack

**Deliverable type:** Capability Pack (BRD 23) · **Publisher:** Windrose · **Initial version:** 1.0.0
**Horizon:** 3 pack wave 2. Reference pattern: BRD 24/30/32. Sibling: BRD 33 (`pharmacovigilance`) — this is the medical-device counterpart: complaint handling + MDR reportability instead of ICSR processing.
**Status:** v1.0.0 authored, install pending; pack-service-tier components declared `deferred` in the manifest.

---

## 1. Overview

**Purpose.** Medical-device complaint handling and MDR reportability AI for the manufacturer side: complaint intake triage with regulatory-clock awareness (21 CFR 803 30-calendar-day and 5-work-day reports, becoming-aware day zero), death reportability presumption handling, malfunction could-recur assessment, 820.100 CAPA trend escalation, returned-device and duplicate workflows, and quality-management KPI surfaces. Sells to device manufacturers (class I–III), combination-product makers, and contract manufacturers.

**Why this vertical.** Device complaint handling is the pharmacovigilance workflow's structural twin (BRD 33) on a different statute: regulated intake → reportability evaluation on EVERY complaint (820.198) → human quality/regulatory determination → auditable submission, with hard clocks (30 calendar days from ANY employee's awareness; 5 work days when remedial action is needed) and direct inspection exposure (FDA QSIT walks complaint files and MDR decision rationale first). Corrections from quality reviewers are frequent and high-signal — ideal fuel for the correction→retrain loop — and trending complaints into CAPA is a statistical workflow the platform already excels at.

**Business value.** Zero late MDRs (deadline-runway surfacing from the true becoming-aware date), intake throughput (reportability pre-assessment), earlier signal detection (device-problem trending, post-rollout cluster flags), CAPA-trigger discipline (trend thresholds instead of tribal knowledge), duplicate-report hygiene, and inspection-ready decision files (every not-reportable closure carries its documented rationale + provenance).

**In scope.** Complaint intake triage copilot (validity → duplicate check → harm/event classification → MDR reportability → disposition proposal), MDR-clock tracking, CAPA trend escalation, returned-device follow-up workflow, complaint-quality KPI semantic model + dashboards, device-problem network analytics, Part 803/820 + EU MDR vigilance grounding, device-fleet anomaly + reportability-scoring pipelines.

**Out of scope.** eQMS replacement (the eQMS remains the system of record — Windrose is the governed decisioning layer); eMDR/EUDAMED submission transport (deferred write adapters); recall execution logistics; drug-side adverse events (see `pharmacovigilance`, BRD 33); clinical-trial device deficiency reporting; servicing/repair operations.

## 2. Actors & user stories

**Personas:** Complaint Intake Coordinator (CIC), Complaint Investigator (CI), MDR Reportability Analyst (MRA), Quality & Regulatory Manager (QRM), Quality Systems Auditor (QSA), Tenant Admin (TA).

- **US-1** As a CIC, my queue ranks open complaints by MDR-clock runway × harm × severity (never FIFO); each case shows the device, product, lot/software-version bands, sibling complaints on the same product, and the copilot's proposed disposition with cited evidence.
- **US-2** As a CIC, the clock starts at becoming-aware day zero (any employee), not at quality-unit intake — the runway I see already accounts for routing lag, and the copilot never lets investigation completeness justify a late report.
- **US-3** As a CI, returned-device analyses, could-recur malfunction assessments, and possible design-induced use errors land with the technical evidence assembled; my corrections are captured as structured evidence for retraining.
- **US-4** As an MRA, death complaints arrive flagged with the reportability presumption (file unless device involvement is ruled out), and malfunction complaints carry a could-recur-and-cause-harm assessment with the reporting prong cited.
- **US-5** As a QRM, MDR filings, not-reportable rationales, and CAPA escalations come to me four-eyes: the analyst proposes, I approve; every not-reportable note must carry the documented rationale 820.198 requires.
- **US-6** As a QRM, I see MDR filing rate, not-reportable rate, CAPA-open share, duplicate rate, backlog aging, deadline runway, and device-problem/harm mix — sliceable by event type, source, product, lot, software version, and month.
- **US-7** As a QSA, I export an inspection bundle showing every AI-assisted reportability decision with reviewer identity, rationale, and timestamps (complaint-file + MDR record expectations).
- **US-8** As a TA, the pack lands as tenant-scoped content only — datasets, model, dashboards, roles, agents — with zero Core changes.

## 3. Functional requirements

### 3.1 Pack manifest (DC-FR-001)

Standard v1. Categories: `medtech, medical_devices, complaints, mdr, quality, post_market_surveillance`. Regulatory: `fda_21_cfr_803, fda_21_cfr_820, eu_mdr, iso_13485`. Clouds: all.

### 3.2 Ontology (DC-FR-010) — deferred to pack-service

`Complaint`, `Device`, `Product`, `Lot`, `DeviceProblemCode`, `PatientHarm`, `Investigation`, `MDRReport`, `ReportabilityDecision`, `CAPA`, `FieldAction`, `DeadlineClock`. Carried today by the `complaints_core` semantic model + dataset schemas.

### 3.3 Semantic model — complaint-quality KPI catalog (DC-FR-020) — authored as `complaints_core`

| Measure | Definition |
|---|---|
| `mdr_filing_rate` | MDR-filed closures / all closures |
| `not_reportable_rate` | not-reportable closures / all closures |
| `capa_open_share` | CAPA-escalated closures / all closures |
| `duplicate_rate` | duplicate closures / all closures |
| `serious_harm_share` | serious-harm complaints / all complaints |
| `avg_complaint_age_days` | backlog aging / investigation cycle time |
| `avg_days_to_deadline` | MDR-clock runway (open book) |
| deadline runway | open complaints by `deadline_bucket` (0-5 / 6-15 / over-15 days) |
| device-problem & harm mix | complaint counts by `device_problem` / `patient_harm` |

Entities: complaints / devices / products (chain, complaints→devices→products many_to_one). Grammar: categorical dims, cast-to-double measures, equality measure filters, expr_metric with nullif.

### 3.4 Agents (DC-FR-030..060) — proposal-mode

1. **Complaint Intake Copilot (DC-FR-030)** — authored as case-triage TenantAgentConfig: evidence-grounded disposition proposal (file_mdr_report / close_not_reportable / open_capa_investigation / request_device_return_info / close_duplicate_complaint), clock-first reasoning from becoming-aware day zero, death presumption, could-recur malfunction test, never files or communicates outcomes. Bespoke LangGraph recipe deferred.
2. **MDR Reportability Decision-Tree Copilot (DC-FR-040)** — deferred recipe: structured decision-tree walk + reporting-prong citation + eMDR narrative draft.
3. **Complaint Trend Sentinel (DC-FR-050)** — deferred recipe; interim: xgboost reportability pipeline + device-problem trending verified query + Device Problem Signals dashboard.
4. **Returned-Device Analysis Tracker (DC-FR-060)** — deferred recipe; interim: request_device_return_info disposition + deadline dashboards.
5. **Analytics agent** — authored: complaints_core-grounded KPI Q&A.

Autonomous regulatory submission or CAPA-record creation is forbidden — proposal-mode with human approval always (`DC_AUTONOMOUS_SUBMISSION_FORBIDDEN` at pack-service tier).

### 3.5 Connectors (DC-FR-080) — deferred to pack-service

**Read:** eQMS/complaint platforms, field-service and returned-goods systems, distributor/importer portals, call-center intake, literature-screening feeds, FDA MAUDE similar-event lookups. **Write adapters (proposal-mode):** eMDR via FDA ESG, EU MDR vigilance / EUDAMED, CAPA record creation in the eQMS, complaint-acknowledgment and device-return-request letters. Pack ships seed datasets in the landing shape; production connectors configure via Data > Connections.

### 3.6 Regulatory guardrails (DC-FR-090)

- **21 CFR 803** — 30-calendar-day reports (death / serious injury / malfunction likely to cause or contribute to death or serious injury on recurrence); 5-work-day reports (remedial action against unreasonable risk of substantial harm, or FDA written request); becoming-aware day zero at ANY employee's awareness.
- **21 CFR 820.198** — every complaint evaluated for MDR reportability; documented rationale + responsible individual when not investigating; MDR-related complaints promptly investigated.
- **21 CFR 820.100** — complaint trends trigger CAPA; CAPA never substitutes for per-event reportability decisions.
- **EU MDR vigilance** — serious incidents within 15 days (shorter windows for deaths/serious deteriorations and public-health threats); FSCA + field safety notices; trend reporting.
- **Inspection posture** — reportability rationale human-owned + reconstructable; systematic under-reporting is a program-level failure even when individual files look defensible.

### 3.7 Roles & case schemas (DC-FR-100) — roles authored, schemas deferred

Roles: `Complaint Intake Coordinator`, `Complaint Investigator`, `MDR Reportability Analyst`, `Quality & Regulatory Manager` (sole disposition approver), `Quality Systems Auditor` (read+audit only). Case schemas (deferred): `complaint_intake`, `mdr_reportability_review`, `capa_trend_investigation`, `returned_device_analysis`, `duplicate_review`.

## 4. Domain model & data

Authored materialization: 3 datasets (complaints 26 / devices 30 / products 10 — seed rows encode a reported death with device involvement unconfirmed (presumption, clock running), a third alarm-failure on one monitor product (30-day malfunction candidate + trend threshold), a software-anomaly cluster after a v4.0 rollout (CAPA candidate), a possibly design-induced use error, a returned-device analysis pending, and a suspected distributor double-report of an already-filed MDR) · 1 semantic model · 5 verified queries · 2 saved queries (incl. device→problem-code network edges) · 3 dashboards (Complaint Handling Center, MDR Clock & Reportability, Device Problem Signals — 15 charts) · 5 dispositions · 6-case seeded queue · 5 roles · 2 agent configs · 10 grounding memories · 2 pipelines (isolation_forest device-fleet anomaly, xgboost reportability scorer). Deferred: guardrails, agent recipes, connectors, write adapters, eval sets, ontology, case schemas, model archetypes, display labels.

## 5. Business rules (DC-BR-*)

- **BR-1** No autonomous MDR filing, vigilance submission, or CAPA-record creation — proposal-mode with human decision, QRM four-eyes on every disposition.
- **BR-2** MDR deadlines outrank investigation completeness: file on the available information and supplement later; the clock runs from becoming-aware day zero (any employee).
- **BR-3** Deaths carry the reportability presumption — file unless the investigation rules device involvement out; "caused or contributed" includes design, labeling, and use-error pathways.
- **BR-4** Malfunctions are assessed on the could-recur prong: no harm this time does not mean not reportable.
- **BR-5** Every complaint gets a reportability evaluation; a not-reportable closure and any decision not to investigate carry a documented rationale and a responsible individual (820.198).
- **BR-6** Trend thresholds (repeat problem code on one product, post-change cluster) escalate to CAPA — and never delay the per-event reportability decision.
- **BR-7** Duplicates are closed only after linkage confirmation (event date, patient, facility); an unconfirmed "duplicate" keeps its own clock.
- **BR-8** Every AI-assisted reportability decision preserves provenance (data/model/prompt/reviewer/timestamp) — QSIT inspection + under-reporting pattern defense.

## 6. Dependencies

Windrose Core (BRDs 01–23), unmodified. External (deferred connectors): tenant eQMS/complaint system of record, FDA ESG credentials (eMDR), EUDAMED access, field-service and distributor feeds.

## 7. NFRs (deltas)

| Metric | Target |
|---|---|
| Triage proposal p95 latency | ≤ 10s |
| Late-MDR rate (post-install) | 0 |
| Trend-signal lead time vs manual review | ≥ 2 weeks earlier on seeded clusters |
| Dashboard chart warm render | 100% real data at install |
| Idempotent re-install | all no-ops |

## 8. Acceptance criteria

- **AC-1** `packctl validate` passes; install exits 0 with 0 failed actions.
- **AC-2** All 15 dashboard charts resolve real rows at install.
- **AC-3** 6-case queue seeded from open complaints; severities/deadlines match the dataset.
- **AC-4** 5 roles bound to permission groups with differentiated live capabilities.
- **AC-5** Re-install is fully idempotent.
- **AC-6** Disposition taxonomy uses only the Core's closed category set.
- **AC-7** Pack installs on unmodified Core — zero service/helm/roles_actions.yaml diffs.
- **AC-8** Pack-service-tier capabilities appear verbatim in the `deferred` ledger, never faked.

## 9. Out of scope / future

eMDR/EUDAMED submission transport until pack-service write adapters ship; recall/field-action execution; servicing and repair-depot workflows; clinical-investigation device deficiency reporting; combination-product constituent-part AE cross-filing with the `pharmacovigilance` pack (natural v2 extension); MAUDE benchmarking analytics.
