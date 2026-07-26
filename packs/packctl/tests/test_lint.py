"""Unit tests for the pack-authoring linter (packctl.lint)."""

from __future__ import annotations

from pathlib import Path

from packctl.lint import lint_pack

PACK_YAML = """\
pack_manifest: 1
name: lint-fixture
version: 1.0.0
description: linter test fixture
publisher: {id: test}
components:
__COMPONENTS__
"""


def _write(root: Path, components: str, files: dict[str, str]) -> Path:
    root.mkdir(parents=True, exist_ok=True)
    (root / "pack.yaml").write_text(PACK_YAML.replace("__COMPONENTS__", components))
    for rel, body in files.items():
        p = root / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(body)
    return root


def _clean_pack(root: Path) -> Path:
    """A minimal, correct PRODUCT pack (no-dummy-data rule): the dataset is a
    file-less binding CONTRACT (required_columns declared), plus a case queue
    that references it."""
    return _write(
        root,
        "  datasets:\n    - {file: data/ds.yaml, identity: ds}\n"
        "  dispositions:\n    - {file: disp.yaml, identity: disp}\n"
        "  cases:\n    - {file: queue.yaml, identity: queue}\n",
        {
            "data/ds.yaml": "- {identity: exceptions, name: exceptions, "
                            "required_columns: [id]}\n",
            "disp.yaml": "- {code: fraud, label: Fraud, category: true_positive}\n",
            "queue.yaml": "dataset: exceptions\nrows:\n  - {row_pk: EX-1}\n",
        },
    )


def test_clean_pack_has_no_findings(tmp_path):
    report = lint_pack(_clean_pack(tmp_path / "p"))
    assert report.ok and report.pack == "lint-fixture"
    assert report.findings == []


def test_shipped_seed_data_warns(tmp_path):
    # No-dummy-data rule: a dataset entry with a seed `file` lints as a
    # SEED_DATA_SHIPPED warning (legal for legacy/demo packs, flagged for
    # product packs); it is NOT an error.
    root = _write(
        tmp_path / "p",
        "  datasets:\n    - {file: data/ds.yaml, identity: ds}\n",
        {"data/ds.yaml": "- {identity: exceptions, name: exceptions, file: rows.csv}\n",
         "rows.csv": "id\n1\n"},
    )
    report = lint_pack(root)
    assert report.ok  # warning only
    assert any(f.code == "SEED_DATA_SHIPPED" for f in report.warnings)


def test_fileless_dataset_without_required_columns_warns(tmp_path):
    root = _write(
        tmp_path / "p",
        "  datasets:\n    - {file: data/ds.yaml, identity: ds}\n",
        {"data/ds.yaml": "- {identity: exceptions, name: exceptions}\n"},
    )
    report = lint_pack(root)
    assert report.ok  # warning only
    assert any(f.code == "NO_BINDING_CONTRACT" for f in report.warnings)


def test_missing_required_field_is_error(tmp_path):
    root = _write(
        tmp_path / "p",
        "  dispositions:\n    - {file: disp.yaml, identity: disp}\n",
        {"disp.yaml": "- {code: fraud, label: Fraud}\n"},  # no category
    )
    report = lint_pack(root)
    assert not report.ok
    codes = {(f.code, f.kind) for f in report.errors}
    assert ("MISSING_FIELD", "dispositions") in codes
    assert any("category" in f.pointer for f in report.errors)


def test_duplicate_name_within_kind_is_error(tmp_path):
    root = _write(
        tmp_path / "p",
        "  dispositions:\n    - {file: disp.yaml, identity: disp}\n",
        {"disp.yaml": "- {code: dup, label: A, category: benign}\n"
                      "- {code: dup, label: B, category: benign}\n"},
    )
    report = lint_pack(root)
    assert any(f.code == "DUPLICATE_NAME" for f in report.errors)


def test_unresolved_dataset_reference_is_error(tmp_path):
    root = _write(
        tmp_path / "p",
        "  datasets:\n    - {file: ds.yaml, identity: ds}\n"
        "  cases:\n    - {file: queue.yaml, identity: queue}\n",
        {
            "ds.yaml": "- {identity: exceptions, name: exceptions, file: rows.csv}\n",
            "rows.csv": "id\n1\n",
            "queue.yaml": "dataset: NOT_DECLARED\nrows:\n  - {row_pk: EX-1}\n",
        },
    )
    report = lint_pack(root)
    ref = next((f for f in report.errors if f.code == "DATASET_REF_UNRESOLVED"), None)
    assert ref is not None and "NOT_DECLARED" in ref.message


