# Pitch: Datacern AI → CEO, $150M-revenue operating company

**Audience:** the CEO of an existing ~$150M-revenue business — not a venture investor.
**Your position:** deep technical asset, no capital.
**Structure:** the 12-part "Perfect Pitch" frame, re-aimed at an operator.

**Rule of this document:** every claim traces to `docs/DATACERN_PARTNER_BRIEFING.md` (verified against code/CI) or to a count re-measured on 2026-08-01. Numbers that moved since that briefing are marked **[updated]**. Nothing here is aspirational unless labelled **ROADMAP**.

---

## Read this first: the frame change

The 12-part structure in your screenshot is a **seed VC deck**. Three of its sections are the wrong instrument for this room, and using them will cost you credibility:

| VC section | Why it misfires with an operator CEO | Use instead |
|---|---|---|
| **5. Market (TAM/SAM/SOM)** | They don't care about a $40B market. They care about one line in *their* P&L. | Their operation, bottom-up, in their numbers |
| **10. Financials / projections** | A five-year hockey stick from a pre-revenue solo founder reads as fiction. | Payback period on *their* spend |
| **12. The ask (raise $X)** | They're not an asset allocator. Asking them to be one puts you in the wrong queue. | A menu of structures, priced |

A CEO at this scale is asking four questions, in this order:
1. Does this fix a problem I actually have?
2. What does it cost me — in money, in my people's time, and in risk?
3. If it goes wrong, who is accountable?
4. Is this person credible?

Your entire pitch is the answer to those four. Everything else is decoration.

**Your one structural weakness — and its fix.** A solo founder with no capital and no customers has no track record to borrow credibility from. So you substitute a different currency: **verifiable precision.** You will state what is not built, before they ask. That is not modesty; it is the only move that makes the *rest* of your claims believable. A CEO who catches you overclaiming once discounts everything you said. A CEO who watches you volunteer your own gaps starts trusting the parts you assert.

The briefing already says it: *the honesty is the brand.*

---

## Before you fill this in: one input I need

The single biggest lever on this pitch is **what business the company is in.** It determines which of the 27 verticals you lead with, which problem you open on, and whether you demo claims, disputes, or AML.

Below, `[VERTICAL]` marks every place that changes. The three strongest fits in the built pack fleet:

| If they are… | Lead pack | Their pain in one line |
|---|---|---|
| Insurance / health plan / TPA | `insurance-claims-payer`, `payer-fwa-siu` | Claims and prior-auth review is people-expensive and audit-exposed |
| Bank / fintech / card issuer | `card-disputes`, `banking-aml`, `chargeback-representment` | Reg E/Z clocks, dispute volume, AML alert triage |
| Any firm with a back-office review queue | `ap-invoice-audit`, `underwriting-intake`, `warranty-claims` | Humans reading documents and deciding, at cost |

Tell me the industry and I'll sharpen every section.

---

# The 12 sections

## 1 · Title / one-liner

> **"I've built the system that lets you put AI into [VERTICAL] decisions without losing the audit trail — and I'm looking for the first company brave enough to run it for real."**

Delivery notes:
- One sentence. Then **stop talking.** The silence does work.
- No architecture, no service count, no "agentic". They will ask "how" — let them pull it out of you.
- The phrase *"brave enough"* is deliberate. It's honest about stage, and it invites a CEO who likes being first.

---

## 2 · Problem

Aim at the thing already on their exec agenda. Frame it as the **trap**, not the pain — CEOs know their pain, they don't know they're in a trap:

> "You're under pressure to use AI in operations. You've probably got pilots running. And every one of them stalls in the same place — not because the model is wrong, but because nobody can answer the compliance question: *who decided this, on what evidence, and can you prove it a year from now?*
>
> So you're choosing between two bad options. Ship AI you can't defend to a regulator or an auditor. Or don't ship, and keep paying humans to read files."

Why this lands: it's true, it's specific to regulated operations, and it names a failure *they have already experienced* — which makes you sound like someone who's been in the room rather than someone selling.

