# BRD 33 — `pharmacovigilance` capability pack

**Deliverable type:** Capability Pack (BRD 23) · **Publisher:** Windrose · **Initial version:** 1.0.0
**Horizon:** 3 pack #2. Reference pattern: BRD 24/30.
**Status:** v1.0.0 SHIPPED Core-neutral via packctl (tenant `wr-pv`); pack-service-tier components declared `deferred` in the manifest.

---

## 1. Overview

**Purpose.** Adverse-event (ICSR) case-processing AI for pharma/biotech safety departments: intake validity + duplicate checking, seriousness/expectedness/causality-grounded reporting proposals, expedited (15-day/7-day) deadline tracking, signal-cluster flagging, and QPPV-governed submission decisions. Sells to sponsors, MAHs, CROs, and PV service providers.

**Why this vertical.** PV case processing is the single most Windrose-shaped workflow in industry: regulated intake → expert triage → human medical correction → auditable regulatory submission, with brutal deadlines (FDA 15-day Alert reports, 7-day fatal/life-threatening SUSARs) and inspection exposure (FDA BIMO, EMA PV inspections). Volumes grow every year; corrections from medical reviewers are frequent and high-signal — ideal fuel for the correction→retrain loop. Companies already pay heavily for safety-database seats and case-processing BPO.

**Business value.** Case cycle-time reduction (validity/duplicate/seriousness pre-assessment), zero late expedited reports (deadline runway surfacing), earlier signal detection (unlisted-term cluster flags), intake data-quality lift (duplicate-rate tracking), and inspection-ready decision provenance.

**In scope.** ICSR triage copilot (validity → duplicate → seriousness → expectedness → causality → reporting route), expedited-clock tracking, PV-ops KPI semantic model + dashboards, MedDRA-coded event signal surfaces, product-event network analytics, FDA/ICH/GVP grounding, event-anomaly + case-priority pipelines.

**Out of scope.** Full safety-database replacement (Argus/LifeSphere/Vault Safety remain the system of record — Windrose is the governed decisioning layer); aggregate report authoring (PADER/PBRER document generation); literature-monitoring search itself; medical-device vigilance (see `device-complaints` pack, BRD 42); veterinary PV.

## 2. Actors & user stories

**Personas:** PV Intake Specialist (PIS), PV Medical Reviewer (PMR), PV Safety Officer / QPPV-equivalent (PSO), PV Signal Analyst (PSA), PV Quality Auditor (PQA), Tenant Admin (TA).

- **US-1** As a PIS, my queue ranks open cases serious-first, tightest reporting deadline first (never FIFO); each case shows source, seriousness criteria, expectedness, and the copilot's proposed route with the criteria cited.
- **US-2** As a PIS, cases missing any of the four valid-case criteria route to follow-up (documented attempts), never dismissal; duplicate suspects are checked against processed cases before assessment.
- **US-3** As a PMR, I confirm or correct seriousness (ICH E2A), expectedness vs the RSI, and causality — my corrections are captured as structured evidence for retraining.
- **US-4** As a PSO, expedited-report proposals reach me four-eyes: the specialist proposes, I approve the submission decision; the note carries the seriousness/expectedness/causality assessment the narrative cites.
- **US-5** As a PSA, repeated unlisted terms in one organ class on one product (e.g., a hepatobiliary cluster) are flagged to me alongside the ICSR decisions, with the product-event network view.
- **US-6** As a PSO, I see serious-case rate, expedited conversion, deadline runway, backlog aging, duplicate rate, and unlisted-term pressure by product/therapeutic area/source/month.
- **US-7** As a PQA, I export an inspection bundle showing every AI-assisted decision with reviewer identity, criteria, and timestamps.
- **US-8** As a TA, the pack lands as tenant-scoped content only — zero Core changes.

## 3. Functional requirements

### 3.1 Pack manifest (PV-FR-001)

