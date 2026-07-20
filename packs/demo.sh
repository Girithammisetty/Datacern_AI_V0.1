#!/usr/bin/env bash
# Demo pack control — load ONE vertical pack (+ its demo data + per-role logins)
# into a throwaway tenant for a demo, then cleanly tear it down afterwards.
#
# This is a thin, friendly front-end over the tooling that already exists:
#   load   -> onboard_pack_tenant.py   (provisions an isolated tenant, installs
#             the pack through the real Core APIs, ingests its demo data, and
#             creates one login per pack role)
#   clean  -> cleanup_pack_tenants.py  (deletes every tenant-keyed row across all
#             service DBs + Redis projections + OpenSearch cases + the logins)
#
# Demo tenants are named `wr-demo-<pack>` so they are always cleanup-eligible
# (wr-* prefix + recorded in .multitenant_state.json) and can never collide with
# the platform's main `demo.windrose` tenant, which cleanup refuses by design.
#
# Usage:
#   packs/demo.sh list                 # available packs + loaded demo tenants
#   packs/demo.sh load  card-disputes  # spin up wr-demo-card-disputes
#   packs/demo.sh clean card-disputes  # tear it down
#   packs/demo.sh clean-all            # tear down every wr-demo-* tenant
#   packs/demo.sh -n load card-disputes  # dry-run: print the command, run nothing
#
# Needs the local stack running (make up) — onboarding hits the live services.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
PY="$REPO/deploy/e2e/.venv/bin/python"
STATE="$HERE/.multitenant_state.json"

RED=$'\033[31m'; GRN=$'\033[32m'; YEL=$'\033[33m'; BLD=$'\033[1m'; NC=$'\033[0m'
say(){ printf '%s\n' "$*"; }
die(){ printf '%sERROR%s %s\n' "$RED" "$NC" "$*" >&2; exit 1; }

DRY=0
[ "${1:-}" = "-n" ] || [ "${1:-}" = "--dry-run" ] && { DRY=1; shift; }

CMD="${1:-}"; PACK="${2:-}"

# tenant/label derivation kept identical everywhere so load + clean always agree
tenant_of(){ printf 'wr-demo-%s' "$1"; }
short_of(){ printf '%s' "$1" | tr -cd 'a-z0-9'; }         # e.g. card-disputes -> carddisputes
title_of(){ printf '%s' "$1" | tr '-' ' ' | awk '{for(i=1;i<=NF;i++)$i=toupper(substr($i,1,1))substr($i,2)}1'; }

installable_packs(){ for d in "$HERE"/*/; do [ -f "${d}pack.yaml" ] && basename "$d"; done; }

require_pack(){
  [ -n "$PACK" ] || die "no pack given. Try: ${BLD}packs/demo.sh list${NC}"
  [ -f "$HERE/$PACK/pack.yaml" ] || die "unknown pack '$PACK'. Run ${BLD}packs/demo.sh list${NC} to see choices."
}
preflight(){ [ -x "$PY" ] || die "e2e venv missing ($PY). Run ${BLD}make up${NC} first."; }

run(){  # echo (shell-quoted, copy-paste-safe) + execute; --dry-run only echoes
  printf '%s+ %s%s\n' "$YEL" "$(printf '%q ' "$@")" "$NC"
  [ "$DRY" = 1 ] && return 0
  ( cd "$HERE" && "$@" )
}

case "$CMD" in
  list)
    say "${BLD}Installable packs${NC} (packs/demo.sh load <pack>):"
    installable_packs | sed 's/^/  /'
    say ""
    say "${BLD}Loaded demo tenants${NC} (packs/demo.sh clean <pack>):"
    if [ -f "$STATE" ] && "$PY" - "$STATE" <<'PYEOF' 2>/dev/null
import json, sys
s = json.load(open(sys.argv[1]))
demo = {k: v for k, v in s.items() if str(k).startswith("wr-demo-")}
if not demo:
    raise SystemExit(1)
for name, row in demo.items():
    pack = name[len("wr-demo-"):]
    tid = row.get("tenant_id", "?") if isinstance(row, dict) else "?"
    print(f"  {pack:24}  tenant={name}  ({tid})")
PYEOF
    then :; else say "  ${YEL}(none)${NC}"; fi
    ;;

  load)
    require_pack; preflight
    T="$(tenant_of "$PACK")"
    say "${BLD}Loading${NC} pack '${PACK}' into demo tenant '${T}' …"
    run "$PY" onboard_pack_tenant.py \
      --pack "$PACK" --tenant "$T" \
      --display "$(title_of "$PACK") Demo" --short "$(short_of "$PACK")"
    [ "$DRY" = 1 ] && exit 0
    say ""
    say "${GRN}ready${NC} — log in at ${BLD}http://localhost:3000/login${NC} as ${BLD}admin@$(short_of "$PACK").windrose${NC} (any password)"
    say "  role logins: packs/MULTITENANT_LOGINS.md    tear down: ${BLD}packs/demo.sh clean $PACK${NC}"
    ;;

  clean)
    require_pack; preflight
    T="$(tenant_of "$PACK")"
    say "${BLD}Cleaning up${NC} demo tenant '${T}' …"
    run "$PY" cleanup_pack_tenants.py --tenant "$T" --yes
    [ "$DRY" = 1 ] || say "${GRN}done${NC} — '${T}' removed. The main demo.windrose tenant is untouched."
    ;;

  clean-all)
    preflight
    say "${BLD}Cleaning up EVERY wr-demo-* tenant${NC} …"
    # cleanup_pack_tenants --all targets every recorded tenant, incl. non-demo
    # wr-* pack tenants; scope strictly to wr-demo-* so we never nuke those.
    if [ ! -f "$STATE" ]; then say "${YEL}no demo tenants recorded${NC}"; exit 0; fi
    mapfile -t demos < <("$PY" - "$STATE" <<'PYEOF'
import json, sys
s = json.load(open(sys.argv[1]))
for k in s:
    if str(k).startswith("wr-demo-"): print(k)
PYEOF
)
    [ "${#demos[@]}" -gt 0 ] || { say "${YEL}no demo tenants to clean${NC}"; exit 0; }
    for t in "${demos[@]}"; do run "$PY" cleanup_pack_tenants.py --tenant "$t" --yes; done
    [ "$DRY" = 1 ] || say "${GRN}done${NC} — all wr-demo-* tenants removed."
    ;;

  ""|-h|--help|help)
    grep -E '^#( |$)' "${BASH_SOURCE[0]}" | sed -E 's/^# ?//'
    ;;
  *)
    die "unknown command '$CMD'. Run ${BLD}packs/demo.sh help${NC}."
    ;;
esac
