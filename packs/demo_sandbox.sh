#!/usr/bin/env bash
# Demo SANDBOX control — provision a demo tenant that arrives WITH A WORKLIST.
#
# Why this exists alongside demo.sh, which looks like it does the same thing:
#
#   packs/demo.sh load <pack>     installs the PACK — roles, case fields,
#                                 dispositions, dashboards, agents. It creates
#                                 ZERO cases, by design: every pack manifest
#                                 declares the no-dummy-data rule ("cases arrive
#                                 from real rows via triggers/intake, not
#                                 seeds"). A freshly loaded pack therefore shows
#                                 an EMPTY case worklist. That is correct
#                                 behaviour and surprises everyone once.
#
#   packs/demo_sandbox.sh load    provisions a profile=demo tenant through
#                                 identity-service's demo-sandbox path (BRD 70),
#                                 whose SeedDemoContent provisioning step applies
#                                 deploy/demo/<pack>/{data,personas,cases}.yaml
#                                 through the real Core APIs. Datasets, personas
#                                 AND cases. This is what you want when the thing
#                                 you are demoing or testing is case management.
#
# Bundles that seed cases today (deploy/demo/<pack>/cases.yaml):
#   card-disputes 8 · banking-aml 5 · insurance-claims-payer 5 · payer-fwa-siu 5
#
# Usage:
#   packs/demo_sandbox.sh load card-disputes          # provision + verify
#   packs/demo_sandbox.sh load card-disputes my-name  # explicit tenant name
#   packs/demo_sandbox.sh logins <tenant-id>          # register its logins with ui-web
#   packs/demo_sandbox.sh status <tenant-id>          # provisioning + case count
#   packs/demo_sandbox.sh reset  <tenant-id>          # re-seed to the baseline
#   packs/demo_sandbox.sh -n load card-disputes       # dry run
#
# Needs the local stack running (make up).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
PY="$REPO/deploy/e2e/.venv/bin/python"
IDENTITY="${IDENTITY_URL:-http://localhost:8301}"
CASE="${CASE_URL:-http://localhost:8308}"

RED=$'\033[31m'; GRN=$'\033[32m'; YEL=$'\033[33m'; BLD=$'\033[1m'; NC=$'\033[0m'
say(){ printf '%s\n' "$*"; }
die(){ printf '%sERROR%s %s\n' "$RED" "$NC" "$*" >&2; exit 1; }
ok(){  printf '%s  ok%s %s\n' "$GRN" "$NC" "$*"; }
warn(){ printf '%s  !!%s %s\n' "$YEL" "$NC" "$*"; }

DRY=0
{ [ "${1:-}" = "-n" ] || [ "${1:-}" = "--dry-run" ]; } && { DRY=1; shift; }
CMD="${1:-}"; PACK="${2:-}"; ARG3="${3:-}"

preflight(){
  [ -x "$PY" ] || die "e2e venv missing ($PY). Run ${BLD}make up${NC} first."
  # A dry run prints the call it WOULD make, so it must not require the stack.
  [ "$DRY" = 1 ] && return 0
  curl -fsS -m 3 "$IDENTITY/healthz" >/dev/null 2>&1 \
    || die "identity-service unreachable at $IDENTITY. Is the stack up (${BLD}make up${NC})?"
}

# The harness IdP mints the platform super-admin token, exactly as every other
# tool in deploy/e2e does. Nothing here invents a credential.
su_token(){ "$PY" "$REPO/deploy/e2e/lib/common.py" superadmin; }

