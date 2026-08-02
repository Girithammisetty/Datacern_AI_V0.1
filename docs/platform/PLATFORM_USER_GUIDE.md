<!-- converted from PLATFORM_USER_GUIDE.docx by tools/docs/docx_to_md.py -->
> **Converted from Word.** This is a point-in-time snapshot: figures in it were accurate on the date stated below and have not been re-verified against the current codebase. For counts that are checked continuously, see the root [`README.md`](../../README.md).

DATACERN AI

End-User Guide

Build the capability, then run the decision — the Insurance Claims Triage pack.

This guide takes you through Datacern twice: first building a decision capability — connecting data, preparing it, building ML pipelines, running experiments — then running the day-to-day governed decision on top of it. Every screenshot is from the live running platform.

Two journeys: Part I — Build the capability · Part II — Run the decision

Pack: Insurance Claims Triage (the exemplar; §11 notes how other packs differ)

Audience: data scientists, adjusters, case managers, tenant admins

Screenshots: captured live from the running platform (tenant “Acme Claims Co”) — real data, real AI

Date: 2026-07-17

# Contents

# 1. What Datacern does for you

Datacern turns a spreadsheet-and-email process into a governed decision workflow. Somebody first builds the capability — brings data in, prepares it, trains models, sets the rules. Then, every day, people run decisions on it: an AI agent reads each case and proposes an outcome (never acts alone), a human approves, edits, or rejects, the decision writes back, and every correction becomes training data so the next proposal is better.

- The AI proposes; you decide. No recommendation ever changes a record without a human approval.
- Everything is grounded and governed. Each step cites the real data it used and is authorized per-request against your permissions.
- You only see what your role allows. Menus, buttons and pages adapt to you; anything you can’t use fails closed with a clear message.

# 2. The four people in the story

You may hold one role or several. In the demo each is a separate sign-in so you can walk the whole loop — build and run.

| Persona | Signs in as | Their job across build + run |
|---|---|---|
| Data Scientist | datascientist@demo.datacern | Builds the capability: connects data, prepares datasets & semantic models, builds ML pipelines, runs experiments and evals. |
| Case Analyst (Adjuster) | adjuster@demo.datacern | Runs the decision: works the case queue, reads the AI recommendation, sets disposition, asks the copilot. |
| Case Manager | manager@demo.datacern | Approves the decision: reviews the AI proposal and approves / rejects (four-eyes — never self-approves). |
| Tenant Admin | admin@demo.datacern | Governs it all: decision tables, tool registry, model ladders, RBAC, kill switches. |

| Sign-in note The demo uses simple email sign-in: type the persona’s email and click Sign in. A real deployment uses your company SSO (the “Sign in with SSO” button); every step after login is identical. |
|---|

# 3. Signing in

- Open the platform at http://localhost:3000 (or your company URL).
- Type your email and click Sign in. You land on Home, scoped to your tenant and role.

Figure 1. The login page. Company SSO is the button on the right; the demo uses email sign-in.

Home shows your worklist, an approval counter, and the Learning-loop panel — the count of decisions captured and human corrections that train the next model.

Figure 2. Home: your queue, what’s awaiting approval, the live learning-loop counter, and AI cost.

Part I · Build the capability

DATA SCIENTIST + ADMIN signs in as datascientist@demo.datacern (build) and admin@demo.datacern (govern)

Before anyone triages a claim, someone makes the capability exist: connect the data, prepare it into governed datasets and models, build the ML pipelines, and gate the models with evals. This is the build journey — mostly the Data Scientist, with the Admin governing.

# 4. Data sourcing — connect where your data lives

Everything starts from real data. Open Data → Data Sources and click New data source. Datacern can connect to databases, warehouses, object stores, file servers, SaaS apps — or you can upload a file directly.

Figure 3. Choosing a source type: Postgres/MySQL/Oracle/SQL-Server, Snowflake/BigQuery/Redshift/Databricks/Synapse/Trino, S3/Azure-Blob/GCS, SFTP/FTP, Salesforce/HTTP — or a direct file upload.

- Pick a source type (for a quick start, File upload accepts CSV, JSON, Parquet, Avro, or XML).
- Enter connection details and Test connection — a green succeeded confirms Datacern can reach it.
- Save it. Your connections live on the Data Sources page, each re-testable and editable.

Figure 4. Saved connections. Each shows its type, last-tested status, and Test / Edit / Delete actions.

A saved source is pulled in by an ingestion run (Data → Ingestions), which lands the data as a versioned dataset. Runs show live status with Retry / Re-ingest if a source hiccups — nothing silently disappears.

# 5. Data preparation — turn raw data into governed assets

## 5.1 Datasets & profiling

Each ingested source becomes a dataset with versions, a profile, and lineage. Open Data → Datasets and confirm yours reads ready. Rows link through to schema, column distributions, and where the data came from.

