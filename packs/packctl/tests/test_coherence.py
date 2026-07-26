"""Unit tests for `packctl coherence` (C1-C11 + demo-bundle wiring),
mirroring test_lint.py/test_demo_lint.py's clean-fixture / one-violation-per-
test pattern per finding code."""

from __future__ import annotations

from pathlib import Path

from packctl.coherence import check_demo_bundle, check_fleet, check_pack

PACK_YAML = """\
pack_manifest: 1
name: coherence-fixture
version: 1.0.0
description: coherence checker test fixture
publisher: {id: test}
components:
__COMPONENTS__
"""

# One component of every kind the C1-C11 checks read, all internally
# consistent -- change exactly one cross-reference per test to trigger one
# finding.
COMPONENTS = """\
  datasets:
    - {file: data/ds.yaml, identity: ds}
  dispositions:
    - {file: disp.yaml, identity: disp}
  case_fields:
    - {file: fields.yaml, identity: fields}
  case_schemas:
    - {file: schemas.yaml, identity: schemas}
  decision_models:
    - {file: decisions.yaml, identity: decisions}
  agent_configs:
    - {file: configs.yaml, identity: configs}
  guardrails:
    - {file: guardrails.yaml, identity: guardrails}
  semantic_models:
    - {file: semantic/model.yaml, identity: model}
  dashboards:
    - {file: dashboards/dash.yaml, identity: dash}
  ontology:
    - {file: ontology/entities.yaml, identity: entities}
  saved_queries:
    - {file: queries/saved.yaml, identity: saved}
  verified_queries:
    - {file: queries/verified.yaml, identity: verified}
"""

DATASETS = "- {identity: ds_x, name: ds-x, required_columns: [colA, status]}\n"
DISPOSITIONS = ("- {code: codeA, label: A, category: true_positive}\n"
                 "- {code: codeB, label: B, category: other}\n")
CASE_FIELDS = "- {name: custom_field, data_type: string}\n"
CASE_SCHEMAS = ("- {schema_key: sk1, name: Schema, fields: "
                 "[{name: custom_field, data_type: string, label: Custom, required: false}]}\n")
DECISIONS = (
    "- identity: dt1\n"
    "  name: Table\n"
    "  rules:\n"
    "    - when:\n"
    "        - {column: colA, op: eq, value: x}\n"
    "      then: {disposition_code: codeA}\n"
    "  default_outcome: {disposition_code: codeA}\n"
)
AGENT_CONFIGS = (
    "- agent_key: triage\n"
    "  enabled: true\n"
    "  prompt_params: {disposition_hints: 'codeA | codeB (some note)'}\n"
)
GUARDRAILS = "- {agent_key: triage, budget: {max_tokens_per_session: 1000}}\n"
SEMANTIC_MODEL = """\
name: core_model
definition:
  entities:
    - {name: ent1, dataset: ds_x, table: main.ds_x, primary_key: [id]}
  join_paths: []
  dimensions:
    - {name: dimA, entity: ent1, type: categorical, column: colA}
  measures:
    - {name: measA, entity: ent1, agg: count}
    - {name: measDisp, entity: ent1, agg: count, filters: "disposition = 'codeA'"}
"""
DASHBOARD = """\
name: Dash
module: insights
semantic_model: core_model
charts:
  - name: Chart1
    chart_type: vertical_bar_chart
    config:
      x: {dimension: dimA}
      y: [{measure: measA, agg_fn: count}]
    sources: [{measure: measA}]
"""
ONTOLOGY = ("- {entity_key: ek1, name: E1, attributes: [], relationships: "
            "[{name: rel1, target: ek1, cardinality: has_many}]}\n")
SAVED_QUERIES = "- {identity: sq1, name: Saved, sql: \"SELECT * FROM {{dataset('ds-x')}}\"}\n"
VERIFIED_QUERIES = ("- {nl_text: Q, sql_text: \"SELECT * FROM {{dataset('ds-x')}} "
                     "WHERE disposition = 'codeA'\", model: core_model}\n")


def _clean_pack(root: Path) -> Path:
    root.mkdir(parents=True, exist_ok=True)
    (root / "pack.yaml").write_text(PACK_YAML.replace("__COMPONENTS__", COMPONENTS))
    files = {
        "data/ds.yaml": DATASETS,
        "disp.yaml": DISPOSITIONS,
        "fields.yaml": CASE_FIELDS,
        "schemas.yaml": CASE_SCHEMAS,
        "decisions.yaml": DECISIONS,
        "configs.yaml": AGENT_CONFIGS,
        "guardrails.yaml": GUARDRAILS,
        "semantic/model.yaml": SEMANTIC_MODEL,
        "dashboards/dash.yaml": DASHBOARD,
        "ontology/entities.yaml": ONTOLOGY,
        "queries/saved.yaml": SAVED_QUERIES,
        "queries/verified.yaml": VERIFIED_QUERIES,
    }
    for rel, body in files.items():
        p = root / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(body)
    return root