bundles_with_cases(){
  for d in "$REPO"/deploy/demo/*/; do
    [ -f "${d}cases.yaml" ] && [ -f "${d}demo.yaml" ] && basename "$d"
  done
}

psql_tenant_id(){ # psql_tenant_id <name> -> uuid, best-effort
  PGPASSWORD=datacern_dev psql -h localhost -U datacern -d identity -tA \
    -c "SELECT id FROM tenants WHERE name = '$1' LIMIT 1" 2>/dev/null | tr -d '[:space:]'
}

api(){ # api METHOD PATH [JSON-BODY]
  local m="$1" p="$2" b="${3:-}"
  if [ -n "$b" ]; then
    curl -sS -X "$m" "$IDENTITY$p" -H "Authorization: Bearer $TOK" \
      -H 'Content-Type: application/json' -d "$b"
  else
    curl -sS -X "$m" "$IDENTITY$p" -H "Authorization: Bearer $TOK"
  fi
}

case_count(){ # case_count <tenant-id> -> integer, via case-service's own API
  local tid="$1" tok
  tok="$("$PY" - "$REPO" "$tid" <<'PYEOF'
import sys, os
sys.path.insert(0, os.path.join(sys.argv[1], "deploy", "e2e", "lib"))
import common as c
print(c.user_token("demo-sandbox-probe", sys.argv[2], ["*"]))
PYEOF
)"
  curl -sS "$CASE/api/v1/cases?limit=200" -H "Authorization: Bearer $tok" \
    | "$PY" -c 'import json,sys; print(len((json.load(sys.stdin).get("data") or [])))' 2>/dev/null \
    || echo "?"
}

# Merge a demo tenant's seeded personas into ui-web's dev-login map.
#
# WHY this is needed at all: demo_seed_runner.py invites REAL identity-service
# users (one per bundle persona), but ui-web's dev login resolves against
# DATACERN_PERSONAS — a JSON map read ONCE at ui-web boot from
# deploy/local/run/personas.json (up.sh::start_ui). Its contract is
# deliberately fail-closed: "when a personas map is present it is
# AUTHORITATIVE; an email that does not resolve is rejected (unknown user)"
# (services/ui-web/src/lib/auth/personas.ts). Nothing in the /demo-tenants path
# writes that file, so a freshly seeded sandbox's personas cannot log in no
# matter what you type. packs/demo.sh's own flow does the equivalent merge +
# ui-web restart; this path had no counterpart.
#
# Entry shape mirrors seed_platform.py::write_personas_env exactly.
pack_of_tenant(){ # pack_of_tenant <tenant-id> -> the bundle it was provisioned from
  # identity-service records it on the tenant (domain.Tenant.DemoPack), so a
  # caller never has to remember which bundle a sandbox came from.
  api GET "/api/v1/tenants/$1" \
    | "$PY" -c 'import json,sys; d=json.load(sys.stdin); print((d.get("tenant") or d).get("demo_pack",""))' \
      2>/dev/null || true
}

merge_personas(){ # merge_personas <tenant-id> <pack>
  local tid="$1" pk="$2" pfile="$REPO/deploy/local/run/personas.json"
  "$PY" - "$REPO" "$tid" "$pk" "$pfile" "$IDENTITY" "$(su_token)" <<'PYEOF'
import json, os, sys
import urllib.request

repo, tid, pack, pfile, identity, tok = sys.argv[1:7]
sys.path.insert(0, os.path.join(repo, "deploy", "e2e", "lib"))

bundle = os.path.join(repo, "deploy", "demo", pack, "personas.yaml")
try:
    import yaml
    people = yaml.safe_load(open(bundle)) or []
except Exception as e:                       # pyyaml absent -> say so, do not guess
    print(f"SKIP {e}", file=sys.stderr); sys.exit(3)

def get(url):
    r = urllib.request.Request(url, headers={"Authorization": f"Bearer {tok}"})
    with urllib.request.urlopen(r, timeout=15) as resp:
        return json.load(resp)

# the tenant's default workspace, from rbac via the same path the journeys use
ws = ""
try:
    import subprocess
    ws = subprocess.run(
        ["psql", "-h", "localhost", "-U", "datacern", "-d", "rbac", "-tA", "-c",
         f"SELECT id FROM workspaces WHERE tenant_id = '{tid}' ORDER BY created_at LIMIT 1"],
        env={**os.environ, "PGPASSWORD": "datacern_dev"},
        capture_output=True, text=True, check=True).stdout.strip()
except Exception:
    pass
if not ws:
    print("SKIP could not resolve the tenant's workspace", file=sys.stderr); sys.exit(3)

existing = {}
if os.path.exists(pfile):
    try:
        existing = json.load(open(pfile))
    except Exception:
        existing = {}

added = []
for p in people:
    # demo_seed_runner.py:184 builds persona emails as
    #   <local_part>@<tenant_id>.demo.datacern.ai
    email = f"{p['email_local_part']}@{tid}.demo.datacern.ai"
    sub = ""
    try:
        data = get(f"{identity}/api/v1/users?filter[email]={email}").get("data") or []
        if data:
            sub = data[0].get("id") or ""
    except Exception:
        pass
    if not sub:
        print(f"SKIP persona {email} has no identity user (did seeding run?)", file=sys.stderr)
        continue
    existing[email] = {"sub": sub, "tenantId": tid, "workspaceId": ws,
                       "scopes": ["*"], "profile": "demo"}
    added.append(email)

os.makedirs(os.path.dirname(pfile), exist_ok=True)
json.dump(existing, open(pfile, "w"))
for e in added:
    print(e)
PYEOF
}

case "$CMD" in
  list)
    say "${BLD}Bundles that seed cases${NC} (deploy/demo/<pack>/cases.yaml):"
    for b in $(bundles_with_cases); do
      n=$("$PY" -c "import yaml;print(len(yaml.safe_load(open('$REPO/deploy/demo/$b/cases.yaml')) or []))" 2>/dev/null || echo '?')
      printf '  %-26s %s seed case(s)\n' "$b" "$n"
    done
    ;;

  load)
    preflight
    [ -n "$PACK" ] || die "usage: packs/demo_sandbox.sh load <pack> [tenant-name]"
    [ -f "$REPO/deploy/demo/$PACK/demo.yaml" ] \
      || die "no demo bundle at deploy/demo/$PACK. Try: ${BLD}packs/demo_sandbox.sh list${NC}"
    [ -f "$REPO/deploy/demo/$PACK/cases.yaml" ] \
      || warn "$PACK has no cases.yaml — this bundle seeds NO cases (datasets/personas only)"

    NAME="${ARG3:-demo-$PACK}"
    SHORT="$(printf '%s' "$PACK" | tr -cd 'a-z0-9')"
    BODY="$(printf '{"name":"%s","display_name":"%s demo","owner_email":"admin@%s.datacern","pack":"%s"}' \
            "$NAME" "$PACK" "$SHORT" "$PACK")"

    say "${BLD}Provisioning demo sandbox${NC} '$NAME' from bundle '$PACK' …"
    printf '%s+ POST %s/api/v1/demo-tenants %s%s\n' "$YEL" "$IDENTITY" "$BODY" "$NC"
    [ "$DRY" = 1 ] && exit 0

    TOK="$(su_token)"
    RESP="$(api POST /api/v1/demo-tenants "$BODY")"
    TID="$(printf '%s' "$RESP" | "$PY" -c 'import json,sys; d=json.load(sys.stdin); print((d.get("tenant") or {}).get("id",""))' 2>/dev/null || true)"
    if [ -z "$TID" ]; then
      # The default tenant name is derived from the pack, so ANY retry after a
      # failed attempt collides — the tenant row is created before seeding runs,
      # and `make down` (without ARGS=--infra) leaves Postgres intact. Say what
      # to do instead of just echoing the 422.
      if printf '%s' "$RESP" | grep -q "already exists\|already in use"; then
        EXISTING="$(psql_tenant_id "$NAME")"
        say ""
        say "${YEL}A tenant named '$NAME' already exists${NC} (likely a previous attempt)."
        [ -n "$EXISTING" ] && say "  its id: ${BLD}$EXISTING${NC}"
        say "  Either re-seed it in place:"
        [ -n "$EXISTING" ] && say "    ${BLD}packs/demo_sandbox.sh reset $EXISTING${NC}"
        say "  or load under a different name:"
        say "    ${BLD}packs/demo_sandbox.sh load $PACK ${NAME}-2${NC}"
        exit 2
      fi
      die "demo tenant not created: $(printf '%s' "$RESP" | head -c 400)"
    fi
    ok "tenant $TID created (profile=demo, TTL-reaped)"

    # Seeding runs as the SeedDemoContent provisioning step, not inline in the
    # request — poll it rather than assume 202 means "done".
    say "  waiting for SeedDemoContent (datasets → personas → cases) …"
    for _ in $(seq 1 60); do
      STEPS="$(api GET "/api/v1/tenants/$TID/provisioning")"
      STATE="$(printf '%s' "$STEPS" | "$PY" -c '
import json,sys
steps={s["step_name"]: s["status"] for s in (json.load(sys.stdin).get("steps") or [])}
seed=steps.get("SeedDemoContent","?")
print(seed if all(v in ("succeeded","failed") for v in steps.values()) or seed in ("failed",) else "running")
' 2>/dev/null || echo '?')"
      case "$STATE" in
        succeeded) ok "SeedDemoContent succeeded"; break ;;
        failed)
          # Print the FAILING step's own error, not the first 600 bytes of the
          # steps array — that truncates mid-token and tells you nothing.
          printf '%s' "$STEPS" | "$PY" -c '
import json, sys
for st in (json.load(sys.stdin).get("steps") or []):
    if st.get("status") == "failed":
        print(f"  step   : {st.get(\"step_name\")}")
        print(f"  attempt: {st.get(\"attempt\")}")
        print(f"  error  : {st.get(\"error\") or st.get(\"detail\") or \"(none recorded)\"}")
' 2>/dev/null || printf '%s\n' "$STEPS"
          die "SeedDemoContent FAILED. The seeding subprocess output is in deploy/e2e/logs/identity.log:
    grep -A20 demo_seed_runner deploy/e2e/logs/identity.log | tail -40
  A ModuleNotFoundError there means DEMO_SEED_PYTHON is not pointing at the
  harness venv (boot_services.sh sets it; an older boot did not)." ;;
      esac
      sleep 2
    done

    # The point of the whole exercise: are there actually cases?
    N="$(case_count "$TID")"
    if [ "$N" = "0" ] || [ "$N" = "?" ]; then
      warn "case worklist is EMPTY (count=$N) — seeding reported success but no cases landed."
      warn "check deploy/e2e/logs/identity.log for the demo_seed_runner.py subprocess output."
    else
      ok "case worklist has $N case(s)"
    fi

    # Seeding created real users; ui-web still cannot log them in until its
    # dev-login map knows about them. Do that here rather than leaving a
    # sandbox whose personas all fail with "unknown user".
    say ""
    say "  merging personas into ui-web's dev-login map …"
    if LOGINS="$(merge_personas "$TID" "$PACK" 2>&1)" && [ -n "$LOGINS" ]; then
      ok "logins registered:"
      printf '%s\n' "$LOGINS" | sed 's/^/       /'
      say ""
      say "  ${YEL}ui-web reads that map ONCE at boot — restart it:${NC}"
      say "    ${BLD}deploy/local/restart_ui.sh${NC}"
    else
      warn "could not merge personas into the dev-login map:"
      printf '%s\n' "$LOGINS" | sed 's/^/       /'
      warn "the seeded users exist in identity-service but ui-web will reject them"
    fi

    say ""
    say "${GRN}ready${NC} — tenant ${BLD}$TID${NC}"
    say "  re-seed: ${BLD}packs/demo_sandbox.sh reset $TID${NC}"
    ;;

  logins)
    # Register an ALREADY-SEEDED sandbox's personas with ui-web's dev login.
    # Separate from `load` because the two fail independently: seeding can
    # succeed while the login map is stale (or vice versa), and re-running a
    # whole load just to fix logins would mint a redundant tenant.
    preflight
    TID="$PACK"; [ -n "$TID" ] || die "usage: packs/demo_sandbox.sh logins <tenant-id> [pack]"
    TOK="$(su_token)"
    PK="${ARG3:-$(pack_of_tenant "$TID")}"
    [ -n "$PK" ] || die "could not determine which bundle tenant $TID came from.
  Pass it explicitly: ${BLD}packs/demo_sandbox.sh logins $TID <pack>${NC}"
    [ -f "$REPO/deploy/demo/$PK/personas.yaml" ] \
      || die "no personas.yaml in deploy/demo/$PK — nothing to register"
    say "Registering ${BLD}$PK${NC} personas for tenant ${BLD}$TID${NC} …"
    if LOGINS="$(merge_personas "$TID" "$PK" 2>&1)" && [ -n "$LOGINS" ]; then
      ok "logins registered:"
      printf '%s\n' "$LOGINS" | sed 's/^/       /'
      say ""
      say "  ${YEL}ui-web reads the map ONCE at boot — restart it before logging in:${NC}"
      say "    ${BLD}deploy/local/restart_ui.sh${NC}"
    else
      printf '%s\n' "$LOGINS" | sed 's/^/  /'
      die "no personas registered — the seeded users (if any) will still be rejected by ui-web"
    fi
    ;;

  status)
    preflight
    TID="$PACK"; [ -n "$TID" ] || die "usage: packs/demo_sandbox.sh status <tenant-id>"
    TOK="$(su_token)"
    api GET "/api/v1/tenants/$TID/provisioning" | "$PY" -m json.tool | head -40
    say "cases: $(case_count "$TID")"
    ;;

  reset)
    preflight
    TID="$PACK"; [ -n "$TID" ] || die "usage: packs/demo_sandbox.sh reset <tenant-id>"
    TOK="$(su_token)"
    printf '%s+ POST %s/api/v1/demo-tenants/%s/reset%s\n' "$YEL" "$IDENTITY" "$TID" "$NC"
    [ "$DRY" = 1 ] && exit 0
    api POST "/api/v1/demo-tenants/$TID/reset" '{}' >/dev/null
    ok "re-seeded to the bundle baseline; cases now: $(case_count "$TID")"
    ;;

  *)
    sed -n '2,31p' "$0" | sed 's/^# \{0,1\}//'
    exit 2
    ;;
esac
