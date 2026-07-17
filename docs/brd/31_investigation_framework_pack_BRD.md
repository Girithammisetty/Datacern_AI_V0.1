# BRD 31 — `investigation-framework` capability pack (LIBRARY pack)

**Deliverable type:** Capability Pack (BRD 23) · **Publisher:** Windrose · **Initial version:** 1.0.0
**Pack class:** **LIBRARY** — reusable investigation primitives consumed by vertical packs via `depends_on`. **This pack ships zero user-facing value on its own.** Installing it into a workspace without a consuming vertical pack produces a warning and no visible surface.
**Horizon:** 2 (ships alongside BRDs 27 + 30 as their shared base; retrofitted into any future investigation-heavy pack).
**Inherits:** `00_MASTER_BRD.md`, `23_pack_service_BRD.md` (uses `depends_on` mechanism per §PKG-FR-001..007).
**Consumed by:** BRD 27 `payer-fwa-siu`, BRD 30 `banking-aml`, future BRD `banking-fraud`, future `capital-markets-mar`, future `cybersecurity-incident-response`.

---

## 1. Overview

**Purpose.** `investigation-framework` is Windrose's **first library pack** — a signed, versioned bundle of reusable investigation primitives that vertical packs specialize. It ships the canonical 3-specialist agent pattern (Pattern Detector → Network Graph Investigator → Risk Scorer), the graph-navigation and chain-of-custody MCP tool set, shared case schemas for the investigate-plan-validate-execute lifecycle, and the guardrails that every investigation-heavy vertical needs (chain-of-custody, tipping-off-lite, evidence provenance, two-signature referral). Vertical packs (payer FWA, banking AML, banking fraud, capital-markets surveillance, cybersecurity IR, quality investigations) plug their typology-specific rules, models, and vocabulary into these abstract components — never rewriting the primitives themselves.

**Why this exists.** Before this pack, BRD 27 (payer FWA) and BRD 30 (banking AML) each independently defined a "case builder + evidence gatherer + risk scorer" pattern with roughly-similar but subtly-different implementations. Future verticals would repeat the pattern again. That's not the pack thesis — that's copy-paste with veneer. Extracting the shared primitives into a library pack:

1. **Proves the pack model works for composition** — packs depending on packs (BRD 23 §PKG-FR-001..007 `depends_on` was designed for this).
2. **Prevents divergence** — every consumer pack gets the same chain-of-custody guarantees, the same graph navigation tools, the same two-signature enforcement.
3. **Reduces per-vertical build time** — new investigation packs are ~40% smaller (mostly typology + connectors + regulatory guardrails, not investigation mechanics).
4. **Enables the ecosystem** — SIs and ISVs publishing packs can build on the same investigation base Windrose ships, so third-party investigation-heavy packs interoperate cleanly.

**Business value.** Indirect — the pack has no end-user surface. Value accrues through consumer packs. Concretely: every quarter of production investigation data across consumer packs feeds a shared distillation candidate stream (with strict workspace + pack scoping — no cross-tenant leakage) that improves the abstract confidence-calibration + network-anomaly baseline models.

**In scope.** Abstract 3-specialist agent recipes, graph-navigation MCP tools, chain-of-custody + evidence-provenance + tipping-off-lite + two-signature-referral guardrails, investigation case-schema library, investigation KPI semantic-model measures, distillation pipeline for abstract confidence calibration, golden eval sets for the abstract patterns.

**Out of scope.** All vertical typologies (structuring, TBML, upcoding, card-not-present, insider trading, etc. — those live in consumer packs); vertical-specific connectors; vertical-specific regulatory guardrails (BSA/OFAC/HIPAA/CMS enforcement lives in consumer packs); direct end-user UI surfaces (no dashboards; consumer packs decide UI); vertical case naming (consumer packs override via `display_labels`).

## 2. Actors & user stories

**Personas (all indirect — they interact with consumer packs, never with this framework directly):** Investigator (any tier), Investigation Supervisor, Compliance Officer, Legal Counsel, Data Steward, Tenant Admin, Windrose Platform Engineer (the persona who installs the framework as a dependency).

