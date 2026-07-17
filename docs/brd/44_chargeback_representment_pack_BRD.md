# BRD 44 — `chargeback-representment` capability pack

**Deliverable type:** Capability Pack (BRD 23) · **Publisher:** Windrose · **Initial version:** 1.0.0
**Horizon:** 3 pack wave (post-BRD-32). Reference pattern: BRD 24/30/32.
**Status:** v1.0.0 authored, install pending; pack-service-tier components declared `deferred` in the manifest.

---

## 1. Overview

**Purpose.** Merchant-side chargeback response and representment AI — the merchant/PSP mirror of the issuer `card-disputes` pack (BRD 32): decide which incoming chargebacks to fight, with what reason-code-matched compelling evidence, at what economics. Sells to large merchants/e-commerce operators, PSPs/acquirers offering managed disputes, and marketplaces.

**Why this vertical.** Every issuer chargeback lands on a merchant with a short acquirer response clock (network windows run roughly 20-45 days; acquirer deadlines are earlier) and a fixed fee regardless of outcome. Win rates hinge on matching evidence to the reason code (delivery confirmation for not-received, usage logs for digital goods, CE 3.0 priors for CNP fraud), while Visa VDMP/VFMP and Mastercard ECM/HECM monitoring programs punish dispute RATIOS that representment wins do not reduce — so fight/accept discipline, friendly-fraud prevention, and pre-dispute deduplication are program-level economics, not case heroics. Evidence-driven, deadline-bound, human-approved decisions: exactly the governed decision shape of the Windrose Core, proven by BRD 30/32.

**Business value.** Recovery lift (CE 3.0 pre-screen, evidence-to-reason-code matching), zero missed response deadlines, fee savings from economics-thresholded accepts and alert deduplication (never refund twice), friendly-fraud loss reduction via block-list feed, monitoring-program headroom protection, and audit-ready decision files (every filing and accept carries findings + provenance).

**In scope.** Incoming-chargeback triage copilot (fight/accept/pre-arb/flag/close), response-deadline tracking, CE 3.0 qualification pre-screen, evidence-strength and fight-economics classification, friendly-fraud repeat-offender flagging, pre-dispute alert deduplication, dispute-program KPI semantic model + dashboards, customer-category network analytics, network-rule grounding, order-anomaly + win-likelihood pipelines.

**Out of scope.** Issuer-side dispute adjudication (BRD 32); authorization-stream fraud prevention/3DS orchestration; actual submission rails (write adapters deferred); refund/customer-service tooling beyond dispute context; collections.

## 2. Actors & user stories

**Personas:** Dispute Response Analyst (DRA), Evidence Specialist (ES), Pre-Arbitration Lead (PAL), Dispute Program Manager (DPM), Payments Compliance Auditor (PCA), Tenant Admin (TA).

- **US-1** As a DRA, my queue ranks open chargebacks by response deadline × dollar × evidence strength (never FIFO); each case shows the order evidence, the customer's chargeback history, and the copilot's proposed fight/accept decision with cited evidence.
- **US-2** As a DRA on a 10.4 CNP fraud claim, the copilot pre-screens Visa CE 3.0 qualification (prior undisputed orders in the qualifying window sharing device/address/login elements) and assembles the qualification package before I decide.
- **US-3** As an ES, evidence requirements come reason-code-matched: signed delivery confirmation for 13.1, usage/login logs for digital goods, checkout policy disclosure for 13.3/cancellations — with the gaps called out.
- **US-4** As a DRA, below-threshold chargebacks come recommended as accept-liability with the economics shown, and orders already refunded via an RDR/Ethoca-style alert come flagged close-duplicate — never a second refund.
- **US-5** As a PAL, issuer pre-arbitrations on big-ticket wins reach me with the fee-at-risk economics and the original evidence file; escalation past pre-arb is a deliberate, approved exception.
- **US-6** As a DPM, filings, accepts, and escalations come to me four-eyes: the analyst proposes, I approve; I see fight rate, win rate, net recovery, accept-liability share, friendly-fraud share, and deadline runway — sliceable by reason code, family, network, evidence strength, and month.
- **US-7** As a PCA, I export an audit bundle showing every AI-assisted decision with reviewer identity, evidence cited, and timestamps — representment packages contain only genuine records.
- **US-8** As a TA, the pack lands as tenant-scoped content only — datasets, model, dashboards, roles, agents — with zero Core changes.

