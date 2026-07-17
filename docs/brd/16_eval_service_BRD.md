# BRD 16 — eval-service

**Service:** eval-service · **Language:** Python 3.12 (FastAPI + Temporal workers for eval runs) · **Phase:** 2 (analytics golden set + CI gate) → 4 (HITL flywheel, canary) → 5 (online sampling at scale, SLO computation)
**Inherits:** `00_MASTER_BRD.md`. Architecture refs: `WINDROSE_PLATFORM_ARCHITECTURE.md` §8.8, principle 6 ("no agent change ships without an eval"); `WINDROSE_V3_AGENTIC_ARCHITECTURE.md` §5.11.

---

## 1. Overview

**Purpose.** eval-service is the quality flywheel for every agent: it manages **versioned golden datasets** per agent (sourced from verified queries, anonymized production traces, HITL rejections with reasons, and approval edit-diffs), runs a **scorer framework** (deterministic scorers first — SQL result-set equivalence, tool-selection accuracy, schema validity, cost ceilings — and LLM-judge second — groundedness, helpfulness — with the hard rule that judge-only verdicts never gate alone), executes **eval runs** (CI webhook, agent-version publish, scheduled online sampling of production traces from Langfuse/OTel), exposes the **CI gate API** (pass/fail vs baseline with regression thresholds), performs **canary comparison** (candidate vs current on live traffic samples), stores scores with trend APIs, and computes **agent SLOs** (task completion rate, escalation rate, cost per completed task).

