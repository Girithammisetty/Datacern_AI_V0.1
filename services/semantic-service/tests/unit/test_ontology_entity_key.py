"""Knowledge Spine WS2 — link a semantic Entity to its governed ontology type.

A semantic entity binds to a dataset_urn but historically never to a domain
ontology type (gap #2 of the initiative). ``ontology_entity_key`` is the
optional canonical join key (dataset-service OntologyEntity.entity_key): its
restricted shape is enforced at authoring, it round-trips through the stored
definition, and its absence stays valid — no existing model changes meaning.
"""

from __future__ import annotations

import pytest

from app.domain.definition import parse_definition
from app.domain.errors import ValidationFailed

_URN = "wr:t42:dataset:dataset/018f0000-0000-7000-8000-0000000000ff"


def _doc(entity_extra: dict | None = None) -> dict:
    entity = {
        "name": "vendors", "dataset_urn": _URN, "table": "bronze.t42.ds_vendors",
        "primary_key": ["id"], "dataset_version_policy": {"policy": "latest"},
        **(entity_extra or {}),
    }
    return {
        "entities": [entity],
        "dimensions": [],
        "measures": [{"name": "vendor_count", "entity": "vendors", "agg": "count"}],
        "join_paths": [],
    }


def test_ontology_entity_key_parses_and_round_trips():
    defn = parse_definition(_doc({"ontology_entity_key": "vendor"}))
    assert defn.entities["vendors"].ontology_entity_key == "vendor"
    # The raw definition (what persists) still carries the key verbatim.
    assert defn.raw["entities"][0]["ontology_entity_key"] == "vendor"


def test_absent_key_stays_valid_and_none():
    defn = parse_definition(_doc())
    assert defn.entities["vendors"].ontology_entity_key is None


def test_malformed_key_rejected_at_authoring():
    # Same restricted shape as names — a typo'd/uppercase key fails at save,
    # not silently at some later join.
    with pytest.raises(ValidationFailed):
        parse_definition(_doc({"ontology_entity_key": "Vendor Corp!"}))
    with pytest.raises(ValidationFailed):
        parse_definition(_doc({"ontology_entity_key": 42}))
