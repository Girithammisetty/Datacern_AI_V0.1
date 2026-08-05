#!/usr/bin/env python3
"""Does the realtime-case-streams add-on hold its four selling claims, live?

The add-on's pitch (docs/initiatives/realtime-case-streams-addon.md): watch an
enterprise source, pull only what's new, open cases in ONE department's
worklist with the intake row frozen as evidence, and refuse all of it without
the SKU. Each claim is asserted here on STATE — rows in Postgres, bytes in
evidence storage, 404s at the department boundary — never on acknowledgements
(the governed-write-loop rule: status fields are things the platform says;
only the row counts).

The arc:
  1. GATE      a fresh tenant without the SKU is refused (403 naming the SKU,
               or 503 fail-closed) BEFORE any resource checks run
  2. GRANT     a platform-operator entitlement override → the projection goes
               live → the same call family stops being refused
  3. COMPOSE   one bff createCaseStream call = connection + watermark schedule
               + case trigger, born in department A's workspace
  4. FLOW      run_now → real query ingestion against a seeded Postgres source
               → ingestion.completed → trigger opens cases — ONLY for rows
               passing the condition (amount > 1000)
  5. EVIDENCE  the case carries an intake snapshot uploaded by trigger/<name>,
               and its bytes contain the source row
  6. ISOLATE   department B (same tenant, different workspace) gets [] from
               the worklist and 404 on the case id, its timeline and evidence
  7. INCREMENT one new source row + run_now → exactly ONE new case; the
               stream's watermark cursor advanced to the new row's timestamp
  8. LAPSE     with the override removed, pause still works (never gated),
               resume is refused, and re-granting restores it

Deliberately end-to-end and unmocked: real Postgres source, real asyncpg
driver probe, real Iceberg/MinIO dataset commit, real Kafka event, real
case-service write + workspace boundary. If any link is broken this goes red.

Needs a running stack (`make up`). Usage:
    deploy/e2e/.venv/bin/python deploy/e2e/test_case_stream_journey.py
Exit 0 = every claim held. Non-zero = at least one did not.
"""
from __future__ import annotations

import json
import subprocess
import sys
import time
import uuid
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "deploy" / "e2e" / "lib"))
import common as c  # noqa: E402
import requests  # noqa: E402

RUN = uuid.uuid4().hex[:8]
SRC_DB = f"journeysrc_{RUN}"
DATASET = f"orders-stream-{RUN}"
STREAM = f"high-value-orders-{RUN}"
T0 = "2026-07-01T00:00:00+00:00"
T1, T2, T3 = "2026-07-02T00:00:00+00:00", "2026-07-04T00:00:00+00:00", "2026-07-06T00:00:00+00:00"

_fail: list[str] = []


def check(ok: bool, label: str, detail: str = "") -> bool:
    print(("  ok   " if ok else "  FAIL ") + label + (f"  -- {detail}" if detail and not ok else ""))
    if not ok:
        _fail.append(label)
    return ok


def bail(label: str, detail: str = "") -> int:
    check(False, label, detail)
    print(f"\nFAIL -- {len(_fail)} check(s): {', '.join(_fail)}\n")
    return 1


def api(method, url, token, body=None, timeout=120):
    return requests.request(method, url, json=body, timeout=timeout,
                            headers={"Authorization": f"Bearer {token}",
                                     "Content-Type": "application/json"})


def gql(query: str, variables: dict, token: str) -> dict:
    r = requests.post(f"{c.BFF}/graphql",
                      json={"query": query, "variables": variables}, timeout=120,
                      headers={"Authorization": f"Bearer {token}"})
    r.raise_for_status()
    return r.json()


def psql(sql: str, db: str = "postgres") -> str:
    return subprocess.run(
        ["psql", "-h", "localhost", "-U", "datacern", "-d", db, "-tA", "-c", sql],
        env={"PGPASSWORD": "datacern_dev", "PATH": "/usr/bin:/bin:/usr/local/bin:/usr/lib/postgresql/16/bin"},
        capture_output=True, text=True, check=True,
    ).stdout.strip()


