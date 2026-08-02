<!-- converted from Warranty_Claims_AGENT_PLAYBOOK.docx by tools/docs/docx_to_md.py -->
> **Converted from Word.** This is a point-in-time snapshot: figures in it were accurate on the date stated below and have not been re-verified against the current codebase. For counts that are checked continuously, see the root [`README.md`](../../README.md).

DATACERN AI · WARRANTY CLAIMS

Agent Playbook

How to put the nine Datacern agents to work in warranty claims.

This playbook maps each of Datacern’s nine agents to a concrete job in this vertical, grounded in the real warranty-claims pack.

Pack: warranty-claims v1.0.0

Domain: manufacturing · warranty · claims · dealers · aftersales

Regulatory: magnuson_moss, ftc_warranty_rules, ucc_article_2, nhtsa_safety_act, tread_act

Golden rule: Datacern proposes; a human decides. Four-eyes is the default on AI-proposed writes and is mandatory — with no tenant opt-out — for high-risk, destructive and admin actions. Tenants may policy-enable auto-execution for low-risk, non-destructive writes.

Date: 2026-07-17

# Contents

# 1. What this pack does

AI-assisted OEM warranty-claims adjudication for dealer/service-network claims: claim intake triage with payment-decision deadline awareness, dealer claim-padding surveillance with audit escalation, component failure early-warning signal detection by build batch, supplier cost recovery (warranty chargebacks), goodwill governance and safety-recall routing, warranty-operations KPI semantic model and dashboards (approval/ denial rates, adjustment share, cost per claim, audit-escalation share, supplier recovery, deadline runway), dealer-component network analytics, Magnuson-Moss / recall-interplay / reserve-accounting grounding memories, and unit-anomaly + claim-outcome training pipelines.

Datacern makes it a governed decision workflow: the source data lands as governed datasets; the agents watch the queue and propose — a disposition, a model, a dashboard — grounded in the domain rules; and a human approves. Every correction trains the next model. The nine agents are the workforce; this playbook is their job description.

| The rule that shapes everything Datacern proposes; a human decides. Proposal-mode + four-eyes: no agent writes or actions on its own — every consequential step is a human-approved proposal. Enforced by the platform. |
|---|

# 2. The team (who does the approving)

The pack ships these roles. Each person only sees what their role allows; the approver on a proposal is never the one (or the agent) who created it.

| Role | Responsibility |
|---|---|
| Warranty Claims Analyst | — |
| Technical Assessor | — |
| Supplier Recovery Specialist | — |
| Warranty Operations Manager | — |
| Warranty Audit Lead | — |

# 3. The nine agents, mapped to this vertical

Every agent below is the same platform agent — specialised to this domain through tenant configuration (persona + domain + rule grounding), not a code fork. case-triage and analytics carry explicit domain instructions today; the rest apply unchanged.

| Agent | Its job here | Who approves |
|---|---|---|
| onboarding | Propose how to land the source feeds as governed datasets | Director / Data admin |
| analytics | Answer KPI questions over the governed models — read-only | — (no write) |
| dashboard-designer | Draft the operational dashboards | Director |
| model-training | Propose a unit-anomaly + claim-outcome training run | Director / Data scientist |
| ml-engineer | Autonomously build & compare candidate models, propose the winner | Director (four-eyes) |
| inference | Batch-score with the production model | Analyst / Manager |
| case-triage | The reviewer: propose a disposition on each queued case | Domain reviewer |
| governance | Open a retrain proposal when a model drifts | Director / Data scientist |
| meta-router | Front door: route a free-text request to the right agent | (delegate’s approver) |

The domain data these agents reason over is live in the platform’s governed layer:

Figure 1. The platform’s Semantic Models surface (models from many installed packs shown). This pack adds: warranty_core.

Figure 2. The Dashboards surface. This pack installs: Warranty_command_center, Dealer_audit_watch, Component_failure_signals.

# 4. Agent-by-agent playbook

## onboarding 4.1. Bring the data in

The onboarding agent inspects a source and proposes an ingestion config + column mapping, grounded in the connector catalog and a live preview.

- Go to Data → Data Sources → New data source; pick a connector or upload a seed extract.
- Ask it to “onboard this feed as a dataset.” It returns an ingestion.create proposal; a data admin approves; the feed lands ready.

## analytics 4.2. Ask the KPIs

The analytics agent answers KPI questions over the governed warranty_core model(s) — read-only, citing the measures it used. From the pack’s own analytics instructions:

| Analytics grounding (from the pack) Answer warranty-program KPI questions from the governed semantic model warranty_core: claim_approval_rate, claim_denial_rate, adjustment_share, audit_escalation_share, supplier_recovery_rate, avg_claim_amount (cost per claim), avg_claim_age_days (backlog aging), deadline runway (open_claim_count by deadline_bucket), component failure surfaces (powertrain_claim_count, labor_stacked_claim_count, replacement_claim_count) and network posture (unit_count, dealer_count, elevated_cpu_dealer_count, high_service_unit_count). Use plain operational language for warranty-operations, quality and finance staff and always cite … |
|---|

