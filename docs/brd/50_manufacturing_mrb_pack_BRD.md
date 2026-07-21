# BRD 50 — `manufacturing-mrb` capability pack

**Deliverable type:** Capability Pack (BRD 23) · **Publisher:** Datacern · **Initial version:** 1.0.0
**Horizon:** 3 pack wave (post BRD-32). Reference pattern: BRD 24/30/32.
**Status:** v1.0.0 authored, install pending (Core-neutral via packctl; pack-service-tier components declared `deferred` in the manifest).

---

## 1. Overview

**Purpose.** Nonconformance disposition and Material Review Board (MRB) adjudication AI for regulated discrete manufacturers: NC intake triage with disposition-deadline awareness, MRB authority-limit discipline (use-as-is on a critical characteristic routes to customer/design-authority approval), supplier quality watch (repeat-SCAR suppliers, suspect certs), containment and suspect-lot traceability, and escape/customer-notification assessment. Sells to aerospace & defense suppliers (AS9100), medical-device manufacturers (ISO 13485 / 21 CFR 820.90), automotive tiers (IATF 16949), and contract manufacturers spanning all three.

**Why this vertical.** Every nonconformance in a regulated plant must be identified, segregated, evaluated, and dispositioned by authorized personnel with documented justification — and dispositions outside delegated MRB authority (a use-as-is on a critical characteristic without customer concurrence) are major audit findings regardless of engineering merit. Volumes are steady, evidence is row-level (lots, serial numbers, certs, inspection results), authority limits are hard rules, and certification-body auditors sample the record trail — the exact governed human-in-the-loop decision shape of the Datacern Core, with the adjudication pattern already proven by BRD 30/32.

**Business value.** Disposition-deadline breach elimination, MRB cycle-time reduction (triage pre-routing + evidence assembly), concession discipline (use-as-is share watched by spec class, authority-limit routing built into the copilot), supplier quality lift (repeat-SCAR escalation instead of lot-by-lot whack-a-mole), escape-cost reduction (containment sweeps + notification assessment on customer returns), and audit-ready decision files (every closure carries its justification + provenance).

**In scope.** NC intake triage copilot, disposition-deadline tracking, MRB authority-limit routing, containment/suspect-lot workflow, supplier SCAR watch, quality-ops KPI semantic model + dashboards, supplier–part-family network analytics, AS9100 / ISO 13485 / IATF 16949 + 8D/CAPA/SCAR/FAI grounding, lot-anomaly + disposition-outcome pipelines.

**Out of scope.** SPC / real-time process control (an MES/SPC product); calibration management; design-control / DHF management; supplier audits execution; warranty claims administration; CAPA workflow beyond the disposition record (natural v2 extension).

## 2. Actors & user stories

**Personas:** Quality Engineer (QE), MRB Engineering Reviewer (MER), Supplier Quality Engineer (SQE), Quality Manager (QM), Quality Systems Auditor (QSA), Tenant Admin (TA).

- **US-1** As a QE, my queue ranks open NCs by disposition-deadline runway × cost impact × spec class (never FIFO); each case shows the lot, supplier, detection point, and the copilot's proposed disposition with cited row-level evidence.
- **US-2** As a QE on a critical-characteristic NC, the copilot tells me use-as-is is outside internal MRB authority — the concession routes to the customer/design authority, and the unit stays quarantined meanwhile.
- **US-3** As an MER, rework proposals arrive with the re-verification evidence closure requires named up front (re-X-ray, re-inspection to original acceptance criteria), and I can author/export ad-hoc queries for justification packages.
- **US-4** As an SQE, repeat-offender suppliers surface as a pattern (Castwell porosity: 4 NCs / 4 months), and the proposed disposition is return + escalated SCAR with the recurrence evidence assembled — not four isolated lot decisions.
- **US-5** As a QM, dispositions come to me four-eyes: the engineer proposes, I approve; every use-as-is carries its documented justification and every escape carries a customer-notification assessment.
- **US-6** As a QM, I see rework rate, use-as-is share, scrap share, supplier-return share, backlog aging, deadline runway, detection-point and spec-class mix — sliceable by part family, program, supplier, certification regime, and month.
- **US-7** As a QSA, I walk an exam bundle showing every AI-assisted disposition with reviewer identity, justification, and timestamps — with no case-write power of my own.
- **US-8** As a TA, the pack lands as tenant-scoped content only — datasets, model, dashboards, roles, agents — with zero Core changes.

