# BRD 37 — `warranty-claims` capability pack

**Deliverable type:** Capability Pack (BRD 23) · **Publisher:** Windrose · **Initial version:** 1.0.0
**Horizon:** 3 (post-BRD-24-31 wave). Reference pattern: BRD 24/30/32.
**Status:** v1.0.0 authored, install pending; pack-service-tier components declared `deferred` in the manifest.

---

## 1. Overview

**Purpose.** OEM warranty-claims adjudication AI for manufacturers paying dealer/service-network claims: intake triage with payment-decision deadline awareness, dealer claim-padding surveillance with audit escalation, component failure early-warning detection by build batch, supplier cost recovery (warranty chargebacks), goodwill governance, and safety-recall routing. Sells to auto OEMs, heavy-equipment/ag OEMs, appliance/electronics manufacturers, and extended-warranty administrators.

**Why this vertical.** Warranty is a multi-billion-dollar cost line accrued at sale (reserve accounting) and adjudicated claim-by-claim against dealer agreements with hard payment-decision clocks; padding/leakage, missed supplier recoveries, and late field-failure signals are chronic and expensive, while safety-recall interplay (NHTSA) and Magnuson-Moss tie-in rules make wrongful denial a regulatory exposure. Every determination is documented, disputable, and evidence-driven — the exact governed human-in-the-loop decision shape of the Windrose Core, proven by the BRD 30/32 adjudication packs.

**Business value.** Deadline-breach elimination on the payment-decision clock, analyst throughput (triage pre-routing), warranty leakage reduction (labor-op trimming + audit selection), supplier recovery lift (attribution evidence discipline), earlier field-failure containment (build-batch clusters), governed goodwill spend, and audit-ready decision files (every denial carries dealer-communicable findings + provenance).

**In scope.** Claim intake triage copilot, payment-deadline tracking, dealer claim-padding watch (labor-op stacking, repeat repairs, claims-per-unit outliers), component failure early-warning signals, supplier chargeback recovery workflow, goodwill review, recall-adjacent routing, warranty-ops KPI semantic model + dashboards, dealer-component network analytics, warranty-law + field-quality grounding, unit-anomaly + claim-outcome pipelines.

**Out of scope.** Dealer-side claim preparation tooling; retail extended-warranty sales/underwriting; parts logistics and inventory; recall campaign execution management (routing only); telematics ingestion pipelines until pack-service connectors ship.

## 2. Actors & user stories

**Personas:** Warranty Claims Analyst (WCA), Technical Assessor (TAS), Supplier Recovery Specialist (SRS), Warranty Operations Manager (WOM), Warranty Audit Lead (WAL), Tenant Admin (TA).

- **US-1** As a WCA, my queue ranks open claims by deadline runway × dollar × severity (never FIFO); each case shows the diagnostic evidence, the unit and dealer history, and the copilot's proposed disposition with cited claim/unit/dealer ids.
- **US-2** As a WCA, when a claim implicates an open safety campaign the copilot routes it to the recall (remedy free of charge regardless of warranty status) and never proposes denying it as a warranty exclusion.
- **US-3** As a TAS, repeat-repair comebacks (same unit, same failure, third visit) and low-hours build-batch failure clusters land in my escalation view with the pattern evidence assembled, and a comeback pays only after a documented root-cause diagnostic.
- **US-4** As an SRS, when a failure is attributable to a supplied component I get the claim paid to the dealer and a drafted supplier chargeback citing the part/lot attribution evidence.
- **US-5** As a WOM, denials, goodwill decisions and supplier debits come to me four-eyes: the analyst proposes, I approve; every denial's note must contain findings the dealer can be told.
- **US-6** As a WOM, I see approval rate, denial rate, adjustment share, cost per claim, audit-escalation share, supplier recovery rate, and deadline runway — sliceable by claim type, component, failure mode, build batch, dealer region, and month.
- **US-7** As a WAL, dealers with claims-per-unit well above peers and labor-op stacking patterns surface for audit selection, and I export decision files showing every AI-assisted disposition with reviewer identity, findings, and timestamps.
- **US-8** As a TA, the pack lands as tenant-scoped content only — datasets, model, dashboards, roles, agents — with zero Core changes.

## 3. Functional requirements

### 3.1 Pack manifest (WA-FR-001)

