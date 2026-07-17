# BRD 51 — `tax-notices` capability pack

**Deliverable type:** Capability Pack (BRD 23) · **Publisher:** Windrose · **Initial version:** 1.0.0
**Horizon:** 3 pack wave (post-BRD-32 pattern). Reference pattern: BRD 24/30/32.
**Status:** v1.0.0 authored, install pending (packctl, Core-neutral); pack-service-tier components declared `deferred` in the manifest.

---

## 1. Overview

**Purpose.** Corporate tax notice and exemption-certificate resolution AI: notice intake triage with jurisdictional-deadline awareness (response windows forfeit appeal rights when missed), penalty-abatement workflow (first-time abatement / reasonable cause), economic-nexus questionnaire handling post-Wayfair, exemption/resale certificate audit remediation, information-mismatch (CP2000-style) response, and duplicate-notice reconciliation. Sells to corporate tax departments, tax-compliance BPOs and firms, multi-state retailers and SaaS sellers (sales tax), and payroll providers.

**Why this vertical.** Every mid-size multi-state business drowns in agency mail: IRS, ~46 state DORs, and thousands of local jurisdictions issue assessments, penalty notices, mismatches, and questionnaires — each with a hard response window whose expiry converts a contestable proposal into a final liability. Post-Wayfair economic nexus multiplied the registration surface; exemption-certificate hygiene decides sales-tax audits; penalties are winnable (FTA/reasonable cause) while interest is not. Every determination is documented, deadline-bound, and evidence-driven — the exact governed human-in-the-loop decision shape of the Windrose Core, proven by the BRD 30/32 adjudication packs.

**Business value.** Deadline-breach elimination (no forfeited appeal rights), penalty-dollar recovery (abatement rate lift on FTA/reasonable-cause candidates), avoided double payment (duplicate reconciliation), systemic root-cause fixes (rate-feed lags, cert hygiene, registration gaps stop recurring), analyst throughput, and audit-ready decision files (every response carries its facts + provenance).

**In scope.** Notice intake triage copilot, jurisdictional deadline tracking, abatement/amended-return/pay-valid workflow, nexus-questionnaire and cert-audit handling, notice-ops KPI semantic model + dashboards, entity-jurisdiction nexus network analytics, IRS-practice + state-DOR grounding, account-anomaly + notice-outcome pipelines.

**Out of scope.** Return preparation and compliance filing engines; tax-provision (ASC 740) accounting; litigation/Tax Court representation; transfer pricing; property-tax valuation appeals; unclaimed property.

## 2. Actors & user stories

**Personas:** Tax Notice Analyst (TNA), Sales Tax Specialist (STS), Controversy & Abatement Lead (CAL), Tax Compliance Manager (TCM), Tax Governance Auditor (TGA), Tenant Admin (TA).

- **US-1** As a TNA, my queue ranks open notices by deadline runway × dollar × severity (never FIFO); each case shows the account and entity context, prior notices on the account, and the copilot's proposed disposition with cited evidence.
- **US-2** As a TNA, every notice is logged and deadline-calendared within days of receipt; the copilot reminds me a response or extension request goes out on time even when research is unfinished — a blown window forfeits appeal rights.
- **US-3** As a CAL, penalty notices with clean 3-year compliance history surface as first-time-abatement candidates with the qualifying facts assembled, and the request cites the taxpayer's actual history — with the expectation set that interest generally stands.
- **US-4** As an STS, exemption-cert audits show the expired/incomplete certificate share and a remediation-sprint plan inside the cure window; nexus questionnaires arrive with the threshold analysis and VDA posture (relief typically dies at first contact).
- **US-5** As a TCM, dispositions come to me four-eyes: the analyst proposes pay/abate/amend/clarify/duplicate, I approve; no response is filed, payment remitted, or waiver signed without my approval.
- **US-6** As a TCM, I see abatement rate, pay-valid share, amended-return share, assessed-vs-abated dollars, backlog aging, and deadline runway — sliceable by notice type, jurisdiction level, tax type, root cause, and month.
- **US-7** As a TGA, I export an exam bundle showing every AI-assisted disposition with reviewer identity, cited facts, and timestamps.
- **US-8** As a TA, the pack lands as tenant-scoped content only — datasets, model, dashboards, roles, agents — with zero Core changes.

## 3. Functional requirements

