# BRD 28 — `pharmacy-benefit-mgmt` capability pack

**Deliverable type:** Capability Pack (BRD 23) · **Publisher:** Datacern · **Initial version:** 1.0.0
**Horizon:** 2 pack #4. Reference pattern: BRD 24.

---

## 1. Overview

**Purpose.** Pharmacy Benefit Management (PBM) workflow AI: prescription prior-authorization, formulary alternative recommendation, Medication Therapy Management (MTM), adherence intervention prioritization. Sells to PBMs (CVS Caremark, Express Scripts, OptumRx and independents), health plans with in-house pharmacy, and Medicare Part D plans.

**Why this vertical.** PBM prior-auth is the highest-volume PA type in US healthcare (~500M Rx PAs/year). CMS Part D + Interoperability rules increase transparency pressure. MTM is a mandated Part D program (CMS Star Ratings weighted). AI-native governance-first fits the PBM regulatory posture.

**Business value.** Rx PA turnaround (from 24–72h to minutes for auto-approvable), formulary compliance (steering to preferred agents), MTM completion rate (Star Ratings), adherence lift (medication possession ratio improvement).

**In scope.** Rx PA copilot, formulary alternative suggester, MTM Comprehensive Medication Review copilot, adherence intervention prioritizer, PBM KPI dashboards, connectors to Rx claim systems + ePA (electronic prior auth) rails.

**Out of scope.** Retail pharmacy workflow (Rx dispensing itself); specialty pharmacy patient hub (separate workflows); drug pricing negotiation (contracting is a distinct product); 340B drug pricing eligibility (regulatory/audit — future pack); non-US pharmacy.

## 2. Actors & user stories

**Personas:** PA Pharmacist (PA-Rx), PA Technician (PA-T), MTM Pharmacist (MTM-Rx), Clinical Pharmacist Reviewer (CPR), Adherence Coordinator (AC), Formulary Manager (FM), VP Clinical (VPC), CMO (Chief Medical Officer of the PBM), Chief Compliance Officer (CCO), Data Steward (DS), Tenant Admin (TA).

- **US-1** As a PA-T, my inbox shows Rx PAs pre-sorted: agent-recommended auto-approve (nurse one-click), agent-escalated to pharmacist review with drafted rationale, and expedited (24-hour) cases surfaced first.
- **US-2** As a PA-Rx on a complex PA, I see the PA Copilot's proposal with plan-policy citation (formulary tier), clinical guideline citation (FDA label / compendium), step-therapy history, and comparator analysis.
- **US-3** As an FM, when a drug is denied on formulary, the Formulary Alternative Suggester proposes 3 preferred-tier alternatives with rationale (similar mechanism, similar indication, better cost/tier) for the prescriber's consideration.
- **US-4** As an MTM-Rx doing an annual CMR (Comprehensive Medication Review), the MTM Copilot has pre-drafted a personalized medication action plan (MAP) grounded in the patient's med list + conditions + adherence data.
- **US-5** As an AC, my daily worklist ranks non-adherent members by (predicted event risk × MPR gap × contact-recency); I get personalized outreach scripts.
- **US-6** As the VPC, I see PA turnaround p50/p95, auto-approve rate, formulary compliance, and MTM completion — with regulator submission preview.
- **US-7** As a CCO, I export CMS Part D audit bundle showing every AI-assisted PA decision with reviewer identity, citations, and turnaround times.
- **US-8** As a TA, when a new therapeutic class arrives (e.g., GLP-1 expansion for weight loss), pack update adds the drug-class rule set overnight.

## 3. Functional requirements

### 3.1 Pack manifest (RX-FR-001)

Standard v1. Categories: `pharmacy, pbm, prior-auth, mtm, adherence, medicare-part-d`. Regulatory: `hipaa, hitrust, cms_part_d, cms_ma, ncpdp_ecl, dea_ec, state_pharmacy_law, ddi_alerts`. Clouds: all.

### 3.2 Ontology (RX-FR-010)

`Member` (with Medicare Part D plan/tier if applicable, formulary), `Prescriber` (NPI, DEA if controlled), `Pharmacy`, `Drug` (NDC, name, therapeutic class, controlled substance schedule), `Prescription` (Rx), `PriorAuthRequest` (Rx PA — distinct from medical PA), `Authorization`, `Denial`, `Formulary` (tiers, restrictions, step therapy), `MTMEligibility` (member enrolled in MTM program), `CMR` (Comprehensive Medication Review event), `MAP` (Medication Action Plan), `AdherenceRecord` (MPR by drug + member), `DrugInteraction` (DDI from Micromedex / First Databank / Lexi-Comp).

### 3.3 Semantic model — PBM KPI catalog (RX-FR-020)

