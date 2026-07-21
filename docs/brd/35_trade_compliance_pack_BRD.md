# BRD 35 — `trade-compliance` capability pack

**Deliverable type:** Capability Pack (BRD 23) · **Publisher:** Datacern · **Initial version:** 1.0.0
**Horizon:** 3 pack wave (post-BRD-32). Reference pattern: BRD 24/30/32.
**Status:** v1.0.0 authored, install pending; pack-service-tier components declared `deferred` in the manifest.

---

## 1. Overview

**Purpose.** Customs and trade-compliance decisioning AI for the importer/broker side: HS classification review with GRI-ordered reasoning under the reasonable-care standard (19 USC 1484), denied-party screening adjudication (OFAC SDN, BIS Entity List, 50% rule), export/dual-use license-determination escalation, and origin/transshipment verification — with deadline-runway awareness on every open item. Sells to importers, customs brokers, freight forwarders, and in-house trade-compliance teams.

**Why this vertical.** Every US entry carries strict legal duties the importer cannot delegate — reasonable care in classification/valuation/origin, five-year recordkeeping, and strict-liability-flavored sanctions exposure where releasing one shipment to a blocked party is a reportable violation. Volumes are high, screening false positives dominate analyst time, and each determination is documented, disputable, and evidence-driven — the exact governed human-in-the-loop decision shape of the Datacern Core, and the alert-adjudication pattern is already proven by BRD 30 (banking-aml) and BRD 32 (card-disputes).

**Business value.** Screening-analyst throughput (evidence-first false-positive clearing), zero unresolved-match releases, duty-exposure reduction (tariff-engineering and misdeclared-origin catches with prior-disclosure timing preserved), penalty mitigation (documented reasonable care + prompt disclosure assessment), and audit-ready decision files (every disposition carries findings + provenance for a CBP focused assessment or OFAC program review).

**In scope.** Review-queue triage copilot (classification reviews + screening alerts), deadline/runway tracking, sanctions match adjudication workflow, origin/transshipment watch, trade-compliance KPI semantic model + dashboards, importer-lane sourcing network analytics, HTS/OFAC/EAR grounding, shipment-anomaly + review-outcome pipelines.

**Out of scope.** Duty calculation/entry filing engines (broker ABI systems of record); export-side AES filing; FTA qualification solicitation campaigns; drawback claims; ITAR/USML licensing (defense articles); customs bonds and surety management.

## 2. Actors & user stories

**Personas:** Classification Analyst (CA), Screening Analyst (SA), Licensing Specialist (LS), Trade Compliance Manager (TCM), Trade Audit Lead (TAL), Tenant Admin (TA).

- **US-1** As a CA, my queue ranks open review items by deadline runway × duty risk × severity (never FIFO); each case shows the shipment evidence, the declared vs described classification, and the copilot's proposed disposition with cited row-level evidence.
- **US-2** As a CA on a repeat lane, a declared-code vs invoice-description mismatch that was already corrected once (TC-4007) surfaces as a reasonable-care red flag with a prior-disclosure assessment prompt — not as a routine review.
- **US-3** As an SA, fuzzy matches arrive with the distinguishing-evidence checklist assembled (address, registration, DOB, 50%-rule ownership) and the party's full alert history (e.g., Altay Instruments: released at 0.79 and 0.81, now matching at 0.88) — and the copilot never proposes release on history or score alone.
- **US-4** As an LS, Entity List matches and dual-use ECCN questions land in my escalation queue with the license-requirement analysis framed (list-entry scope, destination, end use/end user).
- **US-5** As a TCM, holds, corrected entries, and releases come to me four-eyes: the analyst proposes, I approve; every release of a screening match must carry a documented distinguishing rationale.
- **US-6** As a TCM, I see classification correction rate, screening false-positive rate, true-hit count, duty-risk mix, backlog aging, and deadline runway — sliceable by HS chapter, product category, origin, list, lane, mode, and month.
- **US-7** As a TAL, I export an audit bundle showing every AI-assisted disposition with reviewer identity, findings, and timestamps (19 USC 1508 / 19 CFR 163 five-year records).
- **US-8** As a TA, the pack lands as tenant-scoped content only — datasets, model, dashboards, roles, agents — with zero Core changes.

