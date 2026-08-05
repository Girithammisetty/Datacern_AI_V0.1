# Datacern AI — Partner & Investor Briefing

**Prepared:** 2026-07-26 · **Audience:** investor conversations and IT-consulting / SI partner meetings.

**Rule #1 of this document: every factual claim was verified against the codebase, CI, or a recorded live run on 2026-07-26.** Where a capability has a limit, the limit is stated next to the claim — not hidden in an appendix. Anything aspirational is labeled **ROADMAP**. Companion documents: [`docs/security/SECURITY_POSTURE.md`](security/SECURITY_POSTURE.md) (code-cited security controls and non-claims), [`docs/demo/RUNBOOK.md`](demo/RUNBOOK.md) (the live-verified demo, including its own "known limits" section), and [`DATACERN_2035_VISION.md`](DATACERN_2035_VISION.md) (the researched 5–10 year direction — clearly separated bets, not claims).

Sections are marked **[SHARE]** (safe to present or hand over) or **[INTERNAL]** (your prep only).

---

## 1. The 60-second pitch — [SHARE]

**Datacern AI is a governed Decision Intelligence platform for regulated operations** — insurance claims, banking AML, card disputes, appeals, and 20+ other case-based verticals. AI agents read the file, apply the rules, and draft the decision with cited evidence. A named human approves it — by default for every AI-proposed write, and **enforced without exception for high-risk, destructive, and admin actions**, where a second, different person must sign. Every human correction becomes labeled training data that retrains and re-promotes models under the same approval gate.

The differentiator is not "AI that decides" — it is **AI decisions your regulator can audit**: evidence, proposer, approver, and effect, on a tamper-evident record.

One platform Core, versioned. Verticals ship as installable **Capability Packs** (28 built). A pack deliberately ships **zero data** and refuses to install until the customer's real data satisfies its declared contract — nothing on the platform half-works by design.

**And the honest close, which is part of the pitch:** we are pre-revenue, pre-deployment, pre-certification. What exists is a deep, tested, single-machine-provable platform. What we're raising/partnering for is exactly the distance between that and a first production customer. §3 lists that distance item by item.

---

## 2. What is verifiably built — [SHARE]

Every row below is checkable in the repository at the cited location. Hand this table to their engineers.

