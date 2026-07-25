"""`packctl demo-lint` (BRD 70 §2.8, DSP-FR-011/DSP-NFR-004, AC-6).

Two check families over a `deploy/demo/<pack>/` bundle, BOTH blocking
(`error`, not `warning`) -- deliberately stricter than the product-pack
lint's advisory-only `SEED_DATA_SHIPPED`/`NO_BINDING_CONTRACT` (lint.py),
because a demo bundle's entire purpose is shipping seed data and its two
failure modes (a CSV that doesn't satisfy the target pack's contract, or a
real-PII-shaped cell) must never silently ship:

1. Contract validation: every CSV under data/ satisfies the required_columns
   the TARGET PACK declares in packs/<pack>/data/datasets.yaml (reusing the
   same missing-columns comparison packctl.client.bind_dataset already runs
   against a live dataset, just offline against a CSV header); every
   cases.yaml row_pk resolves to an actual row in its dataset's CSV.
2. PII deny-list: pattern-based scan (SSN-shaped, credit-card-shaped digit
   runs, email-shaped strings outside the bundle's declared fictional
   domain) over every CSV cell.
"""
from __future__ import annotations

import csv
import re
from dataclasses import dataclass, field
from pathlib import Path

import yaml

from .demo_manifest import DemoManifestError, DemoBundle, load_demo_bundle

SSN_RE = re.compile(r"\b\d{3}-\d{2}-\d{4}\b")
# Credit-card-shaped: 13-19 digits, optionally grouped by spaces/hyphens in
# runs of 4 (the common human-readable card format) or fully contiguous.
CC_RE = re.compile(r"\b(?:\d[ -]?){12,18}\d\b")
EMAIL_RE = re.compile(r"[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})")
# Domains a bundle author may use for fictional personas/contacts without
# tripping the deny-list (the same "realistic but invented" convention
# PACK_AUTHORING_GUIDE.md already asks for).
ALLOWED_EMAIL_DOMAIN_SUFFIXES = (".example", ".test", ".invalid", "example.com", "datacern.ai")


@dataclass(slots=True)
class Finding:
    code: str
    severity: str  # "error" | "warning"
    file: str
    pointer: str
    message: str

    def as_dict(self) -> dict:
        return {"code": self.code, "severity": self.severity, "file": self.file,
                "pointer": self.pointer, "message": self.message}


@dataclass(slots=True)
class DemoLintReport:
    pack: str | None
    version: str | None
    findings: list[Finding] = field(default_factory=list)

    @property
    def errors(self) -> list[Finding]:
        return [f for f in self.findings if f.severity == "error"]

    @property
    def warnings(self) -> list[Finding]:
        return [f for f in self.findings if f.severity == "warning"]

    @property
    def ok(self) -> bool:
        return not self.errors

    def as_dict(self) -> dict:
        return {"pack": self.pack, "version": self.version, "ok": self.ok,
                "errors": len(self.errors), "warnings": len(self.warnings),
                "findings": [f.as_dict() for f in self.findings]}


def _target_pack_required_columns(packs_root: Path, pack: str) -> dict[str, list[str]] | None:
    """{dataset identity -> required_columns} from the TARGET product pack's
    data/datasets.yaml (no-dummy-data binding-contract shape, see
    packs/PACK_AUTHORING_GUIDE.md). None if the target pack/file can't be
    found -- callers surface that as its own finding, not a crash."""
    ds_path = packs_root / pack / "data" / "datasets.yaml"
    if not ds_path.is_file():
        return None
    try:
        doc = yaml.safe_load(ds_path.read_text()) or []
    except yaml.YAMLError:
        return None
    out: dict[str, list[str]] = {}
    for entry in doc if isinstance(doc, list) else []:
        if isinstance(entry, dict) and entry.get("identity"):
            out[str(entry["identity"])] = [str(c) for c in (entry.get("required_columns") or [])]
    return out


def _read_csv_header_and_pk_values(csv_path: Path, pk_column: str | None) -> tuple[list[str], set[str]]:
    with csv_path.open(newline="") as f:
        reader = csv.DictReader(f)
        header = reader.fieldnames or []
        pk_values: set[str] = set()
        if pk_column and pk_column in header:
            for row in reader:
                v = row.get(pk_column)
                if v:
                    pk_values.add(v)
        return header, pk_values


