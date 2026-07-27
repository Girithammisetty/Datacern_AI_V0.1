# Datacern AI — Positioning Options: SLM Training & Agent Building on the Customer's Own Data

**Prepared:** 2026-07-26 · **Status:** research + options menu, no decision taken · **Audience:** founder / strategy

**The question this answers.** Every enterprise already runs warehouses and data sources. Instead of selling "decision intelligence," should Datacern sell an **SLM + agentic-AI building platform** that runs on the customer's own data with reusable agents — something like a multi-tenant SLM trainer that improves itself autonomously? This document lays out **every option found**, what each would require, and what would kill it. It does not pick one.

**Method.** Three parallel research passes: a ruthless code audit (implementation only — BRDs and comments explicitly disregarded), an SLM/fine-tuning market sweep, and an agent-platform market sweep. Market claims carry a source and date. Strategy inference is marked **[THESIS]**. Code claims are marked **[VERIFIED]** and cite `file:line`.

---

## 1. The reality baseline — what you can say without lying

This is the constraint every option below is bounded by. It comes from the code, not the roadmap.

### 1.1 Genuinely real, and stronger than expected

| Asset | Evidence | Why it matters here |
|---|---|---|
| **19 source connectors, all real drivers, no stubs** | `ingestion-service/app/domain/drivers/` (~3,700 LOC). Two honest tiers: locally-verified (postgres, mysql, sqlserver, oracle, sftp, ftp, http_api, s3, presto/Trino) and credential-gated with real vendor SDKs (snowflake, databricks, bigquery, redshift, spanner, salesforce, gcs, azure_blob) | The most credible "your data sources" evidence in the repo |
| **Corrections → SFT corpus pipeline** | `agent-runtime/app/domain/transcripts.py` + `sft_curation.py` + `sft_template.py`; migrations 0006/0007 with FORCE RLS. Consent-gated, PII-redacted, four human-feedback signals captured, deduped, checksummed, immutably versioned, per-tenant | **The single differentiated asset.** See §3 — this is the scarce input the whole RFT market needs |
| **Real classical-ML training + governed promotion** | `pipeline-orchestrator/app/executor/local.py` (21 algorithms, real MLflow `log_model`); `experiment-service/.../services.py:1125-1265` (four-eyes promotion, incumbent auto-archive); `inference-service/app/adapters/executor.py:62` (real batch scoring). Integration test trains real xgboost from real human corrections against real MLflow | Proves you can train and promote *something* safely today — demoable |
| **Governance rails** | FORCE-RLS on every tenant table; four-eyes proposal chokepoint with toolset re-check; fail-closed eval gate on agent publish (`agent-runtime/app/adapters/eval_gate.py`); judge-never-gates-alone rule (`eval-service/app/domain/gate_rule.py`); external-agent ingress that cannot bypass any of it | Unusually rigorous; directly addresses the #1 documented cause of agent-project failure |
| **Deterministic semantic compiler** | `semantic-service/app/compiler/compiler.py` — whitelisted aggregations, allowlisted columns, parameterized filters, byte-identical SQL for the same request+version+dialect | Semantic layer is where agent accuracy comes from (§2.3); determinism makes it auditable |

### 1.2 Vapor — do not put these on a slide

