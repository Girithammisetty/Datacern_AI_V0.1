# Datacern AI — Platform Direction & 5–10 Year Vision (2026 → 2035)

**Prepared:** 2026-07-26 · **Audience:** founder / investors / strategic partners
**Method:** three web-research sweeps (regulatory demand, frontier use cases, platform-category endgame), each claim cited with source + date, synthesized against the code-verified platform state. Statements marked **[THESIS]** are strategic inference, not sourced fact. Companion docs: [`DATACERN_PARTNER_BRIEFING.md`](DATACERN_PARTNER_BRIEFING.md) (what is true today), [`DATACERN_COMPETITIVE_LANDSCAPE_AND_GTM_ROADMAP.md`](DATACERN_COMPETITIVE_LANDSCAPE_AND_GTM_ROADMAP.md) (0–24 month roadmap).

**Honesty rule carried forward:** nothing below invents a number. Analyst figures are quoted with firm + date; where estimates conflict or are shaky they are labeled directional. The platform-state claims are the code-verified ones from the partner briefing, not aspirations.

---

## 1. The one-sentence thesis

> **Every wave of automation creates a mandatory review layer — and regulators, courts, insurers, and card networks are all converging on specifying that layer identically: *AI drafts, a named human decides, an audit trail proves it.* Datacern is the infrastructure for that layer.**

This is not a prediction that needs to come true — it is already written into law and rulebooks in different vocabularies:

| Who | Where they mandate the pattern | Date |
|---|---|---|
| CMS (Medicare) | WISeR model: AI drafts prior-auth reviews, a licensed clinician must review every non-affirmation, 72-hour clock | live Jan 1, 2026 |
| EU | Platform Work Directive: deactivation-type decisions must be made by a human with review rights | transposition Dec 2, 2026 |
| EU | AI Act Art. 14 human oversight + Art. 12 automatic logging for high-risk systems | Dec 2, 2027 (post-Omnibus) |
| Colorado | SB 26-189: right to "meaningful human review and reconsideration" of adverse AI decisions | Jan 1, 2027 |
| ~25+ US states | NAIC AI Model Bulletin: documented AI governance across underwriting/claims | adopted 2024–26 |
| CA + ~9 states | SB 1120 pattern: AI cannot be the basis of a medical-necessity denial; a physician must decide | 2025–26 |
| Fed/OCC/FDIC | SR 26-2 explicitly carves agentic AI out of model-risk scope — banks must self-govern agents, examiners will ask "show me your framework" | Apr 17, 2026 |
| Mastercard | Agent Pay liability: schemes carry liability only if the back office "can prove the agent stayed within the intent stored for the transaction" | rolling out 2025–26 |

The core platform primitive — a **case** needing a **defensible decision** with **evidence** under a **deadline** answerable to a **regulator** — is the common substrate of all of these. That primitive is what is already built and code-verified: the proposal spine (WriteIntent → four-eyes → signed execution grant), the tamper-evident audit chain + WORM export, and the correction-driven learning loop.

---

## 2. Reality checkpoint (what the vision stands on)

Verified today (see partner briefing for evidence anchors): 23 services, 28 installable packs with real install ledgers, enforced four-eyes with self-approval rejection, RLS multi-tenancy across 21 stateful services, real MLflow learning loop, hierarchical hard budget caps, MCP/A2A interop, self-host/multi-cloud IaC. **Not true yet:** zero customers, zero production cloud deployments, no certifications, per-decision cost attribution and ER merge approval unbuilt, scale proven at demo volume only.

The vision below is therefore a *direction*, not a claim. The credibility rule for using this doc with investors: every future-tense statement must be introduced as a bet, and every present-tense statement must trace to the partner briefing.

---

## 3. The demand engine, 2026 → 2035

### 3.1 Near horizon (2026–2029): the compression point

