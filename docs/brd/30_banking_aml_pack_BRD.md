# BRD 30 — `banking-aml` capability pack

**Deliverable type:** Capability Pack (BRD 23) · **Publisher:** Windrose · **Initial version:** 1.0.0
**Horizon:** 2 (**first non-healthcare pack**) — ships after the 5-pack healthcare sweep has 2+ production references per pack.
**Inherits:** `00_MASTER_BRD.md`, `23_pack_service_BRD.md`. Reference pattern: BRD 24.
**Strategic role:** **cross-industry Core-neutrality proof.** This pack ships against a completely different regulatory family (BSA + OFAC + FinCEN + GLBA) than the healthcare packs (HIPAA + CMS). If it installs cleanly on unmodified Core BRDs 01–23, the pack thesis holds across industries — Test #4 from `WINDROSE_CORE_CAPABILITIES.md` §6, at maximum-difficulty setting.

---

## 1. Overview

**Purpose.** US banking **Anti-Money Laundering (AML)** and **BSA/OFAC compliance** workflow AI. Alert triage, sanctions match adjudication, SAR narrative drafting, CDD/EDD (Customer Due Diligence / Enhanced Due Diligence), adverse media screening, peer-group anomaly detection, regulatory reporting assistance. Sells to US commercial banks (national + regional + community), fintechs/neobanks, credit unions, broker-dealers, money service businesses, and BSA-covered crypto exchanges. Sits ABOVE their existing NICE Actimize / SAS AML / Oracle FSA / Fiserv AML / Napier / Feedzai transaction-monitoring platform — reads alerts + customer + transaction data, writes proposal-mode dispositions + SAR narratives + case notes.