| Area | Verified state | Evidence anchor |
|---|---|---|
| **Core services** | 25 services: 11 Go (identity, RBAC, case, tool-plane, audit, notification, usage, chart, query, realtime, fhir-bridge), 11 Python (agents, AI gateway, data/ML plane), GraphQL BFF, Next.js UI | `services/` |
| **Agents** | 9 built-in agents, all 9 passing a live real-LLM roster test; plus tenant-defined custom agents — configuration only, locked to one vetted graph, capped at propose-only tier, mandatory tool allow-list | `services/agent-runtime/app/agents/catalog.py`, `tests/integration/test_agent_roster_real_llm.py` |
| **Governance gate** | Self-approval rejected server-side; high-risk always requires a distinct approver with no tenant opt-out; agent tool calls require signed on-behalf-of grants through a governed tool plane; a forged grant is rejected in the E2E test | `agent-runtime/app/proposals/service.py`, `tool-plane/internal/enforce/pipeline.go`, `deploy/e2e/driver.py` step E |
| **Learning loop** | Human corrections → labeled dataset → real model training logged to MLflow (sklearn/xgboost/lightgbm) → promotion behind a hard four-eyes gate → batch inference on new work. Proven by a 12-step E2E run on the real stack (Kafka, MinIO/Iceberg, OpenSearch, Ollama, MLflow, Temporal) | `deploy/e2e/driver.py` steps H–L |
| **Vertical packs** | 28 installable packs (27 vertical at v2.1.0 + 1 shared library), each ~20 component kinds (ontology, semantic models, dashboards, decision tables, agent configs, guardrails). Install / upgrade / rollback / drift-detection API; blocking C1–C11 cross-component coherence checker; fail-closed data-binding contract | `packs/`, `services/pack-service/app/api/routes/installs.py`, `packs/packctl/coherence.py` |
| **Data plane** | CSV/JSON/Parquet/Avro/XML plus standards parsers with tests: X12 (deep: 835/834/271/277, ACKs, control numbers, 276 write-back), FHIR, HL7v2; ISO 20022 and ACORD as narrower slices (camt.052/053/054, flat policy rows). Iceberg lakehouse on S3-compatible storage; Trino + DuckDB engines with size-based routing | `services/ingestion-service/app/domain/`, `libs/py-common/datacern_common/iceberg.py`, `services/query-service/internal/engine/` |
| **Multi-tenancy** | Postgres RLS with `FORCE ROW LEVEL SECURITY` in all 21 stateful services; tenant pinned from the verified JWT only; OPA policy checks on guarded routes; cross-tenant denials audited | `docs/security/SECURITY_POSTURE.md` §1–2 |
| **Enterprise identity** | Per-tenant BYO OIDC IdP (real discovery/JWKS, routed by issuer); embedded white-label UI with per-user embed SSO and per-tenant frame-ancestors | `identity-service/internal/domain/token_oidc.go`, `token_embed_oidc.go` |
| **Audit** | Per-tenant hash-chained log in ClickHouse (7-year TTL) plus a separate S3 Object-Lock **COMPLIANCE-mode WORM export** (7-year default); SIEM formatting in JSON/CEF/LEEF | `audit-service/internal/chstore/`, `internal/worm/worm.go` |
| **AI cost control** | Hierarchical hard budget caps (platform→tenant→workspace→principal→key) that fail closed; token metering per tenant/workspace/user/agent/resource; deterministic-first model ladder that degrades to the cheapest rung under budget pressure | `ai-gateway/app/domain/budgets.py`, `ladders.py` |
| **Prompt-injection defense** | Evidence fencing + sanitization + injection signatures; untrusted input forces a human approval leg (rule-of-two) at the proposal chokepoint | `agent-runtime/app/graphs/evidence_guard.py`, `proposals/service.py` |
| **Self-serve demo** | Public signup page provisions a real 14-day demo tenant (rate-limited, capped, TTL-reaped, audit-logged), seeds a payer-claims scenario, and shows a guided in-product walkthrough | `identity-service/internal/domain/demo_public_signup.go`, `ui-web/src/app/live-demo/` |
| **Observability** | OTel tracing + RED metrics wired in all three runtimes (opt-in via env, not always-on); health self-diagnosis (`make doctor`) | `libs/go-common/otelx/`, `libs/py-common/datacern_common/otelx.py` |
| **Deployment artifacts** | One-machine bring-up (`make up`); container builds for all services; Helm chart; Terraform for AWS/GCP/Azure; K8s manifests. **Written and CI-built, never applied to a production cloud** | `deploy/` |

### Engineering quality evidence — [SHARE]

- **~2,560 test functions in-repo** (static count, 2026-07-26: ~1,650 Python, ~940 Go, ~940 TypeScript). Do not quote a "tests passing" number without the CI caveat below.
- **CI on the latest `main` commit: 29 of 30 executed jobs green.** The one red job is a known-flaky realtime-hub timing test. The separate security-scan workflow is red on a Trivy container-CVE gate (pre-existing base-image findings, tracked). "All green" is not our claim; "green except two known, tracked items" is.
- **Full E2E journey test** (`deploy/e2e/driver.py`, 12 steps) runs the entire claims lifecycle against the real stack — real local LLM, real Kafka, real object storage, real MLflow — including negative assertions (forged grant rejected, self-approval rejected).
- **78 numbered BRDs + master** — capabilities specified before build; docs convention enforced.
- **Security controls implemented and cited** in `docs/security/SECURITY_POSTURE.md`, which also lists what we do **not** claim (no SOC 2, no third-party pen test, SCIM stub, no SAML).

---

## 3. What is not true yet — [SHARE the categories; know the details cold]