## 3. Functional requirements

### 3.1 Pack manifest (NC-FR-001)

Standard v1. Categories: `manufacturing, quality, aerospace, medical_devices, automotive`. Regulatory: `as9100, iso13485, iatf16949, fda_21cfr820, iso9001`. Clouds: all.

### 3.2 Ontology (NC-FR-010) — deferred to pack-service

`Nonconformance`, `Lot`, `Part`, `Characteristic`, `Supplier`, `Program`, `Disposition`, `MRBReview`, `Concession`, `SCAR`, `Containment`, `Escape`, `CertificateOfConformance`. Carried today by the `mrb_core` semantic model + dataset schemas.

### 3.3 Semantic model — quality-ops KPI catalog (NC-FR-020) — authored as `mrb_core`

| Measure | Definition |
|---|---|
| `rework_rate` | rework-to-spec dispositions / all closures |
| `use_as_is_share` | use-as-is concessions / all closures |
| `scrap_share` | scrap dispositions / all closures |
| `supplier_return_share` | return-to-supplier (SCAR) dispositions / all closures |
| `repeat_scar_supplier_share` | suppliers with 3+ prior SCARs / supplier base |
| `avg_nc_age_days` | backlog aging / MRB cycle time |
| `quarantined_count` / `customer_return_count` | containment posture / escape counts |
| deadline runway | open NCs by `deadline_bucket` (0-5 / 6-15 / over-15 days) |

Entities: nonconformances / lots / suppliers (chain, many_to_one both hops: NC→lot→supplier). Grammar: categorical dims, cast-to-double measures, equality measure filters, expr_metric with nullif.

### 3.4 Agents (NC-FR-030..060) — proposal-mode

1. **NC Intake Copilot (NC-FR-030)** — authored as case-triage TenantAgentConfig: evidence-grounded disposition proposal (rework_to_spec / no_defect_found_release / use_as_is_engineering_disposition / quarantine_pending_analysis / return_to_supplier_scar), deadline-first + containment-first reasoning, authority-limit routing on critical characteristics, never releases or moves material. Bespoke LangGraph recipe deferred.
2. **MRB Package Builder (NC-FR-040)** — deferred recipe: justification/concession package assembly for customer/design-authority routing.
3. **Supplier SCAR Drafter (NC-FR-050)** — deferred recipe; interim: xgboost disposition-outcome pipeline + suspect-lot and repeat-supplier verified queries.
4. **Containment Sweep Sentinel (NC-FR-060)** — deferred recipe; interim: deadline_bucket/containment dashboards + high-cost open-queue saved query.
5. **Analytics agent** — authored: mrb_core-grounded KPI Q&A.

Autonomous material disposition is forbidden — proposal-mode with human approval always (`NC_AUTONOMOUS_DISPOSITION_FORBIDDEN` at pack-service tier).

### 3.5 Connectors (NC-FR-080) — deferred to pack-service

**Read:** QMS platforms (ETQ Reliance, MasterControl, Arena, Greenlight Guru), ERP quality modules (SAP QM, Oracle Quality), MES/SPC + CMM/inspection-result feeds, PLM (drawing + characteristic data), supplier portals (certs, SCAR responses). **Write adapters (proposal-mode):** disposition write-back to QMS/ERP, SCAR issuance, stock/ship hold place-and-lift, concession/waiver package to customer, escape notification. Pack ships seed datasets in the landing shape; production connectors configure via Data > Connections.

### 3.6 Regulatory guardrails (NC-FR-090)

- **AS9100** — nonconforming-output control (identify, segregate, disposition by authorized personnel, records + concessions), counterfeit/suspect-part prevention (unbroken cert pedigree), FAI practice (AS9102), FOD prevention.
- **ISO 13485 / 21 CFR 820.90** — nonconforming-product control; use-as-is only with documented justification + authorization; rework with re-verification against original acceptance criteria; post-delivery nonconformity → correction-and-removal assessment (21 CFR 806 concept).
- **IATF 16949 / 8D** — containment before root cause, corrective-action effectiveness verification, SCAR escalation ladder.
- **MRB authority limits** — use-as-is/repair on critical characteristics or customer-designed product routes to customer/design authority; dispositioning beyond delegated authority is a major finding.