| Claim | Reality |
|---|---|
| **"Multi-tenant SLM trainer"** | **No SLM has ever been trained or served by this system.** `slm_trainer_backend` defaults to `None` → `UnconfiguredGpuTrainer` raises on every job; `slm-modal` is an *optional* pip extra; Helm `training.enabled: false` and its Job references an `slm-trainer` image **with no Dockerfile in the repo**; the Modal app requires the customer's own Modal account and a manual `modal deploy`; tests are mock-only; CI never touches it |
| **"Trained models get served"** | **No serving path exists.** `ai-gateway` `PROVIDERS = ("azure_openai","bedrock","vertex","anthropic","ollama")` — no SLM/adapter kind. `promote()` flips a DB column `target_rung_alias` that **nothing reads**. Adapter URIs are `modal://…`, resolvable by nothing in the codebase |
| **"Runs on your data where it lives"** | **No query-in-place.** `query-service/internal/engine/stubs.go:25` — the warehouse adapter is a *compiling stub* returning `NotImplemented`, so the entire `warehouse_primary` policy is dead code. Data must be extracted into Datacern's own Iceberg. The snowflake/databricks/bigquery drivers are **extractors, not federation** |
| **"Customers build their own agents"** | **One graph, one tool.** `_CUSTOM_GRAPH_REF = "persona_copilot.v1"` is hard-forced and any other value is rejected; `GRAPH_RUNNERS` has exactly one entry; `_SUPPORTED_PROPOSE_TOOLS = {"case.apply_disposition"}`. Customers **cannot register tools** — the tool catalog is owned by a reserved `PlatformTenant` sentinel. Anything that isn't a case-disposition copilot needs a new Python module and a platform release |
| **"Per-tenant model isolation"** | SLM *metadata* is FORCE-RLS'd (good), but the adapter artifact path is `base_model/sha256(corpus)` in **one shared Modal Volume with no tenant component**. Classical-ML isolation is naming convention inside a single shared, unauthenticated MLflow. Will not survive a security questionnaire |
| **"28 packs = reusable agents"** | Packs are real and substantial, but contribute **zero new agent behaviors** — they are prompts, grounding, dispositions, semantic models and rule tables layered on the platform's fixed graphs. The payer pack's own config says bespoke recipes are *deferred* |

**The blunt version:** you have a governed classical-ML platform with a real connector fleet and — critically — a working, RLS-isolated human-correction-to-SFT-corpus pipeline. You do not have an SLM trainer. The audit's estimate to a *demoable* one is roughly **a quarter of focused work**: deploy the Modal app, tenant-partition the adapter volume, stand up adapter serving, add an `slm` provider kind to ai-gateway, wire eval-gate validation into `promote()`, and build a UI (there is currently **zero** GraphQL or UI surface for transcripts, datasets, jobs or adapters).

---

## 2. Market conditions

### 2.1 The SLM thesis is real and analyst-backed

- **Gartner (Apr 9, 2025):** by 2027 organizations will use small task-specific models **~3× more** than general-purpose LLMs.
- **NVIDIA Research (arXiv:2506.02153, Jun 2025):** "Small Language Models are the Future of Agentic AI" — SLMs are sufficient for the narrow repetitive subtasks inside agent graphs, at ~10–30× lower inference cost. NVIDIA shipped Nemotron 3 (Dec 2025) on exactly this thesis.
- **Reinforcement fine-tuning (RFT/GRPO) became a product category in 2025–26** — OpenAI RFT (public 2025), Predibase RFT, NVIDIA NeMo Customizer, CoreWeave serverless RL, Azure AI Foundry, AWS Bedrock. **RFT runs on graded outcome data** — accept/reject/corrected-output pairs.
- **Multi-tenant per-end-customer training is whitespace.** No vendor in the sweep markets "train a separate small model per your end-customer" as a SKU, while the enabling tech is mature and open: **S-LoRA demonstrated 2,000 adapters on a single GPU**; LoRAX/vLLM do dynamic multi-adapter serving in production.
- **Serving cost, not training cost, is the lever.** Multiple sources converge: keeping a fine-tuned model served costs **50–200× the one-time training cost** over realistic monthly volume. That is the entire economic argument for many-adapters-per-GPU.

### 2.2 …but the counter-evidence is serious

- **Frontier labs ship distillation-as-a-service inside their own walls** — OpenAI Model Distillation API, Google Gemini Distillation, Azure OpenAI Model Distillation. If a customer doesn't need sovereignty or true multi-tenancy, they never leave the walled garden.
- **The warehouses are building train-in-place themselves.** **Snowflake Cortex Training** (Summit, Jun 2, 2026, public preview) trains open-weight models (Qwen, Mistral) reading Snowflake tables directly with explicit *"no data movement outside Snowflake's security boundary"* messaging. Databricks Mosaic AI (MosaicML, $1.3B, 2023) is the equivalent. **This is your pitch, shipped by the incumbents.**
- **Every independent fine-tuning pure-play has been acquired**: Predibase → Rubrik (Jun 2025, now repositioned to governance), OpenPipe → CoreWeave (Sep 2025, legacy platform sunset Jul 30 2026). The category is consolidating into GPU clouds and data platforms. Standalone fine-tuning is not proving to be a durable independent business.

### 2.3 The agent-building market

