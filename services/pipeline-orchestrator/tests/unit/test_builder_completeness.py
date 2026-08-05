"""BRD 71 inc1 — pipeline builder completeness, backend half.

Covers the three backend deliverables: the `drop-columns` operator + `select-columns`
exclude mode (P6, AC-1/AC-2), the served resource policy (U1, AC-3) and the
`effective_resources` the validation report now returns (U1, AC-4).
"""

from __future__ import annotations

import pandas as pd
import pytest

from app.domain.catalog import DATA_PREP, seed_components
from app.domain.dag import validate_definition
from app.domain.enums import PipelineType
from app.domain.resources import DEFAULTS, FLOOR, PLATFORM_CEILING
from app.executor.local_pipeline import LocalPipelineExecutor
from app.executor.operators import OPERATORS, OperatorError, run_operator

_CEIL = dict(PLATFORM_CEILING)


def _df() -> pd.DataFrame:
    return pd.DataFrame({"cat": ["a", "b", "a"], "x": [1.0, 2.0, 3.0],
                         "pii": ["s1", "s2", "s3"], "label": [0, 1, 0]})


# ---------------------------------------------------------------------------
# P6 — drop-columns (AC-1) + label protection / exclude mode (AC-2)
# ---------------------------------------------------------------------------

def test_drop_columns_is_in_the_catalog_as_a_data_prep_component():
    comps = {c.name: c for c in seed_components()}
    assert "drop-columns" in comps
    comp = comps["drop-columns"]
    assert comp.component_type == DATA_PREP
    params = comp.definition["parameters"]
    assert params["columns"]["required"] is True
    assert params["columns"]["format"] == "columns"


def test_drop_columns_has_a_local_implementation():
    assert "drop-columns" in OPERATORS


def test_drop_columns_drops_exactly_the_named_columns():
    out = run_operator("drop-columns", [_df()], {"columns": ["pii", "x"]})[0]
    assert list(out.columns) == ["cat", "label"]
    assert len(out) == 3  # a projection, not a filter


def test_drop_columns_ignores_unknown_columns_rather_than_failing():
    # A drop list that outlives a schema change must not fail the run — the intent
    # ("this column must not be here") is already satisfied. This is V1's behavior.
    out = run_operator("drop-columns", [_df()], {"columns": ["pii", "gone_last_week"]})[0]
    assert list(out.columns) == ["cat", "x", "label"]


def test_drop_columns_requires_a_column_list():
    with pytest.raises(OperatorError):
        run_operator("drop-columns", [_df()], {})


def test_drop_columns_refuses_to_drop_every_column():
    with pytest.raises(OperatorError):
        run_operator("drop-columns", [_df()], {"columns": list(_df().columns)})


def test_drop_columns_never_drops_the_label_column():
    # AC-2. Dropping the label always fails the fit, and the failure surfaces deep
    # inside training rather than at this node — so it is refused here.
    out = run_operator("drop-columns", [_df()],
                       {"columns": ["pii", "label"], "label_column": "label"})[0]
    assert "label" in out.columns
    assert "pii" not in out.columns


def test_executor_injects_the_runs_label_column_into_drop_columns():
    # The node definition should not have to restate what the training step declares.
    definition = {
        "nodes": [
            {"alias": "r", "component": "read-from-warehouse", "parameters": {"dataset": "d"}},
            {"alias": "d1", "component": "drop-columns",
             "parameters": {"columns": ["label", "pii"]}},
        ],
        "edges": [{"from": "r.out", "to": "d1"}],
    }
    ex = LocalPipelineExecutor(reader=lambda urn, params: _df())
    result = ex.run(definition, {"label_column": "label"})
    assert "label" in result.outputs["d1"].columns
    assert "pii" not in result.outputs["d1"].columns


def test_an_explicit_node_label_column_wins_over_the_run_parameter():
    definition = {
        "nodes": [
            {"alias": "r", "component": "read-from-warehouse", "parameters": {"dataset": "d"}},
            {"alias": "d1", "component": "drop-columns",
             "parameters": {"columns": ["label"], "label_column": "cat"}},
        ],
        "edges": [{"from": "r.out", "to": "d1"}],
    }
    ex = LocalPipelineExecutor(reader=lambda urn, params: _df())
    result = ex.run(definition, {"label_column": "label"})
    # The node named `cat` as its label, so `label` is droppable here.
    assert "label" not in result.outputs["d1"].columns


def test_executor_without_run_parameters_is_unchanged():
    definition = {
        "nodes": [
            {"alias": "r", "component": "read-from-warehouse", "parameters": {"dataset": "d"}},
            {"alias": "d1", "component": "drop-columns", "parameters": {"columns": ["pii"]}},
        ],
        "edges": [{"from": "r.out", "to": "d1"}],
    }
    result = LocalPipelineExecutor(reader=lambda urn, params: _df()).run(definition)
    assert list(result.outputs["d1"].columns) == ["cat", "x", "label"]


def test_select_columns_exclude_inverts_the_projection():
    out = run_operator("select-columns", [_df()], {"columns": ["pii"], "exclude": True})[0]
    assert list(out.columns) == ["cat", "x", "label"]


def test_select_columns_exclude_preserves_frame_column_order():
    out = run_operator("select-columns", [_df()],
                       {"columns": ["x"], "exclude": True})[0]
    assert list(out.columns) == ["cat", "pii", "label"]


