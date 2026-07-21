# BRD 49 — `ap-invoice-audit` capability pack

**Deliverable type:** Capability Pack (BRD 23) · **Publisher:** Datacern · **Initial version:** 1.0.0
**Horizon:** 3 pack wave (post-BRD-32 pattern). Reference pattern: BRD 24/30/32.
**Status:** v1.0.0 authored, install pending (packctl validate green); pack-service-tier components declared `deferred` in the manifest.

---

## 1. Overview

**Purpose.** Accounts-payable invoice exception and fraud audit AI: three-way-match exception triage with payment-run deadline awareness, duplicate-payment interception (including OCR-variant resubmissions), BEC/vendor-impersonation banking-change defense with out-of-band verification discipline, shell-vendor and split-invoicing detection, and post-payment recovery workflow. Sells to enterprise finance / AP shared-services organizations, procure-to-pay BPOs, and audit-recovery firms.

**Why this vertical.** AP disbursements sit on hard operational clocks (payment runs, early-payment discount windows, net-terms deadlines) inside a SOX/ICFR control regime; duplicate payments, BEC banking-change fraud, and shell vendors are enormous, well-documented loss surfaces, and an entire contingency-fee recovery-audit industry exists to claw back what the controls missed. Every block/release is a documented, evidence-driven, four-eyes human determination — the exact governed decision shape of the Datacern Core, and the exception-adjudication pattern is already proven by BRD 30/32.