**Then hand them the mirror** — ask, don't assert:
> "How many people in [VERTICAL] operations are, functionally, reading a file and applying a rule?"

Their answer is the entire business case. Write the number down in front of them.

---

## 3 · Solution

> "AI drafts the decision with cited evidence. A named human approves it. Every approval becomes training data that improves the next one — and the retrain goes through the same approval gate.
>
> The point isn't AI that decides. It's **AI decisions your regulator can audit**: evidence, proposer, approver, effect, on a tamper-evident record."

Three proof points — say them as facts, because they are, and each is checkable:

1. **Self-approval is rejected by the server.** Not a UI convention, not a policy document. The person who proposed cannot be the person who approves. High-risk, destructive and admin actions require a second, distinct human, with **no tenant opt-out**.
2. **A pack refuses to install against a tenant with no real data** — and names every missing field. The platform will not half-work to make a demo look good.
3. **Hard budget caps that fail closed.** Platform → tenant → workspace → principal → key. When the ceiling is hit, it stops. A CEO who has been surprised by a cloud bill will react to this.

---

## 4 · Why now

Three converging forces, no hype:

- **Regulatory.** The EU AI Act's high-risk obligations, and the auditability expectations already live in financial services and healthcare, are turning "explain this decision" from good practice into a filing requirement. The pack fleet already carries control mappings to EU AI Act, NIST AI RMF and ISO 42001.
- **Economic.** Model capability is now good enough for drafting; the bottleneck moved from *can it reason* to *can you govern it*. The scarce thing is the governance layer, not the model.
- **Competitive.** Their competitors are running the same stalled pilots. Being 12 months early on *governed* AI in [VERTICAL] is a durable operating advantage — the data flywheel compounds and can't be bought later.

> "The models are commodities and getting cheaper. The governed workflow around them is the moat. That's what I built."

---

## 5 · Market → **their** P&L

**Do not present a TAM slide.** Build the case from their numbers, live, on a whiteboard. It is more persuasive than any market chart because *they* supply the inputs.

```
  A   People doing review work in [VERTICAL]        ← ask them
  B   Fully-loaded cost per person                  ← ask them
  C   Share of their time that is read-file-apply-rule   ← ask; typically 50-70%
  D   Share of that AI can draft (human still signs)     ← be conservative: 30-40%

      Addressable labour  = A × B × C
      Year-1 realistic    = A × B × C × D × 0.5   ← half-year ramp, stated as such
```

Then the second line, which for a regulated operation is often the bigger one:

> "That's the labour line. The one your CFO will care about more is the error line — rework, leakage, and the cost of an audit finding. I can't size that from outside. You can."

**Why this beats a TAM slide:** you never claim a number about their business. They compute it. People don't argue with their own arithmetic.

---

## 6 · Product / tech

Keep it to four sentences unless they ask. Then go as deep as they want — depth is your advantage, but only *on request*.

> "It's a platform Core plus installable vertical packs. The Core does identity, permissions, case management, the data lakehouse, the agent runtime and the governance gate. A pack is configuration — the ontology, decision tables, dashboards and agent setup for one vertical. 27 verticals are built. Installing one configures a tenant without touching platform code."

**Verified state, as of 2026-08-01** — hand this to their CTO, it's designed to survive scrutiny:

| | Verified | **[updated]** |
|---|---|---|
| Services | **24** in the build inventory (Go + Python + GraphQL BFF + Next.js UI) | was 23 |
| Vertical packs | **28** (27 verticals at v2.1.0 + 1 shared library) | — |
| Agents | 9 built-in, all 9 passing a live real-LLM roster test | — |
| BRDs | **72** numbered requirement docs written before build | was 70+ |
| Tests | **~2,560 test functions** in-repo, strict count (985 Go, 996 TS, 578 Python) | conservative recount |
| Packs with a seeded demo scenario | **4 of 28** (insurance-claims-payer, card-disputes, banking-aml, payer-fwa-siu) | was 2 |
| Multi-tenancy | Postgres RLS with `FORCE ROW LEVEL SECURITY` across the stateful services; tenant pinned from the verified JWT only | — |
| Audit | Per-tenant hash-chained log in ClickHouse + S3 Object-Lock COMPLIANCE-mode WORM export | — |
| Infrastructure-as-code | Helm + Terraform for AWS/GCP/Azure — **written and CI-built, never applied to a production cloud** | — |