- **US-1** As a Windrose Platform Engineer installing `banking-aml@1.0.0`, `investigation-framework@1.0.0` installs first (via BRD 23 `?with_dependencies=true`); the consumer pack's specialized agents extend framework agents without duplicating the underlying LangGraph structure.
- **US-2** As an SI author writing a new `capital-markets-mar` pack, I `depends_on: investigation-framework ^1.0.0` and inherit chain-of-custody + graph tools + case schemas; I only ship MAR-specific typologies + connectors.
- **US-3** As an Investigator (in a consumer pack), I open a case; the network graph tool works identically whether I'm in banking-aml or payer-fwa-siu — same UX primitive, different data.
- **US-4** As a Compliance Officer, the two-signature referral guardrail enforces dual approval on every vertical's external-referral write; if a consumer pack tries to override, it fails install.
- **US-5** As a Data Steward, when the framework version updates to `1.1.0` and adds a new graph tool, all consumer packs get it automatically on next install; no per-pack redraft.
- **US-6** As a Windrose Platform Engineer during install validation, the framework refuses to install into a workspace with zero consumer packs present (warns operator: "installing library pack alone provides no user-facing value").

## 3. Functional requirements

### 3.1 Pack manifest (INV-FR-001)

Standard pack.yaml v1 per BRD 23. Distinguishing fields:

```yaml
pack_manifest: 1
name: investigation-framework
version: 1.0.0
publisher: { id: pub-windrose, name: "Windrose Inc." }
license: { spdx_id: "Commercial", url: "https://windrose.ai/licenses/framework" }
description: "Reusable investigation primitives (agents, tools, case schemas, guardrails) consumed by vertical packs via depends_on. LIBRARY pack — installs no end-user surface."
pack_class: library                      # NEW field — distinguishes library from vertical solution pack
categories: [investigation, framework, library, base-pack]
regulatory: []                           # framework is regulation-neutral; consumer packs add regulatory guardrails
platform: { min_version: "1.4.0", clouds: [aws, azure, gcp] }
depends_on: []                           # framework depends on nothing except Core BRDs 01-23
consumers_recommended:                   # NEW field — advisory, not enforcing
  - payer-fwa-siu
  - banking-aml
  - banking-fraud
  - capital-markets-mar
  - cybersecurity-incident-response
components:
  ontology:            [ { file: "ontology/investigation_base.yaml" } ]
  semantic_models:     [ { file: "semantic/investigation_core.yaml", identity: "investigation_core" } ]
  case_schemas:        [ { file: "cases/investigation_intake.yaml", identity: "investigation_intake" },
                         { file: "cases/evidence_review.yaml", identity: "evidence_review" },
                         { file: "cases/network_analysis_review.yaml", identity: "network_analysis_review" },
                         { file: "cases/risk_assessment_review.yaml", identity: "risk_assessment_review" },
                         { file: "cases/investigation_summary.yaml", identity: "investigation_summary" } ]
  role_catalog:        [ { file: "rbac/investigation_roles.yaml" } ]
  eval_sets:           [ { file: "evals/pattern_detection_abstract_golden.jsonl", identity: "pattern_detection" },
                         { file: "evals/network_investigation_abstract_golden.jsonl", identity: "network_investigation" },
                         { file: "evals/risk_scoring_abstract_golden.jsonl", identity: "risk_scoring" } ]
  guardrails:          [ { file: "guardrails/chain_of_custody.rego", identity: "chain_of_custody" },
                         { file: "guardrails/tipping_off_lite.rego", identity: "tipping_off_lite" },
                         { file: "guardrails/evidence_provenance.rego", identity: "evidence_provenance" },
                         { file: "guardrails/two_signature_referral.rego", identity: "two_signature_referral" },
                         { file: "guardrails/investigator_identity_protection.rego", identity: "investigator_identity" } ]
  pipeline_templates:  [ { file: "pipelines/nightly_investigation_queue.yaml", identity: "queue_prioritize" },
                         { file: "pipelines/quarterly_distill_investigation.yaml", identity: "distill_investigation" } ]
  model_archetypes:    [ { file: "models/investigation_confidence_calibrator.yaml", identity: "confidence_calibrator" },
                         { file: "models/network_anomaly_baseline.yaml", identity: "network_anomaly_baseline" } ]
  agent_recipes:       [ { file: "agents/pattern_detector.abstract.yaml", identity: "pattern_detector" },
                         { file: "agents/network_graph_investigator.abstract.yaml", identity: "network_graph_investigator" },
                         { file: "agents/risk_scorer.abstract.yaml", identity: "risk_scorer" },
                         { file: "agents/evidence_gatherer.abstract.yaml", identity: "evidence_gatherer" } ]
  connection_templates:[]                # framework ships zero connectors; consumers ship all vertical connectors
  display_labels:      [ { file: "labels/en.yaml", identity: "en" } ]
```