### 3.7 Roles & case schemas (NC-FR-100) — roles authored, schemas deferred

Roles: `Quality Engineer`, `MRB Engineering Reviewer`, `Supplier Quality Engineer`, `Quality Manager` (sole disposition approver), `Quality Systems Auditor` (read+audit only). Case schemas (deferred): `nc_intake`, `mrb_review`, `supplier_scar`, `containment_sweep`, `escape_assessment`.

## 4. Domain model & data

Authored materialization: 3 datasets (nonconformances 26 / lots 30 / suppliers 12 — seed rows encode a critical-characteristic dimensional NC on a serialized flight part, a repeat casting-porosity trail from a red-scorecard foundry, a solder-void PCB batch, a FOD find sweeping three harness lots, a documentation-only cert gap, and a three-month customer-return cracking trend on a med-device molded family) · 1 semantic model (chain topology NC→lot→supplier) · 5 verified queries · 2 saved queries (incl. supplier→part-family network edges) · 3 dashboards (Nonconformance Command Center, MRB Dispositions & Cycle Time, Supplier Quality Watch — 15 charts) · 5 dispositions · 6-case seeded queue · 5 roles · 2 agent configs · 10 grounding memories · 2 pipelines (isolation_forest lot anomaly, xgboost disposition-outcome scorer). Deferred: guardrails, agent recipes, connectors, write adapters, eval sets, ontology, case schemas, model archetypes, display labels.

## 5. Business rules (NC-BR-*)

- **BR-1** No autonomous disposition, release, scrap, return, or hold of material — proposal-mode with human decision, QM four-eyes on every closure.
- **BR-2** Use-as-is or repair on a critical characteristic (or customer-designed product) requires customer/design-authority approval before closure — internal MRB authority never suffices.
- **BR-3** Rework closures require re-verification evidence against the original acceptance criteria attached to the record (med-device: documented rework procedure + adverse-effect evaluation).
- **BR-4** Containment precedes analysis: quarantine is the immediate action while evidence is gathered, and a FOD/escape-capable find sweeps all lots in the causal window (serialization bounds the sweep).
- **BR-5** Customer-return NCs are escapes: every one carries a customer-notification / correction-and-removal assessment before closure.
- **BR-6** Documentation-only NCs with conforming parts follow the release path — but never release on a broken cert/pedigree chain (counterfeit-part prevention).
- **BR-7** Repeat supplier failures escalate the SCAR ladder (tightened receiving → source inspection → ASL probation → desource) rather than being dispositioned lot-by-lot in isolation.
- **BR-8** Every AI-assisted disposition preserves provenance (data/model/prompt/reviewer/timestamp) and is monitorable in aggregate for concession drift — certification-body and customer audit defense.

## 6. Dependencies

Datacern Core (BRDs 01–23), unmodified. External (deferred connectors): QMS/ERP/MES of record, CMM result feeds, PLM characteristic data, supplier-portal credentials.

## 7. NFRs (deltas)

| Metric | Target |
|---|---|
| Triage proposal p95 latency | ≤ 10s |
| Disposition-deadline breach rate (post-install) | 0 |
| MRB cycle time (avg NC age at closure, 6mo) | ≥ 25% reduction |
| Dashboard chart warm render | 100% real data at install |
| Idempotent re-install | all no-ops |

## 8. Acceptance criteria

- **AC-1** `packctl validate` passes; install exits 0 with 0 failed actions.
- **AC-2** All 15 dashboard charts resolve real rows at install.
- **AC-3** 6-case queue seeded from open nonconformances; severities/deadlines match the dataset.
- **AC-4** 5 roles bound to permission groups with differentiated live capabilities.
- **AC-5** Re-install is fully idempotent.
- **AC-6** Disposition taxonomy uses only the Core's closed category set.
- **AC-7** Pack installs on unmodified Core — zero service/helm/roles_actions.yaml diffs.
- **AC-8** Pack-service-tier capabilities appear verbatim in the `deferred` ledger, never faked.

## 9. Out of scope / future

SPC/process-control decisioning; full CAPA workflow (root-cause management beyond the disposition record — natural v2); supplier audit execution; calibration management; deviation/waiver lifecycle management against customer portals until pack-service write adapters ship; warranty/field-return claims administration.