The last row is deliberately in the table. Put your biggest gap where they can see it, in your own material.

---

## 7 · Commercial model

Be straight that pricing is unset — and turn that into their advantage:

> "Annual platform subscription per use-case, plus consumption on metered decisions, plus packs as add-ons. I'm not going to pretend I have a price list — you'd be the first customer, so the first three design partners set it.
>
> What I'll commit to: design-partner pricing at roughly 60% off whatever list becomes, co-development input on the roadmap, and case-study rights. If you want an anchor for magnitude, enterprise ACV lands in the mid-six figures — but it should be anchored to the review labour it displaces, and you just told me that number."

Built vs roadmap, so their CTO doesn't catch you:
- **Built:** commercial plans, seat/quota enforcement, metering by tenant/workspace/user/agent, a governed-decision counter, hard budget caps, ROI reporting.
- **ROADMAP:** per-*decision* cost attribution. The join key linking LLM spend to an individual decision doesn't exist yet.

**One detail worth demoing** — it's small and it tells them who you are: the ROI report **refuses to compute** rather than estimate. When decision kinds have no labour assumption configured, it returns an explicit gap message instead of a plausible number. Most vendor ROI dashboards do the opposite.

---

## 8 · Traction

This is your weakest section. **Do not dress it up — reframe what traction means at this stage.**

> "Commercial traction: zero. No customers, no pilots, no revenue. You'd be the first.
>
> Engineering traction is the real number: 72 requirement documents written before the code, 24 services, 28 verticals, ~2,500 tests, and a 12-step end-to-end test that runs the whole claims lifecycle against real infrastructure — real Kafka, real object storage, real MLflow, a real LLM — including the negative cases. A forged authorisation grant gets rejected. Self-approval gets rejected. Those assertions run in CI."

Then the line that reframes the whole section:

> "What I'm short of isn't engineering. It's the one thing I can't build alone — a real operation, with real data and real reviewers, to prove it against. That's the specific thing I'm here for."

That sentence converts your weakness into the reason for the meeting.

---

## 9 · Competition / advantage

**Name the real alternatives.** Pretending you have no competition is the fastest way to look naive:

| Their real option | Honest read |
|---|---|
| Big consultancy builds it | 18-24 months, $5-15M, and they own nothing reusable |
| Point AI vendor | Solves one workflow, no governance spine, another silo |
| Build in-house | Their engineers don't want to build audit infrastructure, and it isn't their business |
| **Do nothing** | The most likely competitor. Name it. |

Your advantage, stated without inflation:

> "Two things. First, the governance is the architecture, not a feature bolted on — you cannot get an ungoverned write through this system, because the gate is the write path. Retrofitting that into a point solution is a rewrite.
>
> Second, and I'd rather say this plainly: the asset already exists. Somebody already spent two years and the equivalent of several million dollars in engineering on it. That somebody was me, and I did it without capital. You'd be acquiring a running start, not funding a plan."

---

## 10 · Financials → the business case **for them**

Not projections. **Payback.**

> "Here's the only financial slide that should matter to you: what you spend, what you get back, and when."

| | Design partner year 1 |
|---|---|
| **They spend** | Subscription (design-partner rate) + ~2 SME days/week for 90 days + a dev/infra contact |
| **They get** | One [VERTICAL] workflow in production, an ROI report from the platform's own meters, and preferential pricing locked for 3 years |
| **Payback** | Compute live from §5. If Year-1 realisable savings > Year-1 cost, you have your answer in the room. |
| **Their downside** | Bounded and stated: a 90-day pilot, running in shadow mode first, alongside the existing process |

**Shadow mode is the risk answer.** Say it explicitly:

