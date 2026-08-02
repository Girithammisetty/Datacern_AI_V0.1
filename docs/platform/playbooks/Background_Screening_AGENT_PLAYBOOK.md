<!-- converted from Background_Screening_AGENT_PLAYBOOK.docx by tools/docs/docx_to_md.py -->
> **Converted from Word.** This is a point-in-time snapshot: figures in it were accurate on the date stated below and have not been re-verified against the current codebase. For counts that are checked continuously, see the root [`README.md`](../../README.md).

DATACERN AI · BACKGROUND SCREENING

Agent Playbook

How to put the nine Datacern agents to work in background screening.

This playbook maps each of Datacern’s nine agents to a concrete job in this vertical, grounded in the real background-screening pack.

Pack: background-screening v1.0.0

Domain: screening · employment · hr_compliance · gig_platforms · adjudication

Regulatory: fcra, eeoc_title_vii, ban_the_box, state_screening_laws, cfpb

Golden rule: Datacern proposes; a human decides. Four-eyes is the default on AI-proposed writes and is mandatory — with no tenant opt-out — for high-risk, destructive and admin actions. Tenants may policy-enable auto-execution for low-risk, non-destructive writes.

Date: 2026-07-17

# Contents

# 1. What this pack does

AI-assisted employment background-screening adjudication for CRAs, employer talent-compliance teams, and gig platforms: screening-hit triage with FCRA accuracy and obsolescence awareness (7-year rule, 607(b) maximum-possible-accuracy, 613 public-record rails), identity resolution for common-name/mixed-file hits, pre-adverse/adverse-action two-step clock tracking, EEOC individualized-assessment routing (Green factors), screening-operations KPI semantic model and dashboards (clear rate, adverse-finding rate, suppression rate, identity-escalation share, deadline runway, turnaround), applicant-employer network analytics, FCRA/EEOC grounding memories, and order-anomaly + hit-outcome training pipelines.

Datacern makes it a governed decision workflow: the source data lands as governed datasets; the agents watch the queue and propose — a disposition, a model, a dashboard — grounded in the domain rules; and a human approves. Every correction trains the next model. The nine agents are the workforce; this playbook is their job description.

| The rule that shapes everything Datacern proposes; a human decides. Proposal-mode + four-eyes: no agent writes or actions on its own — every consequential step is a human-approved proposal. Enforced by the platform. |
|---|

# 2. The team (who does the approving)

The pack ships these roles. Each person only sees what their role allows; the approver on a proposal is never the one (or the agent) who created it.

| Role | Responsibility |
|---|---|
| Screening Adjudicator | — |
| Identity Resolution Specialist | — |
| Adverse Action Coordinator | — |
| Screening Operations Manager | — |
| FCRA Compliance Auditor | — |

# 3. The nine agents, mapped to this vertical

Every agent below is the same platform agent — specialised to this domain through tenant configuration (persona + domain + rule grounding), not a code fork. case-triage and analytics carry explicit domain instructions today; the rest apply unchanged.

| Agent | Its job here | Who approves |
|---|---|---|
| onboarding | Propose how to land the source feeds as governed datasets | Director / Data admin |
| analytics | Answer KPI questions over the governed models — read-only | — (no write) |
| dashboard-designer | Draft the operational dashboards | Director |
| model-training | Propose a order-anomaly + hit-outcome training run | Director / Data scientist |
| ml-engineer | Autonomously build & compare candidate models, propose the winner | Director (four-eyes) |
| inference | Batch-score with the production model | Analyst / Manager |
| case-triage | The reviewer: propose a disposition on each queued case | Domain reviewer |
| governance | Open a retrain proposal when a model drifts | Director / Data scientist |
| meta-router | Front door: route a free-text request to the right agent | (delegate’s approver) |

The domain data these agents reason over is live in the platform’s governed layer:

Figure 1. The platform’s Semantic Models surface (models from many installed packs shown). This pack adds: screening_core.

Figure 2. The Dashboards surface. This pack installs: Screening_adjudication_center, Adverse_action_clocks, Accuracy_identity_watch.

# 4. Agent-by-agent playbook

## onboarding 4.1. Bring the data in

The onboarding agent inspects a source and proposes an ingestion config + column mapping, grounded in the connector catalog and a live preview.

- Go to Data → Data Sources → New data source; pick a connector or upload a seed extract.
- Ask it to “onboard this feed as a dataset.” It returns an ingestion.create proposal; a data admin approves; the feed lands ready.

## analytics 4.2. Ask the KPIs

The analytics agent answers KPI questions over the governed screening_core model(s) — read-only, citing the measures it used. From the pack’s own analytics instructions:

| Analytics grounding (from the pack) Answer screening-program KPI questions from the governed semantic model screening_core: clear_rate, adverse_finding_rate, suppression_rate (the accuracy-save rate), identity_escalation_share, criminal_hit_share, avg_review_age_days (backlog aging), avg_deadline_runway_days and the deadline_bucket runway, and order-side surfaces (order_count, driver_order_count, delayed_order_count, avg_turnaround_days). Use plain operational language for screening-operations and compliance staff and always cite the measure names you used. Slice by check type, hit type, record age band, relevance, identity confidence, severity, de… |
|---|

Figure 3. The role-grounded Copilot answering over the governed semantic layer — grounded, never fabricated. The same surface serves this vertical.

## dashboard-designer 4.3. Stand up the boards

It proposes a draft dashboard — title + charts bound to real measures/dimensions — grounded in the semantic layer. Ask “design a board for this program”; review the chart.dashboard.create proposal; a director approves (the boards appear as in Figure 2).

