# BRD 36 — `trucking-claims` capability pack

**Deliverable type:** Capability Pack (BRD 23) · **Publisher:** Windrose · **Initial version:** 1.0.0
**Horizon:** 3 pack wave (post-BRD-32/33). Reference pattern: BRD 24/30/32.
**Status:** v1.0.0 authored, install pending (Core-neutral via packctl; pack-service-tier components declared `deferred` in the manifest).

---

## 1. Overview

**Purpose.** Trucking/logistics claims & safety adjudication AI for motor carriers, freight brokers, and 3PLs: cargo OS&D (over/short/damage) claim handling under the Carmack liability framework with filing-deadline awareness (9-month claim / 2-year suit windows on standard bill-of-lading terms), reefer temperature-excursion evidence workflow, carrier recovery filing, double-brokering / carrier identity-theft vetting, and telematics safety-event review with preventability-and-coaching discipline. Sells to asset carriers (Schneider-class enterprises down to regional fleets), freight brokerages, and 3PLs running mixed asset+brokerage networks.

**Why this vertical.** Cargo claims carry hard contractual clocks (9-month filing, 30-day acknowledgment / 120-day disposition claims-processing practice under 49 CFR Part 370) and every determination is documented, disputable, and evidence-driven — the exact governed human-in-the-loop decision shape of the Windrose Core. Safety-event reviews add litigation-discovery stakes ("nuclear verdict" exposure when telematics alerts are ignored or coaching is inconsistent), and double-brokering fraud is an industry-wide loss surface with a crisp red-flag signature. The alert-adjudication pattern is already proven by BRD 30/32.

**Business value.** Deadline-breach elimination (filing/response clock watch), claims-analyst throughput (triage pre-routing), carrier-recovery lift (Carmack burden-shifting + evidence fit), double-broker fraud loss prevention (mid-load banking-change freeze), consistent litigation-defensible safety files (evidence-first preventability + documented coaching), and exam/discovery-ready decision provenance.

**In scope.** Cargo claim intake triage copilot, filing/response deadline tracking, carrier-recovery workflow, carrier fraud vetting (double-brokering, identity theft, staged loss), telematics safety-event review with coaching closure, claims-and-safety KPI semantic model + dashboards, carrier-lane network analytics, Carmack/FMCSA grounding, shipment-anomaly + claim-outcome pipelines.