**INV-FR-002 (Must)** New pack manifest field `pack_class: library | vertical` distinguishes classes. Pack-service (BRD 23) recognizes the field:
- `library` — installs must be followed by a consumer install within 24h or a warning surfaces; framework alone shows a "no user surface" banner in `/admin/packs`.
- `vertical` — installs stand alone; can be first pack in a workspace.

Default: `vertical` (backward compat with BRDs 24–30 which predate this field).

### 3.2 The 3 abstract agents (INV-FR-010..030)

Framework agents are **abstract** — they define the LangGraph structure and MCP tool interfaces but leave typology-specific logic pluggable via config. Consumer packs specialize them.

#### INV-FR-010 — Pattern Detector (abstract)

LangGraph structure:
```
intake_signal → deterministic_rule_scan → statistical_outlier_check → peer_group_deviation
   → typology_classifier (LLM if rule/statistical inconclusive) → propose_hand_off
```

**Consumer pack specialization points (config, not code):**
- `rules_ref` — pointer to consumer pack's typology rule set (e.g., `banking-aml/typology/structuring.yaml`)
- `statistical_baseline_ref` — consumer pack's outlier baseline
- `peer_group_definition_ref` — consumer pack's peer-grouping rules
- `typology_classifier_prompt_ref` — LLM prompt for domain-specific typology naming
- `handoff_target` — which downstream agent receives the case (default: `network_graph_investigator`)

Cost budget: `chat: 8 calls / 20K tokens / 1 reflection` (mostly deterministic path).

#### INV-FR-020 — Network Graph Investigator (abstract)

LangGraph structure:
```
intake_flagged_entity → tool: graph.expand_neighbors(depth=2) → tool: graph.expand_neighbors(depth=3, filtered)
   → tool: evidence.related_parties → tool: adverse_signal.check_nodes → tool: memory.similar_investigations
   → build_evidence_bundle → propose_hand_off
```

**Consumer pack specialization points:**
- `entity_type` — what kind of entity to investigate (`customer`, `provider`, `transaction`)
- `graph_source` — which graph service backs `graph.expand_neighbors` (Neo4j, TigerGraph, Neptune, or internal Postgres graph — pack config)
- `depth_limits` — per-vertical depth constraints (banking: 5-hop OFAC 50% rule; healthcare: 3-hop provider referral network)
- `adverse_signal_sources` — LEIE/OIG for payer, OFAC SDN for banking, DFS actions for cap markets
- `related_party_algorithm` — which network-analysis heuristic to run (BFS, centrality, community detection)

Cost budget: `chat: 15 calls / 40K tokens / 2 reflections` (graph exploration is chatty).

#### INV-FR-030 — Risk Scorer (abstract)

LangGraph structure:
```
intake_evidence_bundle → tool: inference.score(model=<consumer_pack.risk_model>)
   → decision: score classification
     → low_confidence → loop_back_to_pattern_detector (with reason)
     → medium → llm_reason (justification narrative)
     → high → propose_verdict (with citations)
```

**Consumer pack specialization points:**
- `risk_model_ref` — pointer to consumer pack's trained risk model in inference-service (BRD 11)
- `confidence_thresholds` — low/medium/high boundaries (per-pack tunable)
- `loop_back_max` — max iterations before force-decision (default 2, prevents runaway loops)
- `verdict_taxonomy` — consumer-pack-defined verdict labels (e.g., `sar_worthy`, `dismiss_fp`, `escalate_l3`)

Cost budget: `chat: 5 calls / 15K tokens / 1 reflection`.