Figure 3. The role-grounded Copilot answering over the governed semantic layer — grounded, never fabricated. The same surface serves this vertical.

## dashboard-designer 4.3. Stand up the boards

It proposes a draft dashboard — title + charts bound to real measures/dimensions — grounded in the semantic layer. Ask “design a board for this program”; review the chart.dashboard.create proposal; a director approves (the boards appear as in Figure 2).

## model-training 4.4. Propose a unit-anomaly + claim-outcome model

It turns a plain-language goal into a governed training-run proposal — algorithm, hyperparameters, label/features — grounded in the algorithm catalog and prior runs. The pack ships a real unit-anomaly + claim-outcome training pipeline.

- Ask “train a unit-anomaly + claim-outcome model on the panel.” It returns a pipeline.template.create_from_algorithm proposal; approve → the pipeline runs and registers a model.

Figure 4. Experiments & the model registry — a pipeline-trained model auto-mirrors here, ready to gate and promote.

## ml-engineer 4.5. Build the model for me

The ml-engineer agent runs the whole loop autonomously: inspects the schema, launches candidate models in sandboxed pipeline runs, compares real metrics, and proposes promoting the winner via experiment.model.promote — four-eyes, never promoting directly.

## inference 4.6. Score the population

The inference agent proposes a batch scoring job: it resolves the model’s production version, checks input-schema compatibility, and proposes an inference.submit job whose output is a scored dataset the team works from. A human approves before it runs.

## case-triage 4.7. The reviewer (the heart of it)

Each queued case (claim_queue) gets a proposed disposition, grounded in the domain rules and citing the exact basis. It never takes the action itself. From the pack’s own triage instructions:

| Triage grounding (from the pack) You triage manufacturer warranty claims filed by dealers and service networks (auto, heavy-equipment/ag, appliance/electronics, extended warranty programs). Ground every recommendation in the specific claim evidence — cite claim ids, unit ids, dealer ids, labor-op bands, usage bands, failure modes, amounts and the dealer's claim history. Watch the payment-decision clock first: dealer agreements set a decision deadline per claim, so flag any claim whose days_to_deadline puts the payment decision at risk and chase missing documentation early rather than letting a claim breach its runway. Route safety first: a claim implicating an open safety recall campaign is recall-remedy territory — the fix is free of charge regardless of warranty status and the claim routes to the campaign; NEVER propose denying a safety-defect claim as a warranty exclusion. Respect warranty law: coverage cannot be con… |
|---|

The dispositions it proposes

| Disposition | Meaning | Category |
|---|---|---|
| approve_pay_claim | Approve — pay claim in full (covered failure confirmed) | true_positive |
| deny_policy_exclusion | Deny — policy exclusion or evidence gap | false_positive |
| adjust_partial_pay | Adjust — partial payment (trimmed ops / goodwill cost-share) | other |
| escalate_dealer_audit | Escalate to dealer audit (suspected claim padding) | inconclusive |
| close_supplier_recovery | Close — cost recovered from supplier (warranty chargeback) | benign |

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
- Rules as grounding. The domain’s regulatory rules are retrieved as grounding the agents must cite (magnuson_moss, ftc_warranty_rules, ucc_article_2, nhtsa_safety_act, tread_act).
- Eval-gated models. A model is promoted only after passing its eval suite; rollback = demote.

Figure 9. The eval flywheel — the promotion gate for this vertical’s models: runs & gates, scorers, and canary A/B.

# 7. What is live today vs pack-service-deferred

In the spirit of no-fake: what Core materialises today is live; the rest is recorded in the install ledger as deferred, with the proposal-mode + four-eyes guarantees already holding. Nothing is stubbed.

| Capability | Status |
|---|---|
| Semantic models (warranty_core), dashboards, saved/verified queries | Live |
| Review case queue + disposition taxonomy + role catalog | Live |
| case-triage + analytics specialised to this domain (rule grounding) | Live |
| unit-anomaly + claim-outcome training pipeline | Live |
| Deferred to pack-service: guardrails, agent_recipes, connection_templates, write_adapters, eval_sets, ontology, case_schemas, model_archetypes, display_labels | Deferred → served today via config + seed data; guarantees hold |

Grounded in the real warranty-claims pack (its own pack.yaml, dispositions, roles, and agent instructions). The domain-asset captions name this pack’s real models/dashboards; agent-surface screenshots are the shared, pack-agnostic surfaces (claims demo shown) — this pack drives the identical surfaces with its own data. Where a capability awaits pack-service, this playbook says so.
