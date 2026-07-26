#!/usr/bin/env python3
"""Live-test agents through the REAL chat path — the one the UI copilot uses.

Why this exists separately from test_all_agents.py (replay): the two paths mint
DIFFERENT principals.

  POST /api/v1/replay                -> mint_agent_autonomous  (agent's own
                                        principal; has no RBAC grants, so every
                                        grounding read 403s)
  POST /agents/{k}/chat/completions  -> mint_agent_obo(user)   (on-behalf-of the
                                        signed-in user; authz resolves against
                                        THAT user's capabilities)

Only the second is what a person driving the copilot actually experiences, so
this is the run that decides whether the demo works. Runs are real (Run/Session/
Proposal rows are created) — that is deliberate: it proves the governed path.
"""
from __future__ import annotations
import json, os, sys, time
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "deploy" / "e2e" / "lib"))
import common as c  # noqa: E402
import requests  # noqa: E402

AR = "http://localhost:8306"
P = json.load(open(REPO / "deploy" / "local" / "run" / "personas.json"))
ADMIN = P[os.environ.get("DEMO_PERSONA", "admin@demo.datacern")]
TEN, WS = ADMIN["tenantId"], ADMIN["workspaceId"]
TOK = c.user_token(ADMIN["sub"], TEN, ["*"], workspace_id=WS)
H = {"Authorization": f"Bearer {TOK}", "Content-Type": "application/json"}

CASE_ID = sys.argv[1] if len(sys.argv) > 1 else None
DATASET = sys.argv[2] if len(sys.argv) > 2 else None

CASES = [
    ("analytics", "In one sentence, what is this case about?", {"case_id": CASE_ID}),
    ("case-triage", "Triage this case and propose a disposition.", {"case_id": CASE_ID}),
    ("dashboard-designer", "Design a dashboard showing dispute volume and recovered dollars by month.", {}),
    ("onboarding", "I have a Postgres database of card disputes — how should I onboard it?", {}),
    ("model-training", "Train a gradient boosting model to predict dispute severity.", {"dataset": DATASET}),
    ("inference", "Run batch scoring with the production model on the latest dataset.", {"dataset_id": DATASET}),
    ("ml-engineer", "Train candidates and propose the best model.", {"dataset": DATASET, "label_column": "severity"}),
    ("governance", "Should we retrain?", {"model_urn": f"wr:{TEN}:experiment:model/claims-fraud",
                                          "signals": {"drift_score": 0.45, "correction_count": 25}}),
    ("meta-router", "Build me a dashboard of dispute recovery by month.", {}),
]

def poll(run_id: str, budget_s: int = 180) -> dict:
    """Temporal mode returns immediately; the answer lands on the Run."""
    t0 = time.time()
    while time.time() - t0 < budget_s:
        r = requests.get(f"{AR}/api/v1/runs/{run_id}", headers=H, timeout=30)
        if r.status_code == 200:
            d = (r.json() or {}).get("data", {}) or {}
            if d.get("status") in ("completed", "failed", "awaiting_approval", "cancelled", "killed"):
                return d
        time.sleep(2)
    return {"status": "TIMEOUT"}

print(f"chat path | tenant={TEN[:8]} case={str(CASE_ID)[:8]}")
print(f"{'agent':<20} {'verdict':<8} {'secs':>6}  {'run status':<18} detail")
print("-" * 112)
results = []
for key, msg, inputs in CASES:
    inputs = {k: v for k, v in inputs.items() if v is not None}
    meta = {"inputs": inputs}
    if inputs.get("case_id"):
        meta["case_id"] = inputs["case_id"]
    t0 = time.time()
    try:
        r = requests.post(f"{AR}/api/v1/agents/{key}/chat/completions", headers=H, timeout=300,
                          json={"messages": [{"role": "user", "content": msg}], "metadata": meta})
        if r.status_code != 200:
            dt = time.time() - t0
            print(f"{key:<20} {'FAIL':<8} {dt:6.1f}  {'-':<18} HTTP {r.status_code} {r.text[:70]}")
            results.append((key, "FAIL", dt, f"HTTP {r.status_code} {r.text[:120]}")); continue
        data = (r.json() or {}).get("data", {}) or {}
        run_id = data.get("run_id")
        if data.get("mode") == "inline":
            d = data
            status = "completed"
        else:
            d = poll(run_id)
            status = d.get("status", "?")
        dt = time.time() - t0
        text = (d.get("final_text") or data.get("final_text") or "").strip()
        pid = d.get("proposal_id") or data.get("proposal_id")
        verdict = "PASS" if status in ("completed", "awaiting_approval") and (text or pid) else \
                  ("EMPTY" if status in ("completed", "awaiting_approval") else "FAIL")
        detail = f"proposal={str(pid)[:8] or '-'} text={text[:52]!r}"
        print(f"{key:<20} {verdict:<8} {dt:6.1f}  {status:<18} {detail}")
        results.append((key, verdict, dt, f"{status} {detail}"))
    except Exception as e:
        dt = time.time() - t0
        print(f"{key:<20} {'FAIL':<8} {dt:6.1f}  {'-':<18} {type(e).__name__}: {str(e)[:70]}")
        results.append((key, "FAIL", dt, str(e)[:120]))

print("-" * 112)
p = sum(1 for _, v, _, _ in results if v == "PASS")
e = sum(1 for _, v, _, _ in results if v == "EMPTY")
f = sum(1 for _, v, _, _ in results if v == "FAIL")
print(f"{len(results)} agents via CHAT: {p} PASS, {e} EMPTY, {f} FAIL | {sum(d for _,_,d,_ in results):.0f}s")
json.dump([{"agent": k, "verdict": v, "secs": round(d,1), "detail": x} for k,v,d,x in results],
          open("/private/tmp/claude-501/-Users-girithammisetty-Projects-Nemesis/"
               "49bf2f33-7bbf-4657-b815-f1de419dfede/scratchpad/agent_chat_results.json","w"), indent=1)