Figure 5. The dataset index — real ingested data, each profiled and query-ready.

## 5.2 Explore with governed SQL

Open Data → Queries to run ad-hoc SQL against the governed query engine, save reusable queries, and review execution history. Statements are read-only and results are capped — safe exploration.

Figure 6. The governed query editor with a library of saved, versioned queries you can Run, Edit, or branch.

## 5.3 Semantic models — define your metrics once

A semantic model binds business concepts (entities, dimensions, measures) to real dataset columns, so dashboards and agents all speak the same governed language. Open Data → Semantic Models, click New model, name it, then bind its dimensions and measures to columns.

Figure 7. Creating a semantic model. After naming it you bind entities, dimensions and measures to real dataset columns.

Published models show a health indicator; a model with a broken column reference surfaces as unhealthy so you fix it before anything depends on it. Model changes are reviewable (four-eyes) before publish.

# 6. Pipelines — build, validate, run

Pipelines are no-code ML/data workflows assembled from a catalog of steps. Open Data → Pipelines to see every pipeline in the workspace — data-prep and training alike — each with Run, Edit, Versions, Compile, Clone, and Archive.

Figure 8. The pipeline catalog: real training pipelines (xgboost, isolation-forest, random-forest) and data-prep pipelines, each runnable and versioned.

- Click New pipeline, give it a name and type (data-prep or training).
- Add steps from the catalog and bind each step’s inputs to your datasets/columns.
- Click Compile to validate the graph, then Run — or use Schedules to run it on a recurring cadence.
- Every run appears under Runs with live status (no page refresh) so you can watch it progress.

| Tip Pipelines read the real rows of your prepared datasets, and a training pipeline’s output is automatically mirrored into the model registry (next section) — so a model you train here is immediately promotable. |
|---|

# 7. AI / ML — experiments, models, and the eval gate

## 7.1 Experiments & models

Open Machine Learning → ML. Experiments track training runs with live status; the Models tab is the registry of versioned models; Inference jobs run batch scoring. A model trained by a pipeline shows up here automatically (“auto-mirrored from an MLflow training run”), ready to promote.

Figure 9. Experiments — training runs with live status, plus Models, Inference-jobs and Eval tabs. Note the model auto-mirrored from a pipeline run.

## 7.2 The eval gate

A model is never promoted on trust. Open Machine Learning → Eval — the eval flywheel: scoring Runs with gate status, per-scorer Trends / scorecard, frozen eval Datasets, a Case queue of candidate cases from real corrections, a Scorer registry, and Canaries for A/B against the current baseline.

Figure 10. The eval flywheel: runs & gates, score-trend scorecards, scorers, and canary A/B comparisons — the promotion gate for models and agents.

Only a candidate that clears its eval suite can be promoted (by an admin) to serve real decisions — and it can be rolled back just as cleanly.

# 8. Insights — dashboards on your governed data

Finally, Insights → Dashboards turns the semantic models into boards your business users watch. Click Create dashboard, add charts bound to your model’s measures and dimensions, and (optionally) schedule the board to be emailed. Each installed pack ships its own dashboards.

Figure 11. Dashboards in this workspace — the many boards come from the vertical packs installed in the tenant.

| What you just built A connected source → a ready governed dataset → a semantic model → a validated pipeline → an eval-gated model → dashboards. The capability now exists. Part II is how people use it every day. |
|---|

Part II · Run the decision

We follow one claim — Sofía Gómez, CLM-1014, a $760.40 auto headlamp claim — from the queue to an approved, governed decision.

# 9. Case Analyst (Adjuster) — work the queue

ADJUSTER signs in as adjuster@demo.datacern

The adjuster is the day-to-day worker. Notice the left nav is shorter than the builder’s — the platform only shows what this role can use.

- Open Cases — a searchable, ranked worklist of every open claim, with severity, status, assignee and due date.

Figure 12. The case worklist. Real claimants (Sofía Gómez, Kenji Watanabe, María José Peña…), severity and status at a glance.

- Click a case (CLM-1014). The Overview tab shows the claim’s Evidence — amount, claimant, description, invoice, policy, vendor — pulled live from the warehouse, with a Row reference back to the source dataset, and the AI’s recommendation marked AI-generated.

Figure 13. Case CLM-1014: grounded evidence, and the AI’s “Recommended: apply disposition” with a plain-English rationale.

- Open the Proposals tab to see exactly what the AI wants to change, as a diff. Here two proposals stand — one from the triage copilot, one fired by a governed decision-table rule — both propose, neither acts.

Figure 14. The Proposals tab: each proposal as a field-level diff (case_id, disposition, resolution note, severity) with its source.

As an adjuster you own the case lifecycle — assign, set status, comment, or ask the Copilot (see §12). What you cannot do is approve the AI’s proposal — that authority is the manager’s.

# 10. Case Manager — decide (four-eyes)