**Business value.** Duplicate-payment prevention (block before disbursement, not recovery after), BEC loss avoidance (banking-change verification discipline at the moment of maximum risk), shell-vendor and threshold-splitting detection, discount-window protection (deadline-runway-ranked queues so holds don't burn 2/10-net-30 economics), recovery-audit lift, and exam-ready decision files (every block/release carries its findings + provenance).

**In scope.** Exception triage copilot, payment-run/discount deadline tracking, duplicate/near-duplicate review, banking-change (BEC) and shell-vendor escalation, split-invoicing aggregation, price/quantity-variance credit negotiation, AP-controls KPI semantic model + dashboards, vendor-category network analytics, payment-controls + invoice-fraud grounding, invoice-anomaly + exception-outcome pipelines.

**Out of scope.** Payment execution and bank connectivity (treasury products); invoice OCR/capture itself (upstream platforms); vendor onboarding portals; T&E/expense audit (separate pack candidate); tax-engine determination.

## 2. Actors & user stories

**Personas:** AP Exception Analyst (AEA), Vendor Master Specialist (VMS), Recovery Audit Analyst (RAA), AP Controls Manager (ACM), Internal Controls Auditor (ICA), Tenant Admin (TA).

- **US-1** As an AEA, my queue ranks open exceptions by deadline runway × dollar × severity (never FIFO); each case shows the invoice, the vendor-master facts, the three-way-match result, and the copilot's proposed disposition with cited evidence.
- **US-2** As an AEA on a banking-change exception, the copilot reminds me the only acceptable verification is out-of-band via the known-good phone number on the vendor master — never any contact supplied in the request — and the payment stays held until verification completes.
- **US-3** As a VMS, new vendors with unverified TINs, missing sanctions screens, employee-address collisions, or repeated master-data changes land in my worklist with the indicator evidence assembled.
- **US-4** As an RAA, near-duplicate pairs (vendor+amount+date match, invoice numbers one OCR character apart) and under-threshold invoice strings surface with the sibling rows cited, so I can block pre-payment or claim recovery post-payment.
- **US-5** As an ACM, payment blocks and releases come to me four-eyes: the analyst proposes, I approve; every release over a control exception must carry documented, tellable findings.
- **US-6** As an ACM, I see block rate, release rate, recovered dollars, fraud-escalation share, duplicate share, backlog aging, and deadline runway — sliceable by exception type, match gap, fraud indicator, vendor tenure, and month.
- **US-7** As an ICA, I export an exam bundle showing every AI-assisted disposition with reviewer identity, findings, and timestamps (SOX/ICFR evidence standard).
- **US-8** As a TA, the pack lands as tenant-scoped content only — datasets, model, dashboards, roles, agents — with zero Core changes.

## 3. Functional requirements

### 3.1 Pack manifest (AP-FR-001)

Standard v1. Categories: `finance, accounts_payable, procure_to_pay, fraud, recovery_audit`. Regulatory: `sox_icfr, irs_1099_tin, ofac_sanctions, coso`. Clouds: all.

### 3.2 Ontology (AP-FR-010) — deferred to pack-service

`Vendor`, `VendorBankAccount`, `PurchaseOrder`, `GoodsReceipt`, `Invoice`, `InvoiceLine`, `PaymentRun`, `Exception`, `CreditMemo`, `ApprovalThreshold`, `RecoveryClaim`. Carried today by the `ap_audit_core` semantic model + dataset schemas.

### 3.3 Semantic model — AP-controls KPI catalog (AP-FR-020) — authored as `ap_audit_core`

| Measure | Definition |
|---|---|
| `block_rate` | payments blocked / all closed exceptions |
| `release_rate` | exceptions cleared for payment / all closures |
| `recovery_rate` | dollars recovered or prevented / dollars under exception |
| `fraud_escalation_share` | fraud escalations / all closures |
| `duplicate_share` | duplicate-invoice exceptions / all exceptions |
| `avg_exception_age_days` | backlog aging / cycle time |
| `total_recovered_amount` / `total_exposure_amount` | recovery and exposure dollars |
| deadline runway | open exceptions by `deadline_bucket` (0-5 / 6-15 / over-15 days) |
| vendor-risk mix | `new_vendor_count`, `unverified_tin_vendor_count`, `unscreened_vendor_count`, `non_po_invoice_count` |

Entities: exceptions / invoices / vendors (chain, exceptions→invoices→vendors, both many_to_one). Grammar: categorical dims, cast-to-double measures, equality measure filters, expr_metric with nullif.

### 3.4 Agents (AP-FR-030..060) — proposal-mode

1. **Exception Triage Copilot (AP-FR-030)** — authored as case-triage TenantAgentConfig: evidence-grounded disposition proposal (block_payment_confirmed_error / reject_return_to_vendor / release_payment_cleared / partial_credit_recovery / escalate_fraud_investigation), deadline-first reasoning, never moves payments or accepts banking changes. Bespoke LangGraph recipe deferred.
2. **Banking-Change Verification Sentinel (AP-FR-040)** — deferred recipe: BEC red-flag scoring + out-of-band verification checklist + payment hold proposal.
3. **Duplicate-Pair Matcher (AP-FR-050)** — deferred recipe; interim: isolation_forest invoice-anomaly pipeline + duplicate-share verified query + OCR-normalization guidance in grounding memories.
4. **Recovery Statement Auditor (AP-FR-060)** — deferred recipe; interim: recovered-dollars dashboards + high-value open-exception saved query.
5. **Analytics agent** — authored: ap_audit_core-grounded KPI Q&A.

Autonomous payment movement, vendor-master change, or banking-change acceptance is forbidden — proposal-mode with human approval always (`AP_AUTONOMOUS_PAYMENT_FORBIDDEN` at pack-service tier).

### 3.5 Connectors (AP-FR-080) — deferred to pack-service

**Read:** ERP AP subledgers (SAP S/4HANA, Oracle Fusion, NetSuite), P2P suites (Coupa, Ariba, Ivalua), invoice-capture/OCR platforms, bank payment gateways (run schedules), vendor TIN-matching and sanctions-screening services. **Write adapters (proposal-mode):** ERP payment block/release, invoice park/reject to vendor portal, credit-memo posting, verified vendor-master banking updates. Pack ships seed datasets in the landing shape; production connectors configure via Data > Connections.

### 3.6 Regulatory & control guardrails (AP-FR-090)

- **SOX/ICFR (COSO)** — disbursement and vendor-master controls are in assessment scope; segregation of duties (vendor-master vs invoice entry vs payment approval); documented rationale for any release over a control exception.
- **IRS 1099/TIN** — W-9 collection and TIN verification before payment; unverifiable TINs raise backup-withholding exposure.
- **OFAC** — vendors sanctions-screened before payable status; paying a sanctioned party is strict-liability exposure.
- **BEC defense** — banking changes verified out-of-band via known-good contacts only; payments to newly changed accounts held pending verification.

### 3.7 Roles & case schemas (AP-FR-100) — roles authored, schemas deferred

Roles: `AP Exception Analyst`, `Vendor Master Specialist`, `Recovery Audit Analyst`, `AP Controls Manager` (sole disposition approver), `Internal Controls Auditor` (read+audit only). Case schemas (deferred): `duplicate_review`, `banking_change_verification`, `shell_vendor_investigation`, `price_variance_negotiation`, `recovery_claim`.

## 4. Domain model & data

Authored materialization: 3 datasets (exceptions 26 / invoices 30 / vendors 12 — seed rows encode a BEC banking-change request 2 days before a $148K payment run, an OCR near-duplicate pair (BRL-10442 vs BRL-1O442), a shell-vendor suspect with employee-address collision and sequential invoice numbers, a 3-invoice string each $50 under the $5K approval threshold, a 12% price variance vs PO, and a missing-receipt release candidate) · 1 semantic model · 5 verified queries · 2 saved queries (incl. vendor→category network edges) · 3 dashboards (AP Exception Center, Fraud & Vendor Risk, Recovery & Controls — 15 charts) · 5 dispositions · 6-case seeded queue · 5 roles · 2 agent configs · 10 grounding memories · 2 pipelines (isolation_forest invoice anomaly, xgboost exception-outcome scorer). Deferred: guardrails, agent recipes, connectors, write adapters, eval sets, ontology, case schemas, model archetypes, display labels.

## 5. Business rules (AP-BR-*)

- **BR-1** No autonomous payment block/release, vendor-master change, or banking-change acceptance — proposal-mode with human decision, ACM four-eyes on blocks and releases.
- **BR-2** Banking changes are verified out-of-band only, via the known-good contact on the vendor master — never via any contact supplied in the request; payments to changed accounts hold until verified.
- **BR-3** No vendor is payable without W-9/TIN verification and sanctions screening; unscreened vendors route to the Vendor Master Specialist.
- **BR-4** Duplicate screening must survive channel resubmission and OCR variance (fuzzy vendor+amount+date matching, OCR-confusable normalization) — exact-match dedupe alone is a control gap.
- **BR-5** Under-threshold invoice strings are aggregated as one engagement and re-routed to the approval tier the aggregate requires.
- **BR-6** Holds are scoped to the payment at risk; deadline runway (payment runs, discount windows) ranks the queue — a review hold has a per-day dollar cost on discount-bearing invoices.
- **BR-7** A release over a control exception requires documented, approver-signed findings (SOX evidence standard).
- **BR-8** Every AI-assisted disposition preserves provenance (data/model/prompt/reviewer/timestamp) — audit and ICFR-testing defense.

## 6. Dependencies

Datacern Core (BRDs 01–23), unmodified. External (deferred connectors): ERP/P2P system of record, bank gateway schedules, TIN-matching and sanctions-screening services.

## 7. NFRs (deltas)

| Metric | Target |
|---|---|
| Triage proposal p95 latency | ≤ 10s |
| Duplicate payments disbursed post-install | 0 on screened runs |
| BEC banking-change losses (post-install) | 0 on verified changes |
| Dashboard chart warm render | 100% real data at install |
| Idempotent re-install | all no-ops |

## 8. Acceptance criteria

- **AC-1** `packctl validate` passes; install exits 0 with 0 failed actions. *(validate green 2026-07-16; install pending)*
- **AC-2** All 15 dashboard charts resolve real rows at install.
- **AC-3** 6-case queue seeded from open exceptions; severities/deadlines match the dataset.
- **AC-4** 5 roles bound to permission groups with differentiated live capabilities.
- **AC-5** Re-install is fully idempotent.
- **AC-6** Disposition taxonomy uses only the Core's closed category set (one code per category).
- **AC-7** Pack installs on unmodified Core — zero service/helm/roles_actions.yaml diffs.
- **AC-8** Pack-service-tier capabilities appear verbatim in the `deferred` ledger, never faked.

## 9. Out of scope / future

Payment execution/bank connectivity; invoice OCR capture; vendor onboarding portal; T&E/expense audit (candidate sibling pack); dynamic-discounting optimization; ERP write adapters until pack-service ships; multi-entity intercompany netting (natural v2 extension).
