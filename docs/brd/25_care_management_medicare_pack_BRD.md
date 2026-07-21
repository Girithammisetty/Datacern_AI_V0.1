# BRD 25 — `care-management-medicare` capability pack

**Deliverable type:** Capability Pack (published via pack-service, BRD 23) · **Publisher:** Datacern · **Initial version:** 1.0.0
**Horizon:** 2 (**first provider-side pack** — ships after `insurance-claims-payer` v1 has 3 production references).
**Inherits:** `00_MASTER_BRD.md`, `23_pack_service_BRD.md`. Architecture: `../../DATACERN_PLATFORM_ARCHITECTURE.md` §6, §9; `../../DATACERN_STRATEGY.md` §7 (Horizons).
**Reference implementation:** `24_insurance_claims_payer_pack_BRD.md` — this BRD deliberately mirrors that structure to prove the pack thesis (Core-neutral installation across inverted buyer types).

---

## 1. Overview

**Purpose.** `care-management-medicare` is the **first provider-side vertical solution** on Datacern Core: a signed, versioned Capability Pack (BRD 23) that turns the horizontal platform into a *product* for medical practices, FQHCs, RHCs, and health-system ambulatory groups billing Medicare's care-management program family — **CCM · PCM · TCM · BHI · CoCM · RPM · RTM · APCM (2025)** — with net-new revenue capture, documentation-burden reduction, and audit-defensible compliance from day one.

**Why this is the sharpest provider wedge.** These programs are massively under-billed today (~10–20M eligible Medicare beneficiaries not enrolled). The primary blocker is **documentation burden**, not clinical judgment — care managers spend 30–50% of a session writing the note that justifies the billing code, and every code (99490, 99457, 99495, 99484, G0556, etc.) requires minute-level time tracking, consent, care plan, and activity log. RAC + MAC audits target these codes as high-fraud risk. This is exactly the workflow Datacern's proposal-mode + audit chain + governed-decision model addresses natively: every AI-drafted care plan, code proposal, and RPM review note is a proposal a clinician approves with citations to the specific documentation evidence, generating both revenue lift and compliance defense.

**Business value.** (a) **Revenue capture**: ~$65–275 per patient per program per month (or per episode for TCM), of which 40–70% is currently missed for eligible patients. (b) **Labor reduction**: care managers double or triple their patient panel with AI-assisted documentation. (c) **Compliance defense**: every billed claim ships with a complete provenance chain suitable for RAC/MAC audit. (d) **New-year adaptability**: 2025 APCM bundle (G0556/G0557/G0558) and future CMS changes are pack-version updates, not custom development.

**In scope.** All 8 program families (CCM, PCM, TCM, BHI, CoCM, RPM, RTM, APCM), ontology + semantic model + dashboards for the care-manager and CFO views, 8 agent recipes covering enrollment/scribing/code selection/care plan/documentation auditing/RPM review/TCM prioritization/outreach scheduling, EHR + RPM device + telephony connectors, CMS billing-rule + HIPAA guardrails, golden eval sets, distillation pipelines.

**Out of scope.** Direct-to-patient consumer apps (this pack sells to providers, not to patients); PCP visits themselves (E/M coding is not this pack — see future `healthcare-provider-rcm` pack); Medicaid state-specific care management waivers (each state adds nuance — separate packs); pharmacy medication-therapy management (MTM is a distinct CMS program family, future pack); Medicare Advantage delegated care management contracts (buyer overlap but different sales motion — evaluated at Horizon 2b).

## 2. Actors & user stories

Personas: **Care Manager RN (CM-RN)**, **Care Manager LPN/MA (CM-LPN)**, **Clinician / MD Reviewer (MD)**, **Behavioral Health Care Manager (BHCM)**, **Practice CFO / Director of Revenue Cycle (CFO)**, **Director of Care Coordination (DCC)**, **Chief Medical Officer (CMO)**, **Chief Compliance Officer (CCO)**, **Data Steward (DS)**, **Tenant Admin (TA)**, **RPM Device Vendor Integrator (RDV)**.

- **US-1** As a DCC, when I install the pack I want the Enrollment Eligibility Scanner to run on my practice's Medicare panel overnight and surface a ranked list of patients eligible for CCM/PCM/BHI/RPM candidates so I can prioritize outreach.
- **US-2** As a CM-RN, when I finish a phone call with a chronic-condition patient I want the Ambient Care Manager Scribe to have already produced a structured note with billable time captured, care plan updates, and activity log entries — I just review and approve.
- **US-3** As a CM-RN at month-end, I want the Code Selection Copilot to propose the right code(s) per patient (CCM base + CCM complex + additional 20-min blocks, PCM if applicable, TCM if within window, BHI if BH dx) with citations to logged activities + time — I approve or edit.
- **US-4** As an MD, I get proposed care plans for review from the Care Plan Drafter, personalized to each patient's conditions, medications, and prior visits — I approve or edit before it becomes the patient's plan of record.
- **US-5** As a CM-LPN, at the end of every day I see a queue of RPM patients whose device readings the RPM Data Reviewer has summarized; I read the summary, add anything, and the required "20 minutes of data review" note is drafted for my sign-off.
- **US-6** As a CFO, at the end of every month I see a Revenue Leakage dashboard: patients enrolled but not billed this month, grouped by reason (missing time, no consent, no care plan review, RPM readings < 16 days) — and I can drill from the total dollar leakage to the exact patient and the missing artifact.
- **US-7** As a CCO, when RAC audits arrive I export a signed audit bundle for any billing period showing every code, the time-tracked activities behind it, consent status, care plan approval, and the reviewer identity — in ≤ 5 minutes.
- **US-8** As a DCC, when a patient is discharged from the hospital, the TCM Post-Discharge Prioritizer surfaces them in the daily worklist with the 2-business-day CMS contact deadline and the 7/14-day face-to-face target visible; the pack proposes the initial contact script + med-rec checklist.
- **US-9** As a BHCM in a CoCM program, when I finish a session the BHI/CoCM code selection copilot proposes the correct code (99492 initial vs 99493 subsequent vs 99494 additional) based on my logged time and psychiatric consultant involvement.
- **US-10** As a CFO in an FQHC, I want the pack to correctly select G0511 (FQHC/RHC general care management code) instead of standard CCM/BHI codes for my patients, per CMS FQHC rules.
- **US-11** As a TA, when CMS publishes the 2026 APCM revisions I install the pack update via pack-service; my care managers' active work is preserved, and code selection immediately reflects the new rules.
- **US-12** As a DS, when the pack installs I review the new semantic-model measures (`enrollment_rate`, `revenue_leakage`, `documentation_completeness_rate`) and approve them into the workspace's governed metrics catalog.
- **US-13** As a CM-RN, when I try to bill CCM (99490) and PCM (99424) the same month for the same patient, the Documentation Completeness Auditor blocks the bill and explains the mutual exclusion — no manual audit-risk knowledge required on my part.
- **US-14** As a CMO, when the Patient Outreach Scheduler proposes calls I see the priority rationale (chronic condition acuity + last-contact recency + panel-level revenue impact) so I understand why the copilot is prioritizing this way.