- **Every major ships a builder** — Copilot Studio/Foundry, Agentforce Agent Builder, ServiceNow AI Agent Studio, Databricks Agent Bricks (100K+ agents built), Snowflake Cortex Agents, Google ADK/Agent Studio, AWS AgentCore, Palantir AIP. **Every one pulls the customer into a proprietary runtime, reasoning engine, or ontology. None is neutral across warehouses.**
- **The connector layer is commoditizing** — Fivetran+dbt merged (late 2025); Airbyte/dlt/Estuary cover the long tail. Building your own connectors is a cost sink, not a moat. *(Note the tension with §1.1: your connector fleet is real and good, but it is not defensible.)*
- **MCP is table stakes** (donated to the Linux Foundation Dec 2025; ~110M monthly downloads; 41% of orgs with MCP servers in production). It standardizes tool calling and explicitly **does not** cover governance, evals, registry trust, or observability — so differentiation moved to exactly those.
- **Semantic layer is where accuracy lives**, and Snowflake (Semantic Views GA Mar 2026) and Databricks (Metric Views) are racing to make it proprietary. The **Open Semantic Interchange spec (Jan 2026)** is the neutral counter.
- **Agent projects fail on governance, evaluation and integration — not model quality.** Gartner: >40% of agentic projects canceled by end-2027. Forrester (2026): **88% of pilots never reach production**; eval gaps cited by 64%, governance friction 57%, model reliability 51%. Deloitte: only **21% have a mature agentic governance model** while **85% expect to customize agents to their business**.

That last pair is the crux: **enterprises want to build and customize on their own data (85%), and the attempts die on governance and evaluation (the layer you already built).**

---

## 3. The insight that connects your idea to your assets **[THESIS]**

RFT/GRPO — the fastest-moving corner of the model-customization market — **runs on graded outcome data**: pairs of (model output, human verdict, corrected output). That data is the scarce input. Everyone selling fine-tuning has GPUs and trainers; almost nobody has a governed supply of expert-labeled corrections with provenance.

You produce that data as **exhaust** of the product you already built. The four-eyes approval chokepoint means every proposal gets an expert verdict; `transcripts.py` captures four distinct human-feedback signals; `sft_curation.py` turns them into deduped, checksummed, per-tenant SFT corpora under FORCE-RLS. **[VERIFIED]**

So the honest framing is not "SLM *instead of* governance." It is: **the governance chokepoint is the data-collection mechanism that makes per-tenant SLMs possible.** Competitors can rent the same GPUs and download the same base models; they cannot manufacture your customers' expert corrections, because they don't sit at the point where a named human signs the decision.

That reframe is available to you today and costs nothing to adopt. Whether you *build* the trainer is a separate decision (§4).

---

## 4. The options

Each option: the pitch · why now · what's real today · what must be built · who you fight · what kills it.

---

### Option A — Stay: "Decision Assurance" (governed decisions for regulated ops)