## 3. Functional requirements

### 3.1 Pack manifest (MR-FR-001)

Standard v1. Categories: `payments, merchants, chargebacks, representment, fraud`. Regulatory: `visa_rules, mastercard_rules`. Clouds: all.

### 3.2 Ontology (MR-FR-010) — deferred to pack-service

`Merchant`, `Customer`, `Order`, `Payment`, `Chargeback`, `ReasonCode`, `Representment`, `PreArbitration`, `EvidencePackage`, `PreDisputeAlert`, `BlockListEntry`, `MonitoringProgramStatus`. Carried today by the `representment_core` semantic model + dataset schemas.

### 3.3 Semantic model — dispute-program KPI catalog (MR-FR-020) — authored as `representment_core`

| Measure | Definition |
|---|---|
| `fight_rate` | representments filed / all closed decisions |
| `win_rate` | representments won / representments filed |
| `net_recovery_rate` | dollars recovered / dollars under chargeback |
| `accept_liability_share` | accepted-liability closures / all closures |
| `friendly_fraud_share` | first-party-suspect chargebacks / all chargebacks |
| `avg_chargeback_age_days` | response cycle time / backlog aging |
| `fraud_family_count` | monitoring-program numerator family (10.4/4837) |
| deadline runway | open chargebacks by `deadline_bucket` (0-7 / 8-20 / over-20 days) |

Entities: chargebacks → orders → customers (chain, many_to_one). Grammar: categorical dims, cast-to-double measures, equality measure filters, expr_metric with nullif.

### 3.4 Agents (MR-FR-030..060) — proposal-mode

1. **Chargeback Response Copilot (MR-FR-030)** — authored as case-triage TenantAgentConfig: evidence-grounded fight/accept proposal (represent_with_evidence / accept_liability_refund / pre_arbitration_escalate / flag_friendly_fraud_pattern / close_duplicate_or_resolved), deadline-first reasoning, reason-code evidence matching, CE 3.0 pre-check, alert-refund dedupe, never files or refunds. Bespoke LangGraph recipe deferred.
2. **Representment Package Builder / CE 3.0 Qualifier (MR-FR-040)** — deferred recipe: evidence assembly + qualification matching against the order book.
3. **Fight/Accept Economics Router (MR-FR-050)** — deferred recipe; interim: fight_economics classification + xgboost win-likelihood pipeline + accept-share verified query.
4. **Pre-Arbitration Advisor (MR-FR-060)** — deferred recipe; interim: pre-arb disposition + fee-economics grounding memory + high-value saved query.
5. **Analytics agent** — authored: representment_core-grounded KPI Q&A.

Autonomous representment filing, refund issuance, or block-list mutation is forbidden — proposal-mode with human approval always (`MR_AUTONOMOUS_FILING_FORBIDDEN` at pack-service tier).

### 3.5 Connectors (MR-FR-080) — deferred to pack-service

**Read:** PSP/acquirer dispute APIs + webhooks, network rails via acquirer (VROL, Mastercom), pre-dispute alert rails (Verifi RDR/Order Insight, Ethoca-style feeds), OMS/e-commerce platforms, carrier tracking APIs, device-fingerprint/antifraud platforms (CE 3.0 elements). **Write adapters (proposal-mode):** submit representment, accept liability/refund, alert responses, pre-arb accept/continue, block-list add. Pack ships seed datasets in the landing shape; production connectors configure via Data > Connections.

### 3.6 Network-rule guardrails (MR-FR-090)

- **Response clocks** — acquirer deadlines run earlier than the ~20-45-day network windows; a late strong case is a lost case.
- **Visa CE 3.0** — 2+ prior undisputed transactions 120-365 days old sharing qualifying elements (device/IP/shipping address/login) shift 10.4 liability back to the issuer.
- **Monitoring programs** — VDMP/VFMP and ECM/HECM track dispute/fraud ratios that wins don't reduce; headroom is managed by prevention (thresholds qualitative, acquirer-confirmed).
- **Evidence integrity** — packages contain only genuine verifiable records; fabricated evidence risks network penalties and acquirer offboarding.
- **Deduplication** — alert-refunded orders are answered with credit evidence, never refunded twice.