> "For the first phase nothing the AI produces touches a customer. It drafts, your people decide as they do today, and we compare. If the agreement rate isn't good enough, you've spent 90 days and a small budget and you keep your existing process untouched. That's the whole downside."

A CEO buys bounded downside far more readily than they buy upside.

---

## 11 · Team

**Do not hide the bus factor. Price it, then mitigate it in the same breath.**

> "The team is me. That's a real risk and you should treat it as one.
>
> What reduces it: 72 written requirement documents, enforced documentation conventions, ~2,500 tests, and a full CI pipeline — so the system is specified and verified, not just in my head. Somebody competent can pick this up from the docs. That was a deliberate choice from the start, and it's why I'd hand your CTO the repository and the gap list on day one."

Then convert it into an ask:

> "The honest fix isn't reassurance, it's people. If this goes forward, part of what I need from you is engineers alongside me — yours or funded — so the bus factor stops being one."

If the CEO's first instinct is *"why don't we just hire you"* — that is a **good sign**, not a rejection. See §12, Option D. Be ready for it; it's the most likely counter-offer in this room.

---

## 12 · The ask

**Never open with a number.** Open with the shape, present a menu, let them choose their own commitment level. Menus convert better than single asks because the CEO gets to negotiate *which*, not *whether*.

> "I'm not raising a round. I'd rather have a customer than an investor. Here's what would actually move this forward, in increasing order of commitment — and I'm happy with any of them."

### Option A — Design partner *(lead with this)*
- **They give:** a paid 90-day pilot on one [VERTICAL] workflow, an SME, and a named exec sponsor.
- **They get:** design-partner pricing, roadmap input, 3-year price lock, first-mover advantage in their sector.
- **You get:** revenue, a reference logo, and real data — the three things you cannot manufacture alone.
- **Why lead here:** it's the smallest yes, it needs no board approval, and it's *customer-funded* — you keep 100% of the company.

### Option B — Design partner + upside
- As A, plus warrants or a small equity grant for the sponsor company.
- Use when the CEO likes the product but wants to participate in the outcome.

### Option C — Venture build
- They capitalise a new entity ($1-3M). You contribute the IP for founder-level equity plus a salary. They take a meaningful stake and a preferential internal licence.
- Use when the CEO is genuinely ambitious about the category rather than just wanting the tool.

### Option D — You join them
- You come in as CTO / Head of AI. The platform is **licensed** to them, or assigned on agreed terms, with your compensation reflecting the asset — not a standard employment package.
- **Be ready for this — it is the most probable counter-offer.** It is a legitimate outcome, not a defeat, provided the IP terms are right.

