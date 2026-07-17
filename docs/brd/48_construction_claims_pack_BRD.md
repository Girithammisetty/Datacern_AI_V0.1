# BRD 48 — `construction-claims` capability pack

**Deliverable type:** Capability Pack (BRD 23) · **Publisher:** Windrose · **Initial version:** 1.0.0
**Horizon:** 3 pack wave (post-BRD-32 pattern). Reference pattern: BRD 32 (card-disputes).
**Status:** v1.0.0 authored, install pending; pack-service-tier components declared `deferred` in the manifest.

---

## 1. Overview

**Purpose.** Construction claim and change-order adjudication AI for the paying side of the contract: entitlement-first triage (notice provisions, differing site conditions Type I/II, directed vs constructive acceleration, concurrent delay), quantum discipline (measured-mile over total-cost), defect-backcharge and surety-notice governance, and pay-if-paid/pay-when-paid payment-dispute screening. Sells to owners/developers, general contractors, construction managers, sureties, and infrastructure agencies.

**Why this vertical.** Construction claims are high-dollar, deadline-bound, and evidence-driven: contractual notice windows are condition precedent and strictly enforced in many jurisdictions, response deadlines run from the contract, and every determination is later tested in mediation, arbitration, or litigation from the contemporaneous record. Volumes track the mega-project pipeline (transit, healthcare, education, bridges) and claims teams are chronically understaffed. Every determination is a documented, disputable, evidence-cited human decision — the exact governed human-in-the-loop shape of the Windrose Core, proven by BRD 24 (insurance) and BRD 32 (card-disputes).

**Business value.** Deadline-breach elimination (contractual response-clock watch), reviewer throughput (entitlement pre-analysis and clause routing), quantum leakage reduction (measured-mile anchoring and 3x-norm outlier detection), wrongful-default avoidance (notice-and-cure sequencing before surety steps), and defensible determination files (every rejection cites the clause and record evidence relied upon, with AI provenance).

**In scope.** Claim intake triage copilot, contractual notice/deadline tracking, delay-analysis method screening (TIA/windows/as-planned-vs-as-built, concurrent delay), DSC Type I/II analysis, quantum review (measured-mile vs total-cost), backcharge and surety-notice workflow, payment-dispute clause screening, claims-ops KPI semantic model + dashboards, party-project exposure network, claims-doctrine grounding, contract-anomaly + claim-outcome pipelines.

