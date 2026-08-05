# Build the agents. Not the fifteen months underneath them.

**Datacern AI — for teams building agentic AI platforms for regulated operations.**

*Audience: ISVs, systems integrators, and platform teams who are building their own agentic
product for claims, disputes, appeals, AML, underwriting, or any case-based regulated workflow.*

*Every capability claim in this document is checkable in the repository at the cited path.
The limits are stated next to the claims, and §7 lists what is not true yet. If you are
evaluating a foundation to bet a product on, you need the second list more than the first.*

---

## 1. The pitch

You know what your agent should do. You have the domain expertise, the customer
relationships, and a clear view of the decision your AI should draft.

Then you start building, and you discover the product is the smallest part of the work.

Before a single regulated customer will run your agent, you need per-tenant isolation that
survives an audit. A tool plane that can prove an agent was authorized to make each call. A
tamper-evident record of who proposed what, who approved it, and what changed. Budget caps
that fail closed instead of producing a surprise invoice. A data plane that speaks X12 and
FHIR. An evaluation harness that can gate a model promotion. Nineteen other things, none of
which appear in your pitch deck, all of which appear in your customer's security
questionnaire.

**Datacern is that layer, built and tested.** Governance, multi-tenancy, the tool plane, the
lakehouse data plane, the learning loop, cost control, audit, and the vertical packaging
system. You bring the agents, the domain model, and the customer.

The differentiator we built for is not *AI that decides*. It is **AI decisions your
customer's regulator can audit** — evidence, proposer, approver, and effect, on a
hash-chained record. That property is extremely hard to retrofit and nearly free to inherit.

---

## 2. What you would otherwise build yourself

| You need | Datacern ships | Where to look |
|---|---|---|
| **A governance gate that holds** | Self-approval rejected server-side. High-risk, destructive, and admin actions always require a second, distinct approver — with no tenant opt-out. Agent tool calls require signed on-behalf-of grants; a forged grant is rejected in the E2E test, not just in policy. | `agent-runtime/app/proposals/service.py`, `tool-plane/internal/enforce/pipeline.go` |
| **Multi-tenancy an auditor accepts** | Postgres RLS with `FORCE ROW LEVEL SECURITY` in all 21 stateful services. Tenant pinned from the verified JWT only — never from a request body. OPA checks on guarded routes; cross-tenant denials audited. | `docs/security/SECURITY_POSTURE.md` §1–2 |
| **A tamper-evident record** | Per-tenant hash-chained audit log in ClickHouse (7-year TTL), plus a separate S3 Object-Lock **COMPLIANCE-mode WORM export**. SIEM output in JSON, CEF, and LEEF. | `audit-service/internal/chstore/`, `internal/worm/worm.go` |
| **AI spend that cannot run away** | Hierarchical hard caps — platform → tenant → workspace → principal → key — that **fail closed**. Token metering per tenant, workspace, user, agent, and resource. A deterministic-first model ladder that degrades to the cheapest rung under budget pressure instead of erroring. | `ai-gateway/app/domain/budgets.py`, `ladders.py` |
| **Prompt-injection defense you can describe in a security review** | Evidence fencing, sanitization, and injection signatures. Untrusted input forces a human approval leg — rule-of-two — at the proposal chokepoint, so a successful injection still cannot write unilaterally. | `agent-runtime/app/graphs/evidence_guard.py` |
| **A real data plane** | Iceberg lakehouse on S3-compatible storage. Trino and DuckDB with size-based routing. CSV/JSON/Parquet/Avro/XML, plus standards parsers with tests: X12 (deep — 835/834/271/277, ACKs, control numbers, 276 write-back), FHIR, HL7v2. ISO 20022 and ACORD as narrower slices. | `services/ingestion-service/app/domain/`, `services/query-service/internal/engine/` |
| **The learning loop** | Human corrections become labeled training data → real model training logged to MLflow (sklearn / xgboost / lightgbm) → promotion behind a hard four-eyes gate → batch inference on new work. Proven end to end by a 12-step run against the real stack. | `deploy/e2e/driver.py` steps H–L |
| **Enterprise identity** | Per-tenant bring-your-own OIDC IdP with real discovery and JWKS, routed by issuer. Embedded white-label UI with per-user embed SSO and per-tenant `frame-ancestors`. | `identity-service/internal/domain/token_oidc.go` |
| **Semantics, not just tables** | A governed ontology (the domain type model your agents ground on), a semantic layer that compiles to SQL, saved queries, dashboards, and chart families beyond time-series — grids, heatmaps, networks, metrics — with drill-down, export, and scheduled digests. | `services/semantic-service/`, `services/chart-service/` |
| **Evaluation with teeth** | Suites and gate rules, so "is this agent good enough to promote" is a check that runs, not a meeting. | `services/eval-service/` |

Twenty-five deployable services (`deploy/services.yaml`): eleven Go, eleven Python, a GraphQL
BFF, and a Next.js UI. One versioned Core.

---

## 3. Capability Packs — how your vertical ships