## 3. Functional requirements

### Pack manifest & shipped components

- **CMM-FR-001 (Must)** Pack ships as `pack.yaml` v1 (BRD 23 §PKG-FR-001..007) with the component inventory below. Every referenced file is included in the signed OCI artifact.

```yaml
pack_manifest: 1
name: care-management-medicare
version: 1.0.0
publisher: { id: pub-datacern, name: "Datacern Inc." }
license: { spdx_id: "Commercial", url: "https://datacern.ai/licenses/care-management" }
description: "AI-assisted Medicare care management (CCM/PCM/TCM/BHI/CoCM/RPM/RTM/APCM) for providers, FQHCs, and health-system ambulatory groups."
categories: [healthcare, provider, care-management, chronic-care, remote-monitoring, medicare]
regulatory: [cms_ccm_rules, cms_rpm_rules, cms_apcm_2025, no_surprises_act, hipaa, hitrust_csf, rac_audit_defensible]
platform: { min_version: "1.4.0", clouds: [aws, azure, gcp] }
depends_on: []                          # standalone in v1
components:
  ontology:            [ { file: "ontology/care_mgmt.yaml" } ]
  semantic_models:     [ { file: "semantic/care_mgmt_core.yaml", identity: "care_mgmt_core" },
                         { file: "semantic/rpm_readings.yaml", identity: "rpm_readings" } ]
  dashboards:          [ { file: "dashboards/enrollment_funnel.json", identity: "enrollment_funnel" },
                         { file: "dashboards/revenue_leakage.json", identity: "revenue_leakage" },
                         { file: "dashboards/care_manager_throughput.json", identity: "cm_throughput" },
                         { file: "dashboards/rpm_ops.json", identity: "rpm_ops" },
                         { file: "dashboards/tcm_worklist.json", identity: "tcm_worklist" },
                         { file: "dashboards/program_pnl.json", identity: "program_pnl" } ]
  case_schemas:        [ { file: "cases/care_activity_review.yaml", identity: "care_activity_review" },
                         { file: "cases/monthly_billing_review.yaml", identity: "monthly_billing_review" },
                         { file: "cases/care_plan_review.yaml", identity: "care_plan_review" },
                         { file: "cases/rpm_data_review.yaml", identity: "rpm_data_review" },
                         { file: "cases/tcm_discharge.yaml", identity: "tcm_discharge" } ]
  role_catalog:        [ { file: "rbac/roles.yaml" } ]
  eval_sets:           [ { file: "evals/code_selection_golden.jsonl", identity: "code_selection" },
                         { file: "evals/enrollment_eligibility_golden.jsonl", identity: "enrollment" },
                         { file: "evals/documentation_completeness_golden.jsonl", identity: "documentation" },
                         { file: "evals/care_plan_golden.jsonl", identity: "care_plan" } ]
  guardrails:          [ { file: "guardrails/hipaa.rego", identity: "hipaa" },
                         { file: "guardrails/cms_code_mutual_exclusion.rego", identity: "code_mx" },
                         { file: "guardrails/cms_time_thresholds.rego", identity: "time_thresholds" },
                         { file: "guardrails/consent_required.rego", identity: "consent" },
                         { file: "guardrails/rpm_16day_rule.rego", identity: "rpm_16day" },
                         { file: "guardrails/tcm_window.rego", identity: "tcm_window" },
                         { file: "guardrails/apcm_tier_eligibility.rego", identity: "apcm_tier" },
                         { file: "guardrails/rac_audit_trail.rego", identity: "rac_audit" },
                         { file: "guardrails/fqhc_rhc_g0511.rego", identity: "fqhc_g0511" } ]
  pipeline_templates:  [ { file: "pipelines/nightly_enrollment_scan.yaml", identity: "enrollment_scan" },
                         { file: "pipelines/nightly_label_export.yaml", identity: "label_export" },
                         { file: "pipelines/quarterly_distill_code_selection.yaml", identity: "distill_code" } ]
  model_archetypes:    [ { file: "models/readmission_risk_30d.yaml", identity: "readmission_risk" },
                         { file: "models/enrollment_propensity.yaml", identity: "enrollment_propensity" } ]
  agent_recipes:       [ { file: "agents/enrollment_scanner.yaml", identity: "enrollment_scanner" },
                         { file: "agents/care_scribe.yaml", identity: "care_scribe" },
                         { file: "agents/code_selection.yaml", identity: "code_selection" },
                         { file: "agents/care_plan_drafter.yaml", identity: "care_plan_drafter" },
                         { file: "agents/documentation_auditor.yaml", identity: "documentation_auditor" },
                         { file: "agents/rpm_reviewer.yaml", identity: "rpm_reviewer" },
                         { file: "agents/tcm_prioritizer.yaml", identity: "tcm_prioritizer" },
                         { file: "agents/outreach_scheduler.yaml", identity: "outreach_scheduler" } ]
  connection_templates:[ { file: "sources/epic_ambulatory.yaml", identity: "epic_ambulatory" },
                         { file: "sources/athenahealth.yaml", identity: "athenahealth" },
                         { file: "sources/eclinicalworks.yaml", identity: "eclinicalworks" },
                         { file: "sources/nextgen.yaml", identity: "nextgen" },
                         { file: "sources/cerner_ambulatory.yaml", identity: "cerner_ambulatory" },
                         { file: "sources/rpm_optimize_health.yaml", identity: "rpm_optimize" },
                         { file: "sources/rpm_cadence.yaml", identity: "rpm_cadence" },
                         { file: "sources/rpm_ihealth.yaml", identity: "rpm_ihealth" },
                         { file: "sources/telephony_ringcentral.yaml", identity: "phone_rc" },
                         { file: "sources/telehealth_doxy.yaml", identity: "telehealth_doxy" } ]
  display_labels:      [ { file: "labels/en.yaml", identity: "en" } ]
```