def _break(root: Path, rel: str, body: str) -> None:
    (root / rel).write_text(body)


def test_clean_pack_has_no_findings(tmp_path):
    findings = check_pack(_clean_pack(tmp_path / "p"))
    assert findings == []


def test_c1_decision_column_unresolved(tmp_path):
    root = _clean_pack(tmp_path / "p")
    _break(root, "decisions.yaml", DECISIONS.replace("column: colA", "column: not_a_column"))
    findings = check_pack(root)
    assert any(f.code == "C1_DECISION_COLUMN_UNRESOLVED" for f in findings)


def test_c2_decision_disposition_unresolved(tmp_path):
    root = _clean_pack(tmp_path / "p")
    _break(root, "decisions.yaml", DECISIONS.replace(
        "then: {disposition_code: codeA}", "then: {disposition_code: not_a_code}"))
    findings = check_pack(root)
    assert any(f.code == "C2_DECISION_DISPOSITION_UNRESOLVED" for f in findings)


def test_c3_agent_hint_disposition_unresolved(tmp_path):
    root = _clean_pack(tmp_path / "p")
    _break(root, "configs.yaml", AGENT_CONFIGS.replace("codeA | codeB", "codeA | not_a_code"))
    findings = check_pack(root)
    assert any(f.code == "C3_AGENT_HINT_DISPOSITION_UNRESOLVED" for f in findings)


def test_c4_guardrail_agent_key_unresolved(tmp_path):
    root = _clean_pack(tmp_path / "p")
    _break(root, "guardrails.yaml", GUARDRAILS.replace("agent_key: triage", "agent_key: no_such_agent"))
    findings = check_pack(root)
    assert any(f.code == "C4_GUARDRAIL_AGENT_KEY_UNRESOLVED" for f in findings)


def test_c5_dataset_macro_unresolved(tmp_path):
    root = _clean_pack(tmp_path / "p")
    _break(root, "queries/saved.yaml", SAVED_QUERIES.replace("ds-x", "no-such-dataset"))
    findings = check_pack(root)
    assert any(f.code == "C5_DATASET_MACRO_UNRESOLVED" for f in findings)


def test_c6_dashboard_dimension_unresolved(tmp_path):
    root = _clean_pack(tmp_path / "p")
    _break(root, "dashboards/dash.yaml", DASHBOARD.replace("dimension: dimA", "dimension: not_a_dim"))
    findings = check_pack(root)
    assert any(f.code == "C6_DASHBOARD_DIMENSION_UNRESOLVED" for f in findings)


def test_c6_dashboard_measure_unresolved(tmp_path):
    root = _clean_pack(tmp_path / "p")
    _break(root, "dashboards/dash.yaml", DASHBOARD.replace(
        "sources: [{measure: measA}]", "sources: [{measure: not_a_measure}]"))
    findings = check_pack(root)
    assert any(f.code == "C6_DASHBOARD_MEASURE_UNRESOLVED" for f in findings)


def test_c6_dashboard_semantic_model_unresolved(tmp_path):
    root = _clean_pack(tmp_path / "p")
    _break(root, "dashboards/dash.yaml", DASHBOARD.replace(
        "semantic_model: core_model", "semantic_model: no_such_model"))
    findings = check_pack(root)
    assert any(f.code == "C6_DASHBOARD_SEMANTIC_MODEL_UNRESOLVED" for f in findings)


def test_c7_semantic_entity_ref_unresolved(tmp_path):
    root = _clean_pack(tmp_path / "p")
    _break(root, "semantic/model.yaml", SEMANTIC_MODEL.replace(
        "{name: dimA, entity: ent1,", "{name: dimA, entity: no_such_entity,"))
    findings = check_pack(root)
    assert any(f.code == "C7_SEMANTIC_ENTITY_REF_UNRESOLVED" for f in findings)


def test_c8_ontology_relationship_target_unresolved(tmp_path):
    root = _clean_pack(tmp_path / "p")
    _break(root, "ontology/entities.yaml", ONTOLOGY.replace("target: ek1", "target: no_such_entity"))
    findings = check_pack(root)
    assert any(f.code == "C8_ONTOLOGY_RELATIONSHIP_TARGET_UNRESOLVED" for f in findings)


def test_c9_case_schema_field_unresolved(tmp_path):
    root = _clean_pack(tmp_path / "p")
    _break(root, "schemas.yaml", CASE_SCHEMAS.replace("name: custom_field", "name: no_such_field"))
    findings = check_pack(root)
    assert any(f.code == "C9_CASE_SCHEMA_FIELD_UNRESOLVED" for f in findings)


