"""OWL/JSON-LD export projection of the governed ontology (Knowledge Spine WS4).

The initiative's explicit non-goal is an RDF re-platform: the governed JSONB
registry stays the source of truth, and the standard is adopted as an EXPORT
PROJECTION only — one read-only document an external tool (Protégé, an RDF
store, a partner's graph) can consume without DataCern adopting its stack.

Mapping (only real registry facts are projected — nothing is invented):

- workspace ontology  -> ``owl:Ontology`` (IRI ``urn:datacern:ontology:<ws>``)
- entity type         -> ``owl:Class`` with ``rdfs:label``/``rdfs:comment`` and
  the live published version as ``owl:versionInfo`` (WS3's version, not a guess)
- attribute           -> ``owl:DatatypeProperty`` with ``rdfs:domain``; an
  ``rdfs:range`` is emitted only when ``data_type`` maps cleanly onto an XSD
  datatype — an unknown type gets NO range rather than a fabricated one
- relationship        -> ``owl:ObjectProperty`` with domain + range; has_one /
  belongs_to additionally type it ``owl:FunctionalProperty`` (at most one).
  A range naming a type the workspace never declared is still emitted (RDF is
  open-world) but carries an honest ``rdfs:comment`` saying so
- required / enum     -> a SHACL ``sh:NodeShape`` per constrained type
  (``sh:minCount 1`` / ``sh:in``) — the same contract the WS4 checker enforces
  against real rows, in the standard vocabulary for it
"""

from __future__ import annotations

from urllib.parse import quote

CONTEXT = {
    "owl": "http://www.w3.org/2002/07/owl#",
    "rdfs": "http://www.w3.org/2000/01/rdf-schema#",
    "xsd": "http://www.w3.org/2001/XMLSchema#",
    "sh": "http://www.w3.org/ns/shacl#",
}

# data_type -> XSD datatype, for the values that map CLEANLY. Anything else is
# projected without a range — omitting a fact beats inventing one.
XSD_BY_DATA_TYPE = {
    "string": "xsd:string",
    "text": "xsd:string",
    "int": "xsd:integer",
    "integer": "xsd:integer",
    "number": "xsd:decimal",
    "float": "xsd:decimal",
    "decimal": "xsd:decimal",
    "bool": "xsd:boolean",
    "boolean": "xsd:boolean",
    "date": "xsd:date",
    "datetime": "xsd:dateTime",
    "timestamp": "xsd:dateTime",
}

#: Cardinalities that mean "at most one" — projected as owl:FunctionalProperty.
FUNCTIONAL_CARDINALITIES = ("has_one", "belongs_to")


def _seg(value: str) -> str:
    """IRI path segment — registry keys are already slug-ish, but an IRI must
    never break on a surprising character."""
    return quote(str(value), safe="")


def ontology_iri(workspace_id: str) -> str:
    return f"urn:datacern:ontology:{_seg(workspace_id)}"


def class_iri(workspace_id: str, entity_key: str) -> str:
    return f"{ontology_iri(workspace_id)}:type:{_seg(entity_key)}"


def ontology_to_jsonld(workspace_id: str, entities: list) -> dict:
    """Project the workspace's ontology entities (domain ``OntologyEntity``
    rows) into one self-contained OWL + SHACL document in JSON-LD."""
    graph: list[dict] = [{
        "@id": ontology_iri(workspace_id),
        "@type": "owl:Ontology",
        "rdfs:label": f"DataCern governed ontology — workspace {workspace_id}",
        "rdfs:comment": (
            "Export projection for external interop. The governed registry "
            "inside DataCern is the source of truth; re-import is not supported."
        ),
    }]

    declared = {e.entity_key for e in entities}
    for e in sorted(entities, key=lambda x: x.entity_key):
        cls = class_iri(workspace_id, e.entity_key)
        node: dict = {
            "@id": cls,
            "@type": "owl:Class",
            "rdfs:isDefinedBy": {"@id": ontology_iri(workspace_id)},
            "rdfs:label": e.name,
            "owl:versionInfo": f"v{e.version_no}",
        }
        if e.description:
            node["rdfs:comment"] = e.description
        graph.append(node)

        constrained: list[dict] = []
        for a in e.attributes or []:
            name = str(a.get("name") or "")
            if not name:
                continue
            attr_iri = f"{cls}:attr:{_seg(name)}"
            prop: dict = {
                "@id": attr_iri,
                "@type": "owl:DatatypeProperty",
                "rdfs:label": name,
                "rdfs:domain": {"@id": cls},
            }
            xsd = XSD_BY_DATA_TYPE.get(str(a.get("data_type") or "").lower())
            if xsd:
                prop["rdfs:range"] = {"@id": xsd}
            graph.append(prop)

            constraint: dict = {"sh:path": {"@id": attr_iri}}
            if a.get("required"):
                constraint["sh:minCount"] = 1
            enum = a.get("enum") or []
            if enum:
                constraint["sh:in"] = {"@list": [str(v) for v in enum]}
            if len(constraint) > 1:
                constrained.append(constraint)

        for r in e.relationships or []:
            name = str(r.get("name") or "")
            target = str(r.get("target") or "")
            if not name or not target:
                continue
            rel: dict = {
                "@id": f"{cls}:rel:{_seg(name)}",
                "@type": (
                    ["owl:ObjectProperty", "owl:FunctionalProperty"]
                    if r.get("cardinality") in FUNCTIONAL_CARDINALITIES
                    else "owl:ObjectProperty"
                ),
                "rdfs:label": name,
                "rdfs:domain": {"@id": cls},
                "rdfs:range": {"@id": class_iri(workspace_id, target)},
            }
            if target not in declared:
                rel["rdfs:comment"] = (
                    f"target type '{target}' is not declared in this workspace"
                )
            graph.append(rel)

        if constrained:
            graph.append({
                "@id": f"{cls}:shape",
                "@type": "sh:NodeShape",
                "sh:targetClass": {"@id": cls},
                "sh:property": constrained,
            })

    return {"@context": CONTEXT, "@graph": graph}
