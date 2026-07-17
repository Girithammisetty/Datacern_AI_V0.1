# BRD 24 — `insurance-claims-payer` capability pack

**Deliverable type:** Capability Pack (published via pack-service, BRD 23) · **Publisher:** Windrose · **Initial version:** 1.0.0
**Inherits:** `00_MASTER_BRD.md`, `23_pack_service_BRD.md`. Architecture: `../../WINDROSE_PLATFORM_ARCHITECTURE.md` §6, §9; `../../WINDROSE_V3_AGENTIC_ARCHITECTURE.md` §5.
**Product companion:** `../../WINDROSE_CLAIMS_PRODUCT_SPEC.md`.

---

## 1. Overview

**Purpose.** `insurance-claims-payer` is the **first vertical solution** shipped on Windrose Core — a signed, versioned Capability Pack (BRD 23) that turns the horizontal platform into a *product*: Windrose Claims. The pack ships the ontology, semantic model, dashboards, case schemas, role catalog, connectors, agent recipes, guardrail policies, and eval sets required for a US health-insurance **payer** to deploy AI-assisted **prior-authorization**, **appeal analysis**, and **denial-rationale writing** in ≤ 90 days, additive to their existing Facets / HealthEdge / QNXT / Amisys / Guidewire stack.

**Business value.** (a) **Time-to-value**: install-to-first-live-decision in ≤ 30 days vs. 6–18 months of bespoke build. (b) **Compliance by construction**: CMS-4201-F (interoperability + PA), CMS 2024 MA rule (human review of AI decisions), NAIC Model Bulletin, HIPAA/HITRUST, and EU AI Act Annex III (high-risk) satisfied via Windrose's proposal-mode + audit chain + explainability. (c) **Cost thesis anchored**: the vertical is a workload where a $180/hr clinical reviewer's time dominates every AI call cost — labor arbitrage yields >1000× ROI per decision even at frontier-model pricing, and Windrose's cost mechanisms (deterministic-first, cascade, SLM, distillation — BRD 12 §3.8) compound quarterly. (d) **The learning-loop moat**: every reviewer verdict becomes a governed label; 12 months of resolved cases produce a distilled SLM that no competitor can replicate.

**In scope.** The three flagship agents (Prior-Auth, Appeal Analyst, Denial-Rationale), the payer ontology (Claim / Policy / Member / Provider / Denial / Appeal / PriorAuthRequest / Authorization / ClinicalGuideline), the semantic model and dashboards for the payer KPI catalog (denial rate, overturn rate, PA turnaround, cost per decision, reviewer NPS), case schemas for review workflows, role catalog for the payer org, read connectors (Facets/HealthEdge/QNXT, Guidewire, Epic FHIR, EDI 837/835/270/271/278, Snowflake/Databricks/Iceberg), write adapters (proposal-mode), regulatory guardrail policies, and golden eval sets.

**Out of scope.** Autonomous denial decisions (agents never denial-decide, only draft rationale + score for human — see BR-1); actuarial pricing / underwriting agents (separate future pack `insurance-underwriting-payer`); provider-side RCM (future `insurance-claims-provider`); pharmacy-benefit management workflows (future `pbm-utilization`); Medicaid-specific state waivers (add-on packs); non-US healthcare (jurisdiction-specific packs); replacement of the payer's core admin system (Windrose is additive).

## 2. Actors & user stories

Personas: **PA Nurse Reviewer (PA-N)**, **Medical Director / MD Reviewer (MD)**, **Appeals & Grievances Analyst (A&G)**, **Payment Integrity Analyst (PIA)**, **Chief Medical Officer (CMO)**, **VP Payment Integrity (VP-PI)**, **Chief Compliance Officer (CCO)**, **Data Steward (DS)**, **Tenant Admin (TA)**, **Member Services Agent (MSA)**.

- **US-1** As a PA-N, I open my worklist and see prior-auth requests ordered by (agent confidence × urgency); requests the agent has high-confidence auto-recommended for approval appear pre-drafted so I approve in one click when I agree.
- **US-2** As a PA-N, on a complex PA I click into the agent's proposal and see the cited plan language, medical necessity criteria (InterQual/MCG), and prior-authorization history for the member — all as inline citations I can verify without leaving the case.
- **US-3** As an MD, I get PA cases the nurse escalated with the agent's clinical rationale, cited guidelines, and confidence — I approve, edit, or deny with a mandatory reason that feeds the label store.
- **US-4** As an A&G Analyst, when an appeal arrives I open it and the Appeal Analyst Agent has already drafted a full appeal-analysis packet: the specific denial reason, the strongest overturn arguments with citations to plan policy + clinical evidence + similar prior overturns, and a recommended verdict + confidence.
- **US-5** As an A&G Analyst, I edit the packet in-line, choose uphold or overturn, add my reason — the resolved packet becomes the member letter and the labeled example for the next model version.
- **US-6** As an MSA on the phone with a member, I ask the copilot "why was claim CLM-9F2 denied?" and get a plain-English rationale drawn from the Denial-Rationale Agent's output — cited to policy line, appeal deadline, and next steps.
- **US-7** As the CMO, I open the Payer KPI dashboard and see denial rate, appeal-overturn rate, PA median turnaround, and cost per decision — each with a 90-day trend and drill-down to the individual case.
- **US-8** As the VP-PI, I subscribe to a weekly report of top over-denied procedure codes (high overturn rate on appeal) so I can retrain reviewers and adjust denial rules upstream.
- **US-9** As the CCO, at the end of each month I export a signed audit bundle for CMS/state regulators showing every AI-assisted decision with model version, cited guidelines, reviewer identity, and outcome — the bundle is a single click and completes in < 5 minutes.
- **US-10** As a DS, I approve the pack install into a workspace and review the diff of what will materialize (ontology entities, roles, dashboards, agents) before any user sees it (§BRD 23 §PKG-FR-020).
- **US-11** As a TA, when a new plan year begins (Jan 1) I upgrade the pack to the version carrying the year's new HCPCS codes, MCG/InterQual updates, and updated regulatory disclosures; the upgrade preserves my clinical reviewers' custom-worklist rules (§BRD 23 §PKG-FR-023).
- **US-12** As the CMO, I want a "shadow mode" toggle per agent — the agent runs and stores predictions but never surfaces to reviewers — so I can measure agreement rate against current human decisions before enabling proposals.

