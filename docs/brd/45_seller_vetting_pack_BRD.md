# BRD 45 — `seller-vetting` capability pack

**Deliverable type:** Capability Pack (BRD 23) · **Publisher:** Windrose · **Initial version:** 1.0.0
**Horizon:** 3 pack wave (post-BRD-32). Reference pattern: BRD 24/30/32.
**Status:** v1.0.0 authored, install pending; pack-service-tier components declared `deferred` in the manifest.

---

## 1. Overview

**Purpose.** Marketplace seller vetting and counterfeit/IP-enforcement adjudication AI: onboarding KYB verification with INFORM Consumers Act / EU DSA trader-traceability awareness, counterfeit takedown triage grounded in test-buy and signal-stack evidence, DMCA/trademark claim adjudication that weighs first-sale and claim-abuse defenses, linked-account ring detection, and reinstatement plan-of-action review. Sells to e-commerce marketplaces, app stores, resale platforms, and B2B marketplaces.

**Why this vertical.** Marketplaces carry statutory seller-verification duties (INFORM Consumers Act in the US, DSA trader traceability in the EU) with suspension mandates for non-compliance, plus DMCA safe-harbor clocks and brand-partner SLAs on takedown response; counterfeit and ban-evasion rings scale industrially while false brand claims knock out lawful resellers. Every determination is documented, appealable, and evidence-driven — evidence cuts BOTH ways (enforce vs. protect the seller), the exact governed human-in-the-loop decision shape of the Windrose Core, proven by the BRD 30/32 adjudication packs.

**Business value.** Verification-deadline compliance (INFORM/DSA clocks), takedown-response SLA adherence, counterfeit GMV removed faster (signal-stack ranking + test-buy corroboration), lawful-reseller protection (claim-evidence burden + claimant accuracy tracking), ring-resurrection loss reduction, and appeal-ready decision files (every action carries its evidence + provenance).

**In scope.** Vetting/enforcement triage copilot, response-deadline tracking, counterfeit takedown workflow, IP-claim adjudication (first-sale aware), KYB onboarding/re-screen reviews, linked-account ring watch, reinstatement review, marketplace-integrity KPI semantic model + dashboards, seller-category network analytics, INFORM/DMCA/KYB grounding, listing-anomaly + review-outcome pipelines.

**Out of scope.** Payments fraud and chargebacks (BRD 32); buyer-side abuse (returns fraud, review manipulation); proactive catalog-wide image-matching infrastructure (detector platform product — this pack consumes detector triggers); customs/border enforcement coordination; brand-side claim filing tools.

## 2. Actors & user stories

**Personas:** Vetting Analyst (VA), IP Claims Reviewer (ICR), Marketplace Integrity Investigator (MII), Marketplace Trust Manager (MTM), Marketplace Compliance Auditor (MCA), Tenant Admin (TA).

- **US-1** As a VA, my queue ranks open reviews by deadline runway × GMV at risk × severity (never FIFO); each case shows the listing and seller evidence, the seller's enforcement history, and the copilot's proposed disposition with cited row ids.
- **US-2** As a VA on a KYB mismatch, I see the verification clock and the exact mismatch (payout banking name vs. registered entity), and the copilot reminds me suspension follows notice if corrected documentation doesn't arrive in the window.
- **US-3** As an MII, linked-account alerts land with the shared attributes assembled (payout banking, addresses, device fingerprints) and the network-suspension evidence bar stated — multiple corroborated linkages, each documented.
- **US-4** As an ICR, a brand trademark claim against an apparently genuine reseller surfaces the first-sale analysis: the claimant's evidence burden (non-genuineness or material difference), the seller's pricing/photography/complaint posture, and the claimant's prior accuracy.
- **US-5** As an MTM, listing removals, network suspensions, and claim rejections come to me four-eyes: the analyst proposes, I approve; every rejection's note must record why the evidence failed (the claim-abuse defense file).
- **US-6** As an MTM, I see enforcement rate, claim-rejection rate, evidence-request share, reinstatement rate, ring-detection share, backlog aging, and GMV at risk — sliceable by review type, trigger source, vertical, claim basis, and month.
- **US-7** As an MCA, I export an exam/audit bundle showing every AI-assisted disposition with reviewer identity, evidence cited, and timestamps (INFORM/DSA verification records, DMCA repeat-infringer policy evidence).
- **US-8** As a TA, the pack lands as tenant-scoped content only — datasets, model, dashboards, roles, agents — with zero Core changes.

