# BRD 41 — `trust-safety-appeals` capability pack

**Deliverable type:** Capability Pack (BRD 23) · **Publisher:** Windrose · **Initial version:** 1.0.0
**Horizon:** 3 pack wave (post-BRD-32/33). Reference pattern: BRD 24/30/32.
**Status:** v1.0.0 authored, install pending (packctl validate passing); pack-service-tier components declared `deferred` in the manifest.

---

## 1. Overview

**Purpose.** Trust & safety appeals adjudication AI for online platforms: internal complaint-handling for content and account enforcement appeals (removals, suspensions, demonetizations, ranking restrictions) with statutory-deadline awareness, classifier false-positive detection, brigading/report-integrity screening, policy-gap escalation, and the overturn-rate feedback loop into enforcement quality. Sells to social/UGC platforms, marketplaces, gaming platforms, and dating apps — anyone carrying EU DSA / UK OSA process obligations.

**Why this vertical.** The DSA makes appeals a regulated workflow: statements of reasons for every restriction (Art. 17), an internal complaint-handling system whose decisions are timely, non-discriminatory, and never taken solely by automated means (Art. 20), out-of-court dispute settlement (Art. 21), and transparency reporting on complaint volumes, outcomes, and median decision time (Arts. 15/24); the UK OSA layers comparable complaints and transparency duties under Ofcom. Every determination is documented, contestable, and evidence-driven — the exact governed human-in-the-loop decision shape of the Windrose Core, and the alert-adjudication pattern is already proven by BRD 30/32. Uniquely, appeal outcomes are also the training labels for the enforcement classifiers — the human-correction→retrain loop is the product thesis itself.

**Business value.** Deadline-breach elimination (complaint-clock watch), reviewer throughput (triage pre-routing, duplicate collapse), enforcement-quality lift (overturn-rate segmentation feeding classifier retraining), report-integrity defense (brigading screens), regulator-ready transparency stats, and audit-ready decision files (every determination carries its findings + provenance).

**In scope.** Appeal intake triage copilot, complaint-deadline tracking, overturn/classifier-quality analytics, brigading/mass-report screening, compromised-account restore paths, policy-gap escalation + precedent loop, appeals KPI semantic model + dashboards, account-enforcement network analytics, DSA/OSA grounding, enforcement-anomaly + appeal-outcome pipelines.

