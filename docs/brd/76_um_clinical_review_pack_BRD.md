# BRD 76 — `um-clinical-review` capability pack

**Deliverable type:** Capability Pack (BRD 23) · **Publisher:** Datacern · **Initial version:** 1.0.0
**Horizon:** healthcare wave (extends BRD 24 insurance-claims-payer). Reference pattern: BRD 24 v2.1 deep product pack (no-dummy-data).
**Status:** authored, install pending. Product pack — ZERO seed data; datasets are binding contracts resolved to the tenant's real data at install.

---

## 1. Overview

**Purpose.** Agent-prepared, clinician-decided utilization management (UM) clinical review for US health payers: preservice prior authorization, concurrent, and retrospective medical-necessity reviews prepared against the governing criteria for each line of business (LOB), tracked on plan-configured regulatory clocks, and signed by named human clinicians. Sells to health plans (Blues, regional payers, Medicaid MCOs) and delegated UM entities.

**Why this vertical.** Requirements were derived from a real multi-LOB Blue plan's UM corpus: ~$25M/yr of manual MD/RN review labor; review preparation done cold from unstructured charts; appeals overturned mostly on documentation missing at first pass; LOB authority hierarchies enforced only by training; CEO-attested industry commitments and CMS-0057-F forcing real-time determination rates payers cannot reach without prepared, criteria-matched reviews. Every determination is documented, disputable, and evidence-driven — the platform's governed human-in-the-loop shape, one notch deeper than BRD 24's claims/appeals analytics: this pack owns the REVIEW-PREPARATION work item itself.

**Business value.** Reviewer throughput (prepared packet vs cold chart), MD time protected (referral packets with the question presented), turnaround-clock breach elimination (LOB-aware escalation), appeal-overturn reduction (first-pass completeness gating), audit-ready determination files (every decision carries findings + provenance), and shadow-mode calibration against the tenant's own decided history before any queue goes assisted-live.

**In scope.** Review-preparation copilot (completeness → LOB hierarchy → criteria match → cited assessment → route); deterministic review triage + LOB clock escalation; typed clinical-review and MD-referral case schemas; UM review KPI semantic model + three dashboards; UM ontology, role catalog, grounding, guardrails; X12 278 intake and determination write-back connection templates; determination-outcome training pipeline + governed blueprint.

**Out of scope.** Claim adjudication and denial/appeal analytics (BRD 24); page-anchored OCR/document-intelligence over scanned charts (Core gap — see §9); letter generation; criteria CONTENT (MCG/InterQual are tenant-licensed; the pack never ships or copies licensed criteria); real-time X12 278 transport listeners (Core standards-interop roadmap).

## 2. Actors & user stories

**Personas:** UM Intake Coordinator (UIC), UM Nurse Reviewer (UNR), Medical Director (MD), Appeals & Grievances Analyst (AGA), UM Program Analyst (UPA), UM Compliance Auditor (UCA), Tenant Admin (TA).