## model-training 4.4. Propose a order-anomaly + hit-outcome model

It turns a plain-language goal into a governed training-run proposal — algorithm, hyperparameters, label/features — grounded in the algorithm catalog and prior runs. The pack ships a real order-anomaly + hit-outcome training pipeline.

- Ask “train a order-anomaly + hit-outcome model on the panel.” It returns a pipeline.template.create_from_algorithm proposal; approve → the pipeline runs and registers a model.

Figure 4. Experiments & the model registry — a pipeline-trained model auto-mirrors here, ready to gate and promote.

## ml-engineer 4.5. Build the model for me

The ml-engineer agent runs the whole loop autonomously: inspects the schema, launches candidate models in sandboxed pipeline runs, compares real metrics, and proposes promoting the winner via experiment.model.promote — four-eyes, never promoting directly.

## inference 4.6. Score the population

The inference agent proposes a batch scoring job: it resolves the model’s production version, checks input-schema compatibility, and proposes an inference.submit job whose output is a scored dataset the team works from. A human approves before it runs.

## case-triage 4.7. The reviewer (the heart of it)

Each queued case (adjudication_queue) gets a proposed disposition, grounded in the domain rules and citing the exact basis. It never takes the action itself. From the pack’s own triage instructions:

| Triage grounding (from the pack) You triage employment background-screening hits for a consumer reporting agency and its employer customers under the FCRA (accuracy, obsolescence, and adverse-action duties) and the EEOC's criminal-history guidance. Ground every recommendation in the specific row-level evidence — cite review ids, order ids, applicant ids, check and hit types, record age, identity-match facts (middle name, DOB, address history), position category, and the applicant's history (prior orders, prior dispute). Watch two clocks first: days_to_deadline on any pre-adverse-action response window or dispute-reinvestigation deadline (disputes must be reinvestigated within 30 days), and never let a convenience concern shorten the applicant's customary response window of roughly five business days after the pre-adverse notice. Accuracy outranks speed: a hit may only be reported if it meets the 607(b) maximum-possible-… |
|---|

The dispositions it proposes

| Disposition | Meaning | Category |
|---|---|---|
| clear_report_eligible | Clear — no reportable adverse information | benign |
| report_adverse_finding | Report adverse finding — verified, reportable, job-related | true_positive |
| suppress_not_reportable | Suppress — not reportable (obsolete or mismatched record) | false_positive |
| request_identity_verification | Request identity verification — insufficient identity match | inconclusive |
| individualized_assessment_review | Route to individualized assessment (EEOC Green factors) | other |

How the team uses it:

- Open Cases — the ranked review worklist. Each row is a queued item with its context.

Figure 5. The review worklist surface (claims demo shown; this pack drives the identical surface with its own queue).

- Open an item; the Overview shows the evidence and the AI recommendation citing the rule + source. Open Proposals to see the disposition as a diff.

Figure 6. A disposition proposal as a field-level diff — inert until a human approves.

- Approve, edit (the correction becomes training data), or reject with a reason from the Approvals inbox — four-eyes.

Figure 7. The approval inbox. Every disposition is approved by someone other than the proposer — four-eyes.

## governance 4.8. Keep the models honest

The governance agent runs autonomously under its own agent principal; when a model drifts or corrections pile up past threshold it opens a mlops.open_retrain proposal with the evidence summarised. A director approves.

## meta-router 4.9. The team’s front door

The meta-router takes a free-text request, classifies it, and delegates to the right specialist — analytics for a question, case-triage for a queued item, ml-engineer for a model. Everything still flows through the same proposal + approval gate.

# 5. The operating cycle

| Governed automation is real Decision tables let you encode deterministic rules that propose a disposition for approval — never decide autonomously — alongside the agents. |
|---|

Figure 8. Governed decision tables: deterministic rules that propose a disposition for human approval, versioned and approved by a named user.

# 6. Governance & the eval gate

- No autonomous action. Every consequential step is a human-approved proposal (four-eyes).
- Rules as grounding. The domain’s regulatory rules are retrieved as grounding the agents must cite (fcra, eeoc_title_vii, ban_the_box, state_screening_laws, cfpb).
- Eval-gated models. A model is promoted only after passing its eval suite; rollback = demote.

Figure 9. The eval flywheel — the promotion gate for this vertical’s models: runs & gates, scorers, and canary A/B.

# 7. What is live today vs pack-service-deferred

In the spirit of no-fake: what Core materialises today is live; the rest is recorded in the install ledger as deferred, with the proposal-mode + four-eyes guarantees already holding. Nothing is stubbed.

| Capability | Status |
|---|---|
| Semantic models (screening_core), dashboards, saved/verified queries | Live |
| Review case queue + disposition taxonomy + role catalog | Live |
| case-triage + analytics specialised to this domain (rule grounding) | Live |
| order-anomaly + hit-outcome training pipeline | Live |
| Deferred to pack-service: guardrails, agent_recipes, connection_templates, write_adapters, eval_sets, ontology, case_schemas, model_archetypes, display_labels | Deferred → served today via config + seed data; guarantees hold |

Grounded in the real background-screening pack (its own pack.yaml, dispositions, roles, and agent instructions). The domain-asset captions name this pack’s real models/dashboards; agent-surface screenshots are the shared, pack-agnostic surfaces (claims demo shown) — this pack drives the identical surfaces with its own data. Where a capability awaits pack-service, this playbook says so.