#### INV-FR-040 — Evidence Gatherer (abstract, used across all 3 above)

Not a full LangGraph agent — a **shared tool orchestrator**. Provides `evidence.gather(entity_urn, evidence_types[])` that consumer packs call from within their own agents. Handles chain-of-custody hashing, provenance chain, storage location, retrieval.

### 3.3 MCP tools shipped (INV-FR-050..070)

The framework ships ~15 MCP tools in the tool-plane (BRD 13). All consumer packs' agents can call them without registering their own equivalents.

**Graph navigation tools (INV-FR-050):**
- `graph.expand_neighbors(entity_urn, depth, hop_limit, edge_filter)` — traverse relationships in a network graph
- `graph.shortest_path(from_urn, to_urn, max_hops)` — find connection paths
- `graph.centrality(entity_urn, algorithm)` — compute betweenness/eigenvector/PageRank centrality
- `graph.community_detect(scope_urn, algorithm)` — detect clusters (Louvain, label-propagation)
- `graph.subgraph_export(root_urn, depth, format)` — export subgraph for visualization

**Evidence + chain-of-custody tools (INV-FR-060):**
- `evidence.hash_and_store(payload, evidence_type)` — SHA-256 hash + timestamp + signed provenance; returns evidence URN
- `evidence.verify_hash(evidence_urn)` — validate that stored evidence hasn't been tampered with
- `evidence.related_parties(entity_urn)` — related-party discovery (workspace-scoped)
- `evidence.timeline_build(events[])` — temporal event assembly with cited sources
- `evidence.provenance_chain(evidence_urn)` — full lineage: source system → transform → storage

**Investigation-context tools (INV-FR-070):**
- `investigation.similar_cases_search(query, workspace)` — semantic search over prior workspace investigations (memory-service)
- `investigation.related_investigations(entity_urn)` — find prior investigations involving this entity
- `investigation.risk_history(entity_urn)` — historical risk-rating changes

### 3.4 Case schemas (INV-FR-080)

Materialized via BRD 08. Consumer packs override display labels but reuse the schemas.

- **`investigation_intake`** — initial candidate for investigation. Fields: `signal_source`, `entity_urn`, `initial_confidence`, `handoff_target`, `assigned_investigator`, `status`. States: `pending → in_review → handed_off | dismissed`.
- **`evidence_review`** — evidence gathered awaiting review. Fields: `evidence_bundle_ref`, `chain_of_custody_hash`, `gathered_by`, `related_parties_count`, `network_depth_explored`. States: `pending → in_review → approved | incomplete`.
- **`network_analysis_review`** — network graph reviewed. Fields: `subgraph_export_ref`, `node_count`, `edge_count`, `centrality_findings`, `community_clusters`. States: `pending → in_review → mapped | needs_deeper`.
- **`risk_assessment_review`** — risk score reviewed. Fields: `score`, `score_model_version`, `confidence`, `verdict_recommendation`, `verdict_rationale`. States: `pending → in_review → decided`.
- **`investigation_summary`** — full case for final decision. Fields: `intake_ref`, `evidence_ref`, `network_ref`, `risk_ref`, `final_verdict`, `two_signature_status`, `external_referral_ref?`. States: `draft → pending_signatures → approved | rejected | referred`.

### 3.5 Regulatory guardrails (INV-FR-090)

Framework ships **investigation-generic** guardrails. Consumer packs add regulatory-specific guardrails ON TOP (they layer, not replace).

- **`chain_of_custody.rego`** — every evidence artifact hashed on store; hash verified on read; deletion requires two-person sign-off; access log preserved indefinitely (retention rules per consumer pack).
- **`tipping_off_lite.rego`** — generic "subject-under-investigation notification" prohibition; consumer packs (banking-aml) add regulatory teeth (BSA §5318(g)(2)(A)(i) criminal offense).
- **`evidence_provenance.rego`** — every proposal at case-service boundary must include citations to specific evidence URNs; unsourced proposals rejected.
- **`two_signature_referral.rego`** — any write designated `external_referral: true` requires two distinct actor approvals with defined role gates (Senior Investigator + Legal Counsel minimum by default; consumer packs may tighten).
- **`investigator_identity_protection.rego`** — investigator identity pseudonymized in case content shared beyond the investigation team (whistleblower analog); audit-service preserves real identity for internal-only surfaces.

