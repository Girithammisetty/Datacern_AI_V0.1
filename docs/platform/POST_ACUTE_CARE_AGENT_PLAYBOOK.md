<!-- converted from POST_ACUTE_CARE_AGENT_PLAYBOOK.docx by tools/docs/docx_to_md.py -->
> **Converted from Word.** This is a point-in-time snapshot: figures in it were accurate on the date stated below and have not been re-verified against the current codebase. For counts that are checked continuously, see the root [`README.md`](../../README.md).

DATACERN AI · POST-ACUTE CARE

Agent Playbook

How to put the nine Datacern agents to work across home health, SNF, and hospice.

This playbook maps each of Datacern’s nine agents to a concrete job in post-acute care, grounded in the real post-acute-care v1.0.0 pack (BRD 29).

Pack: post-acute-care v1.0.0

Scope: Home Health · SNF · Hospice · PDGM · PDPM · OASIS-E · MDS 3.0

Audience: HHA Clinical Nurse, SNF MDS Coordinator, Intake Coordinator, Post-Acute Care Manager, PAC Compliance Officer

Golden rule: Datacern never finalizes an assessment. Clinical staff finalize every OASIS/MDS; every case-mix or referral decision is a proposal a human approves (four-eyes).

Date: 2026-07-17

# Contents

# 1. The post-acute care problem Datacern solves

Post-acute revenue and quality both hinge on getting the case mix and the assessment right: PDGM comorbidity capture, PDPM therapy alignment, OASIS-E / MDS 3.0 timing, hospice LCD certification — each documented well enough to survive a CERT / RAC / UPIC audit. Meanwhile a 30-day rehospitalization quietly erodes both outcomes and network standing.

Datacern makes this a governed workflow: referrals, episodes, assessments, and readmission-risk signals land as governed data; agents watch the care-transition queue and propose — a comorbidity code, a therapy realignment, a risk intervention — grounded in source documentation; and clinical staff approve. The nine agents are the workforce.

| The one rule that shapes everything PAC_AUTONOMOUS_ASSESSMENT_FORBIDDEN (BR-1). No agent finalizes or submits an OASIS or MDS assessment, sets hospice eligibility, or increases therapy on its own. It drafts and recommends; clinical staff finalize. Readmission-risk scores prioritize outreach only — they never justify a care-denial or discharge decision (BR-7). |
|---|

# 2. The team (who approves what)

The pack ships these roles. Datacern only shows each person what their role allows; the approver on a proposal is never the one (or the agent) who created it.

| Role | Primary job | Approves |
|---|---|---|
| HHA Clinical Nurse | Home-health visits, OASIS assessment, care activities | activity notes, OASIS finalization |
| SNF MDS Coordinator | MDS 3.0 assessments, PDPM case mix | MDS finalization, therapy realignment |
| Intake Coordinator | Referral triage and acceptance | referral accept/decline |
| Post-Acute Care Manager | Care transitions, readmission-risk interventions | risk interventions, program actions |
| PAC Compliance Officer | CERT/RAC/UPIC defensibility, policy | audit packages, escalations |

# 3. The nine agents, mapped to this vertical

Every agent below is the same platform agent — specialised to post-acute care through tenant configuration (persona + domain + rule grounding), not a code fork. case-triage and analytics carry explicit domain instructions today; the rest apply unchanged.

| Agent | Its job in this vertical | Who approves |
|---|---|---|
| onboarding | Propose how to land the source feeds as governed datasets | Director / Data admin |
| analytics | Answer KPI questions over the governed models — read-only | — (no write) |
| dashboard-designer | Draft the operational dashboards | Director |
| model-training | Propose a 30-day rehospitalization-risk training run | Director / Data scientist |
| ml-engineer | Autonomously build & compare candidate models, propose the winner | Director (four-eyes) |
| inference | Batch-score with the production model | Analyst / Manager |
| case-triage | The reviewer: propose a disposition on each queued case | Domain reviewer |
| governance | Open a retrain proposal when a model drifts | Director / Data scientist |
| meta-router | Front door: route a free-text request to the right agent | (delegate’s approver) |

The domain data these agents reason over is live in the platform:

Figure 1. Real assets in the running platform: the pac_episodes and pac_referrals governed semantic models (among other packs’ models).

Figure 2. The pack’s dashboards — Post-Acute Network, Readmission Watch, and Referral Intake — installed alongside other packs’ boards.

