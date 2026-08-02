<!-- converted from CARE_MANAGEMENT_AGENT_PLAYBOOK.docx by tools/docs/docx_to_md.py -->
> **Converted from Word.** This is a point-in-time snapshot: figures in it were accurate on the date stated below and have not been re-verified against the current codebase. For counts that are checked continuously, see the root [`README.md`](../../README.md).

DATACERN AI · CARE MANAGEMENT (MEDICARE)

Agent Playbook

How to put the nine Datacern agents to work in a Medicare care-management program.

This playbook maps each of Datacern's nine agents to a concrete job in a provider-side Medicare care-management program — CCM, PCM, TCM, BHI, CoCM, RPM, RTM, and APCM 2025 — and shows a care manager, clinician reviewer, or practice CFO exactly how to use it. It is grounded in the real care-management-medicare pack (BRD 25).

Pack: care-management-medicare v1.0.0 (Datacern Inc.)

Programs: CCM · PCM · TCM · BHI · CoCM · RPM · RTM · APCM (2025)

Audience: Care Manager (RN/LPN), Clinician MD Reviewer, Director of Care Coordination, Practice CFO, Compliance Officer

Golden rule: Datacern never bills. Every billing decision is a proposal a human approves (four-eyes).

Date: 2026-07-17

# Contents

# 1. The care-management problem Datacern solves

Medicare care-management revenue is real but fragile: a practice earns it only when the right code is billed for a patient with active consent, the time minimum is met, mutual-exclusion rules are respected, and the documentation would survive a RAC audit. Miss any of those and the revenue leaks — or worse, an over-bill becomes a compliance liability.

Datacern turns that into a governed decision workflow: data comes in as governed datasets, agents watch the panel and the monthly billing queue and propose — a disposition, a model, a dashboard — grounded in the CMS rules, and a human on the care team approves. Every correction becomes training data. The nine agents are the workforce; this playbook is their job description for care management.

| The one rule that shapes everything CMM_AUTONOMOUS_BILLING_FORBIDDEN (BR-2). No agent ever files a bill, writes to the EHR, or posts a charge on its own. Every consequential action is a proposal routed to a care manager, clinician reviewer, or CFO for four-eyes approval. This is enforced by the platform, not by convention. |
|---|

# 2. The care team (who approves what)

The pack ships six care-team roles. Datacern only shows each person what their role allows; the approver on a proposal is never the one (or the agent) who created it.

| Role | Primary job | Approves |
|---|---|---|
| Care Manager RN | Works the panel + billing-review queue; signs care activity / RPM notes | activity & RPM notes, lower-risk billing dispositions |
| Care Manager LPN | Outreach, enrollment, documentation gathering | documentation-complete items |
| Clinician MD Reviewer | Clinical escalations, care-plan sign-off | escalate_md items, care plans |
| Director of Care Coordination | Program operations, staffing, KPIs | program-level & exception approvals |
| Practice CFO | Revenue integrity, billing sign-off | billing dispositions, revenue-leakage actions |
| Compliance Officer | Consent, audit defensibility, policy | consent holds, RAC-audit packages |

# 3. The nine agents, mapped to care management

Every agent below is the same platform agent you saw in the claims pack — specialised to Medicare care management through tenant configuration (persona + domain + CMS-rule grounding), not a code fork. Two agents (case-triage, analytics) carry explicit care-management instructions today; the rest apply unchanged.

