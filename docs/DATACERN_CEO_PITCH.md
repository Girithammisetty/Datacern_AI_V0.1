# Pitch: Datacern AI → CEO, healthcare AI solution provider (~$150M revenue)

**Who they are:** AI solution provider, ~$150M revenue. Contact-centre **voice agent** platform with live customers. Offshore IT team. Onsite GTM team. **Healthcare vertical focus.**
**Your position:** deep technical asset, no capital.
**Structure:** the 12-part "Perfect Pitch" frame, re-aimed at an operator who is also a potential partner.

**Rule of this document:** every claim traces to `docs/DATACERN_PARTNER_BRIEFING.md` (verified against code/CI) or to a count re-measured on 2026-08-01. Anything aspirational is labelled **ROADMAP**. If this document and the codebase disagree, the codebase is right and this is a bug.

---

## The single most important thing on this page

**They are not a customer. They are the other half of a product.**

Their voice agent answers the call. But every healthcare call that matters *ends in a case* — a prior auth to adjudicate, an appeal to review, a denial to work, a claim to reprocess. Today that case falls off the end of their platform into a human queue with no governance, no audit trail, no learning loop.

> **Their product stops when the call ends. Mine starts there.**

And the fit is unusually exact:

| They have | You have | The briefing calls it |
|---|---|---|
| Healthcare customers + onsite GTM | 9 healthcare packs, zero customers | WS-4 |
| Offshore IT team | A written gap list that is exactly offshore-sized work | WS-2 |
| Voice / front office | Back office, **zero** voice surface — no overlap at all | — |
| A commoditising product line | A defensible one they can't quickly build | — |

Their four biggest assets map 1:1 onto your four biggest gaps. That is the pitch. Everything below is support.

**The commercial argument that makes a CEO lean in:** voice agents are commoditising. Every CCaaS vendor ships one now. Their $150M sits on a line where differentiation erodes and margin compresses annually. Governed back-office decisioning is the opposite — hard to build, hard to copy, sold to the same buyer they already have a relationship with. You are offering a **second product line into their existing accounts**, not a tool.

---

## Read this first: the frame change

The 12-part structure in your screenshot is a **seed VC deck**. Three sections misfire here:

| VC section | Why it misfires | Use instead |
|---|---|---|
| **5. Market (TAM/SAM/SOM)** | They know the healthcare AI market better than you. Quoting it back is a status error. | Their account base × attach rate |
| **10. Financials / projections** | A hockey stick from a pre-revenue solo founder reads as fiction. | Payback on *their* pilot spend |
| **12. The ask (raise $X)** | They're an operator, not an allocator. Asking them to allocate puts you in the wrong queue. | A menu of partnership structures |

And note the audience shift: this CEO **sells AI for a living**. They will not be impressed by "we use AI". They will be impressed — or not — by whether you understand governance, healthcare clocks, and why their own pilots stall. Pitch to a peer, not to a buyer.

**Your one structural weakness — and its fix.** No capital, no customers, no track record. So you substitute a different currency: **verifiable precision.** State what is not built before they ask. A CEO who catches you overclaiming once discounts everything. A CEO who watches you volunteer your own gaps starts trusting what you assert. Their CTO will do diligence; make sure they find nothing you didn't already say.

---

# The 12 sections

## 1 · Title / one-liner

> **"Your voice agents answer the call. I built the system that governs what happens after it — prior auth, appeals, denials — with an audit trail a payer's compliance team will accept."**

Delivery notes:
- One sentence. Then **stop.** Let the silence work.
- No service counts, no architecture, no "agentic". They'll pull it out of you.
- It positions you as **complementary in the first six words.** Nobody in that room needs to feel threatened.

---

## 2 · Problem

Aim at *their* ceiling, not at healthcare's. They already know healthcare's.

> "You've automated the conversation. But in healthcare the conversation is rarely the work — the work is the decision behind it. A member calls about a denied claim; your agent handles the call beautifully and then hands off to a queue where a human reads the file and decides, exactly as they did before.
>
> So two things happen. Your value stops at the end of the call — which caps what you can charge. And your customer's actual cost centre, the review staff, is untouched.
>
> Meanwhile every voice vendor now ships an agent. That line is commoditising underneath you."

