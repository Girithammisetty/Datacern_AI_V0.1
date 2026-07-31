"""meta-router classifies a request and delegates to the matching specialist
agent, reusing the SAME GraphDeps so the delegate's own grounding/write-intent
logic runs unchanged (ART-FR-040, §8.4)."""

from __future__ import annotations

from app.adapters.fakes import FakeLlm, FakeMemory
from app.domain.ports import LlmResult
from app.graphs.base import GraphDeps
from app.graphs.meta_router import run_meta_router
from tests.conftest import TENANT_A


class _SequencedLlm:
    """Returns a different response per successive call (classify, then the
    delegate's own LLM call) — FakeLlm alone can't model two distinct prompts."""

    def __init__(self, contents: list[str]) -> None:
        self._contents = list(contents)
        self.calls: list[dict] = []

    async def chat(self, *, messages, tenant_id, response_format=None,
                   temperature=None, max_tokens=None) -> LlmResult:
        self.calls.append({"messages": messages, "tenant_id": tenant_id})
        idx = min(len(self.calls) - 1, len(self._contents) - 1)
        return LlmResult(content=self._contents[idx], input_tokens=10,
                         output_tokens=5, model="fake-fast-small", deployment="fake")


async def test_meta_router_delegates_to_governance_and_forwards_write_intent():
    llm = _SequencedLlm([
        '{"agent_key":"governance","confidence":0.9,'
        '"rationale":"drift/retrain question"}',
        "Drift exceeds threshold; retrain warranted.",
    ])
    deps = GraphDeps(llm=llm, memory=FakeMemory(), prompt_params={}, obo_token="tok")

    outcome = await run_meta_router(deps, {
        "tenant_id": TENANT_A,
        "query": "Model drift check: drift_score 0.45, 25 corrections.",
        "signals": {"drift_score": 0.45, "correction_count": 25},
        "model_urn": f"wr:{TENANT_A}:model:model/claims-fraud",
    })

    assert outcome.structured["routed_to"] == "governance"
    assert outcome.final_text.startswith("[routed to governance] ")
    wi = outcome.write_intent
    assert wi is not None
    assert wi.tool_id == "mlops.open_retrain"
    # both LLM calls (classify + delegate) were made and metered
    assert len(llm.calls) == 2
    assert outcome.usage["output_tokens"] == 10  # 5 (classify) + 5 (delegate)


async def test_meta_router_falls_back_to_analytics_on_unparsable_classification():
    # Non-JSON classify response -> falls back to "analytics"; analytics's own
    # node just consumes the SAME text as a freeform answer (no format clash).
    llm = FakeLlm(content="I'm not sure how to route this, but here's an answer.")
    deps = GraphDeps(llm=llm, memory=FakeMemory(), prompt_params={}, obo_token="tok")

    outcome = await run_meta_router(deps, {
        "tenant_id": TENANT_A, "query": "what does this even mean"})

    assert outcome.structured["routed_to"] == "analytics"
    assert outcome.write_intent is None  # analytics is read-only
    assert len(llm.calls) == 2  # classify + delegate, both hit the real double
    # The caller is told the route was a guess rather than being answered as if
    # the analytics agent had been confidently selected.
    assert outcome.structured["routing_fallback_reason"] == "unparseable_classifier_output"
    assert outcome.final_text.startswith("[routed to analytics — uncertain,")


async def test_confident_route_is_not_labelled_uncertain():
    """A real match must stay clean — the uncertainty marker only appears when
    routing actually was uncertain, or it becomes noise users learn to ignore."""
    llm = _SequencedLlm([
        '{"agent_key":"governance","confidence":0.93,"rationale":"drift question"}',
        "Drift exceeds threshold; retrain warranted.",
    ])
    deps = GraphDeps(llm=llm, memory=FakeMemory(), prompt_params={}, obo_token="tok")

    outcome = await run_meta_router(deps, {
        "tenant_id": TENANT_A, "query": "is my model drifting?",
        "signals": {"drift_score": 0.45, "correction_count": 25},
        "model_urn": f"wr:{TENANT_A}:model:model/claims-fraud"})

    assert outcome.structured["routing_fallback_reason"] is None
    assert outcome.structured["routing_confidence"] == 0.93
    assert outcome.final_text.startswith("[routed to governance] ")