### 3.1 Pack manifest (TX-FR-001)

Standard v1. Categories: `tax, compliance, notices, sales_use, abatement`. Regulatory: `irs_procedures, state_tax_codes, wayfair_nexus, mtc_uniform_cert, streamlined_sales_tax`. Clouds: all.

### 3.2 Ontology (TX-FR-010) — deferred to pack-service

`LegalEntity`, `TaxAccount`, `Jurisdiction`, `Notice`, `Assessment`, `Penalty`, `Interest`, `AbatementRequest`, `AmendedReturn`, `ExemptionCertificate`, `FilingObligation`, `DeadlineClock`, `VoluntaryDisclosure`. Carried today by the `tax_notices_core` semantic model + dataset schemas.

### 3.3 Semantic model — notice-ops KPI catalog (TX-FR-020) — authored as `tax_notices_core`

| Measure | Definition |
|---|---|
| `abatement_rate` | abated/withdrawn closures / all closures |
| `pay_valid_share` | agency-was-right closures / all closures |
| `amended_return_share` | amended-return closures / all closures |
| `abatement_recovery_rate` | dollars abated / dollars assessed |
| `high_severity_share` | high-severity notices / all notices |
| `avg_notice_age_days` | backlog aging / cycle time |
| `total_assessed/abated_amount` | dollar exposure vs recovery |
| deadline runway | open notices by `deadline_bucket` (0-10 / 11-30 / over-30 days) |

Entities: notices / accounts / business_entities (chain, many_to_one up: notices→accounts→entities). Grammar: categorical dims, cast-to-double measures, equality measure filters, expr_metric with nullif.

### 3.4 Agents (TX-FR-030..060) — proposal-mode

1. **Notice Intake Copilot (TX-FR-030)** — authored as case-triage TenantAgentConfig: evidence-grounded disposition proposal (abate_penalty_resolved / pay_assessment_valid / file_amended_return / request_agency_clarification / close_duplicate_notice), deadline-first reasoning, never files responses or remits payments. Bespoke LangGraph recipe deferred.
2. **Abatement Request Builder (TX-FR-040)** — deferred recipe: FTA/reasonable-cause ground selection + compliance-history fact assembly.
3. **Economic-Nexus Threshold Monitor (TX-FR-050)** — deferred recipe; interim: nexus-edge saved query + registration_status dimension + VDA grounding.
4. **Deadline Calendar Sentinel (TX-FR-060)** — deferred recipe; interim: deadline_bucket dashboards + high-exposure saved query.
5. **Analytics agent** — authored: tax_notices_core-grounded KPI Q&A.

Autonomous filing, payment, registration, or waiver signing is forbidden — proposal-mode with human approval always (`TX_AUTONOMOUS_FILING_FORBIDDEN` at pack-service tier).

### 3.5 Connectors (TX-FR-080) — deferred to pack-service

**Read:** IRS transcript/e-Services correspondence feeds, state DOR portal inboxes, ERP tax engines (SAP/Oracle/NetSuite; Vertex/Avalara-class rate providers), certificate-management systems, payroll providers' agency-notice feeds, mailroom OCR. **Write adapters (proposal-mode):** file response/protest via agency portal, submit abatement request, remit payment, file amended return, update cert repository, register a jurisdiction. Pack ships seed datasets in the landing shape; production connectors configure via Data > Connections.

### 3.6 Regulatory guardrails (TX-FR-090)

- **Deadlines** — response windows (commonly 30/60/90 days, jurisdiction-specific) forfeit appeal rights when missed; federal notice of deficiency carries a 90-day Tax Court window; respond or extend on time, always.
- **Penalty relief** — IRS first-time abatement (clean 3-year history, filings current, tax paid/arranged) and reasonable cause (ordinary business care and prudence); interest generally not abatable except narrow agency-delay relief.
- **Nexus & certificates** — post-Wayfair economic-nexus thresholds (state-specific, patterned on $100k/200-transactions); good-faith certificate acceptance, cure windows in audit; MTC/SST multi-state forms with state-specific acceptance.
- **Trust-fund exposure** — withholding and collected sales tax carry responsible-person personal liability (IRC §6672 and state analogues); trust-fund notices outrank same-dollar income notices.
- **Governance** — VDA relief typically unavailable after first contact; statute waivers require manager approval; boilerplate abatement claims and pattern-level pay-outs are audit-committee risks.

