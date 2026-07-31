#!/usr/bin/env python3
"""Fleet gate: every registered action's verb must be one rbac will accept.

rbac's ParseAction validates `<service>.<resource>.<verb>` and checks the verb
against AllVerbs by EXACT membership
(services/rbac-service/internal/domain/catalog.go). An action that fails this
does NOT crash the registering service — it logs a 400 and carries on — so the
action simply never reaches the OPA catalog. It cannot then be granted through
the role/grant path, which means the fine-grained capability it was meant to
express does not exist, while the code that checks it still looks like real
enforcement.

That is why this needs a FLEET check rather than per-service tests. Each service
owned a manifest test, and each was written to accept its own service's habits:
inference-service asserted `verb.split("_")[0] in CANONICAL`, which passed
`create_unpromoted` while rbac rejected it. Every suite was green and ten actions
across three services were unregistrable. A check is only worth having here if it
reads the SAME source of truth rbac does — so this parses AllVerbs out of the Go
file instead of hard-coding a copy that can drift from it.
"""
from __future__ import annotations

import pathlib
import re
import sys

REPO = pathlib.Path(__file__).resolve().parents[2]
CATALOG = REPO / "services/rbac-service/internal/domain/catalog.go"

ACTION_RE = re.compile(r'"([a-z][a-z0-9_]*\.[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*)"')


def canonical_verbs() -> set[str]:
    """Read AllVerbs from rbac's own source — never a hand-kept duplicate."""
    src = CATALOG.read_text(encoding="utf-8")
    m = re.search(r"var AllVerbs = map\[string\]bool\{(.*?)\}", src, re.S)
    if not m:
        raise SystemExit(f"could not parse AllVerbs from {CATALOG} — has it moved?")
    verbs = set(re.findall(r"Verb(\w+):", m.group(1)))
    if not verbs:
        raise SystemExit("AllVerbs parsed but empty — the shape of catalog.go changed")
    # Verb constants are declared as VerbRead = "read", etc.
    out = set()
    for name in verbs:
        cm = re.search(rf'{name}\s*=\s*"([a-z_]+)"', src)
        if cm:
            out.add(cm.group(1))
    return out


def manifests() -> list[pathlib.Path]:
    return sorted(REPO.glob("services/*/app/registration.py")) + \
        sorted(REPO.glob("services/*/internal/register/*.go"))


def main() -> int:
    verbs = canonical_verbs()
    bad: list[tuple[pathlib.Path, str, str]] = []
    scanned = 0
    for path in manifests():
        for raw in path.read_text(encoding="utf-8").splitlines():
            line = raw.strip()
            # Manifest entries only: a bare quoted action on its own line. Prose
            # in docstrings mentioning an action must not trip the gate.
            if not (line.startswith('"') and line.rstrip(",").endswith('"')):
                continue
            m = ACTION_RE.fullmatch(line.rstrip(","))
            if not m:
                continue
            scanned += 1
            verb = m.group(1).rsplit(".", 1)[1]
            if verb not in verbs:
                bad.append((path.relative_to(REPO), m.group(1), verb))

    print(f"canonical verbs (from rbac): {' '.join(sorted(verbs))}")
    print(f"scanned {scanned} registered actions across {len(manifests())} manifests")
    if bad:
        print("\nACTIONS rbac WILL REJECT — each fails registration 400 and never "
              "reaches the OPA catalog, so it can never be granted:\n")
        for path, action, verb in bad:
            print(f"  {path}: {action}  (verb {verb!r} is not canonical)")
        print("\nPut the fine-grained distinction in the RESOURCE, not a compound "
              "verb: inference.job.create_unpromoted became "
              "inference.unpromoted_job.create.")
        return 1
    print("all registered actions use canonical verbs")
    return 0


if __name__ == "__main__":
    sys.exit(main())
