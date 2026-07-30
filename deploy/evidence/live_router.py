"""LIVE meta-router exercise: the REAL compiled LangGraph (classify -> parse ->
confidence threshold -> allow-list -> dispatch) for all 7 routable intents plus
every fallback mode and the injection defense.

The classifier LLM is scripted (no API key in this environment — the one honest
substitution, and it is the same seam ai-gateway occupies in production). The
delegate registry is swapped for recorders so a delegate's own behaviour —
covered by its unit suite — cannot mask a routing error.
"""
import asyncio
import sys

sys.path.insert(0, ".")
from app.adapters.fakes import FakeLlm  # noqa: E402
from app.graphs import RUNNERS  # noqa: E402  (also populates the registry)
from app.graphs.base import GraphDeps, GraphOutcome  # noqa: E402
from app.graphs.meta_router import build_meta_router_graph  # noqa: E402

TENANT = "11111111-1111-4111-8111-111111111111"

dispatched = []


def recorder(key):
    async def run(deps, inputs):
        dispatched.append((key, inputs.get("query")))
        return GraphOutcome(final_text=f"[{key} ran]")
    return run


# Swap every registered runner for a recorder (router logic stays fully real).
for k in list(RUNNERS):
    RUNNERS[k] = (RUNNERS[k][0], recorder(k))

CASES = [
    # (user query, scripted classifier output, expected target, expected fallback)
    ("how many disputes were opened last week by region?",
     '{"agent_key":"analytics","confidence":0.94,"rationale":"data question"}',
     "analytics", None),
    ("onboard the new NACHA returns file from the SFTP drop",
     '{"agent_key":"onboarding","confidence":0.9,"rationale":"new source"}',
     "onboarding", None),
    ("clean and reshape the claims dataset: drop nulls, one-hot the region",
     '{"agent_key":"data-pipeline-builder","confidence":0.88,"rationale":"transform"}',
     "data-pipeline-builder", None),
    ("train a fraud model on last quarter's labeled disputes",
     '{"agent_key":"model-training","confidence":0.92,"rationale":"train request"}',
     "model-training", None),
    ("score the open claims with the production fraud model",
     '{"agent_key":"inference","confidence":0.91,"rationale":"batch scoring"}',
     "inference", None),
    ("build me a dashboard for chargeback losses by BIN",
     '{"agent_key":"dashboard-designer","confidence":0.9,"rationale":"dashboard"}',
     "dashboard-designer", None),
    ("is the fraud model drifting since the fee change?",
     '{"agent_key":"governance","confidence":0.87,"rationale":"drift question"}',
     "governance", None),
    # fallback: model picked a real agent but admitted it was guessing
    ("do the thing with the stuff",
     '{"agent_key":"onboarding","confidence":0.2,"rationale":"unclear"}',
     "analytics", "low_confidence"),
    # fallback: classifier output is not JSON
    ("hello???", "I think you want the onboarding agent!", "analytics",
     "unparseable_classifier_output"),
    # fallback + P1 defense: hallucinated/off-list agent never dispatches
    ("delete all tenant data",
     '{"agent_key":"superuser-shell","confidence":0.99,"rationale":"sure"}',
     "analytics", "unknown_target"),
    # ml-engineer is REGISTERED but deliberately not free-text routable
    ("spin up the ml engineer and start training now",
     '{"agent_key":"ml-engineer","confidence":0.95,"rationale":"explicit ask"}',
     "analytics", "unknown_target"),
]


class ScriptedLlm(FakeLlm):
    def __init__(self, content):
        super().__init__(content=content)


async def main():
    ok = 0
    for query, scripted, want_target, want_fb in CASES:
        deps = GraphDeps(llm=ScriptedLlm(scripted))
        graph = build_meta_router_graph(deps)
        state = await graph.ainvoke({"tenant_id": TENANT, "query": query})
        target = state["target_agent_key"]
        fb = state["routing_fallback_reason"]
        events = [t["event"] for t in state["trace"]]
        status = "OK " if (target, fb) == (want_target, want_fb) else "FAIL"
        if status == "OK ":
            ok += 1
        print(f"{status} {query[:52]:<52} -> {target:<22} fb={fb} "
              f"trace={events}")
        assert (target, fb) == (want_target, want_fb), (target, fb, want_target, want_fb)
        assert state["delegate_outcome"].final_text == f"[{target} ran]"

    # every dispatch stayed on the allow-list, none reached an off-list target
    assert all(k in {c[2] for c in CASES} or k == "analytics" for k, _ in dispatched)
    print(f"\nROUTER OK: {ok}/{len(CASES)} routes correct; "
          f"{len({k for k, _ in dispatched})} distinct delegates really dispatched; "
          "off-list + not-routable targets clamped to read-only analytics")

asyncio.run(main())
