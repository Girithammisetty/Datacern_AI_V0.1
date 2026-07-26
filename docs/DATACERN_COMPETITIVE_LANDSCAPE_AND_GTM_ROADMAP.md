# Datacern AI — Competitive Landscape & Agentic-Platform + GTM Roadmap

**Prepared:** 2026-07-25 · **Audience:** founder / strategy · **Status:** analysis + prioritized roadmap
**Inputs:** full codebase audit (23 services, 30 packs, 66 BRDs), mid-2026 competitive research (web-sourced, cited), GTM feature-pattern research across enterprise AI/data platforms.

Companion docs: [`DATACERN_PARTNER_BRIEFING.md`](DATACERN_PARTNER_BRIEFING.md) (partner motion), [`DATACERN_REALTIME_HEALTHCARE_POSITION.md`](DATACERN_REALTIME_HEALTHCARE_POSITION.md) (healthcare objection handling), [`DATACERN_2035_VISION.md`](DATACERN_2035_VISION.md) (5–10 year direction; this doc governs the 0–24 month window).

---

## 1. Executive summary

Datacern's engineering position is unusually strong for a pre-revenue platform: governance is **in the execution path** (proposals + signed grants + four-eyes + hash-chained WORM audit), not documentation beside it — something none of the incumbents ship today. The competitive research confirms the position Datacern occupies is **genuinely unoccupied in mid-2026**:

> *Neutral, multi-cloud, execution-path governance with regulator-grade evidence, spanning ML **and** agents under one lineage/approval fabric, packaged as installable vertical packs.*

Hyperscalers log after the fact; Databricks/Snowflake govern only their own perimeter; Credo/Holistic document AI but don't run it; gateways route but don't approve; Sierra/Fin are single-vertical apps. The market has also handed Datacern two live urgency levers: **EU AI Act high-risk enforcement (Aug 2026)** and the **SR 11-7 → SR 26-2 replacement (Apr 2026)**, which explicitly left GenAI/agentic AI out of scope — banks must self-govern agents under regulatory uncertainty, and they will buy defensible controls.

The gap is entirely commercial. Three blunt facts from the code audit:

1. **Money cannot change hands.** Rate cards price meters, but nothing invoices, charges, or collects; there is no payment provider, no plan/entitlement/trial object anywhere in the repo — and no `governed_decision` meter despite "per-decision pricing" being the pitch.
2. **There is no self-serve path at all.** No signup, no sandbox, no trial — the `/welcome` page doesn't even link to `/login`. Every motion is demo-request → manual tenant-provisioning script.
3. **Zero product analytics.** OTel exists, but nothing answers "which packs get used, where do users drop off, who is about to churn or expand."

This document maps the landscape (§2–3), locks the differentiation thesis (§4), then lays out two prioritized roadmaps: agentic-platform hardening against the 2026 table-stakes checklist (§5) and the GTM feature build (§6), with quick wins (§7) and a consolidated backlog (§8).

---

## 2. Where Datacern stands today (code-verified)

### 2.1 Strongest assets (real, live-verified)