### Ontology (US-Medicare care-management domain)

- **CMM-FR-010 (Must)** Entities and their key attributes:

| Entity | Key attributes (subset) | Bound to |
|---|---|---|
| `Patient` | patient_id, dob, medicare_beneficiary_id, plan_type (FFS/MA/Duals), qmb_status, effective_date, term_date, primary_provider_npi | EHR + Medicare eligibility feed |
| `Provider` | npi, tin, specialty, credential_status, fqhc_rhc_flag | EHR provider directory |
| `Encounter` | encounter_id, patient_id, provider_id, date, type (visit/telehealth/portal/phone), duration_min | EHR |
| `ChronicCondition` | patient_id, icd10_code, condition_name, onset_date, active_flag, hcc_score? | Problem list (EHR) |
| `BehavioralHealthDx` | patient_id, icd10_code, dx_name, severity, active_flag | Problem list |
| `Discharge` | patient_id, admit_date, discharge_date, facility_id, diagnosis_summary, med_reconciliation_status | HL7 ADT feed / EHR |
| `Consent` | patient_id, program_code (ccm/pcm/tcm/bhi/rpm/rtm/apcm), signed_date, revoked_date? | Consent management system / EHR |
| `CarePlan` | plan_id, patient_id, goals[], interventions[], review_due, last_reviewed_by, last_reviewed_at | EHR care mgmt module |
| `CareCoordinationActivity` | activity_id, patient_id, staff_id, timestamp, duration_min, activity_type (phone/portal/med_rev/coord_call), note_text, cited_evidence_refs | Datacern case-service |
| `DeviceReading` | patient_id, device_type (bp/glucose/spo2/weight/hr/rtm), value, unit, timestamp, device_vendor, device_id | RPM vendor connectors |
| `BillingCandidate` | patient_id, program_code, cpt_code, service_month, activities_ref[], total_time_min, proposed_by (agent_id), proposed_at, decision (pending/bill/hold/adjust) | Datacern case-service (proposal → decision) |
| `RACAuditPackage` | claim_id, cpt_code, service_month, evidence_bundle_ref (signed archive) | Datacern audit-service |

- **CMM-FR-011 (Must)** PHI-bearing fields tagged `phi: true` in the ontology (member_id, MBI, DOB, address, phone, MRN, all note text). ai-gateway PHI redaction (BRD 12 §AIG-FR-050) applies at hosted-provider boundary; SLM tier (self-hosted) is exempt only when the tenant's HIPAA config permits (`hipaa.self_hosted_phi_allowed: true`).

### Semantic model — care-management KPI catalog

- **CMM-FR-020 (Must)** Shipped semantic model `care_mgmt_core` defines the following governed measures:

| Measure | Definition | Source |
|---|---|---|
| `eligible_patients` | count of Medicare patients meeting eligibility for a given program (parameterized by program) | Patient, ChronicCondition, BehavioralHealthDx |
| `enrolled_patients` | count of patients with active `Consent` for a program | Consent |
| `enrollment_rate` | `enrolled_patients / eligible_patients` per program | derived |
| `active_billed_patients` | count of patients with at least one accepted `BillingCandidate` in the service month | BillingCandidate |
| `revenue_captured` | `sum(BillingCandidate.reimbursement) where decision='bill' AND month=<M>` — parameterized by CMS fee schedule | BillingCandidate + fee schedule ref |
| `revenue_leakage` | `sum(reimbursement) of BillingCandidate where decision='hold'` (blocked at documentation-completeness gate) | BillingCandidate |
| `documentation_completeness_rate` | `count(BillingCandidate where decision='bill') / count(BillingCandidate created)` | BillingCandidate |
| `care_manager_active_patients` | distinct patients any CM touched this month | CareCoordinationActivity + staff role |
| `care_manager_avg_minutes_per_patient` | mean total activity minutes per (patient, staff, month) | CareCoordinationActivity |
| `rpm_adherence` | for RPM-enrolled patients, avg count of days with ≥ 1 device reading in 30-day period | DeviceReading |
| `tcm_2day_contact_rate` | `count(Discharge where first_contact_within_2_business_days) / count(Discharge)` | Discharge + CareCoordinationActivity |
| `tcm_face_to_face_rate` | analogous for 7-day (99496) / 14-day (99495) visit | Discharge + Encounter |
| `rac_audit_completeness_rate` | `count(claims with complete RACAuditPackage) / count(claims billed)` | RACAuditPackage |
| `readmission_rate_30d` | for discharged patients, 30-day inpatient readmission | Discharge |
| `apcm_tier_distribution` | count of enrolled APCM patients per tier (G0556/G0557/G0558) | Consent + patient risk score |