## 3. Functional requirements

### Pack manifest & shipped components

- **INS-FR-001 (Must)** The pack ships as `pack.yaml` v1 (BRD 23 §PKG-FR-001..007) with the component inventory below. Every referenced file is included in the signed OCI artifact; component identities are stable across versions to preserve upgrade semantics.

```yaml
pack_manifest: 1
name: insurance-claims-payer
version: 1.0.0
publisher: { id: pub-windrose, name: "Windrose Inc." }
license: { spdx_id: "Commercial", url: "https://windrose.ai/licenses/claims-payer" }
description: "AI-assisted prior-auth, appeal analysis, and denial-rationale writing for US health payers."
categories: [insurance, health, payer, claims, prior-auth, appeals, denials]
regulatory: [cms_4201_f, cms_2024_ma_ai_review, naic_ai_bulletin, hipaa, hitrust_csf, eu_ai_act_annex_iii]
platform: { min_version: "1.4.0", clouds: [aws, azure, gcp] }
depends_on: []                          # standalone; core-financial-utils optional in v2
components:
  ontology:            [ { file: "ontology/payer.yaml" } ]
  semantic_models:     [ { file: "semantic/claims.yaml", identity: "claims" },
                         { file: "semantic/utilization.yaml", identity: "utilization" } ]
  dashboards:          [ { file: "dashboards/payer_kpi.json", identity: "payer_kpi" },
                         { file: "dashboards/appeals_analytics.json", identity: "appeals_analytics" },
                         { file: "dashboards/pa_ops.json", identity: "pa_ops" } ]
  case_schemas:        [ { file: "cases/prior_auth_review.yaml", identity: "pa_review" },
                         { file: "cases/appeal_analysis.yaml", identity: "appeal_analysis" },
                         { file: "cases/denial_rationale_review.yaml", identity: "denial_review" } ]
  role_catalog:        [ { file: "rbac/roles.yaml" } ]
  eval_sets:           [ { file: "evals/pa_golden.jsonl", identity: "pa_golden" },
                         { file: "evals/appeal_golden.jsonl", identity: "appeal_golden" },
                         { file: "evals/denial_rationale_golden.jsonl", identity: "denial_golden" } ]
  guardrails:          [ { file: "guardrails/hipaa.rego", identity: "hipaa" },
                         { file: "guardrails/cms_2024_human_review.rego", identity: "cms_2024_hitl" },
                         { file: "guardrails/naic_ai_disclosure.rego", identity: "naic_disclosure" } ]
  pipeline_templates:  [ { file: "pipelines/nightly_label_export.yaml", identity: "label_export" },
                         { file: "pipelines/quarterly_distill_pa.yaml", identity: "distill_pa" } ]
  model_archetypes:    [ { file: "models/pa_confidence_calibrator.yaml", identity: "pa_confidence" } ]
  agent_recipes:       [ { file: "agents/prior_auth.yaml", identity: "prior_auth" },
                         { file: "agents/appeal_analyst.yaml", identity: "appeal_analyst" },
                         { file: "agents/denial_rationale.yaml", identity: "denial_rationale" } ]
  connection_templates:[ { file: "sources/facets_v6.yaml", identity: "facets_v6" },
                         { file: "sources/healthedge.yaml", identity: "healthedge" },
                         { file: "sources/guidewire_gx.yaml", identity: "guidewire_gx" },
                         { file: "sources/qnxt.yaml", identity: "qnxt" },
                         { file: "sources/epic_fhir_r4.yaml", identity: "epic_fhir_r4" },
                         { file: "sources/edi_837_835.yaml", identity: "edi_837_835" },
                         { file: "sources/edi_278.yaml", identity: "edi_278" } ]
  display_labels:      [ { file: "labels/en.yaml", identity: "en" } ]
```

### Ontology (US-Payer domain)

- **INS-FR-010 (Must)** The ontology defines the following entities with the shipped attributes; each is bound to a canonical dataset in the customer's warehouse via dataset-service or streamed via a connector.

| Entity | Key attributes (subset) | Bound to |
|---|---|---|
| `Member` | member_id, plan_id, dob, gender, effective_date, term_date, coverage_tier, pcp_id | Facets Member / EDI 271 |
| `Provider` | npi, tin, specialty, network_status, credential_status | Facets Provider / EDI 271 |
| `Plan` | plan_id, plan_year, product_type (HMO/PPO/EPO/POS/Medicare_Advantage/Medicaid), sob_ref | Plan config |
| `Claim` | claim_id, member_id, provider_id, service_dates, place_of_service, cpt_codes[], icd10_codes[], billed_amount, allowed_amount, paid_amount, status (open/adjudicated/denied/appealed) | EDI 837 / core admin |
| `PriorAuthRequest` | par_id, member_id, provider_id, requested_service, cpt_codes[], icd10_codes[], urgency (standard/urgent/expedited), submitted_at, status (pending/approved/denied/deferred) | EDI 278 / core admin |
| `Authorization` | auth_id, par_id, approved_service_span, quantity, effective_span, conditions | Core admin |
| `Denial` | denial_id, claim_id or par_id, denial_reason_code, denial_reason_text, decision_by (human/ai_assisted), decision_at | Core admin + Windrose |
| `Appeal` | appeal_id, denial_id, level (1/2/external), submitted_by (member/provider), submitted_at, status (pending/upheld/overturned/withdrawn), verdict_by, verdict_at | Core admin + Windrose |
| `ClinicalGuideline` | guideline_id, source (interqual/mcg/plan_policy/cms_ncd/lcd), version, section_ref, text | Guideline vendor + payer policy library |
| `MemberCommunication` | comm_id, member_id, kind (denial_notice/appeal_response/eob), sent_at, delivery, content_ref | Correspondence system |

