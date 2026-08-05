# Datacern GTM — final positioning and the marketing surface that carries it

*2026-08-05. Supersedes the single-wedge sequencing in
`DATACERN_COMMERCIAL_WEDGE.md` on positioning; the wedge doc's evidence and
market analysis remain valid inputs.*

## 1 · The decision: multi-vertical engine, pack-led entry

Datacern is sold as **one governed decision engine with installable solution
packs** — 27 sellable packs plus the investigation framework as of this
writing (the number on the site is generated, see §4). We do not pick one
vertical as the identity; we let every prospect enter through *their* queue.

What stays true from the earlier wedge analysis:

- **The category is adjudication, not BI.** The site's own words: "AI does the
  work. A named human signs it." Dashboards are a capability inside the
  product; they are never the pitch.
- **Sequencing still exists — in sales focus, not identity.** Fastest cycles
  (disputes/chargebacks, AP audit, seller vetting) get outbound attention
  first; regulated enterprise (payer claims, AML, pharmacovigilance) ramps as
  SOC 2 and references land. The *website* serves all of them at once because
  packs make each landing equally concrete.
- **Outcome-aligned pricing.** Metered governed decisions with a **hard budget
  cap** — the anti-runaway guarantee is itself a differentiator no agentic
  competitor leads with. Illustrative rates stay clearly illustrative.

## 2 · Messaging architecture

- **One-liner:** *Point Datacern at the data behind your regulated queue.
  Agents draft every decision with cited evidence; a named human approves;
  every correction trains a model you own.*
- **Pillars:** (1) a queue that clears itself more each month, (2) a record an
  examiner can follow, (3) a model that is yours, (4) a pack for your queue —
  install, don't build.
- **Proof discipline:** no invented numbers anywhere on the site. Structural
  counts (pack count) are generated from shipped manifests; benchmark numbers
  appear only when a design partner produces them; the security page says
  "SOC 2 in progress", not "compliant".

## 3 · The page system

| Page | Job | Content source |
|---|---|---|
| `/welcome` | The category + the engine story; industries as the way in | **config** (`welcome.ts`) |
| `/solutions` | The full pack catalog, grouped by industry, with the one-engine hub diagram | **config + codegen** |
| `/security` | The governance spine, drawn as the request path; the honesty section | **config** |
| `/pricing` | Budget-cap-first, contact-first — NO prices shown; the levers and the cap explained, quote on request | **config** (`pricing.ts`) |
| `/live-demo` | Self-serve seeded sandbox, no sales gate | **config** (`live-demo.ts`) |
| `/welcome/walkthrough` | One decision end-to-end in five steps | **config** (`walkthrough.ts`) |

Every pre-login page is now a pure renderer of `src/content/marketing/*.ts`;
shared chrome (nav, footer, product name) is single-sourced in `shell.ts`.
Dedup rule: breadth-by-industry lives ONLY on `/solutions` (generated);
`/welcome` keeps the four flagship spotlights and hands off via the
generated-count CTA. Security mechanisms live ONLY on `/security`; `/welcome`'s
trust band is a teaser that links there. Pricing shows no dollar figures at
all — not even labeled-illustrative ones; the page explains the meter and the
hard cap, then asks for a contact. (The billing math stays unit-tested in
`src/lib/pricing/calc.ts`.)

Diagrams (all real-text components, light/dark aware, no image assets):

- **DecisionLoopDiagram** (existing, `/welcome`): the loop, human gate elevated.
- **GovernanceSpineDiagram** (new, `/security`): propose → approve (four-eyes)
  → signed grant → governed execution → immutable record.
- **PackHubDiagram** (new, `/solutions`): the engine hub with industry spokes
  and per-industry pack counts, computed from the generated catalog.

## 4 · Content-as-config (the part that keeps marketing honest)

- **Copy lives in `src/content/marketing/*.ts`** — typed config modules.
  Pages are pure renderers; changing a sentence never touches a component.
- **The catalog is generated, not written.**
  `tools/marketing/gen_pack_catalog.py` reads `packs/*/pack.yaml` and emits
  `packs.gen.ts`: title (curated label), blurb (**the manifest description's
  own headline** — the text before its first colon), version, categories,
  regulatory tags, industry grouping. The marketing site can only claim what a
  shipped manifest claims.
- **Drift fails CI.** The `wiring-audit` job runs the generator's `--check`;
  a pack added, renamed, or re-described without regenerating turns the build
  red. Same single-source-of-truth rule as ci.yml's services.yaml-derived
  matrices.
- **Counts are computed.** "{N} installable solution packs" on `/welcome` and
  the `/solutions` headline both render `SOLUTION_PACK_COUNT` from the
  generated module. The marketing number cannot rot.

## 5 · What marketing still may NOT say (launch gates)

Unchanged, and enforced by the honesty strip on `/security`:

1. No performance/scale numbers until the load tests produce them.
2. No uptime or deployment claims until a production environment exists.
3. No compliance certifications until the report exists — "in progress" only.
4. No win-rate / cost-saving benchmarks until a design partner's data
   produces them, attributed as such.

## 6 · Refinements adopted 2026-08-05 (evening)

A single-vertical "Datacern Disputes" wedge was drafted and explicitly
rejected by the founder ("lets not restrict as it can solve many similar
problems") — multi-vertical stands. From that draft, these refinements WERE
adopted:

1. **Category: "AI adjudication."** Not BI, not case management, not
   "decision intelligence." We sell a cleared queue. The word "platform"
   never appears in rendered marketing copy (generated pack text that uses
   "platforms" to mean marketplace businesses is exempt).
2. **Engine named in the footer.** Every marketing page footer reads
   "Powered by the Datacern adjudication engine."
3. **Entry offer, code-backed:** "Connect your queue's data — we'll score
   your last 90 days free." Fulfilled by the shipped ingestion + scoring
   path; disputes named as the *fastest start* (processor data), never the
   identity.
4. **Pricing: performance-first where the queue recovers revenue** (share of
   recovered revenue, flat per-cleared-case option, enterprise floor),
   governed-decision metering elsewhere, hard budget cap on everything.
   No percentages or rates printed — agreed per portfolio; the free scan is
   the shared baseline.
5. **Launch gates unchanged** (§5): no number on the site the evidence
   ledger can't back.

*If this document and the code disagree, the code is right.*