- **CMM-FR-021 (Must)** Dimensions include: `program_code`, `cpt_code`, `service_month`, `service_line`, `provider_id`, `provider_specialty`, `care_manager_id`, `care_manager_role` (RN/LPN/MA/BHCM), `plan_type` (FFS/MA/Duals), `qmb_flag`, `fqhc_flag`, `condition_group`, `apcm_tier`.

### Agent 1 — Enrollment Eligibility Scanner

- **CMM-FR-030 (Must)** `agents/enrollment_scanner.yaml` recipe: **nightly Argo pipeline** (not interactive LangGraph) — scans the practice's Medicare panel for patients eligible for CCM (2+ chronic), PCM (1 serious chronic), BHI (BH dx), CoCM (BH dx + integrated model available), RPM (chronic with device-appropriate condition), TCM (discharged in last 30 days), APCM (2025 tier stratification per G0556/G0557/G0558 rules). Rank by (expected reimbursement × enrollment propensity × clinical benefit).
- **CMM-FR-031 (Must)** Output: `enrollment_scanner` case type (per case schema) with one case per candidate patient. Care manager reviews → offers enrollment → captures consent (which flows to `Consent` entity).
- **CMM-FR-032 (Must)** Never automatically enrolls a patient. Consent is always a human-captured decision.
- **CMM-FR-033 (Should)** Enrollment propensity model (`models/enrollment_propensity.yaml`) trained on historical consent-vs-offered outcomes; retrainable via quarterly distillation.

### Agent 2 — Ambient Care Manager Scribe

- **CMM-FR-040 (Must)** `agents/care_scribe.yaml` recipe: LangGraph graph triggered by the end of a call/session — takes transcript (from telephony or telehealth) + patient context → produces structured `CareCoordinationActivity` proposal with: activity_type, duration_min (auto-computed from call metadata), note_text (structured narrative), cited_evidence_refs (which parts of the transcript support which claims), care-plan-updates (if any goal or intervention discussed), billable-flag.
- **CMM-FR-041 (Must)** Proposal-mode only — CM reviews + approves the note before it enters the record. Time-tracked minutes are a critical field (drives billing) — the agent extracts them from the transcript and the call-timing metadata, but the CM confirms.
- **CMM-FR-042 (Must)** MCP tools: `patient.get`, `care_plan.get`, `chronic_conditions.list`, `medications.list`, `transcript.get(session_id)`, `activity.propose(patient_id, structured_note)`. All read-only except `activity.propose` (proposal-write).
- **CMM-FR-043 (Should)** Multi-language support: the scribe accepts transcripts in Spanish/Mandarin/Vietnamese and drafts the note in English with the original patient language preserved for the record.

### Agent 3 — Code Selection Copilot

- **CMM-FR-050 (Must)** `agents/code_selection.yaml` recipe: runs end-of-month per patient. Inputs: patient conditions, all `CareCoordinationActivity` for the month, `DeviceReading` counts (for RPM), any `Discharge` events (for TCM), `Consent` status per program, provider setting (FQHC/RHC → G0511 override).
- **CMM-FR-051 (Must)** Output: proposed `BillingCandidate`(s) with the code(s), rationale citing specific activities + time totals + consent evidence, code-mutual-exclusion check (e.g., CCM 99490 vs PCM 99424 same month — pick the higher-value + more-defensible), APCM tier assignment for 2025 (G0556/G0557/G0558 based on QMB + condition count + tier rules).
- **CMM-FR-052 (Must)** Never bills — proposes to a `monthly_billing_review` case for CM/CFO decision. Approval issues signed grant that lets the billing adapter post to the practice management system.
- **CMM-FR-053 (Must)** Handles every code family in scope (§1) with the correct rules — see BR-3.

### Agent 4 — Care Plan Drafter

- **CMM-FR-060 (Must)** `agents/care_plan_drafter.yaml`: at enrollment or care-plan review due-date, drafts a personalized care plan grounded in the patient's conditions + medications + prior care plans + condition-specific templates (diabetes, CHF, COPD, depression, hypertension, CKD).
- **CMM-FR-061 (Must)** Output: proposed `CarePlan` with goals, interventions, review cadence — MD/CM reviews and approves before it becomes the plan of record. Never overwrites patient-authored preferences.
- **CMM-FR-062 (Should)** Care-plan templates ship as pack content (`content/care_plan_templates/*.yaml`) — updateable via pack upgrade for CMS/quality-measure changes.

### Agent 5 — Documentation Completeness Auditor

- **CMM-FR-070 (Must)** `agents/documentation_auditor.yaml`: pre-bill (end-of-month) gate. For each `BillingCandidate` verify: (a) consent for that program on file and not revoked, (b) total time meets code minimum (99490 ≥ 20 min, 99457 ≥ 20 min, 99424 ≥ 30 min, 99492 initial ≥ 70 min, 99493 subsequent ≥ 60 min, etc.), (c) care plan reviewed within required interval, (d) RPM readings ≥ 16 days for 99454, (e) TCM windows met for 99495/99496 (2-business-day contact + face-to-face within 7 or 14 days + medication reconciliation).
- **CMM-FR-071 (Must)** If any element missing → propose `decision=hold`; if all met → propose `decision=bill`. CFO or DCC has final approval. Held claims surface in **Revenue Leakage** dashboard with the exact missing artifact.
- **CMM-FR-072 (Must)** Auditor is deterministic-first — most checks are rule-driven, not LLM. LLM only for close calls (e.g., "was this 21-minute activity substantive enough to count?"). Deterministic-first router (BRD 12 §AIG-FR-080) hits > 90% here.

### Agent 6 — RPM Data Reviewer

