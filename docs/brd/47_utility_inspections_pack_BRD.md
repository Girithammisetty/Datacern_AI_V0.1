# BRD 47 — `utility-inspections` capability pack

**Deliverable type:** Capability Pack (BRD 23) · **Publisher:** Datacern · **Initial version:** 1.0.0
**Horizon:** 3 pack wave (post-BRD-32 pattern). Reference pattern: BRD 24/30/32.
**Status:** v1.0.0 authored, install pending (Core-neutral via packctl); pack-service-tier components declared `deferred` in the manifest.

---

## 1. Overview

**Purpose.** Asset-inspection finding triage and repair/defer decisioning AI for electric and gas utilities: drone-AI/LiDAR/infrared/foot-patrol finding intake with wildfire risk-zone awareness (HFTD Tier 2/3, PSPS-history circuits), gas leak-grading practice, false-detection management with the field-verification detector-training loop, and governed deferral with documented engineering rationale. Sells to electric and gas utilities (especially wildfire-exposed distribution utilities), transmission operators, and inspection-services firms.

**Why this vertical.** Wildfire-mitigation plans, overhead-line clearance standards, gas leak grading, and inspection-cycle rules attach hard clocks and audit exposure to every finding; drone/aerial-AI programs have multiplied finding volume (with material false-positive rates) faster than triage staffing; and the deferred-maintenance record is the decisive fact pattern in post-incident litigation. Every repair/defer call is documented, disputable, and evidence-driven — the exact governed human-in-the-loop decision shape of the Datacern Core, proven by the BRD 24-32 adjudication packs.

**Business value.** Deadline-breach elimination (make-safe and program-window clocks watched per risk zone), triage throughput (pre-routing across dispatch/verify/schedule/monitor), truck-roll savings (false detections screened to field verification instead of dispatch), detector-precision lift (verification outcomes recycled as training labels), and litigation/audit-ready decision files (every deferral carries its engineering rationale + provenance).

**In scope.** Finding triage copilot, wildfire risk-zone and PSPS-aware prioritization, leak-grading-aligned gas workflow, false-detection screening + detector-training loop, repeat-finding escalation, inspection-program KPI semantic model + dashboards, asset/circuit network analytics, wildfire/clearance/leak-grading/NERC grounding, asset-anomaly + disposition-scoring pipelines.

**Out of scope.** Real-time SCADA alarming and protection; outage management and restoration dispatch; vegetation work-order scheduling/optimization (crew routing is an EAM/VM product); drone flight operations and imagery processing (upstream of the findings feed); rate-case analytics.

## 2. Actors & user stories

**Personas:** Inspection Triage Analyst (ITA), Field Verification Engineer (FVE), Vegetation Program Specialist (VPS), Asset Risk Manager (ARM), Regulatory Compliance Auditor (RCA), Tenant Admin (TA).

- **US-1** As an ITA, my queue ranks open findings by deadline runway × risk zone × cost exposure (never FIFO); each case shows the detection evidence, the asset's finding history, and the copilot's proposed disposition with cited evidence.
- **US-2** As an ITA on a Tier-3 HFTD finding, I see the make-safe clock and can never let investigation completeness justify blowing the deadline — the copilot reminds me that risk zone outranks queue order and that a Tier-3 thermal signature on aging equipment is a pre-ignition profile.
- **US-3** As an FVE, low-confidence drone-AI detections matching known shadow/glint artifact signatures land in my verification queue with the prior false-detection pattern assembled — and my confirmed/refuted outcome is captured as a detector-retraining label.
- **US-4** As a VPS, encroachment findings arrive ranked by fire-threat tier, clearance deficit, and the circuit's PSPS history, with adjacent-span trim history cited — keeping PSPS the last resort.
- **US-5** As an ARM, immediate-dispatch and deferral calls come to me four-eyes: the analyst proposes, I approve; every deferral's note must contain the engineering rationale and program window a future auditor (or plaintiff) will judge it against.
- **US-6** As an ARM, I see immediate-dispatch rate, false-detection rate, verification share, backlog aging, deadline runway, risk-zone mix, and detection-source mix — sliceable by finding type, asset class, circuit wildfire risk, and month.
- **US-7** As an RCA, I export an audit bundle showing every AI-assisted disposition with reviewer identity, rationale, and timestamps (inspection-cycle and WMP-commitment audit readiness).
- **US-8** As a TA, the pack lands as tenant-scoped content only — datasets, model, dashboards, roles, agents — with zero Core changes.

