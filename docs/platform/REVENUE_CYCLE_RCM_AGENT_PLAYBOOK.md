<!-- converted from REVENUE_CYCLE_RCM_AGENT_PLAYBOOK.docx by tools/docs/docx_to_md.py -->
> **Converted from Word.** This is a point-in-time snapshot: figures in it were accurate on the date stated below and have not been re-verified against the current codebase. For counts that are checked continuously, see the root [`README.md`](../../README.md).

DATACERN AI · PROVIDER REVENUE CYCLE (RCM)

Agent Playbook

How to put the nine Datacern agents to work in denial management and A/R recovery.

This playbook maps each of Datacern’s nine agents to a concrete job in provider revenue cycle, grounded in the real healthcare-provider-rcm v1.0.0 pack (BRD 26).

Pack: healthcare-provider-rcm v1.0.0

Scope: Denials · Underpayments · A/R · CARC/RARC · LCD/NCD · NCCI · No Surprises Act

Audience: Biller, Medical Coder, Denials Specialist, A/R Manager, Revenue Integrity Analyst, Revenue Cycle Director

Golden rule: Datacern never bills. Every appeal, resubmission, or write-off is a proposal a biller, coder, or denials specialist approves (four-eyes).

Date: 2026-07-17

# Contents

# 1. The provider revenue cycle problem Datacern solves

Provider revenue leaks at two seams: denials (a payer refuses a claim) and underpayments (a remittance line pays below the contracted rate). Working them is deadline-bound, evidence-heavy, and easy to under-staff — an appeal filed past the payer window is worthless, and an unspotted underpayment is money left on the table.

Datacern makes it a governed workflow: claims, remits (835s), denials, and A/R land as governed data; agents work the denial + underpayment queue and propose an action — appeal, corrected resubmit, or write-off — grounded in the CARC/RARC codes and the payer contract; and a biller or denials specialist approves.

| The one rule that shapes everything RCM_AUTONOMOUS_BILLING_FORBIDDEN (BR-1). No agent submits, resubmits, appeals, or writes off a claim on its own. It drafts and recommends the action, cites the evidence, and a human on the revenue-cycle team approves. Enforced by the platform, not by convention. |
|---|

# 2. The team (who approves what)

The pack ships these roles. Datacern only shows each person what their role allows; the approver on a proposal is never the one (or the agent) who created it.

| Role | Primary job | Approves |
|---|---|---|
| Biller | Claim submission, resubmission, follow-up | corrected resubmits |
| Medical Coder | Code assignment and correction | coding adjustments |
| Denials Specialist | Denial work, appeals with evidence | appeals, escalations |
| A/R Manager | Aging A/R, follow-up prioritization | A/R actions, write-offs (with note) |
| Revenue Integrity Analyst | Underpayment detection vs contract | underpayment recoveries |
| Revenue Cycle Director | KPIs, payer relations, sign-off | program-level & exception approvals |

# 3. The nine agents, mapped to this vertical

Every agent below is the same platform agent — specialised to provider revenue cycle through tenant configuration (persona + domain + rule grounding), not a code fork. case-triage and analytics carry explicit domain instructions today; the rest apply unchanged.

| Agent | Its job in this vertical | Who approves |
|---|---|---|
| onboarding | Propose how to land the source feeds as governed datasets | Director / Data admin |
| analytics | Answer KPI questions over the governed models — read-only | — (no write) |
| dashboard-designer | Draft the operational dashboards | Director |
| model-training | Propose a denial-prediction training run | Director / Data scientist |
| ml-engineer | Autonomously build & compare candidate models, propose the winner | Director (four-eyes) |
| inference | Batch-score with the production model | Analyst / Manager |
| case-triage | The reviewer: propose a disposition on each queued case | Domain reviewer |
| governance | Open a retrain proposal when a model drifts | Director / Data scientist |
| meta-router | Front door: route a free-text request to the right agent | (delegate’s approver) |

The domain data these agents reason over is live in the platform:

Figure 1. Real assets in the running platform: the rcm_claims and rcm_ar governed semantic models (among other packs’ models).

Figure 2. The pack’s dashboards — the RCM Command Center, Denial Analytics, and A/R Aging Actions — installed alongside other packs’ boards.

# 4. Agent-by-agent playbook

## onboarding 4.1. Bring the data in

The onboarding agent inspects a source and proposes an ingestion config + column mapping, grounded in the connector catalog and a live preview — landing the domain feeds as governed datasets.

- Go to Data → Data Sources → New data source; pick a connector or upload a seed extract.
- Ask onboarding to “onboard this feed as a dataset.” It returns an ingestion.create proposal; a data admin approves; the feed lands ready.

## analytics 4.2. Ask the KPIs

The analytics agent answers KPI questions over the governed rcm_claims and rcm_ar models — read-only, always citing the measures it used.

Ask it things like:

- “Clean-claim rate vs the 95% benchmark?” → clean_claim_rate
- “Denial rate and overturn rate?” → denial_rate, denial_overturn_rate
- “Days in A/R and % over 90?” → avg_days_to_payment, pct_ar_over_90
- “Net collection rate and total payment variance?” → net_collection_rate, total_payment_variance

Figure 3. The role-grounded Copilot answering over the governed semantic layer — grounded, never fabricated. The same surface serves this vertical’s questions.

## dashboard-designer 4.3. Stand up the boards

It proposes a draft dashboard — title + charts bound to real measures/dimensions — grounded in the semantic layer and chart catalog.

- Ask “design a denial-analytics board.” It proposes charts over rcm_claims and rcm_ar.
- Review the chart.dashboard.create proposal; a director approves; the board appears under Dashboards (Figure 2).

## model-training 4.4. Propose a denial-prediction model