def test_unknown_category_is_warning_not_error(tmp_path):
    root = _write(
        tmp_path / "p",
        "  dispositions:\n    - {file: disp.yaml, identity: disp}\n",
        {"disp.yaml": "- {code: x, label: X, category: made_up}\n"},
    )
    report = lint_pack(root)
    assert report.ok  # a bad enum is advisory (Core is the authority)
    assert any(f.code == "UNKNOWN_CATEGORY" for f in report.warnings)


def test_invalid_manifest_yields_one_error_finding(tmp_path):
    root = tmp_path / "p"
    root.mkdir()
    (root / "pack.yaml").write_text("pack_manifest: 1\nname: BadName\nversion: nope\n")
    report = lint_pack(root)
    assert not report.ok and len(report.errors) == 1  # surfaced, not crashed


# ---------------------------------------------------------------------------
# control_mappings (A6: regulatory control mappings as a product output).
# A mapping is a mapping AID, never a compliance claim (PACK_AUTHORING_GUIDE.md
# "Control mappings") — the linter's job is to make sure a pack can't ship an
# unsubstantiated or malformed one, not to verify the evidence is accurate
# (that's a human judgment made at authoring time).
# ---------------------------------------------------------------------------

_VALID_MAPPING_ENTRY = """\
    - framework: eu_ai_act
      control_id: art_14
      control_title: "Article 14 — Human oversight"
      platform_control: "Distinct-approver four-eyes gate rejects self-approval."
      evidence:
        - "services/agent-runtime/app/proposals/service.py:_check_eligibility"
      status: implemented
"""


def _pack_with_control_mappings(root: Path, block: str) -> Path:
    root.mkdir(parents=True, exist_ok=True)
    (root / "pack.yaml").write_text(
        "pack_manifest: 1\n"
        "name: cm-fixture\n"
        "version: 1.0.0\n"
        "description: control-mappings lint fixture\n"
        "publisher: {id: test}\n"
        f"{block}"
        "components: {}\n"
    )
    return root


def test_no_control_mappings_is_legal(tmp_path):
    # Absent control_mappings is fine — most packs don't have any yet.
    report = lint_pack(_pack_with_control_mappings(tmp_path / "p", ""))
    assert report.ok
    assert not any(f.kind == "control_mappings" for f in report.findings)


def test_valid_control_mapping_has_no_findings(tmp_path):
    block = (
        "control_mappings:\n"
        "  disclaimer: \"Mapping aid only, not a certification.\"\n"
        "  mappings:\n" + _VALID_MAPPING_ENTRY
    )
    report = lint_pack(_pack_with_control_mappings(tmp_path / "p", block))
    assert report.ok
    assert not any(f.kind == "control_mappings" for f in report.findings)


def test_missing_disclaimer_is_error(tmp_path):
    block = "control_mappings:\n  mappings:\n" + _VALID_MAPPING_ENTRY
    report = lint_pack(_pack_with_control_mappings(tmp_path / "p", block))
    assert not report.ok
    assert any(f.code == "CONTROL_MAPPINGS_MISSING_DISCLAIMER" for f in report.errors)


def test_blank_disclaimer_is_error(tmp_path):
    block = (
        "control_mappings:\n"
        "  disclaimer: \"   \"\n"
        "  mappings:\n" + _VALID_MAPPING_ENTRY
    )
    report = lint_pack(_pack_with_control_mappings(tmp_path / "p", block))
    assert not report.ok
    assert any(f.code == "CONTROL_MAPPINGS_MISSING_DISCLAIMER" for f in report.errors)


def test_unknown_framework_is_error(tmp_path):
    block = (
        "control_mappings:\n"
        "  disclaimer: \"Mapping aid only.\"\n"
        "  mappings:\n"
        "    - framework: made_up_framework\n"
        "      control_id: xyz\n"
        "      control_title: \"Something\"\n"
        "      platform_control: \"Some control.\"\n"
        "      evidence: [\"services/somewhere.py\"]\n"
    )
    report = lint_pack(_pack_with_control_mappings(tmp_path / "p", block))
    assert not report.ok
    assert any(f.code == "UNKNOWN_FRAMEWORK" for f in report.errors)


def test_mapping_with_no_evidence_fails_lint(tmp_path):
    # This is THE core honesty check: a mapping that cites nothing must fail.
    block = (
        "control_mappings:\n"
        "  disclaimer: \"Mapping aid only.\"\n"
        "  mappings:\n"
        "    - framework: eu_ai_act\n"
        "      control_id: art_14\n"
        "      control_title: \"Article 14 — Human oversight\"\n"
        "      platform_control: \"Some control.\"\n"
        "      evidence: []\n"
    )
    report = lint_pack(_pack_with_control_mappings(tmp_path / "p", block))
    assert not report.ok
    assert any(f.code == "EMPTY_EVIDENCE" for f in report.errors)