Four mandate waves land within 13 months of each other: **Colorado ADMT (Jan 2027) → CPPA automated-decision rules (Jan 2027) → CMS-0057-F APIs (Jan 2027) → EU AI Act Annex III high-risk (Dec 2027)**. Meanwhile sectoral law already in force (NAIC bulletin states; SB 1120-pattern states) mandates named-human determinations in insurance and healthcare *today*.

The three demand drivers that are **politics-proof** (they survived the 2025–26 deregulation wave and the EU Omnibus dilution):

1. **Litigation.** Every landmark case turned on human review being absent, nominal, or unprovable: *Moffatt v. Air Canada* (chatbot liability, Feb 2024), *Mobley v. Workday* (vendor liable for AI screening; nationwide collective certified May 2025), *UnitedHealth nH Predict* and *Cigna PxDx* (automated-denial class actions proceeding, 2025). Plaintiff theories ("rubber-stamp review", "the algorithm decided") are defeated exactly by what the platform records: named qualified human, what they saw, what they changed, enforced four-eyes. **Sell "litigation-grade decision provenance."**
2. **The assurance/insurance industry.** ISO/IEC 42001 certification is scaling (~350 orgs by spring 2026, incl. Microsoft, AWS, Anthropic; KPMG first Big-4 certified Nov 2025); the UK projects a **£6.5bn AI assurance market by 2035** (DSIT, directional); Lloyd's-backed AI liability insurance exists now (Armilla, $25M limits, Jan 2026; Munich Re aiSure, Mar 2026) and **underwriters demand governance evidence before binding cover**. Datacern's audit trail is the artifact an ISO 42001 auditor samples and an AI underwriter prices against.
3. **Examiner expectation without a template.** SR 26-2's agentic carve-out means every bank deploying agents must show a self-built governance framework to examiners with no safe harbor. A governed-decision platform can *be* the framework.

**Honest bear case (respect it):** EU dilution is real (high-risk slipped 16 months once already); the US preemption EO (Dec 2025) attacks state AI laws; NYC LL144's enforcement was audited as "ineffective"; hyperscalers will bundle good-enough governance. The pipeline should therefore be built on sectoral mandates + liability fear + insurer evidence demands — none of which an executive order touches — with horizontal AI-act compliance as upside, not base case.

### 3.2 Mid horizon (2030–2032): from deadline compliance to standing infrastructure

Gartner anchors (cite exactly): **15% of day-to-day work decisions made autonomously by 2028** (from ~0% in 2024, Jun 25 2025 release); **>40% of agentic AI projects canceled by end-2027** partly on "inadequate risk controls" (same release); **guardian agents capture 10–15% of the agentic AI market by 2030** (Jun 11, 2025); by 2028, 25% of enterprise breaches traced to AI agent abuse (2026 release). McKinsey (Nov 2025): AI agents alone could perform tasks occupying ~44% of US work hours — with ~$2.9T US value contingent on redesigning workflows around human-agent partnership.

If decisions go autonomous at that rate while 40% of projects die on governance, the scarce commodity is the layer that makes agent decisions **reviewable, attributable, and reversible**. In this period the buyer motive shifts from "meet the deadline" to "this is how we run agents at all" — the way double-entry bookkeeping stopped being a compliance requirement and became how business works. **[THESIS]**

### 3.3 Far horizon (2033–2035): the clearing-house scenario

Historical pattern: when a technology wave broke the back office, the industry mutualized a neutral utility whose records became the legally recognized truth — DTCC (paperwork crisis, 1970s), SWIFT (1973), Visa, ADP (payroll tax liability), Stripe (payments compliance behind an API). Durability came from four properties: **neutrality, regulator recognition, an evidence standard others build around, and liability absorption**.