| Asset | Why it matters commercially |
|---|---|
| Proposal spine: `WriteIntent` → four-eyes → RS256 JWS execution grant bound to `(tenant, tool, tier, args_digest)`, verified fail-closed at tool-plane | The core defensible claim: agents *physically cannot* write without human approval. Decision tables, persona copilots, entity merges, and external agents (BRD 60) all funnel through the same spine |
| Audit: per-tenant/day hash chains (ClickHouse) + 7-yr WORM Parquet under Object-Lock + SOC 2 / EU AI Act evidence-pack endpoints | "Evidence-grade audit" — directly sellable against EU AI Act Art. 12/14 and the SR 26-2 vacuum |
| ai-gateway: normative pipeline (guardrails → cache → budget → ladder → provider failover), hierarchical hard budgets that 402 fail-closed | "Your AI bill structurally cannot run away" — a selling feature, already true in code |
| usage-service: 7 versioned meters incl. per-agent dims, rollups, showback CSV, rate cards, budget threshold events, anomaly detection, provider-bill reconciliation | 80% of a billing system's hard half (metering/rating raw material) already exists |
| 30 vertical packs + governed install saga (dry-run plan, origin-tagged ledger, upgrade/rollback/drift, four-eyes on data-chain) + `packctl` lint | The ecosystem/distribution thesis has a real substrate — what's missing is registry/signing/monetization, not the install machinery |
| MCP gateway (pinned spec 2025-06-18), A2A signed agent cards, external-agent SDK (`sdk/agent-python`) | Interop posture already matches where the market converged (MCP is the universal standard; AWS/Snowflake/Databricks all adopted it) |
| Eval-service: deterministic gates + LLM-judge (never gate alone), CI gate API, canaries with bootstrap CIs, agent SLOs | Maps directly onto bank model-validation language (challenger review, ongoing monitoring) |
| Learning loop M1–M2 live (transcripts → SFT datasets), M3 control plane built (GPU behind honest `GpuTrainer` port) | The "cost-per-decision declines with tenure" margin story — no major competitor has this narrative |
| `/welcome` (12 segments, 4 industries, no-invented-numbers rule), persona-scoped Help Center, demo-tenant tooling (`make demo-load PACK=…`) | Raw material for the self-serve funnel — currently unconnected to any funnel |

### 2.2 Honest gaps (from the repo's own docs + audit)