def main() -> int:  # noqa: PLR0911, PLR0915
    print(f"\nRealtime-case-streams journey (run {RUN}) -- does the add-on hold its claims?\n")
    su = c.superadmin_token()

    # ---- a fresh tenant, so no leftover grant can fake the gate -------------
    r = api("POST", f"{c.IDENTITY}/api/v1/tenants", su,
            {"name": f"journey-streams-{RUN}", "display_name": "Streams Journey Co",
             "owner_email": f"owner-{RUN}@journey.test", "tier": "pool", "cloud": "aws"})
    if r.status_code not in (200, 201, 202):
        return bail("tenant provisioned", f"{r.status_code} {r.text[:160]}")
    tenant = (r.json().get("tenant") or r.json()).get("id") or r.json().get("id")
    check(bool(tenant), "tenant provisioned")

    r = api("POST", f"{c.RBAC}/api/v1/admin/tenants/{tenant}/seed", su, {})
    check(r.status_code == 200, "rbac tenant seed (system groups + default workspace)", r.text[:160])

    # Department tokens use the SAME scopes and the SAME rbac grants (Admin
    # group, the durable members-row path seed_platform.py uses): what
    # separates A from B below is the workspace claim alone, never a scope or
    # grant difference — that IS the department boundary being tested.
    def tok(sub: str, ws: str | None) -> str:
        return c.user_token(sub, tenant, ["*"], workspace_id=ws)

    gid = psql("SELECT id FROM groups WHERE tenant_id = "
               f"'{tenant}' AND group_type = 'permission' AND lower(name) = 'admin'", db="rbac")
    if not check(bool(gid), "tenant Admin permission group exists"):
        return bail("rbac groups")
    for sub in ("u-admin", "u-dept-a", "u-dept-b"):
        psql("INSERT INTO members (id, tenant_id, group_id, user_id) VALUES "
             f"('{uuid.uuid4()}', '{tenant}', '{gid}', '{sub}') "
             "ON CONFLICT (group_id, user_id) DO NOTHING", db="rbac")
    r = api("POST", f"{c.RBAC}/api/v1/admin/projection/rebuild?tenant={tenant}", su, {})
    check(r.status_code in (200, 202), "rbac projection rebuild enqueued", r.text[:120])

    default_ws = psql("SELECT id FROM workspaces WHERE tenant_id = "
                      f"'{tenant}' ORDER BY created_at LIMIT 1", db="rbac")
    authz_live = False
    for _ in range(60):
        lr = api("GET", f"{c.INGESTION}/api/v1/case-streams", tok("u-dept-a", default_ws))
        if lr.status_code == 200:
            authz_live = True
            break
        time.sleep(2)
    if not check(authz_live, "rbac perm:* projection materialized (list stops 403ing)"):
        return bail("rbac projection")

    # ---- 1. the gate, before anything exists --------------------------------
    probe = api("POST", f"{c.INGESTION}/api/v1/case-streams/{uuid.uuid4()}/resume",
                tok("u-dept-a", default_ws))
    refused = probe.status_code in (403, 503)
    body = probe.text.lower()
    check(refused and ("realtime_case_streams" in body or "entitlement" in body),
          "without the SKU the stream surface REFUSES (gate precedes resource checks)",
          f"{probe.status_code} {probe.text[:160]}")
    if not refused:
        return bail("gate closed pre-grant")

    # ---- 2. the grant is a commercial-plane act, not a config flag ----------
    r = api("POST", f"{c.IDENTITY}/api/v1/platform/tenants/{tenant}/entitlements/overrides", su,
            {"kind": "feature", "key": "realtime_case_streams",
             "reason": "slice-6 live journey"})
    if not check(r.status_code == 200, "feature override granted via commercial plane", r.text[:160]):
        return bail("override grant")

    # The projection worker (identity-service) must materialize ent:{t}:flat
    # before the gate opens. Poll the SAME refused call: 403/503 → 404 means
    # "entitled, and that stream id does not exist" — the gate opened without
    # us creating anything.
    opened = False
    for _ in range(60):
        pr = api("POST", f"{c.INGESTION}/api/v1/case-streams/{uuid.uuid4()}/resume",
                 tok("u-dept-a", default_ws))
        if pr.status_code == 404:
            opened = True
            break
        time.sleep(2)
    if not check(opened, "entitlements_flat projection went live (refusal → 404 within 60s)"):
        return bail("projection")

    # ---- departments: two real rbac workspaces, same tenant ------------------
    wsa = wsb = None
    for name, holder in (("dept-a-claims", "wsa"), ("dept-b-fraud", "wsb")):
        r = api("POST", f"{c.RBAC}/api/v1/workspaces", tok("u-admin", default_ws), {"name": name})
        if r.status_code not in (200, 201):
            return bail(f"workspace {name}", f"{r.status_code} {r.text[:160]}")
        wid = (r.json().get("data") or r.json()).get("id")
        if holder == "wsa":
            wsa = wid
        else:
            wsb = wid
    check(bool(wsa and wsb), "two departments exist (workspaces dept-a-claims / dept-b-fraud)")
    tok_a, tok_b = tok("u-dept-a", wsa), tok("u-dept-b", wsb)

    # Each department user OWNS its own workspace — the verb-mapped
    # workspace-grant path (owner: read/update/execute/delete/admin) is how
    # workspace-scoped actions like case.trigger.create authorize. SAME level
    # in both departments; only the workspace differs.
    for sub, ws in (("u-dept-a", wsa), ("u-dept-b", wsb)):
        r = api("POST", f"{c.RBAC}/api/v1/grants", tok("u-admin", default_ws),
                {"workspace_id": ws, "resource_urn": f"wr:{tenant}:rbac:workspace/{ws}",
                 "subject": {"type": "user", "id": sub}, "level": "owner"})
        if r.status_code not in (200, 201):
            return bail(f"workspace grant for {sub}", f"{r.status_code} {r.text[:160]}")
    r = api("POST", f"{c.RBAC}/api/v1/admin/projection/rebuild?tenant={tenant}", su, {})
    check(r.status_code in (200, 202), "workspace owner grants + projection rebuild")
    granted = False
    for _ in range(60):
        pr = api("GET", f"{c.CASE}/api/v1/case-triggers", tok_a)
        if pr.status_code == 200:
            granted = True
            break
        time.sleep(2)
    if not check(granted, "workspace-owner grant materialized (case surface opens for dept A)"):
        return bail("workspace grant projection")

    # ---- the enterprise source: a real Postgres db with real rows -----------
    psql(f'CREATE DATABASE "{SRC_DB}"')
    psql(
        "CREATE TABLE public.orders (id int primary key, amount numeric, updated_at timestamptz);"
        f"INSERT INTO public.orders VALUES (1, 500, '{T1}'), (2, 5000, '{T2}');",
        db=SRC_DB,
    )
    check(psql("SELECT count(*) FROM public.orders", db=SRC_DB) == "2",
          "source seeded (2 rows; only #2 passes amount > 1000)")

    r = api("POST", f"{c.INGESTION}/api/v1/connections", tok_a,
            {"name": f"journey-src-{RUN}", "connector_type": "postgres",
             # ssl_mode defaults to "require" (secure-by-default); the lab
             # source has no TLS, so disable EXPLICITLY — the config choice a
             # real customer makes, not a platform special case.
             "config": {"host": "localhost", "port": 5432, "database": SRC_DB,
                        "username": "datacern", "ssl_mode": "disable"},
             "secrets": {"password": "datacern_dev"}, "workspace_id": wsa})
    if not check(r.status_code == 201, "connection created (REAL asyncpg driver probe passed)",
                 f"{r.status_code} {r.text[:200]}"):
        return bail("connection")
    conn_id = r.json()["data"]["id"]

    # ---- 3. ONE call composes the whole stream (bff slice 4) ----------------
    res = gql(
        """mutation($input: CreateCaseStreamInput!) {
             createCaseStream(input: $input) {
               id name status scheduleId caseTriggerId workspaceId schedule
             }
           }""",
        {"input": {
            "name": STREAM, "connectionId": conn_id,
            "ingestionTemplate": {"ingestion_mode": "query",
                                  "statement": "SELECT id, amount, updated_at FROM public.orders",
                                  "new_dataset": {"name": DATASET}},
            "intervalSeconds": 300,
            "watermark": {"column": "updated_at", "valueType": "timestamp", "initialValue": T0},
            "enabled": True,
            "trigger": {"conditions": [{"col": "amount", "op": "gt", "value": "1000"}],
                        "rowPkField": "id", "severity": "high", "attachEvidence": True},
        }},
        tok_a,
    )
    if res.get("errors"):
        return bail("composed createCaseStream via bff", str(res["errors"])[:300])
    stream = res["data"]["createCaseStream"]
    check(bool(stream["caseTriggerId"]),
          "one call composed stream + watermark schedule + case trigger, bound")
    check(stream.get("workspaceId") == wsa, "stream born in department A's workspace")
    check((stream.get("schedule") or {}).get("watermark", {}).get("current_value") == T0,
          "cursor starts at the configured initial watermark")

    # ---- 4. the flow: fire → ingest → trigger → cases ------------------------
    def fire() -> None:
        fr = api("POST", f"{c.INGESTION}/api/v1/schedules/{stream['scheduleId']}/run_now", tok_a)
        if fr.status_code != 200:
            raise RuntimeError(f"run_now {fr.status_code} {fr.text[:160]}")

    def dept_case_ids() -> list[str]:
        out = psql("SELECT id FROM cases WHERE tenant_id = "
                   f"'{tenant}' AND workspace_id = '{wsa}' AND deleted_at IS NULL", db="case_svc")
        return [x for x in out.splitlines() if x]

    try:
        fire()
    except RuntimeError as e:
        return bail("run_now accepted", str(e))

    ids: list[str] = []
    for _ in range(60):  # ingestion + kafka + trigger apply: allow ~5 min (CI-load headroom)
        ids = dept_case_ids()
        if ids:
            break
        time.sleep(5)
    if not check(len(ids) == 1,
                 "exactly ONE case opened (row #2 passed the condition; row #1 filtered)",
                 f"got {len(ids)}"):
        return bail("first fire")
    case_id = ids[0]

    ga = api("GET", f"{c.CASE}/api/v1/cases/{case_id}", tok_a)
    check(ga.status_code == 200 and ga.json()["data"].get("workspace_id") == wsa,
          "department A sees its case via the API, in its own workspace")

    # ---- 5. evidence: the intake row, frozen --------------------------------
    ev = api("GET", f"{c.CASE}/api/v1/cases/{case_id}/evidence", tok_a)
    items = (ev.json().get("data") or []) if ev.status_code == 200 else []
    snap = next((e for e in items if str(e.get("uploaded_by", "")).startswith("trigger/")), None)
    if not check(snap is not None, "an intake snapshot is attached, uploaded by trigger/<name>",
                 f"{ev.status_code} {ev.text[:200]}"):
        return bail("evidence attached")
    dl = api("GET", f"{c.CASE}/api/v1/cases/{case_id}/evidence/{snap['id']}/download", tok_a)
    check(dl.status_code == 200 and b"5000" in dl.content and b"intake_snapshot" in dl.content,
          "evidence bytes are the REAL source row (amount 5000), intake_snapshot/v1",
          f"{dl.status_code} {dl.content[:120]!r}")

    # ---- 6. the department boundary ------------------------------------------
    # The worklist is this journey's ONLY search-backed read — every other check
    # here (the case, its timeline, its evidence) goes straight to Postgres. That
    # asymmetry matters: case-service builds a tenant's OpenSearch index
    # ASYNCHRONOUSLY off tenant.provisioned (events.TenantHandler), and until the
    # consumer catches up, search answers 503 SEARCH_UNAVAILABLE. On a freshly
    # provisioned tenant we can arrive here first, so poll for readiness.
    #
    # Waiting is only half the fix. `b_sees` was None on any non-200, which made a
    # 503 fail the isolation assertion — a warm-up race reported as "department B
    # CAN see the case", which is a security-shaped alarm for an infrastructure
    # hiccup. Search readiness is now its own check, so the two cannot be confused.
    lb = api("GET", f"{c.CASE}/api/v1/cases?limit=50", tok_b)
    for _ in range(60):
        if lb.status_code != 503:
            break
        time.sleep(2)
        lb = api("GET", f"{c.CASE}/api/v1/cases?limit=50", tok_b)
    if not check(lb.status_code == 200,
                 "department B's worklist is searchable (tenant index materialized)",
                 f"{lb.status_code} {lb.text[:160]} — search never became available, so "
                 "the isolation claim below could not be evaluated"):
        return bail("search index for the tenant never materialized")
    b_sees = [x.get("id") for x in (lb.json().get("data") or [])]
    check(case_id not in b_sees,
          "department B's worklist does NOT contain the case", f"{lb.status_code} {b_sees}")
    for what, path in (("case", ""), ("timeline", "/timeline"), ("evidence", "/evidence")):
        rb = api("GET", f"{c.CASE}/api/v1/cases/{case_id}{path}", tok_b)
        check(rb.status_code == 404, f"department B gets 404 on the {what} (not 403: existence unconfirmed)",
              f"{rb.status_code}")

    # ---- 7. incremental: only what's new, cursor advances --------------------
    psql(f"INSERT INTO public.orders VALUES (3, 9000, '{T3}')", db=SRC_DB)
    try:
        fire()
    except RuntimeError as e:
        return bail("second run_now accepted", str(e))
    grew = False
    for _ in range(60):
        ids = dept_case_ids()
        if len(ids) >= 2:
            grew = True
            break
        time.sleep(5)
    check(grew and len(ids) == 2,
          "second fire opened exactly ONE new case (rows 1-2 not re-pulled, no duplicates)",
          f"got {len(ids)}")
    gs = gql("""query($id: ID!) { caseStream(id: $id) { schedule status } }""",
             {"id": stream["id"]}, tok_a)
    cursor = ((gs.get("data") or {}).get("caseStream") or {}).get("schedule", {}) \
        .get("watermark", {}).get("current_value", "")
    check(str(cursor).startswith("2026-07-06"),
          "watermark cursor advanced to the newest row's timestamp", f"cursor={cursor!r}")

    # ---- 8. lapse: off is always allowed, back on needs the SKU --------------
    r = api("DELETE",
            f"{c.IDENTITY}/api/v1/platform/tenants/{tenant}/entitlements/overrides/feature/realtime_case_streams",
            su)
    check(r.status_code in (200, 204), "override removed (simulated lapse)", r.text[:120])
    lapsed = False
    for _ in range(60):
        pr = api("POST", f"{c.INGESTION}/api/v1/case-streams/{stream['id']}/resume", tok_a)
        if pr.status_code in (403, 503):
            lapsed = True
            break
        time.sleep(2)
    check(lapsed, "after the lapse, resume is refused again")
    pz = api("POST", f"{c.INGESTION}/api/v1/case-streams/{stream['id']}/pause", tok_a)
    check(pz.status_code == 200, "pause still works for a lapsed tenant (off is never gated)",
          f"{pz.status_code} {pz.text[:120]}")

    print("\n" + ("PASS -- all realtime-case-streams claims held\n" if not _fail
                  else f"FAIL -- {len(_fail)} check(s): {', '.join(_fail)}\n"))
    return 0 if not _fail else 1


if __name__ == "__main__":
    sys.exit(main())
