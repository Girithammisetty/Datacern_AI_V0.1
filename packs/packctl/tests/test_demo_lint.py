"""Unit tests for `packctl demo-lint` (BRD 70 §2.8, AC-6), mirroring
test_lint.py's clean-fixture / violating-fixture-pair pattern per finding
code."""

from __future__ import annotations

from pathlib import Path

from packctl.demo_lint import lint_demo_bundle

DEMO_YAML = """\
demo_manifest: 1
pack: lint-fixture-pack
pack_version: 1.0.0
version: 1.0.0
provenance: __PROVENANCE__
"""

TARGET_PACK_DATASETS_YAML = """\
- identity: exceptions
  name: exceptions
  required_columns: [id, amount, status]
"""


def _write(root: Path, files: dict[str, str]) -> Path:
    root.mkdir(parents=True, exist_ok=True)
    for rel, body in files.items():
        p = root / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(body)
    return root


def _target_pack(tmp_path: Path) -> Path:
    """A minimal product pack under packs/<name>/ so the bundle's dataset
    contract has something real to validate against."""
    packs_root = tmp_path / "packs"
    (packs_root / "lint-fixture-pack" / "data").mkdir(parents=True)
    (packs_root / "lint-fixture-pack" / "data" / "datasets.yaml").write_text(TARGET_PACK_DATASETS_YAML)
    return packs_root


def _clean_bundle(tmp_path: Path) -> Path:
    bundle = _write(tmp_path / "deploy" / "demo" / "lint-fixture-pack", {
        "demo.yaml": DEMO_YAML.replace("__PROVENANCE__", "synthetic, no real PII"),
        "personas.yaml": "- {email_local_part: admin, role: Admin, display_name: Demo Admin}\n",
        "cases.yaml": "- {dataset: exceptions, row_pk: EX-1, severity: high, "
                      "display_projection: {amount: '100'}, note: evidence}\n",
        "data/exceptions.csv": "id,amount,status\nEX-1,100,open\nEX-2,50,closed\n",
    })
    return bundle


def test_clean_bundle_has_no_findings(tmp_path):
    _target_pack(tmp_path)
    bundle = _clean_bundle(tmp_path)
    report = lint_demo_bundle(bundle, packs_root=tmp_path / "packs")
    assert report.ok and report.pack == "lint-fixture-pack"
    assert report.findings == []


def test_missing_provenance_is_error(tmp_path):
    _target_pack(tmp_path)
    bundle = _write(tmp_path / "deploy" / "demo" / "lint-fixture-pack", {
        "demo.yaml": DEMO_YAML.replace("provenance: __PROVENANCE__\n", ""),
        "personas.yaml": "[]\n",
        "data/exceptions.csv": "id,amount,status\nEX-1,100,open\n",
    })
    report = lint_demo_bundle(bundle, packs_root=tmp_path / "packs")
    assert not report.ok
    assert any(f.code == "VALIDATION_FAILED" for f in report.errors)


def test_contract_violation_missing_column_is_error(tmp_path):
    _target_pack(tmp_path)
    bundle = _write(tmp_path / "deploy" / "demo" / "lint-fixture-pack", {
        "demo.yaml": DEMO_YAML.replace("__PROVENANCE__", "synthetic"),
        "personas.yaml": "[]\n",
        # missing the required 'status' column
        "data/exceptions.csv": "id,amount\nEX-1,100\n",
    })
    report = lint_demo_bundle(bundle, packs_root=tmp_path / "packs")
    assert not report.ok
    viol = next((f for f in report.errors if f.code == "CONTRACT_VIOLATION"), None)
    assert viol is not None and "status" in viol.message


def test_dataset_not_in_target_pack_is_error(tmp_path):
    _target_pack(tmp_path)
    bundle = _write(tmp_path / "deploy" / "demo" / "lint-fixture-pack", {
        "demo.yaml": DEMO_YAML.replace("__PROVENANCE__", "synthetic"),
        "personas.yaml": "[]\n",
        "data/unknown_dataset.csv": "id\n1\n",
    })
    report = lint_demo_bundle(bundle, packs_root=tmp_path / "packs")
    assert not report.ok
    assert any(f.code == "DATASET_NOT_IN_PACK" for f in report.errors)


def test_case_row_pk_unresolved_is_error(tmp_path):
    _target_pack(tmp_path)
    bundle = _write(tmp_path / "deploy" / "demo" / "lint-fixture-pack", {
        "demo.yaml": DEMO_YAML.replace("__PROVENANCE__", "synthetic"),
        "personas.yaml": "[]\n",
        "cases.yaml": "- {dataset: exceptions, row_pk: NOT-A-ROW, severity: high}\n",
        "data/exceptions.csv": "id,amount,status\nEX-1,100,open\n",
    })
    report = lint_demo_bundle(bundle, packs_root=tmp_path / "packs")
    assert not report.ok
    ref = next((f for f in report.errors if f.code == "CASE_ROW_PK_UNRESOLVED"), None)
    assert ref is not None and "NOT-A-ROW" in ref.message


