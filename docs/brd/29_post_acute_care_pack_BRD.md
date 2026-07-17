# BRD 29 — `post-acute-care` capability pack

**Deliverable type:** Capability Pack (BRD 23) · **Publisher:** Windrose · **Initial version:** 1.0.0
**Horizon:** 2 pack #5. Reference pattern: BRD 24.

---

## 1. Overview

**Purpose.** Post-acute care AI — home health, skilled nursing facility (SNF), and hospice workflows. Covers OASIS-E (home health assessment), MDS 3.0 (SNF assessment), PDGM (Patient Driven Groupings Model — home health payment), PDPM (Patient Driven Payment Model — SNF payment), hospice election + LCD compliance, referral triage. Sells to home health agencies (HHAs), SNF operators, hospice organizations, and post-acute-network coordinators.

**Why this vertical.** Post-acute has $70B+ annual Medicare spend under two aggressive payment reforms (PDGM 2020, PDPM 2019) that shift risk to providers and heavily reward accurate assessments. Coding accuracy on OASIS/MDS drives 30–60% of the case-mix reimbursement. This is a high-stakes, high-frequency assessment workflow where AI-assisted accuracy + documentation defensibility is a 6-figure-per-facility annual revenue swing.

**Business value.** Correct PDGM comorbidity capture ($100–$700/episode), correct PDPM PT/OT/SLP/nursing/NTA case-mix assignment (~$500/day differences), reduced re-hospitalization (star ratings + value-based-purchasing), audit defensibility for RAC/CERT/UPIC.

**In scope.** Home health OASIS-E assessment copilot + PDGM optimizer, SNF MDS 3.0 copilot + PDPM optimizer, referral triage (which discharged patients to accept + urgency), care plan updater, hospice election + eligibility copilot, re-hospitalization risk model.

**Out of scope.** Assisted living / independent living (not Medicare-reimbursed workflows); inpatient rehab facility (IRF) — different assessment (IRF-PAI) — separate future pack; long-term acute care hospital (LTACH); non-US post-acute; home health aide non-clinical scheduling (workforce management out of scope).

## 2. Actors & user stories

**Personas:** HHA Clinical Nurse (HHA-N), HHA OASIS Reviewer (HHA-OR), SNF MDS Coordinator (SNF-MDS), SNF Director of Nursing (SNF-DON), Hospice RN (HSPC-RN), Hospice Medical Director (HSPC-MD), Intake Coordinator (INT), Post-Acute Care Manager (PAC-M), Facility Administrator (FA), CFO, CCO, DS, TA.

- **US-1** As an HHA-N doing an OASIS start-of-care visit, the OASIS Copilot pre-populates draft answers grounded in the referring hospital's discharge summary + prior claims + medications; I verify, adjust, and finalize.
- **US-2** As an HHA-OR, the PDGM Optimizer flags each finalized OASIS with the case-mix category, comorbidity adjustment, and any missing comorbidity codes that would upshift the episode (with documentation evidence).
- **US-3** As a SNF-MDS, the MDS Copilot drafts my quarterly MDS 3.0 based on shift notes, therapy notes, med records — I review sections and sign.
- **US-4** As a SNF-DON, the PDPM Optimizer surfaces residents whose PT/OT/SLP therapy plans are misaligned with their PDPM classification (over- or under-treatment risk).
- **US-5** As an INT, when a hospital sends a referral, the Referral Triage Agent scores it on (acceptance likelihood × reimbursement × complexity fit × capacity) and drafts an intake decision with rationale.
- **US-6** As a HSPC-MD, the Hospice Eligibility Copilot pulls the patient's terminal diagnosis + prognosis indicators (functional decline, ADLs, weight loss) and drafts the physician-certification narrative required per CMS.
- **US-7** As an FA, my re-hospitalization risk dashboard shows residents at elevated 30-day risk with recommended interventions.
- **US-8** As a CCO for a home health chain, I export a CERT/RAC audit bundle for OASIS-driven claims — every answer traced to source documentation.
- **US-9** As a TA, when CMS publishes annual OASIS/MDS updates (typically Oct 1), pack version upgrade applies the new item set + logic.

## 3. Functional requirements

### 3.1 Pack manifest (PAC-FR-001)

Standard v1. Categories: `healthcare, post-acute, home-health, snf, hospice, medicare`. Regulatory: `hipaa, cms_pdgm, cms_pdpm, oasis_e, mds_3, hospice_lcd, cert_uic_defensible, hitrust`. Clouds: all.

### 3.2 Ontology (PAC-FR-010)

`Patient`, `Referral` (from acute discharge), `Episode` (60-day home health episode or SNF stay), `OASISAssessment` (with M-item detail), `MDSAssessment` (with section-level detail), `PDGMClassification` (clinical group + functional level + admission source + timing + comorbidity adjustment), `PDPMClassification` (PT/OT/SLP/nursing/NTA components), `TherapyEncounter` (PT/OT/SLP), `MedicationRecord`, `HospiceElection`, `HospiceCertification`, `LCDPolicy` (CMS Local Coverage Determinations for hospice), `RehospitalizationRisk`.

