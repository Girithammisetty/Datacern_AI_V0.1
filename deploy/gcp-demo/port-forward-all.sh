#!/usr/bin/env bash
# Port-forward every Datacern service on the port its seeder already expects.
#
# WHY. The seeders in deploy/local/ and packs/ are written for a laptop bring-up:
# deploy/e2e/lib/common.py resolves every service from an env var that defaults
# to http://localhost:<port> (IDENTITY_URL 8301, DATASET_URL 8304, and so on).
# Forward each in-cluster Service onto exactly that local port and the seeders
# run against a remote cluster with no edits and no env vars at all.
#
# The port list below is generated from deploy/helm/datacern/values.yaml — the
# chart's own service name + port — so it stays true as long as the chart does.
#
# This is the pragmatic path, not the good one. Twenty-plus concurrent forwards
# is fragile, and a forward that drops mid-seed leaves partial state behind. The
# durable fix is to run the seeders as an in-cluster Job pointed at ClusterIP DNS
# names; do that if this environment sees regular use.
set -uo pipefail

NS="${NS:-datacern}"
KCFG="${KUBECONFIG:-$HOME/.kube/datacern-demo.yaml}"

B=$'\033[1m'; G=$'\033[32m'; Y=$'\033[33m'; N=$'\033[0m'
say() { echo "${B}==>${N} $*"; }
ok()  { echo "  ${G}ok${N}   $*"; }
warn() { echo "  ${Y}!!${N} $*"; }

[[ -f "$KCFG" ]] || { echo "no kubeconfig at $KCFG — see README step 5" >&2; exit 1; }
export KUBECONFIG="$KCFG"

# name:port — app services (values.yaml) then the data tier the seeders touch.
SERVICES=(
  identity-service:8301   rbac-service:8302        ingestion-service:8303
  dataset-service:8304    realtime-hub:8305        agent-runtime:8306
  memory-service:8307     case-service:8308        pack-service:8309
  tool-registry:8310      mcp-gateway:8311         ai-gateway:8312
  pipeline-orchestrator:8313 experiment-service:8314 inference-service:8316
  query-service:8085      semantic-service:8086    chart-service:8320
  usage-service:8321      audit-service:8322       notification-service:8323
  eval-service:8324       bff-graphql:4000         ui-web:3000
  postgres:5432           redis:6379               opa:8281
  ollama:11434            minio:9000               opensearch:9200
)

PIDS=()
cleanup() {
  echo
  say "stopping ${#PIDS[@]} forwards"
  for p in "${PIDS[@]}"; do kill "$p" 2>/dev/null || true; done
  wait 2>/dev/null || true
  ok "done"
}
trap cleanup EXIT INT TERM

say "forwarding ${#SERVICES[@]} services from namespace '$NS'"
started=0 missing=0
for entry in "${SERVICES[@]}"; do
  svc="${entry%%:*}"; port="${entry##*:}"
  if ! kubectl -n "$NS" get "svc/$svc" >/dev/null 2>&1; then
    warn "no svc/$svc — skipping (fine if that component is not deployed)"
    (( missing++ )); continue
  fi
  kubectl -n "$NS" port-forward "svc/$svc" "$port:$port" >/dev/null 2>&1 &
  PIDS+=($!); (( started++ ))
done

sleep 3
# A forward whose local port is already taken dies immediately, and kubectl says
# so only on the stderr we discarded. Count survivors instead so the failure is
# visible here rather than as a confusing connection error mid-seed.
alive=0
for p in "${PIDS[@]}"; do kill -0 "$p" 2>/dev/null && (( alive++ )); done

echo
ok "$alive of $started forwards live${missing:+, $missing service(s) absent}"
if (( alive < started )); then
  warn "$(( started - alive )) died on startup — usually a local port already in use."
  warn "check with: lsof -nP -iTCP -sTCP:LISTEN | grep -E '830[0-9]|808[56]|832[0-4]'"
fi
echo
say "seed in another shell, e.g.:"
echo "     uv run python deploy/local/seed_capability_tour.py"
echo "     uv run python packs/land_pack_data.py <pack>"
echo
say "Ctrl-C here when seeding is done"
wait
