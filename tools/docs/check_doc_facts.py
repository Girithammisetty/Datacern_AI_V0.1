#!/usr/bin/env python3
"""Fail when a documented count contradicts the repository.

WHY. On 2026-08-01 an audit of every Markdown file found the same handful of
numbers wrong in seven documents at once: "23 services" when `deploy/services.yaml`
listed 24, "70+ BRDs" against 72 files, "2 of 28 packs" with demo bundles when
four had them, and a test count roughly 40% above a strict recount. None of it
was dishonest — the repository simply moved and the prose did not.

Correcting prose fixes today. This fixes tomorrow: the counts below are derived
from the repository on every run, and any document asserting a different figure
turns CI red with the file, the line and both numbers.

DELIBERATELY NARROW. It checks only facts with an unambiguous machine-readable
source. Prose claims ("four-eyes on every write") are not checkable this way and
are governed by review, not by this script — see docs/DATACERN_PARTNER_BRIEFING.md
§3 for the list that has to be maintained by hand.

Snapshot documents are exempt: a file carrying the converted-from-Word banner is
a point-in-time record whose figures were true when written, so rewriting them
would be falsifying a dated artifact rather than correcting it.

Usage:
    python3 tools/docs/check_doc_facts.py          # check, exit 1 on mismatch
    python3 tools/docs/check_doc_facts.py --list   # print the derived facts
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SNAPSHOT = "converted from"  # banner marker written by docx_to_md.py


# ---- derive the truth from the repository -----------------------------------

def n_services() -> int:
    import yaml  # noqa: PLC0415
    return len(yaml.safe_load((ROOT / "deploy/services.yaml").read_text())["services"])


def n_packs() -> int:
    return sum(1 for p in (ROOT / "packs").iterdir() if (p / "pack.yaml").exists())


def n_brds() -> int:
    return len(list((ROOT / "docs/brd").glob("*.md")))


def n_demo_bundles() -> int:
    return len(list((ROOT / "deploy/demo").glob("*/cases.yaml")))


# Each rule: a human name, the derived value, and a pattern whose first capture
# group is the number a document asserts. Patterns are deliberately specific —
# a rule that fires on unrelated prose is worse than no rule, because the next
# person silences the whole check instead of one false positive.
def rules() -> list[tuple[str, int, re.Pattern[str], bool]]:
    """(name, truth, pattern, authoritative_only).

    Two tiers, because prose numbers cannot be classified reliably. A BRD saying
    "All 4 services `go build` clean" is describing the services a change
    touched, not contradicting the inventory — an early draft of this script
    flagged 27 such lines and would have been silenced wholesale within a week.

    ANCHORED patterns carry their own totalising phrase ("all 23 services",
    "70 numbered BRDs") and are safe to run over every file. LOOSE patterns
    match a bare count and run only over the documents that speak for the
    platform as a whole, listed in AUTHORITATIVE.
    """
    return [
        ("services", n_services(),
         re.compile(r"\ball\s+(\d{1,3})\s+services\b"), False),
        ("services", n_services(),
         re.compile(r"\b(\d{1,3})\s+independently-deployable\s+services\b"), False),
        ("BRDs", n_brds(),
         re.compile(r"\b(\d{1,3})\+?\s+numbered\s+BRDs\b"), False),
        ("packs with a seeded demo scenario", n_demo_bundles(),
         re.compile(r"\b(\d{1,3})\s+of\s+\d{1,3}\s+packs\s+have\s+productized\s+demo\s+bundles"), False),
        ("services", n_services(),
         re.compile(r"\b(\d{1,3})\s+services\b"), True),
        ("capability packs", n_packs(),
         re.compile(r"\b(\d{1,3})\s+installable\s+packs\b"), True),
    ]


# Documents that speak for the platform as a whole. Loose patterns run only
# here; everywhere else a bare count is far more likely to be a subset.
AUTHORITATIVE = {
    "README.md",
    "docs/README.md",
    "docs/DATACERN_PARTNER_BRIEFING.md",
    "docs/WHAT_DATACERN_IS.md",
    "docs/demo/RUNBOOK.md",
    "docs/architecture/DATACERN_TECHNICAL_ARCHITECTURE.md",
    "docs/architecture/DATACERN_DEPLOYMENT_ARCHITECTURE.md",
}


# Phrases that legitimately name a different number than the current count,
# because they are describing history rather than the present.
HISTORICAL = re.compile(
    r"original\s+\d+\s+Core\s+services"
    r"|BRDs?\s+0?1[–-]\d+"
    r"|grown\s+past\s+the\s+original",
    re.I,
)


def md_files() -> list[Path]:
    out: list[Path] = [ROOT / "README.md"]
    for p in sorted((ROOT / "docs").rglob("*.md")):
        out.append(p)
    return [p for p in out if p.exists()]


def main(argv: list[str]) -> int:
    derived = rules()

    if "--list" in argv:
        print("derived from the repository:")
        for name, val, *_ in derived:
            print(f"  {name:38} {val}")
        return 0

    seen: set[str] = set()
    problems: list[str] = []
    for path in md_files():
        text = path.read_text(encoding="utf8")
        if SNAPSHOT in text[:400]:
            continue  # dated snapshot — see module docstring
        rel = str(path.relative_to(ROOT))
        for lineno, line in enumerate(text.splitlines(), 1):
            if HISTORICAL.search(line):
                continue
            for name, truth, pat, auth_only in derived:
                if auth_only and rel not in AUTHORITATIVE:
                    continue
                for m in pat.finditer(line):
                    claimed = int(m.group(1))
                    if claimed != truth:
                        key = f"{rel}:{lineno}:{claimed}:{name}"
                        if key in seen:  # overlapping rules, one real problem
                            continue
                        seen.add(key)
                        problems.append(
                            f"{rel}:{lineno}  says {claimed} {name}, repository has {truth}\n"
                            f"    {line.strip()[:110]}"
                        )

    if problems:
        print(f"{len(problems)} documented count(s) contradict the repository:\n")
        for p in problems:
            print(f"  {p}\n")
        print("Fix the document, or — if the line is describing history — reword it so\n"
              "the historical framing is explicit (see HISTORICAL in this script).")
        return 1

    print(f"doc facts OK — {len(md_files())} markdown files agree with the repository")
    for name, val, *_ in sorted({(n, v) for n, v, *_ in derived}):
        print(f"  {name:38} {val}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