It turns a plain-language goal into a governed training-run proposal, resolving algorithm + hyperparameters + label/features grounded in the algorithm catalog and prior runs. The pack ships a real denial-prediction training pipeline.

- Ask “train a denial-prediction model on the panel.”
- It returns a pipeline.template.create_from_algorithm proposal (algorithm, params, label = will_deny). Approve → the pipeline runs and registers a model.

Figure 4. Experiments & the model registry. A pipeline-trained model auto-mirrors here, ready to gate and promote.

## ml-engineer 4.5. Build the model for me

The ml-engineer agent runs the whole loop autonomously: inspects the schema, launches candidate models in sandboxed pipeline runs, compares real metrics, and proposes promoting the winner — four-eyes, never promoting directly.

- Point it at a prepared dataset and the label (will_deny).
- It emits an experiment.model.promote proposal for the best candidate, with the comparison as evidence. A director approves.

## inference 4.6. Score the population

The inference agent proposes a batch scoring job: it resolves the model’s production version, checks input-schema compatibility, and proposes a job whose output is a scored dataset the team works from.

- Ask “score this week’s outgoing claims with the production denial-prediction model.”
- It returns an inference.submit proposal (model version + input dataset, compatibility confirmed). Approve; the scored set feeds the worklist.

## case-triage 4.7. The denials & underpayment reviewer

The denial queue fills with claim denials and below-contract remittance lines. For each denial, case-triage cites the CARC/RARC codes, classifies it, and proposes the action the class calls for — grounded in the chart, the payer policy, and the contract. It never touches a claim.

What it checks (from the pack’s agent instructions):

- Cite the codes — every denial names its CARC and RARC codes from the 835.
- Classify the denial — coverage (LCD/NCD non-coverage) · documentation · medical-necessity · administrative (BR-4) — the class determines the action.
- Pick the action — appeal with cited chart/policy evidence · corrected resubmit · or write-off when no clinical case exists.
- Check the deadline — an underpayment dispute outside the payer-contract window is time_barred and must not be proposed (BR-5).
- Underpayments — cite the expected contracted amount against the actual paid amount from the 835 line.
- No autonomous writes — draft and recommend only — a human submits, resubmits, appeals, or writes off (BR-1).

The dispositions it proposes

| Disposition | Meaning | Category |
|---|---|---|
| appeal_submitted | Appeal submitted to payer | false_positive |
| corrected_resubmit | Corrected claim resubmitted | true_positive |
| write_off | Write-off approved | true_positive |
| escalate_payer | Escalate to payer relations | inconclusive |
| underpayment_recovered | Underpayment recovered from payer | true_positive |
| balance_verified_correct | Payment verified correct — no action | benign |

How the team uses it:

- Open Cases — the denial & underpayment queue, ranked. Each row is a queued item with its context.

Figure 5. The review worklist surface (claims demo shown; here it is the denial & underpayment queue).

- Open an item. The Overview shows the evidence; the AI recommendation names the exact basis — e.g. “CO-197 (auth missing) documentation denial — auth on file in chart; propose appeal with the cited authorization”.

Figure 6. A case with grounded evidence and the AI’s recommendation, citing the rule and the exact source artifact.

- Open Proposals to see the disposition as a reviewable diff, then decide — inert until a human approves.

Figure 7. The disposition proposal as a field-level diff. Nothing is actioned until a human approves.

- Approve, edit (the correction becomes training data), or reject with a reason from the Approvals inbox. Four-eyes: the approver is not the proposer.

Figure 8. The approval inbox. Every disposition is approved by a different person than the one who raised it — four-eyes.

## governance 4.8. Keep the models honest

The governance agent runs autonomously under its own agent principal. When the denial-prediction model drifts or corrections pile up past threshold, it opens a mlops.open_retrain proposal with the evidence summarised. A director approves.

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

- No autonomous action. RCM_AUTONOMOUS_BILLING_FORBIDDEN — every consequential action is a human-approved proposal.
- Four-eyes. The approver is structurally never the proposer (or the agent).
- Rules as grounding. The domain’s regulatory rules are retrieved as grounding the agents must cite.
- Eval-gated models. A model is promoted only after passing its eval suite; rollback = demote.

Figure 10. The eval flywheel — the promotion gate for this vertical’s models: scoring runs & gates, scorers, and canary A/B.

- Audit trail. Every proposal, decision, and tool call is recorded (audit-defensible); authorization is per-request against your role.

# 7. What is live today vs pack-service-deferred

In the spirit of no-fake: deferred items are recorded in the install ledger, and the guarantees they need (proposal-mode + four-eyes) already hold. Nothing below is stubbed.

| Capability | Status |
|---|---|
| Semantic models (rcm_claims, rcm_ar) + RCM KPI catalog, dashboards, queries | Live |
| Denial + underpayment case queue + disposition taxonomy + RCM role catalog | Live |
| case-triage + analytics specialised to provider RCM (CARC/RARC/contract grounding) | Live |
| Denial-prediction training pipeline | Live |
| Bespoke recipes (coding assistant, appeal drafter, underpayment auditor…) | Deferred → served via config on the fixed agents |
| LCD/NCD/NCCI edits + No Surprises Act + FDCPA OPA guardrails | Deferred → carried today as grounding + proposal-mode+four-eyes |
| Payer/clearinghouse connectors + claim/appeal write adapters | Deferred → customer creds via pack-service; seed datasets today |

Grounded in the real healthcare-provider-rcm pack (BRD 26). Screenshots of domain assets (semantic models, dashboards) are live from the running platform; agent-surface screenshots are the shared, pack-agnostic surfaces (claims demo shown) — this pack drives the identical surfaces with its own data. Where a capability awaits pack-service, this playbook says so.