# 4. Agent-by-agent playbook

## onboarding 4.1. Bring the data in

The onboarding agent inspects a source and proposes an ingestion config + column mapping, grounded in the connector catalog and a live preview — landing the domain feeds as governed datasets.

- Go to Data → Data Sources → New data source; pick a connector or upload a seed extract.
- Ask onboarding to “onboard this feed as a dataset.” It returns an ingestion.create proposal; a data admin approves; the feed lands ready.

## analytics 4.2. Ask the KPIs

The analytics agent answers KPI questions over the governed pac_episodes and pac_referrals models — read-only, always citing the measures it used.

Ask it things like:

- “What’s our 30-day rehospitalization rate?” → rehospitalization_30d_rate
- “Are we capturing PDGM comorbidities (target ≥ 30%)?” → pdgm_comorbidity_capture_rate
- “What’s our CERT audit pass rate and avg length of stay?” → cert_audit_pass_rate, avg_los_days
- “Referral acceptance rate and response time?” → referral_acceptance_rate, avg_response_hours

Figure 3. The role-grounded Copilot answering over the governed semantic layer — grounded, never fabricated. The same surface serves this vertical’s questions.

## dashboard-designer 4.3. Stand up the boards

It proposes a draft dashboard — title + charts bound to real measures/dimensions — grounded in the semantic layer and chart catalog.

- Ask “design a readmission-watch board.” It proposes charts over pac_episodes and pac_referrals.
- Review the chart.dashboard.create proposal; a director approves; the board appears under Dashboards (Figure 2).

## model-training 4.4. Propose a 30-day rehospitalization-risk model

It turns a plain-language goal into a governed training-run proposal, resolving algorithm + hyperparameters + label/features grounded in the algorithm catalog and prior runs. The pack ships a real 30-day rehospitalization-risk training pipeline.

- Ask “train a 30-day rehospitalization-risk model on the panel.”
- It returns a pipeline.template.create_from_algorithm proposal (algorithm, params, label = readmitted_30d). Approve → the pipeline runs and registers a model.

Figure 4. Experiments & the model registry. A pipeline-trained model auto-mirrors here, ready to gate and promote.

## ml-engineer 4.5. Build the model for me

The ml-engineer agent runs the whole loop autonomously: inspects the schema, launches candidate models in sandboxed pipeline runs, compares real metrics, and proposes promoting the winner — four-eyes, never promoting directly.

- Point it at a prepared dataset and the label (readmitted_30d).
- It emits an experiment.model.promote proposal for the best candidate, with the comparison as evidence. A director approves.

## inference 4.6. Score the population

The inference agent proposes a batch scoring job: it resolves the model’s production version, checks input-schema compatibility, and proposes a job whose output is a scored dataset the team works from.

- Ask “score the current census with the production rehospitalization-risk model.”
- It returns an inference.submit proposal (model version + input dataset, compatibility confirmed). Approve; the scored set feeds the worklist.

## case-triage 4.7. The care-transition reviewer

Each day the care-transition queue fills with OASIS/MDS assessment reviews, PDGM comorbidity and PDPM therapy-alignment flags, referral-triage decisions, hospice recertification narratives, and 30-day readmission-risk interventions. For each, case-triage proposes a disposition grounded in the source documentation, citing the exact evidence. It never finalizes an assessment.

What it checks (from the pack’s agent instructions):

- Source-cited case mix — every proposed PDGM comorbidity / PDPM code traces to a discharge summary, med list, or therapy note (BR-3, CERT/RAC/UPIC).
- Assessment integrity — OASIS/MDS are drafted for clinical review only — clinical staff finalize every assessment (BR-1).
- Therapy justification — never propose a therapy increase beyond documented clinical justification (BR-4).
- Hospice — draft the eligibility narrative for physician certification — never make the determination (BR-5).
- Referrals — a decline always carries a documented rationale (BR-6).
- Risk use — readmission-risk prioritizes outreach; it never justifies denial or discharge (BR-7).

The dispositions it proposes

| Disposition | Meaning | Category |
|---|---|---|
| comorbidity_codes_accepted | PDGM comorbidity codes accepted | true_positive |
| comorbidity_codes_rejected | Proposed codes lack documentation (BR-3) | false_positive |
| therapy_plan_realigned | PDPM therapy plan brought into alignment | true_positive |
| risk_intervention_started | Readmission-risk intervention initiated | true_positive |
| risk_flag_cleared | Risk flag cleared — no intervention | false_positive |
| referral_accept_confirmed | Referral accepted — intake confirmed | benign |
| referral_decline_confirmed | Referral declined (rationale required) | other |
| escalate_medical_director | Escalate to medical director | inconclusive |

