#!/usr/bin/env python3
"""Keep the SOC 2 control register honest against the repository.

WHY. A control-to-evidence map is worthless the moment a cited file moves and
the citation silently rots — an auditor (or a Vanta/Drata sync) then chases a
dead path and the "readiness" was fiction. This validator derives truth from
the repo on every run: every evidence `path` in
docs/security/soc2_control_register.yaml MUST exist, or CI turns red with the
criterion, the path, and the note. It mirrors tools/docs/check_doc_facts.py —
the same "the code is the source of truth, the document must match it" rule,
applied to compliance evidence instead of prose counts.

DELIBERATELY NARROW. It checks only what is machine-verifiable:
  1. every evidence `path` exists in the repo (no rotted citations);
  2. every `status` is from the allowed set;
  3. every non-`implemented` criterion names what to collect
     (`external_evidence` is non-empty) — so a gap is never silently blank;
  4. the required Common Criteria (CC1–CC9) are all present.
It does NOT judge whether a control is *sufficient* for SOC 2 — that is an
auditor's job, not a script's. A green run means "every claim in the register
points at something real and every gap is named," nothing more.

Usage:
    python3 tools/compliance/check_soc2_evidence.py            # validate, exit 1 on any problem
    python3 tools/compliance/check_soc2_evidence.py --list     # print criteria + statuses
    python3 tools/compliance/check_soc2_evidence.py --summary  # print a readiness tally
    python3 tools/compliance/check_soc2_evidence.py --self-test
"""
from __future__ import annotations

import sys
from pathlib import Path

import yaml

REPO_ROOT = Path(__file__).resolve().parents[2]
REGISTER = REPO_ROOT / "docs" / "security" / "soc2_control_register.yaml"

VALID_STATUS = {"implemented", "partial", "gap"}
REQUIRED_COMMON_CRITERIA = {f"CC{i}" for i in range(1, 10)}  # CC1..CC9


def load_register(path: Path = REGISTER) -> dict:
    with path.open("r", encoding="utf-8") as fh:
        return yaml.safe_load(fh)


def validate(reg: dict, repo_root: Path = REPO_ROOT) -> list[str]:
    """Return a list of human-readable problems; empty means the register is clean."""
    problems: list[str] = []

    criteria = reg.get("criteria")
    if not isinstance(criteria, list) or not criteria:
        return ["register has no `criteria` list"]

    seen_ids: set[str] = set()
    for crit in criteria:
        cid = crit.get("id", "<no-id>")
        if cid in seen_ids:
            problems.append(f"{cid}: duplicate criterion id")
        seen_ids.add(cid)

        status = crit.get("status")
        if status not in VALID_STATUS:
            problems.append(f"{cid}: status {status!r} not in {sorted(VALID_STATUS)}")

        if not crit.get("summary", "").strip():
            problems.append(f"{cid}: empty summary")

        # Every cited evidence path must exist — the anti-rot check.
        for ev in crit.get("evidence") or []:
            p = ev.get("path")
            if not p:
                problems.append(f"{cid}: evidence entry missing `path`")
                continue
            if not (repo_root / p).exists():
                problems.append(f"{cid}: evidence path does not exist: {p}")

        # A non-implemented criterion must name what to collect — never blank.
        if status in {"partial", "gap"}:
            ext = crit.get("external_evidence") or []
            if not ext:
                problems.append(
                    f"{cid}: status {status!r} but no `external_evidence` — "
                    "a gap must name what to collect"
                )

        # An `implemented` criterion must actually cite in-repo evidence.
        if status == "implemented" and not (crit.get("evidence") or []):
            problems.append(f"{cid}: status 'implemented' but cites no in-repo evidence")

    missing_cc = REQUIRED_COMMON_CRITERIA - seen_ids
    if missing_cc:
        problems.append(
            "missing required Common Criteria: " + ", ".join(sorted(missing_cc))
        )

    return problems


def tally(reg: dict) -> dict[str, int]:
    counts = {s: 0 for s in VALID_STATUS}
    for crit in reg.get("criteria", []):
        st = crit.get("status")
        if st in counts:
            counts[st] += 1
    return counts


def cmd_list(reg: dict) -> None:
    for crit in reg.get("criteria", []):
        n_ev = len(crit.get("evidence") or [])
        n_todo = len(crit.get("external_evidence") or [])
        print(f"{crit.get('id'):<5} {crit.get('status'):<12} "
              f"evidence={n_ev} to-collect={n_todo}  {crit.get('name')}")


def cmd_summary(reg: dict) -> None:
    counts = tally(reg)
    total = sum(counts.values())
    print(f"SOC 2 readiness register — {total} criteria")
    for st in ("implemented", "partial", "gap"):
        print(f"  {st:<12} {counts[st]}")
    todo = sum(len(c.get("external_evidence") or []) for c in reg.get("criteria", []))
    print(f"  evidence-to-collect items: {todo}")
    print("  NOTE: readiness only — SOC 2 not started; no observation window open.")


def self_test() -> int:
    """Prove the validator catches the failure modes it exists to catch."""
    ok = True

    # A rotted path must be flagged.
    bad = {"criteria": [{"id": c, "status": "gap", "summary": "x",
                         "external_evidence": ["y"]} for c in REQUIRED_COMMON_CRITERIA]}
    bad["criteria"][0]["status"] = "implemented"
    bad["criteria"][0]["evidence"] = [{"path": "does/not/exist.xyz"}]
    probs = validate(bad)
    if not any("does not exist" in p for p in probs):
        print("SELF-TEST FAIL: missing path not caught")
        ok = False

    # A blank gap must be flagged.
    blankgap = {"criteria": [{"id": c, "status": "gap", "summary": "x",
                              "external_evidence": ["y"]} for c in REQUIRED_COMMON_CRITERIA]}
    blankgap["criteria"][1]["external_evidence"] = []
    if not any("must name what to collect" in p for p in validate(blankgap)):
        print("SELF-TEST FAIL: blank gap not caught")
        ok = False

    # A bad status must be flagged.
    badstatus = {"criteria": [{"id": c, "status": "gap", "summary": "x",
                               "external_evidence": ["y"]} for c in REQUIRED_COMMON_CRITERIA]}
    badstatus["criteria"][2]["status"] = "sorta"
    if not any("not in" in p for p in validate(badstatus)):
        print("SELF-TEST FAIL: bad status not caught")
        ok = False

    # A missing CC must be flagged.
    missing = {"criteria": [{"id": c, "status": "gap", "summary": "x",
                             "external_evidence": ["y"]}
                            for c in REQUIRED_COMMON_CRITERIA if c != "CC5"]}
    if not any("missing required Common Criteria" in p for p in validate(missing)):
        print("SELF-TEST FAIL: missing criterion not caught")
        ok = False

    # The real register must be clean.
    if validate(load_register()):
        print("SELF-TEST FAIL: the committed register does not validate")
        ok = False

    print("SELF-TEST PASS" if ok else "SELF-TEST FAILED")
    return 0 if ok else 1


def main(argv: list[str]) -> int:
    if "--self-test" in argv:
        return self_test()

    reg = load_register()
    if "--list" in argv:
        cmd_list(reg)
        return 0
    if "--summary" in argv:
        cmd_summary(reg)
        return 0

    problems = validate(reg)
    if problems:
        print(f"SOC 2 control register FAILED validation ({len(problems)} problem(s)):")
        for p in problems:
            print(f"  - {p}")
        return 1
    print("SOC 2 control register OK — every evidence citation resolves; every gap is named.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