## 3. Functional requirements

### 3.1 Pack manifest (UI-FR-001)

Standard v1. Categories: `utilities, energy, inspections, asset_management, wildfire`. Regulatory: `wildfire_mitigation_plans, go_95, phmsa_pipeline_safety, nerc_fac_003, state_psc`. Clouds: all.

### 3.2 Ontology (UI-FR-010) — deferred to pack-service

`Asset`, `Circuit`, `District`, `Finding`, `Detection`, `WorkOrder`, `Deferral`, `RiskZone`, `InspectionCycle`, `LeakGrade`, `VegetationSpan`, `PSPSEvent`. Carried today by the `inspections_core` semantic model + dataset schemas.

### 3.3 Semantic model — inspection-program KPI catalog (UI-FR-020) — authored as `inspections_core`

| Measure | Definition |
|---|---|
| `immediate_dispatch_rate` | immediate-repair dispatches / all closures |
| `false_detection_rate` | false-detection closures / all closures (detector precision proxy) |
| `verification_share` | field-verification routings / all closures |
| `tier3_finding_share` | Tier-3 HFTD findings / all findings |
| `drone_ai_share` | drone-AI-sourced findings / all findings |
| `avg_finding_age_days` | backlog aging / cycle time |
| `total/avg_est_repair_cost` | repair-cost exposure |
| `avg_detection_confidence` | detector-quality watch |
| deadline runway | open findings by `deadline_bucket` (0-3 / 4-14 / over-14 days) |

Entities: findings / assets / circuits (chain, findings→assets→circuits many_to_one). Grammar: categorical dims, cast-to-double measures, equality measure filters, expr_metric with nullif.

### 3.4 Agents (UI-FR-030..060) — proposal-mode

1. **Finding Triage Copilot (UI-FR-030)** — authored as case-triage TenantAgentConfig: evidence-grounded disposition proposal (dispatch_immediate_repair / close_false_detection / schedule_planned_work / request_field_verification / close_monitored_stable), risk-zone-first reasoning, repeat-finding escalation, never creates or defers work orders. Bespoke LangGraph recipe deferred.
2. **Deadline & Make-Safe Sentinel (UI-FR-040)** — deferred recipe; interim: deadline_bucket dashboards + deadline-priority saved/verified queries.
3. **False-Detection Screener (UI-FR-050)** — deferred recipe; interim: false-detection-rate verified query + xgboost disposition-scorer pipeline + verification-loop grounding.
4. **Vegetation Clearance Planner (UI-FR-060)** — deferred recipe; interim: vegetation trend chart + risk-zone/PSPS analytics + prioritization grounding.
5. **Analytics agent** — authored: inspections_core-grounded KPI Q&A.

Autonomous work-order creation, deferral, or crew dispatch is forbidden — proposal-mode with human approval always (`UI_AUTONOMOUS_WORKORDER_FORBIDDEN` at pack-service tier).

### 3.5 Connectors (UI-FR-080) — deferred to pack-service

**Read:** asset registries / GIS (Esri ArcGIS Utility Network-class), EAM/work management (Maximo, SAP PM-class), drone/aerial-AI analytics platforms, LiDAR vegetation-analytics vendors, SCADA/historian feeds, leak-survey instrument exports. **Write adapters (proposal-mode):** create/schedule/close EAM work orders, crew dispatch, GIS condition updates, regulator notifications. Pack ships seed datasets in the landing shape; production connectors configure via Data > Connections.

### 3.6 Regulatory guardrails (UI-FR-090)

- **Wildfire mitigation** — WMP filing + audit regimes in high-fire-risk states; HFTD Tier 2/3 drive shorter inspection cycles, expanded clearances, stricter repair timeframes; PSPS as last resort.
- **Clearance standards** — GO 95-style overhead construction/clearance rules (NESC + state amendments elsewhere); expanded HFTD minimums; encroachment inside minimum clearance is a repair-clock item.
- **Gas safety** — leak grading practice (Grade 1 immediate / Grade 2 scheduled-with-re-evaluation / Grade 3 monitored); PHMSA integrity management; cast-iron/bare-steel replacement programs.
- **Transmission** — NERC FAC-003 vegetation management; vegetation-caused sustained outages reportable.
- **Records & liability** — inspection-cycle audit reconstruction (finding → decision → completion); deferral records discoverable; pattern-of-deferral watch in high-risk zones.