The agent-era equivalent: a neutral layer through which agent actions clear — verified agent identity + scoped human mandate in, tamper-evident approval/decision record out, recognized by auditors, insurers, and regulators as *the* evidence of compliant AI-assisted decisions. Fragments are being built by others today (card networks' agent registries + intent credentials; AIUC-1 certification + insurance; NANDA registry research; NIST agent-standards initiative, Feb 2026). Nobody owns the whole. **[THESIS — the 2035 endgame Datacern should aim its architecture at, while selling §3.1–3.2 to fund the journey.]**

---

## 4. Category: what to claim and why it's open

Analyst naming hasn't settled (AI TRiSM, guardian agents, AI governance platforms, agent orchestration, decision intelligence). The recommended claim:

> **Category: "Decision Assurance."** Tagline: **the accountability layer for enterprise AI agents.** Long-term narrative (2030+): the decision clearing house.

Why this cell is open — every incumbent has the same four structural blind spots:

| Blind spot | Who exhibits it |
|---|---|
| **Neutrality** — governance planes that govern a portfolio the vendor also sells | Microsoft Agent 365, OpenAI Frontier (governing competitors' agents = trust conflict), Salesforce, Anthropic |
| **Regulated-evidence output** — control towers observe/secure but don't produce regulator-consumable decision records with named-human accountability | ServiceNow AI Control Tower (closest competitor; IT-asset framing), Databricks/Snowflake |
| **Sovereignty** — cloud-SaaS only; EU/regulated on-prem demand unserved | Agent 365, Frontier, Agentforce, Control Tower |
| **Cross-vendor enforcement** — discovery and inventory of foreign agents, but thin enforcement of approval workflows on their *actions* | ServiceNow, Workday "Agent System of Record" [THESIS — from positioning, not hands-on evaluation] |

Meanwhile the adjacent layers are being taken: agent *identity* by Microsoft Entra Agent ID + NIST/IETF/ITU standards; agent *payments* by Visa TAP/Mastercard Agent Pay/AP2/x402; agent *plumbing* commoditized via Linux Foundation MCP/A2A (~9,650 MCP servers, ~97M monthly SDK downloads, May 2026). Value migrates to what's left un-owned: **accountability evidence**. The funded-startup map confirms the gold rush is adjacent, not on top of us: identity (Oasis $120M), insurance (AIUC $15M seed, Armilla $25M, Klaimee), observability (Langfuse $50M) — all of them **channel partners, not competitors**, because all of them need the evidence Datacern generates.

Anti-goals (unchanged from the GTM doc, reinforced by this research): don't build an agent framework; don't fight observability open source; don't compete with identity vendors — integrate; don't chase sub-second autonomy loops.

---

## 5. The next packs: decision queues that don't exist yet

Ranked by (timing × fit with the case/proposal/audit primitive × incumbent absence). Full evidence in the research appendix; each is a future **Capability Pack** on the existing Core — no new platform required. **[Pack theses; trend evidence cited per item in §Appendix]**

### Wave 1 — build 2027–2029

1. **Agent Transaction Disputes** — *the flagship.* AP2 mandates, Mastercard Agentic Tokens, and Visa's Trusted Agent framework are creating cryptographic "intent" evidence *specifically so disputes can be adjudicated* — and the dispute-side infrastructure "remains almost entirely unaddressed" (Rivero, Chargebacks911, 2025–26). Baseline: ~337M chargebacks/$28B by 2026; Gartner sees machine customers influencing **$30T in purchases by 2030**. The queue: "did the agent stay within the user's mandate?" — asynchronous, evidence-heavy, deadline-driven, zero incumbents. Datacern already ships a card-disputes pack; this is its agentic successor.
2. **Agent Incident Review & Certification ("HR for agents")** — EU AI Act Art. 73 serious-incident reporting (15/10/2-day deadlines, applies Aug 2, 2026) + Gartner's "40% of enterprises will demote or decommission agents after production incidents" (May 2026). Queues: agent onboarding/certification, incident post-mortems with regulatory clocks, periodic performance/probation review. Sits *above* identity/security vendors (deliberative layer, not runtime policing). The correction-retraining loop is uniquely valuable here: agent-incident taxonomies don't exist yet.
3. **Cell & Gene Therapy Authorization + Outcomes-Contract Adjudication** — $2–4M one-time therapies, 20+ launches expected in two years; CMS's WISeR model *mandates* the AI-drafts/clinician-decides/72-hour architecture. The unowned niche is not commodity prior auth (crowded) but **milestone-based refund adjudication under outcomes-based contracts** — million-dollar decisions over years with registries as evidence.
4. **Platform Justice pack family** — DSA Art. 21 out-of-court dispute bodies (an adjudication industry created by statute, already overloaded: Appeals Centre Europe overturned platforms in most user appeals, 2026), TAKE IT DOWN Act 48-hour deepfake-removal clocks with $53k-per-item FTC penalties (enforced May 2026), age-verification false-positive appeals. Extends the existing trust-&-safety appeals pack. Caveat: thin per-case economics; buyer is the certified body or VLOP T&S org.
5. **Algorithmic-Management & ADMT Appeals** — EU Platform Work Directive (Dec 2026) + Colorado SB 26-189 (Jan 2027) mandate named-human review of automated employment decisions verbatim. Risk: platforms build in-house; sell to the compliance function, not the algorithm owner.

### Wave 2 — build 2029–2032

6. **Autonomous-Systems Injury Claims** — Waymo in 10 metros (Feb 2026), FAA Part 108 BVLOS unlocking drone delivery; claims scale with fleet-miles. Perfect claims-queue fit; concentrated buyer set (a handful of self-insured operators/TPAs) makes it a fat-enterprise sale.
7. **CBAM & Carbon-Credit Verification Disputes** — CBAM definitive period began Jan 2026, first certificate surrender **Sep 30, 2027** starts the enforcement/dispute wave; carbon-credit V&V market growing 14%+ CAGR. Highest regulatory-volatility risk of the list.
8. **Grid Interconnection & DER Enrollment Review** — 2,200+ GW US interconnection backlog, FERC deadlines *with penalties*; "queue" is literally the native vocabulary. Serve the review layer; **exclude real-time bidding** (sub-second, anti-fit).
9. **AI-Insurance Underwriting & Claims** — Armilla-pattern certification-per-policy is itself a decision queue; deepfake-fraud claims funded by Deloitte's projected $40B US gen-AI fraud losses by 2027.

### Wave 3 — 2032–2035

10. **Government Adjudication Oversight** — 3.19M pending US immigration-court cases; OMB M-25-21 classifies benefits/immigration AI as "High-Impact" requiring documented human review; FedRAMP 20x fast-tracks AI authorizations. Largest backlogs on earth, best societal case, slowest procurement — enter via a federal design partner only.
11. **[THESIS, watch-list]** Personal-AI-fiduciary vs. corporate-agent arbitration; mass workforce-transition benefit adjudication; AI-copyright licensing/royalty disputes if collective licensing emerges. Seeds visible (AP2 mandate-dispute forums; Bartz v. Anthropic's 482k-work claims administration, settled Jul 2026), markets not yet formed.

**The anti-fit rule (protects credibility):** any domain whose core loop is sub-second — real-time market bidding, runtime agent policing, live content filtering — contradicts the human-in-command primitive. Serve those domains only at their ex-post review layer, and say so plainly in sales conversations.

---

## 6. Five platform bets (what to build so the core is still the scarce asset in 2035)

Each bet extends verified machinery; none requires abandoning the frozen-Core model.

**Bet 1 — The oversight dial (graduated autonomy).** The bear case is regulators creating "licensed autonomy" classes the way AV rules went safety-driver → remote supervisor → driverless. The product must let oversight *ratio* move without losing accountability: per-action four-eyes → per-policy approval → statistical sampling with named-owner attestation. The seed already exists in code (`auto_execute_policy` for low-risk writes + hard human-required overrides). This converts the platform from "human-in-the-loop tool" (dies if mandates relax) to "accountability infrastructure at any autonomy level" (survives all three scenarios). **This is the single most important architectural bet.**

**Bet 2 — Open evidence standard.** Open-source the **Decision Evidence Record format** (schema for: agent identity + mandate + evidence cited + proposal + named approver + what changed + chain hash) — not the enforcement engine. Rationale: SWIFT/DTCC durability came from *being the evidence standard others build around*; open formats preempt open-source commoditization of the plumbing while the enforcement, learning loop, and packs stay proprietary. Target recognition path: insurers and auditors first (they need a standard now), regulators later.

**Bet 3 — The insurer/assurance channel.** Make "insurance-ready evidence export" a product surface: underwriting questionnaires (Armilla-pattern) pre-answered from live governance data, ISO 42001 / EU AI Act Annex IV artifact generation (already roadmap item A6), continuous evidence feeds to certifiers. The AI insurers and Big-4 assurance practices are a *sales channel* that demands exactly what the audit layer produces — and channel recognition ≈ regulator recognition on a faster clock.

**Bet 4 — Govern other vendors' agents.** Extend the proposal spine to foreign agents: bind Entra-Agent-ID-class identities and AP2-class mandates to WriteIntents, so any agent (Copilot, Agentforce, custom) must *propose* into Datacern rails to touch a governed system of record. The external-agent SDK + MCP gateway already point here. This is the counter to the bundling threat: hyperscaler control towers govern their own estates; the neutral layer governs the mixed fleet every real enterprise runs.

**Bet 5 — Sovereignty as strategy, not deployment option.** Productized zero-access BYOC (roadmap B11) is the structural gap none of Agent 365/Frontier/Agentforce/Control Tower serve. EU + regulated + government demand for on-prem accountable-AI infrastructure is the segment where neutrality + self-host is disqualifying for every large competitor. **[THESIS on segment size — no reliable number exists; the structural gap itself is documented in §4.]**

---

## 7. Scenarios and what changes

| | BASE (~55%) | BULL (~25%) | BEAR (~20%) |
|---|---|---|---|
| 2030 world | Agents execute 20–40% of white-collar task-hours; regulated decisions require documented human accountability | Major agentic breach/loss event + EU enforcement makes named-human accountability a procurement + insurance requirement | Fast model-reliability gains + deregulation; "licensed autonomy" classes shrink mandated human review |
| Demand shape | Governance layer standard in regulated verticals; guardian tech 10–15% of agentic spend | Accountability layer becomes chokepoint; neutral self-host vendors win sovereignty demand | Compliance demand caps; institutional demand (insurers, courts, auditors) remains |
| What Datacern does | Ride §3.1 mandates; packs Wave 1–2 | Scale the clearing narrative early; open standard accelerates | Oversight dial (Bet 1) + evidence-for-insurers (Bet 3) keep the product necessary at lower human-review ratios |
| Kill risk | Being 2 years early on frontier packs | Execution/scale | Bundled "good-enough" governance + OSS audit plumbing — mitigated by Bets 2, 4, 5 |

Probabilities are judgment calls, not sourced. **[THESIS]**

---

## 8. What this means for selling *today* (investor/SI demo mapping)

Every vision claim above has a demoable anchor now — use these pairs, never the vision alone:

| Vision claim | Show today |
|---|---|
| "Review-layer infrastructure regulators are converging on" | Four-eyes approval inbox; self-approval rejected live; WISeR/SB-1120 slide from §1 table |
| "Litigation-grade decision provenance" | Audit trail: named human, evidence viewed, what changed, hash chain; WORM export |
| "Insurable AI" | Evidence-pack export endpoints; map to Armilla underwriting questionnaire |
| "Governs any vendor's agents" | MCP gateway + external-agent SDK proposing into the approval inbox |
| "Cost-per-decision declines" | Model ladder + budget caps + distillation loop in MLflow |
| "New verticals are a pack, not a rebuild" | Install a pack live; show the 41-missing-fields refusal beat |
| "Agent-economy dispute rails" | Card-disputes pack as the structural ancestor of agent-transaction disputes |

And the two sentences that keep the pitch honest: *"Everything you just saw runs today on one machine; production cloud, certifications, and first customers are the work we're raising/partnering to do."* + *"The 10-year story is a bet — but every regulator writing rules for AI decisions is currently specifying our architecture."*

---

## 9. Sequencing (direction, not commitment)

- **2026–27 — prove + certify:** first production deployment, SOC 2 start, design partners in existing packs (insurance claims / disputes / prior auth), `governed_decision` meter + ROI dashboard, oversight-dial slice 1. The 0–24 month roadmap doc governs this window.
- **2027–29 — compression-point harvest:** EU Dec-2027 + state-law waves; ship Wave-1 frontier packs (agent-transaction disputes first — rulebooks are being written now); publish the open Decision Evidence Record; first insurer/certifier integrations.
- **2030–32 — category ownership:** "Decision Assurance" category push; foreign-agent governance at fleet scale; sovereignty/BYOC motion in EU + government; guardian-agent market share contest.
- **2033–35 — the network:** cross-organization decision clearing (issuer ↔ merchant ↔ agent-operator dispute rails; insurer ↔ insured evidence feeds). Only pursue once ≥2 sides of a market run Datacern independently — a clearing house of one is a database. **[THESIS]**

---

## Appendix — key sources (full URL lists in the three research briefs)

Regulation/timing: DLA Piper & Gibson Dunn on the Digital Omnibus (May–Jun 2026); Federal Reserve SR 26-2 (Apr 17, 2026) + Sullivan & Cromwell memo; CMS WISeR provider guide + DLA Piper (Jan 2026); Mayer Brown on Colorado SB 26-189 (May 2026); Quarles/NAIC adoption map; Holland & Knight on state healthcare-AI laws (May 2026); Fisher Phillips on the Platform Work Directive; Latham & Watkins on AI Act Art. 73.
Litigation: McCarthy Tétrault (*Moffatt*); Holland & Knight/Fennemore (*Mobley v. Workday*); Healthcare Finance News (nH Predict); NFP/Thompson Coburn (PxDx).
Assurance/insurance: DSIT Trusted Third-Party AI Assurance Roadmap; Atoro ISO-42001 tracker; PR Newswire/FinTech Global (Armilla, Apr 2025 / Jan 2026); Munich Re aiSure (Mar 2026); Fortune (AIUC, Jul 2025); The Insurer (Klaimee, Jul 2026).
Agentic commerce: Google Cloud AP2 announcement (Sept 2025); Visa Trusted Agent Protocol (Oct 2025); Eco/risingwave on Mastercard Agent Pay; Rivero/Chargebacks911/Chargeflow/Justt on the dispute gap; Forbes on Gartner's $30T machine-customer projection (Feb 2025).
Category/incumbents: Gartner press releases (Jun 11 2025 guardian agents; Jun 25 2025 cancellations + 15%-of-decisions; May 26 2026 uniform-governance failure; Apr 9 2026 security incidents); ServiceNow Knowledge 2026 releases; Microsoft Foundry/Agent 365 posts; TechCrunch/VentureBeat on OpenAI Frontier (Feb 2026); Anthropic MCP donation (Dec 2025); McKinsey MGI (Nov 2025); Salesforce Q4 FY26 earnings (Feb 2026).
Frontier domains: CMS/KFF (WISeR); Bioxconomy/Prime Therapeutics (CGT); Courthouse News/DSA Observatory (ODS bodies); TechTimes (TAKE IT DOWN enforcement, May 2026); Reyes Law (Waymo expansion Feb 2026); Pillsbury (FAA Part 108); EC Access2Markets (CBAM); RMI/Eckert Seamans (interconnection); DOE VPP Liftoff; TRAC (immigration backlog); Holland & Knight (UFLPA, Jul 2026); Deloitte ($40B deepfake fraud).