**Out of scope.** First-instance content moderation and classifier serving (the enforcement stack is the customer's); user-facing appeal-submission UX; out-of-court dispute settlement body tooling; law-enforcement referrals; CSAM/NCMEC mandatory-reporting workflows (specialized legal regime).

## 2. Actors & user stories

**Personas:** Appeals Reviewer (AR), Senior Policy Reviewer (SPR), Escalations Specialist (ES), Appeals Operations Manager (AOM), Transparency & Audit Lead (TAL), Tenant Admin (TA).

- **US-1** As an AR, my queue ranks open appeals by deadline runway × severity × standing (never FIFO); each case shows the enforcement evidence (decision id, policy version, classifier band, report count), the account's history, and the copilot's proposed disposition with cited evidence.
- **US-2** As an AR on a classifier-initiated removal, I see the counter-speech/context signals (prior overturns on the same account, high-confidence score on quoted content) — and the platform's complaint decision is never taken solely by automated means: the copilot proposes, I decide.
- **US-3** As an SPR, mass-reported enforcements land with the report-burst evidence assembled (report counts vs baseline, prior overturned waves) so I judge the content, not the report volume.
- **US-4** As an ES, satire/parody, counter-speech, and newsworthiness edge cases route to me as policy-gap escalations with the precedent trail (prior escalations on the same question) attached.
- **US-5** As an AOM, restorations and final determinations come to me four-eyes: the reviewer proposes, I approve; every uphold's note must contain statement-of-reasons findings the appellant can be told.
- **US-6** As an AOM, I see overturn rate, uphold rate, escalation share, backlog aging, and deadline runway — sliceable by policy area, enforcement source, appeal type, standing, classifier band, and month — and rising overturn segments route to classifier retraining review.
- **US-7** As a TAL, I export the transparency-report cut (complaints received, decisions, outcome mix, aging by enforcement source) and the audit bundle showing every AI-assisted determination with reviewer identity, findings, and timestamps.
- **US-8** As a TA, the pack lands as tenant-scoped content only — datasets, model, dashboards, roles, agents — with zero Core changes.

## 3. Functional requirements

### 3.1 Pack manifest (TS-FR-001)

Standard v1. Categories: `trust_safety, content_moderation, appeals, platform_governance, marketplaces`. Regulatory: `eu_dsa, uk_online_safety_act`. Clouds: all.

### 3.2 Ontology (TS-FR-010) — deferred to pack-service

`Account`, `Content`, `EnforcementDecision`, `Policy`, `PolicyVersion`, `Appeal`, `Report`, `Reporter`, `Strike`, `StatementOfReasons`, `ComplaintClock`, `ODSReferral`. Carried today by the `appeals_core` semantic model + dataset schemas.

### 3.3 Semantic model — appeals KPI catalog (TS-FR-020) — authored as `appeals_core`

| Measure | Definition |
|---|---|
| `overturn_rate` | overturned appeals / all closures (classifier-quality feedback) |
| `uphold_rate` | upheld enforcements / all closures |
| `escalation_share` | policy-team escalations / all closures (policy-gap pressure) |
| `automated_source_share` | appeals contesting classifier decisions / all appeals |
| `repeat_appellant_share` | repeat-standing appeals / all appeals |
| `avg_appeal_age_days` | backlog aging / cycle time |
| `total/avg_report_count` | report volume behind enforcements (brigading surface) |
| deadline runway | open appeals by `deadline_bucket` (0-5 / 6-15 / over-15 days) |

Entities: appeals / enforcements / accounts (chain: appeals →(decision_id) enforcements →(account_id) accounts, many_to_one). Grammar: categorical dims, cast-to-double measures, equality measure filters, expr_metric with nullif.

### 3.4 Agents (TS-FR-030..060) — proposal-mode

1. **Appeal Intake Copilot (TS-FR-030)** — authored as case-triage TenantAgentConfig: evidence-grounded disposition proposal (overturn_restore / uphold_enforcement / partial_modify_action / escalate_policy_team / close_duplicate_appeal), deadline-first reasoning, never restores/removes or promises outcomes. Bespoke LangGraph recipe deferred.
2. **Statement-of-Reasons Drafter (TS-FR-040)** — deferred recipe: findings-cited Art. 17 notice assembly from the determination record.
3. **Brigading/Report-Integrity Screener (TS-FR-050)** — deferred recipe; interim: isolation_forest enforcement-anomaly pipeline + report-volume verified query.
4. **Complaint-Deadline Sentinel (TS-FR-060)** — deferred recipe; interim: deadline_bucket dashboards + deadline-ranked saved query.
5. **Analytics agent** — authored: appeals_core-grounded KPI Q&A.

Autonomous restoration, removal, suspension, or strike change is forbidden — proposal-mode with human approval always; DSA Art. 20 additionally forbids complaint decisions taken solely by automated means (`TS_AUTONOMOUS_ENFORCEMENT_FORBIDDEN` at pack-service tier).

### 3.5 Connectors (TS-FR-080) — deferred to pack-service

**Read:** moderation/enforcement platforms and queues, classifier scoring stores, user-report pipelines, identity/session-anomaly systems (compromised-account evidence), brand-rights registries (counterfeit authorization), ODS-body intake feeds. **Write adapters (proposal-mode):** restore content/account, lift or modify enforcement action, expunge compromise-window strikes, send statement-of-reasons / outcome notices, route corrected labels to classifier retraining. Pack ships seed datasets in the landing shape; production connectors configure via Data > Connections.

### 3.6 Regulatory guardrails (TS-FR-090)

- **DSA Art. 17** — statement of reasons for every restriction: facts relied on, automated-means disclosure, legal/ToS ground, redress information.
- **DSA Art. 20** — internal complaint handling free and electronic for at least 6 months; timely, diligent, non-arbitrary, non-discriminatory; reversal on sufficient grounds; never solely automated, qualified staff.
- **DSA Arts. 15/24 + 21/23** — transparency reporting (complaints, outcomes, median decision time, automated-tool accuracy indicators); out-of-court dispute settlement engagement; misuse measures (warn-then-suspend frequent violators AND frequent manifestly-unfounded reporters — the brigading lever).
- **UK OSA** — accessible complaints procedures and Ofcom-overseen transparency duties (qualitative — thresholds service-tier dependent).

### 3.7 Roles & case schemas (TS-FR-100) — roles authored, schemas deferred

Roles: `Appeals Reviewer`, `Senior Policy Reviewer`, `Escalations Specialist`, `Appeals Operations Manager` (sole disposition approver), `Transparency & Audit Lead` (read+audit only). Case schemas (deferred): `appeal_review`, `policy_escalation`, `report_integrity_review`, `compromised_account_review`, `duplicate_appeal_check`.

## 4. Domain model & data

Authored materialization: 3 datasets (appeals 26 / enforcements 30 / accounts 12 — seed rows encode a counter-speech classifier false positive, a repeat-infringer counterfeit appeal with new authorization docs, a mass-reported creator riding a 214-report brigading burst with an overturned prior wave, a satire demonetization policy-gap, a compromised-account suspension with the spam-blast evidence, and a duplicate second appeal on a pending decision) · 1 semantic model · 5 verified queries · 2 saved queries (incl. account→enforcement-action network edges) · 3 dashboards (Appeals Command Center, Overturn & Classifier Quality, DSA Compliance & Transparency — 15 charts) · 5 dispositions · 6-case seeded queue · 5 roles · 2 agent configs · 10 grounding memories · 2 pipelines (isolation_forest enforcement anomaly, xgboost appeal-outcome scorer). Deferred: guardrails, agent recipes, connectors, write adapters, eval sets, ontology, case schemas, model archetypes, display labels.

## 5. Business rules (TS-BR-*)

- **BR-1** No autonomous restoration, removal, suspension, or strike change — proposal-mode with human decision, AOM four-eyes on final determinations; complaint decisions never taken solely by automated means (DSA Art. 20).
- **BR-2** Complaint-handling deadlines outrank investigation completeness: the clock is watched first and a determination is never silently late.
- **BR-3** Every determination carries statement-of-reasons findings the appellant can be told, including automated-means disclosure (Art. 17 standard).
- **BR-4** Report volume is never evidence: mass-reported enforcements are judged on content assessment; confirmed coordination routes to report-integrity review (Art. 23 covers abusive reporters).
- **BR-5** A repeat infringer's history is a risk signal, not proof — new evidence (e.g. authorization docs) is verified on its own merits.
- **BR-6** Compromised-account violations follow the restore-and-secure path: owner verified, credentials reset, compromise-window strikes expunged — no penalty on the legitimate owner.
- **BR-7** One decision, one live appeal: duplicate second appeals are closed with a link to the pending appeal, never adjudicated in parallel.
- **BR-8** Every AI-assisted determination preserves provenance (policy/model/data/prompt/reviewer/timestamp) — appeal outcomes are classifier training labels and transparency-report figures, and outcome disparities across user groups are monitored (non-discrimination).

## 6. Dependencies

Windrose Core (BRDs 01–23), unmodified. External (deferred connectors): the customer's enforcement/moderation stack, classifier scoring stores, report pipelines, identity/session-anomaly systems, brand-rights registries.

## 7. NFRs (deltas)

| Metric | Target |
|---|---|
| Triage proposal p95 latency | ≤ 10s |
| Complaint-deadline breach rate (post-install) | 0 |
| Overturned-decision label routing to retraining review | 100% |
| Dashboard chart warm render | 100% real data at install |
| Idempotent re-install | all no-ops |

## 8. Acceptance criteria

- **AC-1** `packctl validate` passes; install exits 0 with 0 failed actions.
- **AC-2** All 15 dashboard charts resolve real rows at install.
- **AC-3** 6-case queue seeded from open appeals; severities/deadlines match the dataset.
- **AC-4** 5 roles bound to permission groups with differentiated live capabilities.
- **AC-5** Re-install is fully idempotent.
- **AC-6** Disposition taxonomy uses only the Core's closed category set.
- **AC-7** Pack installs on unmodified Core — zero service/helm/roles_actions.yaml diffs.
- **AC-8** Pack-service-tier capabilities appear verbatim in the `deferred` ledger, never faked.

## 9. Out of scope / future

First-instance moderation and classifier serving; user-facing appeal submission UX; ODS-body tooling; CSAM/mandatory-reporting regimes; ad-policy and commerce-policy appeals as taxonomy extensions; multi-language statement-of-reasons generation until the drafter recipe ships; enforcement-system write adapters until pack-service ships.