async def test_low_confidence_is_honoured_rather_than_promoted_to_a_decision():
    """The classifier picked a REAL candidate but said it was unsure. Running
    that specialist anyway would answer as the wrong expert; the router instead
    falls back to the read-only default and says the route was uncertain."""
    llm = _SequencedLlm([
        '{"agent_key":"onboarding","confidence":0.2,"rationale":"might be a load request"}',
        "Here is an answer.",
    ])
    deps = GraphDeps(llm=llm, memory=FakeMemory(), prompt_params={}, obo_token="tok")

    outcome = await run_meta_router(deps, {
        "tenant_id": TENANT_A, "query": "do something with the vendor stuff"})

    assert outcome.structured["routed_to"] == "analytics"
    assert outcome.structured["routing_fallback_reason"] == "low_confidence"
    assert outcome.structured["routing_confidence"] == 0.2
    assert outcome.write_intent is None  # the guess cannot manufacture a write


async def test_absent_confidence_is_not_treated_as_a_guess():
    """"The model did not report confidence" is not the same fact as "the model
    is unsure" — coercing a missing field to 0.0 would send every confident
    route to the fallback."""
    llm = _SequencedLlm([
        '{"agent_key":"governance","rationale":"drift question"}',
        "Drift exceeds threshold; retrain warranted.",
    ])
    deps = GraphDeps(llm=llm, memory=FakeMemory(), prompt_params={}, obo_token="tok")

    outcome = await run_meta_router(deps, {
        "tenant_id": TENANT_A, "query": "is my model drifting?",
        "signals": {"drift_score": 0.45, "correction_count": 25},
        "model_urn": f"wr:{TENANT_A}:model:model/claims-fraud"})

    assert outcome.structured["routed_to"] == "governance"
    assert outcome.structured["routing_confidence"] is None
    assert outcome.structured["routing_fallback_reason"] is None


async def test_hallucinated_agent_key_falls_back_and_names_the_reason():
    llm = _SequencedLlm([
        '{"agent_key":"sql-wizard","confidence":0.99,"rationale":"made this up"}',
        "Here is an answer.",
    ])
    deps = GraphDeps(llm=llm, memory=FakeMemory(), prompt_params={}, obo_token="tok")

    outcome = await run_meta_router(deps, {
        "tenant_id": TENANT_A, "query": "write me some sql"})

    assert outcome.structured["routed_to"] == "analytics"
    assert outcome.structured["routing_fallback_reason"] == "unknown_target"


def test_router_candidates_and_prompt_agree():
    """The candidate list the code enforces and the list the model is shown must
    not drift: an agent in one but not the other is either unreachable or a
    guaranteed unknown_target fallback."""
    from app.graphs.meta_router import _ALLOWED
    from app.prompts import system_prompt

    prompt = system_prompt("meta_router.system")
    for key in _ALLOWED:
        assert f"- {key}:" in prompt, f"{key} is routable but absent from the prompt"


def test_agents_excluded_from_routing_stay_excluded():
    """Both exclusions are deliberate and load-bearing: case-triage needs a
    case_id the chat route demands separately, and ml-engineer LAUNCHES billable
    training runs before it proposes, so an ambiguous sentence must not reach
    it."""
    from app.graphs.meta_router import _ALLOWED

    assert "case-triage" not in _ALLOWED
    assert "ml-engineer" not in _ALLOWED


def test_meta_router_toolset_covers_every_routable_delegate():
    """The invariant that makes routing usable: meta-router forwards a delegate's
    WriteIntent under its OWN agent version, so any routable delegate whose write
    tool is missing from the router's declared toolset gets rejected as a
    guardrail violation at the proposal chokepoint — routing would appear to work
    right up until the user tried to act on it."""
    from app.agents.catalog import toolset_for
    from app.graphs.meta_router import _ALLOWED

    router_tools = {t["tool_id"] for t in toolset_for("meta-router")}
    for key in _ALLOWED:
        for tool in toolset_for(key):
            assert tool["tool_id"] in router_tools, (
                f"{key} is routable and can emit {tool['tool_id']}, which is not in "
                f"meta-router's declared toolset — its proposals would be rejected")