### 3.7 Roles & case schemas (TX-FR-100) — roles authored, schemas deferred

Roles: `Tax Notice Analyst`, `Sales Tax Specialist`, `Controversy & Abatement Lead`, `Tax Compliance Manager` (sole disposition approver), `Tax Governance Auditor` (read+audit only). Case schemas (deferred): `notice_intake`, `abatement_request`, `nexus_review`, `cert_audit_remediation`, `information_mismatch_response`, `duplicate_reconciliation`.

## 4. Domain model & data

Authored materialization: 3 datasets (notices 26 / accounts 30 / entities 12 — seed rows encode a recurring ERP rate-table lag, an IRS payroll penalty with textbook FTA facts on a 5-day clock, an economic-nexus questionnaire on a just-crossed threshold, an exemption-cert audit with ~30% expired certs, an acquisition duplicate-EIN information mismatch, and a county duplicate of a state-resolved assessment) · 1 semantic model · 5 verified queries · 2 saved queries (incl. entity→jurisdiction nexus network edges) · 3 dashboards (Tax Notice Command Center, Deadlines & Exposure, Root Cause & Abatement — 15 charts) · 5 dispositions · 6-case seeded queue · 5 roles · 2 agent configs · 10 grounding memories · 2 pipelines (isolation_forest account anomaly, xgboost notice-outcome scorer). Deferred: guardrails, agent recipes, connectors, write adapters, eval sets, ontology, case schemas, model archetypes, display labels.

## 5. Business rules (TX-BR-*)

- **BR-1** No autonomous response filing, payment remittance, registration, or waiver signing — proposal-mode with human decision, TCM four-eyes on all dispositions.
- **BR-2** Deadlines outrank research completeness: a protective response or extension request goes out on time; substance can be supplemented, a blown window cannot.
- **BR-3** Abatement requests cite the taxpayer's actual compliance-history facts (never boilerplate); interest expectations are set explicitly — penalties abate, interest generally stands.
- **BR-4** Never pay twice: any notice matching an already-resolved liability (other level, prior notice) is reconciled against payment records before any remittance.
- **BR-5** Trust-fund notices (payroll withholding, collected sales tax) are prioritized ahead of same-dollar income/franchise notices — responsible-person personal liability.
- **BR-6** Nexus decisions precede agency contact where possible; VDA posture is evaluated before responding to a questionnaire, since relief typically dies at first contact.
- **BR-7** Recurring root causes on one account (rate-table lag, cert hygiene, registration gap) trigger a systemic-fix recommendation, not only case-by-case responses.
- **BR-8** Every AI-assisted disposition preserves provenance (data/model/prompt/reviewer/timestamp) — exam and audit-committee defense.

## 6. Dependencies

Windrose Core (BRDs 01–23), unmodified. External (deferred connectors): agency correspondence channels (IRS e-Services, state DOR portals), ERP tax engine of record, certificate-management system, payroll provider feeds.

## 7. NFRs (deltas)

| Metric | Target |
|---|---|
| Triage proposal p95 latency | ≤ 10s |
| Deadline-breach rate (post-install) | 0 |
| Abatement-rate lift on FTA-eligible penalties (6mo) | ≥ +15pp |
| Dashboard chart warm render | 100% real data at install |
| Idempotent re-install | all no-ops |

## 8. Acceptance criteria

- **AC-1** `packctl validate` passes; install exits 0 with 0 failed actions.
- **AC-2** All 15 dashboard charts resolve real rows at install.
- **AC-3** 6-case queue seeded from open notices; severities/deadlines match the dataset.
- **AC-4** 5 roles bound to permission groups with differentiated live capabilities.
- **AC-5** Re-install is fully idempotent.
- **AC-6** Disposition taxonomy uses only the Core's closed category set.
- **AC-7** Pack installs on unmodified Core — zero service/helm/roles_actions.yaml diffs.
- **AC-8** Pack-service-tier capabilities appear verbatim in the `deferred` ledger, never faked.

## 9. Out of scope / future

Return preparation and filing engines; ASC 740 provision; Tax Court/litigation workflow; property-tax valuation appeals; unclaimed property; jurisdiction-rate content subscriptions (consumed via connectors, not shipped); agency write adapters until pack-service ships; a v2 natural extension is credits & incentives notice handling and international (VAT/GST) notices.