## 3. Functional requirements

### 3.1 Pack manifest (SV-FR-001)

Standard v1. Categories: `marketplace, trust_safety, counterfeit, ip_enforcement, seller_risk`. Regulatory: `inform_consumers_act, dmca, lanham_act, eu_dsa, cpsc, ftc`. Clouds: all.

### 3.2 Ontology (SV-FR-010) — deferred to pack-service

`Seller`, `Listing`, `Brand`, `RightsHolder`, `Claim`, `TestBuy`, `KYBVerification`, `LinkedAccountCluster`, `EnforcementAction`, `ReinstatementPlan`, `DeadlineClock`. Carried today by the `seller_vetting_core` semantic model + dataset schemas.

### 3.3 Semantic model — marketplace-integrity KPI catalog (SV-FR-020) — authored as `seller_vetting_core`

| Measure | Definition |
|---|---|
| `enforcement_rate` | listing removals / all closures |
| `claim_rejection_rate` | insufficient-evidence rejections / all closures |
| `evidence_request_share` | authenticity-evidence requests / all closures |
| `reinstatement_rate` | sellers cleared or reinstated / all closures |
| `ring_detection_share` | linked-account network suspensions / all closures |
| `avg_review_age_days` | backlog aging / cycle time |
| `total_gmv_at_risk` | listing GMV exposure across reviews |
| deadline runway | open reviews by `deadline_bucket` (0-3 / 4-10 / over-10 days) |
| risk surface | deep-discount, image-reuse, seller-fulfilled listings; KYB-unverified/mismatch and linked-account sellers |

Entities: reviews / listings / sellers (chain: reviews →many_to_one→ listings →many_to_one→ sellers). Grammar: categorical dims, cast-to-double measures, equality measure filters, expr_metric with nullif.

### 3.4 Agents (SV-FR-030..060) — proposal-mode

1. **Vetting & Enforcement Copilot (SV-FR-030)** — authored as case-triage TenantAgentConfig: evidence-grounded disposition proposal (remove_listing_enforce / reject_claim_insufficient / suspend_seller_network / request_authenticity_evidence / reinstate_seller_cleared), deadline-first reasoning, evidence weighed both ways (signal stack ≠ proof; brand claim ≠ infringement), never removes listings or promises outcomes. Bespoke LangGraph recipe deferred.
2. **Counterfeit Signal-Stack Scorer (SV-FR-040)** — deferred recipe; interim: isolation_forest listing-anomaly pipeline + deep-discount/image-reuse verified query.
3. **Ring Linkage Mapper (SV-FR-050)** — deferred recipe; interim: seller-category network edges saved query + linked-account measures.
4. **Reinstatement Plan-of-Action Reviewer (SV-FR-060)** — deferred recipe; interim: reinstatement grounding memory + queue-note evidence pattern.
5. **Analytics agent** — authored: seller_vetting_core-grounded KPI Q&A.

Autonomous listing removal, seller suspension, or payout hold is forbidden — proposal-mode with human approval always (`SV_AUTONOMOUS_ENFORCEMENT_FORBIDDEN` at pack-service tier).

### 3.5 Connectors (SV-FR-080) — deferred to pack-service

**Read:** marketplace catalog and seller-account APIs, brand-registry claim intake, KYB data providers and business registries, device-fingerprint/fraud platforms, test-buy program logistics, product-safety recall feeds. **Write adapters (proposal-mode):** listing removal/suppression, seller suspension/reinstatement, payout hold/release, claimant and seller notices. Pack ships seed datasets in the landing shape; production connectors configure via Data > Connections.

### 3.6 Regulatory guardrails (SV-FR-090)

- **INFORM Consumers Act** — high-volume seller verification (bank/tax/contact), prompt collection window, annual certification, disclosure duties, suspension after notice; FTC + state AG enforcement.
- **DMCA §512** — valid-notice elements, expeditious takedown, counter-notice restore window, repeat-infringer policy, §512(f) misrepresentation liability both ways.
- **Trademark / first-sale** — genuine-goods resale lawful; claims need non-genuineness or material-difference evidence; "unauthorized seller" alone is not infringement.
- **EU DSA Art. 30** — trader traceability before offering, suspension for non-provision, identity display.
- **Product safety** — child-safety flags enforce-first; recall-linked listings removed pending evidence.

### 3.7 Roles & case schemas (SV-FR-100) — roles authored, schemas deferred

