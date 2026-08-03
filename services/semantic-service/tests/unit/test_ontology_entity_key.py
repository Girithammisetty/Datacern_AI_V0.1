"""Knowledge Spine WS2 — link a semantic Entity to its governed ontology type.

A semantic entity binds to a dataset_urn but historically never to a domain
ontology type (gap #2 of the initiative). ``ontology_entity_key`` is the
optional canonical join key (dataset-service OntologyEntity.entity_key): its
restricted shape is enforced at authoring, it round-trips through the stored
definition, and its absence stays valid — no existing model changes meaning.
"""

from __future__ import annotations

import copy

import pytest

from app.domain.definition import parse_definition
from app.domain.errors import ValidationFailed
from tests.conftest import SALES_DEFINITION, TENANT_A, WORKSPACE, auth, create_model

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


# ---- slice 2: existence validation at submit (against the registry) ---------


def _linked_definition(key: str = "order") -> dict:
    d = copy.deepcopy(SALES_DEFINITION)
    d["entities"][0]["ontology_entity_key"] = key
    return d


async def _submit(client, model_id: str):
    return await client.post(
        f"/api/v1/models/{model_id}/versions/1/submit",
        headers=auth(TENANT_A, sub="author-1"))


@pytest.mark.asyncio
async def test_submit_passes_when_the_type_is_declared(client, container):
    container.dataset_client.register_ontology_type(TENANT_A, WORKSPACE, "order")
    model = await create_model(client, definition=_linked_definition("order"))
    resp = await _submit(client, model["id"])
    assert resp.status_code == 200, resp.text


@pytest.mark.asyncio
async def test_submit_fails_on_a_definitively_undeclared_type(client):
    model = await create_model(client, definition=_linked_definition("odrer"))  # typo'd
    resp = await _submit(client, model["id"])
    assert resp.status_code == 422
    problems = resp.json()["error"]["details"]
    assert any("'odrer'" in p["problem"] and "not declared" in p["problem"]
               for p in problems), problems


@pytest.mark.asyncio
async def test_registry_outage_fails_soft_and_never_blocks_authoring(client, container):
    container.dataset_client.simulate_ontology_outage()
    model = await create_model(client, definition=_linked_definition("order"))
    # The registry can't be checked -> the optional link is skipped, not fatal.
    resp = await _submit(client, model["id"])
    assert resp.status_code == 200, resp.text


# ---- WS2 remainder: explicit ontology-attribute -> dataset-column map --------


def _mapped_definition(key: str = "order", attr_map: dict | None = None) -> dict:
    d = _linked_definition(key)
    d["entities"][0]["ontology_attribute_map"] = (
        attr_map if attr_map is not None else {"order_ref": "order_id"})
    return d


def test_attribute_map_parses_and_round_trips():
    doc = _doc({"ontology_entity_key": "vendor",
                "ontology_attribute_map": {"vendor_ref": "id"}})
    defn = parse_definition(doc)
    assert defn.entities["vendors"].ontology_attribute_map == {"vendor_ref": "id"}
    assert defn.raw["entities"][0]["ontology_attribute_map"] == {"vendor_ref": "id"}


def test_attribute_map_requires_the_type_and_a_sane_shape():
    with pytest.raises(ValidationFailed):
        # A map without a declared type is meaningless.
        parse_definition(_doc({"ontology_attribute_map": {"a": "b"}}))
    with pytest.raises(ValidationFailed):
        parse_definition(_doc({"ontology_entity_key": "vendor",
                               "ontology_attribute_map": {"a": 42}}))


@pytest.mark.asyncio
async def test_submit_passes_with_a_valid_attribute_map(client, container):
    container.dataset_client.register_ontology_type(
        TENANT_A, WORKSPACE, "order", attributes=["order_ref", "amount"])
    model = await create_model(
        client, definition=_mapped_definition("order", {"order_ref": "order_id",
                                                        "amount": "order_total"}))
    resp = await _submit(client, model["id"])
    assert resp.status_code == 200, resp.text


@pytest.mark.asyncio
async def test_submit_fails_on_an_attribute_the_type_does_not_declare(client, container):
    container.dataset_client.register_ontology_type(
        TENANT_A, WORKSPACE, "order", attributes=["order_ref"])
    model = await create_model(
        client, definition=_mapped_definition("order", {"shoe_size": "order_id"}))
    resp = await _submit(client, model["id"])
    assert resp.status_code == 422
    problems = resp.json()["error"]["details"]
    assert any("'shoe_size'" in p["problem"] and "not declared on" in p["problem"]
               for p in problems), problems


@pytest.mark.asyncio
async def test_mapped_column_is_checked_even_when_the_registry_is_down(client, container):
    # Column existence comes from the bound dataset schema, NOT the registry —
    # it stays definitive during an outage (the attribute check is skipped).
    container.dataset_client.simulate_ontology_outage()
    model = await create_model(
        client, definition=_mapped_definition("order", {"order_ref": "no_such_col"}))
    resp = await _submit(client, model["id"])
    assert resp.status_code == 422
    problems = resp.json()["error"]["details"]
    assert any("'no_such_col'" in p["problem"] and "not in dataset schema" in p["problem"]
               for p in problems), problems
