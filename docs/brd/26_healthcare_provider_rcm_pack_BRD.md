# BRD 26 — `healthcare-provider-rcm` capability pack

**Deliverable type:** Capability Pack (BRD 23) · **Publisher:** Datacern · **Initial version:** 1.0.0
**Horizon:** 2 pack #2 (ships after `care-management-medicare` v1 has 2 production references, ~month 24).
**Inherits:** `00_MASTER_BRD.md`, `23_pack_service_BRD.md`. Reference implementation pattern: `24_insurance_claims_payer_pack_BRD.md`.

---

## 1. Overview

**Purpose.** Provider-side **general Revenue Cycle Management**: coding, denial management, underpayment recovery, AR follow-up, patient collections. Sells to medical groups (10+ physicians), hospitals, health systems, ASCs, and RCM outsourcers/MSPs. Sits ABOVE their existing Epic Resolute / Athena Collector / Cerner Millennium / R1 platform — reads via FHIR + EDI + native APIs, writes proposal-mode into the SoR.

**Why this vertical (Horizon 2 pack #2).** Larger TAM than payer (~$3–5B RCM AI market vs ~$1.5B payer AI), and complements BRD 25 by covering the *general* provider revenue cycle vs the *care-management slice*. The pack thesis test: BRD 25 (per-patient recurring billing) + BRD 26 (per-encounter billing) prove Core serves both recurring and event-driven provider workflows without Core changes.

**Business value.** Denial-reversal $, days-in-AR reduction, coder productivity lift, coding-audit defensibility. Providers lose 5–15% of net patient revenue to denials + underpayments; recovering half of that is a 3–7-point margin swing.

**In scope.** Coding (ICD-10 / CPT / HCPCS / DRG) copilot, denial-response drafter, underpayment detector, AR prioritizer, patient-collections copilot, EHR/PMS/clearinghouse connectors, CMS/LCD/NCD/NCCI guardrails, KPI dashboards for RCM ops, golden eval sets, distillation pipelines.

**Out of scope.** Care management (BRD 25 owns CCM/RPM/etc); ambient in-visit note capture (crowded space; separate pack decision, `healthcare-ambient-clinical-documentation`); DME/HME billing (separate workflows); non-US provider billing.

## 2. Actors & user stories

**Personas:** Medical Coder, Denial Specialist, AR Analyst, Billing Manager, Patient Financial Services Rep (PFS), VP Revenue Cycle, CFO, CCO, Data Steward, Tenant Admin.

- **US-1** As a Coder, I see the Coding Copilot's proposed ICD-10 + CPT + modifiers for each encounter with cited chart evidence (progress notes, meds, orders); I accept, edit, or reject.
- **US-2** As a Denial Specialist, I open a denial and see the Denial Response Agent's drafted appeal packet — denial-reason analysis, payer-policy citation, medical-record support, recommended action (appeal, correct+resubmit, write-off).
- **US-3** As an AR Analyst, my daily worklist is ranked by (probability of collection × amount × payer-response-latency); I work the top-value claims first, not FIFO.
- **US-4** As the VP Revenue Cycle, I see days-in-AR, first-pass yield, denial rate by reason code, and net collection rate — with QoQ trends and drill-down.
- **US-5** As a PFS Rep, when I call a patient about balance owed, the Collections Copilot has drafted a plain-English EOB and proposed a payment plan grounded in the patient's affordability profile.
- **US-6** As a CFO, the Underpayment Detector surfaces claims paid below the contracted amount per payer contract — grouped by payer, ranked by dollar impact.
- **US-7** As a CCO, I export a signed coding-audit bundle for a RAC review — every code assignment with cited chart evidence and rule justification, in ≤ 5 min.
- **US-8** As a Coder in a specialty practice, the pack's specialty-specific coding-rule extensions (orthopedics, cardiology, oncology) surface correctly.
- **US-9** As a Tenant Admin, when CMS publishes a new NCCI edit quarterly, I install the pack update; my coders' custom preferences are preserved.

## 3. Functional requirements

### 3.1 Pack manifest (RCM-FR-001)

Standard pack.yaml v1 per BRD 23 §PKG-FR-001..007. Categories: `healthcare, provider, revenue-cycle, coding, denial-mgmt, ar`. Regulatory: `hipaa, cms_billing, lcd_ncd, ncci, no_surprises_act, rac_audit_defensible`. Clouds: aws, azure, gcp.

### 3.2 Ontology (RCM-FR-010)

`Patient`, `Encounter`, `Provider`, `Charge`, `Claim`, `Denial`, `Remittance` (835), `Appeal`, `PayerContract` (per-payer negotiated rates + rules), `PatientAccount`, `ClinicalDocument` (progress notes, orders, labs, imaging), `CodeAssignment` (ICD-10, CPT, HCPCS, modifiers, DRG for inpatient), `PayerPolicy` (payer-specific medical policies).

PHI-bearing fields tagged `phi: true` — same ai-gateway boundary enforcement as BRDs 24/25.

### 3.3 Semantic model — RCM KPI catalog (RCM-FR-020)

| Measure | Definition |
|---|---|
| `days_in_ar` | median days from date-of-service to payment, per payer + service line |
| `first_pass_yield` | count(claims paid on first submission) / count(claims submitted) |
| `denial_rate` | count(denials) / count(claims) — 30d rolling |
| `denial_reversal_rate` | count(overturned appeals) / count(appeals) — 90d |
| `net_collection_rate` | net payments / (net charges − contractual adjustments) |
| `cost_to_collect` | RCM labor + tech cost / net collections |
| `underpayment_recovery_$` | sum(expected_paid − actual_paid) recovered via disputes |
| `coder_productivity` | encounters coded / coder / day |
| `over_denied_procedure_score` | per CPT, `overturned_appeals / total_denials` — flags wrongly-denied procedures |

### 3.4 Agents (RCM-FR-030..080) — 6 proposal-mode

1. **Coding Copilot (RCM-FR-030)** — LangGraph: `intake_encounter → doc_extraction → code_candidates → ncci_edit_check → modifier_analysis → propose`. Tools: `chart.get`, `orders.get`, `labs.get`, `imaging.get`, `code_catalog.lookup`, `ncci_edit.check`, `lcd_ncd.lookup`, `coding.propose_assignment`. Handles E/M leveling (99213/99214/99215 selection), procedure-code selection, modifier logic (25, 59, 76, 77, etc.), and inpatient DRG assignment with MCC/CC identification.

2. **Denial Response Agent (RCM-FR-040)** — `intake_denial → reason_code_analysis → payer_policy_lookup → chart_evidence_pull → payer_specific_appeal_template → propose`. Tools: `denial.get`, `payer_policy.lookup`, `chart.get`, `similar_appeals.search` (RAG over prior workspace overturns), `appeal.propose_packet`. Cost budget: `chat: 30 calls / 60K tokens / 3 reflections` (mirrors payer appeal agent).

3. **Underpayment Detector (RCM-FR-050)** — nightly Argo pipeline compares each 835 remittance line against the `PayerContract` fee schedule. Proposes `underpayment.propose_dispute` for lines paid < contracted with citation to the specific contract clause.

4. **AR Prioritizer (RCM-FR-060)** — daily job scoring open claims by (payer-response-latency × claim age × probability_of_collection × amount). Outputs a ranked worklist per AR Analyst.

5. **Patient Collections Copilot (RCM-FR-070)** — for each patient with balance due, drafts a plain-English EOB, proposes payment plan grounded in affordability signals (charity-care eligibility, prior payment history), TILA-compliant. Tools: `patient_account.get`, `charity_care_eligibility.check`, `affordability_score.compute`, `payment_plan.propose`.

6. **Coding Audit Prep Agent (RCM-FR-080)** — for RAC/MAC/OIG audit requests, assembles the evidence bundle per claim: chart excerpts supporting each code, LCD/NCD citations, modifier justification, signed provenance chain. Non-agent — deterministic assembly, LLM-drafted narrative summary only.

All agents proposal-mode. Attempting to configure any billing/coding write with `mode: autonomous` fails pack install with `RCM_AUTONOMOUS_BILLING_FORBIDDEN` (mirrors BRD 24 §BR-1 and BRD 25 §BR-2).

### 3.5 Connectors (RCM-FR-090)

**Read (10):** Epic Resolute (FHIR R4 + HL7v2 + Epic REST), Athenahealth Collector, eClinicalWorks billing, NextGen billing, Cerner/Oracle Millennium, athenaClinicals, EDI 837 (submitted claims), EDI 835 (remittance), EDI 276/277 (claim status), EDI 275 (medical attachments), Waystar clearinghouse, Change Healthcare (Optum), Availity.

**Write adapters (7, all proposal-mode):** Epic charge/claim/note write · Athena claim update · eCW claim update · Cerner claim update · Waystar submission · Availity submission · outbound EDI 837 (corrected claim) + EDI 276 (status inquiry).

### 3.6 KPI dashboards (RCM-FR-100)

RCM Overview · Denial Analytics · Coding Quality · AR Aging Actions · Underpayment Recovery · Patient Collections. All Semantic-service compile.

### 3.7 Regulatory guardrails (RCM-FR-110)

- **HIPAA** (inherits Core baseline).
- **CMS billing rules** — LCD (Local Coverage Determinations), NCD (National Coverage Determinations), NCCI (National Correct Coding Initiative) edits, MAC-specific edits.
- **No Surprises Act** — patient balance billing rules for OON emergency + ancillary care.
- **State balance-billing rules** — per-state configurable (CA, NY, TX have distinct ones).
- **TILA / FDCPA** — patient payment-plan disclosures + collection practices.
- **RAC/MAC audit posture** — every code assignment cites the source chart evidence.

### 3.8 Roles & case schemas (RCM-FR-120)

Roles: `medical_coder`, `denial_specialist`, `ar_analyst`, `billing_manager`, `pfs_rep`, `revenue_cycle_director`, `cfo`, `compliance_officer`, `coding_auditor`.

Case schemas: `coding_review` · `denial_response_review` · `underpayment_dispute_review` · `ar_worklist_item` · `patient_collection_case` · `coding_audit_prep`.

## 4. Domain model & data

Standard materialization via BRD 23 §PKG-FR-030 into: semantic-service (2 models), chart-service (6 dashboards), case-service (6 schemas), rbac-service (9 role seeds), eval-service (4 golden sets), guardrail-service (6 policies), pipeline-orchestrator (3 pipelines), experiment-service (2 model archetypes: `denial_reversal_probability`, `patient_affordability_score`), agent-runtime (6 agent recipes), ingestion-service (10+ connector templates), tool-registry (~25 MCP tools), memory-service (workspace-scoped RAG for prior overturns + payer policies), bff-graphql (display_labels).

### Display labels (selected)

```yaml
locale: en
keys:
  case.singular:            "Case"
  coding_review.singular:   "Coding review"
  coding_review.action.approve: "Approve codes"
  denial_response_review.singular: "Denial appeal"
  denial_response_review.action.appeal: "Submit appeal"
  underpayment_dispute_review.singular: "Underpayment"
  ar_worklist_item.singular: "AR item"
  patient_collection_case.singular: "Collection case"
  agent.coding_copilot.name:      "Coding Copilot"
  agent.denial_response.name:     "Denial Analyst"
  agent.underpayment_detector.name: "Underpayment Detector"
  agent.ar_prioritizer.name:      "AR Prioritizer"
  agent.patient_collections.name: "Collections Copilot"
entity_templates:
  patient: "Patient {mrn_last4}"
  claim:   "Claim {claim_id}"
```

## 5. Events

Emitted via installed components (no new topics): `case.created/resolved` per case schema; `ai.token_usage.v1` with `decision_urn = case.urn`; `pack.install_completed`.
Consumed: `dataset.schema_changed` on connector-owned datasets.

## 6. Business rules & edge cases (RCM-BR-*)

- **BR-1** Never bills autonomously; the Coding Copilot proposes, the Coder decides. Coding-write adapter refuses without a signed grant.
- **BR-2** E/M level selection uses the 2021 CPT E/M guidelines by default (medical decision-making OR time); pack ships config toggle for practices still on the 1995/1997 rules for their carriers.
- **BR-3** NCCI edit violations block bill proposal; auditor cites the edit pair + rule reference; coder can override with modifier 25/59 with documented reason (audited).
- **BR-4** LCD/NCD non-coverage denials go to a special sub-workflow — the Denial Response Agent flags them as "coverage denial" (vs "documentation denial" or "medical necessity denial") and drafts appeal only if there's clinical case; otherwise recommends write-off.
- **BR-5** Underpayment disputes bounded by payer contract term (typical 90-180 days); disputes older than contract limit are marked `time_barred` and not proposed.
- **BR-6** Payment plans for patients respect state max APR + affordability floor (medical debt federal reporting rules effective 2024+); the Collections Copilot never proposes a plan that fails these checks.
- **BR-7** Coding audit prep is read-only aggregation — never modifies existing code assignments, only surfaces evidence.
- **BR-8** Specialty coding logic (orthopedics 20xxx codes, cardiology 33xxx, oncology infusions) ships as pack sub-configs; enabling a specialty adds tighter rules without altering the base pack behavior.
- **BR-9** Multi-provider practices: billing provider ≠ rendering provider is common; coding attributes to rendering, billing writes reference billing_provider_npi.
- **BR-10** Inpatient DRG assignment (MS-DRG for Medicare, APR-DRG for most others) uses grouper library shipped with the pack; MCC/CC (major/complication) capture is a first-class agent output (drives ~$5K–$50K per DRG upshift when correctly captured).

## 7. Dependencies

Datacern Core (all BRDs 01–23) + BRD 17 usage-service + BRD 16 eval-service + BRD 15 memory-service. External: Epic/Athena/eCW/NextGen/Cerner EHRs; Waystar/Change/Availity clearinghouses; EDI infrastructure; optional grouper library (3M or CMS).

## 8. NFRs (deltas from master)

| Metric | Target |
|---|---|
| Coding copilot p95 per encounter | ≤ 8s |
| Denial response draft p95 per appeal | ≤ 2 min |
| Underpayment scan per 10K remittance lines | ≤ 30 min nightly |
| AR prioritization scan per 10K open claims | ≤ 15 min daily |
| Coding-audit bundle export | p95 ≤ 5 min per claim |
| First-pass yield lift vs baseline (post-install, month 6) | +5–10 points |
| Denial-reversal rate lift vs baseline (post-install, month 6) | +10–25 points |
| PHI leak incidents | 0 |

## 9. Acceptance criteria

- **AC-1** Fresh install of `healthcare-provider-rcm@1.0.0` materializes all components; 6 agents register in `mode: shadow`; `pack.install_completed` fires with `materialized_count=35+`.
- **AC-2** Coding Copilot on a chest-pain E/M encounter proposes `99214` with cited HPI + MDM elements; NCCI check clean; coder approves; write-adapter posts to Epic Resolute with `Idempotency-Key`.
- **AC-3** Denial Response Agent on a 197-denial (precertification not obtained) drafts a 3-argument appeal citing (a) the actual PA on file (agent finds it), (b) the plan policy contradicting the denial, (c) medical urgency records — reviewer sends via clearinghouse.
- **AC-4** Underpayment Detector on 30 days of 835s flags 47 claims paid below contract; ranked by dollar impact; dispute-eligible ones (within contract window) marked `propose_dispute`; time-barred marked `time_barred` with reason.
- **AC-5** AR Prioritizer produces daily worklist ranked correctly (highest-yield-first); AR Analyst throughput on top-quintile claims improves ≥ 30% vs FIFO baseline within 30 days.
- **AC-6** Patient Collections Copilot proposes a payment plan; TILA-compliance guardrail rejects a proposal with APR > state max; corrected plan passes; PFS Rep sends.
- **AC-7** Pack version attempts `mode: autonomous` on any coding/billing/appeal write tool → publish fails `RCM_AUTONOMOUS_BILLING_FORBIDDEN`.
- **AC-8** Coding audit bundle for a claim range exports signed archive in ≤ 5 min with every code + chart-evidence citation.
- **AC-9** Presidio + HIPAA masking verified — no unmasked MRN/DOB/name in any hosted-LLM prompt log.
- **AC-10** **Pack installs cleanly on unmodified Core BRDs 01–23** (falsifiability test per `DATACERN_CORE_CAPABILITIES.md` §6 Test 1).

## 10. Out of scope / future

Ambient in-visit clinical documentation (crowded — evaluate separately); DME/HME billing; dental billing; non-US billing; ACO shared-savings computation (future pack); credentialing workflow; contracting negotiation (payer contract negotiation is a distinct product).