def test_mapping_missing_evidence_key_fails_lint(tmp_path):
    block = (
        "control_mappings:\n"
        "  disclaimer: \"Mapping aid only.\"\n"
        "  mappings:\n"
        "    - framework: eu_ai_act\n"
        "      control_id: art_14\n"
        "      control_title: \"Article 14 — Human oversight\"\n"
        "      platform_control: \"Some control.\"\n"
    )
    report = lint_pack(_pack_with_control_mappings(tmp_path / "p", block))
    assert not report.ok
    assert any(f.code == "EMPTY_EVIDENCE" for f in report.errors)


def test_missing_required_subfield_is_error(tmp_path):
    block = (
        "control_mappings:\n"
        "  disclaimer: \"Mapping aid only.\"\n"
        "  mappings:\n"
        "    - framework: eu_ai_act\n"
        "      control_id: art_14\n"
        "      evidence: [\"services/somewhere.py\"]\n"
    )
    report = lint_pack(_pack_with_control_mappings(tmp_path / "p", block))
    assert not report.ok
    codes = {(f.code, f.pointer.rsplit('/', 1)[-1]) for f in report.errors}
    assert ("MISSING_FIELD", "control_title") in codes
    assert ("MISSING_FIELD", "platform_control") in codes


def test_not_covered_status_allows_empty_evidence(tmp_path):
    block = (
        "control_mappings:\n"
        "  disclaimer: \"Mapping aid only.\"\n"
        "  mappings:\n"
        "    - framework: eu_ai_act\n"
        "      control_id: art_11_annex_iv\n"
        "      control_title: \"Article 11 / Annex IV — Technical documentation\"\n"
        "      platform_control: \"No technical-documentation kit exists yet; documented gap.\"\n"
        "      evidence: []\n"
        "      status: not_covered\n"
    )
    report = lint_pack(_pack_with_control_mappings(tmp_path / "p", block))
    assert report.ok
    assert not any(f.kind == "control_mappings" for f in report.findings)


def test_not_covered_status_with_evidence_is_error(tmp_path):
    # A not_covered entry must not smuggle in evidence — that would misrepresent
    # a documented gap as a covered control.
    block = (
        "control_mappings:\n"
        "  disclaimer: \"Mapping aid only.\"\n"
        "  mappings:\n"
        "    - framework: eu_ai_act\n"
        "      control_id: art_11_annex_iv\n"
        "      control_title: \"Article 11 / Annex IV — Technical documentation\"\n"
        "      platform_control: \"No technical-documentation kit exists yet.\"\n"
        "      evidence: [\"services/somewhere.py\"]\n"
        "      status: not_covered\n"
    )
    report = lint_pack(_pack_with_control_mappings(tmp_path / "p", block))
    assert not report.ok
    assert any(f.code == "NOT_COVERED_HAS_EVIDENCE" for f in report.errors)


def test_unknown_status_is_error(tmp_path):
    block = (
        "control_mappings:\n"
        "  disclaimer: \"Mapping aid only.\"\n"
        "  mappings:\n"
        "    - framework: eu_ai_act\n"
        "      control_id: art_14\n"
        "      control_title: \"Article 14 — Human oversight\"\n"
        "      platform_control: \"Some control.\"\n"
        "      evidence: [\"services/somewhere.py\"]\n"
        "      status: certified\n"
    )
    report = lint_pack(_pack_with_control_mappings(tmp_path / "p", block))
    assert not report.ok
    assert any(f.code == "UNKNOWN_STATUS" for f in report.errors)


def test_duplicate_framework_control_id_is_error(tmp_path):
    block = (
        "control_mappings:\n"
        "  disclaimer: \"Mapping aid only.\"\n"
        "  mappings:\n" + _VALID_MAPPING_ENTRY + _VALID_MAPPING_ENTRY
    )
    report = lint_pack(_pack_with_control_mappings(tmp_path / "p", block))
    assert not report.ok
    assert any(f.code == "DUPLICATE_CONTROL_MAPPING" for f in report.errors)


def test_control_mappings_wrong_shape_is_error(tmp_path):
    block = "control_mappings: [\"not\", \"a\", \"mapping\"]\n"
    report = lint_pack(_pack_with_control_mappings(tmp_path / "p", block))
    assert not report.ok
    assert any(f.code == "CONTROL_MAPPINGS_WRONG_SHAPE" for f in report.errors)