- **INS-FR-011 (Must)** Every entity's `provenance` field carries the source system + last-sync timestamp; PHI-bearing fields (member_id → linked to name/dob/address in the connector) are tagged in the ontology with `phi: true` so guardrails (INS-FR-050) enforce redaction/masking on egress to any hosted LLM.

### Semantic model — payer KPI catalog

- **INS-FR-020 (Must)** Shipped semantic model `claims` defines the following measures (per semantic-service SEM-FR-004); all are governed by the DS and referenced by dashboards and agent tools.

| Measure | Definition | Source |
|---|---|---|
| `denial_rate` | `count(denial) / count(claim)` — window: rolling 30d | Claim, Denial |
| `denial_rate_pa` | `count(pa_denial) / count(pa_request)` — 30d | PriorAuthRequest, Denial |
| `appeal_overturn_rate` | `count(appeal.status='overturned') / count(appeal)` — 90d | Appeal |
| `pa_turnaround_p50` / `p95` | percentiles over `Authorization.decision_at - PriorAuthRequest.submitted_at` — standard / urgent broken out per CMS-4201-F | PriorAuthRequest, Authorization |
| `first_pass_yield` | `count(claim.status='paid_on_first_pass') / count(claim)` | Claim |
| `cost_per_decision` | join to `usage_decisions` (BRD 17 §USG-FR-080) filtered by `decision_kind='case'` and case → agent | usage-service |
| `reviewer_avg_time_per_case` | `case.resolved_at - case.assigned_at` grouped by role | case-service |
| `agent_agreement_rate` | shadow-mode: `count(agent_verdict = human_verdict) / count(shadow_predictions)` | eval-service + case-service |
| `denial_reason_top_n` | top-N denial reason codes by count — 30d, groupable by CPT/DRG | Denial |
| `over_denied_procedure_score` | for each CPT, `(count(overturned_appeals) / count(denials))` — flags procedures being wrongly denied at scale | Claim, Denial, Appeal |

- **INS-FR-021 (Must)** Dimensions include: `plan_year`, `product_type`, `network_status`, `service_line` (mapped from CPT), `place_of_service`, `provider_specialty`, `member_state`, `urgency_tier`, `denial_reason_code`, `reviewer_role`, `agent_id`, `agent_version`.

### Agent 1 — Prior-Auth Agent

- **INS-FR-030 (Must)** `agents/prior_auth.yaml` recipe: LangGraph state machine `intake → policy_lookup → clinical_guideline_match → prior_history_lookup → decision_recommendation → reflection → propose`. Mode: **proposal-only** (agent-runtime `mode: proposal` — cannot bypass to autonomous per BRD 23 §BR-12).
- **INS-FR-031 (Must)** MCP tools consumed (all read-only unless noted): `member.get(member_id)`, `plan.get_summary_of_benefits(member_id, plan_id, cpt_code)`, `authorization.list_for_member(member_id, window)`, `clinical_guideline.match(cpt_code, icd10_codes, member_context)`, `claim.history(member_id, window)`, `semantic.compile_metric_sql` (for aggregate priors). **Write tool (proposal-mode only):** `authorization.propose(par_id, verdict, rationale, cited_guidelines[], confidence)` — creates a `pa_review` case with a `Proposal` for the reviewer.
- **INS-FR-032 (Must)** Confidence calibration: the agent's `confidence` field is passed through the shipped calibrator model (INS-FR-071) that returns a probability aligned with historical human-agreement rates. Below tenant-configured `auto_approve_threshold` (default 0.92 for approvals, agent never auto-denies), the case surfaces with the recommendation as advisory; above threshold + `auto_approve_enabled` policy on, the case is created in `pending_one_click_approve` state where the reviewer sees a pre-checked "Approve as recommended" that they can submit or override in one click.
- **INS-FR-033 (Must)** Cost/latency budget: request class `sql-gen`+`chat` under ai-gateway workflow cap `chat: 12 calls / 25K in-tokens / 2 reflections` (tighter than platform default per BRD 12 §AIG-FR-088) — tuned for standard PA which shouldn't require deep chains of thought.
- **INS-FR-034 (Must)** Shadow mode: tenant-level toggle `agents.prior_auth.mode: shadow | proposal | disabled`. In `shadow`, the agent runs on real PA requests, writes predictions to `agent_shadow_predictions`, and joins them to the human verdict on resolution — used to compute `agent_agreement_rate` before promotion.
- **INS-FR-035 (Should)** Explainability contract: every proposal payload carries `citations[]` with `{guideline_id, section_ref, text_excerpt, url}` — enforced schema-validated at the proposal boundary; empty citations → 422 reject at case-service.

### Agent 2 — Appeal Analyst Agent

