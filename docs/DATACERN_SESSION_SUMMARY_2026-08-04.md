# Session summary — 2026-08-04

A single reviewable ledger of everything that landed in this working session,
in the order it was built. Most of it is already merged into `main` (via
auto-merge PRs #86 and #89); the last item is open as PR #90. Grading uses the
repo's own vocabulary — **PROVEN** (exercised on the real stack, recorded),
**TESTED** (unit/integration green, never live), **BUILT** (code exists,
unproven) — and the built-vs-sold honesty discipline is kept throughout.

## The arc

One thread runs through the whole session: turn a solid-but-undifferentiated
platform into a commercially-sharp one, and prove it. It went
**capability → validation → positioning → the surface that sells it → the two
mechanisms that make the pitch true**, with a production-readiness reckoning in
the middle.

---

## 1 · Health-case solution — FHIR connectivity + race-free triggers

Commits `682f32f`, `325fe0f`, `787c4d9` (→ #86), then `5ca258c` after a
revert, `d0da675`, `7ae70c1`.

Built native (no external dependency), after researching RisingWave and a FHIR
MCP proxy and deciding to **own the code** rather than vendor:

- **Snapshot-delta trigger evaluation** — case-stream triggers stop rescanning
  the whole dataset snapshot per event and evaluate conditions over exactly the
  rows one ingestion appended (py-common `ingestion_delta_file_uris`,
  dataset-service `delta_ingestion_id` browse, case-service flag-gated applier
  with legacy fallback). Dissolves two documented race bugs. **TESTED** (+ a
  real-Iceberg integration test).
- **fhir-bridge** — a new stateless Go service (port 8325) giving agents
  governed FHIR R4 access to Epic/Cerner/OpenEMR/HAPI backends via the
  tool-plane: reads grantable, `create`/`update` **proposal-gated** (the
  clinical system of record changes only after a human-approved grant). Vault
  KV v2 secrets, SMART Backend Services (RS384), OPA re-check, no PHI stored.
  **TESTED** (36 unit tests), fleet 24→25.

**A real defect and an honest revert.** The first merge (#86) broke `e2e-live`:
fhir-bridge died at boot because its `fhir_bridge` database was never created.
The merge was reverted on request, the feature re-introduced on a clean base,
and the actual bug fixed (`7ae70c1` — create the DB; `d0da675` — make an add-on
service warn-not-die at boot). The full loop is recorded honestly in
`docs/initiatives/health-case-realtime-fhir-native.md`.

---

## 2 · Deterministic automation test suite + evidence

Commits `ed12b6c`, `ad7dcff`.

A "test agent" that is deterministic (zero LLM API cost — the agent-exercising
steps use the platform's local Ollama), answering "can we validate the whole
platform?":

- **`make validate-platform`** (`deploy/e2e/validate_platform.py`) — runs every
  existing validator (doctor → 7 journeys → security-probe → agent-roster sweep
  → `pnpm e2e:live` → load profile → soaks) in dependency order and writes ONE
  machine-readable artifact, `deploy/evidence/validation-report.{json,md}` — the
  reproducible evidence the repo never had. Self-tested; an all-skipped run
  reports **INCONCLUSIVE**, never a false PASS. Nightly `validate-platform.yml`
  uploads the artifact.
- **Coverage expansion** — `journey-fhir` wired into CI; the agent-fleet and
  demo live specs un-disabled (real tests, not blanket `fixme`); 3 new
  gap-domain UI journeys (dashboards, decisions, query) authored against real
  routes, pending-live.
- **`docs/DATACERN_TEST_COVERAGE_MATRIX.md`** — layers × workflows × tier,
  every row PROVEN / TESTED / PENDING / NONE.

---

## 3 · Production-readiness checkpoint (the demanding customer)

Commit `88c0fbd`.

`docs/DATACERN_DEMANDING_CUSTOMER_CHECKPOINT.md` grades the platform against a
national-payer profile. Honest verdict: the **governed agentic spine is PROVEN**
and demoable; the **operational envelope is not** — no concurrency numbers, a
per-tenant Kafka partition ceiling, 9 unscalable `replicas:1` services, a
first-`helm install` boot-guard env mismatch, no DR drill, SOC 2 not started.
It also **corrected three drift points in the platform's own honesty ledger**
(the soaks had each run once locally; journey count was 7 not 6; a live spec
carried a stale header). A 7-step, dependency-ordered acceptance gate closes it.

---

## 4 · The commercial wedge — the Governed Decision Flywheel

Commit `035283a`.

`docs/DATACERN_COMMERCIAL_WEDGE.md` answers "what makes it sign-up-able" when
case management + decision intelligence is a mature, crowded category. Grounded
in 2026 market research (agentic governance = the #1 adoption blocker + EU AI
Act enforcement; SLM/own-your-model = the enterprise data moat) and an
evidence-anchored asset inventory. The thesis:

> Not the category — the intersection the incumbents structurally can't occupy.
> The **same four-eyes chokepoint that makes AI admissible** (governance moat,
> PROVEN) is the **proprietary-label factory that compounds into a model the
> customer owns** (learning moat). Sign-up-able because it sits alongside
> existing systems of record, not instead of them.

Named one capability to build (the Expertise Ledger) and two mechanisms to
finish (the outcome loop, one real owned model) — items §5–7 below.

---

## 5 · The Expertise Ledger — the surface that sells it

Commits `ec1fa19` (agent-runtime), `b620700` (bff), `8a0a44a` (ui).

The screen a buyer signs for, at `/ml/expertise`: governed decisions captured,
expert corrections, model agreement vs experts, training-corpus size, and "the
model you own." Full-stack: a real GROUP BY decision-count aggregate (the
headline is an exact total, never a capped list page), a BFF passthrough
preserving nulls, and a UI that **renders honest states** — `agreementRate`
null → "Not enough data yet" (never 0%); no promoted model → "No trained model
yet" with a failed job's error surfaced verbatim; export disabled-with-reason.
**TESTED** across all three layers (agent-runtime 4 tests, bff 446 green, ui
tsc/lint clean, pending-live spec).

---

## 6 · Close the outcome loop — learn from reality

Commit `7a1f9eb`.

The learning loop now closes on **reality**, not just execution.
`POST /api/v1/outcomes/ingest` takes realized outcomes from the system of record
keyed by the **business entity the SoR knows** (a case/claim/dispute URN, not
our internal id), resolves each to the actioned decision that produced it
(`store.find_actioned_proposals_by_urn`), and records a `label_source=sor` label
with agreement computed against what was decided. With no further call these
labels flow into decision effectiveness (the Ledger's agreement number) **and**
into SFT curation weighting (correct → imitate, incorrect → down-weight).
Unmatched keys reported honestly, idempotent, tenant-isolated. **TESTED** (7
tests). Platform mechanism done; a thin producer connector (webhook/feed/event)
is the remaining piece.

---

## 7 · A real distilled model that serves and wins

Commit `f7576b6` — **open as PR #90**.

Closes the four "own your model" gaps the audit named, **on CPU, no GPU**:

- **Real trained model** (`app/domain/distill.py`) — a multinomial NB decision
  student (stdlib + numpy) distilling the governed SFT corpus.
- **Wins gate** (`TrainingJobService.gate`) — promotable only if it beats the
  baseline (majority-class, or the incumbent it would replace) on the tenant's
  held-out decisions; a loss is never promoted.
- **Serves** (`POST /api/v1/distilled/serve`) — the promoted student actually
  decides; the previously-dead promotion column now changes traffic; honest 404
  when nothing is promoted.
- **Tenant-partitioned** artifacts; `AR_SLM_TRAINER_BACKEND=local` in the demo
  boot. **TESTED** (19 tests: model, full loop, HTTP, loser-refused, isolation).

**Honest boundary:** this is a decision classifier — the right tool for the
narrow task and proof of the whole own-your-model mechanism. A **generative**
distilled LLM at production scale stays the GPU-gated leg; `ModalGpuTrainer` +
`slm_modal_app.py` (real QLoRA) are unchanged and need the customer's GPU
account.

---

## Where this leaves the wedge

The wedge's central claim is now backed end to end by code, not roadmap:
**expert decisions are captured → weighted by real-world outcomes → distilled
into a model the tenant owns → promoted only if it beats the baseline → and
served.** That is the Governed Decision Flywheel, working — with the honest
edges (production LoRA on the customer's GPU; a producer connector for the
outcome feed; live execution of the PENDING specs) named, not hidden.

## The honest remaining work (unchanged by this session)

From the production checkpoint, still open and still the real gate to a first
customer: run the load test and soaks for real numbers; `helm install` once
(fix the env mismatch); unpin the 9 `replicas:1` services; a DR drill + RPO/RTO;
and **start SOC 2** — the 6–12 month clock that nothing else unblocks.

---

*Commit trail (main): `682f32f · 325fe0f · 787c4d9` (#86) · `3abf6e7` revert ·
`5ca258c · d0da675 · 7ae70c1` · `88c0fbd` · `ed12b6c · ad7dcff` · `035283a` ·
`ec1fa19 · b620700 · 8a0a44a` · `7a1f9eb` (#89). PR #90: `f7576b6`. If this
document and the codebase disagree, the codebase is right and this is a defect.*