## 3. Functional requirements

### 3.1 Pack manifest (TC-FR-001)

Standard v1. Categories: `trade, customs, imports, sanctions, compliance`. Regulatory: `cbp, htsus, ofac_sdn, bis_entity_list, ear`. Clouds: all.

### 3.2 Ontology (TC-FR-010) — deferred to pack-service

`Shipment`, `EntryLine`, `HsCode`, `OriginClaim`, `TradingPartner`, `ScreeningAlert`, `WatchListEntry`, `LicenseDetermination`, `DutyExposure`, `PriorDisclosure`, `DeadlineClock`. Carried today by the `trade_core` semantic model + dataset schemas.

### 3.3 Semantic model — trade-compliance KPI catalog (TC-FR-020) — authored as `trade_core`

| Measure | Definition |
|---|---|
| `classification_correction_rate` | corrected entries / classification reviews |
| `screening_false_positive_rate` | released false positives / screening alerts |
| `screening_true_hit_rate` | confirmed sanctions hits / screening alerts |
| `sanctions_true_hit_count` | confirmed hits (hold-block-report) |
| `avg_match_score` | screening match-score quality by list |
| `high_duty_risk_share` | high duty/penalty exposure share of the book |
| `avg_item_age_days` | backlog aging / cycle time |
| deadline runway | open items by `deadline_bucket` (0-5 / 6-15 / over-15 days) |
| `total_entered_value` | shipment value by lane / mode / broker |

Entities: review_items / shipments / trading partners (chain: review_items → shipments → partners, many_to_one). Grammar: categorical dims, cast-to-double measures, equality measure filters, expr_metric with nullif.

### 3.4 Agents (TC-FR-030..060) — proposal-mode

1. **Review Triage Copilot (TC-FR-030)** — authored as case-triage TenantAgentConfig: evidence-grounded disposition proposal (confirm_classification / reclassify_correct_entry / sanctions_true_hit_hold / escalate_licensing_review / release_false_positive), deadline-first reasoning, GRI-ordered classification analysis, distinguishing-identifier screening adjudication, never holds/releases shipments or files entries. Bespoke LangGraph recipe deferred.
2. **Screening Match Adjudicator (TC-FR-040)** — deferred recipe: identifier comparison + 50%-rule ownership research + distinguishing-rationale drafting.
3. **License Determination Assistant (TC-FR-050)** — deferred recipe; interim: escalate_licensing_review disposition + EAR/Entity List grounding memories.
4. **Origin Verification Sentinel (TC-FR-060)** — deferred recipe; interim: isolation_forest shipment-anomaly pipeline + importer-lane network saved query.
5. **Analytics agent** — authored: trade_core-grounded KPI Q&A.

Autonomous shipment holds/releases, entry filings, or regulator communications are forbidden — proposal-mode with human approval always (`TC_AUTONOMOUS_RELEASE_FORBIDDEN` at pack-service tier).

### 3.5 Connectors (TC-FR-080) — deferred to pack-service

**Read:** broker/ABI entry feeds and ACE reports, TMS/forwarding platforms (CargoWise-class), ERP purchase/supplier masters, denied-party screening vendors' consolidated list feeds, carrier manifests. **Write adapters (proposal-mode):** corrected entry / post-summary correction via the broker, hold/release instructions to broker/forwarder systems, prior-disclosure and voluntary self-disclosure drafts (CBP/OFAC/BIS), license applications. Pack ships seed datasets in the landing shape; production connectors configure via Data > Connections.

### 3.6 Regulatory guardrails (TC-FR-090)

- **Reasonable care (19 USC 1484)** — importer-of-record responsibility for classification/valuation/origin; documented analyses and binding rulings as evidence; repeating a corrected practice negates it.
- **Penalties & prior disclosure (19 USC 1592)** — culpability-scaled penalties; valid prior disclosure before/without knowledge of an investigation substantially mitigates; timing matters.
- **OFAC sanctions** — SDN blocking, 50 Percent Rule ownership analysis, hold-block-report discipline; no release while a plausible match is unresolved.
- **EAR / Entity List** — supplemental license requirements per list entry (often presumption of denial), ECCN × destination × end-use/end-user analysis, re-export reach of US-origin items.
- **Recordkeeping (19 USC 1508 / 19 CFR 163)** — five years from entry; adjudication rationale retained on the same footing.

