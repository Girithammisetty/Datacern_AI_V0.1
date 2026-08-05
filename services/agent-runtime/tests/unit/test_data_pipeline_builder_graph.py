"""BRD 62 — the data-pipeline-builder agent produces a GOVERNED data-prep pipeline
create WRITE INTENT (never a direct write), grounded in the live operator catalog,
and wires the chosen operators into a validated linear DAG.
"""

from __future__ import annotations

from app.adapters.fakes import FakeLlm, FakeMemory, FakePipelineReader
from app.graphs.base import GraphDeps
from app.graphs.data_pipeline_builder import CREATE_TOOL_ID, run_data_pipeline_builder
from tests.conftest import TENANT_A

_PLAN_JSON = (
    '{"name": "Claims cleanup",'
    ' "operators": ['
    '   {"component": "filter-data", "parameters": {"expression": "amount > 0"}},'
    '   {"component": "handle-missing-values", "parameters": {"strategy": "mean"}},'
    '   {"component": "bogus-operator", "parameters": {}},'
    '   {"component": "one-hot-encoder", "parameters": {"columns": ["merchant"]}}'
    ' ],'
    ' "rationale": "Drop non-positive amounts, impute nulls, one-hot the merchant."}'
)


def _deps(**over):
    base = dict(
        llm=FakeLlm(content=_PLAN_JSON),
        memory=FakeMemory(results=[{"content": "prior claims prep dropped negatives"}]),
        pipeline_reader=FakePipelineReader(),
        prompt_params={}, obo_token="tok")
    base.update(over)
    return GraphDeps(**base)


async def test_builds_governed_data_prep_pipeline_intent():
    deps = _deps()
    outcome = await run_data_pipeline_builder(deps, {
        "tenant_id": TENANT_A, "query": "clean up the claims dataset: drop non-positive "
        "amounts, fill missing values, one-hot the merchant column",
        "dataset": "claims", "workspace_id": "ws-1"})

    wi = outcome.write_intent
    assert wi is not None
    assert wi.tool_id == CREATE_TOOL_ID == "pipeline.template.create"
    assert wi.tier == "write-proposal"
    assert wi.args["pipeline_type"] == "data_prep"
    assert wi.args["workspace_id"] == "ws-1"
    assert wi.required_action == "pipeline.template.create"

    definition = wi.args["definition"]
    comps = [n["component"] for n in definition["nodes"]]
    # A validated LINEAR DAG: read → chosen operators → write.
    assert comps[0] == "read-from-warehouse"
    assert comps[-1] == "write-to-warehouse"
    # The unknown "bogus-operator" was dropped (fail safe); the 3 valid ops remain.
    assert "filter-data" in comps and "handle-missing-values" in comps
    assert "one-hot-encoder" in comps and "bogus-operator" not in comps
    # Edges chain the nodes end to end (n nodes → n-1 edges).
    assert len(definition["edges"]) == len(definition["nodes"]) - 1
    # The read node points at the resolved dataset URN.
    read = next(n for n in definition["nodes"] if n["component"] == "read-from-warehouse")
    assert read["parameters"]["dataset"].startswith(f"wr:{TENANT_A}:dataset:")


async def test_grounds_on_operator_catalog_and_memory():
    deps = _deps()
    await run_data_pipeline_builder(deps, {
        "tenant_id": TENANT_A, "query": "dedupe rows", "dataset": "claims"})
    assert any(c["op"] == "list_components" for c in deps.pipeline_reader.calls)
    assert deps.memory.calls  # RAG grounding attempted


async def test_defensive_on_bad_json():
    deps = _deps(llm=FakeLlm(content="not json"))
    outcome = await run_data_pipeline_builder(deps, {
        "tenant_id": TENANT_A, "query": "prep the data", "dataset": "claims"})
    # Still a valid proposal: read → (no operators) → write, never a crash.
    wi = outcome.write_intent
    comps = [n["component"] for n in wi.args["definition"]["nodes"]]
    assert comps == ["read-from-warehouse", "write-to-warehouse"]


# ---------------------------------------------------------------------------
# BRD 71 (U1, AC-10) — the agent may propose a per-pipeline resource envelope
# ---------------------------------------------------------------------------

