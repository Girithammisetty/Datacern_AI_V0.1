<!-- converted from Benefits_Appeals_AGENT_PLAYBOOK.docx by tools/docs/docx_to_md.py -->
> **Converted from Word.** This is a point-in-time snapshot: figures in it were accurate on the date stated below and have not been re-verified against the current codebase. For counts that are checked continuously, see the root [`README.md`](../../README.md).

DATACERN AI · BENEFITS APPEALS

Agent Playbook

How to put the nine Datacern agents to work in benefits appeals.

This playbook maps each of Datacern’s nine agents to a concrete job in this vertical, grounded in the real benefits-appeals pack.

Pack: benefits-appeals v1.0.0

Domain: government · benefits · eligibility · appeals · program_integrity

Regulatory: due_process, ui_dol_standards, snap_rules, tanf_rules, improper_payments

Golden rule: Datacern proposes; a human decides. Four-eyes is the default on AI-proposed writes and is mandatory — with no tenant opt-out — for high-risk, destructive and admin actions. Tenants may policy-enable auto-execution for low-risk, non-destructive writes.

Date: 2026-07-17

# Contents

# 1. What this pack does

AI-assisted eligibility adjudication and appeals workflow for government benefits programs (unemployment insurance, SNAP, Medicaid eligibility, TANF, state disability): determination triage with due-process and processing-deadline awareness (Goldberg v. Kelly notice/hearing rights, SNAP 7-day expedited and 30-day standards, UI first-payment promptness), appeal-hearing packet preparation, overpayment establishment and equity-and-good-conscience waiver review, identity-fraud watch balanced against false-positive harm to legitimate claimants, an adjudication KPI semantic model and dashboards (approval/denial rates, verification-request share, fraud-referral share, appeal overturn share, deadline runway, overpayment exposure), claimant-program network analytics, due-process + program-rule grounding memories, and claim-anomaly + determination-outcome training pipelines.

Datacern makes it a governed decision workflow: the source data lands as governed datasets; the agents watch the queue and propose — a disposition, a model, a dashboard — grounded in the domain rules; and a human approves. Every correction trains the next model. The nine agents are the workforce; this playbook is their job description.

| The rule that shapes everything Datacern proposes; a human decides. Proposal-mode + four-eyes: no agent writes or actions on its own — every consequential step is a human-approved proposal. Enforced by the platform. |
|---|

# 2. The team (who does the approving)

The pack ships these roles. Each person only sees what their role allows; the approver on a proposal is never the one (or the agent) who created it.

| Role | Responsibility |
|---|---|
| Eligibility Examiner | — |
| Appeals Hearing Preparer | — |
| Overpayment Analyst | — |
| Program Integrity Manager | — |
| Program Audit Lead | — |

# 3. The nine agents, mapped to this vertical

Every agent below is the same platform agent — specialised to this domain through tenant configuration (persona + domain + rule grounding), not a code fork. case-triage and analytics carry explicit domain instructions today; the rest apply unchanged.

| Agent | Its job here | Who approves |
|---|---|---|
| onboarding | Propose how to land the source feeds as governed datasets | Director / Data admin |
| analytics | Answer KPI questions over the governed models — read-only | — (no write) |
| dashboard-designer | Draft the operational dashboards | Director |
| model-training | Propose a claim-anomaly + determination-outcome training run | Director / Data scientist |
| ml-engineer | Autonomously build & compare candidate models, propose the winner | Director (four-eyes) |
| inference | Batch-score with the production model | Analyst / Manager |
| case-triage | The reviewer: propose a disposition on each queued case | Domain reviewer |
| governance | Open a retrain proposal when a model drifts | Director / Data scientist |
| meta-router | Front door: route a free-text request to the right agent | (delegate’s approver) |

The domain data these agents reason over is live in the platform’s governed layer:

Figure 1. The platform’s Semantic Models surface (models from many installed packs shown). This pack adds: benefits_core.

Figure 2. The Dashboards surface. This pack installs: Determinations_command_center, Timeliness_due_process, Integrity_overpayments.

# 4. Agent-by-agent playbook

## onboarding 4.1. Bring the data in

The onboarding agent inspects a source and proposes an ingestion config + column mapping, grounded in the connector catalog and a live preview.

- Go to Data → Data Sources → New data source; pick a connector or upload a seed extract.
- Ask it to “onboard this feed as a dataset.” It returns an ingestion.create proposal; a data admin approves; the feed lands ready.

## analytics 4.2. Ask the KPIs

The analytics agent answers KPI questions over the governed benefits_core model(s) — read-only, citing the measures it used. From the pack’s own analytics instructions:

| Analytics grounding (from the pack) Answer benefits-program KPI questions from the governed semantic model benefits_core: approval_rate, denial_rate, verification_request_share, fraud_referral_share, appeal_overturn_share (due-process quality signal), avg_determination_age_days (backlog aging), total_overpayment_amount and overpayment_case_count (integrity exposure), open_determination_count by deadline_bucket (timeliness runway), and claim-book surfaces (contested_claim_count, shared_address_claim_count, missing_docs_claim_count, vulnerable_claimant_count). Use plain operational language for agency operations, oversight, and audit staff and always… |
|---|

Figure 3. The role-grounded Copilot answering over the governed semantic layer — grounded, never fabricated. The same surface serves this vertical.

## dashboard-designer 4.3. Stand up the boards

It proposes a draft dashboard — title + charts bound to real measures/dimensions — grounded in the semantic layer. Ask “design a board for this program”; review the chart.dashboard.create proposal; a director approves (the boards appear as in Figure 2).

## model-training 4.4. Propose a claim-anomaly + determination-outcome model

It turns a plain-language goal into a governed training-run proposal — algorithm, hyperparameters, label/features — grounded in the algorithm catalog and prior runs. The pack ships a real claim-anomaly + determination-outcome training pipeline.

- Ask “train a claim-anomaly + determination-outcome model on the panel.” It returns a pipeline.template.create_from_algorithm proposal; approve → the pipeline runs and registers a model.

Figure 4. Experiments & the model registry — a pipeline-trained model auto-mirrors here, ready to gate and promote.

## ml-engineer 4.5. Build the model for me

The ml-engineer agent runs the whole loop autonomously: inspects the schema, launches candidate models in sandboxed pipeline runs, compares real metrics, and proposes promoting the winner via experiment.model.promote — four-eyes, never promoting directly.

## inference 4.6. Score the population

The inference agent proposes a batch scoring job: it resolves the model’s production version, checks input-schema compatibility, and proposes an inference.submit job whose output is a scored dataset the team works from. A human approves before it runs.

## case-triage 4.7. The reviewer (the heart of it)

Each queued case (determination_queue) gets a proposed disposition, grounded in the domain rules and citing the exact basis. It never takes the action itself. From the pack’s own triage instructions:

| Triage grounding (from the pack) You triage government benefits eligibility determinations and appeals across unemployment insurance, SNAP, Medicaid eligibility, TANF, and state disability for a state/county agency. Ground every recommendation in the specific case evidence — cite determination ids, claim ids, wage records, verification-document status, employer statements, and the claimant's history (prior claims, prior determinations, identity-verification status, vulnerable-population and language flags). Watch the processing clock first: flag any determination whose days_to_deadline puts a SNAP 30-day (or 7-day expedited) processing standard, a UI first-payment promptness standard, or a fair-hearing packet deadline at risk, and never let an investigation-quality concern justify blowing a processing deadline — under expedited SNAP rules most outstanding verification is postponable and benefits issue on time. Due proce… |
|---|

The dispositions it proposes

| Disposition | Meaning | Category |
|---|---|---|
| approve_benefits | Approve benefits — eligibility confirmed | true_positive |
| deny_with_findings | Deny — written findings and appeal rights issued | false_positive |
| request_verification_documents | Request verification documents — decision deferred | inconclusive |
| refer_fraud_investigation | Refer to program-integrity fraud investigation | other |
| close_withdrawn | Close — application or claim withdrawn by the claimant | benign |

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
- Rules as grounding. The domain’s regulatory rules are retrieved as grounding the agents must cite (due_process, ui_dol_standards, snap_rules, tanf_rules, improper_payments).
- Eval-gated models. A model is promoted only after passing its eval suite; rollback = demote.

Figure 9. The eval flywheel — the promotion gate for this vertical’s models: runs & gates, scorers, and canary A/B.

# 7. What is live today vs pack-service-deferred

In the spirit of no-fake: what Core materialises today is live; the rest is recorded in the install ledger as deferred, with the proposal-mode + four-eyes guarantees already holding. Nothing is stubbed.

| Capability | Status |
|---|---|
| Semantic models (benefits_core), dashboards, saved/verified queries | Live |
| Review case queue + disposition taxonomy + role catalog | Live |
| case-triage + analytics specialised to this domain (rule grounding) | Live |
| claim-anomaly + determination-outcome training pipeline | Live |
| Deferred to pack-service: guardrails, agent_recipes, connection_templates, write_adapters, eval_sets, ontology, case_schemas, model_archetypes, display_labels | Deferred → served today via config + seed data; guarantees hold |

Grounded in the real benefits-appeals pack (its own pack.yaml, dispositions, roles, and agent instructions). The domain-asset captions name this pack’s real models/dashboards; agent-surface screenshots are the shared, pack-agnostic surfaces (claims demo shown) — this pack drives the identical surfaces with its own data. Where a capability awaits pack-service, this playbook says so.