### 3.7 Roles & case schemas (MR-FR-100) — roles authored, schemas deferred

Roles: `Dispute Response Analyst`, `Evidence Specialist`, `Pre-Arbitration Lead`, `Dispute Program Manager` (sole disposition approver), `Payments Compliance Auditor` (read+audit only). Case schemas (deferred): `chargeback_response`, `evidence_assembly`, `pre_arbitration_review`, `friendly_fraud_review`, `alert_deduplication`.

## 4. Domain model & data

Authored materialization: 3 datasets (chargebacks 26 / orders 30 / customers 12 — seed rows encode a CE 3.0-qualified 10.4 claim with three prior same-device orders, a delivery-confirmed 13.1 on a tight deadline, a weak 13.3 where accepting beats fighting, a serial friendly-fraudster's fourth chargeback, an issuer pre-arb on a big-ticket win, and a duplicate chargeback on an alert-refunded order) · 1 semantic model · 5 verified queries · 2 saved queries (incl. customer→category network edges) · 3 dashboards (Chargeback Response Center, Win Rates & Evidence, Program Health & Thresholds — 15 charts) · 5 dispositions · 6-case seeded queue · 5 roles · 2 agent configs · 10 grounding memories · 2 pipelines (isolation_forest order anomaly, xgboost win-likelihood scorer). Deferred: guardrails, agent recipes, connectors, write adapters, eval sets, ontology, case schemas, model archetypes, display labels.

## 5. Business rules (MR-BR-*)

- **BR-1** No autonomous representment filing, refund, pre-arb response, or block-list mutation — proposal-mode with human decision, DPM four-eyes on filings, accepts, and escalations.
- **BR-2** Response deadlines outrank evidence perfection: file the best available package inside the acquirer clock or decide to accept — never silently expire.
- **BR-3** Evidence must be reason-code-matched and genuine; generic or fabricated evidence is never submitted.
- **BR-4** Every 10.4 CNP fraud claim gets a CE 3.0 qualification pre-screen before the fight/accept decision.
- **BR-5** Below the fight-economics threshold, accept liability even when the merchant is right — and log the pattern for prevention.
- **BR-6** Check pre-dispute rails before any refund or fight: an alert-refunded order is answered with credit evidence, never refunded twice.
- **BR-7** Friendly-fraud suspicion never auto-denies a customer: fight with pattern evidence, feed confirmed offenders to the block-list, assess each claim on its own evidence — prevention beats fighting (wins don't reduce monitoring ratios).
- **BR-8** Every AI-assisted decision preserves provenance (data/model/prompt/reviewer/timestamp) — acquirer, PSP, and network program audit defense.

## 6. Dependencies

Windrose Core (BRDs 01–23), unmodified. External (deferred connectors): PSP/acquirer of record, VROL/Mastercom access via acquirer, alert-rail enrollment (RDR/Ethoca-style), OMS + carrier tracking credentials.

## 7. NFRs (deltas)

| Metric | Target |
|---|---|
| Triage proposal p95 latency | ≤ 10s |
| Missed response deadlines (post-install) | 0 |
| Win-rate lift on fought chargebacks (6mo) | ≥ +10pp |
| Double-refund incidents | 0 |
| Dashboard chart warm render | 100% real data at install |
| Idempotent re-install | all no-ops |

## 8. Acceptance criteria

- **AC-1** `packctl validate` passes; install exits 0 with 0 failed actions.
- **AC-2** All 15 dashboard charts resolve real rows at install.
- **AC-3** 6-case queue seeded from open chargebacks; severities/deadlines match the dataset.
- **AC-4** 5 roles bound to permission groups with differentiated live capabilities.
- **AC-5** Re-install is fully idempotent.
- **AC-6** Disposition taxonomy uses only the Core's closed category set (one of each).
- **AC-7** Pack installs on unmodified Core — zero service/helm/roles_actions.yaml diffs.
- **AC-8** Pack-service-tier capabilities appear verbatim in the `deferred` ledger, never faked.

## 9. Out of scope / future

Issuer-side adjudication (BRD 32); authorization-stream fraud prevention and 3DS orchestration; automated evidence submission until write adapters ship; alert-rail auto-refund rules (RDR decisioning) as a v2 governed write; marketplace seller-liability allocation; monitoring-program remediation-plan workflow.