_PLAN_WITH_RESOURCES = (
    '{"name": "Wide join prep",'
    ' "operators": [{"component": "join-data", "parameters": {"on": "claim_id"}}],'
    ' "rationale": "Wide join needs headroom.",'
    ' "resources": {"cpus": 4, "ram_gb": 16, "timeout_minutes": 120}}'
)

_PLAN_OVER_CEILING = (
    '{"name": "Huge", "operators": [{"component": "join-data", "parameters": {}}],'
    ' "rationale": "x", "resources": {"cpus": 99, "ram_gb": 512, "timeout_minutes": 9999}}'
)

_PLAN_JUNK_RESOURCES = (
    '{"name": "Junk", "operators": [{"component": "filter-data", "parameters": {}}],'
    ' "rationale": "x", "resources": {"cpus": "lots", "gpus": 4}}'
)


async def _run(plan_json: str, **over):
    deps = _deps(llm=FakeLlm(content=plan_json), **over)
    return await run_data_pipeline_builder(deps, {
        "tenant_id": TENANT_A, "query": "join claims to members", "dataset": "claims",
        "workspace_id": "ws-1"})


async def test_proposed_resources_land_on_the_read_node():
    # A linear DAG inherits from its predecessor, so one declaration on the read node
    # sizes the whole pipeline — no second "pipeline-global" concept needed.
    outcome = await _run(_PLAN_WITH_RESOURCES)
    nodes = outcome.write_intent.args["definition"]["nodes"]
    assert nodes[0]["component"] == "read-from-warehouse"
    assert nodes[0]["resources"] == {"cpus": 4, "ram_gb": 16, "timeout_minutes": 120}
    # Downstream nodes stay un-pinned so inheritance still applies.
    assert all("resources" not in n for n in nodes[1:])


async def test_proposed_resources_are_summarised_for_the_reviewer():
    outcome = await _run(_PLAN_WITH_RESOURCES)
    assert "Resources:" in outcome.write_intent.predicted_effect["summary"]
    assert "16" in outcome.write_intent.predicted_effect["summary"]


async def test_resources_over_the_tenant_ceiling_are_clamped_not_dropped():
    # AC-10. Clamping keeps the reviewer's signal ("this step is memory-hungry")
    # instead of silently reverting to the 2 GB default.
    outcome = await _run(_PLAN_OVER_CEILING)
    res = outcome.write_intent.args["definition"]["nodes"][0]["resources"]
    assert res == {"cpus": 7, "ram_gb": 24, "timeout_minutes": 480}


async def test_resources_below_the_floor_are_raised_to_it():
    plan = ('{"name": "Tiny", "operators": [{"component": "filter-data", "parameters": {}}],'
            ' "rationale": "x", "resources": {"cpus": 0, "ram_gb": 0, "timeout_minutes": 1}}')
    res = (await _run(plan)).write_intent.args["definition"]["nodes"][0]["resources"]
    assert res == {"cpus": 1, "ram_gb": 2, "timeout_minutes": 5}


async def test_unknown_and_non_numeric_resource_fields_are_ignored():
    outcome = await _run(_PLAN_JUNK_RESOURCES)
    assert "resources" not in outcome.write_intent.args["definition"]["nodes"][0]


async def test_no_resources_proposed_means_the_node_inherits():
    # The default plan JSON carries no `resources` — the definition must be byte
    # identical to what it was before this feature existed.
    outcome = await _run(_PLAN_JSON)
    assert all("resources" not in n
               for n in outcome.write_intent.args["definition"]["nodes"])


async def test_no_resources_proposed_when_the_policy_is_unavailable():
    # An unbounded guess is worse than inheriting: with no served policy the agent
    # must not propose an envelope at all.
    outcome = await _run(_PLAN_WITH_RESOURCES,
                         pipeline_reader=FakePipelineReader(resource_policy={}))
    assert "resources" not in outcome.write_intent.args["definition"]["nodes"][0]


async def test_the_policy_is_fetched_during_grounding():
    reader = FakePipelineReader()
    deps = _deps(llm=FakeLlm(content=_PLAN_WITH_RESOURCES), pipeline_reader=reader)
    await run_data_pipeline_builder(deps, {
        "tenant_id": TENANT_A, "query": "join claims", "dataset": "claims"})
    assert any(c["op"] == "resource_policy" for c in reader.calls)
