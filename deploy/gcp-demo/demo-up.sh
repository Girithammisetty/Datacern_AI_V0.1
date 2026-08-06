#!/usr/bin/env bash
# Start the GCP demo VM and block until Datacern is actually serving.
#
# Starting the instance is one gcloud call; the reason this is a script is
# everything after it. A `gcloud compute instances start` returns as soon as the
# VM is RUNNING, which is well before sshd accepts, which is before k3s has an
# API, which is before the data tier is up, which is before the app services
# stop crashlooping against a Postgres that is not listening yet. Returning at
# the first of those and calling it "up" is how a demo opens on a 502.
#
# So: start, then wait on each layer in turn, and only exit 0 when workloads
# report Ready.
set -euo pipefail

VM="${VM:-datacern-demo}"
ZONE="${ZONE:-us-central1-a}"
NS="${NS:-datacern}"
KCFG="${KUBECONFIG:-$HOME/.kube/datacern-demo.yaml}"
API_TIMEOUT="${API_TIMEOUT:-300}"
WORKLOAD_TIMEOUT="${WORKLOAD_TIMEOUT:-900}"

B=$'\033[1m'; G=$'\033[32m'; Y=$'\033[33m'; N=$'\033[0m'
say() { echo "${B}==>${N} $*"; }
ok()  { echo "  ${G}ok${N}   $*"; }
warn() { echo "  ${Y}!!${N} $*"; }
die() { echo "  ${Y}!!${N} $*" >&2; exit 1; }

command -v gcloud  >/dev/null || die "gcloud not on PATH"
command -v kubectl >/dev/null || die "kubectl not on PATH"
[[ -f "$KCFG" ]] || die "no kubeconfig at $KCFG — see README step 5"
export KUBECONFIG="$KCFG"

status() {
  gcloud compute instances describe "$VM" --zone "$ZONE" --format='value(status)' 2>/dev/null || echo MISSING
}

# ---------------------------------------------------------------- start the VM
st="$(status)"
case "$st" in
  MISSING)   die "instance '$VM' does not exist in $ZONE — see README step 2" ;;
  RUNNING)   ok "instance already RUNNING" ;;
  TERMINATED|SUSPENDED)
    say "starting $VM"
    gcloud compute instances start "$VM" --zone "$ZONE" --quiet >/dev/null
    ok "instance started"
    ;;
  *) say "instance is $st — waiting for it to settle"
     until [[ "$(status)" == "RUNNING" ]]; do sleep 5; done
     ok "instance RUNNING" ;;
esac

# ------------------------------------------------------------- wait for k3s API
# The external IP is reserved (README step 1), so it survives a stop and the
# kubeconfig stays valid. If someone created the VM with an ephemeral IP this is
# where it shows up — as a timeout against a stale address rather than something
# more obvious, hence the explicit hint in the failure message.
say "waiting for the k3s API (timeout ${API_TIMEOUT}s)"
deadline=$(( SECONDS + API_TIMEOUT ))
until kubectl get --raw='/readyz' >/dev/null 2>&1; do
  (( SECONDS < deadline )) || die "k3s API did not answer within ${API_TIMEOUT}s.
     Check: gcloud compute ssh $VM --zone $ZONE --command 'sudo systemctl status k3s'
     If the address changed, the IP is not reserved — see README step 1."
  sleep 5
done
ok "k3s API ready"

# --------------------------------------------------- wait for workloads to settle
# Two separate waits, because they fail for different reasons and a combined one
# would report the wrong cause. The data tier coming up slowly is normal; app
# deployments still not Ready after the data tier IS up means a real problem.
if ! kubectl -n "$NS" get deploy >/dev/null 2>&1; then
  die "namespace '$NS' has no deployments — has the chart been installed? See README step 9"
fi