How the team uses it:

- Open Cases — the care-transition queue, ranked. Each row is a queued item with its context.

Figure 5. The review worklist surface (claims demo shown; here it is the care-transition queue).

- Open an item. The Overview shows the evidence; the AI recommendation names the exact basis — e.g. “PDGM comorbidity K55.1 proposed — cited in the discharge summary; capture adds one comorbidity tier”.

Figure 6. A case with grounded evidence and the AI’s recommendation, citing the rule and the exact source artifact.

- Open Proposals to see the disposition as a reviewable diff, then decide — inert until a human approves.

Figure 7. The disposition proposal as a field-level diff. Nothing is actioned until a human approves.

- Approve, edit (the correction becomes training data), or reject with a reason from the Approvals inbox. Four-eyes: the approver is not the proposer.

Figure 8. The approval inbox. Every disposition is approved by a different person than the one who raised it — four-eyes.

## governance 4.8. Keep the models honest

The governance agent runs autonomously under its own agent principal. When the 30-day rehospitalization-risk model drifts or corrections pile up past threshold, it opens a mlops.open_retrain proposal with the evidence summarised. A director approves.

## meta-router 4.9. The team’s front door

The meta-router takes a free-text request, classifies it, and delegates to the right specialist — the delegate’s own write mode governs whether a proposal results. Everything still flows through the same proposal + approval gate.

# 5. The operating cycle — how the agents chain

- Land data — onboarding proposes ingestions → the source feeds become governed datasets.
- Watch — analytics + dashboards surface where attention is needed.
- Predict — ml-engineer / model-training build the model; inference scores the population.
- Review & decide — case-triage proposes dispositions on the queue; the team approves (four-eyes).
- Write back — approved actions sync to the system of record in proposal-mode (pack-service adapters).
- Learn — every correction trains the next model; governance opens a retrain on drift.

| Governed automation is real Decision tables let you encode deterministic rules that propose a disposition for approval — never decide autonomously — alongside the agents. |
|---|

Figure 9. Governed decision tables: deterministic rules that propose a disposition for human approval, versioned and approved by a named user.

# 6. Governance & compliance

- No autonomous action. PAC_AUTONOMOUS_ASSESSMENT_FORBIDDEN — every consequential action is a human-approved proposal.
- Four-eyes. The approver is structurally never the proposer (or the agent).
- Rules as grounding. The domain’s regulatory rules are retrieved as grounding the agents must cite.
- Eval-gated models. A model is promoted only after passing its eval suite; rollback = demote.

Figure 10. The eval flywheel — the promotion gate for this vertical’s models: scoring runs & gates, scorers, and canary A/B.

- Audit trail. Every proposal, decision, and tool call is recorded (audit-defensible); authorization is per-request against your role.

# 7. What is live today vs pack-service-deferred

In the spirit of no-fake: deferred items are recorded in the install ledger, and the guarantees they need (proposal-mode + four-eyes) already hold. Nothing below is stubbed.

| Capability | Status |
|---|---|
| Semantic models (pac_episodes, pac_referrals), dashboards, saved/verified queries | Live |
| Care-transition case queue + disposition taxonomy + post-acute role catalog | Live |
| case-triage + analytics specialised to post-acute (OASIS/MDS/PDGM/PDPM grounding) | Live |
| 30-day rehospitalization-risk training pipeline | Live |
| Bespoke recipes (assessment scribe, therapy optimizer, hospice narrative…) | Deferred → served via config on the fixed agents |
| OASIS-E/MDS timing + PDGM LUPA + hospice LCD OPA guardrails | Deferred → carried today as grounding + proposal-mode+four-eyes |
| Production EHR/EMR connectors + assessment write adapters | Deferred → customer creds via pack-service; seed datasets today |

Grounded in the real post-acute-care pack (BRD 29). Screenshots of domain assets (semantic models, dashboards) are live from the running platform; agent-surface screenshots are the shared, pack-agnostic surfaces (claims demo shown) — this pack drives the identical surfaces with its own data. Where a capability awaits pack-service, this playbook says so.
