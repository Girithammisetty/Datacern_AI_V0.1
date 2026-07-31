"""meta-router agent (ART-FR-040, §8.4 "Meta-agent router").

Classifies the user's request and delegates to the specialist agent whose
skill matches, reusing the SAME ``GraphDeps`` (real LLM, real memory, real
downstream readers) so the delegate runs exactly as if it had been invoked
directly — no mocked hand-off. The router never invents write authority: it
forwards the delegate's own ``GraphOutcome`` (including any WriteIntent)
unchanged, so whether a run becomes a Proposal is governed entirely by the
delegate's write mode, not by the router.

Two agents are deliberately NOT routable from free text, for different reasons:

* ``case-triage`` requires a ``case_id`` (the chat route rejects a call without
  one), so a case-scoped copilot invokes it directly.
* ``ml-engineer`` LAUNCHES real training runs during its ``train`` node before
  it proposes anything (BRD 52). Free-text routing into it would let an
  ambiguous sentence start billable compute, so reaching it stays an explicit
  choice. ``model-training`` is the routable agent that *proposes* a training
  run without executing one.

Routing honesty: the classifier reports a confidence, and every path that did
NOT produce a confident match is recorded distinctly (``low_confidence``,
``unparseable``, ``unknown_target``) in the trace and in ``structured`` rather
than being flattened into an ordinary "routed" event. The fallback target is
deliberately ``analytics`` — the only read-only candidate — so a mis-route can
never manufacture a WriteIntent the user did not ask for.
"""

from __future__ import annotations

import json

from langgraph.graph import END, StateGraph

from app.graphs.base import GraphDeps, GraphOutcome, register
from app.prompts import system_prompt

_CANDIDATES = [
    ("analytics", "Conversational analytics over the governed semantic layer. "
                  "Use for questions about data, counts, trends, metrics."),
    ("onboarding", "Proposes ingestion configs and column mappings for a new "
                   "data source. Use for requests to onboard, import, or load data."),
    ("data-pipeline-builder", "Proposes a data-prep / feature-engineering "
                              "pipeline (an ordered list of transform operators) "
                              "over a dataset that is ALREADY loaded. Use for "
                              "requests to clean, transform, reshape or prepare "
                              "data — not to load it (that is onboarding)."),
    ("model-training", "Proposes a training run (algorithm, hyperparameters, "
                        "features) for a dataset. Use for requests to train or "
                        "build a model."),
    ("inference", "Proposes a batch inference job with a registered model. Use "
                  "for requests to run, score, or predict with an existing model."),
    ("dashboard-designer", "Proposes a draft dashboard (title + charts) over "
                            "the semantic layer. Use for requests to design or "
                            "build a dashboard or report."),
    ("governance", "Assesses drift/correction signals and opens a retrain "
                   "proposal if warranted. Use for model-governance or drift "
                   "questions."),
]
_ALLOWED = {k for k, _ in _CANDIDATES}
#: Public view of the routable set, for callers that must validate a proposed
#: target before it reaches this graph (the chat route clamps `route_hint` to it).
#: Deliberately excludes case-triage and ml-engineer — see the module docstring.
ROUTABLE_AGENT_KEYS = frozenset(_ALLOWED)
#: The fallback target MUST stay read-only. Every uncertain path lands here, so
#: a target that could emit a WriteIntent would turn "I could not tell what you
#: meant" into a proposal for an action nobody requested.
_DEFAULT = "analytics"
#: Below this self-reported confidence the classification is treated as a guess
#: and labelled as one. It still delegates to the read-only default (a router
#: that refuses outright would strand the caller mid-conversation), but the
#: guess is never presented as a confident match.
_MIN_CONFIDENCE = 0.5

# Why a routing decision was not a confident match (absent = confident).
_FB_LOW_CONFIDENCE = "low_confidence"
_FB_UNPARSEABLE = "unparseable_classifier_output"
_FB_UNKNOWN_TARGET = "unknown_target"


