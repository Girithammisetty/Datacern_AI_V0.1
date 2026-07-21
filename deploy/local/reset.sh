#!/usr/bin/env bash
# Full local clean slate — DELETE all persistent data and start from nothing.
#
# `--platform-only` / `up-platform` only skip THIS boot's vertical seed; they do
# not remove data already written by a previous `make up`. The stores are Docker
# named volumes (pgdata, miniodata, icebergdata, redpandadata) that survive every
# `docker compose down`, so old tenants/cases/datasets persist until dropped.
# This script drops them, so the next `make up` starts genuinely empty.
#
# Wipes EVERYTHING: every tenant (incl. demo.windrose and any wr-demo-* demos),
# every case, dataset, model, dashboard, audit record, and object in MinIO/Iceberg.
# It does NOT touch source code or git.
#
# Usage:
#   make reset            # prompts for confirmation
#   make reset FORCE=1    # no prompt (scripts/CI)
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
COMPOSE="$REPO/deploy/docker-compose.dev.yml"
RED=$'\033[31m'; GRN=$'\033[32m'; YEL=$'\033[33m'; BLD=$'\033[1m'; NC=$'\033[0m'
say(){ printf '%s\n' "$*"; }

say "${BLD}${RED}This deletes ALL local platform data${NC} — every tenant, case, dataset,"
say "model, dashboard, audit record and stored object. Source code + git are untouched."
if [ "${FORCE:-0}" != 1 ]; then
  printf '%sType "wipe" to confirm: %s' "$YEL" "$NC"
  read -r ans
  [ "$ans" = "wipe" ] || { say "aborted — nothing deleted."; exit 1; }
fi

# 1) stop native services first so nothing holds a connection to the stores
say "stopping native services…"
"$HERE/down.sh" >/dev/null 2>&1 || true

# 2) drop the infra stack AND its named volumes (-v is what `make down` omits)
say "dropping Docker infra + data volumes (pgdata, miniodata, icebergdata, redpandadata)…"
( cd "$REPO" && docker compose -f "$COMPOSE" down -v --remove-orphans )

say ""
say "${GRN}clean slate.${NC} Next:"
say "  ${BLD}make up${NC}            fresh platform + claims demo, or"
say "  ${BLD}make up-platform${NC}   fresh platform only, then ${BLD}make demo-load PACK=<pack>${NC}"
