# Datacern AI — Real-Time Readiness for Healthcare Use Cases

**Prepared:** 2026-07-21 · **Purpose:** answer the "healthcare is real-time, your platform looks batch" objection — for partner/prospect conversations and as the engineering roadmap that closes the gap.

---

## 1. The core answer — [SHARE]

**The platform is event-native at its core; datasets are its memory, not its decision path.**

- Every service publishes and consumes **Kafka domain events** through a transactional outbox (case events, ingestion events, disposition events, audit events). The learning loop itself is streaming: a human correction becomes a Kafka event, is consumed into labeled training data, and flows to retraining — continuously, not nightly.
- The UI is **live**: server-sent events push case status, ingestion progress, and pipeline state to every open screen without refresh.
- **Webhook ingestion** exists today — external systems can push records in, per-source signed secrets included.
- The Iceberg lakehouse is the **analytical spine** — history, profiling, training data, dashboards — not a batch gate in front of decisions.

**The second half of the answer is about SLAs.** "Real-time" in healthcare operations almost never means milliseconds. It means *the regulatory clock*:

| Clock | Typical requirement |
|---|---|
| Expedited prior authorization | 24–72 hours (CMS interoperability rules) |
| Standard prior auth / appeals | days to 30–60 days |
| Claim edit / clean-claim scrub | seconds at claim creation |
| Denial follow-up | days (timely-filing windows) |
| Readmission intervention | hours after discharge event |
| POS pharmacy adjudication | **sub-second** (the one true real-time case) |

The platform's event→case→agent-triage→four-eyes path operates in **seconds to minutes** end-to-end. That meets every clock above except point-of-sale pharmacy switching — which we deliberately do *not* replace (see §3.5).

**One-line version for the meeting:** *"We're event-driven where it matters — the decision path — and batch where it's smart — the learning path. The gap to real-time healthcare is a set of transport connectors, not a re-architecture."*

---

## 2. What exists today vs. what's needed — [SHARE]

### Already built (live-verified)

| Capability | Relevance to real-time |
|---|---|
| Kafka event backbone + transactional outbox in every service | The streaming substrate — new event sources plug into an existing pattern |
| Webhook ingestion sources (signed, per-source secrets) | Push-based intake works today for any system that can POST |
| Healthcare wire-format decoders: X12 (837, 276/277 outbound status), FHIR, HL7v2 | Message *understanding* is done; missing piece is *transport* listeners |
| Case materialization from data rows + event-driven case updates | Records become governed work items; status streams live to the UI |
| Agent triage in seconds (real LLM, cited evidence) + four-eyes approval | Decision latency is minutes including the human — inside every regulatory clock |
| Decision tables (governed, versioned, per-decision trace) | The deterministic sub-second path for rules-type decisions |
| Governed write-back to systems of record (DB upsert + HTTP post, four-eyes gated) | Decisions leave the platform in near-real-time after approval |
| Entity resolution with golden-record merge | Cross-feed provider/member linking — the backbone of FWA and RCM |
| Streaming learning loop (corrections → labeled data → retrain → governed promote) | The moat; already continuous |

### The real gap list (roadmap, ~3 increments)

