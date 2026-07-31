#!/usr/bin/env python3
"""Does installing a vertical pack actually CHANGE THE PLATFORM — and does
uninstalling it actually put things back?

The claim this gates: Datacern ships 28 production packs, and installing one
configures a tenant's case taxonomy, intake form, roles and decision surfaces
without code. Today that claim is checked by `packctl lint` (static manifest
rules) and `packctl coherence` (cross-file consistency) — both of which run
against FILES. Neither installs anything. A pack whose manifest is perfect and
whose installer silently no-ops would pass both.

So this asserts on STATE in the DOWNSTREAM services, never on the install
ledger. The ledger is the platform's own account of what it did; the rows in
case-service and rbac are what actually happened.

Three of the checks exist specifically to catch a gate or a reversal that only
LOOKS real:
  * a refused install must materialize NOTHING (not "refuse, then install");
  * a dry-run plan must materialize NOTHING (it is a plan, not a soft install);
  * drift detection must go RED when a human edits a materialized object —
    an always-in_sync detector is worse than none, because it certifies
    configuration nobody re-checked.

The arc:
  1. GATE      a fresh tenant without the pack SKU is REFUSED (403 naming the
               pack, or 503 fail-closed) and nothing lands in Core
  2. PLAN      with the SKU granted, dry_run returns a real plan and STILL
               materializes nothing
  3. INSTALL   execute → the pack's declared case fields, dispositions and
               roles exist as rows in case-service / rbac
  4. LAYOUT    the installed case fields carry the pack's field_meta layout
               (group / order / widget) — "install the pack and the intake
               form rearranges itself" is a materialized fact, not a doc claim
  5. DRIFT     a freshly-installed pack reads in_sync; edit ONE materialized
               object in Core and drift reports exactly that object modified
  6. UNINSTALL kinds whose Core service exposes a delete verb are really GONE;
               kinds without one are RETAINED and tombstoned — the honest gap
               (PKG-FR-025) proven as a gap, not papered over

Needs a running stack (`make up`). Usage:
    deploy/e2e/.venv/bin/python deploy/e2e/test_packs_journey.py
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
import yaml  # noqa: E402

RUN = uuid.uuid4().hex[:8]

# The pack under test. Chosen because it is a flagship vertical whose inc1
# components all materialize into services this stack runs, AND because it is
# the pack that ships an intake-form LAYOUT (schema-driven-forms slice 4) — so
# step 4 closes that loop against a real install.
PACK = "payer-fwa-siu"
PACK_DIR = REPO / "packs" / PACK

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


def api(method, url, token, body=None, timeout=300):
    return requests.request(method, url, json=body, timeout=timeout,
                            headers={"Authorization": f"Bearer {token}",
                                     "Content-Type": "application/json"})


def psql(sql: str, db: str = "postgres") -> str:
    return subprocess.run(
        ["psql", "-h", "localhost", "-U", "datacern", "-d", db, "-tA", "-c", sql],
        env={"PGPASSWORD": "datacern_dev", "PATH": "/usr/bin:/bin:/usr/local/bin:/usr/lib/postgresql/16/bin"},
        capture_output=True, text=True, check=True,
    ).stdout.strip()


def pack_component(rel: str):
    """Read one of the pack's own component files — the journey asserts against
    what the PACK declares, not against names hardcoded here, so a pack edit
    that drops a field turns this red instead of silently narrowing the test."""
    return yaml.safe_load((PACK_DIR / rel).read_text())


def field_count(tenant: str, ws: str) -> int:
    return int(psql("SELECT count(*) FROM case_fields WHERE tenant_id = "
                    f"'{tenant}' AND workspace_id = '{ws}' AND deleted_at IS NULL",
                    db="case_svc") or 0)


def main() -> int:  # noqa: PLR0911, PLR0912, PLR0915
    print(f"\nPack conformance journey (run {RUN}) -- does installing {PACK} change the platform?\n")
    su = c.superadmin_token()

    declared_fields = pack_component("cases/fields.yaml")
    declared_disps = pack_component("cases/dispositions.yaml")
    check(bool(declared_fields and declared_disps),
          f"{PACK} declares {len(declared_fields)} case fields + {len(declared_disps)} dispositions")

    # ---- a fresh tenant, so no leftover entitlement can fake the gate -------
    r = api("POST", f"{c.IDENTITY}/api/v1/tenants", su,
            {"name": f"journey-packs-{RUN}", "display_name": "Packs Journey Co",
             "owner_email": f"owner-{RUN}@journey.test", "tier": "pool", "cloud": "aws"})
    if r.status_code not in (200, 201, 202):
        return bail("tenant provisioned", f"{r.status_code} {r.text[:160]}")
    tenant = (r.json().get("tenant") or r.json()).get("id") or r.json().get("id")
    check(bool(tenant), "tenant provisioned")

    r = api("POST", f"{c.RBAC}/api/v1/admin/tenants/{tenant}/seed", su, {})
    check(r.status_code == 200, "rbac tenant seed", r.text[:140])

    # The seeder's durable-membership recipe (streams/learn journeys use the
    # same): a real Admin grant, not a scope shortcut.
    gid = psql("SELECT id FROM groups WHERE tenant_id = "
               f"'{tenant}' AND group_type = 'permission' AND lower(name) = 'admin'", db="rbac")
    if not check(bool(gid), "tenant Admin permission group exists"):
        return bail("rbac groups")
    psql("INSERT INTO members (id, tenant_id, group_id, user_id) VALUES "
         f"('{uuid.uuid4()}', '{tenant}', '{gid}', 'u-pack-admin') "
         "ON CONFLICT (group_id, user_id) DO NOTHING", db="rbac")
    api("POST", f"{c.RBAC}/api/v1/admin/projection/rebuild?tenant={tenant}", su, {})

    ws = psql("SELECT id FROM workspaces WHERE tenant_id = "
              f"'{tenant}' ORDER BY created_at LIMIT 1", db="rbac")
    if not check(bool(ws), "default workspace resolved"):
        return bail("workspace")
    tok = c.user_token("u-pack-admin", tenant, ["*"], workspace_id=ws)

    # rbac materializes perm:* asynchronously; a pre-projection call is a 403
    # about authz, not about entitlements — poll a harmless read first.
    warm = False
    for _ in range(30):
        if api("GET", f"{c.PACK}/api/v1/installs", tok).status_code == 200:
            warm = True
            break
        time.sleep(2)
    if not check(warm, "rbac projection materialized (installs list stops 403ing)"):
        return bail("rbac projection")

    # ---- 1. GATE: refused, and nothing lands --------------------------------
    before_fields = field_count(tenant, ws)
    r = api("POST", f"{c.PACK}/api/v1/installs", tok, {"pack": PACK, "workspace_id": ws})
    refused = r.status_code in (402, 403, 503)
    body = r.text.lower()
    check(refused and (PACK in body or "entitle" in body or "sku" in body),
          "without the pack SKU the install is REFUSED (gate precedes materialization)",
          f"{r.status_code} {r.text[:180]}")
    if not refused:
        return bail("gate closed pre-grant")
    if not check(field_count(tenant, ws) == before_fields,
                 "the refused install materialized NOTHING"):
        return bail("refused install leaked rows")

    # ---- 2. the SKU is a commercial-plane act -------------------------------
    r = api("POST", f"{c.IDENTITY}/api/v1/platform/tenants/{tenant}/entitlements/overrides", su,
            {"kind": "pack_sku", "key": PACK, "reason": "journey-packs"})
    if not check(r.status_code == 200, "pack SKU granted via the commercial plane", r.text[:160]):
        return bail("sku grant")

    # Poll a dry run until it stops 503ing. NOTE what this does and does NOT
    # prove: pack-service returns the plan for a dry run whether or not the SKU
    # is entitled (it only refuses on EXECUTE), so a 200 here means the
    # projection became READABLE — not that the SKU landed in it. The install
    # below carries its own retry for the propagation window.
    plan = None
    for _ in range(30):
        pr = api("POST", f"{c.PACK}/api/v1/installs", tok,
                 {"pack": PACK, "workspace_id": ws, "dry_run": True})
        if pr.status_code == 200:
            plan = (pr.json().get("data") or {}).get("plan") or []
            break
        time.sleep(2)
    if not check(plan is not None, "entitlements projection became readable (503 → plan within 60s)"):
        return bail("entitlement projection")

    kinds = {op.get("kind") for op in plan}
    check("case_fields" in kinds and "dispositions" in kinds,
          "the plan names the pack's real components", f"kinds={sorted(kinds)}")
    if not check(field_count(tenant, ws) == before_fields,
                 "the DRY RUN materialized nothing (a plan is not a soft install)"):
        return bail("dry run materialized")

    # ---- 3. INSTALL: assert on Core's rows, not on the ledger ---------------
    # Retry across the projection's propagation window: the grant is a
    # commercial-plane write that reaches ent:{tenant}:flat asynchronously, and
    # EXECUTE (unlike the dry run above) is the call that actually checks it.
    r = None
    for _ in range(30):
        r = api("POST", f"{c.PACK}/api/v1/installs", tok, {"pack": PACK, "workspace_id": ws})
        if r.status_code != 403:
            break
        time.sleep(2)
    if r is None or r.status_code not in (200, 201):
        return bail("install executed",
                    f"{r.status_code if r else '-'} {r.text[:220] if r else ''}")
    data = r.json().get("data") or {}
    install_id = data.get("id")
    summary = data.get("summary") or {}
    check(data.get("status") in ("installed", "awaiting_approval"),
          f"install completed (status={data.get('status')}, summary={summary})",
          json.dumps(data)[:220])
    if summary.get("failed"):
        # Named, not summarized: a failed op tells you WHICH component broke.
        failures = [x for x in (data.get("ledger") or []) if x.get("action") == "failed"][:5]
        check(False, "no component failed to materialize", json.dumps(failures)[:400])

    want_fields = {f["name"] for f in declared_fields}
    got_fields = set(psql(
        "SELECT string_agg(name, ',') FROM case_fields WHERE tenant_id = "
        f"'{tenant}' AND workspace_id = '{ws}' AND deleted_at IS NULL", db="case_svc").split(",")) - {""}
    check(want_fields <= got_fields,
          f"all {len(want_fields)} declared case fields exist as ROWS in case-service",
          f"missing={sorted(want_fields - got_fields)}")

    want_codes = {d["code"] for d in declared_disps}
    got_codes = set(psql(
        "SELECT string_agg(code, ',') FROM dispositions WHERE tenant_id = "
        f"'{tenant}' AND workspace_id = '{ws}'", db="case_svc").split(",")) - {""}
    check(want_codes <= got_codes,
          f"all {len(want_codes)} declared dispositions exist as ROWS in case-service",
          f"missing={sorted(want_codes - got_codes)}")

    roles_doc = pack_component("rbac/roles.yaml")
    want_roles = {r_["name"] for r_ in roles_doc} if isinstance(roles_doc, list) else set()
    if want_roles:
        got_roles = set(psql(
            "SELECT string_agg(name, ',') FROM roles WHERE tenant_id = "
            f"'{tenant}'", db="rbac").split(",")) - {""}
        check(want_roles <= got_roles,
              f"all {len(want_roles)} declared roles exist as ROWS in rbac",
              f"missing={sorted(want_roles - got_roles)}")

    # ---- 4. LAYOUT: the pack shipped a form, and the form materialized ------
    # schema-driven-forms slice 4's claim, checked against a real install: the
    # pack's field_meta layout hints survive into case-service's catalog.
    laid_out = [f for f in declared_fields if (f.get("field_meta") or {}).get("group")]
    if laid_out:
        probe = laid_out[0]
        stored = psql(
            "SELECT field_meta FROM case_fields WHERE tenant_id = "
            f"'{tenant}' AND workspace_id = '{ws}' AND name = '{probe['name']}'", db="case_svc")
        meta = json.loads(stored) if stored else {}
        want = probe["field_meta"]
        check(meta.get("group") == want.get("group") and meta.get("order") == want.get("order"),
              "the pack's intake-form LAYOUT (group/order) materialized with the field",
              f"{probe['name']}: stored={stored[:160]}")
        widget_fields = [f for f in declared_fields if (f.get("field_meta") or {}).get("widget")]
        if widget_fields:
            wf = widget_fields[0]
            wstored = psql(
                "SELECT field_meta FROM case_fields WHERE tenant_id = "
                f"'{tenant}' AND workspace_id = '{ws}' AND name = '{wf['name']}'", db="case_svc")
            check(json.loads(wstored or "{}").get("widget") == wf["field_meta"]["widget"],
                  "a widget override materialized too", f"{wf['name']}: {wstored[:120]}")

    # ---- 5. DRIFT: in_sync now, RED after a human edit ----------------------
    r = api("GET", f"{c.PACK}/api/v1/installs/{install_id}/drift", tok)
    if r.status_code != 200:
        return bail("drift readable", f"{r.status_code} {r.text[:180]}")
    d = r.json().get("data") or {}
    check(d.get("inSync") is True,
          "a freshly installed pack reads in_sync",
          f"drifted={d.get('drifted')} summary={json.dumps(d.get('summary'))}")
    content_checked = (d.get("summary") or {}).get("content_checked", 0)
    if not check(content_checked > 0,
                 "drift actually COMPARED content (not presence-only, which cannot detect an edit)",
                 json.dumps(d.get("summary"))):
        return bail("drift is presence-only")

    # A human edits one materialized object in Core, the way an admin would.
    probe_name = sorted(want_fields)[0]
    fid = psql("SELECT id FROM case_fields WHERE tenant_id = "
               f"'{tenant}' AND workspace_id = '{ws}' AND name = '{probe_name}'", db="case_svc")
    r = api("PATCH", f"{c.CASE}/api/v1/case-fields/{fid}", tok,
            {"field_meta": {"label": "Edited by a human after install"}})
    if not check(r.status_code in (200, 204), "a human edited one materialized field",
                 f"{r.status_code} {r.text[:160]}"):
        return bail("edit failed")

    r = api("GET", f"{c.PACK}/api/v1/installs/{install_id}/drift", tok)
    d2 = (r.json().get("data") or {}) if r.status_code == 200 else {}
    modified = [o for o in (d2.get("objects") or []) if o.get("status") == "modified"]
    check(d2.get("inSync") is False and len(modified) >= 1,
          "drift went RED for the edited object (an always-green detector certifies nothing)",
          f"inSync={d2.get('inSync')} summary={json.dumps(d2.get('summary'))}")
    check(any(probe_name in json.dumps(o) for o in modified),
          "drift named the object that was actually edited",
          json.dumps(modified)[:300])

    # ---- 6. UNINSTALL: really gone vs honestly retained ---------------------
    r = api("POST", f"{c.PACK}/api/v1/installs/{install_id}/uninstall", tok, {})
    if r.status_code != 200:
        return bail("uninstall executed", f"{r.status_code} {r.text[:200]}")
    u = r.json().get("data") or {}
    check(u.get("reversed", 0) > 0,
          f"uninstall reversed real objects (reversed={u.get('reversed')}, "
          f"tombstoned={u.get('tombstoned')})")

    # case_fields IS in REVERSIBLE_KINDS -> the rows must be GONE from Core.
    left = set(psql(
        "SELECT string_agg(name, ',') FROM case_fields WHERE tenant_id = "
        f"'{tenant}' AND workspace_id = '{ws}' AND deleted_at IS NULL", db="case_svc").split(",")) - {""}
    check(not (want_fields & left),
          "reversible kind: the pack's case fields are GONE from case-service",
          f"still present={sorted(want_fields & left)}")

    # dispositions is NOT in REVERSIBLE_KINDS (case-service exposes no delete
    # verb for it). The contract says: retained, tombstoned in the ledger,
    # pack-origin cleared. Prove the retention rather than assuming the summary.
    still = set(psql(
        "SELECT string_agg(code, ',') FROM dispositions WHERE tenant_id = "
        f"'{tenant}' AND workspace_id = '{ws}'", db="case_svc").split(",")) - {""}
    check(want_codes <= still,
          "non-reversible kind: dispositions are RETAINED and tombstoned, "
          "not silently dropped (PKG-FR-025's honest gap, proven as a gap)",
          f"missing={sorted(want_codes - still)}")

    tombstoned = int(psql(
        "SELECT count(*) FROM materialized_objects "
        f"WHERE install_id = '{install_id}' AND tombstoned", db="pack") or 0)
    check(tombstoned > 0,
          "the ledger records the tombstones (the retained objects are accounted for)",
          f"tombstoned rows={tombstoned}")

    if _fail:
        print(f"\nFAIL -- {len(_fail)} check(s): {', '.join(_fail)}\n")
        return 1
    print(f"\nPASS -- installing {PACK} configured the tenant for real, drift caught a "
          "human edit, and uninstall reversed what Core can reverse.\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
