# BRD 39 — `credit-disputes` capability pack

**Deliverable type:** Capability Pack (BRD 23) · **Publisher:** Datacern · **Initial version:** 1.0.0
**Horizon:** 3 pack wave (post-BRD-32 pattern). Reference pattern: BRD 24/30/32.
**Status:** v1.0.0 authored, install pending; pack-service-tier components declared `deferred` in the manifest.

---

## 1. Overview

**Purpose.** FCRA credit-**reporting** dispute investigation AI for the furnisher and CRA side: section 611 reinvestigations with regulatory-clock awareness (30/45-day windows, e-OSCAR ACDV response deadlines, 605B identity-theft blocks on a 4-business-day clock), reasonable-investigation depth beyond data matching, obsolescence and duplicate-tradeline detection, and documented frivolous-dispute handling. Sells to banks and lenders as furnishers, consumer reporting agencies, debt buyers/collectors, and fintech servicers.

**Not the card-disputes pack.** This pack is deliberately distinct from `card-disputes` (BRD 32). BRD 32 governs Reg E / Reg Z **transaction** disputes — whether a charge stands and who eats the money (provisional credit, chargebacks, merchant recovery). This pack governs FCRA **reporting** disputes — whether what a furnisher tells the credit bureaus about a consumer is accurate, complete, and timely (corrections, deletions, blocks, notices). Different statutes (FCRA 611/623(b)/605B + Reg V vs. Reg E/Z + network rules), different clocks (30/45 days and 4 business days vs. 10 business days and 2 billing cycles), different counterparties (CRAs and furnishers vs. merchants and networks), different governed action (change what is reported vs. move money). A card dispute can *trigger* a reporting dispute (the account must be marked disputed, and a resolved billing error must not be reported delinquent) — that interplay is a grounding memory here, not an overlap.

**Why this vertical.** FCRA reinvestigations carry hard statutory deadlines (30/45-day windows, 5-business-day forward/notice steps, 4-business-day 605B blocks) and dispute volumes at the nationwide CRAs run to tens of millions of items per year, with credit-reporting complaints persistently the largest CFPB complaint category. The CFPB has repeatedly flagged furnisher dispute-handling — especially perfunctory "match-and-verify" ACDV responses — in supervisory highlights and enforcement, and FCRA private litigation over unreasonable investigations is a mature, growing docket. Every determination is documented, disputable, and evidence-driven — the exact governed human-in-the-loop decision shape of the Datacern Core, proven by BRD 30 (banking-aml) and BRD 32 (card-disputes).

**Business value.** Deadline-breach elimination (611/605B clock watch, day-26 ACDVs never slip), investigator throughput (triage pre-routing), litigation-loss reduction (reasonable-investigation depth on not-mine and identity-theft claims), furnisher-accuracy exam readiness (every determination carries record-level findings + provenance), and repeat-dispute cost control (documented frivolous handling instead of endless re-verification).

**In scope.** Reinvestigation triage copilot, FCRA/605B deadline tracking, ACDV channel awareness, identity-theft block workflow, obsolescence and duplicate-tradeline detection, frivolous-determination documentation, dispute-ops KPI semantic model + dashboards, consumer-creditor network analytics, FCRA/Reg V grounding, tradeline-anomaly + dispute-outcome pipelines.

**Out of scope.** Reg E/Z transaction disputes and chargebacks (the `card-disputes` pack, BRD 32); credit-score modeling or adverse-action decisioning; Metro 2 furnishing pipeline itself (this pack investigates disputes about furnished data, it does not generate the monthly furnishing file); debt collection communications (FDCPA workflows); consumer-side credit-repair tooling.

## 2. Actors & user stories

**Personas:** Dispute Investigator (DI), Identity Theft Specialist (ITS), Furnisher Data Analyst (FDA), Dispute Operations Manager (DOM), FCRA Compliance Auditor (FCA), Tenant Admin (TA).

- **US-1** As a DI, my queue ranks open disputes by deadline runway × severity (never FIFO); each case shows the tradeline evidence, the consumer's dispute history, the intake channel, and the copilot's proposed disposition with cited record evidence.
- **US-2** As a DI on an e-OSCAR ACDV, I see the CRA's window countdown (day 26 of 30 is a red flag, not a backlog item) and the copilot reminds me that a late response means deletion by default — and that answering by re-reading the disputed field is not an investigation.
- **US-3** As an ITS, 605B block requests land in my queue with the FTC report, proof of identity, and the 4-business-day clock front and center; decline/rescind grounds (misrepresentation, goods received) are checked explicitly.
- **US-4** As an FDA, duplicate collection tradelines (same debt, two collectors), re-aged delinquency dates, and obsolete items surface from the tradeline book with the chain-of-assignment and commencement-of-delinquency evidence assembled.
- **US-5** As a DOM, corrections, deletions, and frivolous determinations come to me four-eyes: the investigator proposes, I approve; every frivolous closure must carry the notice with reasons, and every verify-accurate must cite record-level findings.
- **US-6** As a DOM, I see correction rate, verified-accurate rate, deletion rate, identity-theft share, deadline runway, channel mix, and repeat-dispute share — sliceable by reason, channel, tradeline type, furnisher system, and month.
- **US-7** As an FCA, I export an exam bundle showing every AI-assisted determination with reviewer identity, findings, and timestamps — plus the pattern-level verify-accurate tilt monitoring the CFPB looks for.
- **US-8** As a TA, the pack lands as tenant-scoped content only — datasets, model, dashboards, roles, agents — with zero Core changes.