### 3.3 Semantic model — post-acute KPI catalog (PAC-FR-020)

| Measure | Definition |
|---|---|
| `pdgm_case_mix_accuracy` | % episodes where audited case-mix matches billed |
| `pdgm_comorbidity_capture_rate` | count(episodes with any comorbidity adjustment) / count(episodes) — target ≥ 30% |
| `pdpm_component_distribution` | distribution of PT/OT/SLP/nursing/NTA components — outlier detection |
| `oasis_completion_time_p50` | median minutes to complete an OASIS-SOC assessment |
| `mds_completion_time_p50` | median minutes to complete a quarterly MDS |
| `rehospitalization_30d_rate` | 30-day acute readmission rate |
| `referral_acceptance_rate` | referrals accepted / referrals received |
| `hospice_election_median_days` | median days from eligibility to election |
| `cert_audit_pass_rate` | claims passing CERT medical review |

### 3.4 Agents (PAC-FR-030..080) — 6 proposal-mode

1. **OASIS Copilot (PAC-FR-030)** — LangGraph `intake_referral_docs → pull_prior_claims → item_by_item_draft → cross_check_logic → propose`. Drafts each of ~70 M-items in OASIS-E with rationale + source citation (discharge summary excerpt, medication list, prior claim). Nurse reviews and finalizes.

2. **PDGM Optimizer (PAC-FR-040)** — post-OASIS-finalize: computes PDGM classification, flags missed comorbidity codes with documentation evidence (drives ~$100–$700 per episode revenue). Proposes optional additional codes for nurse review.

3. **MDS Copilot (PAC-FR-050)** — parallel to OASIS but for SNF MDS 3.0 — drafts each section (A through Z) with source citations. Handles the tricky Section GG (functional abilities) and Section K (nutrition/swallowing) where PDPM sensitivity is highest.

4. **PDPM Optimizer (PAC-FR-060)** — post-MDS: computes PDPM classification across all 5 components (PT, OT, SLP, nursing, NTA); flags misalignments between therapy plan and classification; identifies interventions that would upshift a case-mix component with documentation basis.

5. **Referral Triage Agent (PAC-FR-070)** — when a hospital referral arrives (via H2H, Bamboo Health, HHAeXchange, or fax OCR), scores on acceptance likelihood, expected reimbursement, complexity vs capacity, care-gap match. Drafts accept/decline recommendation.

6. **Hospice Eligibility Copilot (PAC-FR-080)** — for a candidate patient, evaluates hospice LCD criteria (diagnosis-specific — dementia, cancer, CHF, COPD, ALS, etc.), extracts prognosis indicators from EHR, drafts the physician certification narrative required for CMS.

All proposal-mode. Attempting autonomous OASIS/MDS submission fails install with `PAC_AUTONOMOUS_ASSESSMENT_FORBIDDEN`.

### 3.5 Connectors (PAC-FR-090)

**Read (10):** HomeCare HomeBase (HHA EHR), MatrixCare (SNF + HHA + hospice), PointClickCare (SNF), Netsmart myUnity (HHA/hospice), Axxess (HHA), WellSky (post-acute), HL7 ADT from acute discharge (via HIE), Bamboo Health (post-acute referral network), HHAeXchange (Medicaid HCBS), CMS iQIES (OASIS/MDS submission).

**Write adapters (5, proposal-mode):** OASIS assessment draft write to HHA EHR; MDS assessment draft write to SNF EHR; Care plan update to EHR; Referral response (accept/decline/pend) to referral platform; Hospice certification narrative to hospice EHR.

### 3.6 Regulatory guardrails (PAC-FR-100)

- **HIPAA** — baseline.
- **CMS PDGM rules** — 60-day episode structure; case-mix logic; LUPA threshold; behavioral offset.
- **CMS PDPM rules** — 5 case-mix components; variable per-diem adjustment schedule; interrupted stay policy.
- **OASIS-E** — CMS annual item-set updates; timing rules (SOC ≤ 5 days from ROC); locking rules.
- **MDS 3.0** — comprehensive assessment schedule; Section GG rules; medical review defensibility.
- **Hospice LCD** — diagnosis-specific eligibility criteria (published per MAC); face-to-face certification requirement.
- **PEPPER + CERT + UPIC audit defensibility** — every case-mix assertion cites source documentation.
- **State home health licensure + state SNF regulations** — where they exceed federal.

### 3.7 Roles & case schemas (PAC-FR-110)

Roles: `hha_clinical_nurse`, `hha_oasis_reviewer`, `snf_mds_coordinator`, `snf_don`, `hospice_rn`, `hospice_medical_director`, `intake_coordinator`, `post_acute_care_manager`, `facility_administrator`, `pac_compliance_officer`.

Case schemas: `oasis_review` · `mds_review` · `referral_triage_review` · `pdgm_optimization_review` · `pdpm_optimization_review` · `hospice_eligibility_review`.

## 4. Domain model & data

Materialization: 3 semantic models (`hh_core`, `snf_core`, `hospice_core`) · 6 dashboards · 6 case schemas · 10 role seeds · 5 golden eval sets · 8 guardrail policies · 3 pipeline templates · 2 model archetypes (`rehospitalization_30d_risk`, `referral_acceptance_score`) · 6 agent recipes · 10 connectors · display_labels.

