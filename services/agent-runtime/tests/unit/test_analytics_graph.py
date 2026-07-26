"""analytics agent graph (ART-FR-013) — read-only. It answers a governed
data question and must NEVER emit a WriteIntent. Fills the graph-test gap for
the analytics agent (previously only touched incidentally via the catalog).

Mirrors the other per-agent graph tests: a FakeLlm makes the run deterministic,
so these assert control-flow + the read-only contract, not model quality. The
real-model path for this agent is covered by tests/integration/
test_agent_roster_real_llm.py.
"""

from __future__ import annotations

from app.adapters.fakes import FakeCaseReader, FakeEvidenceReader, FakeLlm
from app.domain.ports import LlmResult
from app.graphs.analytics import run_analytics
from app.graphs.base import GraphDeps
from tests.conftest import TENANT_A

_ANSWER = "Grounded in the governed semantic layer: 42 claims, $1.2M paid, top type = auto."


async def test_analytics_answers_and_never_writes():
    deps = GraphDeps(llm=FakeLlm(content=_ANSWER))
    outcome = await run_analytics(deps, {"tenant_id": TENANT_A,
                                         "query": "How many claims and total paid?"})

    # Read-only contract: an answer, and categorically NO write intent.
    assert outcome.final_text == _ANSWER
    assert outcome.write_intent is None
    # A model was actually invoked (usage populated).
    assert outcome.usage["output_tokens"] > 0
    assert outcome.usage["model"]


async def test_analytics_is_read_only_even_when_a_data_tool_was_used():
    """Even on the reflection path (a data tool was used), the agent stays
    read-only — it produces a grounded answer, never a WriteIntent."""
    deps = GraphDeps(llm=FakeLlm(content=_ANSWER))
    outcome = await run_analytics(deps, {"tenant_id": TENANT_A,
                                         "query": "Trend paid amount by month",
                                         "used_data_tool": True, "max_reflections": 1})
    assert outcome.final_text == _ANSWER
    assert outcome.write_intent is None
    assert outcome.usage["output_tokens"] > 0


async def test_analytics_role_grounds_the_prompt():
    """When the caller's role is known, the system prompt is role-grounded
    (ART-FR-040) — the directive is appended to the analytics system message."""
    llm = FakeLlm(content=_ANSWER)
    deps = GraphDeps(llm=llm)
    await run_analytics(deps, {"tenant_id": TENANT_A, "query": "Summarise claims",
                               "caller": {"roles": ["data-scientist"]}})
    # The single chat call carried a system message; role grounding must not have
    # crashed and a model call was made.
    assert llm.calls
    sys_msg = next(m for m in llm.calls[0]["messages"] if m["role"] == "system")
    assert "semantic layer" in sys_msg["content"].lower()


class _RecordingLlm:
    """Captures the exact user prompt so we can assert case + evidence text
    actually reached the model (not just the raw free-text question)."""

    def __init__(self, content: str) -> None:
        self._content = content
        self.user_prompts: list[str] = []

    async def chat(self, *, messages, tenant_id, response_format=None,
                   temperature=None, max_tokens=None) -> LlmResult:
        self.user_prompts.append(next(m["content"] for m in messages if m["role"] == "user"))
        return LlmResult(content=self._content, input_tokens=50, output_tokens=20, model="fake")


async def test_analytics_grounds_on_the_case_when_a_case_id_is_supplied():
    """The case-detail Copilot drawer sends a case_id (resolved from the page's
    context URN) — the graph must fetch that case + its evidence and put both
    in front of the model, not answer generically with no context (the bug: a
    from-scratch demo tenant's Copilot said "I'm unable to access real-time
    data" because this grounding didn't exist yet)."""
    case = {"id": "case-1", "denial_id": "DN-3901", "payer_name": "Georgia Medicaid CMO",
            "appeal_status": "not_appealed", "appeal_deadline_days": 9}
    llm = _RecordingLlm("The DN-3901 denial is a precert issue for Georgia Medicaid CMO.")
    deps = GraphDeps(
        llm=llm, case_reader=FakeCaseReader(case),
        evidence_reader=FakeEvidenceReader(
            [{"filename": "denial-letter.pdf", "content_type": "application/pdf",
              "text": "Precertification absent for cardiac catheterization.", "extracted": True}]))

    outcome = await run_analytics(deps, {
        "tenant_id": TENANT_A, "case_id": "case-1",
        "query": "summarize this denial and the appeal history for this payer"})

    assert outcome.final_text == llm._content
    assert outcome.write_intent is None
    assert llm.user_prompts, "the model must have been called"
    prompt = llm.user_prompts[0]
    # The case's real fields reached the prompt...
    assert "DN-3901" in prompt
    assert "Georgia Medicaid CMO" in prompt
    # ...and so did the evidence document text, not just the row projection.
    assert "Precertification absent for cardiac catheterization" in prompt
    # ...alongside the user's actual question (not silently dropped).
    assert "summarize this denial" in prompt
    # Grounding is auditable in the run trace, not silent.
    assert any(e.get("event") == "case_grounded" for e in outcome.trace)


