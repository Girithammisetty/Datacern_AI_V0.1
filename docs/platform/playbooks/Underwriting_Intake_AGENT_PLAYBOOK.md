<!-- converted from Underwriting_Intake_AGENT_PLAYBOOK.docx by tools/docs/docx_to_md.py -->
> **Converted from Word.** This is a point-in-time snapshot: figures in it were accurate on the date stated below and have not been re-verified against the current codebase. For counts that are checked continuously, see the root [`README.md`](../../README.md).

DATACERN AI · UNDERWRITING INTAKE

Agent Playbook

How to put the nine Datacern agents to work in underwriting intake.

This playbook maps each of Datacern’s nine agents to a concrete job in this vertical, grounded in the real underwriting-intake pack.

Pack: underwriting-intake v1.0.0

Domain: insurance · underwriting · commercial_lines · intake · triage

Regulatory: state_unfair_trade_practices, surplus_lines_diligent_search, naic_ai_bulletin, fair_underwriting

Golden rule: Datacern proposes; a human decides. Four-eyes is the default on AI-proposed writes and is mandatory — with no tenant opt-out — for high-risk, destructive and admin actions. Tenants may policy-enable auto-execution for low-risk, non-destructive writes.

Date: 2026-07-17

# Contents

# 1. What this pack does

AI-assisted commercial underwriting submission intake and triage: clearance-first duplicate blocking (first-in broker holds the market), appetite-fit and completeness triage (ACORD apps, currently-valued loss runs, SOV/COPE), broker needed-by deadline awareness with renewal-defense prioritization, E&S specialty-market referral with documented admitted-market declination, declination hygiene with risk-based reasons, submission-funnel KPI semantic model and dashboards (accept-to-underwriter rate, declination rate, info-request share, appetite/completeness mix, deadline runway, broker-tier and premium-band mix), broker-line network analytics, clearance/appetite/E&S/cyber-controls/fair-underwriting grounding memories, and account-anomaly + triage-outcome training pipelines.

Datacern makes it a governed decision workflow: the source data lands as governed datasets; the agents watch the queue and propose — a disposition, a model, a dashboard — grounded in the domain rules; and a human approves. Every correction trains the next model. The nine agents are the workforce; this playbook is their job description.

| The rule that shapes everything Datacern proposes; a human decides. Proposal-mode + four-eyes: no agent writes or actions on its own — every consequential step is a human-approved proposal. Enforced by the platform. |
|---|

# 2. The team (who does the approving)

The pack ships these roles. Each person only sees what their role allows; the approver on a proposal is never the one (or the agent) who created it.

| Role | Responsibility |
|---|---|
| Submission Intake Analyst | — |
| Appetite & Clearance Specialist | — |
| Underwriting Assistant | — |
| Underwriting Operations Manager | — |
| Underwriting Audit Lead | — |

# 3. The nine agents, mapped to this vertical

Every agent below is the same platform agent — specialised to this domain through tenant configuration (persona + domain + rule grounding), not a code fork. case-triage and analytics carry explicit domain instructions today; the rest apply unchanged.

| Agent | Its job here | Who approves |
|---|---|---|
| onboarding | Propose how to land the source feeds as governed datasets | Director / Data admin |
| analytics | Answer KPI questions over the governed models — read-only | — (no write) |
| dashboard-designer | Draft the operational dashboards | Director |
| model-training | Propose a account-anomaly + triage-outcome training run | Director / Data scientist |
| ml-engineer | Autonomously build & compare candidate models, propose the winner | Director (four-eyes) |
| inference | Batch-score with the production model | Analyst / Manager |
| case-triage | The reviewer: propose a disposition on each queued case | Domain reviewer |
| governance | Open a retrain proposal when a model drifts | Director / Data scientist |
| meta-router | Front door: route a free-text request to the right agent | (delegate’s approver) |

The domain data these agents reason over is live in the platform’s governed layer:

Figure 1. The platform’s Semantic Models surface (models from many installed packs shown). This pack adds: underwriting_core.

Figure 2. The Dashboards surface. This pack installs: Submission_intake_center, Appetite_clearance, Broker_funnel_performance.

# 4. Agent-by-agent playbook

## onboarding 4.1. Bring the data in

The onboarding agent inspects a source and proposes an ingestion config + column mapping, grounded in the connector catalog and a live preview.

- Go to Data → Data Sources → New data source; pick a connector or upload a seed extract.
- Ask it to “onboard this feed as a dataset.” It returns an ingestion.create proposal; a data admin approves; the feed lands ready.

## analytics 4.2. Ask the KPIs

The analytics agent answers KPI questions over the governed underwriting_core model(s) — read-only, citing the measures it used. From the pack’s own analytics instructions:

| Analytics grounding (from the pack) Answer submission-funnel KPI questions from the governed semantic model underwriting_core: accept_to_underwriter_rate, declination_rate, info_request_share, in_appetite_share, complete_submission_share, avg_triage_age_days (backlog aging / speed-to-first-touch), avg_deadline_runway_days, urgent_count (renewal-defense pressure), and book-quality surfaces (adverse_loss_history_count, preferred_risk_count). Use plain operational language for underwriting operations and distribution staff and always cite the measure names you used. Slice by line of business, segment, appetite fit, completeness, priority band, broker … |
|---|

Figure 3. The role-grounded Copilot answering over the governed semantic layer — grounded, never fabricated. The same surface serves this vertical.

## dashboard-designer 4.3. Stand up the boards

It proposes a draft dashboard — title + charts bound to real measures/dimensions — grounded in the semantic layer. Ask “design a board for this program”; review the chart.dashboard.create proposal; a director approves (the boards appear as in Figure 2).

## model-training 4.4. Propose a account-anomaly + triage-outcome model

It turns a plain-language goal into a governed training-run proposal — algorithm, hyperparameters, label/features — grounded in the algorithm catalog and prior runs. The pack ships a real account-anomaly + triage-outcome training pipeline.

- Ask “train a account-anomaly + triage-outcome model on the panel.” It returns a pipeline.template.create_from_algorithm proposal; approve → the pipeline runs and registers a model.

Figure 4. Experiments & the model registry — a pipeline-trained model auto-mirrors here, ready to gate and promote.

## ml-engineer 4.5. Build the model for me

The ml-engineer agent runs the whole loop autonomously: inspects the schema, launches candidate models in sandboxed pipeline runs, compares real metrics, and proposes promoting the winner via experiment.model.promote — four-eyes, never promoting directly.

## inference 4.6. Score the population

The inference agent proposes a batch scoring job: it resolves the model’s production version, checks input-schema compatibility, and proposes an inference.submit job whose output is a scored dataset the team works from. A human approves before it runs.

## case-triage 4.7. The reviewer (the heart of it)

Each queued case (submission_queue) gets a proposed disposition, grounded in the domain rules and citing the exact basis. It never takes the action itself. From the pack’s own triage instructions:

| Triage grounding (from the pack) You triage commercial P&C underwriting submissions for a carrier/MGA intake desk: clearance first, then appetite, then completeness, then priority. Ground every recommendation in row-level evidence — cite submission ids, account ids, insured ids, broker names and tiers, loss history, TIV bands, completeness flags, and the days_to_deadline runway. Clearance comes before everything: the first broker to submit a risk holds the market, so on a duplicate submission verify received order and any broker-of-record letter before proposing an outcome. Watch the broker's needed-by date next — speed-to-first-touch drives quote-to-bind hit ratio, and renewal-defense submissions inside a 0_3_days runway outrank everything else in the queue. Propose one disposition per submission: accept_route_to_underwriter (in appetite, cleared, file complete enough to work), decline_out_of_appetite (the risk sits ou… |
|---|

The dispositions it proposes

| Disposition | Meaning | Category |
|---|---|---|
| accept_route_to_underwriter | Accept — clear and route to underwriter | true_positive |
| decline_out_of_appetite | Decline — out of appetite (documented reasons) | false_positive |
| request_missing_information | Request missing information from broker | inconclusive |
| refer_specialty_market | Refer to specialty / E&S market | other |
| close_broker_withdrawn | Close — broker withdrew the submission | benign |

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
- Rules as grounding. The domain’s regulatory rules are retrieved as grounding the agents must cite (state_unfair_trade_practices, surplus_lines_diligent_search, naic_ai_bulletin, fair_underwriting).
- Eval-gated models. A model is promoted only after passing its eval suite; rollback = demote.

Figure 9. The eval flywheel — the promotion gate for this vertical’s models: runs & gates, scorers, and canary A/B.

# 7. What is live today vs pack-service-deferred

In the spirit of no-fake: what Core materialises today is live; the rest is recorded in the install ledger as deferred, with the proposal-mode + four-eyes guarantees already holding. Nothing is stubbed.

| Capability | Status |
|---|---|
| Semantic models (underwriting_core), dashboards, saved/verified queries | Live |
| Review case queue + disposition taxonomy + role catalog | Live |
| case-triage + analytics specialised to this domain (rule grounding) | Live |
| account-anomaly + triage-outcome training pipeline | Live |
| Deferred to pack-service: guardrails, agent_recipes, connection_templates, write_adapters, eval_sets, ontology, case_schemas, model_archetypes, display_labels | Deferred → served today via config + seed data; guarantees hold |

Grounded in the real underwriting-intake pack (its own pack.yaml, dispositions, roles, and agent instructions). The domain-asset captions name this pack’s real models/dashboards; agent-surface screenshots are the shared, pack-agnostic surfaces (claims demo shown) — this pack drives the identical surfaces with its own data. Where a capability awaits pack-service, this playbook says so.
