# Copilot capability findings — live UI testing, 2026-07-26

Driven as a human through the browser against the real local stack (tenant
`Acme Claims Co`, 32 real cases, Ollama `llama3.2`), not through the test
harness. Every quote below is a verbatim response from the running product.

## The one thing that matters

**The copilot's behaviour splits cleanly on whether it was given data.** It is
not "the copilot works" or "the copilot is broken" — it is two different
products depending on the surface you open it from.

| surface | has data? | behaviour |
|---|---|---|
| Case detail (`/cases/{id}`) | yes — case + evidence | Accurate. Cites real values, says what it doesn't know. |
| Home / global drawer | **no** | Was fabricating. Now refuses. |

### Grounded path — correct

Asked "What is this case about, and what was decided?" on case #32:

> "the claim type is `auto`, invoice no is `INV-5024`, and the vendor is
> `ACME Auto Body`. However, I do not have information about what was decided
> in this case."

Every value matches the screen. It declined to invent the decision. This is the
behaviour the product promises.

### Ungrounded path — was the worst possible failure (FIXED)

Asked "Which of my open claims looks riskiest, and why?" from the home page,
where five real claims were visible on screen:

> "the claim with the highest risk is **Claim #1234** ... **Low confidence
> score**: the confidence score for this claim is low (0.4) ... this analysis is
> based on the governed semantic layer and should be reviewed by a human expert"

Claim #1234 does not exist. Neither does the confidence score, the "keyword
extraction model", nor the "similar claims with high risk scores". The run was
recorded `completed`. It credited the governance layer for numbers it invented.

Transcript evidence: `grounding.evidence: []`, `input_tokens: 106` — no case
data ever reached the model. `output_tokens: 300` hit the cap, truncating the
answer mid-sentence.

Three causes, all fixed in `claude/fix-analytics-fabrication`:

1. The analytics agent has no data access (its docstring: "Full semantic-layer
   tool wiring is Phase-2 follow-up"); `ground()` fetches only when a case_id
   exists.
2. The system prompt *ordered* the fabrication: "cite that the answer is
   grounded in the governed semantic layer", unconditionally.
3. The anti-guessing guard lived inside the `if case:` branch — present where
   data exists, absent where it doesn't.

After the fix, same question, same screen: *"I don't have enough information to
determine which of your open claims looks riskiest."* (input 106→314,
output 300→42.)

## Open capability gaps

- **Analytics has no data path on global surfaces.** The fix converts a lie
  into an honest limit; it does not make the agent able to answer. Any "ask
  your data a question from anywhere" capability is **not real today**.
- **8 of 11 agent prompts have no anti-fabrication guard.** Only `analytics`
  (now), `triage` and `persona_copilot` do. This matters most where the model
  writes the *rationale a human approves* — four-eyes approval on an invented
  justification is a subtler version of the same failure.
- **A test was pinning the bug.** `test_analytics_without_a_case_id_behaves_
  exactly_as_before` asserted the raw query passed through "unchanged" — it
  encoded the defect as the contract. A green suite was protecting it. Tests
  that assert on a canned `FakeLlm`'s *output* cannot catch fabrication; the
  new ones assert on what is *sent to* the model.

## Good patterns worth keeping

- **`governance` is the right shape.** `should_retrain` is decided in code
  (`drift >= threshold or corrections >= 20`); the LLM only writes the rationale
  prose, with a deterministic fallback. The model cannot cause a proposal.
  Every write-capable agent should look like this.
- `triage` / `persona_copilot` prompts already say "Cite ONLY evidence actually
  provided above — never fabricate a source or a detail."

## UX leaks (cosmetic, but visible to every user)

- The Copilot header shows a raw workspace UUID as "Context"
  (`019f9ff7-31e7-72fd-aef0-03ad70e83898`).
- Answers expose internal field names — "According to the `display_projection`
  field", "the provided JSON case data". A claims adjuster should never see
  these.
- The analytics agent runs on model `fast-small`.

## The approval loop — the strongest surface in the product

The approval inbox is the best-built screen tested. It shows a real diff of the
proposed args, the tool + tier + reversibility, blast radius, an auditor
evidence pack, and — notably — labels the agent's own summary
**"Agent's description (unverified)"**. That is exactly the honest-provenance
discipline the analytics agent was missing, done right.

The stored proposal is equally good: `decision.actor` bound to the approver,
an `args_digest` (sha256) so an approval is tied to the exact arguments it was
granted for, and `rationale_source: "llm"` labelled honestly.

### Four-eyes works — verified live, by accident