### 3.7 Roles & case schemas (UI-FR-100) — roles authored, schemas deferred

Roles: `Inspection Triage Analyst`, `Field Verification Engineer`, `Vegetation Program Specialist`, `Asset Risk Manager` (sole disposition approver), `Regulatory Compliance Auditor` (read+audit only). Case schemas (deferred): `finding_triage`, `field_verification`, `leak_grading`, `vegetation_clearance`, `deferral_engineering_review`.

## 4. Domain model & data

Authored materialization: 3 datasets (findings 26 / assets 30 / circuits 12 — seed rows encode a Tier-3 HFTD drone-AI thermal hotspot on a 2-day clock, a shadow-artifact false-positive candidate, a Grade-2-style leak inside its window, a vegetation cluster on a PSPS-history circuit, 1960s cast-iron corrosion needing engineering review, and a repeat splice hotspot after a prior monitor decision) · 1 semantic model · 5 verified queries · 2 saved queries (incl. asset→finding-type network edges) · 3 dashboards (Inspection Triage Center, Wildfire & Risk Zones, Detection Quality & Backlog — 15 charts) · 5 dispositions · 6-case seeded queue · 5 roles · 2 agent configs · 10 grounding memories · 2 pipelines (isolation_forest asset anomaly, xgboost disposition scorer). Deferred: guardrails, agent recipes, connectors, write adapters, eval sets, ontology, case schemas, model archetypes, display labels.

## 5. Business rules (UI-BR-*)

- **BR-1** No autonomous work-order creation, deferral, or crew dispatch — proposal-mode with human decision, ARM four-eyes on immediate-dispatch and deferral determinations.
- **BR-2** Risk zone outranks queue order: an HFTD Tier-3 finding takes the tightest clock, and make-safe deadlines are never sacrificed to investigation completeness.
- **BR-3** Deferral (schedule_planned_work) requires a documented engineering rationale, program window, and re-inspection basis at decision time — deferred-maintenance records are discoverable.
- **BR-4** A repeat finding on an asset with a prior monitor decision is a worsening trend: escalate, never re-monitor silently; cite the prior finding id in the decision record.
- **BR-5** Low-confidence detections matching a known artifact signature route to field verification, not dispatch and not silent closure; every verification outcome is captured as a detector-retraining label.
- **BR-6** Leak indications follow grading practice: immediate hazard → immediate action; non-hazardous-but-real → scheduled repair inside the window with periodic re-evaluation; minor → monitored re-checks with regrade on change.
- **BR-7** Storm-surge triage goes make-safe-first, and temporary repairs generate follow-up findings — documentation duties do not relax during surge operations.
- **BR-8** Every AI-assisted disposition preserves provenance (data/model/confidence/reviewer/timestamp) — WMP and inspection-cycle audit defense, and pattern-level over-deferral in high-risk zones is itself an exposure.

## 6. Dependencies

Datacern Core (BRDs 01–23), unmodified. External (deferred connectors): asset registry/GIS of record, EAM credentials, drone/LiDAR analytics feeds, leak-survey instrument exports.

## 7. NFRs (deltas)

| Metric | Target |
|---|---|
| Triage proposal p95 latency | ≤ 10s |
| Make-safe deadline-breach rate (post-install) | 0 |
| False-detection truck-roll reduction (6mo) | ≥ 25% on drone-AI findings |
| Dashboard chart warm render | 100% real data at install |
| Idempotent re-install | all no-ops |

## 8. Acceptance criteria

- **AC-1** `packctl validate` passes; install exits 0 with 0 failed actions.
- **AC-2** All 15 dashboard charts resolve real rows at install.
- **AC-3** 6-case queue seeded from open findings; severities/deadlines match the dataset.
- **AC-4** 5 roles bound to permission groups with differentiated live capabilities.
- **AC-5** Re-install is fully idempotent.
- **AC-6** Disposition taxonomy uses only the Core's closed category set.
- **AC-7** Pack installs on unmodified Core — zero service/helm/roles_actions.yaml diffs.
- **AC-8** Pack-service-tier capabilities appear verbatim in the `deferred` ledger, never faked.

## 9. Out of scope / future

SCADA alarming and protection; outage management/restoration; vegetation crew routing and work-order optimization; drone flight ops and imagery processing; rate-case analytics; EAM/GIS write adapters until pack-service ships; joint-use and pole-attachment inspections (natural v2 extension).