Standard v1. Categories: `pharma, pharmacovigilance, drug-safety, icsr`. Regulatory: `fda_21cfr314, fda_21cfr312, ich_e2a, ich_e2d, eu_gvp, meddra`. Clouds: all.

### 3.2 Ontology (PV-FR-010) — deferred to pack-service

`Case/ICSR`, `AdverseEvent`, `Product`, `ActiveSubstance`, `Reporter`, `Patient`, `RegulatoryClock`, `ExpeditedReport`, `PeriodicReport`, `Signal`, `RSIVersion`. Carried today by the `pv_core` semantic model + dataset schemas.

### 3.3 Semantic model — PV KPI catalog (PV-FR-020) — SHIPPED as `pv_core`

| Measure | Definition |
|---|---|
| `serious_case_rate` | serious cases / all cases |
| `expedited_conversion_rate` | expedited reports / closures |
| `unlisted_event_share` | unlisted events / all events (signal pressure) |
| `duplicate_rate` | nullified duplicates / closures (intake quality) |
| `avg_case_age_days` | backlog aging / cycle time |
| `avg_days_to_deadline` | open-book compliance runway |
| deadline runway | open cases by `deadline_bucket` (0-7 / 8-15 / over-15 days) |
| event surfaces | counts by SOC / PT / listedness / severity / product |

Entities: events → cases → products (acyclic snowflake chain, many_to_one). Grammar: categorical dims, cast-to-double measures, equality measure filters, expr_metric with nullif.

### 3.4 Agents (PV-FR-030..060) — proposal-mode

1. **ICSR Triage Copilot (PV-FR-030)** — SHIPPED as case-triage TenantAgentConfig: strict-order reasoning (validity → duplicate → seriousness → expectedness → causality), one proposed disposition (submit_expedited_report / include_periodic_report / non_reportable_invalid / request_followup_info / nullify_duplicate) with the applicable clock cited; conservative when arguable; never submits. Bespoke LangGraph recipe deferred.
2. **Duplicate Detector (PV-FR-040)** — deferred recipe; interim: instructions + queue notes + duplicate_rate KPI.
3. **MedDRA Coding Assistant (PV-FR-045)** — deferred recipe (licensed dictionary required).
4. **Narrative Drafter (PV-FR-050)** — deferred recipe; submission decision remains PSO-only.
5. **Signal Evaluation Copilot (PV-FR-060)** — deferred recipe; interim: unlisted-term dashboards, product-event edges, isolation_forest event-anomaly pipeline.
6. **Analytics agent** — SHIPPED: pv_core-grounded KPI Q&A, patient-detail minimization.

Autonomous regulatory submission is forbidden — proposal-mode with PSO approval always (`PV_AUTONOMOUS_SUBMISSION_FORBIDDEN` at pack-service tier).

### 3.5 Connectors (PV-FR-080) — deferred to pack-service

**Read:** safety databases (Oracle Argus, ArisGlobal LifeSphere, Veeva Vault Safety), intake channels (call center/medical information, E2B(R3) gateways, literature monitoring), MedDRA subscription. **Write adapters (proposal-mode):** E2B(R3) submission to FDA FAERS / EudraVigilance, case status write-back, follow-up letters. Pack ships seed datasets in the landing shape.

### 3.6 Regulatory guardrails (PV-FR-090)

- **21 CFR 314.80** — 15-day Alert reports (serious + unexpected), day-zero on first receipt anywhere in the organization, PADER cadence.
- **21 CFR 312.32** — SUSARs 15-day; fatal/life-threatening 7-day initial + 8-day completion.
- **ICH E2A/E2D** — seriousness definitions, valid-case minimum criteria, due-diligence follow-up.
- **EU GVP Module VI** — serious 15-day, non-serious EEA 90-day via EudraVigilance.
- **Data protection** — patient-identifier minimization in analyst-facing surfaces; aggregate-only analytics by default.

### 3.7 Roles & case schemas (PV-FR-100) — roles SHIPPED, schemas deferred