CASE MANAGER signs in as manager@demo.datacern

- Open Approvals. Every pending AI proposal queues here as a card with the agent, the change, the rationale, and affected records. A clear queue reads No pending proposals.

Figure 15. The approval inbox. Pending proposals appear as decision cards; four-eyes means the reviewer is never the proposer.

- Open a card and click Approve. The agent issues a signed grant, the tool layer verifies it, the case updates, and the badge decrements live — no refresh.
- To reject, click Reject and enter a reason. The reason is mandatory — and becomes a training signal for the next model.

| Why four-eyes matters The reviewer of a proposal is structurally prevented from being the one (or the agent) who created it. This is the governance guarantee that makes AI-assisted decisions auditable and safe for regulated work. |
|---|

# 11. Tenant Admin — govern the decision logic

ADMIN signs in as admin@demo.datacern

- Open Decision Tables — no-code governed rules over your worklist columns (e.g. “severity eq high → escalate”). A rule proposes a disposition for human approval; it never decides autonomously. Versions are published and approved by a named user.

Figure 16. Governed decision tables: deterministic rules that propose (not enact) a disposition, each version approved and published.

- Open Admin → Tool registry — every tool an agent may call, with its owning service, whether effects are reversible, and per-tenant enablement. External tools must pass review; write-direct is forbidden for them.

Figure 17. The tool registry: the governed catalog of everything agents can do, with reversibility and per-tenant enablement.

Authorization is enforced on every request. Even an admin hitting a surface their role doesn’t include gets a clean, fail-closed message with a trace id — never a silent partial result.

Figure 18. Fail-closed by design: a role lacking a capability sees a clear “you don’t have access”, never a broken page.

# 12. Working with the Copilot

The Copilot (top-right on any page, or the Copilot nav item) is a role-grounded assistant. It knows what you’re looking at — on a case it carries that case as context — and it is governed: it only answers within your permissions and over the governed semantic layer, and it clearly warns that its output must be verified before you act.

- Open a case (or any page) and click Copilot.
- Type a grounded question — e.g. “what is this claim about and why might it need review?” — and Send.
- Read the streamed answer. Use it to understand faster, then make the decision yourself. The copilot never files a disposition on its own — that still flows through a proposal and an approval.

Figure 19. The copilot answering live on case CLM-1014. Note it stays grounded — it reasons “as a Case Analyst” over “our governed semantic layer” and asks for context rather than fabricating.

| Grounded, not gullible Notice the copilot didn’t invent claim facts it wasn’t sure of — it asked for more context. That is the design: assist and explain, never hallucinate or act. The banner “Responses may be inaccurate — verify before acting” is always present. |
|---|

# 13. How the loop closes (why corrections matter)

Every time the manager edits or rejects a proposal, the correction is captured — inputs, the AI’s grounding, what it proposed, what the human decided. Consented corrections curate into a versioned training dataset; that distils into a small model that becomes the cheapest first rung the next triage tries. The Learning-loop panel on Home (Figure 2) is this in motion.

| The one honest boundary The training compute that produces a new model runs on GPU hardware. On a laptop demo there is no GPU, so a training job fails cleanly with a “trainer not configured” message rather than inventing a fake model. Everything else in this guide is the real, running system. |
|---|

# 14. Quick reference — a day in the life

- Data Scientist (build): Data Sources → connect → Ingestions → Datasets (ready?) → Queries/Semantic Models → Pipelines (compile + run) → ML/Eval (train + gate).
- Adjuster (run): Cases → open top of queue → read evidence + AI recommendation → set disposition or ask the Copilot → hand off for approval.
- Manager (approve): Approvals → review each card → Approve, or Reject with a reason → watch the badge clear.
- Admin (govern): Decision Tables → Tool registry → Users/RBAC → model ladders & kill switches.

# 15. Other vertical packs — same journey, different domain

Claims triage is one of ~20 installed packs. They all ride the same build + run journey you just learned — connect → prepare → pipeline → model/eval → case → propose → decide → learn. Each pack only changes the domain: the data, the case fields, the agents’ prompts, the decision-table columns, and the dashboards. The dashboards grid (Figure 11) hints at the range:

- Payments / disputes — chargeback & dispute adjudication (Denial Analytics, A/R Aging).
- Financial crime — AML Command Center, Sanctions & Screening, SIU (fraud) Command Center.
- Healthcare payer / provider — Prior-Auth Ops, Appeals Analytics, Readmission Watch, Referral Intake.
- Revenue operations — Revenue Leakage, RCM Command Center, Enrollment Funnel.

To use any of them: sign in to that pack’s tenant and follow the same steps. If you can build and run claims triage, you can do them all.

All screenshots were captured from the live running platform against real seeded data. Where a capability depends on external infrastructure (GPU training), the guide says so plainly rather than showing a fabricated result.