### 3.6 KPI semantic model — `investigation_core` (INV-FR-100)

| Measure | Definition |
|---|---|
| `investigation_conversion_rate` | count(investigations → external_referral filed or recovery action) / count(investigations opened) |
| `avg_investigation_cycle_days` | mean days from intake to final decision |
| `evidence_completeness_rate` | count(investigations with complete evidence bundle at decision) / count(investigations) |
| `investigator_productivity` | investigations closed per FTE per day |
| `case_backlog` | count(investigations in pending or in_progress states) |
| `chain_of_custody_verification_rate` | count(evidence artifacts with valid hash) / count(evidence artifacts) — target 100% |
| `two_signature_compliance_rate` | count(external referrals with dual sign-off) / count(external referrals) — target 100% |
| `abstract_agent_agreement_rate` | for each abstract agent (pattern/network/risk), agreement between agent recommendation and investigator final verdict |

Consumer packs may add their own measures on top; framework KPIs are always available.

### 3.7 Role catalog (INV-FR-110)

Framework seeds abstract roles that consumer packs specialize:
- `investigator_l1` (base tier — case triage, evidence review)
- `investigator_l2` (senior — network analysis, complex cases)
- `investigator_l3` (specialist — external referral prep)
- `investigation_supervisor` (approval authority for two-signature referrals)
- `compliance_officer` (framework-wide compliance oversight)
- `investigation_data_steward`

Consumer packs may add their own specialized roles (BRD 27 adds `siu_investigator`, BRD 30 adds `bsa_officer`) that inherit framework role permissions plus vertical additions.

## 4. Domain model & data

Standard materialization per BRD 23 §PKG-FR-030 into: semantic-service (1 model) · case-service (5 schemas) · rbac-service (6 role seeds) · eval-service (3 golden sets — abstract patterns tested on synthetic data) · guardrail-service (5 policies) · pipeline-orchestrator (2 templates) · experiment-service (2 model archetypes) · agent-runtime (4 abstract agent recipes) · tool-registry (~15 MCP tools) · bff-graphql (display labels).

**Zero connectors, zero dashboards, zero end-user UI shipped** — this is what makes it a library pack.

### Display labels (framework baseline)

```yaml
locale: en
keys:
  case.singular:                          "Case"
  investigation_intake.singular:          "Investigation intake"
  evidence_review.singular:               "Evidence review"
  network_analysis_review.singular:       "Network analysis"
  risk_assessment_review.singular:        "Risk assessment"
  investigation_summary.singular:         "Investigation"
  agent.pattern_detector.name:            "Pattern Detector"
  agent.network_graph_investigator.name:  "Network Investigator"
  agent.risk_scorer.name:                 "Risk Scorer"
  agent.evidence_gatherer.name:           "Evidence Gatherer"
entity_templates:
  investigation: "Investigation #{short_id}"
```

Consumer packs OVERRIDE these — e.g., `banking-aml` renames the investigation to "SAR case", `payer-fwa-siu` renames to "SIU case". Framework labels are the fallback.

## 5. Events

Emitted: `investigation.intake_created`, `investigation.evidence_gathered`, `investigation.network_mapped`, `investigation.risk_scored`, `investigation.summary_referred`, `investigation.chain_of_custody_broken` (alert event — never expected in normal flow).

Consumed: no cross-service events (framework is passive infrastructure).

## 6. Business rules (INV-BR-*)