**Out of scope.** Claimant-side claim preparation (contractor-side pack is a separate vertical); CPM scheduling software itself (P6/MS Project remain the systems of record — this pack adjudicates, it does not schedule); design review and E&O allocation; litigation/arbitration case management; insurance-program (builder's risk/CCIP) claims.

## 2. Actors & user stories

**Personas:** Claims Analyst (CA), Scheduling & Delay Specialist (SDS), Contract Administrator (CTA), Claims Review Board Manager (CRBM), Project Controls Auditor (PCA), Tenant Admin (TA).

- **US-1** As a CA, my queue ranks open claims by contractual deadline runway × dollar × severity (never FIFO); each case shows the asserted entitlement basis, notice timeliness, the party's claim history, and the copilot's proposed disposition with cited evidence.
- **US-2** As a CA, notice screening is first-class: a claim filed outside the contractual notice window is flagged on intake, since timely written notice is a condition precedent strictly enforced in many jurisdictions.
- **US-3** As an SDS, delay claims arrive with the analysis-method question framed (TIA/windows/as-planned-vs-as-built), the concurrent-delay window identified, and the schedule versions to request listed — I never concede compensable time off a bar chart.
- **US-4** As a CA on a DSC claim, the copilot frames the Type I comparison (encountered conditions vs the boring-log/baseline indications) and flags where the geotech record is disputed.
- **US-5** As a CRBM, rejections, approvals above threshold, and negotiated settlements come to me four-eyes: the analyst proposes, I approve; every rejection's note must cite the governing clause and record evidence for the determination letter.
- **US-6** As a CRBM, I see approval/rejection/negotiated rates, the claimed-vs-approved ratio, backlog aging, deadline runway, and schedule-impact mix — sliceable by claim type, entitlement basis, project, contract type, trade, and month.
- **US-7** As a PCA, I export an audit bundle showing every AI-assisted determination with reviewer identity, cited clauses, and timestamps for surety, lender, and agency review.
- **US-8** As a TA, the pack lands as tenant-scoped content only — datasets, model, dashboards, roles, agents — with zero Core changes.

## 3. Functional requirements

### 3.1 Pack manifest (CC-FR-001)

Standard v1. Categories: `construction, claims, change_orders, disputes, infrastructure`. Regulatory: `contract_law, far_dsc_clause, mechanics_lien, surety_bonds, prompt_payment`. Clouds: all.

### 3.2 Ontology (CC-FR-010) — deferred to pack-service

`Project`, `Contract`, `Party`, `Surety`, `Claim`, `ChangeOrder`, `DelayEvent`, `ScheduleUpdate`, `NoticeRecord`, `Backcharge`, `PayApplication`, `DeterminationLetter`. Carried today by the `construction_claims_core` semantic model + dataset schemas.

### 3.3 Semantic model — claims-ops KPI catalog (CC-FR-020) — authored as `construction_claims_core`

| Measure | Definition |
|---|---|
| `approval_rate` | approved determinations / all closures |
| `rejection_rate` | no-entitlement rejections / all closures |
| `negotiated_share` | partial-merit settlements / all closures |
| `approved_to_claimed_ratio` | dollars approved / dollars claimed (quantum discipline) |
| `delay_claim_share` | delay claims / all claims |
| `avg_claim_age_days` | backlog aging / cycle time |
| `late_notice_count` / `major_schedule_impact_count` | notice hygiene and 30+-day critical-path exposure |
| deadline runway | open claims by `deadline_bucket` (0-7 / 8-21 / over-21 days) |

Entities: claims → contracts → parties (chain, many_to_one at each hop). Grammar: categorical dims, cast-to-double measures, equality measure filters, expr_metric with nullif.

### 3.4 Agents (CC-FR-030..060) — proposal-mode

1. **Claim Intake Copilot (CC-FR-030)** — authored as case-triage TenantAgentConfig: entitlement-first, clause-grounded disposition proposal (approve_change_order / reject_no_entitlement / negotiate_partial_merit / request_substantiation / close_withdrawn_resolved), notice-and-deadline-first reasoning, never executes change orders, moves payments, or declares defaults. Bespoke LangGraph recipe deferred.
2. **Delay Analysis Assistant (CC-FR-040)** — deferred recipe: TIA/windows fragnet framing + concurrent-delay window detection from schedule updates.
3. **Quantum Review Builder (CC-FR-050)** — deferred recipe; interim: xgboost claim-outcome pipeline + measured-mile anchoring in copilot instructions + repeat-claim-contracts verified query.
4. **Notice & Deadline Sentinel (CC-FR-060)** — deferred recipe; interim: deadline_bucket dashboards + deadline-ordered verified query + high-value open-claims saved query.
5. **Analytics agent** — authored: construction_claims_core-grounded KPI Q&A.

Autonomous change-order execution, payment movement, or default declaration is forbidden — proposal-mode with human approval always (`CC_AUTONOMOUS_DETERMINATION_FORBIDDEN` at pack-service tier).

### 3.5 Connectors (CC-FR-080) — deferred to pack-service

**Read:** project-controls/PMIS (Procore, Autodesk Construction Cloud, Primavera P6/Unifier, e-Builder, Kahua), ERP/cost (CMiC, Sage 300 CRE, Viewpoint Vista), document management (daily reports, RFIs, submittals, boring logs). **Write adapters (proposal-mode):** execute change order in the contract/ERP system, post backcharge, release/hold progress payment, issue determination letter, transmit surety notice. Pack ships seed datasets in the landing shape; production connectors configure via Data > Connections.

### 3.6 Regulatory & doctrine guardrails (CC-FR-090)

- **Notice provisions** — timely written notice as condition precedent, strictly enforced in many jurisdictions; screen first on every claim.
- **Delay doctrine** — critical-path proof required (TIA/windows/as-planned-vs-as-built); concurrent delay commonly time-no-cost, apportionment jurisdictional.
- **DSC clause (FAR concept)** — Type I (differs from contract indications) vs Type II (unusual for the locality/work); boring-log comparison decisive.
- **Quantum** — total-cost disfavored, measured-mile preferred; total-cost pricing triggers substantiation, not summary rejection.
- **Payment** — pay-when-paid (timing) vs pay-if-paid (risk shift, express language required, unenforceable in some states); prompt-payment and mechanics-lien exposure tracked qualitatively (deadlines jurisdictional).
- **Surety** — notice-and-cure sequence before any default declaration; wrongful default creates its own exposure.

### 3.7 Roles & case schemas (CC-FR-100) — roles authored, schemas deferred

Roles: `Claims Analyst`, `Scheduling & Delay Specialist`, `Contract Administrator`, `Claims Review Board Manager` (sole disposition approver), `Project Controls Auditor` (read+audit only). Case schemas (deferred): `change_order_review`, `delay_claim_analysis`, `dsc_investigation`, `defect_backcharge_review`, `payment_dispute_review`, `acceleration_claim_review`.

## 4. Domain model & data

Authored materialization: 3 datasets (claims 26 / contracts 30 / parties 12 — seed rows encode an owner-furnished-equipment delay with concurrent contractor delay, a DSC rock claim with a boring-log dispute, a change order priced ~3x the measured-mile norm, a total-cost productivity claim, a roofing defect backcharge with surety notice pending, and a pay-if-paid payment dispute) · 1 semantic model (claims→contracts→parties chain) · 5 verified queries · 2 saved queries (incl. party→project network edges) · 3 dashboards (Claims Command Center, Entitlement & Schedule Impact, Party Risk & Recovery — 15 charts) · 5 dispositions · 6-case seeded queue · 5 roles · 2 agent configs · 10 grounding memories · 2 pipelines (isolation_forest contract-book anomaly, xgboost claim-outcome scorer). Deferred: guardrails, agent recipes, connectors, write adapters, eval sets, ontology, case schemas, model archetypes, display labels.

## 5. Business rules (CC-BR-*)

- **BR-1** No autonomous claim determination, change-order execution, payment movement, or default declaration — proposal-mode with human decision, CRBM four-eyes on rejections, settlements, and final determinations.
- **BR-2** Notice screening precedes entitlement analysis: notice timeliness, method, and recipient are documented on every claim before merits are argued.
- **BR-3** Contractual response deadlines outrank analysis depth: when the clock is short, propose an interim substantiation request rather than a rushed determination.
- **BR-4** No compensable delay concession without critical-path proof; concurrent-delay windows are identified before time or money is granted.
- **BR-5** Rejection notes must cite the governing contract clause and the record evidence relied upon (determination-letter standard).
- **BR-6** Total-cost quantum triggers a substantiation request (measured-mile or contemporaneous production records), not automatic rejection.
- **BR-7** No surety notice or default step without the contract's notice-and-cure sequence documented — wrongful default is its own exposure.
- **BR-8** Every AI-assisted determination preserves provenance (data/model/prompt/reviewer/timestamp); pattern-level over-rejection of one trade or party is monitored as a bias signal.

## 6. Dependencies

Windrose Core (BRDs 01–23), unmodified. External (deferred connectors): project-controls/PMIS platform of record, ERP/cost system, document-management repository, schedule files (P6) for delay analysis.

## 7. NFRs (deltas)

| Metric | Target |
|---|---|
| Triage proposal p95 latency | ≤ 10s |
| Contractual response-deadline breach rate (post-install) | 0 |
| Quantum leakage reduction (approved/claimed ratio discipline, 6mo) | measurable vs baseline |
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

Contractor-side claim preparation pack; CPM schedule authoring; P6 XER ingestion + automated fragnet extraction (natural v2 once schedule-file connectors ship); litigation/arbitration hold and discovery management; builder's-risk and wrap-up insurance claims; lien-waiver document generation until write adapters ship.