- No production cloud deployment (IaC written, never applied); no SOC 2/HITRUST (identified as the #1 revenue blocker, not started); scale proven at demo volume only; single-developer bus factor.
- Bedrock/Vertex providers raise `ProviderNotConfigured`; gVisor sandbox off-path; Presidio/ML guardrail classifiers are documented upgrade stubs (regex/heuristic versions are real); per-decision cost attribution (USG-FR-080..086) is design-only; SCIM returns 501.
- Several ui-web admin screens honestly render "not yet wired" panels.

---

## 3. Competitive landscape (mid-2026)

### 3.1 The four fronts

**Enterprise agent platforms.** Microsoft is defining "agent as managed identity" (Agent 365, $15/user/mo, GA May 2026) with Copilot Studio + Foundry underneath; Salesforce set the public unit-price benchmark (Flex Credits ~$0.10/action or $2/conversation; AgentExchange marketplace with 15/25% rev share); ServiceNow repackaged into 3 AI-native tiers with **AI Control Tower** (governance/inventory for *all* agents, incl. third-party) bundled in every tier; Palantir AIP remains the reference for governed ontology-grounded agents in regulated accounts — wins on FDE-heavy delivery, loses on cost/lock-in. Sierra (~$150M ARR, $15.8B val) proved outcome pricing (~$1–2.50/resolution) in customer service. Writer proved **vertical models sell** (Palmyra-Med/Fin). Glean owns the permission-aware knowledge layer.

**Agent frameworks.** Commoditizing and volatile — OpenAI retired Assistants API (Aug 2026) and deprecated AgentKit's visual builder ~8 months after launch; LangGraph/LangSmith is the OSS default; Temporal became the durability substrate ($5B val, OpenAI/ADP/Abridge run agents on it). Money concentrates in durable execution + observability + evals, not frameworks. **Datacern already made the right calls here** (LangGraph + Temporal + MCP) — interoperate, don't compete.

**Data+AI platforms adding agents (closest architectural competitors).** Databricks Agent Bricks GA'd at DAIS 2026 (100k+ agents claimed, Unity Catalog governance, secure sandboxes, supports Claude/LangGraph/CrewAI SDKs) and is publishing SR 26-2 banking guidance — moving directly into the MRM narrative. Snowflake Cortex Agents sell "data never leaves the perimeter" governance. **Both are single-ecosystem gravity wells; neither is neutral, and neither ships opinionated vertical compliance packs.**

**Governance/trust niche.** Fragmented across "document it" (Credo AI, Holistic AI — EU AI Act systems-of-record), "filter it" (Lakera-Check Point, NeMo Guardrails), and "route it" (LiteLLM, Portkey, Kong, TrueFoundry). Almost nobody fuses enforcement + audit + approval into the execution path. That fusion is Datacern's architecture.

### 3.2 2026 table-stakes checklist vs. Datacern

| Table-stakes capability | Datacern status |
|---|---|
| Multi-model LLM gateway, routing, budgets, cost attribution | ✅ Built (bedrock/vertex adapters pending) |
| MCP tools + A2A interop + external-framework support | ✅ Built (MCP gateway, signed A2A cards, external-agent SDK) |
| Durable resumable execution + step-level traces | ✅ Built (Temporal + run-trace visualizer) |
| Evals offline + online, LLM-judge + human review | ✅ Built |
| HITL checkpoints / approval routing | ✅ Built — stronger than anyone (four-eyes + signed grants) |
| Guardrails: injection defense, PII redaction | ✅ Real heuristics; ⚠️ ML-grade classifiers (Presidio/XPIA models) are the named upgrade |
| Agent identity, RBAC, least-privilege tool permissions | ✅ Built (agent principals, OBO intersection, toolset allow-lists) |
| Governed memory/RAG with row-level security | ✅ Built (4 scopes, schema-per-tenant + RLS, erasure cascade) |
| Observability + cost dashboards + audit | ✅ Built |
| SOC 2 / HIPAA deployment, SSO/SCIM, VPC/self-host | ⚠️ Self-host + BYO-IdP real; **certifications not started; SCIM 501** |
| Agent registry/inventory with lifecycle states ("Control Tower") | ⚠️ Exists functionally (catalog, versions, kill switches, rollouts) but not packaged/marketed as a fleet-governance surface |
| Consumption metering with transparent unit economics | ⚠️ Metering real; **no value-shaped meter, no published pricing, no billing** |

Conclusion: Datacern **meets or exceeds nearly every 2026 table-stake on the engineering axis** and fails almost every commercial-packaging one. The roadmap below is weighted accordingly.

---

## 4. Differentiation thesis (lock this in)

1. **Governance in the execution path, not beside it.** Sell "evidence-grade audit": four-eyes on every AI write, signed execution grants, tamper-evident chains, exportable evidence packs. Position against post-hoc logging (hyperscalers) and documentation-only governance (Credo-class). Note: GSA/DoD still restrict autonomous multi-step agents *without* per-transaction human-in-the-loop — **four-eyes is a feature, not friction**, and should be marketed exactly that way.
2. **One MRM plane for models *and* agents.** Banks must validate both under one framework; almost no vendor unifies experiments/pipelines/inference/evals with agent graphs under shared lineage and approvals. SR 26-2's agentic-AI vacuum means examiners will ask "show me your framework" — Datacern can *be* the framework.
3. **Neutral multi-cloud.** Iceberg + semantic layer + SQL broker + BYO-everything = "governed data plane anywhere," against Databricks/Snowflake perimeter gravity and hyperscaler lock-in.
4. **Vertical packs = time-to-audit, not time-to-demo.** Packs already carry regulatory tags (`hipaa`, `cms_0057_f`, `naic_ai_bulletin`). Extend them to carry **control mappings** (EU AI Act, SR 26-2, NIST AI RMF, ISO 42001) and eval suites — a pack install should shorten the customer's *compliance* timeline, which is the actual procurement bottleneck.
5. **Declining cost-per-decision.** The SLM distillation loop (deterministic-first routing + distilled bottom rungs) inverts typical agentic-AI economics. No competitor tells this story; it is Datacern's margin narrative and renewal narrative in one.

Anti-goals (validated by research): don't build another agent framework; don't compete with Sierra/Fin in horizontal customer service; don't chase sub-second adjudication categories (already conceded in the healthcare position doc); don't do pure per-seat pricing.

---

## 5. Roadmap A — Agentic-platform improvements

Ordered by (regulated-buyer impact × effort). These close the remaining ⚠️ rows in §3.2 and sharpen the wedge.

### A1. Ship the "Agent Control Tower" surface (packaging, ~90% built)
ServiceNow made fleet-level agent governance an expected surface. Datacern already has the parts: agent catalog + versions + A2A cards, kill switches, canary/shadow/pin/rollback, eval gates, per-agent cost dims, external-agent registry (BRD 60). Build **one admin page** (`/admin/agents` evolution) that presents: every agent (internal + external + tenant-custom) with lifecycle state, guardrail envelope, toolset, spend, eval status, last incident, kill switch — plus an exportable "agent inventory report" (EU AI Act system-inventory shaped). *Mostly UI + one BFF aggregation; disproportionate demo and compliance value.*

### A2. Value-shaped metering: the `governed_decision` meter (critical, small)
Add first-class meters for the unit of value: `governed_decision` (proposal decided), `case_resolved`, `auto_executed_action`, with dims (agent, pack, workspace, disposition, decision latency, human-edit distance). This closes the credibility gap between the pricing pitch ("per-decision usage") and the code (infra-shaped meters only), implements USG-FR-080..086, and is the substrate for billing (B1), the ROI dashboard (A3/B5), and any future outcome pricing. *Events already flow through `usage.metering.v1`; this is meter definitions + emission points in case-service/agent-runtime.*

### A3. Outcome & ROI instrumentation (BRD 55 acceleration)
Decision Outcome Monitoring is already designed (BRD 55) — prioritize it for *commercial* reasons, not just DI-completeness: outcome labels + per-decision cost + customer-editable time-saved assumptions = the exec value dashboard (§B5) that drives renewals (the Copilot Analytics / Glean-TEI pattern), and the measurement backbone if outcome pricing is ever offered.

### A4. Guardrail upgrades to ML-grade (named stubs → real)
Wire Presidio for PII and an ML injection classifier behind the existing adapter seams; keep heuristics as fallback. In regulated sales, "regex PII detection" will not survive a security review; the seams exist precisely for this.

### A5. Bedrock + Vertex provider adapters
Two typed `ProviderNotConfigured` stubs → real adapters. Matters because regulated buyers standardize on their cloud's model endpoint (Bedrock FedRAMP High/IL5 is often *the* approved path); also a precondition for credible AWS/GCP marketplace listings (§B8).

### A6. Compliance artifacts as product output
Extend audit-service evidence packs into auto-generated: **model/agent cards**, validation reports (from eval-service runs), human-oversight evidence (from proposal decisions), post-market monitoring reports (from BRD 55). Target formats buyers already name: EU AI Act Annex IV technical documentation, ISO 42001 clause evidence, NIST AI RMF mapping, SR 26-2-shaped validation memos. *This turns the audit layer from a defensive feature into a deliverable the compliance team budget pays for.*

### A7. Online decision API (R3 from the healthcare position doc)
The one Core-touching realtime gap: a synchronous `POST /decide` path (bounded-latency, deterministic-first, LLM-optional) with published SLOs. Unlocks the event-native healthcare/payments use cases already scoped in R1–R5.

### A8. Knowledge Spine continuation (WS2+)
Continue the ontology work — it is the counter to Palantir's ontology lock-in story ("ontology as open, queryable, versioned config on Iceberg — not consultant-ware") and grounds agents for the accuracy claims verticals need.

### A9. SCIM + tenant export
Close the two named enterprise-procurement 501s (IDN-FR-024 SCIM, IDN-FR-011 tenant export). Small, but both appear on every enterprise security questionnaire.

---

## 6. Roadmap B — GTM feature build

Phased: **Phase 1 unblocks revenue capture → Phase 2 opens self-serve top-of-funnel → Phase 3 wins procurement → Phase 4 compounds the ecosystem.** Each item names the existing asset it builds on.

### Phase 1 — Monetization spine (money can change hands)

**B1. Plans, entitlements & trials.** Introduce a commercial layer distinct from RBAC: `plan` (design-partner / pilot / enterprise / internal-demo), `entitlements` (pack SKUs, meter allowances, seat/workspace caps, feature gates), `trial` state with expiry on the tenant state machine. Builds on identity-service `Modules[]` (the proto-entitlement) and the provisioning saga. Every downstream GTM feature (trials, pack cross-sell, marketplace) depends on this object existing.

**B2. Metering → billing pipeline.** Don't build invoicing. Emit billable events from usage-service rollups + rate cards into a rating engine — **Lago** (AGPLv3, self-hostable — fits Datacern's self-host model and can ship inside customer VPCs) or **Stripe Billing/Metronome** for the hosted motion. Scope: billable-metric export, commitment/credit-wallet drawdown (the Salesforce Flex Credits / Temporal actions pattern), invoice generation, dunning. The BRD already anticipated this ("external billing system consumes chargeback exports") — now pick the system and wire it.

