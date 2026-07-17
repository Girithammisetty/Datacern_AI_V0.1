# BRD 27 — `payer-fwa-siu` capability pack

**Deliverable type:** Capability Pack (BRD 23) · **Publisher:** Windrose · **Initial version:** 1.0.0
**Horizon:** 2 pack #3 (after `insurance-claims-payer` and `care-management-medicare` have 2+ production references each).
**Inherits:** `00_MASTER_BRD.md`, `23_pack_service_BRD.md`. Reference pattern: BRD 24.

---

## 1. Overview

**Purpose.** Payer-side **Fraud, Waste & Abuse (FWA)** and **Special Investigations Unit (SIU)** workflow. Score post-adjudicated claims for FWA risk, build investigation cases with evidence, refer to law enforcement / OIG / state DOI where indicated, quantify recovered value. Sells to health-plan SIU directors, payment-integrity VPs, chief investigations officers.

**Why this vertical (Horizon 2 pack #3).** FWA is a $60B+ annual leakage in US healthcare (NHCAA + GAO estimates). Every payer has an SIU. Current tooling is fragmented (Cotiviti + Zelis retrospective + manual investigator work). AI-native governance-chain-first is a real gap. Complements BRD 24 (pre-payment PA/appeal) with post-payment recovery.

**Business value.** Recovery $ (SIU-driven claim recovery), fine avoidance (defensible investigations reduce regulator scrutiny), investigator productivity 2–3×, evidentiary chain-of-custody for prosecution.

**In scope.** Post-adjudicated claim FWA scoring, provider-outlier detection, member-outlier detection, SIU case builder, evidence gatherer, OIG/LEIE exclusion checks, prosecution-referral packet drafter, KPI dashboards for SIU ops.

**Out of scope.** Pre-payment fraud prediction at PA time (that's BRD 24 territory); prescription drug FWA (that's BRD 28 pharmacy pack); provider credentialing FWA (separate); member enrollment fraud (identity-vertical, not this pack).

## 2. Actors & user stories

**Personas:** SIU Investigator (SIU-I), SIU Supervisor (SIU-S), Senior Investigator (SR-I), SIU Director (SIU-D), VP Payment Integrity (VP-PI), Chief Compliance Officer (CCO), Legal Counsel (LEG), Data Steward (DS), Tenant Admin (TA).

- **US-1** As an SIU-I, my daily queue shows the highest-scoring FWA candidates ranked by (fraud probability × dollar impact × recoverability).
- **US-2** As an SIU-I, when I open a candidate, the FWA Scorer has attached the risk factors (billing pattern outliers, prior sanctions, member complaints, provider peer-group comparison) with citations.
- **US-3** As an SR-I, when I formally open an investigation, the SIU Case Builder assembles the evidence packet: claim history, provider peer comparisons, LEIE/OIG exclusion status, NPDB lookup, prior related cases.
- **US-4** As an SIU-D, I see the pipeline KPIs (referrals, active investigations, recovered $, avg cycle time) and quality indicators (case-completion rate, prosecution-referral acceptance rate).
- **US-5** As LEG when a case is prosecution-referral-ready, I get the Prosecution-Referral Packet Drafter's output — with citations, evidentiary chain, and a defensible narrative in the DOJ-preferred format.
- **US-6** As VP-PI at quarter-end, I export a defensible SIU report for the board covering recovered $, avoided-loss $, case throughput, and quality metrics.
- **US-7** As a CCO, HHS-OIG asks for evidence on a matter — one-click export bundle with chain-of-custody proofs.
- **US-8** As a TA, when NCPDP publishes new FWA typology (e.g., new upcoding scheme), pack update lands the new scoring rules.

## 3. Functional requirements

### 3.1 Pack manifest (FWA-FR-001)

Standard v1. Categories: `insurance, payer, fwa, siu, payment-integrity`. Regulatory: `hipaa, hitrust, false_claims_act, glba, doj_referral_std, state_doi_reporting, chain_of_custody`. Clouds: all.

**Dependency (from v1.1.0 onward):** `depends_on: [{pack: investigation-framework, version: "^1.0.0"}]`. Pack shrinks ~30% at v1.1.0: `SIU Case Builder` + `Evidence Gatherer` agents move to framework; chain-of-custody + two-signature guardrails delegated to framework; FWA Scorer's risk-scoring stage uses framework's `risk_scorer.abstract` with FWA-model reference. This pack retains ONLY the FWA-typology-specific + connector + FCA/DOJ-referral-specific content.

### 3.2 Ontology (FWA-FR-010)

`Provider` (with NPI, TIN, credentials, sanctions history), `Member`, `Claim`, `Diagnosis`, `Service` (CPT/HCPCS), `SIUCase`, `Evidence` (claim excerpt, provider peer comparison, external record), `Sanction` (LEIE, OIG, state exclusion), `NPDBRecord`, `MemberComplaint`, `PriorCase` (prior related SIU work), `LawEnforcementReferral`, `Recovery` ($, method, date).

### 3.3 Semantic model — SIU KPI catalog (FWA-FR-020)

| Measure | Definition |
|---|---|
| `fwa_recovery_$` | sum recovered via SIU work over period |
| `avoided_loss_$` | claims blocked from payment via SIU-driven policy changes |
| `referral_rate` | SIU-referred cases per 1M claims |
| `case_conversion_rate` | opened investigations → recovery outcome |
| `avg_case_cycle_days` | intake → closure days |
| `prosecution_referral_acceptance_rate` | DOJ/AG-accepted referrals / total referred |
| `provider_outlier_scan_yield` | true-positive rate of nightly outlier scans |
| `siu_labor_cost_per_case` | investigator hours × loaded cost / cases closed |

### 3.4 Agents (FWA-FR-030..070) — 5 proposal-mode

1. **FWA Scorer (FWA-FR-030)** — nightly batch. Scores all newly adjudicated claims via ensemble: rules (unbundling, upcoding CPT patterns, place-of-service mismatches, phantom billing), statistical outliers vs provider peer group, ML model (Random Forest / XGBoost on labeled prior cases). Deterministic-first (rules) → SLM refinement. Output: `claim.fwa_score` (0–1) + reason codes.

2. **Provider Outlier Detector (FWA-FR-040)** — per-provider aggregation over rolling windows. Flags providers deviating > 2σ from peer group on billing patterns (units per visit, high-code-mix, unusual diagnosis combinations). Peer group defined by specialty + geography + practice size.

3. **SIU Case Builder (FWA-FR-050)** — when an investigator opens a case: assembles evidence packet automatically — claim history, provider peer comparison, LEIE/OIG lookup, NPDB query, member complaints, prior related SIU cases. Structured output ready for investigator review.

4. **Evidence Gatherer (FWA-FR-060)** — during active investigation: on-demand pulls of specific claim details, provider chart requests (via provider portal integration), member statements, external data (state DOI records, court records where public).

5. **Prosecution-Referral Packet Drafter (FWA-FR-070)** — when a case is ready for DOJ/AG/OIG referral, drafts the packet in the preferred format (DOJ Civil Division specific), with allegation summary, factual basis, evidence chain-of-custody log, statutes cited (False Claims Act 31 USC 3729, health-care fraud 18 USC 1347), damage quantification. All proposal-mode — LEG reviews and signs.

All agents proposal-mode; write adapters (case status changes, recovery record, referral submission) refuse without signed grant.

### 3.5 Connectors (FWA-FR-080)

**Read (12):** Facets, HealthEdge, QNXT, Amisys (claim history from core admin), EDI 837/835 (raw claims + remittance), NPI Registry (NPPES), LEIE (OIG excluded providers), OIG-CIA (Corporate Integrity Agreements list), state Medicaid exclusion lists, NPDB (National Practitioner Data Bank), SAM.gov (excluded parties), Fraud Prevention Institute (NHCAA) intelligence feeds (subscription), member CRM/complaint system, provider directory + credentialing.

**Write adapters (5, proposal-mode):** Core admin (Facets etc.) case-flag write; Recovery record write; External referral packet delivery (to DOJ e-referral portal / state DOI); Provider sanction flag; Member notification (for pay-back requests).

### 3.6 Regulatory guardrails (FWA-FR-090)

- **HIPAA** — full baseline.
- **False Claims Act** — evidentiary standards; chain-of-custody preservation.
- **DOJ referral standards** — preferred packet format; damage quantification methodology.
- **State DOI reporting** — some states require insurer FWA reports quarterly.
- **Chain-of-custody** — every piece of evidence has cryptographic hash + timestamp + accessed-by log. RAC/prosecution-defensible.
- **Privacy Act** for law-enforcement information; **GLBA** for member PII in referrals.
- **Whistleblower / retaliation** — investigator identity protected; audit-service pseudonymization option.

### 3.7 Roles & case schemas (FWA-FR-100)

Roles: `siu_investigator`, `siu_senior_investigator`, `siu_supervisor`, `siu_director`, `payment_integrity_analyst`, `compliance_officer`, `legal_counsel`, `data_steward`.

Case schemas: `fwa_review` (candidate scoring review) · `siu_investigation` (active investigation, longer-lived) · `prosecution_referral_review` · `recovery_action_case`.

## 4. Domain model & data

Materialization: 2 semantic models · 5 dashboards · 4 case schemas · 8 role seeds · 4 golden eval sets (FWA scoring, outlier detection, packet drafting, evidence completeness) · 7 guardrail policies · 3 pipeline templates (nightly FWA scan, weekly provider outlier scan, quarterly model retrain) · 2 model archetypes (`fwa_ensemble_v1`, `provider_outlier_v1`) · 5 agent recipes · 12 connector templates · pack display_labels.

### Display labels

```yaml
locale: en
keys:
  fwa_review.singular:              "FWA candidate"
  siu_investigation.singular:       "Investigation"
  prosecution_referral_review.singular: "Referral"
  recovery_action_case.singular:    "Recovery"
  agent.fwa_scorer.name:            "FWA Scorer"
  agent.provider_outlier_detector.name: "Outlier Detector"
  agent.siu_case_builder.name:      "Case Builder"
  agent.evidence_gatherer.name:     "Evidence Gatherer"
  agent.referral_drafter.name:      "Referral Drafter"
entity_templates:
  provider: "Provider {npi_last4}"
  member:   "Member {member_id_last4}"
```

## 5. Business rules (FWA-BR-*)

- **BR-1** Every write is proposal-mode; investigator/supervisor/director authority chain enforced. Chain-of-custody guardrail requires two-person sign-off for evidence deletion (audited).
- **BR-2** Evidence hash + timestamp preserved indefinitely (retention rules per state; 10-year default for FCA statute of limitations).
- **BR-3** Prosecution referral requires SR-I + LEG two-signature approval; single-actor referral is refused.
- **BR-4** LEIE/OIG-CIA/SAM.gov data refresh daily; providers newly on exclusion list auto-generate an SIU case for adjudication of pending claims.
- **BR-5** FWA scores exposed to human review only — never used to auto-deny claims (would be pre-payment territory + regulator risk).
- **BR-6** Cross-tenant learning is FORBIDDEN — an FWA pattern learned at Payer A cannot leak into Payer B's model (workspace scope + memory-service isolation). This is stricter than other packs due to competitive sensitivity.
- **BR-7** Investigator identity is pseudonymized in case content shared beyond SIU (whistleblower protection).
- **BR-8** Recovery actions (payback demands to providers) issued only after L1 review + LEG concur; direct member outreach requires D-level approval.

## 6. Dependencies

Windrose Core (all BRDs 01–23) + external subscription feeds (NHCAA, LEIE, NPDB — customer's licenses). MetricStream / SAI360 GRC integration optional. DOJ e-referral portal delivery adapter.

## 7. NFRs (deltas)

| Metric | Target |
|---|---|
| Nightly FWA scoring 1M claims | ≤ 4h |
| FWA candidate ranking p95 | ≤ 500ms (Redis-cached) |
| SIU case-builder assembly p95 | ≤ 30s |
| Prosecution packet draft p95 | ≤ 3 min |
| Chain-of-custody hash verification | ≤ 5s per artifact |
| Recovery $ lift vs baseline (month 12) | ≥ 40% (aggressive but realistic) |
| PHI + prosecution-evidence leak | 0 |

## 8. Acceptance criteria

- **AC-1** Fresh install materializes; 5 agents in shadow mode; badge OK.
- **AC-2** FWA Scorer produces top-100 candidates over a 1M-claim night with plausible ranking; investigator opens top-1 and sees complete reason codes + peer comparison.
- **AC-3** SIU Case Builder on a candidate assembles evidence packet including LEIE hit (provider excluded 2 years ago), 47 similar prior claims, 3 member complaints.
- **AC-4** Evidence hash-chain preserved; deleting evidence requires two-person sign-off; audit event captures both actors.
- **AC-5** Prosecution packet draft cites Civil Division-preferred format; LEG reviews and edits; final packet ships with hash-linked evidence bundle.
- **AC-6** Cross-tenant test: pattern learned in Tenant A does not appear in Tenant B's model — verified via distillation-candidate stream isolation.
- **AC-7** Pack version attempting to remove chain-of-custody guardrail → publish fails.
- **AC-8** Autonomous mode on any recovery write → publish fails `FWA_AUTONOMOUS_RECOVERY_FORBIDDEN`.
- **AC-9** Pack installs cleanly on unmodified Core BRDs 01–23 (falsifiability test).

## 9. Out of scope / future

Pre-payment fraud scoring (BRD 24 owns); Rx FWA (BRD 28 owns); member enrollment fraud; provider credentialing FWA; workers' comp SIU (separate product); state Medicaid MMIS-side FWA (state agency, not payer).
