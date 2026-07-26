# What Datacern AI actually is

**A plain-English explainer — for founders, new joiners, and anyone who needs to
describe this product without an engineering background.**

> A system that lets AI do regulated back-office work — and makes it
> structurally impossible for that AI to make the final call.

Everything stated as fact here was verified running on a real machine on
2026-07-24. The things that are **not** true yet get their own section, because
a claim you can't defend is worse than no claim. Full technical detail lives in
[`docs/demo/RUNBOOK.md`](demo/RUNBOOK.md).

---

## 1. The core idea — a very fast junior analyst with no signing authority

Imagine hiring an analyst who reads a customer dispute in two seconds, pulls up
the relevant rule, drafts the recommendation, and cites the evidence. Brilliant.
But they have **no authority to sign anything**. Everything they produce goes
into a queue for a manager to approve or reject.

Now imagine that this isn't a company policy the analyst could break — it's the
locks on the building. They physically cannot sign. That's the product.

| | |
|---|---|
| **1. Work arrives** | A dispute, a claim, an alert — from the customer's own systems. |
| **2. AI prepares** | Reads the file, applies the rules, drafts a recommendation with its reasoning. |
| **3. A human decides** | It becomes a *proposal*. Nothing happens until a named person approves. |
| **4. Receipt** | Who proposed, who approved, what changed — permanently recorded. |

Step 3 is the whole company. Everything else is plumbing that makes step 3
credible to a regulator.

---

## 2. The four parts

**The platform.** The shared machinery every customer runs on: logins,
permissions, data loading, dashboards, the audit log. Roughly two dozen separate
programs working together. This is the part that took most of the effort and
that a customer never thinks about — until an auditor asks.

**The packs.** Pre-built kits for one specific job — card disputes, insurance
claims, money-laundering alerts, supplier invoices. A pack brings the industry
rules, the outcome codes, the dashboards and the AI instructions for that job.
**28 exist** (27 industry packs plus 1 shared library). Installing one turns
the generic platform into a working dispute department.

**The agents.** Nine AI workers, each with one job — triage a case, design a
dashboard, set up a data feed, train a model, watch for model drift. Each is
restricted to a specific list of things it is allowed to attempt. Anything
outside that list is refused before it is even considered.

**The approval desk.** Where proposals wait. A reviewer sees the recommendation,
the reasoning, and a *system-generated* description of what will actually happen
— so a persuasively-worded suggestion cannot disguise a risky action. Risky
items require a **second, different person**.

---

## 3. Who uses it

| Role | What their day looks like |
|---|---|
| **The specialist** (front line) | Opens their queue, worst deadline first. The AI has already drafted a recommendation on each. They accept, change, or escalate — much faster than starting cold. |
| **The manager** (supervisor) | Works the approval desk. Sees what is proposed and why, approves or rejects with a reason. Cannot approve their own requests. |
| **The compliance lead** (second line) | Never touches a case. Pulls the audit trail when an examiner asks "show me how this decision was made," and gets a complete answer. |

---

## 4. Why anyone would buy it

Banks, insurers and healthcare companies are under real pressure to use AI on
this work. They also cannot let a model decide anything a regulator will later
question — and today they mostly cannot prove what a model did, so the honest
answer inside those companies is "not yet."

Datacern removes the blocker rather than the human. The customer gets the speed
of AI on the preparation, keeps a named human on every decision, and gets an
audit trail that survives an examination.

**The pitch is not "our AI is smarter." It is "our AI is admissible."**

---

## 5. Honest status — what's real, and what isn't

Read this before saying anything to a customer or an investor.

### Verified working (watched running, 2026-07-24)

- All **9 AI workers** run against a real language model and finish in about 20 seconds.
- **7 of 9** correctly stopped and waited for human approval instead of acting.
- The system **fails safe**: when a security component was down, it refused every request rather than guessing.
- A pack **refused to install** against a customer with no data, naming every missing field — then installed cleanly once the data was there.
- Real spreadsheets loaded end-to-end and the dashboards showed correct numbers.
- Customers are genuinely **walled off from each other**.

### Not true yet

- **Zero customers. Zero pilots.** It has never run outside a laptop.
- **Never load-tested.** We do not know what happens with 50 concurrent users.
- All 28 packs have recorded installs at their v1.0.0 form (install ledgers,
  2026-07-15/16), and every pack's current version passes the automated
  cross-component coherence check in CI — but only **card disputes** has a
  recorded install at the current v2.1.0. The other 27 current versions
  haven't been install-tested yet.
- The chat assistant **cannot answer questions about your data** yet — it reasons about one case at a time.
- Fully unattended AI runs are **degraded**; only human-initiated work is solid.
- No independent security audit.

---

## 6. Vocabulary — the words that appear on screen

| Term | What it means |
|---|---|
| **Tenant** | One customer's private world. Their data is invisible to every other customer — enforced by the database itself, not by careful coding. Say "customer." |
| **Use case / Workspace** | A project inside one customer — e.g. "Disputes" separate from "Fraud." Lets a big bank keep teams apart. |
| **Pack** | The pre-built kit for one industry job. Ships rules and know-how, **never data**. |
| **Binding contract** | The list of data fields a pack needs before it will run. If the customer cannot supply them, the install stops and says exactly what is missing. This is a feature — it is why nothing half-works. |
| **Case** | One piece of work: a single dispute, claim or alert. |
| **Decision table** | The rules, written as readable rows — "if the regulatory deadline has passed, mark critical and send to human review." Plain enough for a compliance officer to audit. No AI involved, and instant. |
| **Disposition** | The outcome code — "resolve in customer's favour," "file a chargeback." Each pack defines its own valid list. |
| **Agent** | One AI worker with one job and a fixed list of permitted actions. |
| **Proposal** | An AI recommendation waiting for a human. **The central concept.** AI output is always a proposal, never an action. |
| **Four-eyes** | Banking term for "two different people must sign." The system enforces it — you cannot approve your own request. |
| **Copilot** | The chat assistant. Good at explaining one case and drafting proposals. Not yet a way to query your whole database. |
| **Audit trail** | The permanent record. Tamper-evident, and exportable into the customer's own security tooling. |

---

## 7. Ten sentences to be able to say cold

If you can say these without notes, you can run a first meeting.

1. "We let AI do regulated back-office work without letting it make the final decision."
2. "Every AI output is a proposal. A named human approves it. That's enforced by the system, not by policy."
3. "You can't approve your own request — anything risky needs a second person."
4. "The rules are yours, written in plain language, and you can read every one of them."
5. "When something is uncertain, the system stops and asks. It never guesses."
6. "Every decision has a receipt: who proposed, who approved, what changed."
7. "We install a pre-built kit for your specific workflow — disputes, claims, AML — not a blank platform."
8. "The kit refuses to install until your real data matches what the workflow needs. Nothing half-configured."
9. "Your data never leaves your tenant, and no other customer can see it."
10. "We're pre-launch. I'd rather show you the working system and be honest about the gaps than pitch you a roadmap."

Sentence 10 matters as much as the other nine. At this stage candour is an asset
— the people worth selling to can tell the difference, and the product's whole
thesis is that honesty is designed in.

---

## The best demo beat you have

The strongest single moment in the product is a **refusal**: the pack declining
to install against a customer with no data, naming all 41 missing fields. It
takes 30 seconds and proves the governance claim better than any slide. Lead
with it.
