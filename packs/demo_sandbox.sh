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
    [ -n "$TID" ] || die "demo tenant not created: $(printf '%s' "$RESP" | head -c 400)"
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
        failed)    printf '%s' "$STEPS" | head -c 600; die "SeedDemoContent FAILED — see identity-service logs (deploy/e2e/logs/identity.log)" ;;
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

    say ""
    say "${GRN}ready${NC} — tenant ${BLD}$TID${NC}"
    say "  UI:      ${BLD}http://localhost:3000/login${NC}  (personas: deploy/demo/$PACK/personas.yaml)"
    say "  re-seed: ${BLD}packs/demo_sandbox.sh reset $TID${NC}"
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
