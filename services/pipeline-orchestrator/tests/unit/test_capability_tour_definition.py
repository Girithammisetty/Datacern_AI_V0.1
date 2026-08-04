"""The `make up` capability-tour pipeline must validate against the real catalog.

deploy/local/seed_capability_tour.py authors a training template into the shared
demo workspace. For four rounds it authored one that could not validate, because
its nodes were written from what a pipeline node plausibly ought to look like
(id/type/config, "dataset_source"/"transform"/"train") rather than from
app/domain/catalog.py. Nothing caught it: the seed's own create call returns 201
for an invalid definition and only the *version* is marked `draft`, so the tour
printed a success line while leaving a template the UI refuses to run — which
then failed e2e:live's pipeline spec on three consecutive commits.

This test closes that loop offline. It reads the definition out of the shipping
script (so a copy here cannot drift from what actually runs) and puts it through
the same validate_definition the service uses.
"""

from __future__ import annotations

import ast
from pathlib import Path

from app.domain.catalog import seed_components
from app.domain.dag import validate_definition
from app.domain.enums import PipelineType

# parents: [0] unit, [1] tests, [2] pipeline-orchestrator, [3] services, [4] repo
# root. There is deliberately no skipif on this path: the seed is committed in
# this repo, so a path that does not resolve is a broken test, and a skipped test
# renders green — which is the exact failure mode this file exists to prevent.
_TOUR = (Path(__file__).resolve().parents[4]
         / "deploy" / "local" / "seed_capability_tour.py")

# The seed passes a real dataset URN in at runtime; any well-formed one exercises
# the same dataset_ref check.
_URN = "wr:tenant-a:dataset:dataset/00000000-0000-0000-0000-000000000001"


def _tour_definition() -> dict:
    """Extract the `body["definition"]` literal from seed_pipeline_template."""
    tree = ast.parse(_TOUR.read_text())
    fn = next(n for n in ast.walk(tree)
              if isinstance(n, ast.FunctionDef) and n.name == "seed_pipeline_template")
    body = next(n for n in ast.walk(fn)
                if isinstance(n, ast.Assign)
                and getattr(n.targets[0], "id", "") == "body")
    for key, value in zip(body.value.keys, body.value.values, strict=True):
        if getattr(key, "value", None) == "definition":
            # `dataset_urn` is a runtime name, not a constant — substitute it so the
            # literal can be evaluated without importing the seed (which would pull
            # in the whole e2e driver).
            return ast.literal_eval(
                ast.unparse(value).replace("dataset_urn", repr(_URN)))
    raise AssertionError("seed_pipeline_template no longer builds body['definition']")


def test_capability_tour_pipeline_validates() -> None:
    definition = _tour_definition()
    components = {c.name: c for c in seed_components()}

    report = validate_definition(
        definition,
        pipeline_type=PipelineType.training,
        model_type="anomaly_detection",
        components=components,
        quota_ceiling={"cpu": 64, "memory_gb": 256},
        mode="all",
    )

    assert report.valid, (
        "the capability-tour pipeline would be created as a draft the UI cannot "
        f"run: {report.items}")


def test_capability_tour_uses_only_catalog_components() -> None:
    """Named separately from validity so a bad component name says so directly,
    rather than surfacing as one COMPONENT_NOT_AVAILABLE among a pile of
    cascading arity and edge-type errors."""
    definition = _tour_definition()
    known = {c.name for c in seed_components()}
    used = {n.get("component") for n in definition["nodes"]}
    assert used <= known, f"not in the component catalog: {sorted(used - known)}"