def lint_demo_bundle(bundle_dir: str | Path, packs_root: str | Path | None = None) -> DemoLintReport:
    """Lint one `deploy/demo/<pack>/` bundle directory. `packs_root` defaults
    to `<bundle_dir>/../../../packs` (the deploy/demo/<pack> -> repo-root ->
    packs/ layout this initiative ships); pass it explicitly in tests so the
    check is independent of cwd/repo layout."""
    bundle_dir = Path(bundle_dir)
    report = DemoLintReport(pack=None, version=None)

    try:
        bundle: DemoBundle = load_demo_bundle(bundle_dir)
    except DemoManifestError as exc:
        report.findings.append(Finding(exc.code, "error", "demo.yaml", exc.json_pointer, exc.message))
        return report
    report.pack, report.version = bundle.pack, bundle.version

    root = Path(packs_root) if packs_root is not None else bundle_dir.parent.parent.parent / "packs"
    required = _target_pack_required_columns(root, bundle.pack)
    if required is None:
        report.findings.append(Finding(
            "TARGET_PACK_UNRESOLVED", "error", "demo.yaml", "/pack",
            f"target pack {bundle.pack!r} (pack_version {bundle.pack_version}) has no "
            f"readable data/datasets.yaml under {root} -- cannot validate dataset contracts"))
        return report

    # ---- check family 1a: dataset contract validation --------------------
    dataset_ids = {d.identity for d in bundle.datasets}
    pk_values_by_dataset: dict[str, set[str]] = {}
    for d in bundle.datasets:
        req_cols = required.get(d.identity)
        if req_cols is None:
            report.findings.append(Finding(
                "DATASET_NOT_IN_PACK", "error", f"data/{d.csv_path.name}", "/",
                f"dataset identity {d.identity!r} is not declared in the target pack's "
                f"data/datasets.yaml (declared: {sorted(required) or 'none'})"))
            continue
        try:
            header, pk_values = _read_csv_header_and_pk_values(
                d.csv_path, req_cols[0] if req_cols else None)
        except (OSError, csv.Error) as exc:
            report.findings.append(Finding(
                "CSV_UNREADABLE", "error", f"data/{d.csv_path.name}", "/", str(exc)))
            continue
        pk_values_by_dataset[d.identity] = pk_values
        missing = [c for c in req_cols if c not in header]
        if missing:
            report.findings.append(Finding(
                "CONTRACT_VIOLATION", "error", f"data/{d.csv_path.name}", "/",
                f"missing required column(s) declared by {bundle.pack}/data/datasets.yaml: "
                f"{', '.join(missing)}"))

    # ---- check family 1b: cases.yaml row_pk resolves ----------------------
    for i, c in enumerate(bundle.cases):
        if c.dataset not in dataset_ids:
            report.findings.append(Finding(
                "DATASET_REF_UNRESOLVED", "error", "cases.yaml", f"/{i}/dataset",
                f"references dataset {c.dataset!r}, which this bundle does not ship "
                f"(shipped: {sorted(dataset_ids) or 'none'})"))
            continue
        pk_values = pk_values_by_dataset.get(c.dataset)
        if pk_values is not None and c.row_pk not in pk_values:
            report.findings.append(Finding(
                "CASE_ROW_PK_UNRESOLVED", "error", "cases.yaml", f"/{i}/row_pk",
                f"row_pk {c.row_pk!r} does not match any row in data/{c.dataset}.csv"))

    # ---- check family 2: PII deny-list (DSP-NFR-004) ----------------------
    for d in bundle.datasets:
        _scan_csv_for_pii(d.csv_path, report)

    return report


def _scan_csv_for_pii(csv_path: Path, report: DemoLintReport) -> None:
    try:
        with csv_path.open(newline="") as f:
            reader = csv.DictReader(f)
            for row_num, row in enumerate(reader, start=2):  # header is row 1
                for col, val in row.items():
                    if not val:
                        continue
                    _scan_cell(str(val), f"data/{csv_path.name}", row_num, col, report)
    except (OSError, csv.Error):
        return  # already reported as CSV_UNREADABLE by the contract pass


def _scan_cell(val: str, file: str, row_num: int, col: str, report: DemoLintReport) -> None:
    if SSN_RE.search(val):
        report.findings.append(Finding(
            "PII_SUSPECTED", "error", file, f"/row{row_num}/{col}",
            "value matches an SSN-shaped pattern (###-##-####)"))
    m = EMAIL_RE.search(val)
    if m:
        domain = m.group(1).lower()
        if not any(domain.endswith(suffix) for suffix in ALLOWED_EMAIL_DOMAIN_SUFFIXES):
            report.findings.append(Finding(
                "PII_SUSPECTED", "error", file, f"/row{row_num}/{col}",
                f"email-shaped value with a non-fictional domain ({domain!r}); use "
                f"one of {ALLOWED_EMAIL_DOMAIN_SUFFIXES}"))
    # Credit-card check: only meaningful on columns that are not themselves a
    # legitimate long numeric identifier (NPI, phone, zip+4, etc. all match
    # \d{9,}); require it to look like a grouped/spaced card number OR an
    # unbroken 15-16 digit run to keep the false-positive rate sane against
    # domain identifiers like provider_npi (10 digits, below the 13 floor).
    digits_only = re.sub(r"[ -]", "", val)
    if digits_only.isdigit() and 13 <= len(digits_only) <= 19 and CC_RE.fullmatch(val.strip()):
        report.findings.append(Finding(
            "PII_SUSPECTED", "error", file, f"/row{row_num}/{col}",
            "value matches a credit-card-shaped digit run (13-19 digits)"))
