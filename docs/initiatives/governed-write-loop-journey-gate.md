# A CI gate that asserts an approved AI decision actually changes the row

**Status:** done — 2026-07-26
**Commits:** (this change set) · **Related:** `docs/demo/copilot-capability-findings.md` (the hand-driven session that motivated this), BRD 08 (case lifecycle, BR-9 idempotency), BRD 13 (tool-plane backend facade, TPL-FR-012).

---

## 1. Analysis

### 1a. Platform / product
The product's single load-bearing claim is that an AI proposal, once a human
approves it, is carried out under governance — and that the whole chain is
auditable. Everything else (packs, dashboards, ontology, evidence) is built
around that loop.

On 2026-07-26 the loop was found **completely dead** on a normal local
bring-up: `case.apply_disposition` was never registered at boot, so every
approved disposition was refused by tool-plane and silently dropped. At that
moment 336 agent-runtime + 649 ingestion + 553 ui-web unit tests and 63 CI
checks were **all green**.

They were green because they check *components*. Nothing checked the *journey*,
and nothing anywhere asserted that a case row was different afterwards. The
proposal said `approved`, the workflow completed, the audit trail read clean,
and the case never moved. The defect was found by driving the UI by hand.

That is the gap this initiative closes: a test that asserts on **state**, wired
into CI, so the flagship loop cannot be silently broken again.

### 1b. Technical
Three properties made the failure invisible, and any fix has to survive all
three:

1. **Acknowledgements are not evidence.** `status: approved`, HTTP 200, a green
   workflow and a clean audit trail are all things the platform *says*. Every
   one of them was present while nothing happened.
2. **The reason is never where you look.** It lived in tool-plane's
   `invocation_log.deny_reason`, a table nobody opens. (Since the
   execution-outcome fix it is also recorded on the proposal as
   `decision.execution`.)
3. **Component tests cannot see it.** Each service was individually correct.
   The break was in the composition.

So the rule for the new test: **never accept an acknowledgement as evidence.**
The only thing that counts is the row.

---

## 2. Design

`deploy/e2e/test_governed_write_loop.py` — one journey, unmocked end to end
against a booted stack (`make up`), exposed as `make journey`:

| Step | Actor | Assertion |
|---|---|---|
| preconditions | proposer | case is `in_progress` **and** assigned to the approver |
| 1 | case-triage agent (real Ollama) | the run produced a **PENDING** proposal |
| 2 | a **different** human | the decision is recorded `approved` |
| 3 | — | **the case row's `disposition_id` actually changed** |

Deliberate choices:

- **Two distinct personas.** `admin@` proposes, `manager@` approves. Four-eyes
  is a product claim, so the test must not be able to pass with one identity.
- **Preconditions are asserted, not assumed.** Each unmet precondition produces
  a failure that *looks exactly like* the bug being hunted (unassigned approver
  → `permission denied: obo_grant`; not-in_progress → `INVALID_TRANSITION`). The
  fixture check keeps every later assertion about the loop, not about setup.
- **Failure prints where the real reason lives** — the `invocation_log` and
  `proposals.decision` queries — so the next person does not rediscover it the
  hard way.
- **CI placement: before the Playwright live suite.** It takes ~2 min and gets a
  clean fixture; if the governed write loop is broken there is no point spending
  20 minutes on UI assertions.

---

## 3. Implementation & test

### 3a. The gate
- `deploy/e2e/test_governed_write_loop.py` (new)
- `make journey` (Makefile target)
- `.github/workflows/ci.yml` — new step in the `e2e-live` job, after
  `make doctor`, before `pnpm e2e:live`.

### 3b. The bug it immediately caught

Run 1 passed. **Run 2, on the same case, failed** — and the cause was a real
governance defect, not a test artifact.

`services/case-service/internal/api/handlers_facade.go` fabricated a BR-9
idempotency key whenever the caller supplied no `proposal_urn`:

```go
proposalURN, _ := req.Args["proposal_urn"].(string)
if proposalURN == "" {
    proposalURN = "wr:" + req.Tenant + ":ai:proposal/" + req.ToolID + "/" + caseID.String()
}
```

That key is a pure function of `(tenant, tool, case)` — **identical for every
proposal ever raised against that case**. And agent-runtime never sends
`proposal_urn`: it cannot, because tool-plane enforces
`additionalProperties:false` against each tool's registered input schema, so
injecting the key platform-wide would break every other write tool.

Consequence, reproduced live:

> The **first** approved disposition on a case applies. **Every later one on the
> same case is silently swallowed** — the replay branch returns HTTP 200
> `{applied:true, replayed:true}` without writing. tool-plane logs `allowed`,
> the proposal reads `approved`, the timeline shows nothing, the case does not
> move.

A human approves a decision and the platform does nothing, dressed as success.
That is the exact failure mode the product exists to prevent. It bites any case
worked more than once — reopened after new evidence, re-triaged, corrected.

**Fix:** don't fabricate a key. BR-9 is idempotency *by proposal_urn*; with no
key there is no replay to detect, so the call proceeds normally and a genuine
duplicate is caught loudly by the state machine (`INVALID_TRANSITION`) instead
of being swallowed quietly. This also aligns the facade with the human apply
path (`handlers_proposal.go`), which has always used a real proposal URN.

### 3c. Verification

- `TestBR9_FacadeIdempotencyDoesNotSwallowDistinctDecisions` — two decisions on
  one case with a reopen between; both must take effect.
- `TestBR9_FacadeReplaysOnRepeatedProposalURN` — the other half: a caller that
  *does* supply a key still gets real replay protection, so a retried delivery
  cannot double-apply.
- **Both were confirmed to fail against the pre-fix code**, reproducing the live
  symptom precisely (`replayed:true`, `disposition_id` nil, status stuck at
  `in_progress`). A regression test never seen red is not a regression test.
- `go test ./...` in case-service: green (unit + Docker-backed integration).
- Live: `make journey` run **three times consecutively against the same case** —
  the exact scenario that failed before — all PASS.