def test_case_dataset_ref_unresolved_is_error(tmp_path):
    _target_pack(tmp_path)
    bundle = _write(tmp_path / "deploy" / "demo" / "lint-fixture-pack", {
        "demo.yaml": DEMO_YAML.replace("__PROVENANCE__", "synthetic"),
        "personas.yaml": "[]\n",
        "cases.yaml": "- {dataset: NOT_DECLARED, row_pk: EX-1, severity: high}\n",
        "data/exceptions.csv": "id,amount,status\nEX-1,100,open\n",
    })
    report = lint_demo_bundle(bundle, packs_root=tmp_path / "packs")
    assert not report.ok
    assert any(f.code == "DATASET_REF_UNRESOLVED" for f in report.errors)


def test_ssn_shaped_value_is_pii_error(tmp_path):
    _target_pack(tmp_path)
    bundle = _write(tmp_path / "deploy" / "demo" / "lint-fixture-pack", {
        "demo.yaml": DEMO_YAML.replace("__PROVENANCE__", "synthetic"),
        "personas.yaml": "[]\n",
        "data/exceptions.csv": "id,amount,status\n123-45-6789,100,open\n",
    })
    report = lint_demo_bundle(bundle, packs_root=tmp_path / "packs")
    assert not report.ok
    assert any(f.code == "PII_SUSPECTED" and "SSN" in f.message for f in report.errors)


def test_credit_card_shaped_value_is_pii_error(tmp_path):
    _target_pack(tmp_path)
    bundle = _write(tmp_path / "deploy" / "demo" / "lint-fixture-pack", {
        "demo.yaml": DEMO_YAML.replace("__PROVENANCE__", "synthetic"),
        "personas.yaml": "[]\n",
        "data/exceptions.csv": "id,amount,status\nEX-1,4111 1111 1111 1111,open\n",
    })
    report = lint_demo_bundle(bundle, packs_root=tmp_path / "packs")
    assert not report.ok
    assert any(f.code == "PII_SUSPECTED" and "credit-card" in f.message for f in report.errors)


def test_non_fictional_email_domain_is_pii_error(tmp_path):
    _target_pack(tmp_path)
    bundle = _write(tmp_path / "deploy" / "demo" / "lint-fixture-pack", {
        "demo.yaml": DEMO_YAML.replace("__PROVENANCE__", "synthetic"),
        "personas.yaml": "[]\n",
        "data/exceptions.csv": "id,amount,status\nEX-1,100,open\n",
        "data/wontmatch.txt": "unused",
    })
    # inject a non-fictional email into a real dataset row instead
    (bundle / "data" / "exceptions.csv").write_text(
        "id,amount,status\nreal.person@gmail.com,100,open\n")
    report = lint_demo_bundle(bundle, packs_root=tmp_path / "packs")
    assert not report.ok
    assert any(f.code == "PII_SUSPECTED" and "email" in f.message for f in report.errors)


def test_fictional_email_domain_is_allowed(tmp_path):
    _target_pack(tmp_path)
    bundle = _write(tmp_path / "deploy" / "demo" / "lint-fixture-pack", {
        "demo.yaml": DEMO_YAML.replace("__PROVENANCE__", "synthetic"),
        "personas.yaml": "[]\n",
        "data/exceptions.csv": "id,amount,status\nse@acme.example,100,open\n",
    })
    report = lint_demo_bundle(bundle, packs_root=tmp_path / "packs")
    assert report.ok


def test_missing_bundle_manifest_yields_one_error_finding(tmp_path):
    _target_pack(tmp_path)
    bundle = tmp_path / "deploy" / "demo" / "lint-fixture-pack"
    bundle.mkdir(parents=True)
    report = lint_demo_bundle(bundle, packs_root=tmp_path / "packs")
    assert not report.ok and len(report.errors) == 1


def test_target_pack_unresolved_is_error(tmp_path):
    # No packs/lint-fixture-pack/ at all under packs_root.
    (tmp_path / "packs").mkdir()
    bundle = _write(tmp_path / "deploy" / "demo" / "lint-fixture-pack", {
        "demo.yaml": DEMO_YAML.replace("__PROVENANCE__", "synthetic"),
        "personas.yaml": "[]\n",
        "data/exceptions.csv": "id,amount,status\nEX-1,100,open\n",
    })
    report = lint_demo_bundle(bundle, packs_root=tmp_path / "packs")
    assert not report.ok
    assert any(f.code == "TARGET_PACK_UNRESOLVED" for f in report.errors)


def test_default_packs_root_resolves_from_bundle_dir_layout(tmp_path):
    """No explicit packs_root: <bundle_dir>/../../../packs is the real
    deploy/demo/<pack> -> repo-root -> packs/ layout this initiative ships."""
    packs_root = tmp_path / "packs"
    (packs_root / "lint-fixture-pack" / "data").mkdir(parents=True)
    (packs_root / "lint-fixture-pack" / "data" / "datasets.yaml").write_text(TARGET_PACK_DATASETS_YAML)
    bundle = _write(tmp_path / "deploy" / "demo" / "lint-fixture-pack", {
        "demo.yaml": DEMO_YAML.replace("__PROVENANCE__", "synthetic"),
        "personas.yaml": "[]\n",
        "data/exceptions.csv": "id,amount,status\nEX-1,100,open\n",
    })
    report = lint_demo_bundle(bundle)  # packs_root omitted
    assert report.ok