- **BR-1** **Library pack scope:** framework installs no user-facing surface. If installed alone (no consumer pack), `/admin/packs` shows a persistent banner "Investigation framework installed — no consumer pack detected. Install a vertical pack (banking-aml, payer-fwa-siu, banking-fraud, etc.) to expose investigation surfaces."
- **BR-2** **Version compatibility:** consumer packs declare `depends_on: investigation-framework ^X.0.0` per semver. Framework's SEMVER: MAJOR = breaking agent interface change (removes/renames an agent, changes tool contract, changes case-schema shape), MINOR = additive (new tool, new abstract agent, new guardrail), PATCH = content-only.
- **BR-3** **Consumer packs cannot override framework guardrails** — they can only ADD on top. Attempting to `depends_on: investigation-framework` while shipping a guardrail identity `chain_of_custody` → publish fails with `INV_GUARDRAIL_OVERRIDE_FORBIDDEN`. Consumers add vertical-specific guardrails with unique identities (e.g., `banking-aml` ships `bsa_sar_confidentiality`, layered on framework's `tipping_off_lite`).
- **BR-4** **Consumer packs specialize abstract agents via config, not by shipping their own agent recipes with the framework's identity slugs.** BRD 27 ships `payer_fwa_typology_config.yaml` that plugs into framework's `pattern_detector.abstract`, not a replacement `pattern_detector`. Attempting duplicate identity → install fails.
- **BR-5** **Chain-of-custody is inviolable in framework.** Any consumer pack extension that would relax chain-of-custody (e.g., allowing evidence delete without two-person sign-off) → publish fails.
- **BR-6** **Two-signature referral is the minimum bar.** Consumer packs may raise (three-signature) but not lower to one-signature. Attempted single-signature external-referral write → publish fails.
- **BR-7** **Distillation candidate stream is workspace-scoped** — framework's `investigation_confidence_calibrator` model archetype trains per-tenant per-workspace only, NEVER cross-tenant. Cross-tenant training would leak investigation patterns between competitors and is forbidden by BR (mirrors BRD 27 §BR-6 + BRD 30 §BR-5).
- **BR-8** **Framework retirement** — if framework `1.x` is deprecated in favor of `2.x`, all consumer packs must upgrade their `depends_on` range OR be pinned to `1.x` explicitly. pack-service (BRD 23) prevents auto-upgrade breakage.
- **BR-9** **Abstract agent parameterization is by config file reference, not inline** — consumer packs' rule sets / prompts / models live in the consumer's OCI artifact and are referenced via URN. Prevents inline prompt-injection attack surfaces.
- **BR-10** **Never install alone in production.** Warning in `/admin/packs` per BR-1; second warning as an in-app modal on any admin action; third block: pack-service refuses `pack.install_completed` transitions after 24h without a consumer pack.

## 7. Dependencies

Windrose Core (all BRDs 01–23). External: none directly; consumer packs bring the external data.

**Reverse dependencies (consumers):**
- BRD 27 `payer-fwa-siu@1.1.0+` (updated to declare `depends_on: investigation-framework ^1.0.0`)
- BRD 30 `banking-aml@1.1.0+` (updated to declare `depends_on: investigation-framework ^1.0.0`)
- Future: `banking-fraud`, `capital-markets-mar`, `cybersecurity-incident-response`, `insurance-claims-payer-fwa-extension`

## 8. NFRs (deltas)

| Metric | Target |
|---|---|
| Framework install time (into empty workspace) | ≤ 60s |
| Consumer pack install with framework dep resolution | +5s over standalone install |
| `graph.expand_neighbors` p95 | ≤ 500ms at depth 3 |
| `evidence.hash_and_store` p95 | ≤ 100ms |
| `investigation.similar_cases_search` p95 | ≤ 300ms at 100K prior investigations per workspace |
| Chain-of-custody verification (per artifact) | ≤ 5s |
| Framework MAJOR version bump frequency | ≤ 1 per year (breaking change discipline) |
| Framework tests must pass 100% before any consumer pack accepts the version bump | Release gate |

## 9. Acceptance criteria

- **AC-1** Install `investigation-framework@1.0.0` into a fresh workspace (no consumer pack); materializes 5 case schemas + 4 abstract agents + 15 MCP tools + 5 guardrails; `/admin/packs` shows the "no consumer pack detected" banner.
- **AC-2** Install `banking-aml@1.1.0` (updated to depend on framework); resolves and installs `investigation-framework@1.0.0` automatically (via BRD 23 `?with_dependencies=true`); banking-aml's `Alert Triage Copilot` recipe references `framework.pattern_detector.abstract` in its `extends:` field; on invocation, the agent runs framework's LangGraph with banking-aml's typology config plugged in.
- **AC-3** Consumer pack attempting to ship a duplicate `chain_of_custody` guardrail identity → publish fails `INV_GUARDRAIL_OVERRIDE_FORBIDDEN` with citation to BR-3.
- **AC-4** Consumer pack attempting to specialize `pattern_detector` by shipping its own recipe with identity `pattern_detector` (instead of a config file plug-in) → install fails with duplicate-identity error.
- **AC-5** Framework `investigation.similar_cases_search` scoped to workspace W returns only W's prior investigations; cross-workspace query returns 404 (workspace-scope isolation verified).
- **AC-6** External-referral write with single signature → refused with `INV_TWO_SIGNATURE_REQUIRED`; two distinct actor signatures → accepted; three-signature (consumer-pack-tightened) also accepted.
- **AC-7** Chain-of-custody hash verification on 100K stored evidence artifacts returns 100% valid; injected tamper (test-mode) surfaces `investigation.chain_of_custody_broken` alert event within 10s.
- **AC-8** Framework `1.0.0 → 1.1.0` minor bump (add new graph tool) — consumer packs pinned to `^1.0.0` accept the upgrade automatically; consumer packs pinned to `~1.0.0` (patch-only) refuse — verified in install-plan diff.
- **AC-9** Distillation candidate stream from framework's `investigation_confidence_calibrator` includes only workspace W's data; scoped isolation asserted in test with two tenants both installed.
- **AC-10** **Pack installs cleanly on unmodified Core BRDs 01–23** (falsifiability test). Additionally, **consumer pack retrofits (BRD 27 → 1.1.0, BRD 30 → 1.1.0) require zero Core changes** — the retrofit is entirely pack-content diff (replace inline duplicated primitives with framework references).

## 10. Out of scope / future

- Runtime primitives beyond the shipped 15 MCP tools (each future primitive is a framework MINOR bump, not out-of-scope forever).
- Cross-workspace / cross-tenant distillation aggregation (never — competitor sensitivity in every consuming vertical).
- Consumer pack UI (framework has no UI opinions; consumers own their surfaces).
- Non-investigation packs consuming this framework (audit-heavy but not investigation-heavy packs like compliance reporting shouldn't force-fit here — separate `compliance-reporting-framework` future pack).
- Third-party framework forks (SIs/ISVs consuming this framework is welcome; SIs publishing competing frameworks is a separate ecosystem question — Horizon 3).

## Appendix — the mapping from BRD 27 + BRD 30 pre-framework to post-framework (retrofit checklist)

When BRDs 27 + 30 update to `depends_on: investigation-framework ^1.0.0`, the following consolidation happens:

**BRD 27 (payer-fwa-siu) retrofit deltas:**
- `SIU Case Builder` agent → becomes a config that plugs into framework's `network_graph_investigator.abstract` (deleted from BRD 27's own recipes)
- `Evidence Gatherer` agent → moves to framework; BRD 27 references it (deleted from BRD 27's own recipes)
- FWA Scorer's risk-scoring stage → uses framework's `risk_scorer.abstract` with FWA-model reference
- Chain-of-custody guardrail (originally in BRD 27) → deleted; framework's shipped version applies
- Two-signature enforcement (originally BRD 27 §BR-3) → deleted from BRD 27; framework enforces
- **Result:** BRD 27 shrinks by ~30%; content becomes purely FWA-typology + connectors + FWA-regulatory guardrails.

**BRD 30 (banking-aml) retrofit deltas:**
- `SIU Case Builder`-analog logic in Alert Triage Copilot's network-expansion phase → uses framework's tools
- Chain-of-custody guardrail (BRD 30 §AML-FR-110) → deleted; framework's applies
- Two-signature enforcement (BRD 30 §BR-14) → deleted; framework enforces
- Alert Triage's evidence-gathering phase → uses framework's `evidence.gather` tool
- **Result:** BRD 30 shrinks by ~25%; content becomes purely AML-typology + connectors + BSA/OFAC-regulatory guardrails + tipping-off-STRONG (AML-specific criminal-offense variant of framework's tipping-off-lite).

**This is the pack thesis at work — extract the reusable pattern once, consumer packs get thinner + more consistent + more maintainable.**