Standard v1. Categories: `manufacturing, warranty, claims, dealers, aftersales`. Regulatory: `magnuson_moss, ftc_warranty_rules, ucc_article_2, nhtsa_safety_act, tread_act`. Clouds: all.

### 3.2 Ontology (WA-FR-010) — deferred to pack-service

`Unit`, `Dealer`, `WarrantyPlan`, `Claim`, `LaborOp`, `Part`, `ComponentSystem`, `FailureMode`, `Supplier`, `SupplierChargeback`, `RecallCampaign`, `GoodwillRequest`, `AuditFinding`. Carried today by the `warranty_core` semantic model + dataset schemas.

### 3.3 Semantic model — warranty-ops KPI catalog (WA-FR-020) — authored as `warranty_core`

| Measure | Definition |
|---|---|
| `claim_approval_rate` | full-pay approvals / all closures |
| `claim_denial_rate` | policy-exclusion denials / all closures |
| `adjustment_share` | partial-pay adjustments / all closures |
| `audit_escalation_share` | dealer-audit escalations / all closures |
| `supplier_recovery_rate` | dollars recovered from suppliers / dollars claimed |
| `avg_claim_amount` | cost per claim (as submitted) |
| `avg_claim_age_days` | backlog aging / cycle time |
| claims per unit | `claim_count` against `unit_count` + dealer `claims_per_unit_tier` peer banding |
| deadline runway | open claims by `deadline_bucket` (0-7 / 8-21 / over-21 days) |
| component failure mix | `claim_count` / `powertrain_claim_count` by `component_system`, `failure_mode`, `build_batch` |

Entities: claims / units / dealers (chain, claims→units→dealers many_to_one). Grammar: categorical dims, cast-to-double measures, equality measure filters, expr_metric with nullif.

### 3.4 Agents (WA-FR-030..060) — proposal-mode

1. **Claim Intake Copilot (WA-FR-030)** — authored as case-triage TenantAgentConfig: evidence-grounded disposition proposal (approve_pay_claim / deny_policy_exclusion / adjust_partial_pay / escalate_dealer_audit / close_supplier_recovery), deadline-first reasoning, recall-routing and Magnuson-Moss tie-in awareness, never pays/denies/debits autonomously. Bespoke LangGraph recipe deferred.
2. **Dealer Audit Analyzer (WA-FR-040)** — deferred recipe: claims-per-unit peer scoring + labor-op stacking + usage-meter consistency; interim: dealer-padding verified query + audit-watch dashboard.
3. **Early-Warning Signal Detector (WA-FR-050)** — deferred recipe: failure-rate clustering by component × build batch; interim: component-failure dashboard + hotspot verified query + isolation_forest pipeline.
4. **Supplier Recovery Builder (WA-FR-060)** — deferred recipe: attribution-evidence assembly + debit-memo drafting; interim: supplier-recovery verified query + close_supplier_recovery workflow.
5. **Analytics agent** — authored: warranty_core-grounded KPI Q&A.

Autonomous claim payment, denial, or supplier debit is forbidden — proposal-mode with human approval always (`WA_AUTONOMOUS_PAYMENT_FORBIDDEN` at pack-service tier).

### 3.5 Connectors (WA-FR-080) — deferred to pack-service

**Read:** OEM warranty systems (SAP Warranty Management, Oracle-class modules), dealer management system (DMS) claim feeds, telematics/hour-meter platforms, parts-return and failure-analysis tracking, supplier quality portals, NHTSA campaign feeds (vehicle OEMs). **Write adapters (proposal-mode):** claim payment/denial posting, supplier debit memos, recall-campaign routing, dealer decision notices, parts-return orders. Pack ships seed datasets in the landing shape; production connectors configure via Data > Connections.

### 3.6 Regulatory & policy guardrails (WA-FR-090)

- **Magnuson-Moss (15 U.S.C. 2301 et seq.)** — full vs limited warranty standards, tie-in-sales prohibition (no denial for aftermarket parts/service absent causation evidence), no disclaimer of implied warranties under a written warranty.
- **Implied warranties (UCC Art. 2)** — merchantability / fitness backdrop to written-warranty adjudication.
- **NHTSA Safety Act / TREAD** — safety defects are recall territory (remedy free regardless of warranty; never denied as warranty), early-warning field-data reporting for vehicle OEMs.
- **Financial controls** — warranty reserve accrued at sale; adjudication data drives reserve adequacy; goodwill governed by documented matrix + approval tiers; supplier debits require attribution evidence.