### Display labels

```yaml
locale: en
keys:
  oasis_review.singular:                 "OASIS review"
  mds_review.singular:                   "MDS review"
  referral_triage_review.singular:       "Referral"
  pdgm_optimization_review.singular:     "PDGM optimization"
  pdpm_optimization_review.singular:     "PDPM optimization"
  hospice_eligibility_review.singular:   "Hospice eligibility"
  agent.oasis_copilot.name:              "OASIS Copilot"
  agent.pdgm_optimizer.name:             "PDGM Optimizer"
  agent.mds_copilot.name:                "MDS Copilot"
  agent.pdpm_optimizer.name:             "PDPM Optimizer"
  agent.referral_triage.name:            "Referral Triage"
  agent.hospice_eligibility.name:        "Hospice Eligibility"
entity_templates:
  patient: "Patient {mrn_last4}"
```

## 5. Business rules (PAC-BR-*)

- **BR-1** No autonomous OASIS/MDS submission; every assessment finalized by clinical staff. Autonomous flag on submission tool → publish fails.
- **BR-2** CMS iQIES submission timing rules enforced by case-service SLA (OASIS lock ≤ 30 days from completion; MDS ≤ 14 days from completion).
- **BR-3** PDGM comorbidity codes proposed must have source documentation citation; no comorbidity added without evidence.
- **BR-4** PDPM optimizer never proposes therapy INCREASES beyond clinical justification (regulatory risk — RAC target for "therapy for the sake of case-mix"); proposals must trace to functional status + care goals.
- **BR-5** Hospice eligibility copilot NEVER makes eligibility determination — it drafts the narrative for physician review; physician certifies.
- **BR-6** Referral triage recommendations for decline require rationale (compliance risk — non-discrimination in Medicare-certified providers).
- **BR-7** Re-hospitalization risk model outputs are for care-team prioritization, not for care denial or discharge decisions.
- **BR-8** Cross-tenant model learning permitted for base classifiers (PDGM/PDPM patterns are CMS-published); customer-specific tuning stays workspace-scoped.
- **BR-9** OASIS-E and MDS 3.0 item-set updates ship as pack point releases (typically annual, CMS timing).
- **BR-10** Hospice election revocation is a hard boundary — pack must detect + block downstream hospice-only workflows immediately.

## 6. Dependencies

Windrose Core (all BRDs 01–23). External: HHA/SNF/hospice EHRs; CMS iQIES submission; referral networks (Bamboo, H2H); grouper libraries for PDGM/PDPM (CMS-published or 3M).

## 7. NFRs (deltas)

| Metric | Target |
|---|---|
| OASIS draft time savings vs manual (per assessment) | ≥ 40% (30 min → ≤ 18 min) |
| MDS draft time savings vs manual | ≥ 40% |
| PDGM comorbidity capture lift vs baseline (month 6) | +5–15 percentage points |
| PDPM case-mix accuracy (audited) | ≥ 96% |
| Referral triage p95 | ≤ 30s |
| Hospice eligibility draft p95 | ≤ 60s |
| Rehospitalization risk model AUC | ≥ 0.75 on held-out validation |
| PHI leak | 0 |

## 8. Acceptance criteria

- **AC-1** Fresh install materializes; 6 agents in shadow mode.
- **AC-2** OASIS Copilot drafts an SOC assessment for a discharged CHF patient; every M-item has a source citation (discharge summary / med list / phone screen); nurse review time ≤ 15 min vs 30 min baseline.
- **AC-3** PDGM Optimizer flags 2 missed comorbidity codes with documentation basis; nurse approves; episode reimbursement increases $342.
- **AC-4** MDS Copilot drafts a quarterly MDS; Section GG (functional) draft time reduced ≥ 50%; auditor confirms defensibility.
- **AC-5** PDPM Optimizer flags a resident whose therapy plan is above PDPM classification; proposes bringing plan into alignment with rationale (compliance-first, not revenue-first).
- **AC-6** Referral Triage on a batch of 100 referrals produces a ranked worklist; INT top-decile acceptance rate improves vs FIFO baseline.
- **AC-7** Hospice Eligibility Copilot on a dementia patient extracts FAST scale + weight loss + comorbidities and drafts the physician certification narrative — MD reviews, edits, signs.
- **AC-8** Pack version attempting autonomous submit → publish fails `PAC_AUTONOMOUS_ASSESSMENT_FORBIDDEN`.
- **AC-9** CERT audit bundle for a PDGM episode exports signed archive in ≤ 5 min with every case-mix assertion + evidence.
- **AC-10** Pack installs cleanly on unmodified Core BRDs 01–23 (falsifiability test).

## 9. Out of scope / future

Inpatient rehab (IRF-PAI) assessment — separate pack; LTACH; assisted living / independent living (non-Medicare); international post-acute; workforce scheduling (HR + workforce mgmt out of scope); DME/HME billing (BRD 26 partial); pediatric home health complex-care workflows (specialty extension).