**Why this vertical (Horizon 2 non-healthcare pack #1).** AML is a $50B+ annual global compliance spend with ~$60Bn/year in AML fines since 2008 (BSA/AML enforcement actions from FinCEN, OCC, Fed, FDIC). False-positive rates on legacy transaction monitoring average 95%+ (a 20-alert investigator queue where 1 is real). AI-native alert triage + SAR narrative generation directly addresses banks' #1 compliance-labor cost. Governance-first architecture directly addresses banks' #1 regulator concern (defensibility of AI-assisted BSA decisions in a MRA/MRIA cycle).

**Business value.** (a) **False-positive reduction** — 30–70% investigator time savings on the alert queue; (b) **SAR quality lift** — regulator-defensible narratives with cited transaction evidence; (c) **Enforcement risk reduction** — MRA/MRIA remediation cycles shortened; (d) **Cost per alert** — declines every quarter as the customer's own distillation flywheel spins up on their own alert dispositions.

**In scope.** Alert triage, sanctions match adjudication (OFAC + EU + UN + HMT + others), SAR + CTR filing narrative drafting, CDD/EDD, adverse media continuous screening, peer-group + typology detection, regulatory reporting artifact assembly, KPI dashboards for BSA officer + investigator + regulator submission.

**Out of scope.** Real-time transaction fraud (distinct from AML; typically owned by a Fraud team on a different platform — future pack `banking-fraud`); credit risk / lending decisions (separate); market abuse / MAR-analog (separate future pack for capital markets); anti-bribery-corruption case management (future pack); non-US regulatory regimes as primary buyer (FCA/PRA UK, BaFin, MAS, HKMA, AUSTRAC — evaluated case-by-case; pack extensions later).

## 2. Actors & user stories

**Personas:** AML L1 Analyst (L1), AML L2 Investigator (L2), AML L3 Senior Investigator (L3), BSA Officer (BSAO — legally accountable per BSA), MLRO (Money Laundering Reporting Officer, non-US-analog title), OFAC Compliance Officer (OFAC-CO), CDD/KYC Analyst (KYC), Financial Crimes Compliance VP (FCC-VP), Chief Compliance Officer (CCO), Legal Counsel (LEG), Data Steward (DS), Tenant Admin (TA), Regulator Liaison (REG-L).

- **US-1** As an L1, my daily queue is ranked by (fraud-risk score × dollar impact × age) — not FIFO. The Alert Triage Copilot has pre-drafted a disposition (dismiss with reason / escalate to L2) for each alert with cited transaction patterns and customer context.
- **US-2** As an L1 opening a dismissed alert, I see plain-language reasons — "structuring pattern matches customer's declared business type (POS retail); no unusual counterparties; disposition = false positive." I approve or override; my override feeds the label store.
- **US-3** As an L2 escalated from L1, I see the deeper case-building: peer-group comparison, adverse media hits, related-party network graph, prior SAR history on entity/counterparties.
- **US-4** As an L3/BSAO drafting a SAR, the SAR Narrative Drafter proposes a FinCEN-compliant narrative citing specific transactions, dates, amounts, patterns, and typology (structuring, layering, wire-transfer manipulation, etc.). I edit and sign; the pack files via FinCEN BSA e-filing.
- **US-5** As an OFAC-CO with 200 daily name-match hits against the SDN + EU + UN + HMT lists, the Sanctions Match Adjudicator proposes true-hit vs false-positive with match score, distinguishing evidence, and OFAC 50% Rule inference.
- **US-6** As a KYC Analyst at customer onboarding, the CDD/EDD Copilot pulls beneficial ownership + adverse media + PEP status + jurisdictional risk + product risk and proposes a customer risk rating + EDD recommendation if high-risk.
- **US-7** As an FCC-VP, my Compliance KPI dashboard shows alert TP rate, SAR conversion rate, TTR p95, investigator productivity, FP-reduction trend — with regulator-submission-ready views.
- **US-8** As a CCO exporting for an OCC exam, the pack ships a signed exam-preparation bundle — every AI-touched disposition with model version, rationale, and reviewer identity per the FFIEC BSA/AML Examination Manual expectations.
- **US-9** As LEG when a case escalates toward criminal referral, the Prosecution-Referral Assistant assembles the FinCEN + DOJ preferred-format packet with chain-of-custody preserved.
- **US-10** As a REG-L responding to a MRA/MRIA remediation, I show the regulator specific evidence of AI-assisted-decision governance chain — cited transactions + reviewer approval + model version + audit trail.
- **US-11** As a TA when OFAC publishes an SDN update, the Sanctions Match feed refreshes ≤ 5 min; new hits appear in the queue.
- **US-12** As a DS, I approve the new semantic-model measures (`sar_conversion_rate`, `alert_ttr_p95`, `fp_reduction_pct`) before they enter the governed catalog.

## 3. Functional requirements

### 3.1 Pack manifest (AML-FR-001)

Standard pack.yaml v1 per BRD 23. Categories: `banking, aml, bsa, ofac, sanctions, kyc, fintech, credit-union`. Regulatory: `bsa, fincen, ofac, patriot_act, reg_cdd, cip, glba, nydfs_504, ffiec_bsa_aml, sar_confidentiality`. Clouds: aws, azure, gcp.

**Dependency (from v1.1.0 onward):** `depends_on: [{pack: investigation-framework, version: "^1.0.0"}]`. Pack shrinks ~25% at v1.1.0: Alert Triage Copilot's network-expansion + evidence-gathering phases use framework tools; chain-of-custody + two-signature guardrails delegated to framework. This pack retains ONLY the AML-typology-specific + connector + BSA/OFAC/FinCEN-specific content (including tipping-off-STRONG which layers criminal-offense-teeth on top of framework's `tipping_off_lite`).

### 3.2 Ontology (AML-FR-010)

