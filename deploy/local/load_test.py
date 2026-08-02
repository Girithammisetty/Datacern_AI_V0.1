#!/usr/bin/env python3
"""Concurrent load test — the platform's #1 unverified claim.

`docs/WHAT_DATACERN_IS.md` §5 states plainly: *"Never load-tested. We do not
know what happens with 50 concurrent users."* This harness closes that: it
drives N concurrent virtual users through the read-hero journey against the
real BFF (the single surface the browser talks to), ramps to a target
concurrency, and reports per-step latency percentiles (p50/p95/p99) + error
rate + throughput — the numbers a production-readiness review actually needs.

It never writes: the journey is list-shaped reads (worklist, case detail,
dashboards, the copilot run list), so it is safe to run against any seeded
tenant repeatedly and leaves no state behind.

USAGE (against a booted stack — `deploy/local/up.sh` first):
    python deploy/local/load_test.py --users 50 --duration 60
    python deploy/local/load_test.py --users 50 --ramp 15 --duration 120 --json report.json

Options:
    --users N        target concurrent virtual users (default 50)
    --ramp S         seconds to ramp from 1 -> N users (default 10)
    --duration S     seconds to hold at target after ramp (default 60)
    --slo-p95-ms M   fail (exit 1) if any step's p95 exceeds M ms (default: off)
    --persona KEY    persona from deploy/local/run/personas.json (default: first admin)
    --json PATH      also write the full report as JSON
    --self-test      run the in-process aggregator/ramp self-test and exit
                     (no stack, no network — proves the harness logic itself)

Design notes:
  - Uses only the stdlib + the e2e harness's real token minter
    (`deploy/e2e/lib/common.user_token`) so it needs no extra deps and mints
    tokens every verifier already trusts.
  - Latency is measured per STEP (each GraphQL query) so a slow surface is
    attributable, not hidden in a blended average.
  - Percentiles use the nearest-rank method on the collected samples — exact,
    deterministic, no sampling error to argue about in a review.
"""
from __future__ import annotations

import argparse
import json
import math
import os
import sys
import time
from dataclasses import dataclass, field

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
E2E_LIB = os.path.join(REPO_ROOT, "e2e", "lib")


# ---------------------------------------------------------------------------
# Pure aggregation core (self-testable without a stack or network).
# ---------------------------------------------------------------------------

def percentile(sorted_ms: list[float], pct: float) -> float:
    """Nearest-rank percentile of an already-sorted sample (pct in [0,100])."""
    if not sorted_ms:
        return 0.0
    if pct <= 0:
        return sorted_ms[0]
    if pct >= 100:
        return sorted_ms[-1]
    rank = math.ceil(pct / 100.0 * len(sorted_ms))
    return sorted_ms[min(rank, len(sorted_ms)) - 1]


@dataclass
class StepStats:
    name: str
    latencies_ms: list[float] = field(default_factory=list)
    errors: int = 0

    def record(self, ms: float, ok: bool) -> None:
        self.latencies_ms.append(ms)
        if not ok:
            self.errors += 1

    def summary(self) -> dict:
        s = sorted(self.latencies_ms)
        n = len(s)
        return {
            "step": self.name,
            "count": n,
            "errors": self.errors,
            "error_rate": round(self.errors / n, 4) if n else 0.0,
            "p50_ms": round(percentile(s, 50), 1),
            "p95_ms": round(percentile(s, 95), 1),
            "p99_ms": round(percentile(s, 99), 1),
            "max_ms": round(s[-1], 1) if s else 0.0,
        }


class Recorder:
    def __init__(self) -> None:
        self._steps: dict[str, StepStats] = {}

    def record(self, step: str, ms: float, ok: bool) -> None:
        self._steps.setdefault(step, StepStats(step)).record(ms, ok)

    def report(self, *, wall_s: float) -> dict:
        steps = [self._steps[k].summary() for k in sorted(self._steps)]
        total = sum(s["count"] for s in steps)
        errors = sum(s["errors"] for s in steps)
        return {
            "total_requests": total,
            "total_errors": errors,
            "overall_error_rate": round(errors / total, 4) if total else 0.0,
            "throughput_rps": round(total / wall_s, 1) if wall_s else 0.0,
            "wall_seconds": round(wall_s, 1),
            "steps": steps,
        }


def target_users_at(elapsed_s: float, target: int, ramp_s: float) -> int:
    """Linear ramp 1 -> target over ramp_s, then hold. Deterministic."""
    if ramp_s <= 0 or elapsed_s >= ramp_s:
        return target
    return max(1, math.ceil(target * (elapsed_s / ramp_s)))


# ---------------------------------------------------------------------------
# The read-hero journey (list-shaped GraphQL reads — never writes).
# ---------------------------------------------------------------------------

JOURNEY = [
    ("worklist", "query { cases(first: 25) { nodes { id status severity } } }"),
    ("dashboards", "query { dashboards(first: 20) { nodes { id title } } }"),
    ("inbox", "query { proposals(first: 25) { nodes { id status } } }"),
    ("copilot_runs", "query { agentRuns(first: 20) { nodes { id status } } }"),
    ("datasets", "query { datasets(first: 20) { nodes { id name } } }"),
]