| Measure | Definition |
|---|---|
| `pa_turnaround_p50` / `p95` | percentiles by urgency (standard 72h / expedited 24h per CMS) |
| `pa_auto_approve_rate` | agent-recommended-auto-approved and nurse-confirmed / total PAs |
| `formulary_compliance_rate` | Rx dispensed at preferred tier / total Rx |
| `mtm_completion_rate` | CMRs completed / MTM-eligible members / year (Star Ratings weighted) |
| `adherence_mpr` | Medication Possession Ratio, per drug + member (Star Ratings for statins, diabetes, RAS antagonists) |
| `gap_in_care` | count of Rx gaps > threshold days by drug class |
| `pa_cost_per_decision` | joins usage_decisions with `pa_review` cases |
| `star_ratings_predictor` | rolling estimate of measure-level Star scores |

### 3.4 Agents (RX-FR-030..070) — 5 proposal-mode

1. **Rx PA Copilot (RX-FR-030)** — LangGraph `intake_pa → formulary_lookup → step_therapy_check → clinical_guideline_match → similar_pas_rag → decision_recommendation → propose`. Tools: `member.get_benefits`, `formulary.lookup(ndc, plan)`, `step_therapy.check_history`, `clinical_guideline.match`, `similar_pas.search`, `rx_pa.propose_verdict`. Confidence-calibrated for one-click auto-approve on clean cases; escalates complex to CPR.

2. **Formulary Alternative Suggester (RX-FR-040)** — when Rx PA denies at formulary, proposes 3 preferred alternatives with rationale (same mechanism, similar efficacy per compendium, better tier, DDI-safe for member). Tools: `formulary.alternatives(ndc, therapeutic_class)`, `member.med_list`, `ddi.check`, `alternatives.propose`.

3. **MTM Copilot (RX-FR-050)** — for MTM-eligible members' CMR: drafts personalized MAP grounded in med list + conditions + adherence data + high-risk medication list. Structured output: prioritized recommendations (deprescribe, dose-adjust, therapy-add, adherence coaching, PCP consult).

4. **Adherence Intervention Prioritizer (RX-FR-060)** — daily job scoring non-adherent members by predicted event risk × MPR gap; assigns to AC worklist with drafted personalized outreach script.

5. **Star Ratings Copilot (RX-FR-070)** — proactive gap-closure: identifies members close to falling below MPR threshold for Star-rating drugs (statins, RAS, diabetes); proposes interventions.

All proposal-mode; write adapters refuse without signed grant. Attempting autonomous PA denial fails install with `RX_AUTONOMOUS_DENIAL_FORBIDDEN`.

### 3.5 Connectors (RX-FR-080)