def test_c10_verified_query_model_unresolved(tmp_path):
    root = _clean_pack(tmp_path / "p")
    _break(root, "queries/verified.yaml", VERIFIED_QUERIES.replace(
        "model: core_model", "model: no_such_model"))
    findings = check_pack(root)
    assert any(f.code == "C10_VERIFIED_QUERY_MODEL_UNRESOLVED" for f in findings)


def test_c11_disposition_literal_unresolved_in_semantic_filter(tmp_path):
    root = _clean_pack(tmp_path / "p")
    _break(root, "semantic/model.yaml", SEMANTIC_MODEL.replace(
        "filters: \"disposition = 'codeA'\"", "filters: \"disposition = 'not_a_code'\""))
    findings = check_pack(root)
    assert any(f.code == "C11_DISPOSITION_LITERAL_UNRESOLVED" for f in findings)


def test_c11_disposition_literal_unresolved_in_query_sql(tmp_path):
    root = _clean_pack(tmp_path / "p")
    _break(root, "queries/verified.yaml", VERIFIED_QUERIES.replace(
        "disposition = 'codeA'", "disposition = 'not_a_code'"))
    findings = check_pack(root)
    assert any(f.code == "C11_DISPOSITION_LITERAL_UNRESOLVED" for f in findings)


def test_c11_vocabulary_fork_exception_skips_pharmacovigilance(tmp_path):
    # Same broken literal as the previous test, but under the pack name
    # pack-fleet-depth-audit.md documents as an intentional SoR-vocabulary
    # fork (pharmacovigilance) -- C11 must not flag it.
    root = tmp_path / "pharmacovigilance"
    _clean_pack(root)
    (root / "pack.yaml").write_text(
        (root / "pack.yaml").read_text().replace("name: coherence-fixture", "name: pharmacovigilance"))
    _break(root, "queries/verified.yaml", VERIFIED_QUERIES.replace(
        "disposition = 'codeA'", "disposition = 'not_a_code'"))
    findings = check_pack(root)
    assert not any(f.code == "C11_DISPOSITION_LITERAL_UNRESOLVED" for f in findings)


def test_invalid_manifest_yields_one_finding(tmp_path):
    root = tmp_path / "p"
    root.mkdir()
    (root / "pack.yaml").write_text("pack_manifest: 1\nname: BadName\nversion: nope\n")
    findings = check_pack(root)
    assert len(findings) == 1 and findings[0].code == "MANIFEST_INVALID"


def test_check_fleet_aggregates_packs_and_bundles(tmp_path):
    packs_root = tmp_path / "packs"
    _clean_pack(packs_root / "coherence-fixture")
    demo_root = tmp_path / "deploy" / "demo"
    bundle = demo_root / "coherence-fixture"
    bundle.mkdir(parents=True)
    (bundle / "demo.yaml").write_text(
        "demo_manifest: 1\npack: coherence-fixture\npack_version: 1.0.0\n"
        "version: 1.0.0\nprovenance: synthetic\n")
    (bundle / "personas.yaml").write_text("[]\n")
    (bundle / "data").mkdir()
    (bundle / "data" / "ds_x.csv").write_text("colA,status\nv,open\n")

    report = check_fleet(packs_root, demo_root)
    assert report.packs_checked == 1
    assert report.bundles_checked == 1
    assert report.ok


def test_demo_bundle_pack_version_drift_is_error(tmp_path):
    packs_root = tmp_path / "packs"
    _clean_pack(packs_root / "coherence-fixture")
    bundle = tmp_path / "deploy" / "demo" / "coherence-fixture"
    bundle.mkdir(parents=True)
    (bundle / "demo.yaml").write_text(
        "demo_manifest: 1\npack: coherence-fixture\npack_version: 0.9.0\n"
        "version: 1.0.0\nprovenance: synthetic\n")
    (bundle / "personas.yaml").write_text("[]\n")
    (bundle / "data").mkdir()
    (bundle / "data" / "ds_x.csv").write_text("colA,status\nv,open\n")

    findings = check_demo_bundle(bundle, packs_root)
    assert any(f.code == "DEMO_PACK_VERSION_DRIFT" for f in findings)


def test_demo_bundle_target_pack_unresolved(tmp_path):
    demo_root = tmp_path / "deploy" / "demo"
    bundle = demo_root / "ghost-pack"
    bundle.mkdir(parents=True)
    (bundle / "demo.yaml").write_text(
        "demo_manifest: 1\npack: ghost-pack\npack_version: 1.0.0\n"
        "version: 1.0.0\nprovenance: synthetic\n")
    (bundle / "personas.yaml").write_text("[]\n")
    (bundle / "data").mkdir()
    (bundle / "data" / "x.csv").write_text("a\n1\n")

    findings = check_demo_bundle(bundle, tmp_path / "packs")
    assert any(f.code == "DEMO_TARGET_PACK_UNRESOLVED" for f in findings)