- **Pitch.** AI drafts, a named human decides, an audit trail proves it. The accountability layer for enterprise AI.
- **Why now.** Regulatory convergence (CMS WISeR, EU AI Act Art. 14, Colorado ADMT, NAIC bulletins, SR 26-2's agentic gap) mandates this architecture in different vocabularies. Full detail in [`DATACERN_2035_VISION.md`](DATACERN_2035_VISION.md).
- **Real today.** Nearly all of it. This is the one option where the demo matches the pitch.
- **To build.** Nothing structural — finish billing, certifications, first production deployment.
- **You fight.** ServiceNow AI Control Tower (closest), Credo/Holistic (documentation-only), hyperscaler control planes.
- **What kills it.** Regulators licensing greater autonomy; hyperscalers bundling "good-enough" governance free; the market treating governance as a feature, not a product.

---

### Option B — Pivot: "Multi-tenant SLM trainer" (the literal idea)

- **Pitch.** Bring your data; we train and serve a small model per tenant, continuously improving from usage. Cheaper, faster, sovereign.
- **Why now.** Gartner 3×-by-2027; NVIDIA's SLM thesis; serving-cost amortization via S-LoRA/LoRAX (2,000 adapters/GPU); **no vendor markets per-end-customer training as a SKU**.
- **Real today.** The corpus pipeline (§1.1) and the honest port/adapter scaffolding. **The trainer itself has never executed once.**
- **To build.** Everything downstream of the dataset: GPU execution you control (not the customer's Modal account), tenant-partitioned adapter storage, an adapter-serving endpoint, an `slm` provider kind in ai-gateway, eval-gate validation in `promote()`, and a UI. Plus the multi-tenant hard parts: cross-tenant batching, adapter lifecycle at scale, cold-start for new tenants, and a defensible answer on shared-base-model leakage.
- **You fight.** Snowflake Cortex Training, Databricks Mosaic AI, Predibase/LoRAX (most mature stack technically), CoreWeave+OpenPipe+W&B, NeMo, and the frontier labs' own distillation services.
- **What kills it.** Frontier inference gets cheap enough that per-tenant models aren't worth the ops; Snowflake/Databricks make train-in-place a free feature; you're a small player selling GPU-adjacent infrastructure against companies that own the GPUs. **Also: the acquisition pattern (Predibase, OpenPipe) suggests this is a feature, not a company.**

---

### Option C — Pivot: "Agent building platform on your own data"

- **Pitch.** Build reusable agents against your warehouse, your semantic layer, your tools — without moving data into someone's proprietary runtime.
- **Why now.** 85% of enterprises expect to customize agents (Deloitte); every incumbent builder is runtime-proprietary; **none is neutral across warehouses**; MCP makes tools portable.
- **Real today.** The connector fleet, the deterministic semantic compiler, MCP facades, external-agent ingress, and the governance rails.
- **To build.** This is the option the audit is harshest on. Today "custom agent" means *one* graph and *one* tool, and **customers cannot register tools at all**. You would need: a real multi-graph/composable agent model, customer-registerable tools, an MCP *client* (you only expose servers), and a genuine builder UI (today it's a settings form). Plus **query-in-place** (§1.2) or the "on your own data" claim is false.
- **You fight.** Everyone — Microsoft, Salesforce, ServiceNow, Databricks, Snowflake, Google, AWS, Palantir. All better capitalized.
- **What kills it.** You arrive third to a market where distribution wins; the neutrality wedge isn't enough when the customer already pays for Databricks or Salesforce and gets a builder included.

---

### Option D — Reframe: "The governed correction corpus" (data-flywheel company)

- **Pitch.** Your experts' decisions are training data you're currently throwing away. We capture them under governance, with consent and provenance, and turn them into a per-tenant corpus **you own** — usable to fine-tune anything, anywhere, on any vendor's trainer.
- **Why now.** RFT needs graded outcomes (§3); nobody else sits at the human-approval chokepoint; data portability is a growing enterprise demand.
- **Real today.** **Almost all of it** — this is the one pivot where the code is ahead of the pitch. `transcripts.py`, `sft_curation.py`, RLS, consent gating, PII redaction, checksummed versioned corpora. **[VERIFIED]**
- **To build.** Corpus export in standard formats (JSONL/chat, HF datasets), a UI to browse/curate/version, quality metrics, and integrations that hand the corpus to Bedrock/Vertex/Snowflake/Databricks/OpenAI fine-tuning. Deliberately *not* a trainer.
- **You fight.** Nobody directly. Label vendors (Scale, Surge) sell human labor; you'd sell captured expert judgment as a byproduct.
- **What kills it.** Corpus alone may be too thin to be a company; customers may consider the data theirs and not pay for the capture; it makes you complementary to trainers rather than a platform.

---

### Option E — Hybrid: "Governed agents that get cheaper" (A + D, with B as roadmap)

- **Pitch.** Governed agents on your data today; every expert correction becomes per-tenant training data; cost-per-decision declines as work distills onto small models you own.
- **Why now.** Combines the mandate-driven demand of A with the margin narrative of B and the real asset of D. The declining-cost-per-decision story is one no competitor tells.
- **Real today.** A and D are real; the distillation half is explicitly a **dated roadmap**, not a claim.
- **To build.** Same as D, then B's serving path incrementally — starting with one internal agent distilled onto one small model as an existence proof.
- **You fight.** Same as A, with a differentiated margin story.
- **What kills it.** Requires disciplined honesty about which half is shipped; if the SLM half slips indefinitely the pitch curdles into vaporware — precisely the failure mode the partner briefing was rewritten to avoid.

---

### Option F — "Warehouse-native governed agent layer" (sit on Snowflake/Databricks/Iceberg)

- **Pitch.** Keep your warehouse. We add the governed agent + evaluation + evidence layer your warehouse vendor doesn't, across all of them.
- **Why now.** Iceberg is genuinely neutral substrate (Polaris open-sourced Jun 3 2024; Unity Catalog donated to Linux Foundation Jun 13 2024; near-universal engine support). OSI spec (Jan 2026) makes semantics portable. Warehouse vendors' governance stops at their own perimeter.
- **Real today.** Real Iceberg read/write, Trino + DuckDB engines, a real routing decision table — **but pointed only at Datacern's own catalog**.
- **To build.** **Query-in-place is the whole option** and it is currently a compiling stub. Federating to customer Snowflake/Databricks/BigQuery catalogs, cross-warehouse semantic mapping, and pushdown governance.
- **You fight.** Snowflake and Databricks directly, on their turf — but as a *complement* rather than a replacement.
- **What kills it.** Warehouse vendors close the gap (both are actively doing so); customers standardize on one warehouse and take its native tooling.

---

### Option G — "Vertical AI products" (packs become the product)

- **Pitch.** Stop selling a platform. Sell a payer prior-auth product, a card-disputes product, an AML product — each with its own small model and agents.
- **Why now.** Vertical agent companies command the highest multiples (Sierra ~$15.8B May 2026; Decagon $4.5B Jan 2026); domain knowledge is the cited gap in generic agents.
- **Real today.** 28 packs of genuine domain content — ontologies, dispositions, decision tables, grounding, semantic models. Real and substantial.
- **To build.** Per-vertical GTM, deeper workflow completeness, and the willingness to say no to other verticals. Packs today configure fixed agents; a product needs more.
- **You fight.** Cohere Health (prior auth), vertical incumbents, and the SI/consulting model.
- **What kills it.** You have 28 shallow verticals rather than 1 deep one; picking one discards most of the built content; vertical SaaS needs domain-expert founders per vertical.

---

### Option H — "Open the format, sell the enforcement"

- **Pitch.** Open-source the corpus/evidence formats (governed correction record, decision evidence record); sell the governed runtime, the trainer, and the packs.
- **Why now.** Preempts open-source commoditization; standards win adoption (MCP's trajectory); auditors and insurers need a format before regulators mandate one.
- **Real today.** The formats exist in code and are well-specified. **[VERIFIED]**
- **To build.** Spec extraction, reference implementation, governance/stewardship.
- **You fight.** Nobody initially; this is a seeding play.
- **What kills it.** Standards take years and rarely monetize directly; a small player may lack the credibility to convene one.

---

## 5. Comparison

| # | Option | Real today | Build cost | Competition | Differentiation | Honest-claim risk |
|---|---|---|---|---|---|---|
| A | Decision Assurance | ●●●●● | Low | Medium | High | **None** |
| B | Multi-tenant SLM trainer | ●○○○○ | **Very high** | **Brutal** | Medium | **Severe** — nothing has run |
| C | Agent building platform | ●●○○○ | **Very high** | **Brutal** | Low | **High** — one graph, one tool |
| D | Governed correction corpus | ●●●●○ | Low–med | **None direct** | **High** | Low |
| E | Hybrid (A+D, B roadmap) | ●●●●○ | Medium | Medium | **High** | Low *if disciplined* |
| F | Warehouse-native agent layer | ●●○○○ | High | High | Medium–high | Medium — no query-in-place |
| G | Vertical products | ●●●○○ | Medium | Medium | Medium | Low |
| H | Open format + enforcement | ●●●●○ | Low | None | Medium | Low |

---

## 6. What each option demands you stop doing

Strategy is subtraction; the research makes the trade-offs concrete.

- **B** means competing on GPU-adjacent infrastructure against companies that own GPUs, in a category where every independent player was acquired within 18 months.
- **C** means rebuilding the agent model from one hard-coded graph into a composable system, opening the tool catalog to customers, and building query-in-place — before you have a single customer.
- **F** means the connector fleet's value shifts from extraction to federation; several of the 19 drivers become less relevant.
- **G** means most of the 28-pack library becomes shelfware.
- **D/E** mean explicitly *not* building a trainer yet, and being disciplined enough to say "roadmap" out loud when asked about SLMs.

---

## 7. Sequenced questions that resolve this without a bet

Cheap experiments, in order:

1. **Ask five target buyers what they'd pay for.** Specifically: "a corpus of your experts' AI corrections that you own and can fine-tune anywhere" vs. "we train and host a small model for you." The answer separates D from B for the cost of five calls.
2. **Distill one agent, once.** Take an existing per-tenant SFT corpus, fine-tune one small model (Llama-3.2-3B or Qwen2.5-3B — both already in `KNOWN_BASE_MODELS`), and measure accuracy/cost against the current LLM path on the same cases. That single number tells you whether the SLM thesis holds *on your data*, and it's the strongest possible demo artifact.
3. **Price a query-in-place spike.** Implement the warehouse adapter for exactly one engine (Snowflake or Databricks) and see what it costs. That prices options C and F.
4. **Test the neutrality wedge.** Ask prospects already on Snowflake/Databricks whether a neutral governance+agent layer is worth paying for on top. If yes, F is live; if they shrug, F is dead.

Experiment 2 is the highest-information-per-dollar item in this document. It is also a prerequisite for honestly saying anything about SLMs at all.

---

## 8. My read **[THESIS]**

Your instinct is directionally right and one step too far. The market data supports "customers want to build on their own data with models shaped to their business" (Deloitte 85%). It does **not** support abandoning governance — that is the layer whose absence kills 88% of agent pilots (Forrester), and it is the only place where you currently lead.

The strongest available position is **E**: keep the governed-decision product as the thing you sell and demo, adopt **D**'s reframe immediately (it costs nothing and is already true in code), and treat **B** as a dated roadmap proven by experiment 2 — not a claim. That story is *"governed agents on your data, and every expert correction makes your own small model better and your cost-per-decision lower"* — which is the user's SLM instinct, made defensible by the asset that already exists.

The single most dangerous option is **B as a headline today**: the audit's verdict is that a "multi-tenant autonomous SLM trainer" claim "would fail the first technical diligence call," because the trainer is `enabled: false`, has no container image, no serving path, no tenant-partitioned storage, and has never executed outside a mock. Given the standing rule that every claim must survive inspection, that one cannot be said yet — but it can be *built*, and the audit scopes it at roughly a quarter of focused work.

---

## 9. Sources

**SLM / fine-tuning:** Gartner (Apr 9, 2025) small-task-specific-models prediction · NVIDIA Research arXiv:2506.02153 (Jun 2025) · NVIDIA Nemotron 3 (Dec 2025) · OpenAI Model Distillation API · Google Gemini Distillation · Azure OpenAI Model Distillation · Snowflake Cortex Training (Summit, Jun 2, 2026) · Databricks/MosaicML ($1.3B, Jun 2023) · Rubrik–Predibase (Jun 2025) · CoreWeave–OpenPipe (Sep 3, 2025) · S-LoRA arXiv:2311.03285 · LoRAX · IBM Granite 4.1 (Apr 29, 2026) · Arcee AI Trinity (TechCrunch, Jan 28, 2026) · OpenAI RFT docs · NVIDIA NeMo Customizer.

**Agent platforms:** Microsoft Foundry Agent Service (Build 2026) · Salesforce Agentforce Builder + AgentExchange (TrailblazerDX 2026) · ServiceNow AI Agent Studio / Build Agent GA (2026) · Databricks Agent Bricks (DAIS, Jun 2026) · Snowflake Cortex Agents + Semantic Views (GA Mar 2, 2026) · Google ADK / Gemini Enterprise (Cloud Next 2026) · AWS Bedrock AgentCore (2026) · Palantir AIP (Apr 2026) · MCP → Linux Foundation (Dec 2025) · Snowflake Polaris open-sourced (Jun 3, 2024) · Databricks Unity Catalog open-sourced (Jun 13, 2024) · Open Semantic Interchange (Jan 2026).

**Failure/adoption data:** Gartner (Jun 25, 2025) >40% agentic projects canceled by 2027 · Forrester (2026) 88% of pilots not in production; eval 64% / governance 57% / reliability 51% · Deloitte State of AI (survey Aug–Sep 2025) 21% mature agentic governance, 85% expect to customize agents.

**Sourcing caveat.** Several figures — dbt semantic-layer benchmark deltas, TEKsystems' integration-barrier percentage, the MIT/NANDA pilot-stall figure, marketplace rev-share terms, and the "10×/32× cheaper" SLM cost multiples — reached the research only via secondary aggregation because the primary pages block automated fetch. They are directionally consistent with vendor pricing but should be re-verified before appearing in any customer- or investor-facing material. Every code claim in §1 was verified directly against the implementation.