def _parse_confidence(raw) -> float | None:
    """Confidence as a 0..1 float, or None when the model omitted/garbled it.

    None is NOT coerced to 0.0: "the model did not tell us" and "the model told
    us it is unsure" are different facts, and only the second is evidence of a
    guess.
    """
    if isinstance(raw, bool) or not isinstance(raw, (int, float)):
        return None
    return max(0.0, min(1.0, float(raw)))

_SYS = system_prompt("meta_router.system")

# Keys the router itself adds to state; everything else in the original input
# (tenant_id/query/workspace_id/case_id, plus any caller-supplied extra fields
# such as governance's signals/model_urn or onboarding's connection_id) is
# forwarded to the delegate UNCHANGED — the router narrows only WHICH agent
# runs, never WHAT it sees.
_ROUTER_OWNED_KEYS = {"target_agent_key", "routing_rationale", "routing_confidence",
                     "routing_fallback_reason", "usage", "trace", "delegate_outcome",
                     # Router-only: the delegate already IS the routing decision,
                     # so passing the prior on would just be noise it might act on.
                     "route_hint"}


def _safe_delegate_target(target: str, runners) -> str:
    """The orchestrator only ever dispatches to an allow-listed, REGISTERED delegate.
    A self-asserted / unknown / unregistered target falls back to the safe default —
    an injected classifier can never route the caller to an off-list agent (P1)."""
    if target in _ALLOWED and target in runners:
        return target
    return _DEFAULT


def build_meta_router_graph(deps: GraphDeps):
    async def classify(state: dict) -> dict:
        query = state.get("query", "") or ""
        # The caller's current screen, as a TIE-BREAKER only. "run it again" on
        # the batch-scoring page means something different than the same words on
        # the training page, and the text alone cannot tell them apart. Phrased so
        # the model overrides it whenever the request is clear, because the whole
        # point of routing on intent is that the screen must not get the last word.
        hint = state.get("route_hint")
        user_content = query
        if hint in ROUTABLE_AGENT_KEYS:
            user_content = (
                f"{query}\n\n[The user is currently on the {hint} screen. Use this "
                "ONLY to break a tie when the request itself is ambiguous; if the "
                "request clearly names a different task, route to that task instead.]")
        result = await deps.llm.chat(
            messages=[{"role": "system", "content": _SYS},
                      {"role": "user", "content": user_content}],
            tenant_id=state["tenant_id"],
            # ai-gateway's semantic cache matches on embedding similarity of the
            # full prompt (AIG-FR-040/BR-15). The classify system prompt is long
            # and near-identical across calls (it enumerates the fixed candidate
            # list every time) while the distinguishing signal is just the short
            # trailing user query — so at temperature<=0.2 (cache-eligible,
            # AIG-FR-042) two DIFFERENT routing questions can embed above the
            # 0.97 similarity threshold and the cache serves the FIRST call's
            # target for every later one, silently breaking routing. temperature
            # just above cache_max_temperature (0.2) is the gateway's documented
            # opt-out — the sanctioned way to force a live call per request.
            temperature=0.3, max_tokens=200,
            response_format={"type": "json_object"})
        parsed: dict = {}
        fallback_reason: str | None = None
        try:
            loaded = json.loads(result.content or "{}")
            if isinstance(loaded, dict):
                parsed = loaded
            else:
                fallback_reason = _FB_UNPARSEABLE
        except (json.JSONDecodeError, TypeError):
            fallback_reason = _FB_UNPARSEABLE

        target = parsed.get("agent_key")
        confidence = _parse_confidence(parsed.get("confidence"))
        if fallback_reason is None and target not in _ALLOWED:
            # Covers both a missing key and a hallucinated agent name.
            fallback_reason = _FB_UNKNOWN_TARGET
        if fallback_reason is None and confidence is not None and confidence < _MIN_CONFIDENCE:
            # The model picked a real candidate but told us it was unsure. Honour
            # its own uncertainty instead of promoting a guess to a decision.
            fallback_reason = _FB_LOW_CONFIDENCE
        if fallback_reason is not None:
            target = _DEFAULT

        state["target_agent_key"] = target
        state["routing_confidence"] = confidence
        state["routing_fallback_reason"] = fallback_reason
        state["routing_rationale"] = str(parsed.get("rationale", ""))[:400]
        state["usage"] = {"input_tokens": result.input_tokens,
                          "output_tokens": result.output_tokens, "model": result.model}
        # A guess and a confident match are different events, so they get
        # different names in the trace — an approver reviewing a proposal that
        # came out of a mis-route needs to see that routing was uncertain.
        state.setdefault("trace", []).append(
            {"event": "routed" if fallback_reason is None else "routed_by_fallback",
             "target_agent_key": target,
             "confidence": confidence,
             "fallback_reason": fallback_reason,
             # Recorded so a reviewer can tell a decision the text drove from one
             # the screen nudged — otherwise a hint-shaped mis-route is invisible.
             "route_hint": hint if hint in ROUTABLE_AGENT_KEYS else None,
             "rationale": state["routing_rationale"]})
        return state

    async def delegate(state: dict) -> dict:
        # Local import: app.graphs.__init__ populates RUNNERS by importing this
        # module, so a module-level `from app.graphs import RUNNERS` would be
        # circular. By the time this node executes, app.graphs has finished
        # importing and RUNNERS is fully populated.
        from app.graphs import RUNNERS

        requested = state["target_agent_key"]
        # Defense-in-depth (P1): re-assert the routing allow-list at the orchestrator
        # handoff. The classifier already clamps to _ALLOWED, but the dispatch step
        # must NOT trust a target that isn't an approved, registered delegate — reject
        # a self-asserted/unknown target and fall back to the safe default (logged),
        # never dispatch outside the allow-list.
        target = _safe_delegate_target(requested, RUNNERS)
        if target != requested:
            state.setdefault("trace", []).append(
                {"event": "routing_target_rejected", "requested": requested,
                 "fell_back_to": target})
            state["target_agent_key"] = target
            state["routing_fallback_reason"] = _FB_UNKNOWN_TARGET
        _, runner = RUNNERS[target]
        delegate_inputs = {k: v for k, v in state.items() if k not in _ROUTER_OWNED_KEYS}
        state["delegate_outcome"] = await runner(deps, delegate_inputs)
        return state

    g = StateGraph(dict)
    g.add_node("classify", classify)
    g.add_node("delegate", delegate)
    g.set_entry_point("classify")
    g.add_edge("classify", "delegate")
    g.add_edge("delegate", END)
    return g.compile()