- `Customer` (retail or business, with CIP verification, jurisdiction, product mix, risk rating)
- `BeneficialOwner` (per Reg CDD — 25%+ ownership + control person)
- `Account` (deposit, loan, brokerage, custodial)
- `Transaction` (deposit, withdrawal, wire, ACH, card, check, cash, ATM)
- `Wire` / `SWIFTMessage` (MT103, MT202, MT200 etc. with structured fields)
- `Alert` (rule-generated or model-generated; typology, severity, generating scenario)
- `Case` (investigation case — 30d/60d/90d cycle common)
- `SAR` (Suspicious Activity Report — filed via FinCEN e-filing; NEVER disclosed to customer per SAR confidentiality)
- `CTR` (Currency Transaction Report — cash > $10K, aggregate over 24h)
- `SanctionsList` (OFAC SDN, EU consolidated, UN, HMT, DFAT, Section 314(a), state-specific)
- `SanctionsMatch` (name/entity match candidate with score + evidence)
- `WatchlistEntity` (PEP, adverse media subject, high-risk jurisdiction party)
- `AdverseMediaEvent` (news/regulatory action mention of customer or related party)
- `RiskRating` (customer risk rating: low/medium/high; drivers; effective date)
- `TypologyPattern` (structuring, layering, integration, trade-based ML, funnel account, cuckoo smurfing, etc.)
- `RegulatoryFiling` (SAR, CTR, 314(a) response, other)

PII/BSI fields tagged (SSN, TIN, DOB, account number, wire beneficiary details) — ai-gateway PHI-analog redaction applies at hosted-provider boundary. Self-hosted SLM tier default (BRD 12 §AIG-FR-084).

### 3.3 Semantic model — AML KPI catalog (AML-FR-020)

| Measure | Definition |
|---|---|
| `alert_true_positive_rate` | count(alerts → SAR filed) / count(alerts closed) — 90d rolling |
| `alert_false_positive_rate` | count(alerts closed as FP) / count(alerts closed) — 90d |
| `sar_conversion_rate` | SARs filed / alerts investigated — 90d |
| `alert_ttr_p95` | 95th percentile time-to-close from alert generation |
| `investigator_productivity` | alerts closed per FTE per day |
| `sar_quality_score` | regulator-feedback-adjusted quality index (if feedback available) |
| `cost_per_alert` | joins `usage_decisions` (BRD 17) filtered by alert case URN |
| `cost_per_sar` | analogously |
| `fp_reduction_pct` | rolling FP rate vs pre-pack baseline |
| `sanctions_match_adjudication_time_p95` | for name-match hits |
| `cdd_completion_time_p50` | median for onboarding CDD or refresh EDD |
| `edd_high_risk_ratio` | customers on active EDD monitoring / total high-risk |
| `adverse_media_hit_rate` | per customer / per counterparty per month |
| `sar_filed_by_typology` | grouped by typology (structuring, layering, TBML, etc.) |
| `regulatory_finding_open_count` | MRA/MRIA/consent-order items open by regulator |

### 3.4 Agents (AML-FR-030..090) — 7 proposal-mode

1. **Alert Triage Copilot (AML-FR-030)** — LangGraph `intake_alert → pull_customer_context → transaction_pattern_analysis → typology_classification → peer_comparison → similar_alerts_rag → decision_recommendation → propose`. Tools: `alert.get`, `customer.get`, `transaction.history`, `peer_group.compare`, `typology.classify`, `similar_alerts.search` (workspace-scoped RAG), `alert.propose_disposition`. Deterministic-first pre-router (BRD 12 §AIG-FR-080) checks rules + prior dispositions before LLM. Confidence-calibrated for one-click FP dismissal; escalates borderline to L2 with drafted case notes.

2. **Sanctions Match Adjudicator (AML-FR-040)** — for each name-match hit, evaluates: name-match score (fuzzy match, phonetic, translit), distinguishing evidence (DOB, address, country, ID number), OFAC 50% Rule inference (ownership chain), Section 313 correspondent-banking rules if applicable. Proposes true-hit or false-positive with cited evidence. Tools: `sanctions_list.get_entry`, `customer.get`, `beneficial_owner.chain`, `ownership_50pct.evaluate`, `match.propose_verdict`.