### 3.7 Roles & case schemas (WA-FR-100) — roles authored, schemas deferred

Roles: `Warranty Claims Analyst`, `Technical Assessor`, `Supplier Recovery Specialist`, `Warranty Operations Manager` (sole disposition approver), `Warranty Audit Lead` (read+audit only). Case schemas (deferred): `claim_adjudication`, `dealer_audit`, `supplier_recovery`, `goodwill_review`, `early_warning_investigation`, `recall_routing_review`.

## 4. Domain model & data

Authored materialization: 3 datasets (claims 26 / units 30 / dealers 12 — seed rows encode a dealer at ~3x peer claims-per-unit on stacked electrical labor ops, a powertrain crank-seal cluster on one build batch with supplier recovery, an out-of-warranty goodwill request from a fleet account, a high-dollar hydraulics replacement with photos pending, a third-visit HVAC comeback, and a recall-adjacent brake claim) · 1 semantic model · 5 verified queries · 2 saved queries (incl. dealer→component network edges) · 3 dashboards (Warranty Command Center, Dealer & Audit Watch, Component Failure Signals — 15 charts) · 5 dispositions · 6-case seeded queue · 5 roles · 2 agent configs · 10 grounding memories · 2 pipelines (isolation_forest unit anomaly, xgboost claim-outcome scorer). Deferred: guardrails, agent recipes, connectors, write adapters, eval sets, ontology, case schemas, model archetypes, display labels.

## 5. Business rules (WA-BR-*)

- **BR-1** No autonomous claim payment, denial, or supplier debit — proposal-mode with human decision, WOM four-eyes on denials, goodwill, and supplier chargebacks.
- **BR-2** A claim implicating an open safety campaign routes to the recall (remedy free of charge regardless of warranty status) — never denied as a warranty exclusion.
- **BR-3** No denial conditioned on non-branded parts or independent service unless evidence shows it caused the failure (Magnuson-Moss tie-in rule).
- **BR-4** Suspected claim padding justifies audit escalation, not blanket denial — each claim adjudicated on its own diagnostic evidence; paid claims remain chargeable after post-payment audit.
- **BR-5** Denial notes must contain dealer-communicable findings (specific exclusion or evidence gap).
- **BR-6** Supplier debits require attribution evidence (returned-part failure analysis + lot traceability) — weak attribution is the top reversal cause.
- **BR-7** A repeat-repair comeback (same unit, same failure, third visit) pays only after a documented root-cause diagnostic.
- **BR-8** Goodwill is discretionary and governed: documented matrix, tiered approval, cost-share default, tracked separately from the warranty reserve; every AI-assisted disposition preserves provenance (data/model/prompt/reviewer/timestamp).

## 6. Dependencies

Windrose Core (BRDs 01–23), unmodified. External (deferred connectors): OEM warranty system of record, DMS claim feeds, supplier quality/chargeback rails, NHTSA campaign data (vehicle OEMs).

## 7. NFRs (deltas)

| Metric | Target |
|---|---|
| Triage proposal p95 latency | ≤ 10s |
| Payment-decision deadline-breach rate (post-install) | 0 |
| Warranty leakage reduction (6mo) | ≥ 5% of paid-claim dollars via trims + audit selection |
| Supplier recovery lift (6mo) | ≥ +10% recovered dollars on attributable claims |
| Dashboard chart warm render | 100% real data at install |
| Idempotent re-install | all no-ops |

## 8. Acceptance criteria

- **AC-1** `packctl validate` passes; install exits 0 with 0 failed actions.
- **AC-2** All 15 dashboard charts resolve real rows at install.
- **AC-3** 6-case queue seeded from open claims; severities/deadlines match the dataset.
- **AC-4** 5 roles bound to permission groups with differentiated live capabilities.
- **AC-5** Re-install is fully idempotent.
- **AC-6** Disposition taxonomy uses only the Core's closed category set.
- **AC-7** Pack installs on unmodified Core — zero service/helm/roles_actions.yaml diffs.
- **AC-8** Pack-service-tier capabilities appear verbatim in the `deferred` ledger, never faked.

## 9. Out of scope / future

Dealer-side claim-prep tooling; extended-warranty sales/underwriting; parts logistics; recall campaign execution management; telematics-stream failure prediction and lemon-law case management (natural v2 extensions); warranty-system write adapters until pack-service ships.
