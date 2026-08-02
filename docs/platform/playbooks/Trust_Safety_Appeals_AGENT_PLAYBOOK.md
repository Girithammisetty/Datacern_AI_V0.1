<!-- converted from Trust_Safety_Appeals_AGENT_PLAYBOOK.docx by tools/docs/docx_to_md.py -->
> **Converted from Word.** This is a point-in-time snapshot: figures in it were accurate on the date stated below and have not been re-verified against the current codebase. For counts that are checked continuously, see the root [`README.md`](../../README.md).

DATACERN AI · TRUST SAFETY APPEALS

Agent Playbook

How to put the nine Datacern agents to work in trust safety appeals.

This playbook maps each of Datacern’s nine agents to a concrete job in this vertical, grounded in the real trust-safety-appeals pack.

Pack: trust-safety-appeals v1.0.0

Domain: trust_safety · content_moderation · appeals · platform_governance · marketplaces

Regulatory: eu_dsa, uk_online_safety_act

Golden rule: Datacern proposes; a human decides. Four-eyes is the default on AI-proposed writes and is mandatory — with no tenant opt-out — for high-risk, destructive and admin actions. Tenants may policy-enable auto-execution for low-risk, non-destructive writes.

Date: 2026-07-17

# Contents

# 1. What this pack does

AI-assisted trust-and-safety appeals adjudication for online platforms: appeal intake triage with complaint-handling deadline awareness (DSA statement-of-reasons and internal complaint-handling obligations, human review never solely automated), classifier false-positive detection with overturn-rate feedback into enforcement quality, brigading/mass-report integrity screening, compromised-account restore paths, policy-gap escalation and precedent loops, appeals-operations KPI semantic model and dashboards (overturn rate, uphold rate, escalation share, deadline runway, enforcement-source mix), account-enforcement network analytics, DSA/OSA grounding memories, and enforcement-anomaly + appeal-outcome training pipelines.

Datacern makes it a governed decision workflow: the source data lands as governed datasets; the agents watch the queue and propose — a disposition, a model, a dashboard — grounded in the domain rules; and a human approves. Every correction trains the next model. The nine agents are the workforce; this playbook is their job description.

| The rule that shapes everything Datacern proposes; a human decides. Proposal-mode + four-eyes: no agent writes or actions on its own — every consequential step is a human-approved proposal. Enforced by the platform. |
|---|

# 2. The team (who does the approving)

The pack ships these roles. Each person only sees what their role allows; the approver on a proposal is never the one (or the agent) who created it.

| Role | Responsibility |
|---|---|
| Appeals Reviewer | — |
| Senior Policy Reviewer | — |
| Escalations Specialist | — |
| Appeals Operations Manager | — |
| Transparency & Audit Lead | — |

# 3. The nine agents, mapped to this vertical

Every agent below is the same platform agent — specialised to this domain through tenant configuration (persona + domain + rule grounding), not a code fork. case-triage and analytics carry explicit domain instructions today; the rest apply unchanged.

| Agent | Its job here | Who approves |
|---|---|---|
| onboarding | Propose how to land the source feeds as governed datasets | Director / Data admin |
| analytics | Answer KPI questions over the governed models — read-only | — (no write) |
| dashboard-designer | Draft the operational dashboards | Director |
| model-training | Propose a enforcement-anomaly + appeal-outcome training run | Director / Data scientist |
| ml-engineer | Autonomously build & compare candidate models, propose the winner | Director (four-eyes) |
| inference | Batch-score with the production model | Analyst / Manager |
| case-triage | The reviewer: propose a disposition on each queued case | Domain reviewer |
| governance | Open a retrain proposal when a model drifts | Director / Data scientist |
| meta-router | Front door: route a free-text request to the right agent | (delegate’s approver) |

The domain data these agents reason over is live in the platform’s governed layer:

Figure 1. The platform’s Semantic Models surface (models from many installed packs shown). This pack adds: appeals_core.

Figure 2. The Dashboards surface. This pack installs: Appeals_command_center, Overturn_classifier_quality, Dsa_compliance_transparency.

# 4. Agent-by-agent playbook

## onboarding 4.1. Bring the data in

The onboarding agent inspects a source and proposes an ingestion config + column mapping, grounded in the connector catalog and a live preview.

- Go to Data → Data Sources → New data source; pick a connector or upload a seed extract.
- Ask it to “onboard this feed as a dataset.” It returns an ingestion.create proposal; a data admin approves; the feed lands ready.

## analytics 4.2. Ask the KPIs

The analytics agent answers KPI questions over the governed appeals_core model(s) — read-only, citing the measures it used. From the pack’s own analytics instructions:

| Analytics grounding (from the pack) Answer appeals-program KPI questions from the governed semantic model appeals_core: overturn_rate and uphold_rate (the classifier-quality feedback loop), escalation_share (policy-gap pressure), automated_source_share, repeat_appellant_share, avg_appeal_age_days (backlog aging), deadline runway (open_appeal_count by deadline_bucket), and enforcement-side surfaces (high_confidence_classifier_count, total_report_count, avg_report_count for the brigading watch). Use plain operational language for appeals-operations, policy, and transparency-reporting staff and always cite the measure names you used. Slice by appeal t… |
|---|

Figure 3. The role-grounded Copilot answering over the governed semantic layer — grounded, never fabricated. The same surface serves this vertical.

## dashboard-designer 4.3. Stand up the boards

It proposes a draft dashboard — title + charts bound to real measures/dimensions — grounded in the semantic layer. Ask “design a board for this program”; review the chart.dashboard.create proposal; a director approves (the boards appear as in Figure 2).

## model-training 4.4. Propose a enforcement-anomaly + appeal-outcome model

It turns a plain-language goal into a governed training-run proposal — algorithm, hyperparameters, label/features — grounded in the algorithm catalog and prior runs. The pack ships a real enforcement-anomaly + appeal-outcome training pipeline.

- Ask “train a enforcement-anomaly + appeal-outcome model on the panel.” It returns a pipeline.template.create_from_algorithm proposal; approve → the pipeline runs and registers a model.

Figure 4. Experiments & the model registry — a pipeline-trained model auto-mirrors here, ready to gate and promote.

## ml-engineer 4.5. Build the model for me

The ml-engineer agent runs the whole loop autonomously: inspects the schema, launches candidate models in sandboxed pipeline runs, compares real metrics, and proposes promoting the winner via experiment.model.promote — four-eyes, never promoting directly.

## inference 4.6. Score the population

The inference agent proposes a batch scoring job: it resolves the model’s production version, checks input-schema compatibility, and proposes an inference.submit job whose output is a scored dataset the team works from. A human approves before it runs.

## case-triage 4.7. The reviewer (the heart of it)

Each queued case (appeals_queue) gets a proposed disposition, grounded in the domain rules and citing the exact basis. It never takes the action itself. From the pack’s own triage instructions:

| Triage grounding (from the pack) You triage appeals against platform enforcement decisions (content removals, account suspensions, demonetizations, ranking restrictions) under internal complaint-handling obligations of the EU Digital Services Act and comparable regimes: decisions must be timely, diligent, non-arbitrary and non-discriminatory, and never taken solely by automated means — you propose, a qualified human reviewer and the Appeals Operations Manager decide. Ground every recommendation in the specific enforcement evidence — cite appeal ids, decision ids, policy versions, classifier score bands, report counts, and the account's history (prior enforcements, prior appeal outcomes, standing, verified and monetized status). Watch the complaint-handling clock first: flag any appeal whose days_to_deadline puts a determination deadline at risk. Propose one disposition per appeal: overturn_restore (evidence confirms an … |
|---|

The dispositions it proposes

| Disposition | Meaning | Category |
|---|---|---|
| overturn_restore | Overturn — enforcement error confirmed, restore content/account | true_positive |
| uphold_enforcement | Uphold — appeal without merit, enforcement stands | false_positive |
| partial_modify_action | Partial — modify the enforcement action (proportionality) | other |
| escalate_policy_team | Escalate to policy team (policy gap / precedent question) | inconclusive |
| close_duplicate_appeal | Close — duplicate of an existing appeal on this decision | benign |

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
- Rules as grounding. The domain’s regulatory rules are retrieved as grounding the agents must cite (eu_dsa, uk_online_safety_act).
- Eval-gated models. A model is promoted only after passing its eval suite; rollback = demote.

Figure 9. The eval flywheel — the promotion gate for this vertical’s models: runs & gates, scorers, and canary A/B.

# 7. What is live today vs pack-service-deferred

In the spirit of no-fake: what Core materialises today is live; the rest is recorded in the install ledger as deferred, with the proposal-mode + four-eyes guarantees already holding. Nothing is stubbed.

| Capability | Status |
|---|---|
| Semantic models (appeals_core), dashboards, saved/verified queries | Live |
| Review case queue + disposition taxonomy + role catalog | Live |
| case-triage + analytics specialised to this domain (rule grounding) | Live |
| enforcement-anomaly + appeal-outcome training pipeline | Live |
| Deferred to pack-service: guardrails, agent_recipes, connection_templates, write_adapters, eval_sets, ontology, case_schemas, model_archetypes, display_labels | Deferred → served today via config + seed data; guarantees hold |

Grounded in the real trust-safety-appeals pack (its own pack.yaml, dispositions, roles, and agent instructions). The domain-asset captions name this pack’s real models/dashboards; agent-surface screenshots are the shared, pack-agnostic surfaces (claims demo shown) — this pack drives the identical surfaces with its own data. Where a capability awaits pack-service, this playbook says so.