Then the mirror — **ask, do not assert**:

> "When one of your agents finishes a healthcare call, what happens to the case it just created?"

Their answer is the whole opening. Let them describe the gap in their own words; then you are not selling, you are agreeing.

**Second question, once they've answered:**

> "And across your healthcare accounts — how many of them have review staff sitting behind that queue?"

Write the number down in front of them. That is your attach-rate denominator for §5.

---

## 3 · Solution

> "AI drafts the decision with cited evidence. A named human approves it. Every approval becomes training data that improves the next one — and the retrain goes through the same approval gate.
>
> It isn't AI that decides. It's **AI decisions a payer's compliance team can audit**: evidence, proposer, approver, effect, on a tamper-evident record."

Three proof points. Each is checkable, and each is chosen because *this* CEO will recognise why it's hard:

1. **Self-approval is rejected server-side.** Not a UI convention. The proposer cannot be the approver. High-risk, destructive and admin actions require a second, distinct human with **no tenant opt-out**. They have tried to sell AI into a payer; they know what that unlocks.
2. **A pack refuses to install against a tenant with no real data**, naming every missing field. The platform will not half-work to make a demo look good.
3. **Hard budget caps that fail closed** — platform → tenant → workspace → principal → key. Anyone running LLMs at customer scale has been surprised by a bill.

**Then close the loop back to their product:**

> "And the integration seam already exists — webhook ingestion with signed per-source secrets. Your voice agent finishes a call and posts the outcome; a governed case exists on the other side. That's a connector, not a re-architecture."

---

## 4 · Why now

Three forces, aimed at a healthcare AI seller:

- **Regulatory.** CMS interoperability rules put hard clocks on prior auth (24–72h expedited). The EU AI Act's high-risk obligations and existing payer audit expectations are turning "explain this decision" into a filing requirement. The pack fleet already carries control mappings to EU AI Act, NIST AI RMF and ISO 42001.
- **Economic.** Models are good enough to draft; the bottleneck moved from *can it reason* to *can you govern it*. The scarce asset is the governance layer, not the model — and it is not the thing a voice platform naturally grows into.
- **Competitive, and this is the one for them.** Their voice competitors will reach back-office in 18–24 months. Getting there first, with an audit story, is a durable position. Building it from scratch is 2–3 years and several million dollars of engineering they'd rather spend on their core.

> "The models are commodities and getting cheaper. The governed workflow around them is the moat — and it's the half you don't have."

---

## 5 · Market → **their** account base

**Do not present a TAM slide to a company that sells into this market.** Build it from their numbers, on a whiteboard:

```
  A   Healthcare accounts they already serve         ← ask them
  B   Share with a back-office review queue          ← ask; in healthcare, most
  C   Realistic attach rate in 24 months             ← be conservative: 20-30%
  D   Annual platform + pack ACV per account         ← anchor to displaced review labour

      New recurring line  =  A × B × C × D
```

Then the second number, which is theirs alone:

> "That's the licence line. The bigger one for you is probably services — your offshore team implements every one of these, and SI services typically run one to three times the platform subscription on enterprise deployments. That pool is yours, not mine."

**Why this beats a market chart:** you never assert a number about their business. They supply every input. Nobody argues with their own arithmetic — and the services pool makes it *their* upside, not just yours.

---

## 6 · Product / tech

Four sentences unless asked. Then go as deep as they want — depth is your advantage, but only on request.

> "A platform Core plus installable vertical packs. The Core does identity, permissions, case management, the lakehouse, the agent runtime and the governance gate. A pack is configuration — ontology, decision tables, dashboards, agent setup — for one vertical. 27 verticals are built; **9 of them are healthcare or life sciences.**"

**The healthcare fleet — lead with this, it is your strongest single slide for this company:**