Roles: `Vetting Analyst`, `Marketplace Integrity Investigator`, `IP Claims Reviewer`, `Marketplace Trust Manager` (sole disposition approver), `Marketplace Compliance Auditor` (read+audit only). Case schemas (deferred): `onboarding_vetting`, `counterfeit_takedown`, `ip_claim_review`, `ring_investigation`, `reinstatement_review`.

## 4. Domain model & data

Authored materialization: 3 datasets (reviews 26 / listings 30 / sellers 12 — seed rows encode a deep-discount + image-reuse luxury counterfeit with a test buy in flight, a first-sale trademark claim against a genuine reseller, a KYB banking-name mismatch on a high-GMV new seller, a 3-attribute linked-account ring resurrecting a banned seller, a safety-flagged toy listing, and a plan-of-action reinstatement) · 1 semantic model · 5 verified queries · 2 saved queries (incl. seller→category network edges) · 3 dashboards (Marketplace Integrity Center, Counterfeit & IP Claims, Seller Risk & Rings — 15 charts) · 5 dispositions · 6-case seeded queue · 5 roles · 2 agent configs · 10 grounding memories · 2 pipelines (isolation_forest listing anomaly, xgboost review-outcome scorer). Deferred: guardrails, agent recipes, connectors, write adapters, eval sets, ontology, case schemas, model archetypes, display labels.

## 5. Business rules (SV-BR-*)

- **BR-1** No autonomous listing removal, seller suspension, or payout hold — proposal-mode with human decision, MTM four-eyes on removals, network suspensions, and claim rejections.
- **BR-2** Response clocks outrank investigation completeness: takedown-response, counter-notice, and verification deadlines are flagged first; child-safety flags are enforce-first with evidence to follow.
- **BR-3** Counterfeit signal stacks (deep discount + image reuse + seller fulfillment + new account) rank work; enforcement requires corroboration — test buy, brand authentication, or documented buyer evidence.
- **BR-4** Brand claims carry an evidence burden: genuine-goods resale is lawful (first-sale); rejection notes record why the evidence failed, and per-claimant accuracy is tracked.
- **BR-5** Network suspensions require multiple corroborated shared attributes (payout banking, address, device), each named in the disposition note.
- **BR-6** KYB payout-name mismatch on a qualifying seller holds disbursements and triggers re-verification; suspension follows notice if documentation doesn't arrive in the window.
- **BR-7** Reinstatement requires a plan of action (root cause / corrective / preventive) plus distributor-verified invoices; re-entry is monitored.
- **BR-8** Every AI-assisted disposition preserves provenance (data/model/prompt/reviewer/timestamp) — appeal defense and INFORM/DSA exam readiness; pattern-level over-enforcement of lawful resellers is monitored as a program risk.

## 6. Dependencies

Windrose Core (BRDs 01–23), unmodified. External (deferred connectors): marketplace catalog/seller APIs, brand-registry intake, KYB data providers, device-fingerprint platform, test-buy logistics.

## 7. NFRs (deltas)

| Metric | Target |
|---|---|
| Triage proposal p95 latency | ≤ 10s |
| Verification/takedown deadline breaches (post-install) | 0 |
| Counterfeit takedown cycle time (6mo) | ≥ 30% faster on detector-triggered reviews |
| Wrongful-takedown (overturned-on-appeal) rate | no increase vs. pre-AI baseline |
| Dashboard chart warm render | 100% real data at install |
| Idempotent re-install | all no-ops |

## 8. Acceptance criteria

- **AC-1** `packctl validate` passes; install exits 0 with 0 failed actions.
- **AC-2** All 15 dashboard charts resolve real rows at install.
- **AC-3** 6-case queue seeded from open reviews; severities/deadlines match the dataset.
- **AC-4** 5 roles bound to permission groups with differentiated live capabilities.
- **AC-5** Re-install is fully idempotent.
- **AC-6** Disposition taxonomy uses only the Core's closed category set.
- **AC-7** Pack installs on unmodified Core — zero service/helm/roles_actions.yaml diffs.
- **AC-8** Pack-service-tier capabilities appear verbatim in the `deferred` ledger, never faked.

## 9. Out of scope / future

Buyer-side abuse (returns fraud, review manipulation); proactive catalog-wide image-matching detector infrastructure; brand-side claim-filing portal; customs/recall agency integrations; payout-hold write adapters until pack-service ships; app-store binary/static-analysis vetting (natural v2 extension for the app-store buyer segment).
