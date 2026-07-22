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
