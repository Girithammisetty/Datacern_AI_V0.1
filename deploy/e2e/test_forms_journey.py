#!/usr/bin/env python3
"""Can a customer shape the case intake form WITHOUT code — and does the platform
hold the values it promised to hold?

The schema-driven-forms add-on's pitch (docs/initiatives/schema-driven-forms-
addon.md): a tenant (or a pack) declares typed intake fields with layout hints,
the form renders them with no deploy, AI drafts values from evidence as
SUGGESTIONS, the human edits and submits, and what lands on the case is exactly
what was submitted — type-checked against the declaration.

Every claim below is asserted on STATE: rows in case-service's Postgres, the
form model the bff actually serves, the case's stored custom_fields JSONB. Never
on acknowledgements. Two of the checks exist specifically to prove a REFUSAL is
real (a wrong type and a missing required field write NOTHING), because a
validation message with a row written anyway is worse than no validation.

The arc:
  1. DECLARE    typed fields with field_meta layout hints land in the catalog
  2. SERVE      the bff's caseForm hoists `required` and preserves the hints —
                the declaration reaches a renderer unchanged
  3. REFUSE     wrong type / undeclared key / missing required are each 4xx AND
                leave the case count unchanged
  4. DRAFT      real ai-gateway -> real Ollama: suggestions come back inside the
                declared catalog, typed, and NOTHING is written
  5. SUBMIT     the human's create stores exactly the submitted values, typed
                (a float stays a number, an enum stays a declared option)
  6. METER      the draft left a request_log row on the CALLER's tenant,
                attributed to the human's own sub — drafting is budgeted and
                metered like any other model call, not a side-door LLM path

Needs a running stack (`make up`). Usage:
    deploy/e2e/.venv/bin/python deploy/e2e/test_forms_journey.py
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
DATASET_URN_TMPL = "wr:{tenant}:dataset:dataset/forms-journey"

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
                      json={"query": query, "variables": variables}, timeout=180,
                      headers={"Authorization": f"Bearer {token}"})
    r.raise_for_status()
    return r.json()


def psql(sql: str, db: str = "postgres") -> str:
    return subprocess.run(
        ["psql", "-h", "localhost", "-U", "datacern", "-d", db, "-tA", "-c", sql],
        env={"PGPASSWORD": "datacern_dev", "PATH": "/usr/bin:/bin:/usr/local/bin:/usr/lib/postgresql/16/bin"},
        capture_output=True, text=True, check=True,
    ).stdout.strip()


def boot_tenant() -> str:
    """The tenant this stack booted with (deploy/e2e/run/context.env).

    This journey deliberately does NOT mint a fresh tenant like the streams and
    learn journeys do: ai-gateway binds a virtual key to one tenant, and the bff
    was booted with the key for THIS one. Drafting from a fresh tenant would be
    refused — which is the documented single-tenant limit, and step 6 pins it.
    """
    path = REPO / "deploy" / "e2e" / "run" / "context.env"
    for line in path.read_text().splitlines():
        if "TENANT_ID" in line and "=" in line:
            return line.split("=", 1)[1].strip().strip("'\"")
    raise SystemExit("no TENANT_ID in deploy/e2e/run/context.env -- run `make up` first")


# The customer's own intake form, authored as a pack would author it
# (packs/*/cases/fields.yaml): typed, with enum options, a required flag, and
# LAYOUT hints (group + order) that no code knows about.
FIELDS = [
    {"name": f"siu_referral_{RUN}", "data_type": "enum", "purpose": "both",
     "field_meta": {"label": "SIU referral", "options": ["yes", "no"],
                    "required": True, "group": "Lead", "order": 1}},
    {"name": f"exposure_{RUN}", "data_type": "float", "purpose": "both",
     "field_meta": {"label": "Exposure (USD)", "group": "Lead", "order": 2}},
    {"name": f"recovery_method_{RUN}", "data_type": "enum", "purpose": "both",
     "field_meta": {"label": "Recovery method", "widget": "radio",
                    "options": ["offset", "settlement", "demand"],
                    "group": "Recovery", "order": 10}},
    {"name": f"analyst_note_{RUN}", "data_type": "text", "purpose": "both",
     "field_meta": {"label": "Analyst note", "group": "Recovery", "order": 11}},
]
SIU, EXPOSURE, METHOD, NOTE = (f["name"] for f in FIELDS)

# Ids of the fields this run declared, so it can take them back out again.
#
# siu_referral_<RUN> is REQUIRED. Left in the catalog it does not just linger —
# it makes every LATER case creation in this tenant fail validation, because a
# required custom field must be supplied by whoever writes next. That is exactly
# what happened the first time the live Playwright suite ever executed (6f996fd):
# journey-forms passed, journey-packs passed, and then e2e:live died on
#
#   custom field "siu_referral_62c9bf60" is required   VALIDATION_FAILED
#
# for four separate specs. The leak had existed for as long as this journey has,
# and nothing downstream ever ran to notice — e2e:live had been skipped behind
# journey-packs on every previous run.
_DECLARED_IDS: list[str] = []
_TOK: str | None = None


def _undeclare(tok) -> None:
    """Remove the fields this run declared. A journey that mutates a SHARED
    tenant owes the next suite a clean catalog — case-service exposes a real
    DELETE for case fields (they are in packctl's REVERSIBLE_KINDS, and the packs
    journey asserts they are gone after uninstall), so this is a real revert and
    not a workaround."""
    for fid in _DECLARED_IDS:
        try:
            api("DELETE", f"{c.CASE}/api/v1/case-fields/{fid}", tok)
        except Exception:  # noqa: BLE001 — teardown must never mask the verdict
            pass

CASE_FORM_Q = """
query($mode: String) {
  caseForm(mode: $mode) {
    mode
    customFields { name dataType required custom fieldMeta }
  }
}"""

DRAFT_M = """
mutation($input: DraftCaseFieldsInput!) {
  draftCaseFields(input: $input) {
    fields { name value confidence sourceRef }
    unfilled model evidenceUsed
  }
}"""

# The material a human would paste into the AI panel: an adjuster's note that
# plainly supports some fields and says nothing about others.
EVIDENCE_TEXT = (
    "Adjuster note, file 88-2201. Vendor billed invoice INV-5540 twice within "
    "48 hours. Total at-risk exposure is 9000 USD. Referring this to SIU: yes. "
    "Proposed recovery method: offset against the next remittance."
)


def case_count(tenant: str, ws: str) -> int:
    out = psql("SELECT count(*) FROM cases WHERE tenant_id = "
               f"'{tenant}' AND workspace_id = '{ws}'", db="case_svc")
    return int(out or 0)


def main() -> int:  # noqa: PLR0911, PLR0915
    print(f"\nSchema-driven forms journey (run {RUN}) -- declare → serve → refuse → draft → submit\n")
    su = c.superadmin_token()
    tenant = boot_tenant()
    check(bool(tenant), "boot tenant resolved", tenant)

    # A FRESH WORKSPACE inside the boot tenant: custom fields are workspace-
    # scoped, so this gives a clean catalog without a fresh tenant (which would
    # break the gateway key binding — see boot_tenant()).
    default_ws = psql("SELECT id FROM workspaces WHERE tenant_id = "
                      f"'{tenant}' ORDER BY created_at LIMIT 1", db="rbac")
    if not check(bool(default_ws), "default workspace resolved"):
        return bail("workspace")

    admin_tok = c.user_token("u-forms-admin", tenant, ["*"], workspace_id=default_ws)
    r = api("POST", f"{c.RBAC}/api/v1/workspaces", admin_tok, {"name": f"forms-journey-{RUN}"})
    if r.status_code not in (200, 201):
        # fall back to the default workspace rather than failing the whole run
        ws = default_ws
        check(True, "workspace (reusing default -- create returned "
                    f"{r.status_code})")
    else:
        ws = (r.json().get("data") or r.json()).get("id")
    check(bool(ws), "journey workspace resolved", str(ws))

    # The seeder's durable-membership recipe (same as the streams/learn
    # journeys): a real rbac grant, not a scope shortcut.
    gid = psql("SELECT id FROM groups WHERE tenant_id = "
               f"'{tenant}' AND group_type = 'permission' AND lower(name) = 'admin'", db="rbac")
    if gid:
        psql("INSERT INTO members (id, tenant_id, group_id, user_id) VALUES "
             f"('{uuid.uuid4()}', '{tenant}', '{gid}', 'u-forms-admin') "
             "ON CONFLICT (group_id, user_id) DO NOTHING", db="rbac")
    if ws != default_ws:
        r = api("POST", f"{c.RBAC}/api/v1/grants", admin_tok,
                {"workspace_id": ws, "resource_urn": f"wr:{tenant}:rbac:workspace/{ws}",
                 "subject": {"type": "user", "id": "u-forms-admin"}, "level": "owner"})
        check(r.status_code in (200, 201), "workspace owner grant", r.text[:140])
    api("POST", f"{c.RBAC}/api/v1/admin/projection/rebuild?tenant={tenant}", su, {})

    tok = c.user_token("u-forms-admin", tenant, ["*"], workspace_id=ws)
    global _TOK
    _TOK = tok  # so teardown can revert the catalog from any of the 14 exit paths

    # rbac materializes the perm:* projection asynchronously; a field write
    # before it lands is a 403 that has nothing to do with this add-on. Poll a
    # harmless read until the grant is live (the streams-journey recipe).
    warm = False
    for _ in range(30):
        if api("GET", f"{c.CASE}/api/v1/case-fields", tok).status_code == 200:
            warm = True
            break
        time.sleep(2)
    if not check(warm, "rbac projection materialized (the catalog stops 403ing)"):
        return bail("rbac projection")

    # ---- 1. DECLARE ---------------------------------------------------------
    for f in FIELDS:
        r = api("POST", f"{c.CASE}/api/v1/case-fields", tok, f)
        if r.status_code not in (200, 201):
            return bail(f"declare field {f['name']}", f"{r.status_code} {r.text[:200]}")
        body = r.json()
        fid = (body.get("data") or body).get("id")
        if fid:
            _DECLARED_IDS.append(str(fid))
    declared = int(psql(
        "SELECT count(*) FROM case_fields WHERE tenant_id = "
        f"'{tenant}' AND workspace_id = '{ws}' AND name LIKE '%{RUN}' "
        "AND deleted_at IS NULL", db="case_svc") or 0)
    if not check(declared == len(FIELDS),
                 f"{len(FIELDS)} typed fields with layout hints are in the catalog",
                 f"got {declared}"):
        return bail("declare")

    # ---- 2. SERVE: the declaration reaches a renderer unchanged -------------
    body = gql(CASE_FORM_Q, {"mode": "create"}, tok)
    if body.get("errors"):
        return bail("caseForm served", json.dumps(body["errors"])[:220])
    served = {f["name"]: f for f in body["data"]["caseForm"]["customFields"]
              if f["name"].endswith(RUN)}
    check(len(served) == len(FIELDS), "every declared field is served on the create form",
          f"got {sorted(served)}")

    siu = served.get(SIU) or {}
    # `required` is authored inside field_meta and HOISTED by the form model —
    # before this add-on it died there, so a pack declaring a required field
    # rendered as optional.
    check(siu.get("required") is True,
          "required is hoisted out of field_meta (a pack's required field renders required)",
          json.dumps(siu)[:200])
    meta = siu.get("fieldMeta") or {}
    check(meta.get("group") == "Lead" and meta.get("order") == 1,
          "layout hints (group/order) survive to the renderer")
    check((served.get(METHOD, {}).get("fieldMeta") or {}).get("widget") == "radio",
          "widget override survives to the renderer")
    check(sorted(meta.get("options") or []) == ["no", "yes"],
          "enum options survive to the renderer")

    # ---- 3. REFUSE: and write nothing --------------------------------------
    before = case_count(tenant, ws)
    dataset_urn = DATASET_URN_TMPL.format(tenant=tenant)

    def create(custom: dict, rowpk: str):
        return api("POST", f"{c.CASE}/api/v1/cases", tok, {
            "dataset_urn": dataset_urn,
            "due_date": "2027-01-01T00:00:00Z",
            "severity": "medium",
            "custom_fields": custom,
            "rows": [{"row_pk": rowpk, "display_projection": {"invoice_no": "INV-5540"}}],
        })

    r = create({SIU: "yes", EXPOSURE: "not a number"}, f"bad-type-{RUN}")
    check(r.status_code == 422, "a value that does not fit the declared type is REFUSED",
          f"{r.status_code} {r.text[:160]}")

    r = create({SIU: "yes", f"secret_backdoor_{RUN}": "oops"}, f"bad-key-{RUN}")
    check(r.status_code == 422, "an undeclared field name is REFUSED",
          f"{r.status_code} {r.text[:160]}")

    r = create({SIU: "maybe"}, f"bad-enum-{RUN}")
    check(r.status_code == 422, "an enum value outside the declared options is REFUSED",
          f"{r.status_code} {r.text[:160]}")

    r = create({EXPOSURE: 9000.0}, f"missing-required-{RUN}")
    check(r.status_code == 422, "omitting a required field is REFUSED",
          f"{r.status_code} {r.text[:160]}")

    after = case_count(tenant, ws)
    if not check(after == before,
                 "every refusal wrote NOTHING (the case count did not move)",
                 f"{before} -> {after}"):
        return bail("refusals leaked rows")

    # ---- 4. DRAFT: suggestions, inside the catalog, writing nothing ---------
    # Timestamp read from the DB's own clock so step 6 compares like with like.
    draft_started = psql("SELECT now()", db="ai_gateway")
    body = gql(DRAFT_M, {"input": {"evidenceText": EVIDENCE_TEXT,
                                   "fieldNames": [SIU, EXPOSURE, METHOD, NOTE]}}, tok)
    errs = body.get("errors") or []
    drafting_configured = not any(
        "not configured" in (e.get("message") or "") for e in errs)
    if not drafting_configured:
        # An operator who did not wire AI_GATEWAY_VIRTUAL_KEY should read that
        # here, loudly, rather than have the journey quietly skip a claim.
        return bail("AI drafting is configured on this stack",
                    "AI_GATEWAY_VIRTUAL_KEY unset -- see deploy/local/up.sh::start_bff")
    if errs:
        return bail("draftCaseFields succeeded", json.dumps(errs)[:240])

    d = body["data"]["draftCaseFields"]
    names = [f["name"] for f in d["fields"]]
    known = {SIU, EXPOSURE, METHOD, NOTE}
    check(set(names) <= known,
          "every drafted name is inside the workspace's own catalog", f"got {names}")
    check(len(names) == len(set(names)), "no field is drafted twice", f"got {names}")
    check(d["evidenceUsed"] == ["provided text"],
          "the draft reports what it read", json.dumps(d["evidenceUsed"]))
    check(bool(d["model"]), "a real model answered (the gateway reported which)")
    # Whatever the model returned, the TYPES must already be right: the resolver
    # coerces or drops. A local 3B model is not reliable enough to assert WHICH
    # fields it fills, so assert the invariant that protects the human instead.
    typed = True
    for f in d["fields"]:
        v = f["value"]
        if f["name"] == EXPOSURE and not isinstance(v, (int, float)):
            typed = False
        if f["name"] == SIU and v not in ("yes", "no"):
            typed = False
        if f["name"] == METHOD and v not in ("offset", "settlement", "demand"):
            typed = False
    check(typed, "drafted values are typed to the declaration (coerced or dropped)",
          json.dumps(d["fields"])[:240])
    check(set(names) | set(d["unfilled"]) == known,
          "every requested field is either drafted or reported unfilled",
          f"{names} + {d['unfilled']}")

    mid = case_count(tenant, ws)
    if not check(mid == before, "drafting wrote NOTHING (it suggests; the human signs)",
                 f"{before} -> {mid}"):
        return bail("draft wrote rows")

    # ---- 5. SUBMIT: exactly what the human sent, typed ----------------------
    row_pk = f"forms-{RUN}"
    submitted = {SIU: "yes", EXPOSURE: 9000.0, METHOD: "offset",
                 NOTE: "Edited by the analyst before submitting."}
    r = create(submitted, row_pk)
    if r.status_code not in (200, 201):
        return bail("human create accepted", f"{r.status_code} {r.text[:200]}")

    stored_raw = psql(
        "SELECT custom_fields FROM cases WHERE tenant_id = "
        f"'{tenant}' AND workspace_id = '{ws}' AND row_pk = '{row_pk}'", db="case_svc")
    if not check(bool(stored_raw), "the case row exists", stored_raw[:120]):
        return bail("case row")
    stored = json.loads(stored_raw)
    check(stored == submitted,
          "the case stores EXACTLY the submitted values -- nothing added, nothing dropped",
          f"{stored} != {submitted}")
    # JSONB keeps 9000.0 a number; a form that shipped "9,000" would have rotted
    # the typed catalog into strings on the very first write.
    check(isinstance(stored.get(EXPOSURE), (int, float)),
          "a float field is stored as a NUMBER, not a formatted string",
          repr(stored.get(EXPOSURE)))

    created_by = psql(
        "SELECT created_by_id FROM cases WHERE tenant_id = "
        f"'{tenant}' AND workspace_id = '{ws}' AND row_pk = '{row_pk}'", db="case_svc")
    check(created_by == "u-forms-admin",
          "the case is attributed to the HUMAN who submitted it, not to the model",
          created_by)

    # ---- 6. METER: the draft is a governed model call ----------------------
    # The selling claim is that AI drafting runs through ai-gateway on the
    # CALLER's tenant, so it is budgeted, guardrailed and metered like any other
    # model call — not a side-door LLM path in the bff. That is only true if the
    # gateway logged it against this tenant and this human.
    logged = "0"
    for _ in range(10):  # the log commits on the gateway's own transaction
        logged = psql(
            "SELECT count(*) FROM request_log WHERE tenant_id = "
            f"'{tenant}' AND principal = 'u-forms-admin' AND request_class = 'chat' "
            f"AND created_at >= '{draft_started}'", db="ai_gateway") or "0"
        if int(logged) >= 1:
            break
        time.sleep(1)
    check(int(logged) >= 1,
          "the draft is metered on the CALLER's tenant, attributed to the human's sub",
          f"request_log rows since the draft: {logged}")

    # ---- 6. UNDECLARE: leave the shared tenant as we found it ---------------
    # Asserted, not assumed. The __main__ finally block is a safety net for the
    # bail paths; this proves the revert actually happens on the path that
    # matters, because a required field left behind breaks the NEXT suite rather
    # than this one — which is precisely why it went unnoticed until e2e:live
    # ran for the first time.
    _undeclare(tok)
    left = int(psql(
        "SELECT count(*) FROM case_fields WHERE tenant_id = "
        f"'{tenant}' AND workspace_id = '{ws}' AND name LIKE '%{RUN}' "
        "AND deleted_at IS NULL", db="case_svc") or 0)
    check(left == 0,
          "the run's fields are removed again (a REQUIRED field left behind "
          "fails every later case write in this tenant)",
          f"{left} still in the catalog")

    if _fail:
        print(f"\nFAIL -- {len(_fail)} check(s): {', '.join(_fail)}\n")
        return 1
    print("\nPASS -- the customer's own form is declared, served, enforced, "
          "drafted from, stored exactly as submitted, and withdrawn again.\n")
    return 0


if __name__ == "__main__":
    # finally, not a trailing call: main() has 14 exit paths, and a journey that
    # bails early is exactly when it is most likely to leave a required field
    # behind for the next suite to trip over.
    try:
        _rc = main()
    finally:
        if _TOK:
            _undeclare(_TOK)
    sys.exit(_rc)
