# Platform development progress — checkpoint 2026-08-05

**Method:** every number below was measured against the repository or read from
a named CI run at the time of writing. Nothing is quoted from an older
document. Uses the ledger's three states, which are not interchangeable:
**PROVEN** (exercised on the real stack in a recorded run) · **TESTED**
(unit/integration green, never live) · **BUILT** (code exists, unproven).

Companion docs: `DATACERN_STATUS_CHECKPOINT.md` (the standing evidence
ledger), `DATACERN_SESSION_SUMMARY_2026-08-04.md` (what shipped and why),
`DATACERN_DEMANDING_CUSTOMER_CHECKPOINT.md` (the production gate),
`DATACERN_COMMERCIAL_WEDGE.md` (the positioning it all serves).

---

## 1 · Headline

The platform gained a **commercial thesis with code behind it** and a
**reproducible way to prove itself** — and it is still **not production-ready**,
for the same reasons as before. Both halves matter.

| | |
|---|---|
| Deployable services | **25** (fhir-bridge added) |
| Backend journeys | **7** (`journey-fhir` added; 6 previously PROVEN) |
| Live UI spec files | **15** (3 new gap-domain specs; 2 previously-disabled specs re-enabled) |
| Validation orchestrator | **`make validate-platform`** — new, emits a machine-readable evidence artifact |
| agent-runtime unit tests | **401** (was 353 at session start) |
| Production cloud deployments | **0** — unchanged |
| Customers / pilots / revenue | **0** — unchanged |

---

## 2 · What changed — capability

| Capability | State | Evidence |
|---|---|---|
| **Snapshot-delta case triggers** — evaluate only the rows one ingestion appended | TESTED | dataset-service delta browse + case-service flag-gated applier; dissolves 2 recorded race bugs |
| **fhir-bridge** — governed FHIR R4 access for agents (reads grantable, writes proposal-gated) | TESTED | 36 unit tests; Vault secrets, SMART RS384, OPA re-check, no PHI stored |
| **Expertise Ledger** (`/ml/expertise`) — the flywheel made visible | TESTED | full-stack: exact GROUP BY decision counts → BFF passthrough → UI with honest null-states |
| **Closed outcome loop** — realized outcomes from the system of record | TESTED | business-URN → actioned-decision join; feeds effectiveness AND SFT weighting; 7 tests |
| **Distilled model that serves and wins** | TESTED | train → eval-gate(beats baseline) → promote → serve, tenant-partitioned; 19 tests |
| **Validation orchestrator + evidence artifact** | BUILT | self-tested; an all-skipped run reports INCONCLUSIVE, never a false PASS |

**The through-line:** expert decisions captured → weighted by real-world
outcomes → distilled into a model the tenant owns → promoted only if it beats
the baseline → and served. That is the Governed Decision Flywheel, and it is
now backed end to end by code rather than roadmap.

---

## 3 · What changed — evidence discipline

This is the less visible half, and arguably the more valuable.

- **The repo had zero machine-generated result artifacts.** Every execution
  claim was prose in a dated markdown file. `make validate-platform` now
  produces `deploy/evidence/validation-report.{json,md}`, uploaded nightly.
- **Three drift points in the honesty ledger were corrected** — the soaks had
  each run once locally (the ledger said "never" without scoping to CI); the
  journey count was 7, not 6; a live spec carried a stale "never executed"
  header despite having run.
- **~28% of the live UI suite was permanently disabled.** The agent-fleet and
  demo specs are now real tests; only narrow, precisely-reasoned `fixme`s
  remain (kill-executes needs unbuilt SSE; spend-under-outage needs downing a
  service).
- **A coverage matrix** (`DATACERN_TEST_COVERAGE_MATRIX.md`) marks every layer
  and workflow PROVEN / TESTED / PENDING / NONE, so gaps cannot hide.

---

## 4 · CI and security state — as of this writing

**Honest and incomplete: I cannot yet report a green verdict.** All four
recent runs (`8ad0bb6`, `38c6554`, `980b75e`, `0113c7f`) are **queued or
in-progress**. The last *completed* runs were failures, from before the fixes
below landed.

Two CI failures were diagnosed and fixed this session:

1. **`test-python (agent-runtime)`** — a `ruff` lint failure (not a test
   failure): `datetime.UTC` alias, two unquoted forward refs, one unused
   import. Fixed; ruff clean locally. → merged (#91).
2. **`security-scan / trivy`** — **34 code-scanning alerts, failing on every
   `main` run and predating all recent feature work.** All 34 were two
   packages repeated per lockfile. `aiohttp` → 3.14.3 and `cryptography` →
   50.0.0 across 12 `uv.lock` files; mlflow 3.14.0 → 3.15.1 where needed.
   → merged (#92).

**Residual, stated plainly: 2 alerts will remain and the trivy gate will
still fail.** `mlflow` caps `cryptography<50` at *every* published version, so
`inference-service` and `pipeline-orchestrator` cannot reach 50.0.0 (they are
now on 49.0.0). I did **not** add a `.trivyignore` to force the gate green —
this sandbox cannot reach trivy's vulnerability DB to confirm the real CVE ID,
and inventing one to silence a security gate is precisely the kind of unearned
claim the repo's conventions exist to prevent. A documented exception needs
only the CVE ID from the alert page.

**A process note worth recording:** an automation auto-creates and merges PRs
from the development branch within ~1 minute of a push. Every PR opened this
session (#86, #89, #90, #91, #92) merged before review. One consequence was
real: PR #86 merged a genuine defect (fhir-bridge's database was never
created, breaking `e2e-live`), which was reverted on request and re-landed
fixed. Work is reaching `main` without a review gate.

---

## 5 · What has NOT changed — the production gate

Everything in `DATACERN_DEMANDING_CUSTOMER_CHECKPOINT.md` still stands. In
leverage order:

1. **No concurrency numbers exist.** `load_test.py` has still never touched a
   running stack — no p95, no throughput, for any surface.
2. **Both soaks have still never run in CI.** They are now wired into the
   orchestrator, which is their first path to executing.
3. **Nothing has ever been deployed.** Helm never installed, Terraform never
   applied; the chart still carries a documented env-name mismatch that would
   fail its own boot guard on a first install.
4. **No DR drill, no restore test, no RPO/RTO, no incident-response plan.**
5. **SOC 2 not started** — the 6–12 month clock that nothing else unblocks.
6. **~9 of 33 deployables cannot scale horizontally** (in-process schedulers,
   `replicas: 1`); the HPA template remains dead code.

The new capability work does not move any of these. It was never meant to —
they are operational and organizational, not architectural.

---

## 6 · Honest grading of the commercial thesis

| Claim | Backed by |
|---|---|
| "AI admissible enough to deploy in a regulated decision" | **PROVEN** — propose→approve→signed-grant→WORM audit, forged-grant rejection asserted on real backend state |
| "Every expert correction compounds into a model you own" | **TESTED** — corpus → distilled student → eval-gate → serve, all with tests; never run on the live stack |
| "Decision intelligence that learns from reality" | **TESTED** — SoR outcome ingestion feeds effectiveness + corpus weighting |
| "Own your model" (generative LLM at production scale) | **GPU-gated roadmap** — `ModalGpuTrainer` unchanged, needs the customer's GPU account |

The CPU distilled student is a **decision classifier**, not a generative LLM.
It is the right tool for the narrow decision task and proves the whole
own-your-model mechanism; the generative variant is a compute upgrade of the
same, now-proven pipeline. Any external use of "own your model" must carry
that distinction.

---

## 7 · Next, in leverage order

1. **Run `make validate-platform` against a live stack, once.** It converts a
   large block of TESTED to PROVEN in one execution — and, on this repo's
   track record, will find real defects. Everything built this session is
   PENDING until it does.
2. **Get the trivy gate to a truthful green** — either mlflow relaxes its pin,
   or a documented `.trivyignore` exception with the CVE ID.
3. **Load test + both soaks in CI** — the largest block of entirely unmeasured
   behaviour left.
4. **`helm install` once**, fixing the env-name mismatch — turns "IaC written,
   never applied" into a deployed environment.
5. **Start SOC 2.**

---

*Written 2026-08-05 against `main` @ `8ad0bb6`. CI runs for `8ad0bb6`,
`38c6554`, `980b75e`, `0113c7f` were queued/in-progress at the time of
writing and are NOT reported here as passing. If this document and the
codebase ever disagree, the codebase is right and this is a defect.*
