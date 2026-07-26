"""`packctl coherence` — fleet-wide structural coherence checks (C1-C11).

Genesis: `docs/initiatives/pack-fleet-depth-audit.md` documents a "coherence
checker (C1-C11)" that was run by hand during the 2026-07-23 pack fleet depth
audit ("Coherence checker (C1-C11 incl. disposition-literal<->catalog gate):
0 hard issues across 28 packs") — cross-file link checks `lint.py` does not
perform, because they read ACROSS a pack's component kinds (a decision
table's columns against its binding contracts, a dashboard's measures
against its semantic model, ...) rather than within one component file. That
checker was never committed, so nothing regression-guards the invariants it
verified. This module is the durable, CI-run replacement.

The audit doc names only C11 outright ("disposition literals in semantic
measure filters and query SQL <= the pack's own disposition catalog codes")
and describes six more checks in one prose sentence without numbering them:
"decision-table columns <= binding-contract columns U case fields;
decision/disposition_hints codes <= disposition catalog; guardrail
agent_keys <= agent configs; {{dataset()}} macros <= dataset names; semantic
entity refs / dashboard measures+dimensions <= semantic model; ontology
relationship targets <= entity keys". This module assigns C1-C10 to those
checks (splitting a couple of the prose's compound clauses so each check has
one clear failure mode) — see each `_cN_*` function's docstring for exactly
what it verifies and why that numbering was chosen. It is this module's own
best-effort reconstruction, not a recovered original.

Every check below is real and was validated against the actual fleet
(packs/*) while writing it: it currently reports zero findings, matching the
audit doc's "0 hard issues" claim. Coverage is 11 of 11 named/inferred
checks — no stubs.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path

import yaml

from .demo_manifest import DemoManifestError, load_demo_bundle
from .manifest import Manifest, ManifestError, load_component_file, load_manifest

DISPOSITION_LITERAL_RE = re.compile(r"\bdisposition\s*=\s*'([^']+)'")
DATASET_MACRO_RE = re.compile(r"\{\{\s*dataset\(\s*'([^']+)'\s*\)\s*\}\}")

# Packs with a DOCUMENTED, intentional fork between a raw dataset column
# literally named `disposition` (the source-of-record's own closure
# vocabulary) and the pack's case-catalog disposition codes -- see
# packs/pharmacovigilance/data/datasets.yaml's pv_cases `disposition` value
# domain comment ("deliberately DISTINCT from the case catalog's review-queue
# codes") and pack-fleet-depth-audit.md's C11 note that the gate "honors
# pharmacovigilance's documented SoR-vocabulary fork". C11 does not flag
# these packs' semantic/query `disposition` literal comparisons.
C11_VOCABULARY_FORK_EXCEPTIONS = {"pharmacovigilance"}


@dataclass(slots=True)
class Finding:
    code: str
    severity: str  # "error" | "warning" -- every check here is a real cross-
    # file break (dead KPI, rejected install proposal, silently-unenforced
    # guardrail), so every finding is an "error", mirroring demo_lint.py's
    # all-blocking stance rather than lint.py's error/warning split.
    pack: str
    file: str
    pointer: str
    message: str

    def as_dict(self) -> dict:
        return {"code": self.code, "severity": self.severity, "pack": self.pack,
                "file": self.file, "pointer": self.pointer, "message": self.message}


@dataclass(slots=True)
class CoherenceReport:
    findings: list[Finding] = field(default_factory=list)
    packs_checked: int = 0
    bundles_checked: int = 0

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
        return {"ok": self.ok, "packs_checked": self.packs_checked,
                "bundles_checked": self.bundles_checked,
                "errors": len(self.errors), "warnings": len(self.warnings),
                "findings": [f.as_dict() for f in self.findings]}


def _as_list(doc: object) -> list[dict]:
    if isinstance(doc, dict):
        return [doc]
    if isinstance(doc, list):
        return [e for e in doc if isinstance(e, dict)]
    return []


def _component_docs(manifest: Manifest, kind: str) -> list[tuple[str, object]]:
    """[(file, parsed_doc)] for every component of `kind` the pack declares.
    Unparseable files are skipped -- `packctl lint` already reports those as
    COMPONENT_UNPARSEABLE; coherence assumes a lint-clean pack."""
    out: list[tuple[str, object]] = []
    for comp in manifest.components_of(kind):
        try:
            out.append((comp.file, load_component_file(manifest, comp)))
        except yaml.YAMLError:
            continue
    return out


def _semantic_models(manifest: Manifest) -> dict[str, dict]:
    models: dict[str, dict] = {}
    for file, doc in _component_docs(manifest, "semantic_models"):
        if not isinstance(doc, dict) or not doc.get("name"):
            continue
        definition = doc.get("definition") or {}
        measures = [m for m in (definition.get("measures") or []) if isinstance(m, dict)]
        dimensions = [d for d in (definition.get("dimensions") or []) if isinstance(d, dict)]
        models[doc["name"]] = {
            "file": file,
            "entities": {e.get("name") for e in (definition.get("entities") or [])
                         if isinstance(e, dict)},
            "dimensions": {d.get("name") for d in dimensions},
            "measures": {m.get("name") for m in measures},
            "measure_entries": measures,
            "dimension_entries": dimensions,
            "join_paths": [j for j in (definition.get("join_paths") or []) if isinstance(j, dict)],
        }
    return models


def _disposition_codes(manifest: Manifest) -> set[str]:
    codes: set[str] = set()
    for _file, doc in _component_docs(manifest, "dispositions"):
        for entry in _as_list(doc):
            if entry.get("code"):
                codes.add(str(entry["code"]))
    return codes


def _c1_decision_columns(manifest: Manifest) -> list[Finding]:
    """C1: every column a decision-table rule reads (`when[].column`) must be
    either a binding-contract column one of the pack's datasets declares, or
    a typed case field the pack ships -- otherwise the rule can never match a
    real row at install (pack-fleet-depth-audit.md: "decision-table columns
    <= binding-contract columns U case fields")."""
    known: set[str] = set()
    for _file, doc in _component_docs(manifest, "datasets"):
        for entry in _as_list(doc):
            known.update(str(c) for c in (entry.get("required_columns") or []))
    for _file, doc in _component_docs(manifest, "case_fields"):
        for entry in _as_list(doc):
            if entry.get("name"):
                known.add(str(entry["name"]))

    findings: list[Finding] = []
    for file, doc in _component_docs(manifest, "decision_models"):
        for i, table in enumerate(_as_list(doc)):
            for j, rule in enumerate(table.get("rules") or []):
                if not isinstance(rule, dict):
                    continue
                for k, cond in enumerate(rule.get("when") or []):
                    col = cond.get("column") if isinstance(cond, dict) else None
                    if col and str(col) not in known:
                        findings.append(Finding(
                            "C1_DECISION_COLUMN_UNRESOLVED", "error", manifest.name, file,
                            f"/{i}/rules/{j}/when/{k}/column",
                            f"decision table {table.get('identity')!r} rule reads column {col!r}, "
                            f"which is not a binding-contract required_column or case field this "
                            f"pack declares -- the rule can never match a bound row"))
    return findings


def _c2_decision_dispositions(manifest: Manifest, disposition_codes: set[str]) -> list[Finding]:
    """C2: a decision table's `then.disposition_code` and `default_outcome.
    disposition_code` must be codes the pack's own disposition catalog
    declares -- otherwise the proposal case-service materializes at install
    references a disposition that doesn't exist and gets rejected."""
    findings: list[Finding] = []
    for file, doc in _component_docs(manifest, "decision_models"):
        for i, table in enumerate(_as_list(doc)):
            for j, rule in enumerate(table.get("rules") or []):
                if not isinstance(rule, dict):
                    continue
                code = (rule.get("then") or {}).get("disposition_code")
                if code and code not in disposition_codes:
                    findings.append(Finding(
                        "C2_DECISION_DISPOSITION_UNRESOLVED", "error", manifest.name, file,
                        f"/{i}/rules/{j}/then/disposition_code",
                        f"decision table {table.get('identity')!r} proposes disposition_code "
                        f"{code!r}, which this pack's disposition catalog does not declare"))
            default = table.get("default_outcome") or {}
            code = default.get("disposition_code")
            if code and code not in disposition_codes:
                findings.append(Finding(
                    "C2_DECISION_DISPOSITION_UNRESOLVED", "error", manifest.name, file,
                    f"/{i}/default_outcome/disposition_code",
                    f"decision table {table.get('identity')!r} default_outcome proposes "
                    f"{code!r}, which this pack's disposition catalog does not declare"))
    return findings


def _c3_agent_hint_dispositions(manifest: Manifest, disposition_codes: set[str]) -> list[Finding]:
    """C3: `agent_configs[].prompt_params.disposition_hints` (the pipe-
    separated list an agent's system prompt is told to propose from) must
    name only codes the pack's disposition catalog declares. Each segment may
    carry a human parenthetical, e.g. "recommend_sar (MLRO decides filing)"
    -- only the leading token before `(` is the code under test."""
    findings: list[Finding] = []
    for file, doc in _component_docs(manifest, "agent_configs"):
        for i, entry in enumerate(_as_list(doc)):
            hints = (entry.get("prompt_params") or {}).get("disposition_hints") or ""
            for part in hints.replace("\n", " ").split("|"):
                code = part.split("(")[0].strip()
                if code and code not in disposition_codes:
                    findings.append(Finding(
                        "C3_AGENT_HINT_DISPOSITION_UNRESOLVED", "error", manifest.name, file,
                        f"/{i}/prompt_params/disposition_hints",
                        f"agent_key {entry.get('agent_key')!r} hints disposition {code!r}, which "
                        f"this pack's disposition catalog does not declare"))
    return findings


def _c4_guardrail_agent_keys(manifest: Manifest) -> list[Finding]:
    """C4: a guardrail's `agent_key` must match an `agent_configs[].agent_key`
    the pack ships -- a guardrail for an agent_key the pack never configures
    is dead config: agent-runtime has no TenantAgentConfig row to attach the
    security envelope to."""
    configured: set[str] = set()
    for _file, doc in _component_docs(manifest, "agent_configs"):
        for entry in _as_list(doc):
            if entry.get("agent_key"):
                configured.add(str(entry["agent_key"]))

    findings: list[Finding] = []
    for file, doc in _component_docs(manifest, "guardrails"):
        for i, entry in enumerate(_as_list(doc)):
            key = entry.get("agent_key")
            if key and str(key) not in configured:
                findings.append(Finding(
                    "C4_GUARDRAIL_AGENT_KEY_UNRESOLVED", "error", manifest.name, file,
                    f"/{i}/agent_key",
                    f"guardrail targets agent_key {key!r}, which this pack's agent_configs does "
                    f"not declare -- the security envelope would never apply"))
    return findings


def _c5_dataset_macros(manifest: Manifest) -> list[Finding]:
    """C5: every `{{dataset('<name>')}}` macro in a saved/verified query's SQL
    must reference a dataset `name` (the kebab-case macro name, distinct from
    the snake_case `identity`) the pack actually declares in
    data/datasets.yaml -- query-service's tenant-namespace guard would refuse
    the macro at install/query time otherwise."""
    names: set[str] = set()
    for _file, doc in _component_docs(manifest, "datasets"):
        for entry in _as_list(doc):
            if entry.get("name"):
                names.add(str(entry["name"]))

    findings: list[Finding] = []
    for kind in ("saved_queries", "verified_queries"):
        for file, doc in _component_docs(manifest, kind):
            for i, entry in enumerate(_as_list(doc)):
                sql = entry.get("sql") or entry.get("sql_text") or ""
                for m in DATASET_MACRO_RE.finditer(sql):
                    ref = m.group(1)
                    if ref not in names:
                        findings.append(Finding(
                            "C5_DATASET_MACRO_UNRESOLVED", "error", manifest.name, file,
                            f"/{i}",
                            f"{{{{dataset('{ref}')}}}} does not match any dataset `name` this pack "
                            f"declares (declared: {sorted(names) or 'none'})"))
    return findings


def _c6_dashboard_refs(manifest: Manifest, models: dict[str, dict]) -> list[Finding]:
    """C6: a dashboard's `semantic_model` must resolve to a model the pack
    ships, and every chart's x-axis dimension / y-axis and `sources[]`
    measures must be names that model declares -- a mismatch here is a chart
    that renders empty (or 4xxs) at install, the F2-class defect the fleet
    depth audit found repeatedly."""
    findings: list[Finding] = []
    for comp in manifest.components_of("dashboards"):
        try:
            doc = load_component_file(manifest, comp)
        except yaml.YAMLError:
            continue
        if not isinstance(doc, dict):
            continue
        model_name = doc.get("semantic_model")
        model = models.get(model_name)
        if model is None:
            findings.append(Finding(
                "C6_DASHBOARD_SEMANTIC_MODEL_UNRESOLVED", "error", manifest.name, comp.file,
                "/semantic_model",
                f"dashboard declares semantic_model {model_name!r}, which this pack does not ship"))
            continue
        for ci, chart in enumerate(doc.get("charts") or []):
            if not isinstance(chart, dict):
                continue
            cfg = chart.get("config") or {}
            dim = (cfg.get("x") or {}).get("dimension")
            if dim and dim not in model["dimensions"]:
                findings.append(Finding(
                    "C6_DASHBOARD_DIMENSION_UNRESOLVED", "error", manifest.name, comp.file,
                    f"/charts/{ci}/config/x/dimension",
                    f"chart {chart.get('name')!r} plots dimension {dim!r}, which semantic model "
                    f"{model_name!r} does not declare"))
            for yi, y in enumerate(cfg.get("y") or []):
                measure = y.get("measure") if isinstance(y, dict) else None
                if measure and measure not in model["measures"]:
                    findings.append(Finding(
                        "C6_DASHBOARD_MEASURE_UNRESOLVED", "error", manifest.name, comp.file,
                        f"/charts/{ci}/config/y/{yi}/measure",
                        f"chart {chart.get('name')!r} plots measure {measure!r}, which semantic "
                        f"model {model_name!r} does not declare"))
            for si, s in enumerate(chart.get("sources") or []):
                measure = s.get("measure") if isinstance(s, dict) else None
                if measure and measure not in model["measures"]:
                    findings.append(Finding(
                        "C6_DASHBOARD_MEASURE_UNRESOLVED", "error", manifest.name, comp.file,
                        f"/charts/{ci}/sources/{si}/measure",
                        f"chart {chart.get('name')!r} sources measure {measure!r}, which semantic "
                        f"model {model_name!r} does not declare"))
    return findings


def _c7_semantic_entity_refs(manifest: Manifest, models: dict[str, dict]) -> list[Finding]:
    """C7: within one semantic model, every `join_paths[].from_entity`/
    `to_entity` and every measure's/dimension's `entity` must name an entity
    the same model declares -- an unresolved entity ref is a join or column
    lookup semantic-service can't compile."""
    findings: list[Finding] = []
    for name, model in models.items():
        entities = model["entities"]
        for jp in model["join_paths"]:
            for key in ("from_entity", "to_entity"):
                val = jp.get(key)
                if val and val not in entities:
                    findings.append(Finding(
                        "C7_SEMANTIC_ENTITY_REF_UNRESOLVED", "error", manifest.name, model["file"],
                        f"/definition/join_paths/{jp.get('name')}/{key}",
                        f"join_path {jp.get('name')!r} references entity {val!r}, which semantic "
                        f"model {name!r} does not declare"))
        for coll, label in ((model["measure_entries"], "measures"),
                            (model["dimension_entries"], "dimensions")):
            for e in coll:
                ent = e.get("entity")
                if ent and ent not in entities:
                    findings.append(Finding(
                        "C7_SEMANTIC_ENTITY_REF_UNRESOLVED", "error", manifest.name, model["file"],
                        f"/definition/{label}/{e.get('name')}/entity",
                        f"{label[:-1]} {e.get('name')!r} references entity {ent!r}, which semantic "
                        f"model {name!r} does not declare"))
    return findings


def _c8_ontology_relationship_targets(manifest: Manifest) -> list[Finding]:
    """C8: every ontology entity relationship's `target` must be an
    `entity_key` this pack's own ontology declares -- a dangling target
    describes a type-level edge to an entity that doesn't exist."""
    findings: list[Finding] = []
    for file, doc in _component_docs(manifest, "ontology"):
        entries = _as_list(doc)
        keys = {e.get("entity_key") for e in entries if e.get("entity_key")}
        for i, e in enumerate(entries):
            for j, rel in enumerate(e.get("relationships") or []):
                target = rel.get("target") if isinstance(rel, dict) else None
                if target and target not in keys:
                    findings.append(Finding(
                        "C8_ONTOLOGY_RELATIONSHIP_TARGET_UNRESOLVED", "error", manifest.name, file,
                        f"/{i}/relationships/{j}/target",
                        f"entity {e.get('entity_key')!r} relationship {rel.get('name')!r} targets "
                        f"{target!r}, which this pack's ontology does not declare as an entity_key"))
    return findings


def _c9_case_schema_fields(manifest: Manifest) -> list[Finding]:
    """C9: every field a `case_schemas[].fields[]` entry embeds must be a
    field name `case_fields` also declares for this pack -- authoring
    convention (see e.g. card-disputes/cases/schemas.yaml's header comment)
    is that the two are kept in sync by hand; nothing enforced it."""
    field_names: set[str] = set()
    for _file, doc in _component_docs(manifest, "case_fields"):
        for entry in _as_list(doc):
            if entry.get("name"):
                field_names.add(str(entry["name"]))

    findings: list[Finding] = []
    for file, doc in _component_docs(manifest, "case_schemas"):
        for i, schema in enumerate(_as_list(doc)):
            for j, fd in enumerate(schema.get("fields") or []):
                name = fd.get("name") if isinstance(fd, dict) else None
                if name and str(name) not in field_names:
                    findings.append(Finding(
                        "C9_CASE_SCHEMA_FIELD_UNRESOLVED", "error", manifest.name, file,
                        f"/{i}/fields/{j}/name",
                        f"case schema {schema.get('schema_key')!r} embeds field {name!r}, which "
                        f"this pack's case_fields does not declare -- the two will silently drift"))
    return findings


def _c10_verified_query_models(manifest: Manifest, models: dict[str, dict]) -> list[Finding]:
    """C10: a verified query's `model` must name a semantic model the pack
    ships -- it is the NL<->SQL pairing's governance anchor (the four-eyes
    approval is scoped to that model), so an unresolved model breaks the
    query's provenance even if the SQL itself is fine."""
    findings: list[Finding] = []
    for file, doc in _component_docs(manifest, "verified_queries"):
        for i, entry in enumerate(_as_list(doc)):
            model_name = entry.get("model")
            if model_name and model_name not in models:
                findings.append(Finding(
                    "C10_VERIFIED_QUERY_MODEL_UNRESOLVED", "error", manifest.name, file,
                    f"/{i}/model",
                    f"verified query {entry.get('nl_text')!r} declares model {model_name!r}, "
                    f"which this pack does not ship as a semantic model"))
    return findings


def _c11_disposition_literals(manifest: Manifest, disposition_codes: set[str]) -> list[Finding]:
    """C11 (named in pack-fleet-depth-audit.md): a `disposition = '<literal>'`
    comparison in a semantic measure's `filters` or in saved/verified query
    SQL must use one of the pack's own disposition catalog codes -- otherwise
    the measure/query reads zero forever (the F2 "disposition-vocabulary
    drift" defect class the depth audit fixed fleet-wide). Skips packs with a
    documented SoR-vocabulary fork (see C11_VOCABULARY_FORK_EXCEPTIONS)."""
    if manifest.name in C11_VOCABULARY_FORK_EXCEPTIONS:
        return []

    findings: list[Finding] = []
    for file, doc in _component_docs(manifest, "semantic_models"):
        if not isinstance(doc, dict):
            continue
        for m in (doc.get("definition") or {}).get("measures") or []:
            if not isinstance(m, dict):
                continue
            for lit in DISPOSITION_LITERAL_RE.findall(m.get("filters") or ""):
                if lit not in disposition_codes:
                    findings.append(Finding(
                        "C11_DISPOSITION_LITERAL_UNRESOLVED", "error", manifest.name, file,
                        f"/definition/measures/{m.get('name')}/filters",
                        f"measure {m.get('name')!r} filters on disposition literal {lit!r}, which "
                        f"is not a code in this pack's disposition catalog -- the measure reads "
                        f"zero forever"))
    for kind in ("saved_queries", "verified_queries"):
        for file, doc in _component_docs(manifest, kind):
            for i, entry in enumerate(_as_list(doc)):
                sql = entry.get("sql") or entry.get("sql_text") or ""
                for lit in DISPOSITION_LITERAL_RE.findall(sql):
                    if lit not in disposition_codes:
                        findings.append(Finding(
                            "C11_DISPOSITION_LITERAL_UNRESOLVED", "error", manifest.name, file,
                            f"/{i}",
                            f"query SQL filters on disposition literal {lit!r}, which is not a "
                            f"code in this pack's disposition catalog"))
    return findings


def check_pack(pack_dir: str | Path) -> list[Finding]:
    """Run C1-C11 against one `packs/<pack>/` directory."""
    pack_dir = Path(pack_dir)
    try:
        manifest = load_manifest(pack_dir)
    except ManifestError as exc:
        return [Finding("MANIFEST_INVALID", "error", pack_dir.name, "pack.yaml",
                         exc.json_pointer, exc.message)]

    disposition_codes = _disposition_codes(manifest)
    models = _semantic_models(manifest)

    findings: list[Finding] = []
    findings += _c1_decision_columns(manifest)
    findings += _c2_decision_dispositions(manifest, disposition_codes)
    findings += _c3_agent_hint_dispositions(manifest, disposition_codes)
    findings += _c4_guardrail_agent_keys(manifest)
    findings += _c5_dataset_macros(manifest)
    findings += _c6_dashboard_refs(manifest, models)
    findings += _c7_semantic_entity_refs(manifest, models)
    findings += _c8_ontology_relationship_targets(manifest)
    findings += _c9_case_schema_fields(manifest)
    findings += _c10_verified_query_models(manifest, models)
    findings += _c11_disposition_literals(manifest, disposition_codes)
    return findings


def check_demo_bundle(bundle_dir: str | Path, packs_root: str | Path | None = None) -> list[Finding]:
    """Cross-repo wiring check for one `deploy/demo/<pack>/` bundle: it pins
    `pack` + `pack_version` so it stays reproducible "independent of what the
    product pack has moved on to since" (demo.yaml's own header comment) --
    but nothing enforced that pin stays current, so a fleet-wide pack version
    bump (e.g. the depth audit's 2.0.0 -> 2.1.0) can leave a bundle silently
    pointed at a pack version that no longer exists."""
    bundle_dir = Path(bundle_dir)
    try:
        bundle = load_demo_bundle(bundle_dir)
    except DemoManifestError as exc:
        return [Finding("MANIFEST_INVALID", "error", bundle_dir.name, "demo.yaml",
                         exc.json_pointer, exc.message)]

    root = Path(packs_root) if packs_root is not None else bundle_dir.parent.parent.parent / "packs"
    pack_yaml = root / bundle.pack / "pack.yaml"
    if not pack_yaml.is_file():
        return [Finding("DEMO_TARGET_PACK_UNRESOLVED", "error", bundle.pack, "demo.yaml", "/pack",
                         f"target pack {bundle.pack!r} has no pack.yaml under {root}")]
    try:
        target = yaml.safe_load(pack_yaml.read_text()) or {}
    except yaml.YAMLError as exc:
        return [Finding("MANIFEST_INVALID", "error", bundle.pack, str(pack_yaml), "/", str(exc))]

    actual_version = str(target.get("version") or "")
    if actual_version and actual_version != bundle.pack_version:
        return [Finding(
            "DEMO_PACK_VERSION_DRIFT", "error", bundle.pack, "demo.yaml", "/pack_version",
            f"bundle pins pack_version {bundle.pack_version!r} but packs/{bundle.pack}/pack.yaml "
            f"is now at {actual_version!r} -- update the bundle's pin (after confirming it still "
            f"installs cleanly against the newer pack)")]
    return []


def check_fleet(packs_root: str | Path = "packs", demo_root: str | Path = "deploy/demo") -> CoherenceReport:
    """Walk every `<packs_root>/<pack>/pack.yaml` (C1-C11) and every
    `<demo_root>/<pack>/demo.yaml` (pack-version wiring) and return one
    aggregated report."""
    packs_root = Path(packs_root)
    demo_root = Path(demo_root)
    report = CoherenceReport()

    if packs_root.is_dir():
        for pack_dir in sorted(p for p in packs_root.iterdir()
                                if p.is_dir() and (p / "pack.yaml").is_file()):
            report.findings.extend(check_pack(pack_dir))
            report.packs_checked += 1

    if demo_root.is_dir():
        for bundle_dir in sorted(b for b in demo_root.iterdir()
                                  if b.is_dir() and (b / "demo.yaml").is_file()):
            report.findings.extend(check_demo_bundle(bundle_dir, packs_root))
            report.bundles_checked += 1

    return report
