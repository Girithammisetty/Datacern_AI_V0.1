"""BRD 62 follow-up — every data-prep operator now declares an authoring param
schema, so a pipeline carrying their params validates like a UI submit (previously
only a subset had schemas, so e.g. group-by-with-params was rejected UNKNOWN_PARAM).
The executor already honored these params (test_operators.py); this closes the
authoring/validation side.
"""

from __future__ import annotations

import pandas as pd

from app.domain.catalog import DATA_PREP, seed_components
from app.domain.dag import validate_definition
from app.domain.enums import PipelineType
from app.executor.operators import OPERATORS, run_operator

_CEIL = {"cpus": 7, "ram_gb": 24, "timeout_minutes": 480}

# One realistic, valid param set per operator (matches what the executor consumes).
_PARAMS: dict[str, dict] = {
    "add-guid-column": {"column": "gid"},
    "cast-data": {"casts": {"x": "float"}},
    "correlation-filter": {"threshold": 0.9},
    "filter-data": {"expression": "x > 0"},
    "group-by": {"by": ["cat"], "aggregations": {"x": "sum"}},
    "handle-missing-values": {"strategy": "mean", "columns": ["x"]},
    "join-data": {"join_type": "left", "on": "cat"},
    "linear-combination": {"weights": {"x": 1.0}, "output_column": "lc"},
    "long-to-wide-converter": {"index": "cat", "columns": "x", "values": "x"},
    "merge-data": {"on": "cat"},
    "minmax-scale": {"columns": ["x"]},
    "model-input": {"role": "TRAIN"},  # role-typed feed into training
    "one-hot-encoder": {"columns": ["cat"]},
    "ordinal-encoder": {"columns": ["cat"]},
    "pca": {"columns": ["x"], "n_components": 1},
    "python-expression": {"expression": "x + 1", "output_column": "y"},
    "quantization": {"column": "x", "bins": 3},
    "quasi-constant-filter": {"threshold": 0.95},
    "remove-duplicate-rows": {"subset": ["cat"]},
    "remove-outliers": {"columns": ["x"], "method": "iqr"},
    "rename-columns": {"mapping": {"x": "value"}},
    "sample-data": {"fraction": 0.5},
    "select-columns": {"columns": ["cat", "x"]},
    "sort-data": {"by": ["x"], "ascending": False},
    "split-data": {"split_size": 0.7},
    "statistical-filter": {"target": "x", "threshold": 0.1},
    "target-encoder": {"columns": ["cat"], "target": "x"},
    "transform-data": {"function": "log", "columns": ["x"]},
    "union": {},
    "variance-filter": {"threshold": 0.0},
    "wide-to-long-converter": {"id_vars": ["cat"]},
    "zscore-normalization": {"columns": ["x"]},
}


def test_every_data_prep_operator_has_an_authoring_param_case():
    names = [c.name for c in seed_components() if c.component_type == DATA_PREP]
    missing = [n for n in names if n not in _PARAMS]
    assert missing == [], f"operators with no authoring param case in this test: {missing}"


def test_authored_params_validate_for_every_operator():
    comps = {c.name: c for c in seed_components()}
    bad: list[tuple[str, list]] = []
    for name, params in _PARAMS.items():
        comp = comps[name]
        min_in = comp.definition["min_inputs"]
        # A minimal, arity-correct DAG: N reads → the operator → (single output only).
        nodes = [{"alias": f"r{i}", "component": "read-from-warehouse",
                  "parameters": {"dataset": "wr:t:dataset:dataset/d"},
                  "outputs": [{"name": "out", "type": "dataframe"}]}
                 for i in range(max(1, min_in))]
        outs = comp.definition.get("outputs") or [{"name": "out", "type": "dataframe"}]
        nodes.append({"alias": "op", "component": name, "parameters": params,
                      "outputs": outs})
        edges = [{"from": f"r{i}.out", "to": f"op.in{i}", "type": "dataframe"}
                 for i in range(max(1, min_in))]
        report = validate_definition(
            {"nodes": nodes, "edges": edges}, pipeline_type=PipelineType.data_prep,
            model_type=None, components=comps, quota_ceiling=_CEIL, mode="all")
        # Only care about PARAM problems on the operator node (arity/edge shape of this
        # synthetic DAG is not the point).
        param_errs = [it for it in report.items
                      if it.get("alias") == "op"
                      and it.get("code") in ("UNKNOWN_PARAM", "MISSING_PARAM",
                                             "PARAM_INVALID", "NOT_IN_ENUM")]
        if param_errs:
            bad.append((name, param_errs))
    assert bad == [], f"operators whose authored params failed validation: {bad}"


def test_group_by_pipeline_now_authors_and_runs():
    # The exact case that previously failed UNKNOWN_PARAM at authoring: group-by with
    # by + aggregations. It now validates AND the executor runs it.
    comps = {c.name: c for c in seed_components()}
    definition = {
        "nodes": [
            {"alias": "r", "component": "read-from-warehouse",
             "parameters": {"dataset": "wr:t:dataset:dataset/d"},
             "outputs": [{"name": "out", "type": "dataframe"}]},
            {"alias": "g", "component": "group-by",
             "parameters": {"by": ["cat"], "aggregations": {"x": "sum"}},
             "outputs": [{"name": "out", "type": "dataframe"}]}],
        "edges": [{"from": "r.out", "to": "g.in1", "type": "dataframe"}]}
    report = validate_definition(definition, pipeline_type=PipelineType.data_prep,
                                 model_type=None, components=comps, quota_ceiling=_CEIL,
                                 mode="all")
    gb_param_errs = [it for it in report.items
                     if it.get("alias") == "g" and "PARAM" in it.get("code", "")]
    assert gb_param_errs == []
    # And it executes.
    df = pd.DataFrame({"cat": ["a", "b", "a"], "x": [1.0, 2.0, 3.0]})
    out = run_operator("group-by", [df], {"by": ["cat"], "aggregations": {"x": "sum"}})[0]
    assert out.loc[out["cat"] == "a", "x"].iloc[0] == 4.0


def test_operators_and_params_stay_in_sync():
    # Guard: every operator with a declared schema is a real registered operator.
    from app.domain.catalog import _OVERRIDES
    for name in _OVERRIDES:
        if name in OPERATORS or name in ("split-data",):
            continue
        # IO / non-operator override keys are allowed; data-prep ones must exist.
        assert name not in _PARAMS or name in OPERATORS, name