**Read (11):** RxClaim (Change Healthcare's PBM platform), MedImpact, ScriptCheck, ECIN (CoverMyMeds electronic prior auth), Surescripts (Real-Time Prescription Benefit RTPB), NCPDP EDI (Rx claims), pharmacy dispensing feeds (retail chains + PBM mail-order), Micromedex / First Databank / Lexi-Comp (drug knowledge bases — licensed), plan/formulary configs, member CRM.

**Write adapters (5, proposal-mode):** RxClaim PA decision post-back; CoverMyMeds ePA response; Surescripts approval/denial; MTM CMR document upload; adherence intervention log (into pharmacy CRM).

### 3.6 Regulatory guardrails (RX-FR-090)

- **HIPAA** — full baseline.
- **CMS Part D rules** — PA turnaround windows (72h standard / 24h expedited); coverage determination transparency; formulary transparency; MTM eligibility criteria (§423.153).
- **CMS Star Ratings** — measure-specific rules (statin adherence, statin use in diabetes, MPR ≥ 80% target).
- **NCPDP EDI** — proper eligibility / claim / PA transaction formats.
- **DEA electronic prescribing controlled substances (EPCS)** — additional identity + audit for CII-V prescription workflows.
- **State pharmacy law** — pharmacy licensure + delegation-of-authority rules per state.
- **Drug interaction alert requirements** — clinical-critical DDIs surface to reviewer; consumer-safe (non-alarming) presentations for member-facing surfaces.

### 3.7 Roles & case schemas (RX-FR-100)

Roles: `pa_pharmacist`, `pa_technician`, `mtm_pharmacist`, `clinical_pharmacist_reviewer`, `adherence_coordinator`, `formulary_manager`, `pbm_medical_director`, `pbm_compliance_officer`.

Case schemas: `rx_pa_review` · `formulary_alternative_review` · `mtm_cmr_review` · `adherence_intervention_case` · `star_gap_closure_case`.

## 4. Domain model & data

Materialization: 2 semantic models (`pbm_core`, `rx_adherence`) · 5 dashboards · 5 case schemas · 8 role seeds · 4 golden eval sets · 8 guardrail policies · 3 pipeline templates (nightly adherence scan, weekly Star gap prediction, quarterly distill Rx PA) · 2 model archetypes (`rx_pa_confidence`, `adherence_event_risk`) · 5 agent recipes · 11 connectors · pack display_labels.

### Display labels

```yaml
locale: en
keys:
  rx_pa_review.singular:           "Rx prior auth"
  rx_pa_review.action.approve:     "Approve as recommended"
  formulary_alternative_review.singular: "Formulary alternative"
  mtm_cmr_review.singular:         "Medication review (CMR)"
  adherence_intervention_case.singular: "Adherence outreach"
  star_gap_closure_case.singular:  "Star gap closure"
  agent.rx_pa_copilot.name:        "Rx PA Copilot"
  agent.formulary_alt.name:        "Alternative Finder"
  agent.mtm_copilot.name:          "MTM Copilot"
  agent.adherence_prioritizer.name: "Adherence Coordinator"
  agent.star_gap.name:             "Star Ratings Copilot"
entity_templates:
  member: "Member {member_id_last4}"
  drug:   "{name} ({ndc})"
```

## 5. Business rules (RX-BR-*)

- **BR-1** No autonomous denial or autonomous formulary change — always proposal-mode with pharmacist decision.
- **BR-2** Controlled substance (CII–CV) workflows require additional PA pharmacist review (never auto-approve); DEA EPCS audit trail preserved.
- **BR-3** CMS 72h/24h SLA enforced by case-service SLA policy; breach alerts to VPC.
- **BR-4** Formulary alternatives never suggest drugs the member has documented allergy/intolerance to (guardrail).
- **BR-5** DDI alerts surface for Level 1-2 severity per compendium; Level 3-4 (minor) suppressed to reduce alert fatigue (configurable per plan).
- **BR-6** MTM eligibility is a hard CMS rule per §423.153 (2+ chronic + 8+ Part D drugs + ≥ threshold cost); pack computes eligibility, never assumes.
- **BR-7** Non-adherent member outreach respects TCPA + opt-out preferences; automatic pause if member marks "do not contact".
- **BR-8** Star Ratings gap-closure interventions timed to CMS measurement year (typically Jan-Dec with claims run-out Jun of next year).
- **BR-9** Cross-tenant learning forbidden for formulary preferences (PBM competitive sensitivity).
- **BR-10** RTPB (Real-Time Prescription Benefit) lookups at prescriber e-Rx point are read-only; write-back to prescriber system is via proposal-mode only.

## 6. Dependencies

Datacern Core (all BRDs 01–23). External: RxClaim/MedImpact/other PBM systems; Surescripts (Rx routing); CoverMyMeds (ePA); Micromedex/First Databank/Lexi-Comp (drug knowledge — licensed); NCPDP infrastructure; DEA CSOS integration for EPCS.

## 7. NFRs (deltas)

| Metric | Target |
|---|---|
| Rx PA copilot p95 latency (per PA) | ≤ 10s |
| PA auto-approve rate (post-6mo, clean cases) | ≥ 40% |
| PA turnaround p95 (post-install) | ≤ 6h standard / ≤ 4h expedited |
| MTM CMR draft p95 | ≤ 60s |
| Adherence scoring per 100K members | ≤ 20 min nightly |
| Star Ratings prediction accuracy vs actual | ± 0.1 star |
| Cost per Rx PA (post-distillation) | ≤ $0.20 |
| PHI leak / controlled-substance data leak | 0 |

## 8. Acceptance criteria

- **AC-1** Fresh install materializes; 5 agents in shadow mode.
- **AC-2** Rx PA Copilot on a preferred-tier statin auto-approves in shadow mode with 96% agreement rate vs pharmacist historical decisions.
- **AC-3** Formulary Alternative Suggester on a denied GLP-1 proposes 3 preferred alternatives with DDI-clean, allergy-clean, therapeutic-class-match rationale.
- **AC-4** MTM Copilot on a member with 12 meds + 4 chronic conditions drafts a MAP identifying 3 deprescribing candidates + 2 adherence coaching items.
- **AC-5** Adherence Prioritizer ranks 100K members; top-decile intervention yields ≥ 2× MPR improvement vs random-assignment baseline within 90 days.
- **AC-6** Pack version attempting autonomous denial or autonomous formulary write → publish fails `RX_AUTONOMOUS_DENIAL_FORBIDDEN` / `RX_AUTONOMOUS_FORMULARY_FORBIDDEN`.
- **AC-7** Controlled substance PA never auto-approved (BR-2).
- **AC-8** CMS Part D audit bundle exports in ≤ 5 min with full evidence chain.
- **AC-9** Pack installs cleanly on unmodified Core BRDs 01–23.

## 9. Out of scope / future

Retail pharmacy dispensing (POS); specialty pharmacy patient hub; drug pricing negotiation; 340B eligibility; non-US pharmacy; hospital IP pharmacy medication reconciliation (that's provider EHR territory).