- **CMM-FR-080 (Must)** `agents/rpm_reviewer.yaml`: at end of each RPM-enrolled patient's monthly review window, summarize the 30-day device readings, flag anomalies (BP > 160/100, glucose > 250, weight change > 5% in 7 days, SpO2 < 90%), draft the "20 minutes of data review" note with cited specific data points and dates — for MD/CM sign-off.
- **CMM-FR-081 (Must)** Every anomaly flagged auto-generates a follow-up `care_activity_review` case (proposed CM outreach). Clinician acuity thresholds override alert defaults.
- **CMM-FR-082 (Must)** Data must exist to support 99454 bill — auditor (agent 5) gates on 16-day rule.

### Agent 7 — TCM Post-Discharge Prioritizer

- **CMM-FR-090 (Must)** `agents/tcm_prioritizer.yaml`: consumes `Discharge` events (HL7 ADT feed via connector). Ranks discharged patients daily by (30-day readmission risk × TCM 2-business-day deadline proximity × 99496-vs-99495 differential $75). Drives the CM's daily worklist.
- **CMM-FR-091 (Should)** Proposes an initial contact script (introduction + med reconciliation checklist + follow-up appointment offer) that the CM reviews and executes.
- **CMM-FR-092 (Must)** Enforces the TCM window in the completeness auditor (contact ≤ 2 business days; face-to-face 7 days for 99496 / 14 days for 99495).

### Agent 8 — Patient Outreach Scheduler