**Out of scope.** Real-time dispatch/routing and load-board tendering; freight bill audit & payment; insurance policy administration (the pack adjudicates claims, it is not the insurer's core); driver hiring/qualification files (DQF) management; hours-of-service compliance tooling.

## 2. Actors & user stories

**Personas:** Claims Analyst (CA), Safety Review Specialist (SRS), Carrier Compliance Analyst (CCA), Claims & Safety Manager (CSM), Fleet Compliance Auditor (FCA), Tenant Admin (TA).

- **US-1** As a CA, my queue ranks open claims by deadline runway × dollar × severity (never FIFO); each case shows the shipment evidence, the carrier's history on the lane, and the copilot's proposed disposition with cited row-level evidence.
- **US-2** As a CA on a reefer claim, I see the evidence checklist (unit download, origin pre-cool/pulping, destination pulping) and the Carmack burden-shifting posture — prima facie made vs carrier defense available — before I propose pay, deny, or recovery.
- **US-3** As a CCA, a new-authority carrier changing banking details mid-load lands in my queue as a payment-freeze fraud check with the red-flag evidence assembled (authority age, reference status, FMCSA-registration mismatch).
- **US-4** As an SRS, telematics/camera events arrive with the video evidence linked; a disputed event from a million-mile driver gets the same evidence-first review, and my coaching closures are documented for litigation discovery.
- **US-5** As a CSM, claim payments, denials, recovery filings, and preventability determinations come to me four-eyes: the analyst proposes, I approve; every denial's note must carry findings the claimant can be told and the defense relied upon.
- **US-6** As a CSM, I see claim pay rate, denial rate, recovery rate, fraud-escalation share, coaching closure, deadline runway, carrier risk mix, and on-time share — sliceable by claim kind/type, liability band, lane, mode, carrier tier, and month.
- **US-7** As an FCA, I export an audit bundle showing every AI-assisted disposition with reviewer identity, findings, and timestamps — claim files for Part 370 practice review, safety files for litigation-discovery readiness.
- **US-8** As a TA, the pack lands as tenant-scoped content only — datasets, model, dashboards, roles, agents — with zero Core changes.

## 3. Functional requirements

### 3.1 Pack manifest (TL-FR-001)

Standard v1. Categories: `logistics, trucking, cargo_claims, safety, carrier_fraud`. Regulatory: `carmack_amendment, cfr49_part370, fmcsa_csa, bill_of_lading_terms`. Clouds: all.

### 3.2 Ontology (TL-FR-010) — deferred to pack-service

`Shipper`, `Consignee`, `Carrier`, `Driver`, `Shipment`, `Lane`, `BillOfLading`, `Claim`, `SafetyEvent`, `RecoveryClaim`, `SealRecord`, `TemperatureLog`, `PreventabilityDetermination`, `CoachingRecord`. Carried today by the `trucking_claims_core` semantic model + dataset schemas.

### 3.3 Semantic model — claims-and-safety KPI catalog (TL-FR-020) — authored as `trucking_claims_core`

| Measure | Definition |
|---|---|
| `claim_pay_rate` | accepted-and-paid closures / all closures |
| `claim_denial_rate` | documented denials / all closures |
| `recovery_rate` | dollars recovered from carriers / dollars claimed |
| `fraud_escalation_share` | fraud-investigation escalations / all items |
| `coaching_closure_rate` | coaching-completed closures / all safety events |
| `on_time_share` | on-time deliveries / all shipments |
| `avg_claim_age_days` | backlog aging / cycle time |
| deadline runway | open items by `deadline_bucket` (0-15 / 16-45 / over-45 days) |
| carrier risk mix | watch-tier / insurance-lapsed / high-fraud-risk carrier counts |

Entities: claims / shipments / carriers (chain: claims →many_to_one→ shipments →many_to_one→ carriers). Grammar: categorical dims, cast-to-double measures, equality measure filters, expr_metric with nullif.

### 3.4 Agents (TL-FR-030..060) — proposal-mode

1. **Cargo Claim Intake Copilot (TL-FR-030)** — authored as case-triage TenantAgentConfig: evidence-grounded disposition proposal (accept_pay_claim / deny_claim_documented / file_carrier_recovery / escalate_fraud_investigation / close_coaching_completed), deadline-first reasoning, Carmack burden-shifting + released-value check, never pays/denies/files or communicates outcomes. Bespoke LangGraph recipe deferred.
2. **Carrier Recovery Builder (TL-FR-040)** — deferred recipe: recovery-claim assembly against the responsible carrier with cited evidence; interim: recovery verified query + liability-band dashboards.
3. **Double-Broker Fraud Screener (TL-FR-050)** — deferred recipe; interim: carrier watchlist verified query + isolation_forest shipment-anomaly pipeline + vetting grounding memories.
4. **Filing-Deadline Sentinel (TL-FR-060)** — deferred recipe; interim: deadline_bucket dashboards + deadline verified/saved queries.
5. **Analytics agent** — authored: trucking_claims_core-grounded KPI Q&A.

Autonomous claim payment, denial issuance, recovery filing, carrier suspension, or coaching assignment is forbidden — proposal-mode with human approval always (`TL_AUTONOMOUS_SETTLEMENT_FORBIDDEN` at pack-service tier).

### 3.5 Connectors (TL-FR-080) — deferred to pack-service

**Read:** TMS platforms (McLeod/TMW/MercuryGate-class), telematics & video-safety platforms (ELD, forward camera, harsh-event feeds), reefer telematics/temperature downloads, FMCSA registration & safety data services, load-board / carrier-identity monitoring, claims mailboxes/EDI. **Write adapters (proposal-mode):** claim payment/settlement in TMS-AP, acknowledgment/denial letters, recovery filings, carrier suspension in the carrier-management system, coaching assignment in the telematics platform. Pack ships seed datasets in the landing shape; production connectors configure via Data > Connections.

### 3.6 Regulatory & practice guardrails (TL-FR-090)

- **Carmack (49 U.S.C. 14706)** — actual-loss liability, burden-shifting (prima facie → freedom-from-negligence + excepted cause), released-value limitation (14706(c)), 9-month claim / 2-year suit minimums (14706(e)).
- **Claims processing (49 CFR Part 370)** — written claim requisites, 30-day acknowledgment, 120-day pay/decline/offer, 60-day status intervals; declinations state documented findings.
- **FMCSA CSA** — BASICs-based safety posture; crash/event preventability determinations documented on evidence (Crash Preventability Determination Program concept).
- **Litigation-discovery readiness** — safety reviews, coaching records, and telematics alerts are discoverable; consistency and completion are the defense posture.

### 3.7 Roles & case schemas (TL-FR-100) — roles authored, schemas deferred

Roles: `Claims Analyst`, `Carrier Compliance Analyst`, `Safety Review Specialist`, `Claims & Safety Manager` (sole disposition approver), `Fleet Compliance Auditor` (read+audit only). Case schemas (deferred): `cargo_osd_claim`, `reefer_excursion_review`, `safety_event_review`, `carrier_fraud_vetting`, `recovery_filing`.

## 4. Domain model & data

Authored materialization: 3 datasets (claims 26 / shipments 30 / carriers 12 — seed rows encode a reefer temperature-excursion produce claim with the unit download pending, a repeat intact-seal shortage on one carrier/lane, a mid-load banking change on a new-authority carrier (double-brokering signature), a disputed harsh-braking event from a million-mile driver, a full-trailer electronics theft on a known hot lane by an already-escalated carrier, and a repeat-damage carrier/lane cluster) · 1 semantic model · 5 verified queries · 2 saved queries (incl. carrier→lane network edges) · 3 dashboards (Claims & Safety Command Center, Cargo Claims & Recovery, Carrier Risk Watch — 15 charts) · 5 dispositions · 6-case seeded queue · 5 roles · 2 agent configs · 10 grounding memories · 2 pipelines (isolation_forest shipment anomaly, xgboost claim-outcome scorer). Deferred: guardrails, agent recipes, connectors, write adapters, eval sets, ontology, case schemas, model archetypes, display labels.

## 5. Business rules (TL-BR-*)

- **BR-1** No autonomous claim payment, denial, recovery filing, carrier suspension, or coaching assignment — proposal-mode with human decision, CSM four-eyes on all final determinations.
- **BR-2** Filing and response clocks outrank investigation completeness: calendar the 9-month/2-year windows at intake, acknowledge and respond within claims-processing practice windows, and never let an open evidence request silently burn a recovery deadline.
- **BR-3** Check released-value / limitation-of-liability terms before valuing any claim — a sound claim may still be capped.
- **BR-4** A denial note must carry claimant-tellable documented findings and the defense relied upon (declination-letter standard).
- **BR-5** Intact-seal shortages on shipper-load-and-count moves are investigated as origin short-counts before any payment; repeat patterns on one carrier/lane escalate to fraud review.
- **BR-6** Mid-load banking/factoring changes on new-authority carriers freeze payment pending independent FMCSA-registration verification — funds never release on the strength of the requesting email.
- **BR-7** Safety events get evidence-first review; preventability and coaching decisions are documented, consistent across drivers, and closed to completion (discoverability standard) — driver tenure is context, not proof.
- **BR-8** Every AI-assisted disposition preserves provenance (data/model/prompt/reviewer/timestamp) — claim files and safety files are exam- and discovery-facing records.

## 6. Dependencies

Windrose Core (BRDs 01–23), unmodified. External (deferred connectors): tenant TMS of record, telematics/video platform, reefer telematics provider, FMCSA data services, claims mailbox/EDI.

## 7. NFRs (deltas)

| Metric | Target |
|---|---|
| Triage proposal p95 latency | ≤ 10s |
| Filing/response deadline-breach rate (post-install) | 0 |
| Carrier-recovery rate lift (6mo) | ≥ +10pp on carrier-liable cargo claims |
| Double-broker loss events on frozen-flag loads | 0 |
| Dashboard chart warm render | 100% real data at install |
| Idempotent re-install | all no-ops |

## 8. Acceptance criteria

- **AC-1** `packctl validate` passes; install exits 0 with 0 failed actions.
- **AC-2** All 15 dashboard charts resolve real rows at install.
- **AC-3** 6-case queue seeded from open claims; severities/deadlines match the dataset.
- **AC-4** 5 roles bound to permission groups with differentiated live capabilities.
- **AC-5** Re-install is fully idempotent.
- **AC-6** Disposition taxonomy uses only the Core's closed category set (one of each: true_positive / false_positive / other / inconclusive / benign).
- **AC-7** Pack installs on unmodified Core — zero service/helm/roles_actions.yaml diffs.
- **AC-8** Pack-service-tier capabilities appear verbatim in the `deferred` ledger, never faked.

## 9. Out of scope / future

Real-time dispatch and load tendering; freight bill audit & payment; insurance policy administration; DQF/driver-qualification management; hours-of-service tooling; LTL carrier-specific NMFC classing workflows (natural v2 extension); TMS/telematics write adapters until pack-service ships.
