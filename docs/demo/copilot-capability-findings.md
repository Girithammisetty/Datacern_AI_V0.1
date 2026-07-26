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

## Not yet tested

Dashboards, ML, decision tables, data onboarding, and the four-eyes approval
inbox were not driven end to end in this pass.