- **US-1** As a UNR, my worklist ranks pending reviews by regulatory runway (each case's own plan-configured window) × urgency, never FIFO; each case opens with the agent's criteria-by-criteria preparation and cited evidence.
- **US-2** As a UNR on an incomplete file, the triage table has already proposed the records request naming the specific missing documents — before the clock runs out, because appeals overturn on late-arriving information.
- **US-3** As an MD, referrals arrive as prepared packets: the question presented, evidence for and against, and the criteria excerpt — my time is spent deciding, not searching.
- **US-4** As an MD, an adverse determination is mine alone: no agent or decision table ever proposes it, and my signed findings ride the determination record.
- **US-5** As an AGA, I work appeal-bound cases with the original review's full evidence trail — what was in the file at first pass is a fact, not a reconstruction.
- **US-6** As a UPA, I slice review volume, turnaround vs window, MD-referral rate, documentation completeness, overturn rate, and policy digitization coverage by LOB / review type / urgency / month.
- **US-7** As a UCA, I export the determination audit trail (proposer, approver, evidence, timestamps) for NCQA file review or a CMS program-integrity request.
- **US-8** As a TA, the pack lands tenant-scoped with zero Core changes; install fails closed naming every missing binding-contract column.

## 3. Functional requirements

### 3.1 Pack manifest (UMR-FR-001)
Standard v1 envelope. Categories: `insurance, health, payer, utilization-management, prior-auth, clinical-review`. Regulatory tags: `cms_4201_f, cms_0057_f, cms_2024_ma_ai_review, ncqa_um, state_ur_statutes, hipaa`. Control mappings (EU AI Act art. 12/14, NIST AI RMF, ISO 42001) carried with verified evidence; Annex IV kit honestly `not_covered`.

### 3.2 Binding contracts (UMR-FR-010)
Four dataset contracts, no seed data: `um-review-cases` (the worklist, incl. `window_hours` so clock math is data-driven), `um-case-documents` (intake integrity: channel, OCR state, contains-clinicals), `um-policy-catalog` (criteria source + digitization state), `um-determinations` (signed decisions + appeal outcomes — the shadow-mode calibration corpus).

### 3.3 Semantic KPI catalog (UMR-FR-020) — `um_review`

| Measure | Definition |
|---|---|
| `md_referral_rate` | physician-required reviews / all reviews |
| `clinical_incomplete_rate` | incomplete-file reviews / all reviews |
| `determination_denial_rate` | adverse determinations / all determinations |
| `appeal_overturn_rate` | overturned appeals / appealed determinations |
| `policy_digitization_rate` | digitized policies / all policies |
| `avg_turnaround_hours` vs `avg_window_hours` | elapsed clock vs plan-configured window |
| documentation health | `missing_clinicals_count`, `ocr_failed_count` by channel |

Entities: cases / documents / determinations / policies (star + chain, many_to_one, acyclic). Grammar: categorical dims, cast-to-double measures, single-equality filters, expr_metric with nullif.

### 3.4 Agents (UMR-FR-030) — proposal-mode only
`case-triage` specialized as a review-preparation nurse: LOB hierarchy first (never mixed), completeness second, criteria match third, clock watch fourth; recommends `approve`/`refer_md`/`request_info`; NEVER proposes `adverse_determination_md`, never communicates outcomes, never touches payment. `analytics` grounded in `um_review`. Guardrails: PII redaction on egress, workspace-bound grounding, budget-clamped.

### 3.5 Decision tables (UMR-FR-040)
`um_review_triage` (urgent-clock escalation, incomplete-file records request, plan MD-routing rule, agent-escalation honoring, high-confidence approve proposal — four-eyes always) and `um_lob_clock_escalation` (standard-tier per-LOB floors: commercial FI ~5 business days, Medicare 7-calendar-day forward-compatible floor, Medicaid state-contract, ASO plan-document; incomplete-file early warning). Neither table can propose an adverse determination.

### 3.6 Connectors (UMR-FR-080)
Incoming: X12 278 SFTP drop, UM-platform case extract (S3), decided-case history extract (S3). Outgoing: determination write-back (http_api), proposal-mode four-eyes, empty secrets at install. The tenant's UM core (Pega/Predictal-class, VirtualHealth/Helios-class, GuidingCare-class, Facets/QNXT-class) remains the system of record.

### 3.7 Regulatory guardrails (UMR-FR-090)
Grounding records: LOB authority hierarchies (never mixed), MA/CMS-0057-F clocks, state UR statute regimes (qualitative, plan-window authoritative), CMS 2024 MA AI rule (clinician decides), NCQA UM standards, adverse-determination notice content, peer-to-peer practice, gold-carding evidence basis, industry real-time commitments.

### 3.8 Roles & case schemas (UMR-FR-100)
Six roles with UM separation of duties (only the Medical Director holds `case.disposition.approve`, `case.bulk.approve`, `experiment.promotion.approve`; the auditor writes nothing). Two typed schemas: `um_clinical_review`, `um_md_referral`.

## 4. Domain model & data
Ontology: member, provider, review_case, clinical_document, medical_policy, determination — attributes exactly the binding-contract columns. What materializes at install: config kinds first (dispositions → fields → schemas → labels → guardrails → agent configs → archetypes → ontology → adapters → templates → roles → decision tables), then the data chain against bound real datasets, dashboards only after a distinct human approves the semantic model.

## 5. Business rules
- **BR-1** No autonomous adverse determination — every agent/table output is a proposal; `adverse_determination_md` is human-only and never proposed; four-eyes on every governed action.
- **BR-2** LOB authority hierarchies are never mixed across coverage types.
- **BR-3** The case's own `window_hours` is authoritative for clock math; table literals are conservative escalation floors only.
- **BR-4** Incomplete clinical file ⇒ propose the records request naming the missing documents; never assess against an incomplete file silently.
- **BR-5** Licensed criteria (MCG/InterQual) are accessed via the tenant's own license; the pack never ships, copies, or serves criteria content.
- **BR-6** Determination write-back carries only the human-approved decision to the tenant's UM system of record.
- **BR-7** Outcome scores order worklists only; they never issue or accelerate a denial.
- **BR-8** Member PHI is redacted from agent egress; grounding reads are workspace-bound.

## 6. Dependencies
Core services: case-service (typed fields/schemas), agent-runtime (decision tables, TenantAgentConfig, guardrails, proposals), semantic/query/chart services, memory-service, rbac/identity, ingestion-service (connections), experiment-service (archetype), pipeline-orchestrator (xgboost), pack-service (deep-kind install path). Tenant-supplied: bound real datasets for the four contracts, criteria license, UM-core write-back endpoint + credentials, SSO/IdP.

## 7. NFRs

| Concern | Requirement |
|---|---|
| Tenancy | All components tenant/workspace-scoped; RLS-enforced; no cross-tenant grounding or corrections |
| PHI | HIPAA posture: PII redaction on agent egress, no PHI in pack files, WORM audit retention |
| Auditability | Every proposal/decision on the hash-chained audit trail; exportable for NCQA/CMS review |
| Idempotency | Install twice ⇒ no duplicates; upgrade/rollback keyed on version |
| Fail-closed | Missing binding-contract columns fail install with the named list; unresolvable disposition codes fail install |

## 8. Acceptance criteria
1. `packctl validate um-clinical-review` → "manifest ok" (22 component files, 1 deferred). **Verified at authoring: 0 lint errors/warnings, 0 pack coherence findings, 0 fleet coherence errors.**
2. Install (pack-service, dry-run then apply) exits 0 against a tenant whose bound datasets satisfy all four contracts; fails closed naming missing columns otherwise.
3. 15/15 charts render against bound real data after semantic-model approval; no chart reads an expr_metric.
4. Six roles land differentiated (only the Medical Director approves dispositions/bulk/promotions; auditor is read-only).
5. Neither decision table nor any agent config can emit `adverse_determination_md` (C2/C3 checks + code review of rules).
6. Disposition categories drawn from the closed case-service set; all decision-table columns resolve to contract columns or typed fields (C1).
7. Core unmodified; `agent_recipes` deferral ledgered with its honest reason.

## 9. Out of scope / future
- **Document-intelligence service** (OCR + page-anchored clinical fact extraction over scanned charts/faxes): the highest-leverage Core addition this vertical needs; until it ships, `contains_clinicals`/`ocr_status` arrive from the tenant's existing pipeline.
- **Da Vinci CRD/DTR/PAS conformance + real-time X12 278 listener** (Core standards-interop roadmap R1/R5) — unlocks CMS-0057-F API-native intake.
- **Bespoke LangGraph recipes** (chart-reader → criteria-matcher → determination-drafter chain) once agent-runtime graph-module registration opens.
- **Letter generation** (determination → member-readable notice with reading-level and language-access QA) — candidate sibling pack.
- **Eval golden sets** curated by the tenant from its own decided history (the `um-determinations` contract is the source); frozen via eval-service once curated.
