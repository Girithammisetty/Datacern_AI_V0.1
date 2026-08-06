#!/usr/bin/env bash
# Provision the GCP demo VM and deploy Datacern onto it — one command, end to end.
#
# This automates deploy/gcp-demo/README.md steps 1–9 plus the incremental
# app-tier start that the first real bring-up proved necessary: the data tier
# first, then every app service ONE AT A TIME in dependency order, each waited
# to Ready before the next. One replica per service throughout (the
# values-hetzner single-node profile), Recreate strategy, no stampede.
#
# Idempotent by construction: every step checks before it creates, so re-running
# after a failure resumes where it stopped instead of erroring on what exists.
#
# Required environment (only for the first run, while secrets don't exist yet):
#   GHCR_USERNAME   GitHub user whose ghcr.io namespace holds the images
#   GHCR_TOKEN      PAT with read:packages
# Optional:
#   VM, ZONE        default: datacern-demo / us-central1-a
#   IMAGE_TAG       skip find-image-tag.sh and use this SHA
#   SKIP_PROVISION  =1 to start at the Kubernetes work (VM already exists)
#
# Prerequisites: gcloud (authenticated, project set), kubectl, helm, python3.
# Run FROM THE REPOSITORY ROOT:  ./deploy/gcp-demo/provision.sh
set -euo pipefail

VM="${VM:-datacern-demo}"
ZONE="${ZONE:-us-central1-a}"
REGION="${ZONE%-*}"
NS="${NS:-datacern}"
KCFG="${KUBECONFIG:-$HOME/.kube/datacern-demo.yaml}"
ADDR_NAME="datacern-demo-ip"

B=$'\033[1m'; G=$'\033[32m'; Y=$'\033[33m'; N=$'\033[0m'
say()  { echo "${B}==>${N} $*"; }
ok()   { echo "  ${G}ok${N}   $*"; }
warn() { echo "  ${Y}!!${N} $*"; }
die()  { echo "  ${Y}!!${N} $*" >&2; exit 1; }

[[ -f deploy/gcp-demo/provision.sh ]] || die "run from the repository root: ./deploy/gcp-demo/provision.sh"
command -v gcloud  >/dev/null || die "gcloud not on PATH"
command -v kubectl >/dev/null || die "kubectl not on PATH"
command -v helm    >/dev/null || die "helm not on PATH"

# ----------------------------------------------------------------- provision
if [[ "${SKIP_PROVISION:-0}" != "1" ]]; then
  say "static IP ($ADDR_NAME)"
  if gcloud compute addresses describe "$ADDR_NAME" --region "$REGION" >/dev/null 2>&1; then
    ok "already reserved"
  else
    gcloud compute addresses create "$ADDR_NAME" --region "$REGION"
    ok "reserved"
  fi
  IP="$(gcloud compute addresses describe "$ADDR_NAME" --region "$REGION" --format='value(address)')"

  say "VM ($VM, e2-standard-8, 200GB)"
  st="$(gcloud compute instances describe "$VM" --zone "$ZONE" --format='value(status)' 2>/dev/null || echo MISSING)"
  case "$st" in
    MISSING)
      gcloud compute instances create "$VM" --zone "$ZONE" --machine-type e2-standard-8 \
        --image-family ubuntu-2404-lts-amd64 --image-project ubuntu-os-cloud \
        --boot-disk-size 200GB --boot-disk-type pd-standard \
        --address "$ADDR_NAME" --tags datacern-demo
      ok "created"
      say "waiting 60s for first boot + sshd"
      sleep 60
      ;;
    TERMINATED|SUSPENDED)
      gcloud compute instances start "$VM" --zone "$ZONE" --quiet >/dev/null
      ok "started (was $st)"; sleep 30 ;;
    RUNNING) ok "already running" ;;
    *) die "instance in unexpected state: $st" ;;
  esac

  say "firewall"
  gcloud compute firewall-rules describe datacern-demo-web >/dev/null 2>&1 \
    || gcloud compute firewall-rules create datacern-demo-web --allow tcp:80,tcp:443 --target-tags datacern-demo
  MYIP="$(curl -s ifconfig.me)"
  if gcloud compute firewall-rules describe datacern-demo-api >/dev/null 2>&1; then
    # refresh the source range — laptops change networks and 6443 is IP-pinned
    gcloud compute firewall-rules update datacern-demo-api --source-ranges "${MYIP}/32" >/dev/null
    ok "api rule refreshed to ${MYIP}/32"
  else
    gcloud compute firewall-rules create datacern-demo-api --allow tcp:6443 \
      --target-tags datacern-demo --source-ranges "${MYIP}/32"
    ok "api rule created for ${MYIP}/32"
  fi

  say "k3s"
  if gcloud compute ssh "$VM" --zone "$ZONE" --command "systemctl is-active k3s" 2>/dev/null | grep -q '^active$'; then
    ok "already installed and active"
  else
    gcloud compute ssh "$VM" --zone "$ZONE" --command \
      "curl -sfL https://get.k3s.io | sh -s - --write-kubeconfig-mode 644 --tls-san $IP"
    ok "installed"
  fi

  say "kubeconfig → $KCFG"
  mkdir -p "$(dirname "$KCFG")"
  gcloud compute ssh "$VM" --zone "$ZONE" --command "sudo cat /etc/rancher/k3s/k3s.yaml" \
    | sed "s/127.0.0.1/$IP/" > "$KCFG"
  ok "written"