The extension model is the part most platform teams underestimate, so it is worth being
concrete.

A **Capability Pack** is an installable vertical: roughly twenty component kinds — ontology,
semantic models, dashboards, decision tables, agent configurations, guardrails — versioned and
shipped as a unit. Install, upgrade, rollback, and drift detection are API operations.

Two design decisions you inherit, both of which will save you a support quarter:

- **A pack ships zero data.** It refuses to install until the customer's real data satisfies
  its declared contract. Nothing half-works and then quietly produces a chart of nothing.
- **A blocking coherence checker (C1–C11)** validates cross-component consistency before a
  pack lands. A dashboard that references a measure the semantic model does not define is
  caught at authoring time, not by the customer.

**Twenty-eight packs are built** — twenty-seven verticals at v2.1.0 plus a shared library:
insurance claims, banking AML, card disputes, credit disputes, chargeback representment,
payer FWA/SIU, healthcare provider RCM, care management, post-acute care, pharmacovigilance,
pharmacy benefit management, benefits appeals, workers' comp, trucking claims, construction
claims, warranty claims, device complaints, manufacturing MRB, AP invoice audit, mortgage loss
mitigation, tax notices, trade compliance, underwriting intake, background screening, seller
vetting, trust and safety appeals, utility inspections.

Use them as shipping product, as reference implementations, or as the template for the pack
you author for your own vertical.

---

## 4. Your agents, on our rails

Nine built-in agents ship in the catalog — case triage, governance, analytics, onboarding,
dashboard designer, model training, ML engineer, inference, and a meta-router — all nine
passing a live roster test against a real LLM.

More relevant to you: **tenant-defined custom agents.** Configuration, not code — locked to
one vetted graph, capped at propose-only, with a mandatory tool allow-list. Your customer's
domain expert can define an agent without your engineering team shipping a release, and
without that agent being able to write unilaterally.

The model layer is yours to choose. Bedrock, Vertex, Azure OpenAI, Anthropic, OpenAI, or
in-cluster Ollama — the gateway abstracts the provider, meters the spend, and enforces the
budget regardless of which rung you land on.

---

## 5. Why this is credible

- **~2,560 test functions in-repo** — roughly 1,650 Python, 940 Go, 940 TypeScript.
- **A full 12-step E2E journey** that runs the entire lifecycle against the real stack — real
  LLM, real Kafka, real object storage, real MLflow, real Temporal — including the negative
  assertions that matter: a forged grant is rejected, self-approval is rejected.
- **78 numbered BRDs.** Capabilities were specified before they were built, and the
  documentation convention is CI-enforced — including the fact-checker that verifies the
  numbers in documents like this one still match the repository.
- **A security posture document that lists what we do not claim**, cited to code.

On CI, we quote the real number: **29 of 30 executed jobs green** on latest `main`, with one
known-flaky realtime-hub timing test, and a separate security-scan workflow red on a Trivy
container-CVE gate for pre-existing base-image findings. "All green" is not our claim.

---

## 6. Who this is for

**A strong fit if** you are building an agentic product for a regulated, case-based workflow;
your buyer's security review is a real gate; you need multi-tenancy and audit on day one; and
your differentiation is domain judgment rather than platform plumbing.

**A poor fit if** you want a hosted SaaS you can sign up for this afternoon, your workflow is
not case-shaped, or human approval in the loop defeats your product's purpose. The governance
gate is not optional, and it is not a feature flag.

---

## 7. What is not true yet

This section is why the rest of the document is worth reading. A competent diligence engineer
finds all of it anyway; better it comes from us.

- **Zero customers, zero pilots, zero revenue.** The platform has never run outside
  development machines and CI.
- **No production cloud deployment.** Terraform for AWS/GCP/Azure, a Helm chart, and K8s
  manifests exist and build in CI — they have never been applied to a real cloud account.
- **No SOC 2, no third-party penetration test.** The controls are implemented and cited; they
  have not been externally attested.
- **SCIM is a stub, and there is no SAML.** OIDC is real; those two are not.
- **ISO 20022 and ACORD are narrow slices** — camt.052/053/054 and flat policy rows — not the
  depth of the X12 support.

What exists is a deep, tested, single-machine-provable platform. The distance between that and
a first production deployment is real, scoped, and something we would rather discuss in the
first meeting than the fourth.

---

## 8. The conversation we want

If you are eighteen months from a governed agentic platform and would rather be three months
from your agents running on one, the useful next step is narrow: bring your hardest
compliance requirement and your ugliest data format, and we will show you where each one
lands in the code.

**Companion reading:** [`DATACERN_PARTNER_BRIEFING.md`](DATACERN_PARTNER_BRIEFING.md) ·
[`security/SECURITY_POSTURE.md`](security/SECURITY_POSTURE.md) ·
[`demo/RUNBOOK.md`](demo/RUNBOOK.md) · [`packs/PACK_AUTHORING_GUIDE.md`](../packs/PACK_AUTHORING_GUIDE.md)
