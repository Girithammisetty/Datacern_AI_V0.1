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