fi

export KUBECONFIG="$KCFG"
say "cluster reachability"
deadline=$(( SECONDS + 180 ))
until kubectl get --raw='/readyz' >/dev/null 2>&1; do
  (( SECONDS < deadline )) || die "k3s API not answering at $(grep server: "$KCFG" | awk '{print $2}')"
  sleep 5
done
ok "$(kubectl get nodes --no-headers | awk '{print $1" "$2}')"

# ---------------------------------------------------------------- data tier
say "namespace + OPA policy bundle"
kubectl create namespace "$NS" --dry-run=client -o yaml | kubectl apply -f - >/dev/null
kubectl -n "$NS" create configmap opa-policy \
  --from-file=services/rbac-service/policy/datacern_authz.rego \
  --from-file=services/rbac-service/policy/datacern_authz_input.rego \
  --dry-run=client -o yaml | kubectl apply -f - >/dev/null
ok "applied"

say "storageClass swap (hcloud-volumes → local-path)"
if grep -rql hcloud-volumes deploy/k8s/data-tier/ 2>/dev/null; then
  if sed --version >/dev/null 2>&1; then SED_I=(sed -i); else SED_I=(sed -i ''); fi
  grep -rl hcloud-volumes deploy/k8s/data-tier/ | xargs "${SED_I[@]}" 's/hcloud-volumes/local-path/g'
  ok "swapped (local working-tree edit — do not commit it)"
else
  ok "already local-path"
fi

say "data tier (kubectl apply -k)"
kubectl apply -k deploy/k8s/data-tier >/dev/null
ok "applied"

say "waiting for Ollama, then pulling llama3.2:3b"
kubectl -n "$NS" rollout status statefulset/ollama --timeout=600s >/dev/null
kubectl -n "$NS" exec statefulset/ollama -- ollama pull llama3.2:3b
ok "model present"

say "waiting for the rest of the data tier"
while read -r sts; do
  [[ -n "$sts" ]] || continue
  kubectl -n "$NS" rollout status "$sts" --timeout=900s >/dev/null \
    || die "data tier not ready: $sts — kubectl -n $NS describe ${sts#*/}"
done < <(kubectl -n "$NS" get statefulset -o name)
kubectl -n "$NS" wait --for=condition=available --timeout=900s deploy --all >/dev/null 2>&1 || true
ok "data tier ready"

# ------------------------------------------------------------------ secrets
say "app secrets"
if kubectl -n "$NS" get secret datacern-secrets >/dev/null 2>&1; then
  ok "datacern-secrets exists (delete it to regenerate)"
else
  (cd deploy/k8s/data-tier && ./create-secrets.sh)
  ok "created"
fi
say "ghcr pull secret"
if kubectl -n "$NS" get secret ghcr-pull >/dev/null 2>&1; then
  ok "ghcr-pull exists"