- **INS-FR-040 (Must)** `agents/appeal_analyst.yaml` recipe: `intake → denial_context_lookup → policy_lookup → clinical_evidence_search → similar_overturns_rag → argument_generation → reflection → propose`. Mode: **proposal-only**.
- **INS-FR-041 (Must)** MCP tools: all Agent 1 tools plus: `denial.get(denial_id)`, `appeal.history(member_id or provider_id)`, `similar_overturns.search(nl_query, top_k)` (pgvector-backed RAG over the payer's own governed label store — resolved appeals with verdict), `medical_literature.search(nl_query)` (optional — payer's licensed corpus e.g., UpToDate). Write tool: `appeal.propose_analysis(appeal_id, verdict_recommendation, rationale, arguments[], citations[], confidence)`.
- **INS-FR-042 (Must)** Grounding rule: at least one citation from **plan policy** OR **clinical guideline** (INS-FR-031 tools) is REQUIRED on the packet; agent-runtime validates the tool-call trace at proposal-boundary and rejects packets missing grounding (422 `INS_UNGROUNDED_APPEAL`).
- **INS-FR-043 (Must)** Similar-overturns retrieval is strictly workspace-scoped (tenant's own overturns only); no cross-tenant RAG. HIPAA-preserving: retrieved cases are de-identified (member/provider tokens redacted) before entering the prompt.
- **INS-FR-044 (Must)** Cost budget: `chat: 30 calls / 60K in-tokens / 3 reflections` (looser than PA — appeals are lower volume and higher stakes). Deterministic-first pre-router (BRD 12 §AIG-FR-080) checks `similar_overturns` first; a strong hit (≥ 0.97 cosine) skips full argument generation and offers the prior overturn as the primary argument, reducing cost to the retrieval + rewrite cost only.
- **INS-FR-045 (Should)** Output is a structured `AppealPacket` (JSON) with sections: `denial_summary`, `member_context`, `policy_analysis`, `clinical_analysis`, `argument_hierarchy` (strongest first), `recommended_verdict`, `confidence`, `alternate_verdicts_considered`.

### Agent 3 — Denial-Rationale Agent

- **INS-FR-050 (Must)** `agents/denial_rationale.yaml` recipe: `intake_denial_decision → policy_lookup → guideline_lookup → member_language_check → rationale_draft → reflection → propose`. **NEVER decides denial** — always accepts a denial decision already made by the payer's rules engine or a human reviewer as input. The agent's job is producing the compliant human-readable rationale + member letter.
- **INS-FR-051 (Must)** MCP tools: `denial.get(denial_id)` (input includes `deciding_actor: rules_engine|human|other_ai`), `plan.get_denial_policy(reason_code)`, `clinical_guideline.get(guideline_id)`, `member.get_preferred_language(member_id)`, `member.get_reading_level(member_id)` (optional; defaults to grade 8 per CMS best-practice). Write tool (proposal-mode): `denial.propose_rationale(denial_id, member_letter_draft, internal_note_draft, cited_policy[], cited_guidelines[], appeal_rights_disclosure)`.
- **INS-FR-052 (Must)** Regulatory template compliance: the member letter template MUST include: specific reason for denial (in the member's preferred language, at CMS-recommended reading level), citations to plan-policy sections, appeal-rights disclosure with deadlines (state-specific), and (for Medicare Advantage) the CMS-standard MA denial notice format. Templates ship as guardrail-enforced structure — if the drafted letter is missing any required section, agent-runtime rejects it 422 `INS_INCOMPLETE_DENIAL_NOTICE`.
- **INS-FR-053 (Must)** Never adds *new* denial reasons; the reason code is fixed input. Drift-detection: if the agent's rationale references a policy/guideline that doesn't match the reason code's mapping, the proposal is flagged for MD review before member send.
- **INS-FR-054 (Should)** Cost budget: `chat: 8 calls / 20K in-tokens / 1 reflection`. Denial-rationale is high-volume, low-variance — SLM tier handles > 90% after distillation.

### Connectors & write adapters

- **INS-FR-060 (Must)** Read connectors — each is a `connection_template` (BRD 04 dataset-service consumes; ingestion-service materializes). Named datasets appear pre-registered in the workspace on install:

| Connector | Read scope | Sync mode |
|---|---|---|
| `facets_v6` | Facets Member, Provider, Claim, Auth, Correspondence (via Cognizant REST + JDBC) | CDC via Facets outbound + nightly full-refresh |
| `healthedge` | HealthEdge HealthRules Payor (REST) — Member, Claim, PriorAuth | CDC |
| `guidewire_gx` | Guidewire ClaimCenter GX Model REST — Claim, Coverage, Party, Note | CDC |
| `qnxt` | TriZetto QNXT (JDBC) — Member, Claim, Auth | Nightly |
| `epic_fhir_r4` | Epic FHIR R4 — Patient, Encounter, Observation, DocumentReference, Coverage | On-demand + subscription |
| `edi_837_835` | S/FTP or clearinghouse (Change/Optum/Availity) — 837 claim, 835 remittance | Event-driven |
| `edi_278` | S/FTP or clearinghouse — 278 prior-auth request/response | Event-driven |

- **INS-FR-061 (Must)** Write adapters (proposal-mode only; never called before a human approval in case-service):

| Adapter | Writes to |
|---|---|
| `facets_pa_decision.write` | POST to Facets auth-decision API |
| `guidewire_appeal_note.write` | POST to Guidewire ClaimCenter Note |
| `facets_denial_member_letter.write` | POST to Facets correspondence subsystem |
| `healthedge_pa_decision.write` | POST to HealthEdge PA API |
| `outbound_edi_278_response.write` | Post EDI 278 response to clearinghouse |
| `outbound_edi_835_supplemental_note.write` | Attach denial reason to 835 remittance |

- **INS-FR-062 (Must)** Adapter idempotency: every write carries `Idempotency-Key: <case_id>:<proposal_id>` per BRD 23 §PKG-FR-031; retries never double-submit to the customer's SoR.

### KPI dashboards

- **INS-FR-070 (Must)** Three shipped dashboards, each pre-wired to the semantic model measures:
  - **Payer KPI** — top-line denial rate, appeal overturn rate, PA turnaround, first-pass yield, cost per decision; 90-day trend and drill-down.
  - **Appeals Analytics** — appeal volume by level, overturn rate by denial reason, over-denied procedure heatmap, reviewer-throughput view (uses `usage_decisions` join per BRD 17 §USG-FR-080).
  - **PA Ops** — live PA queue depth by urgency tier, per-nurse throughput, agent-shadow agreement rate, SLA breach risk (CMS 7-day standard / 72-hr urgent).
- **INS-FR-071 (Should)** Ships one model archetype (`pa_confidence_calibrator.yaml`) — a Platt-scaling calibrator on top of the PA agent's raw confidence, retrainable from `usage_decisions` + verdicts nightly via `pipelines/quarterly_distill_pa.yaml`.

### Regulatory guardrails

- **INS-FR-080 (Must)** `guardrails/hipaa.rego` — every agent tool call and every LLM prompt passes through PHI-scoped guardrails: (a) all `phi:true` ontology fields are masked at the ai-gateway boundary (BRD 12 §AIG-FR-050 Presidio + custom HIPAA identifier detectors: SSN, MRN, member_id, DOB, address, phone); (b) LLM egress logs never carry unmasked PHI (verified in the audit sample); (c) memory-service entries derived from cases carry the masked-only versions.
- **INS-FR-081 (Must)** `guardrails/cms_2024_human_review.rego` — CMS Advance-Notice + MA rule (2024) requires a qualified human to review AI-assisted adverse determinations. Enforcement: every `denial.*.write` adapter call must be preceded by a case-service resolution where `resolver_role ∈ {md_reviewer, appeal_analyst}` and `resolver_id ≠ agent_principal`. Adapter middleware verifies this on every write; failure → 403 `INS_CMS_HUMAN_REVIEW_REQUIRED` and the write is refused.
- **INS-FR-082 (Must)** `guardrails/naic_ai_disclosure.rego` — NAIC Model Bulletin transparency: (a) any member-facing artifact produced with AI assistance carries the pack-configured disclosure text (integrates with UI-FR-031 AI label + UI-FR-032 provenance badge); (b) internal-facing artifacts carry the `provenance` chain; (c) tenant admin can export a per-jurisdiction disclosure report on demand.
- **INS-FR-083 (Should)** EU AI Act Annex III (insurance = high-risk system) documentation kit: the pack ships a `docs/eu_ai_act/` folder covering the Article 11 technical documentation, Article 13 transparency requirements, and Article 14 human oversight design — pre-filled with Windrose Core's controls + this pack's specifics. Deployable in EU cells for insurers with EU exposure.

### Roles & case schemas

- **INS-FR-090 (Must)** `rbac/roles.yaml` — seeds these roles (materialized via BRD 02 rbac-service): `pa_nurse`, `pa_md`, `appeals_analyst`, `appeals_supervisor`, `payment_integrity_analyst`, `medical_director`, `compliance_officer`, `member_services`. Each role's grants align with the case schemas below and the ai-gateway `max_rung` policy (e.g., MDs get access to escalation to frontier tier; nurses do not).
- **INS-FR-091 (Must)** Case schemas (materialized via BRD 08 case-service):
  - **`pa_review`** — fields: par_id (URN), agent_confidence, agent_recommendation, agent_citations[], sla_deadline (from urgency), assigned_reviewer, verdict, verdict_reason, verdict_at. Statuses: `pending → in_review → decided`. `value_usd` set from claim's `allowed_amount` for ROI panel.
  - **`appeal_analysis`** — fields: appeal_id, denial_id, packet_ref (draft), agent_verdict_recommendation, agent_confidence, sla_deadline (state-specific), assigned_analyst, final_verdict, edit_diff, resolved_at. `value_usd` = potential paid claim value on overturn.
  - **`denial_review`** — fields: denial_id, member_letter_draft, internal_note_draft, cited_policy[], preferred_language, reading_level, reviewer_edits, approved_at.

### KPI + reporting deliverables (compliance-facing)

- **INS-FR-100 (Must)** `pipelines/nightly_label_export.yaml` — Argo workflow that nightly emits governed labels (case resolutions + agent predictions + human verdicts) to the tenant's label store (BRD 17 `usage_decisions` join + case-service resolutions) — feeds the distillation flywheel (BRD 12 §AIG-FR-085).
- **INS-FR-101 (Must)** `pipelines/quarterly_distill_pa.yaml` — Argo workflow that retrieves a sanitized training set from the ai-gateway distillation-candidates endpoint (BRD 12 §AIG-FR-085) filtered to `agent_id: prior_auth`, fine-tunes an SLM (7B or 13B), runs the shipped `pa_golden` eval set, and — if acceptance passes — registers a new `self_hosted` deployment for promotion into the PA agent's ladder rung 0.
- **INS-FR-102 (Must)** One-click regulator audit bundle: `POST /packs/insurance-claims-payer/audit_bundle?from=&to=&jurisdiction=` (workspace-admin, invoked via UI at `/admin/audit`) returns a signed archive containing: all decisions in-range with model versions, cited guidelines, reviewer identities, `install_events_ledger` entries, guardrail-policy versions in effect, eval-set results, and a per-agent card summary. Delivery via signed S3/Azure/GCS URL, expiring in 7 days.

## 4. Domain model & data

The pack **does not create tables** in the platform — it materializes rows into the platform services (semantic-service, chart-service, case-service, rbac-service, eval-service, guardrail-service, ingestion-service, agent-runtime, memory-service, tool-registry) via the pack-service materialization contract (BRD 23 §PKG-FR-030). The tables of concern are:

| Where | What appears on install |
|---|---|
| **semantic-service** | model `claims` v1 + measure/dimension rows per INS-FR-020..021; model `utilization` v1; verified queries for the top-20 canonical questions (see Appendix) |
| **chart-service** | 3 dashboards (INS-FR-070) with ~40 charts wired to compile-through-semantic (BRD 07) |
| **case-service** | 3 case schemas (INS-FR-091) with fields, statuses, SLA policies |
| **rbac-service** | 8 role seeds (INS-FR-090) + permission bindings |
| **eval-service** | 3 golden eval sets (INS-FR-020 shipped list) with acceptance thresholds |
| **guardrail-service** | 3 OPA policies (INS-FR-080..082) |
| **pipeline-orchestrator** | 2 workflow templates (INS-FR-100..101) |
| **experiment-service** | 1 model archetype seed (INS-FR-071) |
| **agent-runtime** | 3 agent recipes (INS-FR-030..050) registered proposal-mode |
| **ingestion-service** | 7 connection templates (INS-FR-060) staged (credentials filled at install) |
| **tool-registry** | ~25 MCP tool registrations (member/provider/plan/claim/denial/appeal/authorization/guideline) |
| **memory-service** | Workspace-scoped memory bucket for similar-overturns RAG (with PHI masking policy attached) |
| **bff-graphql** | Pack's `display_labels` entries (INS-FR-110 below) merged into the workspace label map |

### 4.1 Display labels (INS-FR-110)

The pack overrides platform defaults with payer-domain vocabulary. Selected keys shipped:

```yaml
locale: en
keys:
  case.singular:       "Case"                # unchanged for PA/appeal/denial cases
  pa_review.singular:  "Prior Auth"
  pa_review.plural:    "Prior Auths"
  pa_review.action.approve: "Approve as recommended"
  appeal_analysis.singular: "Appeal"
  appeal_analysis.action.uphold: "Uphold denial"
  appeal_analysis.action.overturn: "Overturn — approve claim"
  denial_review.singular: "Denial notice"
  agent.prior_auth.name: "PA Copilot"
  agent.appeal_analyst.name: "Appeal Analyst"
  agent.denial_rationale.name: "Denial Notice Drafter"
  cost.not_tracked: "Cost not attributed"
entity_templates:
  case: "{kind_singular} #{short_id}"
  claim: "Claim #{claim_id}"
  member: "Member {member_id_last4}"      # PHI-safe display — never full member_id in default mode
```

### 4.2 State machines

- **PA review case:** `pending → in_review → decided (approved | denied | deferred | canceled)`. Guards: `decided` requires assigned reviewer with `pa_nurse` or `pa_md` role.
- **Appeal analysis case:** `pending → in_review → decided (upheld | overturned | withdrawn | escalated)`. Escalation `level 1 → level 2 → external` follows CMS + state regs; SLA per state config.
- **Denial notice case:** `pending → mds_review (if drift-flagged) → approved → sent`. `sent` triggers write-adapter and freezes the letter for audit.

## 5. Pack manifest specification

See §3 INS-FR-001 for the top-level manifest. Cross-referenced artifacts live under the pack's OCI tar:

```
insurance-claims-payer-1.0.0.tar
├── pack.yaml
├── ontology/payer.yaml
├── semantic/{claims,utilization}.yaml
├── dashboards/{payer_kpi,appeals_analytics,pa_ops}.json
├── cases/{prior_auth_review,appeal_analysis,denial_rationale_review}.yaml
├── rbac/roles.yaml
├── evals/{pa_golden,appeal_golden,denial_rationale_golden}.jsonl
├── guardrails/{hipaa,cms_2024_human_review,naic_ai_disclosure}.rego
├── pipelines/{nightly_label_export,quarterly_distill_pa}.yaml
├── models/pa_confidence_calibrator.yaml
├── agents/{prior_auth,appeal_analyst,denial_rationale}.yaml
├── sources/{facets_v6,healthedge,guidewire_gx,qnxt,epic_fhir_r4,edi_837_835,edi_278}.yaml
├── labels/en.yaml
├── docs/eu_ai_act/{art11,art13,art14}.md
└── SIGNATURES/     # cosign detached signatures + SLSA provenance
```

## 6. Events

- **Emitted (via installed components — no new topics):** `case.created / case.resolved` on `case.events.v1` per case schema; `ai.token_usage.v1` per agent call with `decision_urn = case.urn` (satisfying BRD 17 §USG-FR-080); `pack.install_completed` on install (BRD 23).
- **Consumed:** `dataset.schema_changed` on connector-owned datasets — pack surfaces broken references in `pack_installs.health` (BRD 23 §PKG-FR-070).

## 7. Business rules & edge cases

- **BR-1** No agent in this pack, at any version, may execute an autonomous denial decision. Denials are made by (a) the customer's existing rules engine, or (b) a qualified human reviewer. The Denial-Rationale Agent produces paperwork for a decision already made. Attempting to configure an agent recipe with `mode: autonomous` on a `denial.*` write tool fails pack install with `INS_AUTONOMOUS_DENIAL_FORBIDDEN` — a hard release gate.
- **BR-2** Every PA/appeal/denial proposal MUST carry at least one policy or guideline citation; unsourced proposals are rejected at case-service ingest per INS-FR-042 (`INS_UNGROUNDED_APPEAL`) and INS-FR-053 (drift check on rationale).
- **BR-3** Shadow mode → proposal mode promotion requires eval-service acceptance on the shipped golden set + a tenant-configured minimum shadow agreement rate (default 85%) sustained for ≥ 30 days. Skipping the promotion gate requires a documented CMO waiver (audited).
- **BR-4** PHI redaction is enforced at the ai-gateway boundary; any agent recipe attempting a raw-PHI egress to a hosted LLM (via a `raw_phi_egress: true` flag) fails install (`INS_PHI_EGRESS_FORBIDDEN`). Self-hosted SLM tier is exempt from redaction only when the tenant's HIPAA config explicitly permits it (`hipaa.self_hosted_phi_allowed: true`) — audited quarterly.
- **BR-5** Multi-plan-year support: a member with claims across 2025 and 2026 plans has each claim scored against the plan year in effect on the service date. The ontology's `PriorAuthRequest → Plan` binding uses service-date resolution; the semantic model exposes `plan_year` as a mandatory dimension on utilization measures.
- **BR-6** Similar-overturns RAG (INS-FR-041) is workspace-scoped ONLY. Cross-tenant retrieval, even from the same publisher, is forbidden by the memory-service tenant partition and enforced by the guardrail policy.
- **BR-7** CMS-4201-F PA SLAs (7-day standard, 72-hour urgent effective 2026-01-01, potentially compressed further in later rules) are enforced as case-service SLA policies in `pa_review`; SLA-breach risk is a first-class dashboard signal.
- **BR-8** State-specific appeal escalation timelines (varies by state — NY 30 days, CA 30 days, TX 30 days, Medicare 60 days internal + 60 external) ship in `cases/appeal_analysis.yaml` as an SLA policy table keyed by member state.
- **BR-9** Coordination of benefits (COB): claims with multiple payers require COB resolution before adjudication. This pack v1 does NOT ship a COB agent; instead, `Claim.status='cob_pending'` is a hard-block state that removes the claim from PA/appeal agent queues. COB agent lands in v2.
- **BR-10** Duals (Medicare + Medicaid) require dual-plan rule evaluation; v1 requires the customer's rules engine to have already flagged duality on the claim. Agent recipes read `member.plan.duals: true` and skip PA auto-recommendation for duals in v1 (safety-first).
- **BR-11** Pack upgrade preserves reviewers' custom worklist filters and the tenant's `auto_approve_threshold` setting; upgrading the model archetype does not overwrite tenant-tuned calibration parameters (BRD 23 §PKG-FR-023 field-scoped edit protection).
- **BR-12** Audit bundle export (INS-FR-102) redacts PHI in the "external regulator" variant and preserves PHI in the "internal compliance" variant (parameter `redact_phi: true|false`); redaction is deterministic + tested.

## 8. Dependencies

- **Windrose services:** all core services + BRD 23 pack-service (installer), BRD 12 ai-gateway (agent LLM calls), BRD 14 agent-runtime (recipes), BRD 08 case-service (review queues), BRD 06 semantic-service (measures), BRD 07 chart-service (dashboards), BRD 17 usage-service (ROI panels), BRD 16 eval-service (golden sets + agent promotion gate), BRD 15 memory-service (similar-overturns RAG), BRD 13 tool-plane (MCP), BRD 02 rbac-service (role seeds), BRD 20 realtime-hub (case updates), BRD 21 bff-graphql (dashboard queries + display labels), BRD 22 ui-web (case triage screens).
- **External systems (customer's):** Facets / HealthEdge / QNXT / Guidewire / core admin of record; EDI clearinghouse (Change/Optum/Availity); Epic/Cerner FHIR endpoint; guideline vendor (InterQual, MCG); optional: UpToDate / DynaMed license; customer's data warehouse (Snowflake / Databricks / BigQuery / Iceberg).
- **Regulatory + legal:** Windrose ships template Business Associate Agreement (BAA) and Data Processing Agreement (DPA); HITRUST CSF certification (Windrose Core, inherited); SOC 2 Type II (Windrose Core, inherited); pack-specific docs for CMS PA rule and NAIC bulletin filing (informational, not filing-service).

## 9. NFRs (deltas from master)

| Metric | Target |
|---|---|
| Prior-auth agent p95 latency (per proposal) | ≤ 15s (deterministic-first hit) / ≤ 60s (full LLM chain) |
| Appeal analyst p95 latency (per packet) | ≤ 3 min |
| Denial-rationale p95 latency | ≤ 20s |
| Agent shadow-mode agreement rate (post-install, week 8+) | ≥ 85% before proposal-mode toggle allowed |
| Cost per PA decision (post-distillation, month 12+) | ≤ $0.05 (est.) — target confirmed against tenant's own cost telemetry |
| Cost per appeal packet (month 12+) | ≤ $0.50 (est.) |
| CMS PA SLA compliance | ≥ 99% within 7-day standard / 72-hr urgent windows |
| PHI-leak incidents (unmasked PHI in LLM prompt) | 0 (release gate; audited quarterly via prompt-log sampling) |
| Audit bundle generation (INS-FR-102) | p95 ≤ 5 min for a 30-day window |
| Time to first live decision post-install | ≤ 30 days from `pack.install_completed` |

## 10. Acceptance criteria

- **AC-1** Given a fresh install of `insurance-claims-payer@1.0.0` into a workspace on an AWS cell, When the install completes, Then all components in §5 materialize successfully (BRD 23 §PKG-FR-021), the three dashboards render with 0 charts errored (measures are declared but not yet computed against real data), the three agents register in `mode: shadow`, and `pack.install_completed` carries `materialized_count=42+` (exact number per shipped inventory).
- **AC-2** Given the `facets_v6` connector configured with production credentials, When the first CDC batch lands, Then the `Claim`, `Member`, and `Provider` ontology entities populate in the datasets, `denial_rate` measure returns a non-null value within 24h, and the Payer KPI dashboard renders live numbers.
- **AC-3** Given the PA agent in shadow mode for 30 days, When the CMO checks `agent_agreement_rate`, Then the value is ≥ 85% on standard PAs (measured against human verdicts) and the shipped `pa_golden` eval set passes with ≥ 90% accuracy; failing either metric blocks the promotion to `proposal` mode via a hard tenant-policy gate.
- **AC-4** Given a PA proposal from Agent 1 with confidence 0.95 and `auto_approve_enabled: true`, When the case surfaces to a PA nurse, Then the "Approve as recommended" CTA is pre-checked; When the nurse clicks it, Then the write adapter `facets_pa_decision.write` executes and Facets receives the decision with `Idempotency-Key: <case_id>:<proposal_id>` — verified in the Facets audit log.
- **AC-5** Given an appeal for a denied MRI where the payer's prior overturned appeals contain a strong similarity match (≥ 0.97 cosine), When the Appeal Analyst Agent runs, Then the deterministic-first path is taken (per INS-FR-044 + BRD 12 §AIG-FR-080), the packet cites the prior overturn as the strongest argument, cost per decision is < $0.05, and the reviewer resolves in ≤ 5 min.
- **AC-6** Given a denial-rationale proposal missing the appeal-rights disclosure section, When submitted to the agent-runtime proposal boundary, Then it is rejected 422 `INS_INCOMPLETE_DENIAL_NOTICE` and the agent retries at the next rung; a persistently non-compliant draft after retries fails the run and pages the compliance officer.
- **AC-7** Given an agent recipe attempting configuration with `mode: autonomous` on a `denial.*.write` tool, When the pack version is submitted for publish, Then publish fails `INS_AUTONOMOUS_DENIAL_FORBIDDEN` naming the offending recipe (BR-1 hard gate).
- **AC-8** Given a member with claim PHI in a PA request, When the PA agent constructs the prompt, Then Presidio + HIPAA-custom detectors mask member_id, DOB, address, and phone before the prompt reaches any hosted LLM; a golden test asserts that the deployed LLM provider's logged prompt contains zero unmasked identifiers (verified in the release audit).
- **AC-9** Given the CCO invokes the audit bundle for 2026-01-01..2026-01-31 with `redact_phi: true`, When generated, Then a signed archive returns within 5 min containing: every AI-touched decision, model versions, guardrail versions, human reviewer identities, cited guidelines, and reviewer edits; PHI fields are replaced with typed placeholders; a second run with `redact_phi: false` (internal compliance) returns PHI intact for tenant-internal use.
- **AC-10** Given `pack.uninstall_completed` in `soft` mode, When executed, Then all pack-origin objects still tagged `origin: pack:` and `edited_since_install=false` are removed (dashboards, unmodified case schemas, unmodified role seeds), tenant-tuned `auto_approve_threshold` and any reviewer-created custom worklists are preserved with `orphaned_from_pack=true`, and the Facets/Guidewire connectors continue to sync (they carry customer credentials — pack owned the template, not the live secrets).
- **AC-11** Given the quarterly distillation pipeline runs on 3 months of resolved PA cases, When completes, Then a new self-hosted SLM deployment is registered, evaluated against `pa_golden`, and promoted to rung 0 of the PA agent's ladder if acceptance thresholds pass; the promotion emits `cascade.rung_shifted` (BRD 12 §AIG-FR-082) with `reason: distillation_promoted`.
- **AC-12** Given the Payer KPI dashboard is rendered, When any chart displays a KPI value, Then a `<DecisionFooter>` (UI-FR-076) shows model + provenance + cost per decision aggregated from `usage_decisions` (BRD 17 §USG-FR-080), and clicking through drills to the individual decisions.
- **AC-13** Given a tenant configures `agents.denial_rationale.mode: proposal`, When a denial rationale draft is proposed and the human reviewer approves, Then the write adapter fires the member letter to Facets; the `install_events_ledger` captures the reviewer identity, timestamp, and cited policies; the CMS-4201-F human-review guard (INS-FR-081) enforces that the reviewer's role is in `{md_reviewer, appeals_analyst}`.
- **AC-14** Given SAS release-gate (BRD 22 §UI-FR-090..092) run on a workspace with this pack installed, When `sas-b-first-case` runs, Then the new tenant admin resolves their first PA case in ≤ 5 minutes with no documentation opened; failing this gate blocks the pack release.
- **AC-15** Given the tenant's cell is Azure and the pack advertises `clouds: [aws, azure, gcp]`, When installed, Then all connector templates resolve to the Azure variants (`sources/facets_v6.azure.yaml` if such a variant exists; otherwise cloud-neutral); when the pack later drops Azure support, the installed version continues to function but upgrades are refused with `INCOMPATIBLE_CLOUD` (BRD 23 §BR-10).

## 11. Out of scope / future

- Autonomous denial decisioning (permanent — pack policy per BR-1, not a future scope).
- FWA (fraud/waste/abuse) SIU agent — future pack `insurance-payer-fwa`.
- Coordination-of-benefits agent — v2.
- Coding audit / DRG validator — v2.
- Provider-side RCM (denial-management-for-providers) — separate pack `insurance-claims-provider`.
- PBM utilization management workflows — separate pack `pbm-utilization`.
- Non-US healthcare (EU sickness funds, UK NHS ICBs, IN Ayushman Bharat) — jurisdiction-specific packs.
- Real-time member chat via the AI copilot for benefits questions — a `member-services` pack.
- Natural-language plan-policy authoring — a benefits-configuration pack (long-term).
- Integration with claims-editing vendors (Cotiviti, ClaimsXten) beyond read — v2 partnership-dependent.

## Appendix — canonical NL questions (shipped as verified queries in semantic-service)

The pack seeds the following verified queries (BRD 06 §SEM-FR-040) to accelerate the analyst copilot:

1. "What's our denial rate over the last 30 days by product type?"
2. "Which procedure codes have the highest appeal overturn rate this quarter?"
3. "How many PAs did we auto-approve this week, and what was the reviewer override rate?"
4. "Show me PA turnaround by urgency tier compared against CMS 7-day / 72-hour SLA."
5. "Which providers have the highest denial rate on E/M codes this month?"
6. "Cost per PA decision this quarter, broken down by (nurse-approved, MD-escalated, agent-auto-approved)."
7. "Appeals pending resolution past state SLA — grouped by member state and level."
8. "Top-10 denial reason codes by count over the last 90 days."
9. "Members with 3+ denied claims in 30 days — for member-outreach targeting."
10. "MD reviewer workload by day of week — for staffing planning."

(Full list of 20 in `semantic/claims.verified_queries.yaml` shipped with the pack.)
