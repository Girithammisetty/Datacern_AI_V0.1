#!/usr/bin/env python3
"""Deterministic full-platform validation orchestrator.

Runs every EXISTING platform validator in dependency order against a live
stack (`make up`), captures a per-step result, and writes ONE machine-readable
evidence artifact — `deploy/evidence/validation-report.{json,md}` — that says,
without archaeology, exactly what passed, what failed, what was skipped, and
how long each took.

This is a harness, not new test logic: it invokes the same journeys, probes,
soaks, and suites the Makefile already exposes. It costs ZERO LLM API tokens —
the agent-exercising steps drive the platform's own ai-gateway, which the test
stack points at a local Ollama model, not a paid endpoint.

Design rules (match the repo's iron conventions):
  - Assert on real process exit codes and captured output — never on a claim.
  - Every step records status ∈ {passed, failed, skipped, errored} + duration
    + a bounded output tail, so the report is the evidence.
  - A missing precondition (stack down, tool absent) SKIPS with a reason; it
    does not silently pass. Coverage that did not execute is reported as such.
  - Exit non-zero iff any REQUIRED step failed. Optional steps (soaks, load)
    are reported but do not gate, unless --strict.

Usage:
  deploy/e2e/validate_platform.py                 # full run against a live stack
  deploy/e2e/validate_platform.py --quick         # skip soaks + load (fast signal)
  deploy/e2e/validate_platform.py --self-test     # prove the orchestrator itself,
                                                   # no stack, no network
  deploy/e2e/validate_platform.py --strict        # optional-step failure also gates
  deploy/e2e/validate_platform.py --only journeys # run one tier (see TIERS)

The report is intentionally committed-artifact-shaped: point CI's
upload-artifact at deploy/evidence/validation-report.* and the "is it green?"
question is answered by opening one file.
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field, asdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
EVIDENCE = ROOT / "deploy" / "evidence"
VENV_PY = ROOT / "deploy" / "e2e" / ".venv" / "bin" / "python"
PY = str(VENV_PY) if VENV_PY.exists() else sys.executable

BFF_URL = os.environ.get("BFF_URL", "http://localhost:4000")
TAIL_CHARS = 4000  # bounded output kept per step so the JSON stays reviewable


# --- step model ---------------------------------------------------------------

@dataclass
class Step:
    key: str
    title: str
    tier: str
    cmd: list[str]
    required: bool = True
    # a step may declare it needs the live stack; when the stack is down it is
    # SKIPPED (reason recorded), never counted as passed.
    needs_stack: bool = True
    timeout_s: int = 1800


@dataclass
class Result:
    key: str
    title: str
    tier: str
    status: str = "pending"      # passed | failed | skipped | errored
    reason: str = ""
    returncode: int | None = None
    duration_s: float = 0.0
    output_tail: str = ""


# --- the tier plan ------------------------------------------------------------
# Ordered by dependency: preflight health first, then the six governed backend
# journeys (real Postgres/Kafka/Iceberg/Ollama), then the seventh FHIR journey,
# then cross-tenant security, the agent-roster sweep, the browser suite, and
# finally the two soaks (heaviest, most likely to surface the unmeasured).

def build_plan(quick: bool) -> list[Step]:
    steps: list[Step] = [
        Step("doctor", "Health gate (make doctor)", "preflight",
             ["bash", str(ROOT / "deploy/local/doctor.sh")]),

        Step("journey_governed", "Governed write loop (AI proposes → human approves → row changes)",
             "journeys", [PY, str(ROOT / "deploy/e2e/test_governed_write_loop.py")]),
        Step("journey_streams", "Realtime case streams (gate · watermark · dept isolation)",
             "journeys", [PY, str(ROOT / "deploy/e2e/test_case_stream_journey.py")]),
        Step("journey_learn", "Learn flywheel (corrections → retrain → four-eyes promote → score)",
             "journeys", [PY, str(ROOT / "deploy/e2e/test_learn_journey.py")]),
        Step("journey_forms", "Schema-driven forms (typed intake · refusals write nothing)",
             "journeys", [PY, str(ROOT / "deploy/e2e/test_forms_journey.py")]),
        Step("journey_packs", "Pack conformance (install · drift · uninstall · tombstone)",
             "journeys", [PY, str(ROOT / "deploy/e2e/test_packs_journey.py")]),
        Step("journey_fhir", "Governed FHIR loop (read granted · writes proposal-gated)",
             "journeys", [PY, str(ROOT / "deploy/e2e/test_fhir_journey.py")]),

        Step("security_probe", "Cross-tenant authorization probe (isolation attack)",
             "security", [PY, str(ROOT / "deploy/security/cross_tenant_authz_probe.py")]),

        Step("agents_chat", "Agent roster sweep (9 agents over the real OBO chat path)",
             "agents", [PY, str(ROOT / "deploy/e2e/test_agents_chat.py")], required=False),

        Step("ui_live", "Browser suite (pnpm e2e:live) against the running stack",
             "ui", ["pnpm", "-C", str(ROOT / "services/ui-web"), "e2e:live"],
             required=False, timeout_s=3600),
    ]

    if not quick:
        steps += [
            Step("load", "Load profile (50 VUs, p95 recorded)", "load",
                 [PY, str(ROOT / "deploy/local/load_test.py"), "--users", "50",
                  "--ramp", "10", "--duration", "60",
                  "--json", str(EVIDENCE / "load-report.json")],
                 required=False),
            Step("soak_restart", "Restart soak (infra restart survival)", "soak",
                 ["bash", str(ROOT / "deploy/local/soak.sh")], required=False,
                 timeout_s=2400),
            Step("soak_volume", "Volume soak (bulk-row survival)", "soak",
                 ["bash", str(ROOT / "deploy/local/soak_volume.sh")], required=False,
                 timeout_s=3600),
        ]
    return steps


TIERS = ["preflight", "journeys", "security", "agents", "ui", "load", "soak"]


# --- execution ----------------------------------------------------------------

def stack_up(timeout: float = 2.0) -> bool:
    """The stack is 'up' iff the BFF answers. Used only to decide SKIP-vs-run
    for stack-dependent steps — never to fake a pass."""
    req = urllib.request.Request(f"{BFF_URL}/healthz", method="GET")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return 200 <= r.status < 500
    except urllib.error.HTTPError as e:
        return 200 <= e.code < 500  # any HTTP answer means the port is live
    except Exception:
        return False


def run_step(step: Step, live: bool) -> Result:
    res = Result(step.key, step.title, step.tier)
    if step.needs_stack and not live:
        res.status = "skipped"
        res.reason = "live stack not reachable at BFF /healthz — run `make up` first"
        return res
    if not Path(step.cmd[-1]).exists() and step.cmd[0] in (PY, "bash") \
            and step.cmd[-1].endswith((".py", ".sh")):
        res.status = "skipped"
        res.reason = f"command target missing: {step.cmd[-1]}"
        return res

    start = time.monotonic()
    try:
        proc = subprocess.run(step.cmd, cwd=str(ROOT), capture_output=True,
                              text=True, timeout=step.timeout_s)
        res.returncode = proc.returncode
        combined = (proc.stdout or "") + (proc.stderr or "")
        res.output_tail = combined[-TAIL_CHARS:]
        res.status = "passed" if proc.returncode == 0 else "failed"
    except subprocess.TimeoutExpired:
        res.status = "errored"
        res.reason = f"timed out after {step.timeout_s}s"
    except Exception as exc:  # noqa: BLE001 — record any launch failure honestly
        res.status = "errored"
        res.reason = f"failed to launch: {exc}"
    res.duration_s = round(time.monotonic() - start, 2)
    return res


# --- reporting ----------------------------------------------------------------

def write_reports(results: list[Result], meta: dict) -> tuple[Path, Path]:
    EVIDENCE.mkdir(parents=True, exist_ok=True)
    payload = {"meta": meta, "steps": [asdict(r) for r in results]}
    json_path = EVIDENCE / "validation-report.json"
    json_path.write_text(json.dumps(payload, indent=2))

    icon = {"passed": "✅", "failed": "❌", "skipped": "⏭️",
            "errored": "💥", "pending": "…"}
    counts: dict[str, int] = {}
    for r in results:
        counts[r.status] = counts.get(r.status, 0) + 1

    lines = [
        f"# Platform validation report — {meta['generated_at']}",
        "",
        f"**Commit:** `{meta['commit']}`  ·  **Mode:** {meta['mode']}  ·  "
        f"**Stack:** {'live' if meta['stack_live'] else 'DOWN (stack-dependent steps skipped)'}",
        "",
        "| " + " · ".join(f"{icon[k]} {counts.get(k, 0)} {k}"
                          for k in ("passed", "failed", "skipped", "errored")) + " |",
        "|" + "---|" * 1,
        "",
        f"**Verdict: {meta['verdict']}**",
        "",
        "| Step | Tier | Status | Duration | Note |",
        "|---|---|---|---:|---|",
    ]
    for r in results:
        note = r.reason or (f"rc={r.returncode}" if r.returncode not in (0, None) else "")
        lines.append(f"| {r.title} | {r.tier} | {icon[r.status]} {r.status} | "
                     f"{r.duration_s:.1f}s | {note} |")

    failing = [r for r in results if r.status in ("failed", "errored")]
    if failing:
        lines += ["", "## Failing steps — output tails", ""]
        for r in failing:
            lines += [f"### {icon[r.status]} {r.title} (`{r.key}`)", "",
                      "```", (r.output_tail or r.reason or "(no output)").strip(), "```", ""]

    md_path = EVIDENCE / "validation-report.md"
    md_path.write_text("\n".join(lines) + "\n")
    return json_path, md_path


def git_commit() -> str:
    try:
        return subprocess.run(["git", "rev-parse", "--short", "HEAD"], cwd=str(ROOT),
                              capture_output=True, text=True).stdout.strip() or "unknown"
    except Exception:
        return "unknown"


# --- self-test (no stack, no network) ----------------------------------------

def self_test() -> int:
    """Prove the orchestrator's own logic: plan build, verdict math, and report
    rendering — without a stack. Mirrors load_test.py's --self-test discipline."""
    assert len(build_plan(quick=True)) < len(build_plan(quick=False)), "quick must trim soaks/load"
    demo = [
        Result("a", "req pass", "journeys", status="passed"),
        Result("b", "req fail", "journeys", status="failed", returncode=1,
               output_tail="boom"),
        Result("c", "opt fail", "soak", status="failed", returncode=1),
        Result("d", "skipped", "ui", status="skipped", reason="stack down"),
    ]
    # required failure gates; optional failure does not (non-strict).
    required_keys = {"a", "b"}
    verdict = compute_verdict(demo, required_keys, strict=False)
    assert verdict == "FAIL", verdict
    verdict_ok = compute_verdict([demo[0], demo[3]], {"a"}, strict=False)
    assert verdict_ok == "PASS", verdict_ok
    # strict makes the optional failure gate.
    assert compute_verdict([demo[0], demo[2]], {"a"}, strict=True) == "FAIL"
    # an all-skipped run is INCONCLUSIVE, never PASS.
    assert compute_verdict([demo[3]], {"a"}, strict=False) == "INCONCLUSIVE"
    meta = {"generated_at": "self-test", "commit": "test", "mode": "self-test",
            "stack_live": False, "verdict": verdict}
    jp, mp = write_reports(demo, meta)
    assert jp.exists() and mp.exists()
    # clean up the self-test artifacts so they never masquerade as a real run.
    jp.unlink(); mp.unlink()
    print("validate_platform self-test: OK (plan, verdict math, report render)")
    return 0