else
  [[ -n "${GHCR_USERNAME:-}" && -n "${GHCR_TOKEN:-}" ]] \
    || die "set GHCR_USERNAME and GHCR_TOKEN (PAT with read:packages) for the first run"
  GHCR_USERNAME="$GHCR_USERNAME" GHCR_TOKEN="$GHCR_TOKEN" deploy/k8s/data-tier/create-ghcr-pull-secret.sh
  ok "created"
fi

# ----------------------------------------------------------------- platform
REGISTRY_OWNER="$(kubectl -n "$NS" get secret ghcr-pull -o jsonpath='{.data.\.dockerconfigjson}' \
  | base64 -d | python3 -c "import sys,json;d=json.load(sys.stdin);import base64;print(base64.b64decode(list(d['auths'].values())[0]['auth']).decode().split(':')[0].lower())")"

if [[ -z "${IMAGE_TAG:-}" ]]; then
  say "resolving newest main SHA with a complete image set"
  IMAGE_TAG="$(deploy/gcp-demo/find-image-tag.sh | awk '/^  [0-9a-f]{40}  /{print $1; exit}')"
  [[ -n "$IMAGE_TAG" ]] || die "find-image-tag.sh found no complete SHA — check the Actions tab for a green build-push on main"
fi
ok "imageTag: $IMAGE_TAG"

say "helm install (this runs DB bootstrap + all migrations — up to 20 minutes)"
helm upgrade --install datacern deploy/helm/datacern -n "$NS" --create-namespace \
  -f deploy/helm/datacern/values-hetzner.yaml \
  --set storageClass=local-path \
  --set "global.registry=ghcr.io/${REGISTRY_OWNER}" \
  --set "global.imageTag=${IMAGE_TAG}" \
  --timeout 20m
ok "release deployed"

# --------------------------------------------- incremental app-tier start
# Park everything the chart just started, then bring services up one at a
# time in dependency order: rbac first (everything registers its actions
# there), identity second, the governed spine, domain services, and the
# BFF/UI last. First failure stops the line with the evidence in hand.
APP_SEL='app.kubernetes.io/component=service'
say "parking the app tier for the incremental start"
kubectl -n "$NS" scale deploy -l "$APP_SEL" --replicas=0 >/dev/null
kubectl -n "$NS" wait --for=delete pod -l "$APP_SEL" --timeout=300s >/dev/null 2>&1 || true
ok "parked"

ORDER="rbac-service identity-service usage-service audit-service case-service \
dataset-service ingestion-service query-service semantic-service chart-service \
eval-service inference-service experiment-service pipeline-orchestrator \
notification-service memory-service realtime-hub agent-runtime ai-gateway \
tool-registry mcp-gateway pack-service bff-graphql ui-web"

for d in $ORDER; do
  kubectl -n "$NS" get deploy "$d" >/dev/null 2>&1 || { warn "$d not in this chart — skipping"; continue; }
  say "starting $d"
  kubectl -n "$NS" scale deploy/"$d" --replicas=1 >/dev/null
  if kubectl -n "$NS" rollout status deploy/"$d" --timeout=300s >/dev/null 2>&1; then
    ok "$d ready"
  else
    echo
    warn "$d did NOT become ready in 300s. Stopping here — evidence:"
    echo "--- last 15 log lines:"
    kubectl -n "$NS" logs deploy/"$d" --tail=15 2>/dev/null || true
    echo "--- recent events:"
    kubectl -n "$NS" get events --sort-by=.lastTimestamp 2>/dev/null | grep "$d" | tail -5 || true
    die "fix $d first, then re-run this script — it will resume from the data-tier checks and skip what's already Ready"
  fi
done

IP="$(gcloud compute addresses describe "$ADDR_NAME" --region "$REGION" --format='value(address)' 2>/dev/null || true)"
echo
ok "all services up — one pod each"
kubectl -n "$NS" get deploy -l "$APP_SEL" --no-headers \
  -o custom-columns=NAME:.metadata.name,READY:.status.readyReplicas | awk '{print "       "$1"  "$2"/1"}'
echo
ok "Datacern is up${IP:+ at http://$IP}"
echo "  next: seed demo data (README step 11), then the acceptance test:"
echo "        ./deploy/gcp-demo/port-forward-all.sh   # and in another shell:"
echo "        make journey"
echo "  when done: ./deploy/gcp-demo/demo-down.sh (or the app-tier scale-down + VM stop)"