## 3. Functional requirements

### 3.1 Pack manifest (CR-FR-001)

Standard v1. Categories: `banking, credit_reporting, disputes, furnisher, compliance`. Regulatory: `fcra, reg_v, cfpb`. Clouds: all.

### 3.2 Ontology (CR-FR-010) — deferred to pack-service

`Consumer`, `Tradeline`, `Furnisher`, `CRA`, `Dispute`, `ACDV`, `IdentityTheftReport`, `Block`, `DeadlineClock`, `ReinvestigationNotice`, `FrivolousNotice`, `MixedFile`. Carried today by the `credit_disputes_core` semantic model + dataset schemas.

### 3.3 Semantic model — dispute-ops KPI catalog (CR-FR-020) — authored as `credit_disputes_core`

| Measure | Definition |
|---|---|
| `correction_rate` | tradeline corrections / all closures (furnisher accuracy signal) |
| `verified_accurate_rate` | verified-accurate determinations / all closures |
| `deletion_rate` | deletions (unverifiable or obsolete) / all closures |
| `identity_theft_share` | identity-theft claims / all disputes |
| `repeat_disputer_share` | consumers with >5 prior disputes / consumer book |
| `avg_dispute_age_days` | backlog aging / cycle time |
| `avg_deadline_runway_days` | days remaining on the governing FCRA clock |
| channel mix | `acdv / direct / court_document` dispute counts |
| deadline runway | open disputes by `deadline_bucket` (0-5 / 6-15 / over-15 days) |

Entities: disputes / tradelines / consumers (chain, disputes→tradelines→consumers many_to_one). Grammar: categorical dims, cast-to-double measures, equality measure filters, expr_metric with nullif.

### 3.4 Agents (CR-FR-030..060) — proposal-mode

1. **Reinvestigation Copilot (CR-FR-030)** — authored as case-triage TenantAgentConfig: record-evidence-grounded disposition proposal (correct_tradeline / verify_accurate_as_reported / delete_unverifiable / escalate_identity_theft_review / close_frivolous_documented), deadline-first reasoning, reasonable-investigation depth beyond data matching, never changes what is reported or promises outcomes. Bespoke LangGraph recipe deferred.
2. **ACDV Response Builder (CR-FR-040)** — deferred recipe: assembles the furnisher's ACDV answer from the servicing record with the CRA-window countdown.
3. **605B Block Sentinel (CR-FR-050)** — deferred recipe; interim: identity-theft docket verified query + 4-business-day clock in queue notes and deadline buckets.
4. **Obsolescence / Duplicate-Tradeline Auditor (CR-FR-060)** — deferred recipe; interim: isolation_forest tradeline-anomaly pipeline + consumer-creditor network edges saved query.
5. **Analytics agent** — authored: credit_disputes_core-grounded KPI Q&A.

Autonomous furnishing of corrections, deletions, blocks, or consumer notices is forbidden — proposal-mode with human approval always (`CR_AUTONOMOUS_REPORTING_CHANGE_FORBIDDEN` at pack-service tier).

### 3.5 Connectors (CR-FR-080) — deferred to pack-service

**Read:** e-OSCAR ACDV/AUD feeds, Metro 2 furnishing extracts from servicing platforms (core banking, card, auto, mortgage, student loan, collections), FTC IdentityTheft.gov report intake, credit-monitoring dispute portals, letter-vendor mail intake. **Write adapters (proposal-mode):** ACDV answer via e-OSCAR, Metro 2 corrections/deletions to all CRAs furnished, 605B block apply/rescind, mark-account-disputed, reinvestigation-results and frivolous-determination notices. Pack ships seed datasets in the landing shape; production connectors configure via Data > Connections.

### 3.6 Regulatory guardrails (CR-FR-090)

- **FCRA 611 (15 U.S.C. 1681i)** — 30-day reinvestigation (45 when the consumer adds relevant information mid-stream), 5-business-day forward to furnisher, 5-business-day results notice, delete-if-unverified, reinsertion only with furnisher certification + 5-business-day reinsertion notice.
- **FCRA 623(b) + Reg V (12 CFR 1022)** — furnisher reasonable investigation on ACDV referral, review of all CRA-provided information, response inside the CRA window, correction to every CRA furnished; direct-dispute duties incl. frivolous handling.
- **FCRA 605B** — identity-theft block within 4 business days of a valid identity theft report + proof of identity; furnisher notification; no re-furnishing of blocked items; decline/rescind grounds only.
- **FCRA 605** — 7-year adverse-item period (running from 180 days after commencement of delinquency for charge-offs/collections), 10-year chapter 7 bankruptcy period; no re-aging.
- **Frivolous determinations (611(a)(3))** — permitted only with the 5-business-day notice stating reasons and information needed; each round still checked for new information.
- **CFPB/litigation** — reasonable investigation beyond data matching; pattern-of-verification monitoring; dispute-flag reporting (623(a)(3)) while pending.