Roles: `PV Intake Specialist`, `PV Medical Reviewer`, `PV Safety Officer` (sole submission approver), `PV Signal Analyst`, `PV Quality Auditor` (read+audit only). Case schemas (deferred): `icsr_intake`, `medical_review`, `duplicate_review`, `signal_evaluation`, `late_case_investigation`.

## 4. Domain model & data

SHIPPED materialization: 3 datasets (cases 26 / events 30 MedDRA-coded / products 8 fictional) — seed rows encode a fatal unlisted hepatobiliary cluster on the oncology product, unlisted SJS + neuropathy on a REMS product, a 7-day-clock trial anaphylaxis, an invalid-criteria consumer case, and duplicate-feed cases · 1 semantic model · 5 verified queries · 2 saved queries (incl. product→PT signal network edges) · 3 dashboards (PV Case Operations, Signal Watch, Regulatory Reporting — 15 charts) · 5 dispositions · 6-case seeded queue · 5 roles · 2 agent configs · 10 grounding memories · 2 pipelines (isolation_forest event anomaly, xgboost case-priority scorer). Deferred: guardrails, agent recipes, connectors, write adapters, eval sets, ontology, case schemas, model archetypes, display labels.

## 5. Business rules (PV-BR-*)

- **BR-1** No autonomous regulatory submission — proposal-mode with PSO four-eyes approval on every expedited decision.
- **BR-2** A case missing valid-case criteria triggers documented follow-up (≥2 attempts), never dismissal; the clock starts when the four criteria first exist.
- **BR-3** Duplicate nullification requires the retained case id; new information in a "duplicate" merges as follow-up instead.
- **BR-4** When seriousness or expectedness is arguable, assess conservatively (serious/unexpected) with reasoning recorded.
- **BR-5** Day zero is first receipt by ANY employee or agent — intake lag is a finding, not an excuse.
- **BR-6** Unlisted-term clusters in one SOC on one product flag to the signal analyst alongside (not instead of) the ICSR decision.
- **BR-7** Special situations (pregnancy exposure, overdose, medication error, lack of efficacy) are collected and assessed even without an AE.
- **BR-8** Every AI-assisted decision preserves provenance (data/model/prompt/reviewer/timestamp) — GxP/CSV posture; models require review before promotion.

## 6. Dependencies

Windrose Core (BRDs 01–23), unmodified. External (deferred connectors): safety database of record, E2B gateways, MedDRA license.

## 7. NFRs (deltas)

| Metric | Target |
|---|---|
| Triage proposal p95 latency | ≤ 10s |
| Late expedited reports (post-install) | 0 |
| Case cycle-time reduction (6mo) | ≥ 30% |
| Dashboard chart warm render | 100% real data at install |
| Idempotent re-install | all no-ops |

## 8. Acceptance criteria

- **AC-1** `packctl validate` passes; install exits 0 with 0 failed actions. **(MET 2026-07-16)**
- **AC-2** All 15 dashboard charts resolve real rows at install. **(MET — 15/15)**
- **AC-3** 6-case queue seeded from open cases incl. the 7-day SUSAR and the signal-cluster case. **(MET, UI-verified)**
- **AC-4** 5 roles bound with differentiated live capabilities; PSO alone holds disposition approve. **(MET)**
- **AC-5** Re-install is fully idempotent. **(MET)**
- **AC-6** Product grid reconciles row-for-row against seed data in the live UI. **(MET — Oncovair 4/4/4/2/1)**
- **AC-7** Pack installs on unmodified Core — zero service/helm/roles_actions.yaml diffs. **(MET)**
- **AC-8** Pack-service-tier capabilities appear verbatim in the `deferred` ledger, never faked. **(MET — 9 deferred)**

## 9. Out of scope / future

Aggregate report document generation; literature search; MedDRA licensing/coding automation; medical-device vigilance (BRD 42); veterinary PV; safety-database replacement; E2B write adapters until pack-service ships.