3. **SAR Narrative Drafter (AML-FR-050)** — for confirmed suspicious activity, drafts a FinCEN-compliant SAR narrative (5W: Who, What, When, Where, Why + How) grounded in specific transactions + typology + customer context. Sections: Subject Info, Suspicious Activity, Amounts, Dates, Typology, Law Enforcement Contact. Compliance-officer edits + signs; pack files via BSA e-filing.

4. **CTR Aggregator (AML-FR-060)** — non-LLM: aggregates cash transactions per customer per 24h; auto-detects > $10K aggregate; drafts CTR with beneficial ownership if business account; queues for review + filing. Pure rules; agent-runtime just orchestrates.

5. **CDD/EDD Copilot (AML-FR-070)** — at customer onboarding + periodic refresh: pulls beneficial ownership + adverse media + PEP status + jurisdictional risk + product risk. Proposes customer risk rating with drivers. For high-risk, drafts EDD recommendations (enhanced monitoring cadence, additional documentation asks, senior officer sign-off). Tools: `beneficial_owner.chain`, `pep.check`, `adverse_media.search`, `jurisdiction_risk.get`, `risk_rating.propose`.

6. **Adverse Media Screener (AML-FR-080)** — continuous background job. For each customer + beneficial owner + counterparty, monitors adverse media feeds (Refinitiv, Dow Jones, LexisNexis) for negative news matching typology-relevant categories (financial crime, fraud, sanctions, ML, terrorism). Materializes hits as `adverse_media_review` cases for KYC analyst.

7. **Peer-Group Anomaly Detector (AML-FR-090)** — statistical + ML model. Per customer, compares transaction pattern to declared business type (SIC code) + geographic peer group. Flags outliers (e.g., a florist with weekly $50K international wires) for L2 case build. Deterministic-first math; LLM only for narrative-generation step.

All agents proposal-mode. Attempting `mode: autonomous` on any SAR-filing / CTR-filing / customer-off-boarding / OFAC-action write tool → publish fails with `AML_AUTONOMOUS_FILING_FORBIDDEN`.

### 3.5 Connectors (AML-FR-100)

**Read (14):**
- Core banking: FIS Profile, Fiserv DNA + Signature, Jack Henry SilverLake + CIF 20/20, Temenos T24, Finastra Fusion, TCS BaNCS.
- Transaction monitoring platforms: NICE Actimize, SAS AML, Oracle Financial Services Analytics, Fiserv AML Risk Manager, Napier, Feedzai, Featurespace (Visa), ComplyAdvantage, Unit21.
- Sanctions data: OFAC SDN + Consolidated (Treasury), EU consolidated, UN, HMT, DFAT, Section 314(a); via Dow Jones RiskCenter, Refinitiv World-Check, LexisNexis Bridger, Accuity, Moody's Analytics KYC.
- Adverse media: Refinitiv, DJ Risk & Compliance, LexisNexis Nexis Diligence.
- Beneficial ownership: Bureau van Dijk Orbis, Sayari, TransUnion TruAudience, Moody's Analytics KYC.
- KYC / identity: Alloy, Persona, Trulioo, Socure, Onfido, Jumio, Prove.
- Payments: SWIFT (MT + MX), Fedwire, CHIPS, ACH (Nacha), card networks.
- 314(a) list feed from FinCEN.

**Write adapters (7, proposal-mode):**
- Case status write to core AML platform (Actimize / SAS / Oracle / Fiserv).
- SAR filing to FinCEN BSA e-filing system (FinCEN E-Filing Batch or direct XML).
- CTR filing to FinCEN e-filing.
- Customer risk-rating update to core banking system.
- OFAC blocked-property freeze action (proposal → OFAC-CO approval → core banking freeze).
- Adverse media hit acknowledgment to KYC platform.
- Regulatory-finding remediation status update to GRC platform (MetricStream, SAI360, RSA Archer).

### 3.6 Regulatory guardrails (AML-FR-110)

