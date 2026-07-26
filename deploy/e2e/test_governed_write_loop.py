#!/usr/bin/env python3
"""Does an approved AI decision actually CHANGE ANYTHING? Assert on state.

This is the one test that would have caught every defect found by hand on
2026-07-26. On that day the flagship loop was completely dead -- `case.
apply_disposition` was never registered at boot, so every approved disposition
was refused by tool-plane and silently dropped -- while 336 agent-runtime, 649
ingestion and 553 ui-web unit tests plus 63 CI checks were all green.

They were green because they check COMPONENTS. Nothing checked the JOURNEY, and
nothing anywhere asserted that a case row was different afterwards. The proposal
said `approved`, the workflow completed, the audit trail read clean, and the
case never moved.

So the single rule here: **never accept an acknowledgement as evidence.** Status
fields, HTTP 200s and `approved` badges are all things the platform says. The
only thing that counts is the row.

Deliberately end-to-end and unmocked: real agent (real Ollama), real proposal,
real four-eyes approval by a DIFFERENT human, real tool-plane authorization,
real case-service write. If any link is broken this goes red.

Usage (needs a running stack -- `make up`):
    deploy/e2e/.venv/bin/python deploy/e2e/test_governed_write_loop.py
Exit 0 = the governed write loop is intact. Non-zero = it is not.
"""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "deploy" / "e2e" / "lib"))
import common as c  # noqa: E402
import requests  # noqa: E402

AR = "http://localhost:8306"
CASE_SVC = "http://localhost:8308"

P = json.load(open(REPO / "deploy" / "local" / "run" / "personas.json"))
PROPOSER = P["admin@demo.datacern"]      # raises the proposal
APPROVER = P["manager@demo.datacern"]    # a DIFFERENT human decides it
TENANT = PROPOSER["tenantId"]

_fail: list[str] = []


def check(ok: bool, label: str, detail: str = "") -> bool:
    print(("  ok   " if ok else "  FAIL ") + label
          + (f"  -- {detail}" if detail and not ok else ""))
    if not ok:
        _fail.append(label)
    return ok


def tok(p, scopes=None):
    return c.user_token(p["sub"], p["tenantId"], scopes or p.get("scopes") or ["*"],
                        workspace_id=p.get("workspaceId"))


def api(method, url, token, body=None, timeout=300):
    r = requests.request(method, url, json=body, timeout=timeout,
                         headers={"Authorization": f"Bearer {token}",
                                  "Content-Type": "application/json"})
    return r


def get_case(case_id: str) -> dict:
    r = api("GET", f"{CASE_SVC}/api/v1/cases/{case_id}", tok(PROPOSER))
    r.raise_for_status()
    return r.json()["data"]


def pick_case() -> str | None:
    """Any case we can drive. Prefers one not already resolved."""
    r = api("GET", f"{CASE_SVC}/api/v1/cases?limit=25", tok(PROPOSER))
    r.raise_for_status()
    rows = r.json().get("data") or []
    # A closed case refuses every transition, and a resolved one already has a
    # disposition — neither can demonstrate a CHANGE. Prefer anything else, and
    # fall back to a resolved case (reopen/start below still moves it).
    live = [x for x in rows if x.get("status") not in ("closed",)]
    open_first = [x for x in live if x.get("status") not in ("resolved",)]
    pick = (open_first or live or rows)
    return (pick[0] or {}).get("id") if pick else None