| Pack | What it governs |
|---|---|
| `insurance-claims-payer` | Prior-auth review, appeal analysis, denial analytics — X12 837 intake, claim-status sync |
| `payer-fwa-siu` | FWA screening and SIU investigation |
| `healthcare-provider-rcm` | Provider-side revenue cycle, denials |
| `benefits-appeals` | Eligibility adjudication and appeals |
| `care-management-medicare` | CCM/PCM/TCM/BHI/CoCM/RPM/RTM/APCM |
| `pharmacy-benefit-mgmt` | PBM / Part D |
| `post-acute-care` | Home health, SNF, hospice — PDGM/PDPM |
| `device-complaints` | Complaint handling, MDR reportability |
| `pharmacovigilance` | 21 CFR 314.80/312.32, ICH E2A/E2D |

> "The first one is the point for you. Prior auth, appeals and denials are *what healthcare contact-centre calls are about.* Your agents are already having these conversations."

**Verified state, 2026-08-01** — hand this table to their CTO; it is built to survive scrutiny:

| | Verified |
|---|---|
| Services | **24** in the build inventory (Go + Python + GraphQL BFF + Next.js UI) |
| Vertical packs | **28** (27 verticals at v2.1.0 + 1 shared library); **9 healthcare / life sciences** |
| Healthcare wire formats | X12 (837, 276/277 outbound status), FHIR, HL7v2 — decoders built and tested |
| Agents | 9 built-in, all 9 passing a live real-LLM roster test |
| BRDs | **72** numbered requirement docs, written before build |
| Tests | **~2,560** test functions, strict count (985 Go, 996 TS, 578 Python) |
| Packs with a seeded demo scenario | **4 of 28** |
| Multi-tenancy | Postgres RLS with `FORCE ROW LEVEL SECURITY`; tenant pinned from the verified JWT only |
| Audit | Per-tenant hash-chained log in ClickHouse + S3 Object-Lock COMPLIANCE-mode WORM export |
| Event backbone | Kafka + transactional outbox in every service; SSE live UI; **webhook ingestion with signed per-source secrets** |
| Voice / telephony | **None. Zero surface.** Deliberately — that's their half |
| Infrastructure-as-code | Helm + Terraform for AWS/GCP/Azure — **written and CI-built, never applied to a production cloud** |

Put the last two rows in front of them yourself. "Zero voice surface" is a *feature* in this conversation — it means no overlap, no threat, no wasted engineering. And volunteering "never deployed to a cloud" is what buys you belief on the rows above it.

---

## 7 · Commercial model

They are a channel, so price the **channel**, not the seat:

> "For an end customer: annual platform subscription per use case, consumption on metered decisions, packs as add-ons. For you: resale margin, or an OEM licence if you'd rather it carry your name.
>
> Directionally — resale margin in the 20–30% range, referral 10–15% of first-year subscription. But the number that should interest you more is the services pool your offshore team bills on every implementation."

Built vs roadmap, so their CTO can't catch you:
- **Built:** commercial plans, seat/quota enforcement, metering by tenant/workspace/user/agent, governed-decision counter, hard budget caps, ROI reporting.
- **ROADMAP:** per-*decision* cost attribution — the join key linking LLM spend to an individual decision does not exist yet.

**One detail worth demoing** — small, and it tells them exactly who you are: the ROI report **refuses to compute** rather than estimate. With no labour assumption configured for a decision kind, it returns an explicit gap message instead of a plausible number. Most vendor ROI dashboards do the opposite, and this CEO has probably shipped one that does.

---

## 8 · Traction

Your weakest section. Do not dress it. **Reframe what traction means at this stage — then convert it into the ask.**

> "Commercial traction: zero. No customers, no pilots, no revenue. You'd be the first.
>
> Engineering traction is the real number: 72 requirement documents written before the code, 24 services, 28 verticals, ~2,500 tests, and a 12-step end-to-end test that runs a full claims lifecycle against real infrastructure — real Kafka, real object storage, real MLflow, a real LLM — including the negative cases. A forged authorisation grant is rejected. Self-approval is rejected. Those assertions run in CI."

Then the pivot that makes the whole section work:

> "What I'm short of isn't engineering. It's the three things I can't build alone: customers, a GTM motion, and a team. You have all three, pointed at healthcare, today. That's the entire reason I asked for this meeting."

---

## 9 · Competition / advantage

**Name the real alternatives** — pretending you have none is the fastest way to look naive to someone who sells in this space:

| Their real option | Honest read |
|---|---|
| Build it in-house with the offshore team | 2–3 years, $5–15M. And governance/audit/multi-tenancy is not the muscle a voice platform has built. |
| Partner with a healthcare AI point vendor | Solves one workflow, no governance spine, and they become a reseller of someone else's roadmap |
| Buy a back-office vendor | Priced on revenue, not on asset. Far more than this conversation costs. |
| Stay front-office only | The most likely choice — and the one where the margin erodes. Name it. |

Your advantage, without inflation:

> "Two things. First, the governance *is* the architecture, not a feature bolted on. You cannot get an ungoverned write through this system because the gate is the write path. Retrofitting that into a point solution is a rewrite, not a sprint.
>
> Second — plainly: the asset exists. Somebody already spent two years and several million dollars' worth of engineering on it. That was me, without capital. You'd be acquiring a running start, not funding a plan."

---

## 10 · Financials → the business case **for them**

Not projections. **Payback**, on the smallest possible commitment.

> "The only financial question that should matter today: what does one pilot cost you, and what does it prove?"

| | Joint pilot, 90 days |
|---|---|
| **They give** | One existing healthcare account, an exec intro, one SME, and 2–3 offshore engineers part-time |
| **They spend** | Nothing in licence. Their cost is people-time and a warm introduction. |
| **They get** | A governed prior-auth or appeals workflow live behind their voice agent, an ROI report from the platform's own meters, and a reference they own |
| **They learn** | Whether this becomes a product line — for the price of a quarter |
| **Downside** | Bounded and stated: shadow mode first. Nothing the AI produces touches a member or a claim. |

**Shadow mode is the risk answer. Say it explicitly:**

> "Phase one, nothing the AI produces reaches a member. It drafts, their people decide as they do today, and we compare agreement rates on real files. If the number is bad, you've spent a quarter and some engineer time and your customer's process is untouched."

A CEO buys bounded downside far more readily than upside — and this CEO has sold enough pilots to recognise a well-constructed one.

---

## 11 · Team

**Do not hide the bus factor. Price it, mitigate it, then convert it — in one breath.**

> "The team is me. That's a real risk and you should treat it as one.
>
> What reduces it: 72 written requirement documents, enforced documentation conventions, ~2,500 tests and a full CI pipeline — the system is specified and verified, not carried in my head. A competent team can pick it up from the docs. That was deliberate from day one, and it's why I'd hand your CTO the repository, the security posture doc and the gap list on day one."

Then the conversion — and for **this** company it is the natural close:

> "The honest fix isn't reassurance, it's people. You have an offshore team. My gap list is already written as scoped work items — connectors, pack authoring, the named product gaps. It reads like a backlog for exactly the team you already have."

If the CEO's first instinct is *"why don't we just hire you"* — that is a **good sign**, not a rejection. See §12 Option D. It is the most likely counter-offer in this room. Be ready, and be ready on IP.

---

## 12 · The ask

**Never open with a number.** Open with the shape, offer a menu, let them choose their commitment level. A menu converts because the CEO negotiates *which*, not *whether*.

> "I'm not raising a round. I'd rather have a partner than an investor. Four ways this could work, in increasing order of commitment — and I'm genuinely happy with any of them."

### Option A — One joint pilot *(lead with this)*
- **They give:** one existing healthcare account, an exec intro, an SME, 2–3 offshore engineers part-time.
- **They get:** a governed workflow behind their voice agent, an ROI report, a reference they own, and first look at everything after.
- **You get:** the three things you cannot manufacture — a real customer, real data, and proof.
- **Why lead here:** smallest yes, no board approval, no money changes hands, and it's the natural test of whether the bigger structures are worth doing.

### Option B — Channel / OEM partner
- They resell or white-label Datacern into their healthcare base. Resale margin theirs, subscription yours, services pool theirs.
- Use when they like the product but want to stay asset-light.

### Option C — New product line / JV
- They capitalise a venture ($1–3M) as their back-office line. You contribute the IP for founder-level equity plus salary; they take a meaningful stake, a preferential internal licence, and the services revenue.
- Use when the CEO is ambitious about the category rather than just wanting a tool. Given they already sell AI, this is a realistic landing spot.