> ⚠️ **Protect the asset.** If the conversation moves toward employment, do not sign anything before a lawyer reads the IP-assignment clause. Standard employment agreements routinely assign *all* IP, including pre-existing work, unless the existing codebase is explicitly carved out in writing. Get the carve-out, in the contract, before you start. *(I'm not a lawyer — this is a flag, not advice.)*

### Close

> "You've seen exactly what's built and exactly what isn't. The gap list is the work order. What I want is one real operation to prove it in — and I'd rather that be a company that moves first than a bigger name that moves in a year."

---

# Objection handling

The six you will actually get.

**"You're one person. What if you get hit by a bus?"**
> "Then you'd have 72 requirement docs, 2,500 tests and a full CI pipeline, and any competent team could continue — that's why I built it that way. But you're right that it's a real risk, and the fix is engineers, not reassurance. That's part of what I'm asking for."

**"Why hasn't anyone bought this?"**
> "I've never sold it. I've been building. You're one of the first conversations — which is exactly why the terms available to you now won't exist in twelve months."

**"We don't have AI budget."**
> "Then don't take it from AI budget. This displaces review labour in [VERTICAL] operations — that's where the money is and where the return shows up. And the pilot is small by design."

**"How do I know it works?"**
> "You don't yet, and I'm not going to ask you to believe me. That's what shadow mode is for: 90 days running alongside your existing process, measuring agreement rate on your real files. If the number is bad, you've lost a quarter and a small budget and nothing else."

**"What about SOC 2 / HITRUST?"**
> "Not started, and it's the number one blocker to a regulated production deployment — six to twelve months and it needs funding. That's a genuine reason to start in shadow mode on a bounded dataset. It's also one of the things a first customer relationship pays for."

**"Our IT will say no."**
> "They should push back, and I'd want the meeting. It runs in your cloud or on-prem, the tenancy isolation is enforced at the database, and I'll give your CTO the repository, the security posture document and the gap list on day one. I'd rather they find problems now than in production."

---

# The do-not-say list

Every line below is checkable and currently **false**. Saying one and being caught ends the meeting.

- ❌ "All tests are green" → CI has known, tracked red items. Say *"green except known, tracked items."*
- ❌ "Four-eyes on every write, no exceptions" → tenants can policy-enable auto-execution for low-risk non-destructive writes. High-risk/destructive/admin **cannot** bypass — say it that precisely.
- ❌ "Cost per decision" as a live metric → ROADMAP, no join key exists.
- ❌ "SOC 2 in progress" → not started.
- ❌ "Bedrock and Vertex supported" → schema accepts them, **no adapter**. Three real providers: Ollama, OpenAI/Azure-OpenAI, Anthropic.
- ❌ "Packs come with demo data" → **4 of 28** have seeded scenarios.
- ❌ "Fully autonomous agents" → autonomous event-triggered agent runs are **off** in every shipped configuration. Human-initiated is the solid path.
- ❌ Any reference to a customer, pilot, or user. There are none.
- ❌ Any revenue projection presented as a forecast rather than an illustration.

---

# Pre-meeting checklist

**One week out**
- [ ] Confirm the industry → pick the lead pack and rewrite every `[VERTICAL]`
- [ ] Research their operation: headcount, recent earnings commentary, any public AI initiative
- [ ] Decide your walk-away and your preferred structure *before* you walk in
- [ ] Print two copies of the §6 verified-state table — one is for their CTO to keep

**The day before — this one is not optional**
- [ ] **Rehearse the exact demo, end to end, on the exact machine.** `make up`, then walk all five beats.
- [ ] Then `make doctor` and confirm green.
- [ ] Demo the **claims** path (`make up`). It is the proven one — 8 seeded cases, 2 pending proposals, a promoted model.
- [ ] **Do not demo an arbitrary pack install live.** The `demo.sh load` path for the other 26 packs was broken until 2026-08-01 and the fix has not yet been verified against a live stack. If you want the pack-refusal beat, rehearse it specifically and have a recording as backup.
- [ ] Record the demo as a fallback. Laptops fail; a $150M CEO's calendar doesn't reschedule easily.

**In the room**
- [ ] One-liner, then stop
- [ ] Ask the headcount question early and write the number down
- [ ] Show the refusal beat before any slide — 30 seconds, and it proves the thesis better than talking
- [ ] Volunteer the gap list before they ask
- [ ] Present the ask as a menu
- [ ] **Never leave without a dated next step and a named person**

---

# Meeting agenda (45 minutes)

| Min | What |
|---|---|
| 0-5 | One-liner. The problem. The headcount question — write the number down. |
| 5-15 | Live demo: the five beats. Refusal → triage → approval (self-approval rejected) → learning loop → audit trail. |
| 15-25 | Verified state (§6 table) and the gap list (§8), presented **together**, in that order. |
| 25-35 | The business case, built on the whiteboard from *their* numbers. |
| 35-42 | The ask menu. Let them pick. |
| 42-45 | Next step: dated, named, written down. |

---

## Source & provenance

- Claims base: `docs/DATACERN_PARTNER_BRIEFING.md` (verified against code/CI 2026-07-26), `docs/security/SECURITY_POSTURE.md`, `docs/demo/RUNBOOK.md`
- Counts marked **[updated]** re-measured against the repository on 2026-08-01
- Demo beats: `docs/DATACERN_PARTNER_BRIEFING.md` §7B
- Gap list: `docs/DATACERN_PARTNER_BRIEFING.md` §3

If a claim in this document and the codebase ever disagree, **the codebase is right and this document is a bug.**