def main() -> int:
    print("\nGoverned write loop -- does an approved decision change the row?\n")

    case_id = pick_case()
    if not check(bool(case_id), "a case exists to drive",
                 "seed the tenant first (make up)"):
        return 1

    # --- preconditions -------------------------------------------------------
    # NOT incidental setup. Each of these, unmet, produces exactly the kind of
    # silent failure this test exists to catch, and would be misread as the loop
    # being broken: an unassigned approver holds no per-resource grant, so the
    # write dies at tool-plane with "permission denied: obo_grant"; a case that
    # is not in_progress refuses Resolve() with INVALID_TRANSITION. So drive the
    # case to a known state and ASSERT we got there, keeping every check below
    # about the LOOP rather than about fixture state.
    #
    # The state machine (case-service/internal/domain/statemachine.go):
    #   resolved --reopen--> in_progress (and clears the disposition)
    #   unassigned --assign--> draft --start--> in_progress
    st = get_case(case_id).get("status")
    steps = []
    if st == "resolved":
        steps.append(("reopen", api("POST", f"{CASE_SVC}/api/v1/cases/{case_id}/reopen",
                                    tok(PROPOSER), {"reason": "governed-write-loop check"})))
    # Assign in every case: the approver needs the resource grant, not just a
    # reachable status. From in_progress this is a no-op reassignment.
    steps.append(("assign", api("POST", f"{CASE_SVC}/api/v1/cases/{case_id}/assign",
                                tok(PROPOSER), {"assignee_id": APPROVER["sub"]})))
    if get_case(case_id).get("status") == "draft":
        steps.append(("start", api("POST", f"{CASE_SVC}/api/v1/cases/{case_id}/start",
                                   tok(APPROVER), {})))
    time.sleep(3)  # the assignment consumer mints the approver's resource grant

    before = get_case(case_id)
    ready = (before.get("status") == "in_progress"
             and str(before.get("assigned_to_id")) == APPROVER["sub"])
    if not check(ready, "fixture: case is in_progress and assigned to the approver",
                 "; ".join(f"{n} -> {r.status_code} {r.text[:90]}" for n, r in steps)
                 + f" | final status={before.get('status')} "
                   f"assignee={before.get('assigned_to_id')}"):
        return 1

    print(f"  case {case_id}  status={before.get('status')} "
          f"disposition={before.get('disposition_id') or '(none)'}\n")

    # --- 1. the agent proposes ----------------------------------------------
    r = api("POST", f"{AR}/api/v1/agents/case-triage/chat/completions", tok(PROPOSER),
            {"messages": [{"role": "user",
                           "content": "Triage this case and propose a disposition."}],
             "metadata": {"case_id": case_id}})
    if not check(r.status_code == 200, "agent-triage run accepted", r.text[:160]):
        return 1
    run_id = r.json()["data"]["run_id"]

    proposal_id = None
    for _ in range(60):
        pr = api("GET", f"{AR}/api/v1/proposals?status=pending&limit=50", tok(APPROVER))
        for p in (pr.json().get("data") or []) if pr.ok else []:
            if p.get("run_id") == run_id:
                proposal_id = p.get("id")  # the list serialises it as `id`
        if proposal_id:
            break
        time.sleep(5)
    if not check(bool(proposal_id), "the run produced a PENDING proposal",
                 "an agent that writes without proposing is the failure this "
                 "platform exists to prevent"):
        return 1

    # --- 2. a different human approves --------------------------------------
    dr = api("POST", f"{AR}/api/v1/proposals/{proposal_id}/decide", tok(APPROVER),
             {"action": "approve"})
    if not check(dr.status_code == 200 and dr.json()["data"]["status"] == "approved",
                 "a DIFFERENT human approved it", dr.text[:160]):
        return 1

    # --- 3. THE ASSERTION THAT MATTERS --------------------------------------
    # Everything above is the platform telling us things went well. Only this
    # proves it. Poll: the write federates through tool-plane to case-service.
    after = before
    for _ in range(24):
        time.sleep(5)
        after = get_case(case_id)
        if after.get("disposition_id") and after.get("disposition_id") != before.get("disposition_id"):
            break

    changed = bool(after.get("disposition_id")) and \
        after.get("disposition_id") != before.get("disposition_id")
    ok = check(changed, "THE CASE ACTUALLY CHANGED",
               f"disposition {before.get('disposition_id') or '(none)'} -> "
               f"{after.get('disposition_id') or '(none)'}")

    if not ok:
        # The reason is never in the proposal -- it is in tool-plane's
        # invocation_log, and (since the execution-outcome fix) on the proposal
        # itself as decision.execution. Say so, so the next person does not
        # rediscover this the hard way.
        print("\n  The proposal will still read `approved`. That is the bug shape.")
        print("  Look here for the real reason:")
        print("    psql -d tool_plane -c \"select tool_id, decision, deny_reason "
              "from invocation_log order by created_at desc limit 3\"")
        print("    psql -d agent_runtime -c \"select decision from proposals "
              f"where proposal_id='{proposal_id}'\"")

    print("\n" + ("PASS -- governed write loop intact\n" if not _fail
                  else f"FAIL -- {len(_fail)} check(s): {', '.join(_fail)}\n"))
    return 0 if not _fail else 1


if __name__ == "__main__":
    sys.exit(main())