### Option D — Acquisition / you join them
- They acquire the platform; you come in as CTO or Head of Healthcare AI. Compensation reflects the **asset**, not a standard employment package.
- **Be ready — this is the most probable counter-offer.** It is a legitimate outcome, not a defeat, provided the IP terms are right.

> ⚠️ **Protect the asset.** If the conversation turns to employment, do not sign before a lawyer reads the IP-assignment clause. Standard employment agreements routinely assign *all* IP including pre-existing work unless the existing codebase is explicitly carved out in writing. Get the carve-out in the contract, before you start. *(Not legal advice — a flag.)*

### Close

> "You've seen exactly what's built and exactly what isn't. The gap list is a work order, and it's sized for a team you already have. What I want is one healthcare account to prove this in — and I'd rather it be a company that already knows how to sell into a payer than a bigger name that takes a year to decide."

---

# Objection handling

The seven you will actually get from **this** CEO.

**"We could just build this ourselves."**
> "You could. It'd be two to three years and the expensive part isn't the AI — it's the governance, the multi-tenancy and the audit trail, and that's not the muscle a voice platform builds. Meanwhile your competitors get there too. The question isn't whether you can, it's whether it's the best use of the next two years of your team."

**"How is this different from what our voice agents already do?"**
> "It doesn't overlap at all — there is zero telephony in my platform, by design. Yours handles the conversation. Mine handles the decision the conversation creates. The seam between them is a webhook."

**"You're one person. What if you get hit by a bus?"**
> "Then you'd have 72 requirement docs, 2,500 tests and a full CI pipeline, and any competent team could continue — that's why I built it that way. But you're right that it's a real risk, and the fix is engineers, not reassurance. You happen to have them."

**"Why hasn't anyone bought this?"**
> "I've never sold it — I've been building. You're one of the first conversations, which is exactly why the terms available now won't exist in twelve months."

**"HIPAA? SOC 2? HITRUST?"** *(the first question their healthcare customers will ask)*
> "None started, and I'll be blunt: it's the number one blocker to a regulated production deployment. Six to twelve months and it needs funding. That's a genuine reason to start in shadow mode on a bounded dataset — and it's precisely the kind of thing a partner with healthcare customers and a compliance function does far better than a solo founder. It's on the ask list for a reason."

**"How do we know it works?"**
> "You don't yet, and I won't ask you to believe me. That's what shadow mode is for — 90 days alongside the existing process, measuring agreement rate on real files. If the number's bad, you've lost a quarter."

**"Can your agents talk to our systems over MCP?"** *(their CTO will ask this)*
> "Separate the two directions. Inbound — yes, today: we're an MCP server, spec 2025-06-18, `initialize`/`tools/list`/`tools/call`, and all nine agents' tool calls go through that one chokepoint. Your voice agent can call us as a standard MCP client and every call is authorised, tiered, kill-switchable and audited. Outbound — not yet: our federation to backends uses our own facade contract, so we can't consume a third-party MCP server today. The backend model already carries external kind, egress allow-list and vault auth, so it's an adapter behind an existing interface — but I haven't scoped it and I won't quote a date."
>
> Full detail: `docs/DATACERN_MCP_CONNECTIVITY.md`. Hand it to their CTO.

**"Our customers won't let AI touch claims decisions."**
> "They're right not to, and that's the product thesis. The AI never decides — it drafts, a named human approves, and the whole chain is on a tamper-evident record. The pitch to their compliance officer isn't 'trust the AI', it's 'you now have an audit trail you didn't have when a human did it silently'."

---

# The do-not-say list

Every line below is checkable and currently **false**. One slip ends the meeting.