def _self_test() -> int:
    """Prove the aggregator + ramp math without a stack or network."""
    # percentile nearest-rank
    xs = list(range(1, 101))  # 1..100
    assert percentile(xs, 50) == 50, percentile(xs, 50)
    assert percentile(xs, 95) == 95
    assert percentile(xs, 99) == 99
    assert percentile(xs, 100) == 100
    assert percentile([], 95) == 0.0
    assert percentile([42.0], 95) == 42.0

    # recorder rolls up per step with error rate
    rec = Recorder()
    for ms in (10, 20, 30, 40, 200):        # p95 of 5 samples (rank 5) = 200
        rec.record("worklist", ms, ok=(ms != 200))
    rep = rec.report(wall_s=1.0)
    step = rep["steps"][0]
    assert step["count"] == 5 and step["errors"] == 1, step
    assert step["error_rate"] == 0.2, step
    assert step["p95_ms"] == 200.0, step
    assert rep["overall_error_rate"] == 0.2, rep
    assert rep["throughput_rps"] == 5.0, rep

    # ramp: 1 at t=0+, target at/after ramp end, monotonic non-decreasing
    assert target_users_at(0.0, 50, 10) == 1
    assert target_users_at(5.0, 50, 10) == 25
    assert target_users_at(10.0, 50, 10) == 50
    assert target_users_at(99.0, 50, 10) == 50
    assert target_users_at(3.0, 50, 0) == 50      # no ramp
    prev = 0
    for t in range(0, 11):
        u = target_users_at(float(t), 50, 10)
        assert u >= prev, (t, u, prev)
        prev = u

    print("load_test self-test: OK (percentiles, roll-up, error-rate, ramp)")
    return 0


# ---------------------------------------------------------------------------
# Live driver (only imported/used when actually run against a stack).
# ---------------------------------------------------------------------------

def _run_live(args) -> int:
    import concurrent.futures
    import threading
    import urllib.error
    import urllib.request

    sys.path.insert(0, E2E_LIB)
    import common as c  # real token minter + BFF URL

    bff = os.environ.get("BFF_URL", c.BFF)
    personas_path = os.path.join(REPO_ROOT, "local", "run", "personas.json")
    with open(personas_path) as f:
        personas = json.load(f)
    # pick an admin-shaped persona (broad read scope) unless one is named
    key = args.persona
    persona = personas.get(key) if key else None
    if persona is None:
        for k, v in personas.items():
            if "tenant.admin" in v.get("scopes", []) or "*" in v.get("scopes", []):
                key, persona = k, v
                break
    if persona is None:
        print("no admin-shaped persona in personas.json", file=sys.stderr)
        return 2
    token = c.user_token(persona["sub"] if "sub" in persona else key,
                         persona["tenantId"], persona.get("scopes", []),
                         persona.get("workspaceId"))
    print(f"load test -> {bff}  persona={key}  tenant={persona['tenantId']}")
    print(f"  {args.users} users, {args.ramp}s ramp, {args.duration}s hold")

    rec = Recorder()
    rec_lock = threading.Lock()
    stop_at = time.monotonic() + args.ramp + args.duration
    start = time.monotonic()

    def one_request(step: str, query: str) -> None:
        body = json.dumps({"query": query}).encode()
        req = urllib.request.Request(f"{bff}/graphql", data=body, headers={
            "content-type": "application/json", "authorization": f"Bearer {token}"})
        t0 = time.monotonic()
        ok = False
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                payload = json.loads(resp.read())
                ok = resp.status == 200 and "errors" not in payload
        except (urllib.error.URLError, TimeoutError, ValueError):
            ok = False
        ms = (time.monotonic() - t0) * 1000.0
        with rec_lock:
            rec.record(step, ms, ok)

    def virtual_user(uid: int) -> None:
        # Each VU only starts once the ramp admits its index.
        while time.monotonic() < stop_at:
            elapsed = time.monotonic() - start
            if uid >= target_users_at(elapsed, args.users, args.ramp):
                time.sleep(0.2)
                continue
            for step, query in JOURNEY:
                if time.monotonic() >= stop_at:
                    break
                one_request(step, query)

    with concurrent.futures.ThreadPoolExecutor(max_workers=args.users) as pool:
        futures = [pool.submit(virtual_user, i) for i in range(args.users)]
        for fut in concurrent.futures.as_completed(futures):
            fut.result()

    report = rec.report(wall_s=time.monotonic() - start)
    print("\n==================== LOAD REPORT ====================")
    print(f"  requests={report['total_requests']}  errors={report['total_errors']}"
          f"  ({report['overall_error_rate'] * 100:.2f}%)  throughput={report['throughput_rps']}/s")
    print(f"  {'step':16} {'n':>6} {'p50':>7} {'p95':>7} {'p99':>7} {'err%':>6}")
    worst_p95 = 0.0
    for s in report["steps"]:
        worst_p95 = max(worst_p95, s["p95_ms"])
        print(f"  {s['step']:16} {s['count']:6} {s['p50_ms']:7} {s['p95_ms']:7} "
              f"{s['p99_ms']:7} {s['error_rate'] * 100:6.2f}")
    if args.json:
        with open(args.json, "w") as f:
            json.dump(report, f, indent=2)
        print(f"  wrote {args.json}")

    if args.slo_p95_ms and worst_p95 > args.slo_p95_ms:
        print(f"\nSLO FAIL: worst step p95 {worst_p95}ms > {args.slo_p95_ms}ms")
        return 1
    if report["overall_error_rate"] > 0.01:
        print(f"\nHIGH ERROR RATE: {report['overall_error_rate'] * 100:.2f}% (> 1%)")
        return 1
    print("\nLOAD TEST PASSED")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="Concurrent load test against the BFF")
    ap.add_argument("--users", type=int, default=50)
    ap.add_argument("--ramp", type=float, default=10.0)
    ap.add_argument("--duration", type=float, default=60.0)
    ap.add_argument("--slo-p95-ms", type=float, default=0.0)
    ap.add_argument("--persona", default=None)
    ap.add_argument("--json", default=None)
    ap.add_argument("--self-test", action="store_true")
    args = ap.parse_args()
    if args.self_test:
        return _self_test()
    return _run_live(args)


if __name__ == "__main__":
    raise SystemExit(main())