- **BSA / FinCEN SAR filing standards** — 30-day filing deadline from initial detection (60d if no subject); mandatory continuation SARs every 90d for ongoing activity.
- **CTR filing** — $10K cash threshold; aggregate over 24h across accounts + branches; 15-day filing deadline.
- **OFAC 50% Rule** — blocked-property inference for entities 50%+ owned by SDN parties; multi-tier ownership chains resolved.
- **Reg CDD** (31 CFR 1010.230) — beneficial ownership at 25%+ + control person; ongoing monitoring.
- **CIP** (Customer Identification Program) — CIP required for all new accounts; identity verification.
- **Tipping-off prohibition** — SAR filing NEVER disclosed to customer or counterparty; audit-service redacts SAR references from any customer-visible surface (hard gate).
- **SAR confidentiality (31 USC 5318(g)(2)(A)(i))** — SAR filing existence is confidential; disclosure = criminal offense. Pack enforces zero-leak: no SAR indicator ever surfaces to a customer-facing UI or in a downstream write that could reach the customer.
- **Recordkeeping** — 5-year retention for BSA records; SAR + supporting documentation preserved.
- **FFIEC BSA/AML Examination Manual** — exam-preparation bundle format matches FFIEC expectations.
- **NYDFS Part 504** — transaction monitoring + sanctions filtering system certification; annual senior-officer attestation.
- **FinCEN AML/CFT National Priorities (2021+)** — corruption, cybercrime, terrorism financing, fraud, TBML, drug trafficking, human trafficking, PF (proliferation financing).
- **Cross-tenant learning forbidden** — competitive-sensitivity + regulator-sensitivity; workspace-scoped only.
- **Model risk (SR 11-7 for banks under Fed supervision)** — model-inventory, validation, monitoring, retirement documentation preserved for every deployed agent version.

### 3.7 Roles & case schemas (AML-FR-120)

Roles: `aml_l1_analyst`, `aml_l2_investigator`, `aml_l3_senior`, `bsa_officer`, `mlro`, `ofac_compliance_officer`, `kyc_analyst`, `fcc_vp`, `compliance_officer`, `legal_counsel`, `regulator_liaison`, `data_steward`, `aml_model_risk_officer`.

Case schemas: `alert_triage` · `sanctions_match_adjudication` · `sar_case` (long-lived, 30–90d cycles) · `ctr_review` · `cdd_edd_review` · `adverse_media_review` · `peer_anomaly_investigation` · `regulatory_finding_remediation`.

## 4. Domain model & data

Materialization per BRD 23 §PKG-FR-030: 3 semantic models (`aml_core`, `sanctions_core`, `cdd_core`) · 7 dashboards (Alert Ops, SAR Pipeline, Sanctions Ops, CDD/KYC, Adverse Media, Model Risk, Regulator Prep) · 8 case schemas · 13 role seeds · 5 golden eval sets (alert triage, sanctions adjudication, SAR narrative, CDD risk rating, peer anomaly) · 12 guardrail policies · 4 pipeline templates (nightly peer-anomaly scan, hourly adverse-media scan, weekly typology-model refresh, quarterly distill alert triage) · 2 model archetypes (`alert_disposition_confidence`, `customer_risk_rating_v1`) · 7 agent recipes · 14 connector templates · pack display_labels.

### Display labels (selected)