**B3. Published pricing + cost calculator.** A public pricing page: platform floor + per-governed-decision tiers + hard budget caps ("73% of agentic-AI projects bust budget; ours structurally can't") + pack add-ons, with an interactive calculator fed by the same rate-card math. The clearest lesson from Fin-vs-Sierra research: modelable-before-sales-contact pricing wins trust; opaque pricing is the #1 buyer complaint against Sierra-class vendors.

**B4. Lead capture hardening.** The demo-request webhook is fire-and-forget. Add: persistent lead store, dedupe, rate limiting, prospect confirmation email (notification-service already has real SMTP + templates), CRM forwarding. Hours of work; protects every lead the `/welcome` page ever generates.

**B5. Exec value/ROI dashboard.** Per-tenant: governed decisions completed, approval/edit/reject mix, hours saved (customer-editable per-task-minute assumptions × decisions), cost-per-decision vs. human baseline ($180/hr clinician framing), model-ladder savings from distillation, adoption by team — exportable as a board-ready report. Builds on A2/A3 + existing CostPanel. This is the renewal weapon (Copilot Analytics / Glean 141%-ROI-TEI pattern) and it uniquely showcases the declining-cost-per-decision story.

### Phase 2 — Self-serve entry (see value before wiring data)

**B6. Demo sandbox tenants (synthetic data, per vertical).** The no-dummy-data rule is right for *product* packs — keep it. Add a parallel, clearly-labeled **demo-tenant profile**: `make demo-load` already builds isolated seeded tenants per pack; productize that as (i) a hosted, resettable, cloneable-per-prospect sandbox for sales, and (ii) later, self-serve "explore a claims workspace" access from `/welcome`. Research: sandbox demos cut SE time ~30% and are the aha-moment vehicle for regulated buyers who cannot upload real data pre-contract.

