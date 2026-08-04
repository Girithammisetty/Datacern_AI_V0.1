# The commercial wedge — what makes Datacern sign-up-able

Date: 2026-08-04 · Purpose: name the ONE capability that turns a solid platform
into a commercial product, grounded in (a) the 2026 market and (b) what the
codebase can actually back. Honesty rule inherited from the repo: every claim
below is tagged **REAL** (backed by a PROVEN/TESTED asset), **ASSEMBLE** (parts
exist, need packaging), or **BUILD** (the genuine gap to close). No vapor on a
slide.

## 1 · The problem you correctly identified

"Case management + decision intelligence" is a mature, crowded category —
~$8B in 2025 heading to ~$18B by 2030, owned by FICO, SAS, IBM, Pega, Appian
([market](https://fintechnews.ch/aifintech/top-decision-intelligence-platforms-of-2026-according-to-gartner/82427/)).
Rules engines are 30 years old. Every enterprise already has a case system and
a decision engine. So "we do governed decisions" is **not a wedge** — it's a
category you'd be entering third, losing to FICO on analytics depth and Pega on
workflow depth. That is exactly why sign-up is hard: you're asking a buyer to
displace something that already works.

The wedge cannot be the category. It has to be a capability the incumbents
**structurally cannot** offer and the buyer **cannot get** from their existing
stack or from a generic LLM copilot.

## 2 · Where the market actually moved in 2026 — two buying triggers

Two shifts, both post-dating the incumbents' architectures:

**Trigger A — agentic governance is the #1 adoption blocker.** Nearly two-thirds
of enterprises name security/risk as the top barrier to scaling AI agents, and
only ~30% have mature agentic controls; Gartner projects task-specific agents in
40% of enterprise apps by end-2026, up from <5%
([state of agentic governance](https://semanticos.io/blog/ai-trust-2026-agentic-era/)).
The quotable core: *"the hard part is no longer getting an agent to act — it is
being able to explain, after the fact, why it acted, what it read, and who is
answerable for it,"* arriving exactly as **EU AI Act enforcement activates
2026-08-02**
([compliance deadline](https://zylos.ai/research/2026-05-01-ai-agent-governance-compliance-2026/)).

**Trigger B — "own your model" from proprietary expertise is the enterprise AI
moat.** Small, fine-tuned models on proprietary data now beat frontier LLMs on
narrow tasks, and the strategic value is a compounding data moat: *"each
production deployment generates training data for the next iteration"* —
against generic LLM copilots that mean vendor lock-in, data leaving, and nothing
you own
([the SLM shift](https://www.opensourceforu.com/2026/04/the-quiet-revolution-how-small-language-models-are-redefining-enterprise-ai-strategy/)).

Datacern's architecture already sits on **both** triggers. That intersection is
the wedge.

## 3 · The wedge — the Governed Decision Flywheel

> Not "another decision intelligence platform." The system where every expert
> decision is **governed enough to deploy AI in a regulated process today**, and
> is **captured as proprietary training signal that compounds into a decision
> model you own**.

Two moats, one mechanism. The same four-eyes approval that makes the AI
*admissible* is also the event that produces a *labeled training example*. The
governance chokepoint IS the proprietary-data factory — a competitor without
that chokepoint cannot manufacture the same expert-labeled corrections.

### Moat 1 — Governance (why they can BUY it now) · **REAL**
Propose → four-eyes approve → cryptographically-signed execution grant →
WORM audit. This is the exact "explain why it acted, what it read, who is
answerable" machinery the market says is blocking adoption. It is **PROVEN**:
`deploy/e2e/test_fhir_journey.py` and `test_governed_write_loop.py` assert on
real system-of-record bytes that an ungranted or **forged-grant** write is
refused and only a legitimately-signed, human-approved grant lands exactly one
change — with every invocation in the audit log. The one-liner the repo already
uses: *"our AI isn't smarter — it's admissible."* FICO/SAS **score**; they do
not govern the **action** an agent takes on the system of record.

### Moat 2 — Learning (why they STAY — compounding lock-in) · **REAL corpus / BUILD the model**
Every correction → labeled example → the model proposes → the expert corrects →
the loop compounds. The classical-ML leg is **PROVEN** end to end
(`deploy/e2e/test_learn_journey.py`: 24 governed resolutions → real training run
→ self-approval rejected 403 → distinct-human promotion → score → cases for
exactly the flagged rows). The correction corpus itself — consent-gated,
PII-redacted, checksummed, versioned, RLS-isolated
(`agent-runtime/app/domain/{transcripts,sft_curation}.py`) — is the repo's one
asset where **the code is ahead of the pitch**. A generic copilot sends your
data out and leaves you owning nothing; a rules engine never learns at all.

## 4 · Why this is sign-up-able (your actual pain)

- **It sits ALONGSIDE, not instead of.** No rip-and-replace of Pega/ServiceNow/
  FICO. Datacern connects to the existing system of record via the tool-plane /
  FHIR / connectors and becomes the governed-decision-and-learning layer on top
  — matching the market's own framing that agents become the interface layer
  while systems of record stay underneath.
- **Value on day one:** the copilot proposes from the first case.
- **Value that compounds:** accumulated corrections + a model you own = a
  switching cost that grows every day of use. That is the commercial engine —
  the reason to sign *and* the reason not to leave.
- **A compliance tailwind, not a science project:** EU AI Act Art. 14 human
  oversight, CMS WISeR, Colorado SB 26-189 — the governance spine is the thing
  a regulated buyer's compliance team can actually sign off on.

## 5 · The ONE capability to ADD — the Expertise Ledger

The flywheel is real but **invisible**, and the "you own a model" half is
**roadmap**. The commercial capability to add is not another engine — it is the
product surface that makes the flywheel **visible, measurable, and ownable**,
plus the two technical legs that turn roadmap into a live demo.

**5.1 · The Expertise Ledger UI — `ASSEMBLE` (highest leverage).**
One screen that says to the buyer, from their own data:

> "This quarter your experts made **4,120 governed decisions**. Your decision
> model now agrees with them **91%** of the time, up from 84%. Every decision
> has a named approver and a hash-chained audit trail. Here is the model trained
> on *your* experts — and the button to export it."

It assembles parts that already exist: transcript counts, `outcomes.effectiveness`,
the audit chain, SFT dataset versions. It converts an invisible backend loop
into the artifact a buyer signs for — *"the expertise walking out the door,
turned into an asset you own."* This is the single most leverage-per-effort
item: mostly a read-model + UI over existing data.

**5.2 · Close the outcome loop — platform mechanism `DONE`; producer connector `BUILD`.**
The automated inbound signal — *was the decision actually right?* (chargeback
won, SAR substantiated, readmission avoided) — now flows from the system of
record back into the model. `POST /api/v1/outcomes/ingest`
(`agent-runtime/app/api/routes/outcomes.py`) takes realized outcomes keyed by
the **business entity** the SoR knows (a case/claim/dispute URN, not our
internal id), resolves each to the actioned decision that produced it
(`store.find_actioned_proposals_by_urn`), records a `label_source=sor` label
with agreement computed against what was decided, and — with no further call —
those labels flow into decision effectiveness (the Expertise Ledger's agreement
number) AND into SFT curation weighting (correct → imitate, incorrect →
down-weight). Unmatched keys are reported honestly, re-ingest is idempotent,
tenants isolated; 7 unit tests prove the chain end to end. This is what lets
you say "decision intelligence that learns from **reality**," not a rules
engine. The one remaining piece is a thin producer — a connector/webhook/event
relay that pushes the SoR's realized results into that seam; the hard part (the
business-key→decision join + automated labeling + corpus weighting) is built.

**5.3 · Make "own your model" demoable — CPU existence proof `DONE`; production LoRA `GPU`.**
The audit's four gaps (never executed, no serving path, `promote()` flips a dead
column, no tenant partition) are closed on CPU. A `LocalCpuTrainer`
(`agent-runtime/app/adapters/local_trainer.py`) distils the tenant's governed
SFT corpus into a **real, servable decision student** (`app/domain/distill.py`,
a trained NB classifier — stdlib+numpy, no GPU); it is stored **tenant-
partitioned** (`{tenant_id}/{archetype}/{run_id}`); an **eval-gate**
(`TrainingJobService.gate`) marks it promotable **only if it beats the baseline
on the tenant's held-out decisions** (the "wins" bar — the majority-class
predictor, or the incumbent student it would replace); and `POST /api/v1/
distilled/serve` **serves the promoted student** so the owned model actually
decides — with an honest 404 when nothing is promoted, never a base guess
dressed up as the owned model. 19 tests prove the full train → gate(wins) →
promote → serve loop end to end, including a loser being refused and tenant
isolation; the local backend is wired into the demo boot
(`AR_SLM_TRAINER_BACKEND=local`).

What stays honest roadmap: a **generative** distilled LLM at production scale —
that is the genuinely GPU-gated leg, and `ModalGpuTrainer` +
`slm_modal_app.py` (real QLoRA on an A10G) already exist for it, unchanged, and
require the customer's GPU account. The CPU student is the right tool for the
narrow *decision* task (small models win on narrow tasks) and proves the whole
own-your-model mechanism the buyer needs to see; the LLM variant is a compute
upgrade of the same, now-proven, pipeline.

## 6 · Competitive teardown — why only Datacern

| Competitor | Does | Structurally cannot |
|---|---|---|
| FICO / SAS / IBM (decision intelligence) | score, optimize | govern the *action* an agent takes on the SoR; turn expert corrections into an owned model |
| Pega / Appian (case + BPM) | workflow, rules depth | learn from corrections; produce a portable model asset; agentic-action governance with signed grants |
| Generic LLM copilots (Microsoft/Google/OpenAI) | draft, summarize | give you a model you *own*; keep data in-tenant; four-eyes admissibility + WORM audit |
| Build-it-yourself | anything | the governance chokepoint + the label factory + the audit spine, integrated and proven |

The defensible sentence: **"They score. We govern the decision that follows the
score — and every decision trains a model you own."**

## 7 · Commercial model this unlocks

- **Land:** governed copilot on one high-volume decision (claims triage, card
  disputes, prior-auth) — fast value, low switching risk, sits alongside.
- **Expand:** the Expertise Ledger makes the compounding model asset visible →
  price on **decisions governed** + **expertise captured/model quality**, not
  seats. Usage that deepens the moat is usage you can meter (the metering +
  value-report plumbing already exists).
- **Retain:** the owned model + accumulated corrections are the switching cost.
  Offer model export as a *trust* feature — paradoxically it makes buyers more
  willing to sign, because it removes the lock-in objection while the compounding
  advantage keeps them.

## 8 · Build order (leverage-first)

1. **Reposition** (free, now): lead every conversation with the flywheel, not
   "case management." Category = "the governed decision flywheel / expertise-to-
   model system," adjacent to DI and case management, not inside them.
2. **Expertise Ledger UI** (`ASSEMBLE`, weeks) — the surface that sells it.
3. **Close the outcome loop** (`BUILD`, weeks) — SoR-inbound outcome → training
   weight, with an e2e proof.
4. **One real owned model** (`BUILD`, the hard yard) — minimum-demoable distilled
   adapter that serves and wins on one tenant's task.
5. Keep the honesty discipline: SLM multi-tenant trainer stays dated roadmap
   until §5.3 is live.

## 9 · One-sentence version

Stop selling case management and decision intelligence — sell the **Governed
Decision Flywheel**: the only system where AI is admissible enough to deploy in
a regulated decision today, and every expert correction compounds into a
decision model the customer owns; the capability to add is the **Expertise
Ledger** that makes that flywheel visible, measurable, and ownable.

---

### Sources
- Decision intelligence / case management market & incumbents: [FintechNews / Gartner 2026](https://fintechnews.ch/aifintech/top-decision-intelligence-platforms-of-2026-according-to-gartner/82427/)
- Agentic governance as the adoption blocker + EU AI Act: [SemanticOS](https://semanticos.io/blog/ai-trust-2026-agentic-era/), [Zylos](https://zylos.ai/research/2026-05-01-ai-agent-governance-compliance-2026/)
- SLM / own-your-model moat: [Open Source For You](https://www.opensourceforu.com/2026/04/the-quiet-revolution-how-small-language-models-are-redefining-enterprise-ai-strategy/), [HatchWorks](https://hatchworks.com/blog/gen-ai/small-language-models/)
- Internal asset ground-truth: `docs/DATACERN_POSITIONING_OPTIONS_SLM_AND_AGENTS.md`, `deploy/e2e/test_learn_journey.py`, `deploy/e2e/test_fhir_journey.py`, `agent-runtime/app/domain/{transcripts,sft_curation,outcomes}.py`