```yaml
locale: en
keys:
  case.singular:                        "Case"
  alert_triage.singular:                "Alert"
  alert_triage.plural:                  "Alerts"
  alert_triage.action.dismiss:          "Dismiss as false positive"
  alert_triage.action.escalate:         "Escalate to L2"
  sanctions_match_adjudication.singular: "Sanctions hit"
  sanctions_match_adjudication.action.true_hit: "Confirm true hit"
  sar_case.singular:                    "SAR case"
  sar_case.action.file:                 "File SAR with FinCEN"
  cdd_edd_review.singular:              "CDD review"
  adverse_media_review.singular:        "Adverse media hit"
  peer_anomaly_investigation.singular:  "Peer anomaly"
  regulatory_finding_remediation.singular: "Regulator finding"
  agent.alert_triage.name:              "Alert Triage Copilot"
  agent.sanctions_adjudicator.name:     "Sanctions Adjudicator"
  agent.sar_drafter.name:               "SAR Narrative Drafter"
  agent.cdd_edd.name:                   "CDD/EDD Copilot"
  agent.adverse_media_screener.name:    "Adverse Media Screener"
  agent.peer_anomaly.name:              "Peer Anomaly Detector"
entity_templates:
  customer:  "Customer {customer_id_last4}"
  account:   "Account {account_id_last4}"
  entity:    "{name}"
```

## 5. Events

Emitted via installed components (no new topics): `case.created / case.resolved` per case type; `ai.token_usage.v1` per agent call with `decision_urn = case.urn`; `pack.install_completed`.

Consumed: `dataset.schema_changed` on connector-owned datasets → surface broken references in `pack_installs.health`. Consumed adverse-media event streams from external vendors (via ingestion-service connectors) — proposal cases materialize.

## 6. Business rules & edge cases (AML-BR-*)

- **BR-1** No autonomous SAR filing. No autonomous CTR filing. No autonomous customer off-boarding. No autonomous OFAC freeze action. Every write is proposal-mode with human approval. Attempted `mode: autonomous` → publish fails `AML_AUTONOMOUS_FILING_FORBIDDEN`. Cross-checks BR-2 tipping-off + BR-4 audit chain.
- **BR-2** **Tipping-off is a hard, permanent guardrail.** No SAR filing existence, SAR-in-progress indicator, or SAR reference field EVER surfaces to a customer-facing UI, customer letter, downstream write to a system the customer or counterparty accesses, or any external adapter that isn't SAR-authorized. Every write path checks the tipping-off guardrail before emit. Violation is a criminal offense per 31 USC 5318(g)(2)(A)(i).
- **BR-3** SAR confidentiality extends to related-party workflows: if Customer B is a counterparty in a SAR filed on Customer A, the fact of the SAR is not disclosed to Customer B; adverse-media surfaces on B do NOT mention the A-SAR link.
- **BR-4** Every AI-assisted alert disposition + SAR narrative + risk rating retained per BSA 5-year recordkeeping + FFIEC exam-manual expectations. Signed provenance chain: data version → model version → prompt hash → tool trace → reviewer identity → timestamp. RAC/SR-11-7-analog defensibility.
- **BR-5** Cross-tenant learning is FORBIDDEN — banks compete + share regulator supervision context. Workspace-scoped only. Same stricter isolation as BRD 27 (payer FWA).
- **BR-6** Sanctions screening uses whitelisted OFAC + EU + UN + HMT lists refreshed ≤ 5 min after publisher update; expiry / removal events handled — a customer previously matched who is removed from list surfaces as `sanctions_match_review_removal` case for reviewer confirmation of unblock.
- **BR-7** OFAC 50% Rule inference resolves ownership chains up to 5 hops depth; deeper chains flagged for L3 manual review (regulator expectation for defensibility).
- **BR-8** SR 11-7 model risk applies to Fed-supervised bank tenants: every deployed agent version has model-inventory documentation, validation report, ongoing-monitoring config, and defined retirement criteria. Pack ships the model-risk template; MRM team completes.
- **BR-9** NYDFS Part 504 annual senior-officer attestation ships as an assisted-drafting flow — BSAO signs; audit chain preserved for regulator review.
- **BR-10** FinCEN AML/CFT National Priorities update annually; pack ships priorities as configurable typology weights (typologies aligned to Priorities upweighted in alert-triage scoring). Update via pack point release.
- **BR-11** Currency transaction aggregation crosses account + branch + related-parties per Reg 1010.313; pure rules; agent orchestrates lookup + proposal.
- **BR-12** International wires (MT103) with intermediary institutions in high-risk jurisdictions auto-flag per FATF greylist/blacklist current version; agent enriches with typology context.
- **BR-13** Cash-intensive business customers (SIC codes: convenience stores, restaurants, car washes) get relaxed structuring thresholds; agent references SIC-code + declared-business-type baselines.
- **BR-14** Prosecution referral (rare but material) requires L3 + BSAO + LEG three-signature approval; pack refuses single- or two-actor referral.
- **BR-15** Regulator MRA/MRIA remediation cycle: each open finding maps to a `regulatory_finding_remediation` case with milestone dates; pack blocks new dispositions using AI models on the specific decision-type under regulator scrutiny until remediation approved.

