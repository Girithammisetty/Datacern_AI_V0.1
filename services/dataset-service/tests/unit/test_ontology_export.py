"""Knowledge Spine WS4 — the OWL/JSON-LD export projection.

The governed JSONB registry stays the source of truth; the export is one
read-only OWL + SHACL document in JSON-LD for external tooling. Only real
registry facts are projected: an unknown ``data_type`` yields NO ``rdfs:range``
(never a fabricated one), a relationship to an undeclared type keeps its range
(RDF is open-world) but says so in a comment, and an empty workspace exports an
honestly empty graph.
"""

from __future__ import annotations

import pytest

from tests.conftest import WORKSPACE, auth

pytestmark = pytest.mark.asyncio

VENDOR = {
    "workspace_id": WORKSPACE, "entity_key": "vendor", "name": "Vendor",
    "description": "A supplier the organization pays.",
    "attributes": [
        {"name": "status", "data_type": "string", "required": True,
         "enum": ["active", "dormant"]},
        {"name": "risk_score", "data_type": "mystery"},  # unmappable type
    ],
    "relationships": [
        {"name": "invoices", "target": "invoice", "cardinality": "has_many"},
        {"name": "owner", "target": "person", "cardinality": "has_one"},  # dangling
    ],
}
INVOICE = {"workspace_id": WORKSPACE, "entity_key": "invoice", "name": "Invoice"}


async def _export(client):
    r = await client.get(
        "/api/v1/ontology/export",
        params={"filter[workspace_id]": WORKSPACE}, headers=auth())
    assert r.status_code == 200, r.text
    return r


def _by_id(doc):
    return {n["@id"]: n for n in doc["@graph"]}


async def test_export_projects_classes_properties_and_shapes(client):
    for body in (VENDOR, INVOICE):
        r = await client.post("/api/v1/ontology/entities", json=body, headers=auth())
        assert r.status_code == 201, r.text

    r = await _export(client)
    assert r.headers["content-type"].startswith("application/ld+json")
    doc = r.json()
    assert set(doc["@context"]) == {"owl", "rdfs", "xsd", "sh"}
    nodes = _by_id(doc)
    base = f"urn:datacern:ontology:{WORKSPACE}"

    # The ontology node names the projection honestly.
    assert nodes[base]["@type"] == "owl:Ontology"
    assert "source of truth" in nodes[base]["rdfs:comment"]

    # Classes carry the LIVE published version (WS3), label and description.
    vendor = nodes[f"{base}:type:vendor"]
    assert vendor["@type"] == "owl:Class"
    assert vendor["rdfs:label"] == "Vendor"
    assert vendor["rdfs:comment"] == "A supplier the organization pays."
    assert vendor["owl:versionInfo"] == "v1"

    # A clean data_type maps to XSD; an unknown one gets NO range at all.
    status = nodes[f"{base}:type:vendor:attr:status"]
    assert status["@type"] == "owl:DatatypeProperty"
    assert status["rdfs:domain"] == {"@id": f"{base}:type:vendor"}
    assert status["rdfs:range"] == {"@id": "xsd:string"}
    assert "rdfs:range" not in nodes[f"{base}:type:vendor:attr:risk_score"]

    # has_many -> plain ObjectProperty aimed at the declared target class.
    invoices = nodes[f"{base}:type:vendor:rel:invoices"]
    assert invoices["@type"] == "owl:ObjectProperty"
    assert invoices["rdfs:range"] == {"@id": f"{base}:type:invoice"}
    assert "rdfs:comment" not in invoices

    # has_one -> additionally functional; an undeclared target keeps its range
    # (open-world) but the projection says so instead of staying silent.
    owner = nodes[f"{base}:type:vendor:rel:owner"]
    assert owner["@type"] == ["owl:ObjectProperty", "owl:FunctionalProperty"]
    assert owner["rdfs:range"] == {"@id": f"{base}:type:person"}
    assert "not declared in this workspace" in owner["rdfs:comment"]

    # required/enum become one SHACL shape; the unconstrained attribute
    # contributes no property constraint.
    shape = nodes[f"{base}:type:vendor:shape"]
    assert shape["sh:targetClass"] == {"@id": f"{base}:type:vendor"}
    (constraint,) = shape["sh:property"]
    assert constraint["sh:path"] == {"@id": f"{base}:type:vendor:attr:status"}
    assert constraint["sh:minCount"] == 1
    assert constraint["sh:in"] == {"@list": ["active", "dormant"]}

    # Invoice has no constrained attributes -> no shape node for it.
    assert f"{base}:type:invoice:shape" not in nodes

    # Deterministic order: ontology node first, then classes sorted by key.
    class_ids = [n["@id"] for n in doc["@graph"] if n.get("@type") == "owl:Class"]
    assert class_ids == sorted(class_ids)


async def test_empty_workspace_exports_an_honestly_empty_graph(client):
    doc = (await _export(client)).json()
    assert len(doc["@graph"]) == 1  # just the ontology node — nothing invented
    assert doc["@graph"][0]["@type"] == "owl:Ontology"