**B7. POC mode + design-partner tooling.** A time-boxed POC tenant profile: pre-agreed success metrics captured at creation, a live success dashboard (from B5 metrics), expiry + conversion flow. Attacks the industry's ~5% pilot→production rate with the 90-day playbook (shadow → proposal → ROI report) already defined in the partner briefing. Design-partner variant: early-access flags + discounted entitlements (B1) + feedback instrumentation.

**B8. Product analytics.** Self-hostable analytics (PostHog fits the self-host posture) wired for: activation funnel (login → pack installed → first proposal → first approval), feature adoption per pack, per-persona engagement, drop-off. Without this, B6/B7 can't be tuned and expansion signals (B12) have no substrate. Respect tenancy: per-tenant opt-out, no PII in events.

**B9. `/welcome` funnel completion.** Immediate fixes: sign-in link in header/footer; then add trust/security page, legal pages (privacy/terms/DPA), and — once B6 exists — a "explore the sandbox" secondary CTA beside "Request a demo". Keep the no-invented-numbers rule; replace the missing social proof with the sandbox itself.

### Phase 3 — Trust as GTM (win procurement)

**B10. SOC 2 path + public trust center.** SOC 2 Type II is the stated #1 revenue blocker — start evidence collection now (the audit-service SOC 2 evidence-pack endpoint is a real head start; Vanta/Drata + the existing CI security-scan baseline). Ship a public trust center (SafeBase/Vanta-style): security whitepaper, subprocessors, pen-test summary, SIG/CAIQ answers, BAA/DPA templates (already promised in pack BRDs — write them). ISO 42001 next: it accelerates EU AI Act procurement ~30-40% and Bedrock/Anthropic/Microsoft all use it as a sales asset. Then HITRUST (healthcare-first) / FedRAMP (only with a federal design partner; note FedRAMP 20x fast-tracks AI services since Aug 2025).