## 7. Dependencies

- **Windrose services:** all Core BRDs 01–23 + BRD 17 usage-service + BRD 16 eval-service (with model-risk gating: SR 11-7 aware) + BRD 15 memory-service.
- **External systems (customer's):** core banking + AML platform (§3.5); sanctions data providers (customer's subscription); adverse media (customer's subscription); FinCEN BSA e-filing (customer's BSA-E user credential); OFAC feed direct from Treasury.
- **Regulatory:** Windrose ships FFIEC BSA/AML Examination Manual crosswalk + SR 11-7 model-risk-management templates + NYDFS Part 504 attestation template.
- **Compliance:** SOC 2 Type II + HITRUST (inherited from Core) + optional FFIEC Cybersecurity Assessment Tool crosswalk for bank tenants + SR 11-7 model-risk documentation package.

## 8. NFRs (deltas from master)

| Metric | Target |
|---|---|
| Alert Triage Copilot p95 per alert | ≤ 5s |
| Sanctions Match Adjudicator p95 per hit | ≤ 3s |
| SAR Narrative Drafter p95 per SAR | ≤ 3 min |
| CDD/EDD Copilot p95 per customer | ≤ 30s |
| Adverse Media scan p95 per customer per day | ≤ 1s (indexed) |
| Peer Anomaly nightly scan per 10M customer-days | ≤ 6h |
| Alert FP reduction vs baseline (month 6) | ≥ 30% conservative; 50% target |
| SAR filing deadline compliance | ≥ 99.5% within 30d (60d no-subject) |
| Sanctions list refresh latency (OFAC publish → hits appear) | ≤ 5 min |
| Tipping-off zero-leak | 0 incidents (release gate — every release audited via prompt-log sample + write-path automated scan) |
| Cost per alert (post-distillation, month 12) | ≤ $0.10 (est.) |
| Cost per SAR (post-distillation, month 12) | ≤ $5 |
| PHI/PII/BSI leak | 0 |

## 9. Acceptance criteria

