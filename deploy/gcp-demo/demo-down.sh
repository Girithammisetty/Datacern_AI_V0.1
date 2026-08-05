#!/usr/bin/env bash
# Stop the GCP demo VM. Compute billing stops; the disk and all seeded state stay.
#
# The stop itself is one gcloud call. What this adds is a graceful pause first:
# Postgres, ClickHouse and OpenSearch are all running on local-path volumes
# backed by the boot disk, and yanking power under an open write is how you find
# out what their recovery paths do. Scaling the app tier to zero first stops new
# writes; the short settle gives the stateful set time to checkpoint.
#
# This is best-effort by design. If the cluster is already unreachable, stopping
# the VM is still the right outcome — a script that refuses to stop the instance
# because it could not tidy up first would leave the meter running, which is the
# one failure this whole setup exists to avoid.
set -euo pipefail

VM="${VM:-datacern-demo}"
ZONE="${ZONE:-us-central1-a}"
NS="${NS:-datacern}"
KCFG="${KUBECONFIG:-$HOME/.kube/datacern-demo.yaml}"
SETTLE="${SETTLE:-15}"
SKIP_DRAIN="${SKIP_DRAIN:-0}"

B=$'\033[1m'; G=$'\033[32m'; Y=$'\033[33m'; N=$'\033[0m'
say() { echo "${B}==>${N} $*"; }
ok()  { echo "  ${G}ok${N}   $*"; }
warn() { echo "  ${Y}!!${N} $*"; }
die() { echo "  ${Y}!!${N} $*" >&2; exit 1; }

command -v gcloud >/dev/null || die "gcloud not on PATH"

st="$(gcloud compute instances describe "$VM" --zone "$ZONE" --format='value(status)' 2>/dev/null || echo MISSING)"
case "$st" in
  MISSING)    die "instance '$VM' does not exist in $ZONE" ;;
  TERMINATED) ok "instance already stopped — nothing to do"; exit 0 ;;
esac

# ------------------------------------------------------------- quiesce (best effort)
if [[ "$SKIP_DRAIN" == "1" ]]; then
  warn "SKIP_DRAIN=1 — stopping without quiescing"
elif [[ -f "$KCFG" ]] && KUBECONFIG="$KCFG" kubectl get --raw='/readyz' >/dev/null 2>&1; then
  export KUBECONFIG="$KCFG"
  say "scaling the app tier down so the data tier stops taking writes"
  # Only the Helm-managed app deployments. The data tier is applied separately
  # (kubectl apply -k) and carries no such label, so this leaves Postgres and
  # friends running to flush — which is the point.
  if kubectl -n "$NS" scale deploy --replicas=0 -l app.kubernetes.io/managed-by=Helm >/dev/null 2>&1; then
    ok "app deployments scaled to 0"
    say "letting the data tier checkpoint (${SETTLE}s)"
    sleep "$SETTLE"
  else
    warn "could not scale app deployments — continuing to stop anyway"
  fi
else
  warn "cluster not reachable — stopping without quiescing"
fi

# ------------------------------------------------------------------------- stop
say "stopping $VM"
gcloud compute instances stop "$VM" --zone "$ZONE" --quiet >/dev/null
ok "instance stopped — compute billing has ceased"
echo
ok "disk and seeded state preserved; ./demo-up.sh brings it back"
warn "still billed while stopped: the boot disk and the reserved static IP (a few \$/month)"