| # | Gap | What to build | Unblocks |
|---|---|---|---|
| R1 | **Streaming transport connectors** | HL7v2 MLLP listener; FHIR R4 Subscription client; Kafka-source connector; wire the existing SFTP/EDI poller; X12 real-time request/response (278 PA, 270/271 eligibility) | ADT-triggered care management, ePA intake, EDI clearinghouse feeds |
| R2 | **Event-rule case triggers** | Declarative "event pattern → auto-create/route case" rules (the materialization machinery exists; the trigger grammar doesn't) | Denial lands → case opens in seconds, no human seeding |
| R3 | **Online decision API** | Synchronous scoring endpoint serving promoted models from the registry (today scoring is batch parquet) + synchronous decision-table evaluation API | Inline claim scrubbing, pre-pay flags inside the adjudication window |
| R4 | **Latency SLOs** | Published p95 for event→case→triage-proposal (target < 60s) with the existing tracing/metrics stack | A number sales can say out loud |
| R5 | **Compliance packs for the new rails** | CMS-0057 Prior Auth API (Da Vinci PAS/DTR) conformance; NCPDP ePA flows | Payer PA modernization deals |

R1+R2 are connector/config work on existing patterns — **ideal partner/offshore workstreams**. R3 touches Core (inference-service + query path) — keep in-house or vetted seniors.

---

## 3. Use-case by use-case — [SHARE]

### 3.1 Claims Adjudication & Appeals *(packs: insurance-claims-payer, benefits-appeals)*
**Real-time need:** PA turnaround (24–72h expedited), appeal deadlines, denial response windows. Minutes-level intake, not milliseconds.
**Today:** denial/appeal records ingest (X12 837/277 decode, webhook push, file drop) → cases with severity/due-date ranking → triage agent drafts the determination with cited plan/policy evidence → four-eyes approval → governed write-back (outbound 276 status exists) → every correction trains the next model.
**With R1/R2:** an 835 denial or 278 PA request *lands as an open, triaged case within seconds* of hitting the wire — no batch window anywhere.
**Sell it as:** the *turnaround-time compressor* — the platform's whole job is collapsing the human queue time that dominates these SLAs, with an audit trail per determination.

### 3.2 Provider Revenue Cycle *(pack: healthcare-provider-rcm)*
**Real-time need:** clean-claim scrubbing at claim creation (seconds, synchronous); denial recovery is worklist-speed (days).
**Today:** 837 ingest → denial-pattern analytics → prioritized recovery worklists by dollar value → appeal drafting by agent → learning loop learns *this* provider's payer-specific denial causes.
**With R3:** the online decision API lets the platform sit **inline at claim creation** — decision-table edits + model score returned synchronously to the practice-management system, so claims are fixed *before* submission rather than recovered after.
**Sell it as:** recover-then-prevent — start with recovery worklists (works today), graduate to inline prevention (R3).

### 3.3 Payment Integrity — FWA/SIU *(packs: payer-fwa-siu, investigation-framework)*
**Real-time need:** pre-pay flags must land inside the adjudication window (hours); investigations are inherently retrospective.
**Today:** this is the platform's strongest fit — claims stream in, **entity resolution** links providers/members/facilities across feeds into golden records, models score suspect patterns, flagged claims become investigation cases with evidence attached, and **defensible closure is native**: four-eyes disposition, immutable 7-year WORM audit trail, per-decision trace with input snapshot. "Close each case defensibly" is literally the governance layer's design goal.
**With R1/R3:** scoring moves from near-line to pre-pay — flag before the check is cut.
**Sell it as:** the SIU case system where the AI's accusation comes with its evidence, and the audit file writes itself.

### 3.4 Care Management *(packs: care-management-medicare, post-acute overlap)*
**Real-time need:** enrollment triggers from ADT events (hours), RPM device streams (continuous), CCM/RPM time-and-billing (monthly — genuinely batch).
**Today:** webhook intake for device/vendor pushes; enrollment and program-tracking cases with task workflows; billing rollups on the analytical spine (that part *should* be batch).
**With R1 (HL7v2 MLLP + FHIR Subscriptions):** hospital discharge ADT event → risk score → outreach case opens with a due-date clock — the readmission-prevention motion, event-driven end to end.
**Sell it as:** event-triggered enrollment + airtight billing evidence (time tracking with an audit trail is exactly what CCM/RPM audits demand).

### 3.5 Pharmacy Benefits — PBM *(pack: pharmacy-benefit-mgmt)*
**Real-time need:** two very different clocks. (a) ePA turnaround: minutes-to-hours — platform fits today. (b) POS claim adjudication (NCPDP B1/B2): **sub-second at the switch — we do not compete there, and say so.**
**Today + R1:** ePA requests intake → agent drafts the PA determination with formulary/safety citations → pharmacist four-eyes → response returned. Rebate integrity runs on the analytical spine (contract-term validation over claim history — a batch problem by nature). Safety edits are *authored and governed* in Datacern decision tables, then **pushed to the switch** as its edit rules.
**Sell it as:** the governance and learning layer *around* the switch — turnaround speed on PA, defensibility on rebates, versioned/audited authorship of the safety edits the switch enforces. Positioning honestly here builds credibility everywhere else.

### 3.6 Post-Acute Care *(pack: post-acute-care)*
**Real-time need:** OASIS/MDS assessment deadlines (days), episode milestones (days), readmission signals (hours post-discharge).
**Today:** episode cases with milestone/deadline tracking, assessment-completeness checks, live status on every worklist.
**With R1:** ADT discharge/readmit events drive the episode timeline automatically — the platform becomes the early-warning system, not a retrospective report.
**Sell it as:** deadline-driven casework is the platform's native shape; the connector work just removes manual event entry.

---

## 4. The honest one-paragraph summary — [INTERNAL, but use its content freely]

Five of the six use cases are **case-lifecycle problems with regulatory clocks in minutes-to-days** — squarely inside the platform's event-driven envelope once R1/R2 connectors land (connector work, not re-architecture, and well-suited to the SI partner). The sixth (POS pharmacy) contains one truly sub-second path we intentionally don't own; we govern around it. The only Core-touching gap is the online decision API (R3), which converts the RCM and payment-integrity stories from "recover after" to "prevent inline" — that's the highest-leverage engineering item and should stay in-house. If asked "are you real-time?", the answer is: *"our decision path is event-driven in seconds; our regulatory answer is we beat every turnaround clock in these six use cases; and we'll never pretend to be a claims switch."*