**B11. Productized BYOC.** The WarpStream/Confluent "zero-access" pattern: split control/data plane — customer-VPC data plane, vendor control plane for upgrades + metering, air-gap-tolerant delayed usage reporting, customer-managed keys, offline image bundle + air-gap install guide. Terraform/Helm exist; this is packaging + one hosted control-plane service. For regulated buyers this converts "self-hostable" from an ops burden into a sovereignty selling point.

**B12. Cloud marketplace listings.** AWS Marketplace (AI Agents category now exists, MCP-compatible listings) + Azure/GCP: container packaging, metered-billing integration (from B2), **private offers** so deals burn down committed cloud spend (~$470B committed spend enterprise-wide; 100% EDP burn-down is the single biggest procurement accelerator). Depends on A5 (Bedrock/Vertex) for credibility on each cloud.

### Phase 4 — Ecosystem compounding

**B13. Pack marketplace v1: signing + registry + entitlements.** In order: (i) pack signing/provenance (cosign + checksums + SBOM; `publisher` becomes a keyed identity), (ii) a registry service decoupling distribution from the monorepo (`packctl publish/pull`), (iii) pack SKUs tied to entitlements (B1) with visible-but-locked previews in `/packs` + one-click trial activation (the a16z vertical-AI cross-sell mechanism), (iv) third-party author onboarding: certification checklist, sandboxed review, lint gates — the trust-per-listing model AgentExchange differentiates on. Start at **zero rev-share to seed supply** (Databricks Marketplace pattern); introduce 15-25% later (Salesforce pattern). This is the mechanism behind the briefing's "an SI shipping a pack we didn't build" milestone — which currently has none.

**B14. In-product expansion signals.** Budget/threshold events (already emitted at 80/95/100%) + entitlement limit-hits → contextual upgrade prompts at peak intent + CRM-visible signals. Existing metering is the raw material; this is the 2026-standard land-and-expand loop (top-quartile NRR ~104%; AI-signal-driven flows report +20-40% NRR).

**B15. Developer surface: public docs + SDK expansion.** Publish a docs site (quickstart, API reference from existing per-service OpenAPI specs, pack-authoring guide) and ship `sdk/agent-python` to PyPI + a TypeScript twin. The external-agent SDK is the best PLG wedge in the repo — *"your agent shouldn't write your systems of record directly; with this SDK it proposes instead"* — and it recruits the developer who then pulls the platform in. Publish a **Datacern MCP server** so Claude/Copilot/Agentforce agents can propose into Datacern's governance rails: embed into ecosystems rather than fight them (the Snowflake-MCP-bridge pattern).

---

## 7. Quick wins (days, not weeks)

1. Sign-in link on `/welcome` header/footer (B9) — existing customers currently have no path to `/login`.
2. `governed_decision` meter definition + emission (A2) — closes the pitch-vs-code gap.
3. Lead-capture hardening: store + dedupe + confirmation email (B4).
4. Prospect confirmation + welcome email templates in notification-service (supports B4/B1).
5. "Agent inventory export" (CSV/PDF of agent catalog + versions + guardrails + eval status) as a first Control-Tower artifact (A1).
6. BAA/DPA template docs in-repo + a first-pass security whitepaper from existing BRD/security content (B10).
7. Trial/expiry field on the tenant state machine (first slice of B1).
8. Publish `datacern-agent` to PyPI (B15).