### 3.7 Roles & case schemas (CR-FR-100) — roles authored, schemas deferred

Roles: `Dispute Investigator`, `Identity Theft Specialist`, `Furnisher Data Analyst`, `Dispute Operations Manager` (sole disposition approver), `FCRA Compliance Auditor` (read+audit only). Case schemas (deferred): `reinvestigation`, `acdv_response`, `identity_theft_block_review`, `obsolescence_review`, `duplicate_tradeline_review`, `frivolous_determination`.

## 4. Domain model & data

Authored materialization: 3 datasets (disputes 26 / tradelines 30 / consumers 12 — seed rows encode an e-OSCAR ACDV on day 26 of 30, a 605B block request with FTC report on the 4-business-day clock, a data-matches-but-litigation-history "not mine", a duplicate collection tradeline across two collectors, an obsolete 7+ year charge-off still reporting, and a serial disputer's sixth round on the same accurate tradeline) · 1 semantic model (`credit_disputes_core`, 25 measures + 5 rate expr_metrics) · 5 verified queries · 2 saved queries (incl. consumer→creditor network edges) · 3 dashboards (Dispute Operations Center, FCRA Clock & Channels, Accuracy & Outcomes — 15 charts) · 5 dispositions · 6-case seeded queue · 5 roles · 2 agent configs · 10 grounding memories · 2 pipelines (isolation_forest tradeline anomaly, xgboost dispute-outcome scorer). Deferred: guardrails, agent recipes, connectors, write adapters, eval sets, ontology, case schemas, model archetypes, display labels.

## 5. Business rules (CR-BR-*)

- **BR-1** No autonomous change to what is reported about a consumer — no correction, deletion, block, or notice without proposal-mode + human decision, DOM four-eyes on all final determinations.
- **BR-2** The FCRA clock outranks investigation completeness planning: a day-26 ACDV is answered inside the CRA window or the item deletes by default — escalate, never slip.
- **BR-3** A verify-accurate determination requires record-level findings (application, servicing ledger, assignment chain) — name/SSN/DOB matching alone never suffices.
- **BR-4** A valid 605B block request is honored within 4 business days; decline/rescind only on the statutory grounds, documented.
- **BR-5** Frivolous closures require the 5-business-day notice with reasons and what is needed — and each repeat round is first checked for new information.
- **BR-6** Obsolescence runs from 180 days after commencement of delinquency — never from charge-off, assignment, or payment dates; suspected re-aging escalates.
- **BR-7** Corrections and deletions propagate to every CRA the item was furnished to; deleted items are never reinserted without furnisher certification + consumer notice.
- **BR-8** Every AI-assisted determination preserves provenance (data/model/prompt/reviewer/timestamp) and feeds pattern-level verify-accurate-tilt monitoring — CFPB furnisher-accuracy exam defense.

## 6. Dependencies

Datacern Core (BRDs 01–23), unmodified. External (deferred connectors): e-OSCAR participation, Metro 2 extracts from the furnisher's servicing platforms, FTC report intake, letter vendor.

## 7. NFRs (deltas)

| Metric | Target |
|---|---|
| Triage proposal p95 latency | ≤ 10s |
| FCRA deadline-breach rate (post-install) | 0 |
| Verified-accurate reversals on repeat rounds (6mo) | ≥ −20% (fewer re-litigated verifications) |
| Dashboard chart warm render | 100% real data at install |
| Idempotent re-install | all no-ops |

## 8. Acceptance criteria

- **AC-1** `packctl validate` passes; install exits 0 with 0 failed actions.
- **AC-2** All 15 dashboard charts resolve real rows at install.
- **AC-3** 6-case queue seeded from open disputes; severities/deadlines match the dataset.
- **AC-4** 5 roles bound to permission groups with differentiated live capabilities.
- **AC-5** Re-install is fully idempotent.
- **AC-6** Disposition taxonomy uses only the Core's closed category set.
- **AC-7** Pack installs on unmodified Core — zero service/helm/roles_actions.yaml diffs.
- **AC-8** Pack-service-tier capabilities appear verbatim in the `deferred` ledger, never faked.

## 9. Out of scope / future

Reg E/Z transaction disputes (card-disputes pack, BRD 32); Metro 2 furnishing-file generation and pre-furnish accuracy screening (natural v2 extension); FDCPA collection-communication workflows; consumer-facing dispute portals; mixed-file resolution tooling beyond detection; e-OSCAR write adapters until pack-service ships.
