"""Demo-bundle manifest loading (BRD 70 §2.2/§2.8).

A demo bundle (`deploy/demo/<pack>/`) is a DIFFERENT shape from a product
pack: `demo.yaml` instead of `pack.yaml`, no `components:`/`deferred:`
envelope, and it legitimately ships seed data (`data/*.csv`) -- the entire
opposite of the no-dummy-data rule `manifest.py`/`lint.py` enforce for
product packs. This module is intentionally NOT `manifest.py` with a
different filename: reusing `load_manifest`'s `SUPPORTED_KINDS`-shaped
assumptions here would blur the "packs ship zero seed data" boundary this
whole initiative exists to keep structurally intact (see
docs/initiatives/demo-sandbox-poc-mode.md §2.2).
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path

import yaml

NAME_RE = re.compile(r"^[a-z][a-z0-9-]{2,63}$")
SEMVER_RE = re.compile(r"^\d+\.\d+\.\d+$")


@dataclass(slots=True)
class DemoManifestError(Exception):
    code: str
    json_pointer: str
    message: str

    def __str__(self) -> str:  # pragma: no cover - repr convenience
        return f"{self.code} at {self.json_pointer}: {self.message}"


@dataclass(slots=True)
class DemoPersona:
    email_local_part: str
    role: str
    display_name: str


@dataclass(slots=True)
class DemoCase:
    dataset: str
    row_pk: str
    severity: str
    display_projection: dict
    note: str


@dataclass(slots=True)
class DemoDataset:
    identity: str
    csv_path: Path


@dataclass(slots=True)
class DemoBundle:
    pack: str
    pack_version: str
    version: str
    provenance: str
    bundle_dir: Path
    datasets: list[DemoDataset] = field(default_factory=list)
    personas: list[DemoPersona] = field(default_factory=list)
    cases: list[DemoCase] = field(default_factory=list)


def _err(code: str, pointer: str, message: str) -> DemoManifestError:
    return DemoManifestError(code=code, json_pointer=pointer, message=message)


def _load_yaml(path: Path):
    try:
        return yaml.safe_load(path.read_text())
    except yaml.YAMLError as exc:
        raise _err("COMPONENT_UNPARSEABLE", f"/{path.name}", f"YAML parse error: {exc}") from exc
    except FileNotFoundError:
        return None


def load_demo_bundle(bundle_dir: str | Path) -> DemoBundle:
    """Load + validate `<bundle_dir>/demo.yaml` + personas.yaml + cases.yaml
    + data/*.csv. Raises DemoManifestError on the first structural problem
    (structured code + json pointer, mirroring manifest.load_manifest)."""
    bundle_dir = Path(bundle_dir)
    manifest_path = bundle_dir / "demo.yaml"
    if not manifest_path.is_file():
        raise _err("MANIFEST_MISSING", "/", f"{manifest_path} does not exist")
    doc = _load_yaml(manifest_path) or {}
    if not isinstance(doc, dict):
        raise _err("VALIDATION_FAILED", "/", "demo.yaml must be a mapping")

    if doc.get("demo_manifest") != 1:
        raise _err("VALIDATION_FAILED", "/demo_manifest", "demo_manifest must be 1")
    pack = doc.get("pack") or ""
    if not NAME_RE.match(pack):
        raise _err("VALIDATION_FAILED", "/pack", f"pack {pack!r} must match {NAME_RE.pattern}")
    pack_version = str(doc.get("pack_version") or "")
    if not SEMVER_RE.match(pack_version):
        raise _err("VALIDATION_FAILED", "/pack_version", "pack_version must be strict semver")
    version = str(doc.get("version") or "")
    if not SEMVER_RE.match(version):
        raise _err("VALIDATION_FAILED", "/version", "version must be strict semver")
    provenance = str(doc.get("provenance") or "").strip()
    if not provenance:
        raise _err("VALIDATION_FAILED", "/provenance",
                   "provenance (no-real-PII attestation, DSP-NFR-004) is required")

    personas: list[DemoPersona] = []
    personas_doc = _load_yaml(bundle_dir / "personas.yaml") or []
    if not isinstance(personas_doc, list):
        raise _err("WRONG_SHAPE", "/personas.yaml", "personas.yaml must be a list")
    for i, p in enumerate(personas_doc):
        if not isinstance(p, dict) or not p.get("email_local_part") or not p.get("role"):
            raise _err("MISSING_FIELD", f"/personas.yaml/{i}",
                       "each persona needs email_local_part + role")
        personas.append(DemoPersona(
            email_local_part=str(p["email_local_part"]), role=str(p["role"]),
            display_name=str(p.get("display_name") or p["email_local_part"])))

    cases: list[DemoCase] = []
    cases_path = bundle_dir / "cases.yaml"
    if cases_path.is_file():
        cases_doc = _load_yaml(cases_path) or []
        if not isinstance(cases_doc, list):
            raise _err("WRONG_SHAPE", "/cases.yaml", "cases.yaml must be a list")
        for i, c in enumerate(cases_doc):
            if not isinstance(c, dict) or not c.get("dataset") or not c.get("row_pk"):
                raise _err("MISSING_FIELD", f"/cases.yaml/{i}",
                           "each case needs dataset + row_pk")
            cases.append(DemoCase(
                dataset=str(c["dataset"]), row_pk=str(c["row_pk"]),
                severity=str(c.get("severity") or ""),
                display_projection=dict(c.get("display_projection") or {}),
                note=str(c.get("note") or "")))

    data_dir = bundle_dir / "data"
    datasets: list[DemoDataset] = []
    if data_dir.is_dir():
        for csv_path in sorted(data_dir.glob("*.csv")):
            datasets.append(DemoDataset(identity=csv_path.stem, csv_path=csv_path))
    if not datasets:
        raise _err("VALIDATION_FAILED", "/data", f"no data/*.csv datasets found under {data_dir}")

    return DemoBundle(
        pack=pack, pack_version=pack_version, version=version, provenance=provenance,
        bundle_dir=bundle_dir, datasets=datasets, personas=personas, cases=cases,
    )