### 3.7 Roles & case schemas (TC-FR-100) — roles authored, schemas deferred

Roles: `Classification Analyst`, `Screening Analyst`, `Licensing Specialist`, `Trade Compliance Manager` (sole disposition approver), `Trade Audit Lead` (read+audit only). Case schemas (deferred): `hs_classification_review`, `screening_adjudication`, `origin_verification`, `license_determination`, `prior_disclosure_review`.

## 4. Domain model & data

Authored materialization: 3 datasets (review items 26 / shipments 30 / trading partners 12 — seed rows encode a repeat tariff-engineering reclassification attempt, an SDN fuzzy match at 0.88 with two prior released alerts on the same supplier, an Entity List match on a new re-export consignee, a misdeclared-origin transshipment suspicion on high-value solar modules, a high-duty-delta classification on a new product line, and a dual-use license-determination question) · 1 semantic model · 5 verified queries · 2 saved queries (incl. importer→lane network edges) · 3 dashboards (Trade Compliance Command Center, Screening & Sanctions, Classification & Duty Risk — 15 charts) · 5 dispositions · 6-case seeded queue · 5 roles · 2 agent configs · 10 grounding memories · 2 pipelines (isolation_forest shipment anomaly, xgboost review-outcome scorer). Deferred: guardrails, agent recipes, connectors, write adapters, eval sets, ontology, case schemas, model archetypes, display labels.

## 5. Business rules (TC-BR-*)

- **BR-1** No autonomous shipment hold/release, entry filing, or regulator communication — proposal-mode with human decision, TCM four-eyes on all dispositions.
- **BR-2** No release while a plausible denied-party match is unresolved — deadline pressure accelerates adjudication, never the release.
- **BR-3** A screening match is cleared only on documented distinguishing evidence (address, DOB, registration, 50%-rule ownership) — never on match score or alert history alone.
- **BR-4** An Entity List match triggers a license-requirement analysis specific to the list entry — neither automatic block nor automatic release.
- **BR-5** A declared-code vs product-description mismatch on a lane with a prior corrected entry is a reasonable-care red flag: reclassify and assess prior disclosure covering intervening entries.
- **BR-6** Origin is established by substantial transformation with production records — certificates alone do not close a transshipment question.
- **BR-7** Classification analysis applies the GRIs in order (heading terms and section/chapter notes first); uncertain high-recurrence items warrant a binding-ruling recommendation.
- **BR-8** Every AI-assisted disposition preserves provenance (data/model/prompt/reviewer/timestamp) — CBP focused-assessment and OFAC program-review defense; screening-threshold tuning requires adjudication-history review.

## 6. Dependencies

Datacern Core (BRDs 01–23), unmodified. External (deferred connectors): broker ABI/ACE feeds, TMS/ERP systems, denied-party list vendor credentials.

## 7. NFRs (deltas)

| Metric | Target |
|---|---|
| Triage proposal p95 latency | ≤ 10s |
| Unresolved-match release rate (post-install) | 0 |
| Screening false-positive clearance time (6mo) | ≥ 30% reduction |
| Dashboard chart warm render | 100% real data at install |
| Idempotent re-install | all no-ops |

## 8. Acceptance criteria

- **AC-1** `packctl validate` passes; install exits 0 with 0 failed actions.
- **AC-2** All 15 dashboard charts resolve real rows at install.
- **AC-3** 6-case queue seeded from open review items; severities/deadlines match the dataset.
- **AC-4** 5 roles bound to permission groups with differentiated live capabilities.
- **AC-5** Re-install is fully idempotent.
- **AC-6** Disposition taxonomy uses only the Core's closed category set.
- **AC-7** Pack installs on unmodified Core — zero service/helm/roles_actions.yaml diffs.
- **AC-8** Pack-service-tier capabilities appear verbatim in the `deferred` ledger, never faked.

## 9. Out of scope / future

Export-side AES filing and ITAR/USML licensing; duty calculation and entry-filing engines; FTA qualification campaigns and drawback (natural v2 extensions); forced-labor (UFLPA) supply-chain tracing (candidate companion pack); broker write adapters until pack-service ships.
