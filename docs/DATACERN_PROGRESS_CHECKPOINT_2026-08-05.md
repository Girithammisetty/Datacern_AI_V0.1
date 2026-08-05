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

**Update — measured on `77bd090` / `9f31dca` / `6bddee7`.** `ci.yml`
completed with **no failing jobs**, including `e2e-contract` (which the Case
Workbench change had broken, since a row click now opens the case in the
right-hand pane via `?c=<id>` instead of navigating). `security-scan` is
**4 of 5 green** — `gitleaks`, `bandit`, `semgrep`, and `gosec` all pass;
`trivy` was the only red job, and section 4a below records how it was closed.

Two CI failures were diagnosed and fixed this session:

1. **`test-python (agent-runtime)`** — a `ruff` lint failure (not a test
   failure): `datetime.UTC` alias, two unquoted forward refs, one unused
   import. Fixed; ruff clean locally. → merged (#91).
2. **`security-scan / trivy`** — **34 code-scanning alerts, failing on every
   `main` run and predating all recent feature work.** All 34 were two
   packages repeated per lockfile. `aiohttp` → 3.14.3 and `cryptography` →
   50.0.0 across 12 `uv.lock` files; mlflow 3.14.0 → 3.15.1 where needed.
   → merged (#92).

### 4a · The trivy residual, resolved

The previous draft of this section said the gate would keep failing and that a
`.trivyignore` could not be justified without the real CVE ID. That precondition
has since been met, so the exception was written. The chain, in order:

1. **The job's log named nothing.** trivy ran with `--format sarif --output`
   only, so a failure produced `Process completed with exit code 1` and no
   findings — the package had to be reverse-engineered from the Security tab.
   Fixed first: a non-gating `--format table` pass now prints the findings where
   the failure is read.
2. **The next run named them.** Exactly **3 findings, one CVE**:
   `CVE-2026-69247`, `cryptography` 49.0.0 → fixed in 50.0.0, in
   `deploy/e2e/uv.lock`, `services/inference-service/uv.lock`, and
   `services/pipeline-orchestrator/uv.lock`. Every other lockfile: 0.
3. **The fix is provably unreachable.** Not asserted — demonstrated. Adding
   `cryptography>=50` and re-resolving makes the uv solver state it outright:
   `mlflow>=3.11.0 depends on cryptography>=43.0.0,<50`, therefore
   unsatisfiable. No published mlflow lifts the cap, and mlflow is genuinely
   used by all three, so dropping it is not available either.
4. **The vulnerable path is not reachable here.** The CVE is a Bleichenbacher
   oracle in PKCS#7 `EnvelopedData` decryption (`pkcs7_decrypt_der/pem/smime`).
   A repository-wide search for pkcs7 / EnvelopedData / S/MIME across
   `services`, `libs`, `deploy` and `packs` returns **zero** first-party
   matches; `cryptography` is reached only as pyjwt's RS*/ES* backend and for
   keypair generation in test fixtures. Exploitation needs an S/MIME gateway
   auto-decrypting untrusted payloads adaptively at high volume. The advisory
   scores it **CVSS 3.1 (low)**; trivy reports HIGH from a different vendor's
   rating, and its own log warns it is "using severities from other vendors".

`.trivyignore.yaml` therefore carries one entry — scoped to those three
lockfiles, with the reachability and unfixability arguments written out, and
**`expired_at: 2026-11-05`** so it re-opens the gate on its own rather than
being silently inherited. The informational pass runs `--show-suppressed`, so
the accepted risk stays visible in every run instead of disappearing.

This is a documented exception, not a fix: **the dependency is still on 49.0.0.**
It comes off the moment an mlflow release lifts the cap.

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
2. ~~**Get the trivy gate to a truthful green**~~ — done; see §4a. The follow-up
   is to *retire* the exception when mlflow lifts its `cryptography<50` cap,
   which `expired_at: 2026-11-05` forces.
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