- **AC-1** Fresh install of `banking-aml@1.0.0` materializes all components; 7 agents in `mode: shadow`; `pack.install_completed` fires with `materialized_count=45+`.
- **AC-2** Alert Triage Copilot on a batch of 10K real-shaped alerts in shadow mode achieves ≥ 85% agreement with human historical dispositions on the customer's golden eval set within 30 days.
- **AC-3** Sanctions Match Adjudicator on a name-match hit "John Smith" against SDN "John A. Smith" cites DOB mismatch + address mismatch → proposes false-positive with rationale; OFAC-CO one-click confirms.
- **AC-4** SAR Narrative Drafter on a confirmed structuring case produces a FinCEN-compliant SAR narrative with the 5W structure + specific transaction citations; BSAO reviews, edits, signs; pack files via FinCEN e-filing; filing confirmation stored.
- **AC-5** Tipping-off zero-leak test: automated scan across all write adapters + UI surfaces confirms no SAR reference field is ever emitted to a customer-visible surface, customer letter, or non-SAR-authorized write; violation blocks release (release gate).
- **AC-6** OFAC 50% Rule: given a customer 60%-owned by a customer 55%-owned by an SDN party (2-hop chain), the Sanctions Match Adjudicator flags blocked-property inference with the chain evidence.
- **AC-7** CDD/EDD Copilot on a new business customer with SIC = "money service business" + jurisdiction = high-risk + PEP-affiliated beneficial owner → proposes risk rating = high + EDD recommendations (enhanced monitoring + quarterly refresh + senior-officer sign-off).
- **AC-8** Adverse Media Screener: within 60 min of an adverse news event mentioning an existing customer, an `adverse_media_review` case appears in the KYC analyst's queue.
- **AC-9** Peer Anomaly Detector on nightly scan of 10M customer-days identifies a florist with weekly $50K international wires → materializes `peer_anomaly_investigation` case with peer-group evidence.
- **AC-10** Pack version attempting `mode: autonomous` on any SAR/CTR/customer-off-boarding/OFAC-action write → publish fails `AML_AUTONOMOUS_FILING_FORBIDDEN`.
- **AC-11** Pack version attempting to remove the tipping-off guardrail policy → publish fails.
- **AC-12** Presidio + BSI custom detectors + prompt-log audit sample: no unmasked SSN/TIN/full account number in any hosted-LLM prompt log; self-hosted SLM tier is preferred by default for BSI-sensitive workloads.
- **AC-13** FinCEN e-filing test-batch submission end-to-end (against FinCEN sandbox) succeeds; test SAR + test CTR both accepted; production credentials gated behind customer BSA-E enrollment.
- **AC-14** Regulator prep bundle export for an OCC/FDIC/Fed exam period returns signed archive in ≤ 5 min with every AI-touched disposition + model version + reviewer identity + FFIEC-manual crosswalk.
- **AC-15** **Pack installs cleanly on unmodified Core BRDs 01–23** — **cross-industry Core-neutrality proof** (Test #4 from `WINDROSE_CORE_CAPABILITIES.md` §6 at maximum-difficulty setting: different regulatory family — BSA + OFAC + FinCEN + GLBA vs healthcare's HIPAA + CMS). If this pack requires ANY Core change, the platform thesis fails.

## 10. Out of scope / future

- Real-time transaction fraud (`banking-fraud` future pack — distinct team + platform typically).
- Credit risk / lending decisions (BRD 32+ future).
- Market abuse / MAR-analog for capital markets (`capital-markets-mar` future).
- Anti-bribery-corruption case management (`abac` future pack).
- Trade surveillance (equity/FICC — distinct workflow).
- Non-US regulatory regimes as PRIMARY buyer (UK FCA/PRA, EU AMLD6, Singapore MAS, Hong Kong HKMA, Australia AUSTRAC) — supported as configuration/extensions later; primary buyer stays US to preserve BSA-first narrative.
- Crypto-native AML (Chainalysis / Elliptic / TRM Labs / Merkle Science own this; evaluate `banking-aml-crypto-native` as extension pack).
- Retail bank consumer-facing member-services chatbot (permanently out — B2B strategy per WINDROSE_STRATEGY.md §5).

## Appendix — canonical NL questions (verified queries in semantic-service)

Seeded with the pack:

1. "What's our alert true-positive rate this quarter, grouped by rule / typology?"
2. "Which sanctions match false-positive types are most common — can we tune?"
3. "SAR pipeline: how many drafts pending review by BSAO past 20 days?"
4. "Adverse media hits this week on customers rated medium-risk or higher."
5. "Peer anomaly hits by SIC code group — where is our detector most sensitive?"
6. "Investigator productivity by tier — top and bottom deciles."
7. "Cost per SAR filed this quarter vs 6 months ago (distillation flywheel check)."
8. "Which regulatory findings have milestones due in the next 30 days?"
9. "Customers upgraded from medium to high risk in the last 90 days and drivers."
10. "OFAC 50% Rule 2-hop-or-deeper blocked-property inferences this month."

(Full 20 in `semantic/aml_core.verified_queries.yaml`.)