This is the section that makes the rest of the document credible. A competent diligence engineer will find all of it; better they hear it from us, framed as scoped work.

**Company-stage gaps**
1. **Zero customers, zero pilots, zero revenue.** The platform has never run outside development machines and CI.
2. **No production cloud deployment.** Terraform/Helm exist and build in CI but have never been applied to a real cloud account.
3. **No compliance certifications.** SOC 2 / HITRUST not started; identified internally as the #1 blocker to a first regulated customer (6–12 month lead time).
4. **No third-party penetration test.** Internal cross-tenant probes exist and pass, but cover 4 of 20+ tenant-scoped services.
5. **Scale proven at demo volume only.** A written scalability audit lists the known bottlenecks; no load testing has been run.
6. **Single-developer bus factor.** Built by one person with AI tooling; 72 BRDs and enforced docs conventions mitigate, not eliminate.

**Product gaps the code itself admits** (each is a scoped, partner-sized work item — see §4)
7. **Four-eyes is the default, not a universal.** Tenants can policy-enable auto-execution for low-risk, non-destructive writes (`actor = "policy:auto"`), and `write-direct`-tier tools bypass the proposal gate. High-risk/destructive/admin actions cannot bypass a distinct human approver.
8. **Autonomous, event-triggered agent runs are off.** The runbook's own words: the intake queue fills itself once a trigger rule is written, but "the 'agent reads it and drafts' half is not running in any shipped configuration." Human-initiated agent work is the solid path today.
9. **Entity-resolution merge approval is missing.** Matching, scoring, and golden-record materialization of auto-merge clusters are real; the human review queue for borderline candidates is **read-only** — no approve/reject/apply endpoint yet.
10. **SIEM export can't authenticate.** Formatting and delivery work, but credential resolution for the destination is unimplemented — a Splunk HEC / bearer-token endpoint won't accept our export today.
11. **Cost attribution is per agent/user/resource, not per decision.** There is no join key linking LLM spend to an individual governed decision; "cost per decision" is a reporting roadmap item, not a current query.
12. **LLM providers: 3 real, 2 declared.** Ollama, OpenAI/Azure-OpenAI, and Anthropic have working adapters; Bedrock and Vertex are accepted by the schema but have no adapter.
13. **4 of 28 packs have productized demo bundles** (insurance-claims-payer — the self-serve default — and card-disputes). The other 24 install and pass coherence checks but have no seeded demo scenario.
14. **The self-serve demo-signup E2E spec is written but has never been executed** (needs a super-admin credential the harness doesn't provide), and the public signup endpoint has rate limits and caps but **no CAPTCHA**.
15. **SLM distillation is half-built.** Training control plane and LoRA fine-tune scaffolding exist; persisting and serving the tuned model as a gateway rung is explicitly "the next increment."
16. **BYO secrets is Python-side.** Real Vault/AWS/GCP adapters for Python services; Go services have signing-key adapters only.

**[INTERNAL] Disclosure line:** share the numbered categories freely — they demonstrate self-knowledge. Volunteer items 7–16 when the counterpart is technical; every one has a mitigation or is a natural SOW. Do not volunteer test-failure history or internal incident notes unprompted; do answer honestly if asked.

---

## 4. What we need from a partner — four workstreams — [SHARE]

The gap list in §3 is the work order. Concrete, scoped, and priced realistically:

### WS-1 · Testing & QA
- **Execute the written-but-never-run suites**: the demo-signup Playwright journey, load profiles from the documented bottleneck list, the 16 remaining cross-tenant probe targets.
- **Performance/load testing** against stated targets (millions of cases per tenant).
- **External pen test** + remediation — doubles as SOC 2 evidence.
- *Good first SOW: 6–8 weeks, fixed scope, measurable exit criteria (load numbers, pen-test report, probe coverage).*

### WS-2 · Offshore engineering
Parallelizable, Core-protected lanes, in priority order:
- **Close the named product gaps** from §3: ER merge-approval endpoint, SIEM credential resolution, decision-level cost join, Bedrock/Vertex adapters, CAPTCHA on public signup. Each is a well-bounded, well-documented feature with existing patterns to follow.
- **Pack authoring** (framework + authoring guide + coherence checker exist; a pack is config, not platform code) and **demo bundles for the other 26 packs** — the highest-leverage sales work available.
- **Connectors** (core-admin systems, Snowflake/Databricks, SFTP/EDI).
- Core platform changes stay with named, vetted seniors until trust is established.

### WS-3 · Infrastructure & operations
- **First production deployment** on one cloud using the existing Terraform + Helm (never applied — this is literally workstream #1).
- **SRE build-out**: turn the wired-but-opt-in OTel/metrics into always-on monitoring, alerting, runbooks, backup/DR.
- **Compliance engineering**: SOC 2 Type II (HITRUST if healthcare-first) — the critical path to revenue; say it that way.
- **Hosted demo environment** so the self-serve demo runs off a URL, not a laptop.

### WS-4 · GTM
- **Design-partner sourcing** against the written ICP (regional health plans, mid-cap banks for disputes/AML). Ask directly for named, warm logos.
- **Pilot delivery** using the 90-day pilot playbook (shadow → proposal → ROI report).
- **Collateral** built from this document and the demo walkthrough page — no invented numbers, ever; the honesty is the brand.

---

## 5. Partnership structure — [SHARE the model, INTERNAL the guardrails]

### Phasing — [SHARE]

| Phase | Model | Money flow |
|---|---|---|
| **1. Prove-out (0–3 mo)** | Paid services engagement: 1–2 fixed-scope SOWs from WS-1/WS-3 | We pay them (or at-risk pricing if they want to earn the partnership) |
| **2. Delivery partner (3–12 mo)** | Certified implementation partner on jointly-closed pilots; services revenue theirs, subscription ours | Customer pays each separately |
| **3. Ecosystem (12 mo+)** | Co-sell + resale margin; they publish packs on the marketplace ("an SI shipping a pack we didn't build is the moment we know we're a platform") | Referral/resale + their pack revenue |

Directional market economics: referral ~10–15% of first-year subscription; resale margin ~20–30%; SI services typically 1–3× platform subscription on enterprise deployments — that services pool is why this is attractive to them; say so explicitly.

### Non-negotiable guardrails — [INTERNAL]

1. **IP:** work-for-hire, IP assigned. No Core co-ownership, no OEM/white-label rights early, standard escrow only.
2. **No exclusivity** until earned with closed revenue; offer "first-mover preference" language instead.
3. **No equity for services.**
4. **Code-access tiers:** packs/tests/docs for offshore; Core only for named, vetted seniors; branch protection + our review as merge gate.
5. **Offshore security:** no production/customer data offshore ever; isolated dev environments (the `make up` stack exists for exactly this); named resources; their ISO 27001/SOC 2 posture verified; audit rights; background checks for Core access.
6. **Governance cadence:** weekly delivery standup, monthly steering, milestone-gated payments with written acceptance criteria.

---

## 6. Pricing — what to say when asked — [SHARE]

The pricing *architecture* is designed into the product; the parts that are built vs. roadmap are marked:

1. **Platform floor** — annual subscription per tenant/use-case (commercial plans, seat/quota enforcement: **built**).
2. **Usage tier** — consumption pricing on metered units. Metering by tenant/workspace/user/agent and a governed-decision counter: **built**. Per-decision *cost* attribution: **ROADMAP** (§3.11).
3. **Hard budget caps** — customer-set circuit breakers that fail closed: **built**, and a genuine differentiator worth demoing.
4. **Packs as priced add-ons** on the Core subscription.
5. **Bounded professional services** — platform PS limited to first-pilot integration; long-tail services deliberately reserved for certified partners.
6. **Margin thesis (ROADMAP, honest framing):** deterministic-first routing and budget-degraded model ladders are built; SLM distillation is half-built. The *design goal* is cost-per-decision declining with tenure. Present it as the engineered intent with the routing/budget half already real — not as an observed result, because there are no production tenants to observe.

**Design-partner terms** (first 3 lighthouse customers): ~60% off list year 1, co-development input, case-study rights. **List price:** "finalized per-vertical with the first design-partner cohort"; if pressed for magnitude, mid-six-figure annual platform+pack ACV at enterprise scale, anchored to displaced review-labor cost.

---

## 7. The demo — [SHARE]

Two demo modes exist. Both are real; know which one you're in.

**A. Self-serve (no operator):** the public page at `/live-demo` provisions a real, isolated, 14-day demo tenant (payer prior-auth scenario) and walks the visitor through a 5-step guided tour in-product. Guardrails on the endpoint: 3 signups/IP/hour, 8/email-domain/day, 20 concurrent demo tenants max, disposable-email denylist, auto-teardown. **Public walkthrough page:** `/welcome/walkthrough` narrates the same journey with real product flows before anyone signs up.

**B. Operated (the strong version, `make up` on a workstation):** full platform + seeded vertical in minutes. The five beats, all live-verified:

1. **The refusal.** Install a pack against a tenant with no data → it fails closed, naming every missing field. 30 seconds; proves the governance thesis better than any slide.
2. **Worklist → Copilot triage.** Real seeded queue; open the flagged case; the agent drafts a disposition with cited evidence and confidence, against a real local LLM.
3. **Approval inbox.** Approve the proposal — and show that self-approval is rejected server-side, and high-risk requires a second person.
4. **Learning loop.** Corrections → labeled examples → the retrained model in MLflow → promoted through the same four-eyes gate → new claims scored by it. No mocks anywhere in the path.
5. **Audit trail.** Every step above as tamper-evident events with proposer, approver, and effect. Close: *"Every AI action you just saw is governed, attributed, and replayable — that's the product."*

**Metrics to have memorized:** 25 services · 9 agents (9/9 live-tested) · 28 packs · 72 BRDs · ~2,560 test functions · 12-step E2E on the real stack · IaC for 3 clouds written, 0 applied.

**[INTERNAL] Do-not-say list** (each is checkable and currently false): "all tests green" · "four-eyes on every write, no exceptions" · "cost per decision" as a live metric · "SOC 2 in progress" · "Bedrock and Vertex supported" · "packs come with demo data" · "fully autonomous agents" · any customer/pilot reference.

---

## 8. Qualify them hard — [INTERNAL]

1. **Vertical proof:** named health-plan / bank deliveries; references we can call.
2. **GTM substance:** for each promised logo — who is the sponsor, when did you last transact?
3. **Testing credentials:** a sample perf-test report and pen-test deliverable from a comparable engagement.
4. **Offshore specifics:** locations, ISO 27001/SOC 2, attrition, IP assignment and data isolation practice.
5. **Compliance experience:** have they carried a product through SOC 2 Type II / HITRUST? Real timeline and cost.
6. **Commercial model:** sample MSA/SOW, rate card, partner-tier history with other ISVs.
7. **Skin in the game:** discounted/at-risk first SOW tied to the first closed customer?
8. **Continuity:** named phase-1 team, key-person commitments.

**Walk-away signals:** exclusivity demands before delivery · IP co-ownership or "our own accelerator on top" ambiguity · equity for services · logo lists with no named sponsors · pushing a large offshore team onto Core · open-ended T&M with no milestone gates · refusal of the offshore security terms.

---

## 9. Meeting agenda — [SHARE]

1. Intros + NDA confirmation (5 min)
2. Demo — the five beats of §7B (10 min)
3. Platform state: §2 table + §3 gap list, presented together (10 min)
4. Their capabilities walkthrough (15 min)
5. The four workstreams; which two start first (15 min)
6. Partnership phasing + commercial principles (10 min)
7. Next steps: mutual references, phase-1 SOW draft, second meeting date (5 min)

**The close:** "You've seen exactly what's built and exactly what isn't — the gap list is the work order, and the first two SOWs are the audition. If delivery is strong, the certified-partner services pool on every future customer is yours to lose."