# StatefulSets FIRST, and separately. Half the data tier — Postgres, Redpanda,
# MinIO, OpenSearch, ClickHouse, Iceberg REST, Ollama — is StatefulSets, and
# `wait --for=condition=available` silently ignores them: that condition only
# exists on Deployments, so `wait ... deploy --all` returns success while
# Postgres is still starting. The app tier then crashloops against a database
# that is not listening, which looks like an app bug and is not one.
# StatefulSets have no Available condition at all, hence rollout status.
say "waiting for the data tier (StatefulSets)"
sts_ok=1
while read -r sts; do
  [[ -n "$sts" ]] || continue
  if ! kubectl -n "$NS" rollout status "$sts" --timeout="${WORKLOAD_TIMEOUT}s" >/dev/null 2>&1; then
    warn "not ready: $sts"; sts_ok=0
  fi
done < <(kubectl -n "$NS" get statefulset -o name 2>/dev/null)
(( sts_ok )) && ok "data tier ready" || warn "data tier incomplete — app services may crashloop"

# ------------------------------------------------- staged app-tier start
# On boot every app pod cold-starts at once, competing with the data tier for
# 8 vCPUs — probes time out, pods crashloop, and the loop itself burns the CPU
# it is waiting for. If the app tier is not already healthy once the data tier
# IS, restart it deliberately: identity + rbac first (every other service
# validates JWTs against them), then the rest a few seconds apart. Chart app
# services all carry app.kubernetes.io/component=service; the support tier
# (keycloak, redis, mlflow, ...) does not, and is left alone. Replicas restore
# to 1 because this profile is global.replicaOverride: 1 by definition.
APP_SEL='app.kubernetes.io/component=service'
not_ready="$(kubectl -n "$NS" get deploy -l "$APP_SEL" \
  -o custom-columns='NAME:.metadata.name,READY:.status.readyReplicas,WANT:.spec.replicas' \
  --no-headers 2>/dev/null | awk '$2 != $3 || $2 == "<none>"' | wc -l)"
if (( sts_ok )) && (( not_ready > 0 )); then
  say "staged app start: $not_ready service(s) not ready — restarting the app tier in dependency order"
  kubectl -n "$NS" scale deploy -l "$APP_SEL" --replicas=0 >/dev/null
  for _ in $(seq 1 60); do
    n="$(kubectl -n "$NS" get pods -l "$APP_SEL" --no-headers 2>/dev/null | wc -l)"
    (( n == 0 )) && break
    sleep 5
  done
  for d in identity-service rbac-service; do
    kubectl -n "$NS" scale "deploy/$d" --replicas=1 >/dev/null 2>&1 || true
  done
  if kubectl -n "$NS" wait --for=condition=available --timeout=300s \
       deploy/identity-service deploy/rbac-service >/dev/null 2>&1; then
    ok "identity + rbac ready"
  else
    warn "identity/rbac still coming up — continuing; the workload wait below is the real gate"
  fi
  while read -r d; do
    [[ -n "$d" ]] || continue
    kubectl -n "$NS" scale "$d" --replicas=1 >/dev/null 2>&1 || true
    sleep 3
  done < <(kubectl -n "$NS" get deploy -l "$APP_SEL" -o name | grep -Ev '/(identity-service|rbac-service)$')
  ok "app tier restarted in order"
fi

say "waiting for workloads (timeout ${WORKLOAD_TIMEOUT}s)"
if kubectl -n "$NS" wait --for=condition=available --timeout="${WORKLOAD_TIMEOUT}s" deploy --all >/dev/null 2>&1; then
  ok "all deployments available"
else
  warn "not everything came up in ${WORKLOAD_TIMEOUT}s — still-unavailable deployments:"
  kubectl -n "$NS" get deploy \
    -o custom-columns='NAME:.metadata.name,READY:.status.readyReplicas,WANT:.spec.replicas' \
    --no-headers | awk '$2 != $3 || $2 == "<none>" {print "       " $1 "  " $2 "/" $3}'
  echo
  warn "this is usually slow storage on first boot; re-run to keep waiting, or:"
  warn "  kubectl -n $NS logs deploy/<name> --tail=50"
  exit 1
fi

ip="$(gcloud compute instances describe "$VM" --zone "$ZONE" \
      --format='value(networkInterfaces[0].accessConfigs[0].natIP)' 2>/dev/null || true)"
echo
ok "Datacern is up${ip:+ at http://$ip}"
[[ -n "$ip" ]] || warn "no external IP found — use: kubectl -n $NS port-forward svc/ui-web 3000:3000"