**Business value.** Prompt/graph/model changes shipped blind (chat-agent-service's four untracked `ANALYSIS_PROMPT_FINANCIAL_V*` iterations) are the single largest agent-quality risk. eval-service makes eval gates equal in status to tests: no agent version publishes without one (enforced by agent-registry, BRD 14 ART-FR-060), regressions block merges, canaries gate promotions, and production failures feed back into datasets automatically.

**In scope:** dataset management + case sourcing pipelines; scorer framework + registry; eval run execution (against agent-runtime replay/shadow modes); CI gate API; canary comparison; score storage + trends; agent SLO computation + error budgets; Langfuse integration contract; judge calls via ai-gateway judge ladder.
**Out of scope:** Langfuse itself (deployed infra); trace *emission* (every service emits OTel; Langfuse ingests); the publish decision (agent-registry enforces; eval-service supplies the verdict); human labeling UI beyond case review queues (ui-web); model fine-tuning from flywheel data (data prepared, training deferred).

## 2. Actors & user stories

Personas: **Agent Engineer**, **CI Pipeline**, **Agent Registry** (service), **QA/Domain Expert** (case curator), **Platform Operator**, **Tenant Admin** (read-only quality visibility).

- **US-1** As an Agent Engineer, I change the analytics agent prompt in a PR; CI calls the gate API, the suite runs against the candidate build, and the merge is blocked because SQL result-set equivalence dropped 4% vs baseline (threshold 2%).
- **US-2** As the Agent Registry, before publishing analytics@v15 I require a passing gate result for exactly that version's content digest, no older than the last content change.
- **US-3** As a QA curator, I review auto-harvested candidate cases (a HITL rejection with the reason "wrong assignee — this vendor class routes to team B") and promote them into the case-triage golden dataset v8 with expected output filled from the human's correction.
- **US-4** As an Agent Engineer, every verified query added in semantic-service automatically becomes a candidate NL→SQL eval case with the verified SQL as expected output.
- **US-5** As a Platform Operator, 5% of production analytics traces are sampled nightly, scored online (groundedness, cost, tool-selection), and score dips page the owning team before users complain.
- **US-6** As an Agent Engineer, I start a canary comparison for v15 vs v14 on 10% live traffic; after 500 paired samples the report shows v15 +3% completion, −12% cost, no metric regressed beyond threshold, and I promote.
- **US-7** As an Agent Engineer, I browse score trends per agent/version/scorer/dataset over releases and drill into individual failed cases with full traces (Langfuse deep links).
- **US-8** As a Platform Operator, per-agent SLOs (task completion, escalation rate, cost/completed task) are computed continuously with error budgets and alerting.
- **US-9** As a Tenant Admin, I see my tenant's agent quality panel (completion rate, escalation rate) without seeing other tenants' data.
- **US-10** As a Security Engineer, judge prompts and versions are pinned per suite; a judge model change requires re-baselining, so scores stay comparable across time.
- **US-11** As a QA curator, anonymization is enforced before any production trace becomes a dataset case — PII scrubbing runs and I attest the case is clean before promotion.
- **US-12** As an Agent Engineer, eval runs are reproducible: dataset version + agent version + scorer versions + judge ladder + memory snapshot version are all pinned in the run record.

## 3. Functional requirements

### Golden dataset management
- **EVL-FR-001 (Must)** Dataset: `{dataset_key (per agent_key, e.g. analytics/nl2sql, case-triage/proposals), version int (immutable once frozen), description, case_count, provenance_summary, status: draft→frozen→archived}`. Frozen versions are immutable; edits create the next draft version (copy-on-write).
- **EVL-FR-002 (Must)** EvalCase: `{case_id, dataset_key, input {messages|task, context_refs (semantic model ver, memory snapshot_ver, resource fixtures)}, expected {kind: sql_result|tool_sequence|proposal|structured|rubric, value}, source: verified_query|production_trace|hitl_rejection|approval_edit_diff|manual, source_ref (trace id / proposal id / verified query URN), tags[], anonymization_attested_by?, weight float default 1.0, status: candidate→active→retired}`.
- **EVL-FR-003 (Must)** **Case sourcing pipelines** (each produces `candidate` cases into a review queue; nothing auto-promotes to `active` except verified queries, which are pre-governed):
  (a) **Verified queries** — consume `semantic.events.v1: verified_query.created|updated` → NL input + verified SQL expected (auto-active, tagged `verified_query`);
  (b) **Anonymized production traces** — sampled low-score or operator-flagged traces from Langfuse → input reconstruction + PII scrub (Presidio + rules) → candidate;
  (c) **HITL rejections** — consume `ai.proposal.v1: proposal.rejected` → input = run context at proposal time, expected = *not* the proposed action, rejection message attached as rubric/label;
  (d) **Approval edit-diffs** — consume `proposal.edited_approved` → expected = edited args (the human-corrected answer), diff stored as the supervision signal.
- **EVL-FR-004 (Must)** Curation APIs: review queue list, promote (requires `anonymization_attested_by` for production-sourced cases), reject, edit, retire; bulk tag ops. Dataset freeze requires ≥ 1 active case and a curator sign-off.
- **EVL-FR-005 (Must)** Minimum gate-dataset sizes enforced at suite binding: analytics/nl2sql ≥ 100 active cases (Phase 2 exit criterion); other agents ≥ 50 before their gate becomes blocking (below that, gate runs advisory).
**Eval case example (analytics/nl2sql, sourced from a verified query):**
```json
{"case_id": "ec-01J2", "dataset_key": "analytics/nl2sql", "source": "verified_query",
 "source_ref": "wr:t-42:semantic:verified_query/vq-88",
 "input": {"messages": [{"role": "user", "content": "monthly revenue by region for the last 4 quarters"}],
   "context_refs": {"semantic_model_ver": "ws-7f3@v12", "memory_snapshot_ver": "2026-07-08",
                    "fixture_warehouse": "fw-analytics-v3"}},
 "expected": {"kind": "sql_result",
   "value": {"sql": "SELECT region, date_trunc('month', order_date) AS m, SUM(net_revenue)…",
             "float_tolerance": 0.01, "order_insensitive": true}},
 "tags": ["revenue", "time-series"], "weight": 1.0, "status": "active"}
```

- **EVL-FR-006 (Should)** Dataset diff API (`GET /datasets/:key/versions/:a/diff/:b`) — added/removed/changed cases, for baseline comparability review.

### Scorer framework
- **EVL-FR-010 (Must)** Scorer registry: `{scorer_key, kind: deterministic|llm_judge, version, config_schema, applicable_expected_kinds[], gate_eligible: bool}`. **Judge scorers have `gate_eligible=false` standalone** — a gate metric set must include ≥ 1 deterministic scorer; judge scores may only gate in combination (BR-1).
- **EVL-FR-011 (Must)** Built-in deterministic scorers v1:
  (a) `sql_result_equivalence` — execute candidate SQL and expected SQL against the pinned fixture warehouse (read-only eval schema), compare result sets (order-insensitive, float tolerance config, column-name normalization); score 1/0 + mismatch diff;
  (b) `tool_selection_accuracy` — compare invoked tool sequence vs expected (exact / set / prefix modes per case config);
  (c) `schema_validity` — structured outputs validate against the tool/output JSON Schema;
  (d) `cost_ceiling` — run cost (from metering) ≤ per-case or per-suite ceiling;
  (e) `proposal_match` — proposed tool+args vs expected proposal (field-level, with per-field must/should weights);
  (f) `latency_ceiling` (Should) — full-answer latency ≤ ceiling.
- **EVL-FR-012 (Must)** LLM-judge scorers v1: `groundedness` (answer claims supported by cited tool results/chunks; verdict + per-claim rationale), `helpfulness` (rubric 1–5). Judges call **ai-gateway `judge` request class** (temperature 0, pinned judge ladder — BRD 12 AIG-FR-005/AC-14); judge prompt artifacts are versioned; every judge result stores `{judge_model, judge_prompt_ver, rationale}`.
- **EVL-FR-013 (Must)** Custom scorers: registered as containerized scorer plugins (image + config schema) executed in the sandbox pool (no network except declared fixtures); platform-operator approval to register.
- **EVL-FR-014 (Should)** Judge calibration set: a small human-labeled set per judge scorer; judge-vs-human agreement computed on each judge prompt/model change; agreement < 0.8 blocks judge version activation.

**Suite definition example (analytics publish gate):**
```json
{"suite_id": "analytics-gate", "version": 4, "agent_key": "analytics",
 "datasets": [{"dataset_key": "analytics/nl2sql", "version": 9}],
 "scorers": [
   {"scorer": "sql_result_equivalence", "version": 2, "weight": 0.5, "regression_threshold": -0.02},
   {"scorer": "tool_selection_accuracy", "version": 1, "weight": 0.2, "regression_threshold": -0.05},
   {"scorer": "cost_ceiling", "version": 1, "weight": 0.1, "config": {"usd_per_case_max": 0.25}},
   {"scorer": "groundedness", "version": 3, "weight": 0.2, "regression_threshold": -0.3}],
 "gate_rule": "sql_result_equivalence.mean >= baseline - 0.02 AND tool_selection_accuracy.mean >= baseline - 0.05 AND cost_ceiling.pass_rate >= 0.98 AND groundedness.mean >= baseline - 0.3",
 "judge_ladder_pin": {"request_class": "judge", "prompt_ver": "groundedness@3"},
 "min_cases": 100}
```

### Eval runs
- **EVL-FR-020 (Must)** EvalRun: `{run_id, trigger: ci|publish_gate|scheduled_online|canary|manual, agent_key, candidate {agent_version|build_digest}, baseline?, dataset_key+version | trace_sample_spec, suite_id, scorer pins, memory_snapshot_ver?, status: queued→running→scoring→completed|failed, totals, started_by}`. Runs execute as Temporal workflows; per-case executions parallelized (fan-out cap 20) against **agent-runtime replay/no-side-effect mode** (BRD 14 ART-FR-015: write tools stubbed, memory writes suppressed, corpus retrieval pinned to `memory_snapshot_ver`).
- **EVL-FR-021 (Must)** Triggers:
  (a) **CI webhook** `POST /api/v1/ci/evaluate {repo, commit, agent_key, build_digest, suite_id}` → 202 + callback/poll; also posts a commit status via CI integration;
  (b) **publish gate** — agent-registry requests a gate run for a draft version (or reuses a fresh passing run for the same content digest);
  (c) **scheduled online sampling** — cron per agent: sample N% of production traces (from Langfuse API, filter: completed runs, per-tenant fair sampling) and score them with production-safe scorers (no re-execution; groundedness, schema, cost, tool-selection vs plan) — results feed SLOs and the flywheel, never gates;
  (d) **canary** (EVL-FR-030); (e) manual.
- **EVL-FR-022 (Must)** Suite: `{suite_id, agent_key, datasets[], scorers[] with weights + per-scorer regression thresholds, gate_rule (expression over scorer aggregates, e.g. `sql_result_equivalence.mean >= baseline - 0.02 AND cost_ceiling.pass_rate >= 0.98 AND groundedness.mean >= baseline - 0.05`), judge_ladder pin, min_cases}`. Suites versioned; the gate rule must reference ≥ 1 deterministic scorer (validated at save).
- **EVL-FR-023 (Must)** Eval spend draws from the platform system/eval budget (BRD 12 BR-7) with per-run cost caps; a run exceeding its cap fails `EVAL_BUDGET_EXCEEDED` with partial results retained.
- **EVL-FR-024 (Must)** Full reproducibility: re-running an EvalRun's pin set yields comparable results; all pins recorded (dataset ver, agent content digest, scorer versions, judge model+prompt ver, memory snapshot, fixture warehouse snapshot).

### CI gate API
- **EVL-FR-030 (Must)** `GET /api/v1/gates/:gate_run_id` → `{gate_passed: bool, verdicts: [{scorer, aggregate, baseline, threshold, passed}], failed_cases_sample[], report_url}`. Baseline = the suite's designated baseline version's most recent frozen scores on the same dataset version (recomputed if dataset version differs — never compare across dataset versions silently; mismatch → `BASELINE_INCOMPARABLE`, gate fails safe).
- **EVL-FR-031 (Must)** Gate results are immutable, addressable by `(agent_key, content_digest, suite version, dataset version)`; agent-registry consumes `eval.events.v1: gate.completed`.
- **EVL-FR-032 (Should)** Flake control: per-case retry once on infra-class failure (runtime 5xx, timeout); scorer-level nondeterminism report (case pass variance across retries) attached to the run.

### Canary comparison
- **EVL-FR-040 (Must)** CanaryComparison: `{comparison_id, agent_key, candidate_version, baseline_version, sample_spec {traffic_pct source: rollout id (BRD 14), min_samples default 200, max_duration}, mode: paired_shadow|split_live}`. `paired_shadow`: every sampled live input also runs on the candidate in shadow → paired scoring on identical inputs (preferred). `split_live`: score each arm's own traffic (when shadow is too costly). Scorers: production-safe set + cost + latency.
- **EVL-FR-041 (Must)** Report: per-scorer candidate vs baseline with confidence intervals (bootstrap), regression flags per threshold, SLO deltas; status `collecting → ready → expired`. `canary.scored` events let agent-registry auto-promote/halt (BRD 14 ART-FR-061).
- **EVL-FR-042 (Must)** Early stop: if any Must-scorer regression exceeds 2× its threshold with ≥ 50 samples, emit `canary.failed_early` immediately.

### Scores, trends, SLOs
- **EVL-FR-050 (Must)** Score storage: per-case results (scorer outputs, rationale refs, trace links) + per-run aggregates; trend API `GET /api/v1/trends?agent_key=&scorer=&window=` (per version and per time bucket). Tenant-visible views expose only tenant-attributable online-sampling aggregates.
- **EVL-FR-051 (Must)** **Agent SLO computation** (streaming, from `ai.agent_run.v1`, `ai.proposal.v1`, `ai.token_usage.v1` + online scores): per agent_key×version×tenant and rolled up — `task_completion_rate` (completed / (completed+failed+expired_proposal+abandoned)), `escalation_rate` (runs ending in human-handoff or rejection / total), `tool_error_rate`, `p95_first_token`, `p95_full_answer`, `cost_per_completed_task`. Error budgets per agent (targets set at version publish, stored here); budget burn alerts via standard alerting.
- **EVL-FR-052 (Must)** SLO API: `GET /api/v1/slos?agent_key=&window=` (operator: all tenants; tenant admin: own tenant); dashboards-as-code ship with the service (MASTER-FR-072).

**SLO metric definitions (normative formulas):**

| Metric | Formula (per agent_key × version × window) | Source events |
|---|---|---|
| `task_completion_rate` | completed / (completed + failed + expired_proposal + abandoned) | `ai.agent_run.v1` |
| `escalation_rate` | (runs with human-handoff outcome + rejected-proposal terminal runs) / total runs | `ai.agent_run.v1`, `ai.proposal.v1` |
| `tool_error_rate` | tool invocations with error ÷ total invocations attributed to the agent | `ai.tool_invoked.v1` |
| `proposal_acceptance_rate` | (approved + edited_approved) / decided proposals | `ai.proposal.v1` |
| `p95_first_token` / `p95_full_answer` | latency percentiles over completed runs | run usage + trace attrs |
| `cost_per_completed_task` | Σ cost_usd (all runs) / completed runs | `ai.token_usage.v1` joined on run_id |

Abandoned = session expired/terminated with the final run in `awaiting_input` > 15 min. Windows: 1h/24h/7d/30d rolling.

### Langfuse / OTel integration contract
- **EVL-FR-060 (Must)** Contract: all agent traces land in Langfuse via OTel (GenAI semconv pinned, MASTER-FR-052) with required attributes `{tenant_id, agent_key, agent_version, run_id, session_id, request_class}`. eval-service reads via Langfuse API: trace fetch by id, filtered sampling queries, and **writes back** scores (Langfuse score API) so traces and evals are joined in one UI. Langfuse project-per-cell; tenant_id as trace metadata (Langfuse is operator-facing; tenant users never access it directly).
- **EVL-FR-061 (Must)** Trace completeness monitor: sampled reconciliation of `ai.agent_run.v1` events vs Langfuse traces; missing-trace rate > 1% alerts (observability contract enforcement).
- **EVL-FR-062 (Should)** Human feedback ingestion: UI thumbs/structured feedback events (`ui.feedback.v1`) attached as Langfuse scores + harvested as dataset candidates.

## 4. Domain model & data

Postgres `eval` DB; standard columns + RLS (datasets/suites/runs are platform-scoped rows unless tenant-sourced; tenant-attributable rows carry real tenant_id).

| Table | Key columns | Indexes / notes |
|---|---|---|
| `datasets` | dataset_key, version int, agent_key, status enum(draft,frozen,archived), case_count, frozen_by, frozen_at | unique (dataset_key, version) |
| `eval_cases` | dataset_key, dataset_version, input jsonb (≤64KB, documented; larger fixtures → object storage pointer), expected jsonb (≤64KB), source enum, source_ref, source_tenant_id?, tags text[], anonymization_attested_by?, weight, status enum(candidate,active,retired) | idx (dataset_key, dataset_version, status); idx GIN tags; idx (source, status) for review queues |
| `scorers` | scorer_key, version, kind enum, gate_eligible bool, config_schema jsonb, image_ref? (custom), judge_prompt_ref?, judge_agreement? | unique (scorer_key, version) |
| `suites` | suite_id, agent_key, version, datasets jsonb, scorers jsonb (pins+weights+thresholds), gate_rule text, judge_ladder_pin, min_cases | unique (suite_id, version); save-time validation of gate_rule |
| `eval_runs` | run_id uuidv7, trigger enum, agent_key, candidate jsonb {agent_version?, content_digest}, baseline jsonb?, suite pins jsonb, memory_snapshot_ver?, status enum, totals jsonb, temporal_workflow_id, cost_usd | partitioned by month; idx (agent_key, trigger, created_at); retention 25 months |
| `case_results` | run_id, case_id, scorer_key+ver, score numeric, passed bool, details jsonb (≤32KB; diffs/rationale), trace_ref (Langfuse id), latency_ms, cost_usd | partitioned by month; idx (run_id); retention 13 months (aggregates kept longer) |
| `gate_results` | gate_run_id, agent_key, content_digest, suite pins, gate_passed bool, verdicts jsonb, immutable | unique (agent_key, content_digest, suite_id, suite_version, dataset_version) |
| `canary_comparisons` | comparison_id, agent_key, candidate/baseline versions, sample_spec jsonb, mode enum, status enum(collecting,ready,failed_early,expired), report jsonb | idx (agent_key, status) |
| `slo_rollups` | agent_key, agent_version, tenant_id?, window_start, metrics jsonb {completion_rate, escalation_rate, tool_error_rate, p95s, cost_per_task}, sample_n | partitioned by month; unique (agent_key, agent_version, tenant_id, window_start); retention 25 months |
| `outbox` | standard | |

**State machines.**
- Dataset version: `draft → frozen → archived`; freeze guard: ≥1 active case + curator sign-off; frozen is immutable (trigger-enforced).
- EvalCase: `candidate → active → retired`; promote guard: production-sourced requires anonymization attestation.
- EvalRun: `queued → running → scoring → completed | failed`; cancel from non-terminal.
- CanaryComparison: `collecting → ready | failed_early | expired (max_duration)`.

**Index & retention summary.**

| Table | Hot-path indexes | Partitioning / retention |
|---|---|---|
| `eval_cases` | (dataset_key, dataset_version, status); (source, status); GIN(tags) | none / retired kept with dataset version |
| `eval_runs` | (agent_key, trigger, created_at) | monthly / 25 months |
| `case_results` | (run_id) | monthly / 13 months (aggregates permanent in `eval_runs.totals`) |
| `gate_results` | (agent_key, content_digest, suite_id, suite_version, dataset_version) unique | none / permanent (compliance evidence) |
| `slo_rollups` | (agent_key, agent_version, tenant_id, window_start) unique | monthly / 25 months |

**Canary report example (excerpt):**
```json
GET /api/v1/canaries/cc-01J7
→ {"data": {"status": "ready", "mode": "paired_shadow", "samples": 512,
  "metrics": [
    {"scorer": "tool_selection_accuracy@1", "candidate": 0.94, "baseline": 0.91, "delta": 0.03, "ci95": [0.01, 0.05], "regressed": false},
    {"scorer": "groundedness@3", "candidate": 4.15, "baseline": 4.22, "delta": -0.07, "ci95": [-0.19, 0.05], "regressed": false},
    {"scorer": "cost_per_task", "candidate": 0.021, "baseline": 0.024, "delta": -0.003, "regressed": false}],
  "slo_deltas": {"p95_full_answer_ms": -420}, "recommendation": "promote"}}
```

## 5. API specification

Base `/api/v1`.

| Method & path | Purpose | Auth | Notable errors |
|---|---|---|---|
| `POST /datasets` · `POST /datasets/:key/versions/:v/freeze` · `GET /datasets…` | dataset lifecycle | agent engineer/curator | 409 (frozen), 422 (freeze guard) |
| `GET /cases?filter[status]=candidate&filter[dataset_key]=` · `POST /cases/:id/promote|reject` · `PATCH /cases/:id` | curation queue | curator | 422 ANONYMIZATION_REQUIRED |
| `GET /datasets/:key/versions/:a/diff/:b` | dataset diff | engineer | — |
| `POST /scorers` · `POST /scorers/:key/versions/:v/activate` | scorer registry | operator | 422 (judge agreement gate) |
| `POST /suites` · `GET /suites/:id` | suite config | engineer/operator | 422 (gate_rule lacks deterministic scorer) |
| `POST /ci/evaluate` | CI trigger | CI service token (mTLS) | 202 {operation_id} |
| `POST /runs` · `GET /runs/:id` · `POST /runs/:id/cancel` · `GET /runs/:id/cases` | manual runs + inspection (paginated) | engineer | 402 EVAL_BUDGET_EXCEEDED |
| `GET /gates/:gate_run_id` · `GET /gates?agent_key=&content_digest=` | gate verdicts | agent-registry (mTLS), CI, engineer | 409 BASELINE_INCOMPARABLE |
| `POST /canaries` · `GET /canaries/:id` · `POST /canaries/:id/stop` | canary comparisons | operator/engineer | 409 |
| `GET /trends?agent_key=&scorer=&window=` | score trends | engineer/operator; tenant admin (own aggregates) | — |
| `GET /slos?agent_key=&window=` | SLO metrics + budgets | operator; tenant admin (own) | — |

**Example — CI gate verdict:**
```json
GET /api/v1/gates/gr-01HX
→ 200 {"data": {"gate_passed": false,
  "candidate": {"agent_key": "analytics", "content_digest": "sha256:ab12…"},
  "verdicts": [
    {"scorer": "sql_result_equivalence@2", "aggregate": 0.87, "baseline": 0.93, "threshold": -0.02, "passed": false},
    {"scorer": "cost_ceiling@1", "aggregate": 0.99, "baseline": 0.98, "threshold": -0.02, "passed": true},
    {"scorer": "groundedness@3", "aggregate": 4.1, "baseline": 4.2, "threshold": -0.3, "passed": true}],
  "failed_cases_sample": [{"case_id": "c-…", "scorer": "sql_result_equivalence@2",
     "details": {"diff": "expected 12 rows, got 9; missing group 'EMEA'"}, "trace_ref": "lf-…"}],
  "report_url": "https://…/eval/runs/gr-01HX"}}
```

## 6. Events

**Emitted** (`eval.events.v1`):
- `gate.completed {gate_run_id, agent_key, content_digest, gate_passed, suite pins}` — consumed by agent-registry (publish gate) and CI.
- `canary.scored {comparison_id, status, summary}` · `canary.failed_early {regressing_scorers}` — consumed by agent-registry rollout automation.
- `dataset.version_frozen`, `case.promoted {source}`, `slo.budget_burn {agent_key, metric, burn_rate}`, `eval_run.completed|failed`.

**Consumed:**
- `semantic.events.v1: verified_query.created|updated` → auto case creation (EVL-FR-003a).
- `ai.proposal.v1: proposal.rejected|edited_approved` → flywheel candidates (EVL-FR-003c/d).
- `ai.agent_run.v1` + `ai.token_usage.v1` → SLO streaming rollups.
- `agent.events.v1: agent_version.published` → schedule post-publish baseline run; `rollout.started (canary)` → auto-create canary comparison if configured.
- `ui.feedback.v1` → Langfuse scores + candidates (Should).

## 7. Business rules & edge cases

- **BR-1** **Judge-never-gates-alone:** suite save rejects gate rules without ≥1 deterministic scorer term; gate evaluation re-asserts at runtime (defense in depth). Judge score movements alone may *alert*, never block or auto-promote.
- **BR-2** Baseline integrity: baselines pair (agent version × dataset version × scorer versions). Any pin mismatch → `BASELINE_INCOMPARABLE` and the gate fails safe (a gate can never pass by comparing incomparables). New dataset versions require a baseline re-run before gating candidates.
- **BR-3** Anonymization is a promotion precondition for production-sourced cases: automated scrub + human attestation; unattested cases cannot enter `active` nor be exported. Case content follows MASTER-FR-042 (URN references over raw PII).
- **BR-4** Eval-vs-production separation: eval executions run in the runtime's no-side-effect mode with pinned memory snapshots; the fixture warehouse is a read-only eval schema seeded per dataset version — eval can never mutate tenant data (netpol + mode assertions).
- **BR-5** Tenant-sourced cases retain `source_tenant_id`; a tenant's erasure/offboarding retires its production-sourced cases (dataset versions already frozen keep aggregate scores but case content is redacted — scores remain valid history, content is gone).
- **BR-6** Online sampling fairness: per-tenant sampling caps prevent one high-volume tenant from dominating quality signals; sampling never increases user latency (post-hoc trace reads only).
- **BR-7** Nondeterminism: candidate executions run temperature per agent config; gate aggregates use one execution per case by default; suites may pin `n_trials>1` with majority/mean rules — cost caps apply across trials.
- **BR-8** Judge drift: judge model or prompt version change requires calibration (EVL-FR-014) and creates a re-baselining task for all suites pinning that judge; old and new judge scores are never mixed within a run.
- **BR-9** SQL equivalence edge cases: NULL-ordering and float tolerance configured per case; timeouts on candidate SQL score 0 with `timeout` detail (a cost-bomb candidate must fail, not hang the run) — per-case SQL execution ceiling 60s, fixture-side row cap enforced.
- **BR-10** Concurrency: one active gate run per (agent_key, content_digest, suite version) — duplicate CI triggers return the in-flight run's operation id (idempotent).
- **BR-11** Canary sample validity: paired_shadow requires the BRD 14 shadow mode marker on candidate traces; report excludes pairs where either arm hit infra errors (tracked separately as reliability signal, not quality).
- **BR-12** Flywheel loop-guard: cases sourced from a rejection of version N are excluded from N's own retro-baseline (no self-grading on the corrective set until the next version).
- **BR-13** If Langfuse is unavailable: gate runs proceed (traces buffered via OTel collector), online sampling pauses with alert; SLO rollups continue from Kafka events (Langfuse is enrichment, not the SLO source of truth).

## 8. Dependencies

- **Calls:** agent-runtime (replay/no-side-effect executions, shadow hooks), ai-gateway (`judge` class; eval budget), memory-service (snapshot-pinned retrieval), Langfuse API (trace fetch/sample, score write-back), fixture warehouse (read-only eval schemas over Iceberg/DuckDB), sandbox pool (custom scorers).
- **Consumed by:** agent-registry (gates, canary events), CI (GitLab webhook + commit status), bff/ui-web (trends, SLO panels, review queues).
- **Consumes:** Kafka topics per §6; Temporal (run workflows).
- **Infra:** Postgres, Redis, Kafka, Temporal, OPA sidecar, object storage (large fixtures/reports).
- **Contracts:** gate result schema (agent-registry contract-tests it); required trace attributes (EVL-FR-060) are a platform-wide contract this service monitors.

## 9. NFRs (deltas from master)

| Metric | Target |
|---|---|
| CI gate wall-clock (100-case suite, fan-out 20) | p95 ≤ 15 min |
| Gate verdict availability after last case scored | ≤ 30s |
| Online sampling scoring lag | ≤ 24h behind production |
| SLO rollup freshness | ≤ 5 min (streaming) |
| Eval run reproducibility | same pins → same deterministic-scorer results (bit-stable); judge results within ±1 rubric point at temp 0 |
| Eval spend | per-run cost caps enforced; monthly eval budget alerting at 80/95/100% (via BRD 12 budgets) |

## 10. Acceptance criteria

- **AC-1** Given a frozen analytics dataset (≥100 active cases) and a suite whose gate rule includes `sql_result_equivalence`, When CI posts `POST /ci/evaluate` for a commit, Then a run executes against the runtime in no-side-effect mode, completes within the wall-clock SLO in the perf environment, and `GET /gates/:id` returns per-scorer verdicts with baseline deltas.
- **AC-2** Given a candidate whose SQL equivalence mean is 4% below baseline with threshold 2%, Then `gate_passed=false`, the failing verdict names the scorer and delta, `failed_cases_sample` includes result-set diffs, and a `gate.completed {gate_passed:false}` event is emitted.
- **AC-3** Given a suite draft whose gate rule references only `groundedness` (judge), When saved, Then 422 with a message citing the judge-never-gates-alone rule; adding `schema_validity` makes the save succeed.
- **AC-4** Given a new verified query is created in semantic-service, When the event is consumed, Then an **active** eval case exists in the analytics dataset draft with the NL text as input, the verified SQL as expected, and source `verified_query`.
- **AC-5** Given a case-triage proposal is rejected with the message "wrong assignee — vendor class routes to team B", When consumed, Then a `candidate` case exists carrying the run context, the rejected proposal, and the rejection reason; it cannot be promoted without anonymization attestation (attempt → 422), and with attestation it becomes `active`.
- **AC-6** Given an approval with edited args (severity high→medium), When consumed, Then a candidate case's expected value equals the **edited** args and the diff is stored as the supervision label.
- **AC-7** Given agent-registry requests a publish gate for content digest D reusing an existing passing gate for D with identical suite pins, Then the same immutable gate result is returned (no duplicate run); Given the dataset version changed since D's gate, Then `BASELINE_INCOMPARABLE` until a baseline re-run exists.
- **AC-8** Given a canary comparison (paired_shadow, min 200 samples) between v15 and v14, When 200 valid pairs are scored, Then the report shows per-scorer deltas with confidence intervals and status `ready`, and a `canary.scored` event is emitted; Given a Must-scorer regresses 2× threshold at 50 samples, Then `canary.failed_early` fires without waiting.
- **AC-9** Given nightly online sampling at 5% for analytics, Then sampled traces are scored with production-safe scorers only (no re-execution against tenant data — asserted via runtime call absence), scores are written back to Langfuse, and per-tenant sampling caps hold under a skewed-tenant load test.
- **AC-10** Given `ai.agent_run.v1` and proposal events flowing, Then `GET /slos?agent_key=case-triage` returns completion rate, escalation rate, and cost/completed task fresh within 5 min, tenant admins see only their tenant slice, and a synthetic burn scenario raises `slo.budget_burn`.
- **AC-11** Given a judge prompt version bump with calibration agreement 0.72 (<0.8), When activation is attempted, Then 422 and suites keep the old judge pin; with agreement 0.85, Then activation succeeds and affected suites are flagged for re-baselining.
- **AC-12** Given an eval run re-executed with identical pins (dataset, digest, scorers, judge, memory snapshot), Then deterministic scorer results are identical and the run record proves all pins.
- **AC-13** Given a run whose cumulative judge+execution cost hits its cap, Then it fails `EVAL_BUDGET_EXCEEDED`, partial case results are retained and inspectable, and no gate result is produced.
- **AC-14** Given tenant A's admin queries trends or SLOs, Then only tenant A-attributable aggregates return; requesting another tenant's slice returns 404 (isolation suite).
- **AC-15** Given a frozen dataset version, When any case mutation is attempted against it, Then it is rejected (trigger-enforced) and copy-on-write to the next draft version is offered.

## 11. Out of scope / future

Human labeling UI beyond review queues (ui-web builds on these APIs); DPO/fine-tuning export pipelines (edit-diff data retained, format TBD); automated red-teaming harness (quarterly program tooling, tracked separately); cross-agent composite evals (meta-router end-to-end suites — after Phase 5); tenant-authored custom evals; statistical process control on online scores beyond threshold alerts; Langfuse multi-region federation.