# ---- route hint: the screen breaks ties, never overrides a clear request -----
#
# Routing used to be decided ENTIRELY by the UI route: the copilot drawer bound
# its agent to the pathname, so a dashboard question asked from a case page kept
# answering as the case page's agent and nothing ever re-routed mid-thread. The
# drawer now talks to this router every turn and passes the screen as a hint.
# A hint that could override the text would just reintroduce the original bug in
# a new place, so these tests pin that it stays subordinate to intent.

async def test_route_hint_reaches_the_classifier_prompt():
    llm = _SequencedLlm([
        '{"agent_key":"inference","confidence":0.9,"rationale":"scoring"}',
        "Scoring job proposed.",
    ])
    deps = GraphDeps(llm=llm, memory=FakeMemory(), prompt_params={}, obo_token="tok")

    await run_meta_router(deps, {
        "tenant_id": TENANT_A, "query": "run it again", "route_hint": "inference"})

    classify_prompt = llm.calls[0]["messages"][-1]["content"]
    assert "run it again" in classify_prompt
    assert "inference" in classify_prompt
    # It must be presented as a tie-breaker, not as the answer.
    assert "ONLY to break a tie" in classify_prompt


async def test_a_clear_request_routes_against_the_hint():
    """The bug this whole change exists to fix: being on the dashboards screen
    must not stop a data question from reaching analytics."""
    llm = _SequencedLlm([
        '{"agent_key":"analytics","confidence":0.95,"rationale":"data question"}',
        "Approvals rose 12% last week.",
    ])
    deps = GraphDeps(llm=llm, memory=FakeMemory(), prompt_params={}, obo_token="tok")

    outcome = await run_meta_router(deps, {
        "tenant_id": TENANT_A,
        "query": "why did approvals spike last week?",
        "route_hint": "dashboard-designer",
    })

    assert outcome.structured["routed_to"] == "analytics"


async def test_hint_is_not_forwarded_to_the_delegate():
    """The delegate IS the routing decision; passing the prior on invites it to
    re-litigate a choice already made."""
    seen: dict = {}

    async def _spy_runner(deps, inputs):  # noqa: ANN001
        seen.update(inputs)
        from app.graphs.base import GraphOutcome
        return GraphOutcome(final_text="ok", write_intent=None, usage={}, trace=[],
                            structured={}, evidence=[])

    import app.graphs as graphs_pkg
    original = graphs_pkg.RUNNERS["analytics"]
    graphs_pkg.RUNNERS["analytics"] = ("analytics.v1", _spy_runner)
    try:
        llm = _SequencedLlm(['{"agent_key":"analytics","confidence":0.9,"rationale":"q"}'])
        deps = GraphDeps(llm=llm, memory=FakeMemory(), prompt_params={}, obo_token="tok")
        await run_meta_router(deps, {
            "tenant_id": TENANT_A, "query": "how many cases?", "route_hint": "onboarding"})
    finally:
        graphs_pkg.RUNNERS["analytics"] = original

    assert "route_hint" not in seen
    assert seen.get("query") == "how many cases?"  # everything else still forwarded


async def test_routing_trace_records_whether_a_hint_was_in_play():
    llm = _SequencedLlm([
        '{"agent_key":"analytics","confidence":0.9,"rationale":"q"}', "answer"])
    deps = GraphDeps(llm=llm, memory=FakeMemory(), prompt_params={}, obo_token="tok")

    outcome = await run_meta_router(deps, {
        "tenant_id": TENANT_A, "query": "how many cases?", "route_hint": "onboarding"})

    routed = [e for e in outcome.trace if e.get("event") in ("routed", "routed_by_fallback")]
    assert routed and routed[0]["route_hint"] == "onboarding"


async def test_unroutable_hint_is_ignored_not_interpolated():
    """case-triage/ml-engineer are excluded from free-text routing on purpose;
    a hint naming one must not smuggle it into the classifier prompt."""
    llm = _SequencedLlm([
        '{"agent_key":"analytics","confidence":0.9,"rationale":"q"}', "answer"])
    deps = GraphDeps(llm=llm, memory=FakeMemory(), prompt_params={}, obo_token="tok")

    await run_meta_router(deps, {
        "tenant_id": TENANT_A, "query": "check this", "route_hint": "ml-engineer"})

    assert "ml-engineer" not in llm.calls[0]["messages"][-1]["content"]