- **CMM-FR-100 (Must)** `agents/outreach_scheduler.yaml`: for every active-enrolled patient, propose next outreach date + method (call/text/portal message) balancing engagement risk (last contact ≥ N days ago), condition acuity, staff capacity, and time-of-month billing thresholds (patient needs another 8 minutes to hit 99439 add-on).
- **CMM-FR-101 (Should)** Learns from historical outreach outcomes (patient picked up / didn't / needed multiple attempts) to improve prioritization.

### Connectors & write adapters

- **CMM-FR-110 (Must)** Read connectors (via BRD 03 ingestion-service + BRD 04 dataset-service, templated per BRD 23):

| Connector | Read scope | Sync |
|---|---|---|
| `epic_ambulatory` | Epic Healthy Planet + Ambulatory (FHIR R4 + HL7v2) — Patient, Encounter, Problem List, Meds, Care Plan, ADT | CDC + subscription |
| `athenahealth` | Athena Clinicals + Population Health (REST) | CDC |
| `eclinicalworks` | eCW Care Management module (REST + FHIR) | CDC |
| `nextgen` | NextGen Care Management (FHIR + JDBC) | Nightly |
| `cerner_ambulatory` | Cerner Millennium Ambulatory (FHIR + HL7v2) | CDC |
| `rpm_optimize_health` | Optimize Health device data (webhooks + REST) | Event |
| `rpm_cadence` | Cadence RPM (REST) | Event |
| `rpm_ihealth` | iHealth device data (REST) | Event |
| `phone_rc` | RingCentral call metadata + recording download | Event |
| `telehealth_doxy` | Doxy.me session recording + duration | Event |

- **CMM-FR-111 (Must)** Write adapters (proposal-mode only, tool-plane authorized):

| Adapter | Writes to |
|---|---|
| `epic_care_activity.write` | Post `CareCoordinationActivity` to Epic Healthy Planet activity log |
| `athena_care_activity.write` | Analogous for Athena Population Health |
| `ecw_care_activity.write` | Analogous for eCW Care Management |
| `epic_care_plan.write` | Post `CarePlan` to Epic care-plan module |
| `epic_billing_candidate.write` | Queue `BillingCandidate` to Epic Resolute Ambulatory billing |
| `athena_billing_candidate.write` | Queue to Athena Collector |
| `ecw_billing_candidate.write` | Queue to eCW billing |

- **CMM-FR-112 (Must)** Adapter idempotency: every write carries `Idempotency-Key: <case_id>:<proposal_id>` per BRD 23 §PKG-FR-031; retries never double-post.

### KPI dashboards

- **CMM-FR-120 (Must)** Six shipped dashboards:
  - **Enrollment Funnel** — eligible → offered → consented → active per program; conversion rates + attrition.
  - **Revenue Leakage** — held claims by missing-artifact reason, $ leaked per week, drill to patient + artifact.
  - **Care Manager Throughput** — patients per FTE, minutes per patient, ratio of documented vs billed minutes, per-CM productivity + variance.
  - **RPM Ops** — device adherence per patient, anomaly counts, review-note completion rate.
  - **TCM Worklist** — daily discharges, 2-day contact rate, face-to-face achievement rate, per-payer breakdown.
  - **Program P&L** — revenue by code family with net after CM labor cost per patient; APCM tier distribution (2025+).

### Regulatory guardrails

- **CMM-FR-130 (Must)** `guardrails/hipaa.rego` — inherits BRD 24 §INS-FR-080 pattern; PHI masking at ai-gateway boundary for hosted providers; SLM tier default.
- **CMM-FR-131 (Must)** `guardrails/cms_code_mutual_exclusion.rego` — enforces same-month exclusions: 99490 (CCM) vs 99424 (PCM); 99484 (BHI) vs 99492-4 (CoCM); RPM vs RTM on same device data set. Violation → bill blocked with citation to CMS rule.
- **CMM-FR-132 (Must)** `guardrails/cms_time_thresholds.rego` — each code's minimum time (99490 ≥ 20, 99457 ≥ 20, 99424 ≥ 30, 99492 ≥ 70 initial, etc.); auditor blocks under-threshold bills.
- **CMM-FR-133 (Must)** `guardrails/consent_required.rego` — no bill for any code without active (not revoked) consent for that program family on that date.
- **CMM-FR-134 (Must)** `guardrails/rpm_16day_rule.rego` — CPT 99454 requires ≥ 16 days of device readings in the 30-day period. Auto-block if not met.
- **CMM-FR-135 (Must)** `guardrails/tcm_window.rego` — 99495/99496 windows: contact ≤ 2 business days after discharge + face-to-face ≤ 14 days (99495) or ≤ 7 days (99496) + medication reconciliation documented.
- **CMM-FR-136 (Must)** `guardrails/apcm_tier_eligibility.rego` (2025+) — G0556/G0557/G0558 tier assignment rules (QMB status + condition count + tier definitions per CMS 2025 rule).
- **CMM-FR-137 (Must)** `guardrails/rac_audit_trail.rego` — every billed claim must have a complete `RACAuditPackage` (consent, activity log with time, care plan review, device data for RPM). Missing → bill blocked.
- **CMM-FR-138 (Must)** `guardrails/fqhc_rhc_g0511.rego` — for FQHC/RHC providers, override standard CCM/BHI codes to G0511 bundle per CMS FQHC rules.

### Roles & case schemas

- **CMM-FR-140 (Must)** `rbac/roles.yaml` seeds: `care_manager_rn`, `care_manager_lpn`, `care_manager_ma`, `bh_care_manager`, `clinician_md`, `director_care_coordination`, `practice_cfo`, `compliance_officer`, `data_steward`, `rpm_device_admin`.
- **CMM-FR-141 (Must)** Case schemas materialized via BRD 08:
  - **`care_activity_review`** — fields: patient_id, activity_id, drafted_note, drafted_time_min, cited_evidence, decision (approve/edit/reject). Statuses: `pending → in_review → decided`.
  - **`monthly_billing_review`** — fields: patient_id, service_month, proposed_billing_candidates[], total_expected_revenue, decision. Statuses: `pending → in_review → decided`.
  - **`care_plan_review`** — fields: patient_id, drafted_plan_ref, base_template, personalizations, cited_conditions, decision. Statuses: `pending → in_review → decided`.
  - **`rpm_data_review`** — fields: patient_id, review_period, drafted_summary, anomalies, drafted_review_note, decision. Statuses: `pending → in_review → decided`.
  - **`tcm_discharge`** — fields: patient_id, discharge_id, sla_deadline_2day, sla_deadline_faceto7or14, contact_status, drafted_script, decision. Statuses: `pending → in_progress → resolved`.

### KPI + reporting deliverables (compliance-facing)

- **CMM-FR-150 (Must)** `pipelines/nightly_enrollment_scan.yaml` — Argo workflow runs the enrollment scanner nightly; new candidate cases surface each morning.
- **CMM-FR-151 (Must)** `pipelines/nightly_label_export.yaml` — governed labels (activity approvals, billing decisions, care plan approvals, RPM review approvals) → label store → distillation flywheel.
- **CMM-FR-152 (Must)** `pipelines/quarterly_distill_code_selection.yaml` — retrains Code Selection Copilot on the customer's own resolved billing history; promotes new SLM version through eval gate (BRD 16).
- **CMM-FR-153 (Must)** One-click regulator audit bundle: `POST /packs/care-management-medicare/audit_bundle?claim_id=` or `?from=&to=` returns a signed archive with every claim's evidence chain — for RAC/MAC audit response in ≤ 5 minutes.

## 4. Domain model & data

Same materialization contract as BRD 24 (§4): the pack materializes rows into Core services via BRD 23 §PKG-FR-030. Table of concern:

| Where | What appears on install |
|---|---|
| **semantic-service** | `care_mgmt_core` model + `rpm_readings` model + shipped verified queries |
| **chart-service** | 6 dashboards |
| **case-service** | 5 case schemas |
| **rbac-service** | 10 role seeds |
| **eval-service** | 4 golden eval sets |
| **guardrail-service** | 9 OPA policies |
| **pipeline-orchestrator** | 3 workflow templates |
| **experiment-service** | 2 model archetype seeds |
| **agent-runtime** | 8 agent recipes (proposal-mode) |
| **ingestion-service** | 10 connection templates |
| **tool-registry** | ~30 MCP tool registrations |
| **memory-service** | Workspace-scoped RAG bucket for prior care plans + resolved billing outcomes |
| **bff-graphql** | Pack `display_labels/en.yaml` merged into workspace label map |

### 4.1 Display labels (CMM-FR-160)

Selected keys shipped:

```yaml
locale: en
keys:
  case.singular:            "Case"
  patient.singular:         "Patient"
  patient.plural:           "Patients"
  care_activity_review.singular:  "Care activity"
  care_activity_review.action.approve: "Approve activity"
  monthly_billing_review.singular: "Monthly billing"
  monthly_billing_review.action.approve: "Bill approved codes"
  monthly_billing_review.action.hold: "Hold for missing docs"
  care_plan_review.singular: "Care plan"
  rpm_data_review.singular:  "RPM data review"
  tcm_discharge.singular:    "Post-discharge (TCM)"
  agent.enrollment_scanner.name: "Enrollment Scanner"
  agent.care_scribe.name:      "Care Manager Scribe"
  agent.code_selection.name:   "Code Copilot"
  agent.care_plan_drafter.name: "Care Plan Drafter"
  agent.documentation_auditor.name: "Documentation Auditor"
  agent.rpm_reviewer.name:     "RPM Reviewer"
  agent.tcm_prioritizer.name:  "TCM Prioritizer"
  agent.outreach_scheduler.name: "Outreach Scheduler"
  cost.not_tracked:            "Cost not attributed"
entity_templates:
  patient: "Patient {mbi_last4}"       # PHI-safe display — never full MBI in default mode
  case:    "{kind_singular} #{short_id}"
```

### 4.2 State machines

Standard per-case-schema state machines (§CMM-FR-141). Additionally:

- **BillingCandidate:** `proposed → in_review → decided (bill | hold | adjust)`. Only `bill` triggers the write-adapter to the PMS. `hold` surfaces in Revenue Leakage.

## 5. Pack manifest specification

See §3 CMM-FR-001 for the top-level manifest. OCI artifact layout mirrors BRD 24 §5 with the CMM-specific components substituted.

## 6. Events

- **Emitted (via installed components — no new topics):** `case.created / case.resolved` per case type; `ai.token_usage.v1` per agent call with `decision_urn = case.urn` (BRD 17 §USG-FR-080); `pack.install_completed` (BRD 23).
- **Consumed:** `dataset.schema_changed` on connector-owned datasets → surface broken references in `pack_installs.health`.

## 7. Business rules & edge cases

- **BR-1** Consent is a hard prerequisite. No agent recipe in this pack proposes billing for any code without an active, non-revoked `Consent` row for that program family. Auditor blocks; UI shows the missing artifact.
- **BR-2** Autonomous mode is forbidden for every write adapter — same permanent gate as BRD 24 §BR-1. Attempting to set `mode: autonomous` on any billing/care-plan/care-activity write tool fails pack install with `CMM_AUTONOMOUS_BILLING_FORBIDDEN`.
- **BR-3** Code family rules encoded in the agent recipes + guardrails (not just documentation):
  - **CCM 99490 base** ≥ 20 min non-face-to-face; **99439 additional** blocks (each +20 min beyond 40, up to 60 min); **99487 complex** ≥ 60 min; **99489 complex additional** blocks; **99491 solo physician** ≥ 30 min.
  - **PCM 99424..99427** ≥ 30 min for single serious chronic condition.
  - **BHI 99484** ≥ 20 min; **CoCM 99492 initial** ≥ 70 min; **99493 subsequent** ≥ 60 min; **99494 additional** blocks.
  - **TCM 99495** face-to-face within 14 days + med-rec + moderate complexity; **99496** face-to-face within 7 days + med-rec + high complexity; both require contact ≤ 2 business days.
  - **RPM 99453** setup + patient education; **99454** ≥ 16 days of device readings in 30 days; **99457** ≥ 20 min/mo clinician review; **99458** additional 20-min blocks.
  - **RTM 98975–98977** analogous device families for musculoskeletal/respiratory/CBT; **98980..98981** clinician review time.
  - **APCM (2025) G0556 / G0557 / G0558** tier stratification per condition count + QMB status.
  - **FQHC/RHC G0511** overrides standard CCM/BHI codes per CMS FQHC rules.
- **BR-4** RPM 16-day rule blocks the 99454 bill; but 99457 (clinician review time) is billable independently if the 20-min threshold met, even if device-reading days < 16. Auditor handles this correctly per code.
- **BR-5** Same patient can be enrolled in CCM AND RPM (they don't conflict); can be enrolled in CCM AND BHI (different clinical domains). Cannot bill CCM 99490 AND PCM 99424 same month (mutual exclusion). Cannot bill BHI 99484 AND CoCM 99492-4 same month.
- **BR-6** APCM (G0556/G0557/G0558) is a BUNDLED code — it replaces standard CCM/PCM/TCM billing for that month when a practice chooses the APCM model. Enrollment is per-practice, not per-patient. Once APCM enrolled for a practice, standard CCM codes are not billed for those patients (pack enforces).
- **BR-7** Consent revocation is immediate — a patient can revoke at any time; the case-service consent tracker consumes revocation events and the auditor consults latest state before proposing any bill.
- **BR-8** TCM 30-day period counts from discharge date, not admit date; face-to-face day is the calendar day (not business day); contact within 2 business days excludes weekends and federal holidays (state holidays are configurable).
- **BR-9** RPM device data must originate from an FDA-cleared device — the pack ships a whitelist of vendor+device pairs; data from non-listed devices does not count toward the 16-day rule.
- **BR-10** RTM (98975..98981) allows non-physician billing (PT, OT, SLP under general supervision); CCM and RPM require physician or NP/PA supervision. Auditor enforces per-code supervision requirements.
- **BR-11** Multi-provider practices: care-management billing attributes to the "billing provider" (usually the primary care physician), not the care manager. Time can be accumulated across multiple staff (RN + LPN + MA) but under one billing provider per patient per month.
- **BR-12** For 2025+ tenants that opt into APCM, historical CCM/PCM enrollments are grandfathered; new enrollments after the APCM opt-in date use G0556/G0557/G0558.
- **BR-13** Consent capture triggers a `Consent` row + audit event; revocation is a separate audit event. The `RACAuditPackage` for any bill must include both if a revocation happened after enrollment.

## 8. Dependencies

- **Datacern services:** all Core BRDs (01–22) + BRD 23 pack-service + BRD 17 usage-service for cost-per-decision panels + BRD 16 eval-service for release gate + BRD 15 memory-service for prior-care-plan RAG.
- **External systems (customer's):** Epic Ambulatory / Athena / eCW / NextGen / Cerner Ambulatory (EHR); Optimize Health / Cadence / iHealth / Rimidi / Impilo (RPM devices); RingCentral / Zoom for Healthcare / Doxy.me (telephony/telehealth); Waystar / Availity / Change Healthcare (clearinghouse for claim submission); optional: Salesforce Health Cloud (care-management workflow layer some practices use).
- **Regulatory:** Datacern ships HIPAA BAA + template + HITRUST + SOC 2; pack ships CMS rule documentation crosswalks per program family; RAC/MAC audit-response playbook.

## 9. NFRs (deltas from master)

| Metric | Target |
|---|---|
| Enrollment scanner scan time per 10K-patient panel | ≤ 30 min nightly |
| Care scribe latency (transcript → drafted note) | ≤ 60s after call end |
| Code selection copilot p95 latency (per patient-month) | ≤ 5s |
| Documentation auditor p95 latency (per patient-month) | ≤ 2s (deterministic-first hit rate > 90%) |
| RPM data reviewer p95 latency (per patient) | ≤ 15s |
| TCM contact 2-business-day compliance (post-pack) | ≥ 95% target |
| RAC audit bundle export | p95 ≤ 5 min |
| Enrollment lift vs baseline (post-install, month 6) | ≥ 2× baseline for CCM/RPM candidates |
| PHI leak incidents | 0 (release gate) |

## 10. Acceptance criteria

- **AC-1** Given a fresh install of `care-management-medicare@1.0.0` into a workspace, When install completes, Then all components in §4 materialize successfully, 8 agents register in `mode: shadow`, and `pack.install_completed` fires with `materialized_count=30+`.
- **AC-2** Given the `epic_ambulatory` connector configured with production credentials, When the first CDC batch lands, Then `Patient`, `ChronicCondition`, `CarePlan`, `Encounter`, and `Discharge` entities populate; the Enrollment Funnel dashboard renders live numbers within 24h.
- **AC-3** Given a Medicare patient with hypertension + type-2 diabetes (2 chronic conditions), When the Enrollment Scanner runs, Then this patient appears in the CCM candidate list ranked with expected reimbursement $65 PMPM and enrollment propensity score.
- **AC-4** Given a completed 22-minute care coordination call for an enrolled CCM patient, When the Ambient Care Scribe processes the transcript, Then a `CareCoordinationActivity` proposal is drafted with `duration_min=22`, structured note, and cited transcript evidence — approved by the CM within 30 seconds of review.
- **AC-5** Given an enrolled CCM patient with 3 approved activities totaling 25 minutes for the month, When the Code Selection Copilot runs at month-end, Then it proposes `BillingCandidate(cpt=99490, patient_id=…, month=…, total_time_min=25, expected_reimbursement=$65)` with rationale citing the activities.
- **AC-6** Given the same patient with 42 minutes total (20+ base + 22 additional), When the Copilot runs, Then it proposes `99490` base + `99439` additional 20-min block — with mutual exclusion vs PCM 99424 confirmed and rationale attached.
- **AC-7** Given a proposed CCM bill for a patient whose consent was revoked 5 days before service month end, When the Documentation Auditor runs, Then the bill is proposed `decision=hold` with reason `consent_revoked` and revocation date cited; Revenue Leakage dashboard shows the held claim.
- **AC-8** Given an RPM-enrolled patient with 15 days of BP readings in the 30-day period, When the auditor evaluates `99454`, Then bill is `hold` with reason `rpm_16day_not_met`; the co-billable `99457` (20-min review) can still be billed if the review threshold is met.
- **AC-9** Given a discharged patient at 5 PM Friday, When the TCM Prioritizer runs Saturday morning, Then the 2-business-day contact deadline is computed as end-of-day-Tuesday (excluding weekend); worklist priority reflects this.
- **AC-10** Given a proposed `denial.rationale` (in the analog payer pack), the equivalent here is a proposed care activity — When the CM approves with an edit (changed duration_min from agent's 22 to 20), Then the edit-diff is highlighted, both drafted and approved values are stored on the case, and the edited value feeds the label store.
- **AC-11** Given a pack version submitted with an agent recipe carrying `mode: autonomous` on `billing.bill_now.write`, When published, Then publish fails `CMM_AUTONOMOUS_BILLING_FORBIDDEN` naming the offending recipe (BR-2 hard gate).
- **AC-12** Given a Presidio + HIPAA-custom detector at the ai-gateway boundary, When the Care Scribe processes a transcript containing patient MBI and DOB, Then the hosted-provider prompt log contains typed placeholders `<PII:MBI:1>` and `<PII:DOB:1>` — verified by prompt-log sample audit.
- **AC-13** Given the CCO invokes `POST /packs/care-management-medicare/audit_bundle?claim_id=99490-…`, When generated, Then a signed archive returns within 5 min containing consent, all activities with times + notes, care plan review, cited evidence, reviewer identity, and CPT-rule citations; second run with `redact_phi: true` returns the same bundle with PHI redacted for external submission.
- **AC-14** Given a `care-management-medicare@1.0.0 → 1.1.0` upgrade adding the 2025 APCM tier rules (G0556/G0557/G0558), When executed, Then the upgrade materializes the new guardrail policy + agent-recipe update; existing CCM enrollments are preserved; new enrollments after the APCM opt-in date use APCM codes.
- **AC-15** Given a fresh cell with only Core BRDs 01–23 installed (no vertical pack), When `care-management-medicare@1.0.0` installs, Then no Core service requires a patch — this pack ships and runs on unmodified Core (**pack thesis Test 1 per `DATACERN_CORE_CAPABILITIES.md` §6**).

## 11. Out of scope / future

- Direct-to-patient consumer app (member-services pack, future).
- E/M code selection for primary care visits (that's `healthcare-provider-rcm`, future pack).
- Medicaid state-specific care management (per-state waiver rules — future packs).
- Medicare Advantage delegated care management contracts (buyer overlap but different sales motion — evaluated Horizon 2b).
- Pharmacy MTM (Medication Therapy Management — separate CMS program family).
- Home-health OASIS assessments (distinct workflow — future pack).
- ACO shared-savings calculation + attribution (analytics on top of this pack — future).
- Non-Medicare commercial care management (some payers offer analogous programs — evaluate case-by-case).
- Autonomous billing (never — see BR-2).

## Appendix — canonical NL questions (verified queries in semantic-service)

Seeded with the pack:

1. "How many patients are eligible for CCM but not yet enrolled?"
2. "What's our revenue leakage this month, grouped by reason?"
3. "Which care managers have the highest patients-per-FTE?"
4. "Show me RPM patients under 16 days of readings this cycle."
5. "TCM patients discharged in the last 7 days who haven't been contacted."
6. "Monthly program P&L by CPT code family for last quarter."
7. "APCM tier distribution — how many patients qualify for G0556 vs G0557 vs G0558?"
8. "Patients enrolled in CCM whose care plan hasn't been reviewed in the last 12 months."
9. "Which chronic conditions in our panel have the lowest CCM enrollment rate?"
10. "Total RAC audit-defensible claims this quarter vs claims billed without complete evidence."

(Full 20 in `semantic/care_mgmt_core.verified_queries.yaml` shipped with the pack.)