def test_select_columns_without_exclude_is_unchanged():
    out = run_operator("select-columns", [_df()], {"columns": ["x", "cat"]})[0]
    assert list(out.columns) == ["x", "cat"]


def test_select_columns_exclude_refuses_to_drop_every_column():
    with pytest.raises(OperatorError):
        run_operator("select-columns", [_df()],
                     {"columns": list(_df().columns), "exclude": True})


def test_drop_columns_validates_and_compiles_in_a_definition():
    # AC-1: authoring path, not just the executor.
    comps = {c.name: c for c in seed_components()}
    definition = {
        "nodes": [
            {"alias": "r", "component": "read-from-warehouse",
             "parameters": {"dataset": "wr:t:dataset:dataset/d"}},
            {"alias": "d1", "component": "drop-columns", "parameters": {"columns": ["pii"]}},
            {"alias": "w", "component": "write-to-warehouse",
             "parameters": {"output_dataset_name": "out"}},
        ],
        "edges": [{"from": "r.out", "to": "d1"}, {"from": "d1.out", "to": "w"}],
    }
    report = validate_definition(definition, pipeline_type=PipelineType.data_prep,
                                 model_type=None, components=comps,
                                 quota_ceiling=_CEIL, mode="all")
    assert report.valid, report.items


# ---------------------------------------------------------------------------
# U1 — effective_resources in the validation report (AC-4)
# ---------------------------------------------------------------------------

def _resource_definition(explicit: dict | None) -> dict:
    read: dict = {"alias": "r", "component": "read-from-warehouse",
                  "parameters": {"dataset": "wr:t:dataset:dataset/d"}}
    if explicit is not None:
        read["resources"] = explicit
    return {
        "nodes": [
            read,
            {"alias": "d1", "component": "drop-columns", "parameters": {"columns": ["pii"]}},
            {"alias": "w", "component": "write-to-warehouse",
             "parameters": {"output_dataset_name": "out"}},
        ],
        "edges": [{"from": "r.out", "to": "d1"}, {"from": "d1.out", "to": "w"}],
    }


def _report(definition: dict, ceiling: dict | None = None):
    return validate_definition(
        definition, pipeline_type=PipelineType.data_prep, model_type=None,
        components={c.name: c for c in seed_components()},
        quota_ceiling=ceiling or _CEIL, mode="all")


def test_validation_report_exposes_effective_resources_per_alias():
    payload = _report(_resource_definition(None)).to_dict()
    assert set(payload["effective_resources"]) == {"r", "d1", "w"}
    assert payload["effective_resources"]["r"] == DEFAULTS


def test_effective_resources_show_inherited_values_not_just_declared_ones():
    # The whole point of returning these: d1 and w declare nothing, and inherit.
    payload = _report(_resource_definition(
        {"cpus": 4, "ram_gb": 16, "timeout_minutes": 120})).to_dict()
    eff = payload["effective_resources"]
    assert eff["r"] == {"cpus": 4, "ram_gb": 16, "timeout_minutes": 120}
    assert eff["d1"] == eff["r"], "downstream node must inherit from its predecessor"
    assert eff["w"] == eff["r"]


def test_effective_resources_are_clamped_to_the_tenant_ceiling():
    ceiling = {**PLATFORM_CEILING, "ram_gb": 8}
    payload = _report(_resource_definition({"cpus": 1, "ram_gb": 64,
                                            "timeout_minutes": 30}), ceiling).to_dict()
    assert payload["effective_resources"]["r"]["ram_gb"] == 8


def test_effective_resources_are_clamped_to_the_floor():
    payload = _report(_resource_definition({"cpus": 0, "ram_gb": 0,
                                            "timeout_minutes": 0})).to_dict()
    assert payload["effective_resources"]["r"] == FLOOR


def test_validation_report_keeps_its_existing_keys():
    payload = _report(_resource_definition(None)).to_dict()
    assert payload["status"] == "valid"
    assert payload["items"] == []


# ---------------------------------------------------------------------------
# U1 — GET /resource-policy (AC-3), through the real API
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_resource_policy_returns_defaults_floor_and_ceiling(client):
    from tests.conftest import auth

    resp = await client.get("/api/v1/resource-policy", headers=auth())
    assert resp.status_code == 200, resp.text
    data = resp.json()["data"]
    assert data["defaults"] == DEFAULTS
    assert data["floor"] == FLOOR
    assert data["ceiling"] == PLATFORM_CEILING


@pytest.mark.asyncio
async def test_resource_policy_reflects_the_tenant_ceiling_not_the_platform_one(client):
    # AC-3. The form must be bounded by what THIS tenant may actually request,
    # otherwise it offers values the compiler silently clamps.
    from tests.conftest import TENANT_A, auth

    put = await client.put(
        f"/api/v1/admin/quotas/{TENANT_A}",
        headers=auth(scopes=["pipeline.quota.admin"]),
        json={"resource_ceiling": {"cpus": 2, "ram_gb": 8, "timeout_minutes": 60}})
    assert put.status_code in (200, 201), put.text

    resp = await client.get("/api/v1/resource-policy", headers=auth())
    ceiling = resp.json()["data"]["ceiling"]
    assert ceiling["ram_gb"] == 8
    assert ceiling["cpus"] == 2
    assert resp.json()["data"]["floor"] == FLOOR, "the floor is platform-wide, not per tenant"