- ❌ "We integrate with your voice platform" → **no integration exists.** Say: *"the seam is a webhook, and webhook ingestion is built."*
- ❌ "We can plug into any MCP server" → **no MCP client exists.** We are an MCP *server*; outbound federation is a proprietary facade. Inbound only.
- ❌ "All agent data access is MCP" → all agent *tool calls* are. Reads go direct to internal services.
- ❌ "HIPAA compliant" / "SOC 2 in progress" / "HITRUST" → **none started.**
- ❌ "All tests are green" → CI has known, tracked red items. Say *"green except known, tracked items."*
- ❌ "Four-eyes on every write, no exceptions" → tenants can policy-enable auto-execution for low-risk non-destructive writes. High-risk/destructive/admin **cannot** bypass — say it that precisely.
- ❌ "Cost per decision" as a live metric → ROADMAP, no join key exists.
- ❌ "Bedrock and Vertex supported" → schema accepts them, **no adapter**. Three real: Ollama, OpenAI/Azure-OpenAI, Anthropic.
- ❌ "Packs come with demo data" → **4 of 28** have seeded scenarios.
- ❌ "Fully autonomous agents" → autonomous event-triggered runs are **off** in every shipped configuration. Human-initiated is the solid path.
- ❌ Any reference to a customer, pilot, or user. There are none.
- ❌ Any revenue projection presented as forecast rather than illustration.

---

# Pre-meeting checklist

**One week out**
- [ ] Research their voice platform: which healthcare workflows do their agents already handle? Name one in the meeting.
- [ ] Find their published healthcare logos and recent announcements — you want to name the *type* of account for the pilot
- [ ] Decide your walk-away and your preferred structure **before** you walk in
- [ ] Print two copies of the §6 verified-state table — one is for their CTO to keep

**The day before — not optional**
- [ ] **Rehearse the exact demo end to end on the exact machine.** `make up`, then walk all five beats. Then `make doctor`, confirm green.
- [ ] Demo the **claims / prior-auth** path — `make up` seeds `insurance-claims-payer`-shaped work and it is the proven path. 8 seeded cases, 2 pending proposals, a promoted model.
- [ ] **Do not demo an arbitrary pack install live.** The `demo.sh load` path for the other 26 packs was broken until 2026-08-01 and the fix is not yet verified against a live stack. Want the pack-refusal beat? Rehearse that one specifically and record a backup.
- [ ] Record the whole demo as a fallback. Laptops fail; a $150M CEO's calendar doesn't reschedule.

**In the room**
- [ ] One-liner, then stop
- [ ] Ask "what happens to the case after your agent finishes the call?" early — and let them answer fully
- [ ] Show the refusal beat before any slide. 30 seconds, and it proves the thesis better than talking.
- [ ] Volunteer the gap list before they ask
- [ ] Present the ask as a menu, lead with the pilot
- [ ] **Never leave without a dated next step and a named person**

---

# Meeting agenda (45 minutes)

| Min | What |
|---|---|
| 0-5 | One-liner. The after-the-call question. Let them describe the gap themselves. |
| 5-15 | Live demo, five beats: refusal → prior-auth triage → approval (self-approval rejected) → learning loop → audit trail. |
| 15-22 | The healthcare fleet (§6) and the asset-fit table. This is the "oh" moment — don't rush it. |
| 22-30 | Verified state **and** the gap list, together, in that order. |
| 30-38 | The business case on the whiteboard, from their account numbers. |
| 38-43 | The ask menu. Lead with the pilot. Let them pick. |
| 43-45 | Next step: dated, named, written down. |

---

## Source & provenance

- Claims base: `docs/DATACERN_PARTNER_BRIEFING.md` (verified against code/CI 2026-07-26), `docs/security/SECURITY_POSTURE.md`, `docs/DATACERN_REALTIME_HEALTHCARE_POSITION.md`, `docs/demo/RUNBOOK.md`
- Counts re-measured against the repository 2026-08-01: 24 services, 28 packs (9 healthcare/life-sciences), 72 BRDs, ~2,560 test functions, 4 packs with seeded demo scenarios
- Voice/telephony surface: confirmed **absent** by repo-wide search, 2026-08-01
- Webhook ingestion + X12/FHIR/HL7v2 decoders: `services/ingestion-service/app/api/routes/hooks.py`, `services/ingestion-service/app/domain/{x12,fhir,hl7v2}.py`
- Healthcare clocks and event-native argument: `docs/DATACERN_REALTIME_HEALTHCARE_POSITION.md` §1