@register("meta_router.v1")
def meta_router_module():
    return build_meta_router_graph


async def run_meta_router(deps: GraphDeps, inputs: dict) -> GraphOutcome:
    graph = build_meta_router_graph(deps)
    final = await graph.ainvoke(dict(inputs))
    outcome: GraphOutcome | None = final.get("delegate_outcome")
    router_usage = final.get("usage", {}) or {}
    combined_usage = dict(router_usage)
    if outcome and outcome.usage:
        combined_usage["input_tokens"] = (
            router_usage.get("input_tokens", 0) + outcome.usage.get("input_tokens", 0))
        combined_usage["output_tokens"] = (
            router_usage.get("output_tokens", 0) + outcome.usage.get("output_tokens", 0))
        combined_usage["model"] = outcome.usage.get("model", router_usage.get("model"))
    target = final.get("target_agent_key", _DEFAULT)
    fallback_reason = final.get("routing_fallback_reason")
    # Say so in the user-visible text when the route was a guess: the caller is
    # the one who can correct it, and silently answering as the wrong specialist
    # is the failure mode this router exists to avoid.
    prefix = (f"[routed to {target}] " if fallback_reason is None
              else f"[routed to {target} — uncertain, ask again naming the task if this is wrong] ")
    final_text = prefix + ((outcome.final_text or "") if outcome else "")
    trace = list(final.get("trace", []))
    if outcome:
        trace.extend(outcome.trace)
    return GraphOutcome(
        final_text=final_text,
        write_intent=outcome.write_intent if outcome else None,
        usage=combined_usage,
        trace=trace,
        structured={"routed_to": target,
                    "rationale": final.get("routing_rationale", ""),
                    "routing_confidence": final.get("routing_confidence"),
                    "routing_fallback_reason": fallback_reason,
                    **((outcome.structured if outcome else {}) or {})},
        evidence=outcome.evidence if outcome else [],
    )