| Agent | Its care-management job | Who approves the result |
|---|---|---|
| onboarding | Propose how to land EHR / RPM / claims / ADT feeds as governed datasets | Director / Data admin |
| analytics | Answer care KPI questions (enrollment, RPM adherence, revenue leakage) — read-only | — (no write) |
| dashboard-designer | Draft RPM-ops / enrollment-funnel / revenue-leakage boards | Director |
| model-training | Propose an enrollment-propensity / readmission-risk training run | Director / Data scientist |
| ml-engineer | Autonomously build & compare candidate risk models, propose the winner | Director (four-eyes promote) |
| inference | Batch-score the patient panel with the production risk model | Care Manager RN |
| case-triage | The billing reviewer: propose a disposition on each flagged BillingCandidate | Care Manager / Clinician / CFO |
| governance | Open a retrain proposal when a risk model drifts | Director / Data scientist |
| meta-router | Front door: route a free-text care-manager request to the right agent | (delegate's approver) |

The rest of this playbook is one section per agent: what it does, how to use it, and what it grounds on. The care-specific data it reasons over is already live in the platform:

Figure 1. Real care-management assets in the running platform: the care_mgmt_core and rpm_readings governed semantic models (alongside other packs’ models).

Figure 2. The care-management dashboards — Enrollment Funnel, Revenue Leakage, RPM Ops, Readmission Watch, Referral Intake, Post-Acute Network — installed by the pack.

# 4. Agent-by-agent playbook

## onboarding 4.1. Bring the care data in

Care management runs on data from many systems: EHR (Epic, athenahealth, eClinicalWorks…), RPM device vendors, claims, and ADT discharge feeds. The onboarding agent inspects a source and proposes an ingestion config + column mapping — grounded in the connector catalog and a live preview — landing patients, encounters, device readings, discharges, consents, and billing candidates as governed datasets.

How to use it:

- Go to Data → Data Sources → New data source; pick your EHR/RPM connector or upload a seed extract (CSV/Parquet).
- Ask onboarding (or the Copilot) to “onboard this RPM device feed as a dataset.” It returns an ingestion.create proposal with the mapped columns and types.
- A data admin approves; the feed lands as a ready dataset that everything downstream reads.

| Live vs deferred Production EHR/RPM connectors and SoR write-back (care-activity, care-plan, billing-candidate writes with idempotency keys) are materialised by pack-service with your credentials. Today the pack ships seed datasets in the exact landing shape, and all platform writes stay proposal-mode. |
|---|

## analytics 4.2. Ask the panel a question

The analytics agent answers care-management KPI questions over the governed care_mgmt_core and rpm_readings models — read-only, always citing the measures it used. It never writes.

Ask it things like:

- “What is our RPM 16-day compliance rate this month?” → rpm_16day_compliance_rate
- “Where is revenue leaking?” → total_expected_revenue (held_count × reimbursement)
- “What’s our TCM 2-day contact rate and 30-day readmission rate?” → tcm_2day_contact_rate, readmission_rate_30d
- “How many active patients per care manager?” → care_manager_active_patients

Open the Copilot on any care page and type the question; the answer is grounded and cites whether a figure is expected reimbursement vs posted revenue.

Figure 3. The role-grounded Copilot answering over the governed semantic layer. It reasons within your role and never fabricates — the same surface serves care-management questions.

## dashboard-designer 4.3. Stand up the ops boards

The dashboard-designer proposes a draft dashboard — a title plus charts bound to real measures/dimensions — grounded in the semantic layer and the chart catalog. For care management it drafts the three program boards: Enrollment Funnel, Revenue Leakage, and RPM Ops.

How to use it:

- Ask “design an RPM operations dashboard.” It proposes charts over rpm_readings (adherence, 16-day compliance, avg reading days).
- Review the chart.dashboard.create proposal; a director approves; the board appears under Dashboards (Figure 2).

## model-training 4.4. Propose a risk / propensity model

The model-training agent turns a plain-language goal into a governed training-run proposal: it resolves the algorithm, fills hyperparameters, and picks label + feature columns grounded in the algorithm catalog and prior runs. For care management the pack ships a real enrollment-propensity training pipeline.

- Ask “train an enrollment-propensity model on the patient panel to predict CCM uptake.”
- It returns a pipeline.template.create_from_algorithm proposal (algorithm, params, label = enrolled, features). Approve → the pipeline runs and registers a model.

Figure 4. Experiments & the model registry. A pipeline-trained model (e.g. enrollment propensity, readmission risk) auto-mirrors here, ready to gate and promote.

## ml-engineer 4.5. Build the model for me

Where model-training proposes one run, the ml-engineer agent runs the whole data-science loop autonomously: it inspects the dataset schema, launches several candidate models in sandboxed pipeline runs, compares real metrics, and proposes promoting the winner — four-eyes, never promoting directly. Use it to build the 30-day readmission-risk or enrollment-propensity model without hand-tuning.

- Point it at a prepared panel dataset and the label (e.g. readmitted_30d).
- It trains candidates, then emits an experiment.model.promote proposal for the best one, with the comparison as evidence. A director approves the promotion.

## inference 4.6. Score the panel

The inference agent proposes a batch scoring job: it resolves the model’s production version, checks the input dataset’s schema is compatible, and proposes a job whose output is a scored dataset the care team works from (e.g. this month’s readmission-risk or enrollment-propensity scores).

- Ask “score the current panel with the production readmission model.”
- It returns an inference.submit proposal (model version + input dataset, compatibility confirmed). A care manager approves; the scored panel lands as a dataset and feeds the worklist.

## case-triage 4.7. The billing reviewer (the heart of it)

This is the agent that earns the program its revenue safely. Each month the billing-review queue fills with auditor-flagged BillingCandidates plus drafted activity notes, care plans, RPM review notes, and TCM discharge items. For each, case-triage proposes a disposition — grounded in the retrieved CMS rules — citing the exact missing artifact. It never bills.

What it checks, in order (from the pack’s agent instructions):

- Consent — active, non-revoked consent for the program family (a hard prerequisite; revocation is immediate).
- Code time-minimums — 99490 ≥ 20 min, 99487 ≥ 60, 99424 ≥ 30, 99484 ≥ 20, 99492 ≥ 70, 99493 ≥ 60, 99457 ≥ 20 (+99439 add-on blocks).
- Same-month mutual exclusions — 99490 vs 99424; 99484 vs 99492–99494.
- RPM 16-day rule for 99454 — but 99457 stays billable independently when its 20-minute threshold is met.
- TCM windows — contact ≤ 2 business days; face-to-face ≤ 7 days (99496) / ≤ 14 days (99495); med-rec documented.
- Setting rules — FQHC/RHC bill G0511 instead of standard CCM/BHI; APCM (G0556/57/58) is bundled and replaces CCM/PCM/TCM that month.

The dispositions it proposes

| Disposition | Meaning | Signal |
|---|---|---|
| bill_approved | Approve the flagged codes | false positive |
| bill_held | Hold for missing documentation (note required) | true positive |
| bill_adjusted | Code adjusted before billing (note required) | other |
| consent_issue_confirmed | Consent missing/revoked — do not bill | true positive |
| activity_note_approved | Care-activity note approved | benign |
| care_plan_approved | Care plan approved as plan of record | benign |
| rpm_review_signed | RPM review note signed | benign |
| escalate_md | Escalate to clinician reviewer | inconclusive |

How the care team uses it:

- Open Cases — the monthly billing-review worklist, ranked. Each row is a flagged candidate with its patient/program context.

Figure 5. The review worklist surface (claims demo shown; for care management this is the monthly billing-review queue of flagged BillingCandidates).

- Open a candidate. The Overview shows the evidence; the AI recommendation names the exact gap (e.g. “99457 held — RPM 16-day rule not met; 99457 time minimum IS met, propose bill 99457 only”).

Figure 6. A case with grounded evidence and the AI’s recommendation. In care management the recommendation cites the CMS rule and the exact missing artifact.

- Open Proposals to see the disposition as a reviewable diff, then decide. The proposal is inert until a human approves.

Figure 7. The disposition proposal as a field-level diff. Nothing is billed until the care manager, clinician, or CFO approves.

- Approve, edit (the corrected disposition becomes training data), or reject with a reason — from the Approvals inbox. Four-eyes: the approver is not the proposer.

Figure 8. The approval inbox. Every billing disposition is approved here by a different person than the one who raised it — four-eyes on revenue.

## governance 4.8. Keep the models honest

The governance agent runs autonomously under its own agent principal (never a borrowed clinician identity). When a risk model drifts or human corrections pile up past threshold, it opens a mlops.open_retrain proposal with the evidence summarised — so the readmission or propensity model that feeds the panel stays accurate. A director approves the retrain.

## meta-router 4.9. The care manager’s front door

A care manager doesn’t think in agent names. The meta-router takes a free-text request, classifies it, and delegates to the right specialist — the delegate’s own write mode governs whether a proposal results.

- “Which patients are eligible for CCM this month?” → analytics
- “Are any RPM bills missing the 16-day threshold?” → case-triage over the flagged queue
- “Build me a readmission model” → ml-engineer / model-training

Everything the delegate produces still flows through the same proposal + approval gate.

# 5. The monthly cycle — how the agents chain

Across a billing month the agents form one governed loop:

| Governed automation is real Decision tables let you encode deterministic care rules (e.g. “TCM face-to-face overdue → escalate_md”) that propose a disposition for approval — never decide autonomously — sitting right alongside the agents. |
|---|

Figure 9. Governed decision tables: deterministic care rules that propose a disposition for human approval, versioned and approved by a named user.

# 6. Governance & compliance

- No autonomous billing (BR-2). Every billing decision is a human-approved proposal. Enforced by the platform.
- Four-eyes. The approver is structurally never the proposer (or the agent).
- CMS rules as grounding. Consent, code time-minimums, mutual exclusions, RPM 16-day, TCM windows, FQHC G0511, APCM bundling are retrieved as grounding memories the agents must cite.
- Eval-gated models. A risk/propensity model is promoted only after passing its eval suite; rollback = demote.

Figure 10. The eval flywheel — the promotion gate for the care-management risk models: scoring runs & gates, scorers, and canary A/B.

- Audit trail. Every proposal, decision, and tool call is recorded (RAC-audit-defensible); authorization is per-request against your role.

# 7. What is live today vs pack-service-deferred

In the spirit of no-fake: the pack is honest about what Core materialises today and what awaits pack-service. Nothing below is stubbed — deferred items are recorded in the install ledger, and the guarantees they need (proposal-mode + four-eyes) already hold.

| Capability | Status |
|---|---|
| Semantic models (care_mgmt_core, rpm_readings), dashboards, saved/verified queries | Live |
| Billing-review case queue + disposition taxonomy + care-team roles | Live |
| case-triage + analytics specialised to Medicare care management (CMS-rule grounding) | Live |
| Enrollment-propensity training pipeline | Live |
| 8 bespoke agent recipes (care_scribe, code_selection, rpm_reviewer, tcm_prioritizer…) | Deferred → served today via config on the fixed agents |
| Model archetypes (readmission_risk_30d, enrollment_propensity) | Deferred → capability exists via pipelines/ml-engineer |
| Production EHR/RPM connectors + SoR write adapters | Deferred → customer creds via pack-service; seed datasets today |
| Guardrail OPA policies (hipaa.rego, cms_time_thresholds, rpm_16day_rule…) | Deferred → carried today as grounding + proposal-mode+four-eyes |

Grounded in the real care-management-medicare pack (BRD 25). Screenshots showing care assets (semantic models, dashboards) are live from the running platform; agent-surface screenshots are the shared, pack-agnostic surfaces (claims demo shown) — the care pack drives the identical surfaces with care data. Where a capability awaits pack-service, this playbook says so rather than implying it is materialised.