async def test_analytics_without_a_case_id_refuses_instead_of_improvising():
    """No case_id -> no data of any kind, so the question is wrapped in a refusal
    instruction rather than passed through bare.

    This test previously asserted the opposite — that the prompt was "exactly the
    user's raw query, unchanged" — and so pinned the defect in place. Handing a
    live model a data question with no data is what produced the fabricated
    "Claim #1234" answer; passing the query through unchanged was the bug, not
    the contract. Do not restore the old assertion.
    """
    llm = _RecordingLlm(_ANSWER)
    deps = GraphDeps(llm=llm)
    await run_analytics(deps, {"tenant_id": TENANT_A, "query": "How many claims total?"})

    prompt = llm.user_prompts[0]
    assert "How many claims total?" in prompt  # the question is not dropped
    assert "NO DATA" in prompt  # ...but it is explicitly marked unanswerable
    assert prompt != "How many claims total?"


# --------------------------------------------------------------- no-data guard
#
# These assert on what is SENT TO THE MODEL, not on what a fake model returns.
# That is the only part the graph controls, and it is where the real defect was:
# with no case_id the graph passed the bare question through, and a live model
# answered by inventing "Claim #1234" with a 0.4 confidence score from a
# "keyword extraction model" — then credited the governed semantic layer for it.
# A FakeLlm returning canned text cannot catch that; the prompt contract can.


async def test_ungrounded_question_instructs_the_model_to_refuse():
    """No case_id -> no data exists, so the graph must tell the model to refuse
    rather than hand it a bare question it can only answer by inventing one."""
    llm = FakeLlm(content="I can't answer that from this screen.")
    await run_analytics(GraphDeps(llm=llm), {"tenant_id": TENANT_A,
                                             "query": "Which claim is riskiest?"})

    user_msg = llm.calls[0]["messages"][-1]["content"]
    assert "NO DATA" in user_msg
    assert "do not invent" in user_msg.lower()
    # The question still reaches the model — we refuse it, we don't drop it.
    assert "Which claim is riskiest?" in user_msg


async def test_system_prompt_never_tells_the_model_to_claim_governed_provenance():
    """The original prompt said to 'cite that the answer is grounded in the
    governed semantic layer' unconditionally — so an ungrounded model dutifully
    claimed provenance it never had. Fabricated provenance is the one failure
    this product cannot ship."""
    llm = FakeLlm(content="ok")
    await run_analytics(GraphDeps(llm=llm), {"tenant_id": TENANT_A, "query": "anything"})

    system = llm.calls[0]["messages"][0]["content"].lower()
    assert "cite that the answer is grounded" not in system
    assert "never claim an answer is grounded" in system


async def test_grounded_case_question_still_passes_the_real_case_data():
    """The refusal path must not swallow the branch that actually works: with a
    case_id, the case JSON still reaches the model."""
    llm = FakeLlm(content="The case is a duplicate invoice.")
    deps = GraphDeps(llm=llm, case_reader=FakeCaseReader(), evidence_reader=FakeEvidenceReader())
    await run_analytics(deps, {"tenant_id": TENANT_A, "case_id": "case-1",
                               "query": "What is this case about?"})

    user_msg = llm.calls[0]["messages"][-1]["content"]
    assert "Case (JSON):" in user_msg
    assert "NO DATA" not in user_msg


async def test_answers_are_not_truncated_mid_sentence_by_a_tight_token_cap():
    """The live answer stopped at exactly 300 output tokens, mid-sentence
    ("Please let me know if"). Keep real headroom."""
    llm = FakeLlm(content="ok")
    await run_analytics(GraphDeps(llm=llm), {"tenant_id": TENANT_A, "query": "anything"})
    assert llm.calls[0]["max_tokens"] >= 800