---

## 8. Consolidated priority view

| # | Item | Roadmap | Effort | Unblocks |
|---|---|---|---|---|
| 1 | Value-shaped meters (`governed_decision`) | A2 | S | Pricing credibility, B2, B5 |
| 2 | Plans / entitlements / trials | B1 | M | Everything commercial |
| 3 | Billing pipeline (Lago or Stripe/Metronome) | B2 | M | Revenue capture |
| 4 | Exec ROI/value dashboard | B5 | M | Renewals, POC conversion |
| 5 | Agent Control Tower surface + inventory export | A1 | S–M | Demo, EU AI Act inventory |
| 6 | Demo sandbox tenants (hosted, per vertical) | B6 | M | Top-of-funnel, sales efficiency |
| 7 | SOC 2 start + trust center + BAA/DPA | B10 | M (long lead) | Every regulated deal |
| 8 | Published pricing + calculator | B3 | S | Trust, inbound qualification |
| 9 | Product analytics (self-hosted) | B8 | S–M | Funnel tuning, expansion signals |
| 10 | POC mode + design-partner tooling | B7 | M | Pilot→production conversion |
| 11 | Guardrails to ML-grade (Presidio/XPIA) | A4 | M | Security review survival |
| 12 | Compliance artifacts as product output | A6 | M | Compliance-budget revenue |
| 13 | Bedrock/Vertex adapters | A5 | S–M | Cloud-native deals, B12 |
| 14 | Productized BYOC (zero-access split-plane) | B11 | L | Sovereignty deals |
| 15 | Cloud marketplace listings + private offers | B12 | M | Procurement channel |
| 16 | Pack marketplace v1 (sign → registry → SKUs) | B13 | L | Ecosystem thesis |
| 17 | Expansion signals in-product | B14 | S | NRR |
| 18 | Docs site + SDK expansion + Datacern MCP server | B15 | M | Developer wedge |
| 19 | Online decision API + SLOs | A7 | M–L | Realtime verticals |
| 20 | SCIM + tenant export | A9 | S | Procurement checklists |

Sequencing logic: items 1–4 make the existing enterprise motion able to capture and defend revenue (no channel dependency); 5–10 make the platform *showable and buyable* without founder-led heroics; 11–15 win regulated procurement; 16–20 compound ecosystem and expansion. The design-partner motion (already defined in the partner briefing) should run in parallel from day one — items 6, 7, and 10 are what make it repeatable.

---

## 9. Risks & open questions

- **Certification lead time (6–12 mo) is the critical path to regulated revenue** — nothing in this roadmap shortens it except starting now; the partner WS-3 co-staffing ask remains the right mitigation.
- **Outcome-based pricing**: attractive narrative, but research shows definition ambiguity and rev-rec complexity (Deloitte, Jun 2026). Recommendation: price on *governed decisions* (objective, already meterable), keep outcome pricing as a negotiated option once BRD 55 outcome labels mature.
- **Marketplace timing**: don't build B13 before two external parties actually want to ship a pack; signing/registry (its first slice) is justified earlier purely as supply-chain security.
- **Demo-sandbox vs. no-dummy-data tension**: resolved by profile separation (§B6), but enforcement should be structural (demo tenants visibly watermarked, non-upgradeable to paid without reset) so the integrity rule survives sales pressure.
- **Single-ecosystem competitors will bundle**: Databricks/Snowflake will keep absorbing governance features. The moat is neutrality + execution-path enforcement + vertical packs — the roadmap deliberately invests where bundlers structurally can't follow (multi-cloud neutrality, four-eyes-native design, regulator-artifact output).