Two proposals, approved by the same person (admin), opposite outcomes:

| proposal | proposed by | result |
|---|---|---|
| `ef946523` | a different principal | **approved** — `decision.actor` recorded as the admin |
| `721549bd` | **the admin themselves** (via the case's own Draft recommendation button) | **refused** — stays `pending` |

`tenant_agent_configs` is empty, so `self_approval` is false and the gate
refuses. You cannot approve your own proposal. This is the platform's central
claim and it holds under a real UI test.

### CORRECTION: the refusal is NOT silent — I was wrong

An earlier revision of this document claimed the self-approval refusal was
completely silent and called it a defect. **That was my error.** The UI shows a
toast with the title "Decision failed", the exact reason
("self-approval not permitted for this tenant") and a trace id — verified by
watching the DOM immediately after the click. The API returns a clean
`403 PERMISSION_DENIED` with the same message.

I originally screenshotted ~20 seconds after clicking, by which point the toast
had auto-dismissed, and a console check would never have shown it either. The
error handling here is good; nothing needs fixing.

Worth keeping as a testing lesson: a screenshot taken after the fact cannot
prove the *absence* of transient UI. Assert on the DOM at the moment of the
action, or you will report working behaviour as broken.

### Approved does not always mean executed

Approving `ef946523` flipped it to `approved` and recorded the approver, but the
case was never updated (`disposition_id` empty, `updated_at` unchanged).

Mechanism: `app/api/routes/proposals.py` calls `decide(..., execute=not
temporal_backed)`. For a Temporal-backed run, approval does not execute inline —
it signals the workflow. That run's status was already `completed`, so the
signal went nowhere and the approval became a no-op.

**Resolved: it is a standing defect, not my restart.** Re-tested cleanly —
manager approved a proposal raised by admin, workflow alive (`awaiting_
approval`), no restart in between. Case still unchanged. Two stacked causes,
both found in tool-plane's `invocation_log`:

**Cause 1 (FIXED).** `deny_reason: "tool not found"`. `up.sh` seeded four write
tools and the registry held exactly those four; `case.apply_disposition` — the
one the flagship loop runs on — was never among them. Its recipe lived only in
`deploy/e2e/driver.py:register_apply_tool()`, which boot does not call, so it
worked under the e2e driver and the wellstar demo builder and was broken on
every ordinary bring-up. Fixed by adding `register_case_apply_tool()` to
`seed.py` and calling it from `up.sh`; the tool now registers, publishes, and
resolves at version 1.2.0.

**Cause 2 (NOT A BUG — an unmet precondition).** With the tool registered the
denial moved to `permission denied: obo_grant`. That is the policy working.
`proposals/service.py` deliberately executes as the **decider**, not the
original trigger user, and says why: obo_sub=obo_user was tried and case-service
rejected every apply with 403 because the trigger user only holds
`case.case.update`. So the approver must hold a per-resource grant on the case —
and grants are minted by **assignment**, which none of the seeded cases had.
I nearly "fixed" this by weakening the policy; it needed data, not code.

**Cause 3 (also correct).** With a grant in place the denial moved again, to
`backend_rejected: INVALID_TRANSITION: resolve requires an in_progress case,
got draft` — case-service's own state machine. Start the case first.

### The loop DOES close — verified end to end

Sequence that works, all live, no mocks:

1. assign the case to the approver (mints an `editor` grant on the case URN)
2. start the case (`draft -> in_progress`)
3. admin's `case-triage` agent proposes a disposition
4. **manager** approves (different person — four-eyes satisfied)
5. tool-plane: `allowed`
6. case-service applies it — `status=2`, `disposition_id` set, the agent's
   resolution note written to the case

So the governed write path is real. What was missing was one tool registration
(fixed) plus two preconditions nobody surfaces: the approver needs a grant on
the resource, and the case must be in progress.

### The demo implication

A demo tenant whose cases are **unassigned** or in **draft** cannot complete
this loop, and every failure is silent. Any demo script must assign + start
before showing an approval, or the money moment ends with "approved" and an
unchanged case.

### The shape of this failure is the real lesson

At no point did any surface say anything was wrong. The agent proposed, the
inbox rendered a clean diff, four-eyes recorded a named approver, the workflow
completed, the proposal read `approved` — and nothing happened. The only
evidence was a `deny_reason` in a table nobody looks at. **An approved-but-not-
executed proposal should be a loud, visible state**, not a silent one; today
the audit trail says a decision was applied when it was not.

## Not yet tested

Dashboards, ML, decision tables, and data onboarding were not driven end to end
in this pass.
