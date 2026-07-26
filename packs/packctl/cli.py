"""packctl CLI.

  python -m packctl.cli validate    <pack_dir>
  python -m packctl.cli lint        <pack_dir> [--strict]
  python -m packctl.cli demo-lint   <bundle_dir> [--packs-root <dir>]
  python -m packctl.cli coherence   [--packs-root <dir>] [--demo-root <dir>]
  python -m packctl.cli install     <pack_dir> [--keep-going]

`validate` is pure/offline (manifest + component file structure). `lint` is also
pure/offline but goes deeper — component-file CONTENT + cross-references (see
lint.py) — and is what an author runs in CI. `demo-lint` (BRD 70 §2.8) is a
SEPARATE offline check over a `deploy/demo/<pack>/` demo-seed bundle (never a
`packs/<pack>/` product pack) — contract validation against the target pack's
dataset bindings + a PII deny-list scan, both blocking. `coherence` (see
coherence.py) is the fleet-wide C1-C11 checker from
docs/initiatives/pack-fleet-depth-audit.md: cross-FILE consistency WITHIN each
pack (decision tables, dispositions, agent configs, guardrails, dataset
macros, semantic models, dashboards, ontology, case schemas, verified
queries) that `lint` doesn't perform, plus a demo-bundle pack_version wiring
check across every `packs/<pack>/` + `deploy/demo/<pack>/` pair. `install`
drives the REAL platform APIs against the locally-running stack, authorizing
with harness-IdP-signed JWTs (harness_auth.py). Exit code 0 only when every
action succeeded.
"""

from __future__ import annotations

import argparse
import sys

from .client import Endpoints, PlatformClient
from .coherence import check_fleet
from .demo_lint import lint_demo_bundle
from .installer import install
from .lint import lint_pack
from .manifest import ManifestError, load_manifest


def _run_lint(pack_dir: str, strict: bool) -> int:
    """Print lint findings; exit 1 on any error (or any warning under --strict)."""
    report = lint_pack(pack_dir)
    for f in report.findings:
        loc = f"{f.file}{f.pointer}" if f.pointer not in ("", "/") else f.file
        mark = "ERROR" if f.severity == "error" else "warn "
        print(f"  [{mark}] {f.code} {f.kind}:{loc} — {f.message}")
    label = f"{report.pack}@{report.version}" if report.pack else pack_dir
    print(f"lint {label}: {len(report.errors)} error(s), {len(report.warnings)} warning(s)")
    if report.errors:
        return 1
    return 1 if (strict and report.warnings) else 0


def _run_demo_lint(bundle_dir: str, packs_root: str | None) -> int:
    """Print demo-lint findings; exit 1 on ANY error (both check families are
    blocking by design, DSP-FR-011/AC-6 — no --strict escape hatch)."""
    report = lint_demo_bundle(bundle_dir, packs_root)
    for f in report.findings:
        loc = f"{f.file}{f.pointer}" if f.pointer not in ("", "/") else f.file
        mark = "ERROR" if f.severity == "error" else "warn "
        print(f"  [{mark}] {f.code} {loc} — {f.message}")
    label = f"{report.pack}@{report.version}" if report.pack else bundle_dir
    print(f"demo-lint {label}: {len(report.errors)} error(s), {len(report.warnings)} warning(s)")
    return 1 if report.errors else 0


def _run_coherence(packs_root: str, demo_root: str) -> int:
    """Print coherence findings across every pack + demo bundle; exit 1 on
    ANY finding (all C1-C11 + demo-wiring findings are blocking, no --strict
    escape hatch — see coherence.py)."""
    report = check_fleet(packs_root, demo_root)
    for f in report.findings:
        loc = f"{f.file}{f.pointer}" if f.pointer not in ("", "/") else f.file
        mark = "ERROR" if f.severity == "error" else "warn "
        print(f"  [{mark}] {f.code} {f.pack}:{loc} — {f.message}")
    print(f"coherence: {report.packs_checked} pack(s), {report.bundles_checked} demo bundle(s) — "
          f"{len(report.errors)} error(s), {len(report.warnings)} warning(s)")
    return 1 if report.errors else 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="packctl")
    sub = ap.add_subparsers(dest="cmd", required=True)
    v = sub.add_parser("validate", help="validate pack.yaml + component files")
    v.add_argument("pack_dir")
    lc = sub.add_parser("lint", help="deep content + cross-reference lint (offline)")
    lc.add_argument("pack_dir")
    lc.add_argument("--strict", action="store_true", help="treat warnings as errors")
    dl = sub.add_parser("demo-lint", help="lint a deploy/demo/<pack>/ bundle (BRD 70 §2.8)")
    dl.add_argument("bundle_dir")
    dl.add_argument("--packs-root", default=None,
                    help="override the packs/ dir used to resolve the target pack's "
                         "dataset contracts (default: <bundle_dir>/../../../packs)")
    co = sub.add_parser("coherence", help="fleet-wide C1-C11 cross-file coherence checks (offline)")
    co.add_argument("--packs-root", default="packs",
                    help="root dir containing <pack>/pack.yaml (default: packs)")
    co.add_argument("--demo-root", default="deploy/demo",
                    help="root dir containing <pack>/demo.yaml (default: deploy/demo)")
    i = sub.add_parser("install", help="install a pack into the running platform")
    i.add_argument("pack_dir")
    i.add_argument("--keep-going", action="store_true",
                   help="continue past failed components (default: stop)")
    args = ap.parse_args(argv)

    if args.cmd == "lint":
        return _run_lint(args.pack_dir, args.strict)
    if args.cmd == "demo-lint":
        return _run_demo_lint(args.bundle_dir, args.packs_root)
    if args.cmd == "coherence":
        return _run_coherence(args.packs_root, args.demo_root)

    try:
        manifest = load_manifest(args.pack_dir)
    except ManifestError as exc:
        print(f"INVALID: {exc}", file=sys.stderr)
        return 2
    print(f"manifest ok: {manifest.name}@{manifest.version} — "
          f"{len(manifest.components)} component file(s), "
          f"{len(manifest.deferred)} deferred")

    if args.cmd == "validate":
        return 0

    from . import harness_auth
    ctx = harness_auth.load_context()  # runs the idempotent platform seed
    author, approver, agent = harness_auth.token_providers(ctx)
    client = PlatformClient(
        endpoints=Endpoints(), tenant_id=ctx["tenant"],
        workspace_id=ctx["workspace"],
        author_token=author, approver_token=approver, agent_token=agent)
    result = install(manifest, client, keep_going=args.keep_going)
    return 0 if result.ok else 1


if __name__ == "__main__":
    sys.exit(main())