def compute_verdict(results: list[Result], required_keys: set[str], strict: bool) -> str:
    """FAIL if any gating step failed; INCONCLUSIVE if nothing actually
    executed (e.g. the stack was down and every step skipped) — an all-skipped
    run must never read as PASS; PASS only when real steps ran and none gating
    failed."""
    for r in results:
        if r.status in ("failed", "errored") and (strict or r.key in required_keys):
            return "FAIL"
    if not any(r.status in ("passed", "failed", "errored") for r in results):
        return "INCONCLUSIVE"
    return "PASS"


# --- main ---------------------------------------------------------------------

def main() -> int:
    ap = argparse.ArgumentParser(description="Full-platform validation orchestrator")
    ap.add_argument("--quick", action="store_true", help="skip soaks + load profile")
    ap.add_argument("--strict", action="store_true",
                    help="optional-step failure also gates the exit code")
    ap.add_argument("--only", choices=TIERS, help="run only one tier")
    ap.add_argument("--self-test", action="store_true",
                    help="prove the orchestrator itself; no stack, no network")
    args = ap.parse_args()

    if args.self_test:
        return self_test()

    live = stack_up()
    plan = build_plan(quick=args.quick)
    if args.only:
        plan = [s for s in plan if s.tier == args.only]
    required_keys = {s.key for s in plan if s.required}

    generated_at = subprocess.run(["date", "-u", "+%Y-%m-%dT%H:%M:%SZ"],
                                  capture_output=True, text=True).stdout.strip()
    print(f"== validate-platform :: {'LIVE' if live else 'STACK DOWN'} :: "
          f"{len(plan)} steps ==", flush=True)

    results: list[Result] = []
    for step in plan:
        print(f"-> {step.title} ...", flush=True)
        r = run_step(step, live)
        marker = {"passed": "OK", "failed": "FAIL", "skipped": "skip",
                  "errored": "ERROR"}[r.status]
        print(f"   [{marker}] {r.duration_s:.1f}s {r.reason}", flush=True)
        results.append(r)

    verdict = compute_verdict(results, required_keys, strict=args.strict)
    meta = {
        "generated_at": generated_at,
        "commit": git_commit(),
        "mode": ("quick" if args.quick else "full") + (f":{args.only}" if args.only else ""),
        "stack_live": live,
        "strict": args.strict,
        "verdict": verdict,
    }
    json_path, md_path = write_reports(results, meta)
    print(f"\n== verdict: {verdict} ==")
    print(f"   report: {md_path.relative_to(ROOT)}")
    print(f"   json:   {json_path.relative_to(ROOT)}")
    # Only a genuine PASS exits 0; FAIL and INCONCLUSIVE (nothing ran) both
    # exit non-zero so CI can never mistake an unbooted stack for success.
    return 0 if verdict == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
