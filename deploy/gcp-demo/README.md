# Datacern demo on GCP — single VM, k3s, stop when idle

**Profile: lowest-cost demo environment.** One GCE instance running k3s with the whole
stack — services and self-hosted data tier — on it. Stop it when you're not demoing and
you pay for the disk only; start it again and the state is exactly as you left it.

> **This path has never been run.** The rest of `deploy/` is CI-built and, per
> `docs/DATACERN_PARTNER_BRIEFING.md`, has never been applied to a real cloud account —
> this directory is newer still. Treat the first bring-up as a half-day of discovery, not
> a fifteen-minute copy-paste. Every step below is written from the code and the Hetzner
> runbook it mirrors; none of it is a recorded live run.

## Why a single VM and not GKE

The managed module at `deploy/terraform/gcp/` provisions GKE, Cloud SQL, Memorystore,
Managed Kafka, Cloud NAT, KMS. Three of those **cannot be stopped** — Memorystore, Managed
Kafka, and the GKE control plane bill by the hour until deleted. So with that module your
only real "off" is `terraform destroy`, and coming back means re-apply, re-install, and
re-seed.

A GCE instance stops in one command, keeps its disk, and restarts in about two minutes with
every byte of demo state intact. That is the whole point.

Use the managed module when a customer asks "does this run on real GKE and Cloud SQL?" —
apply it once, screenshot it, destroy it. Use this for everyday demos.

## Cost shape

| | Running | Stopped |
|---|---|---|
| `e2-standard-8` (8 vCPU / 32 GB) | ~$0.27/hr | **$0** |
| 200 GB `pd-standard` boot disk | ~$8/mo | ~$8/mo |
| Reserved static IP | ~$3/mo | ~$3/mo |

At roughly 20 demo-hours a week that lands near **$35/month all-in**. Verify current rates;
these are list-price estimates, not quotes.

Two notes on sizing. The validated footprint elsewhere in the repo is ~48 GB (the Hetzner
cluster is 3 × 16 GB), so 32 GB is deliberately tighter and may need the `--core` profile's
trimming. If it's tight, you can **resize a stopped instance in one command** — no rebuild:

```bash
gcloud compute instances set-machine-type datacern-demo --machine-type e2-standard-16 --zone "$ZONE"
```

And don't use Spot/preemptible here. It saves 60–70%, but the box is stopped most of the
time so you're saving cents, and being preempted mid-demo is a bad trade.

---

## Step 0 — Create the GCP account

Starting from nothing. Budget about 20 minutes, most of it waiting on verification.

1. Go to **cloud.google.com** and click *Get started for free*. Sign in with any Google
   account.
2. **You will be asked for a credit card.** It is used for identity verification. A trial
   account does not auto-charge when the credit runs out — it suspends resources and asks
   you to upgrade deliberately. Verify this on the signup screen rather than taking my word
   for it; billing policies change.
3. New customers get **$300 in free credits, valid 90 days** (verify current terms at
   signup). That comfortably covers this demo environment for the whole trial — at the usage
   pattern below you would spend well under a third of it.
4. Accept the terms. GCP creates a project called *My First Project* — use it or create your
   own at **console.cloud.google.com/projectcreate**.
5. Note your **project ID** (not the display name — the ID, which is globally unique and
   often has a number appended).

Then install the CLI tools on your laptop:

```bash
brew install --cask google-cloud-sdk
```

```bash
brew install kubectl helm
```

You also need a **GitHub PAT with `read:packages`** — the Datacern images are private on
GHCR. Create one at github.com/settings/tokens.

### Two things that bite new accounts

**CPU quota.** A fresh project often ships with a low per-region CPU quota. The
`e2-standard-8` below needs 8 vCPUs, which typically fits — but if you later resize to
`e2-standard-16` you may hit the ceiling. Check before you need it:

```bash
gcloud compute regions describe us-central1 --format="value(quotas.filter(metric:CPUS).limit)"
```

If it's too low, request an increase under *IAM & Admin → Quotas* in the console. Approval is
usually quick but is not instant, so do it before demo day, not during.

**Trial accounts have restrictions** beyond quota — notably around GPUs. That doesn't affect
this runbook (there's no GPU here), but it will if you later try
`deploy/terraform/gcp/gpu_training_pool.tf`.

## Step 0b — Authenticate and set your shell

```bash
gcloud auth login
```

Set these once per shell; every later step uses them. Replace `PROJECT` with your real
project ID.

```bash
export PROJECT=your-gcp-project-id; export ZONE=us-central1-a; export VM=datacern-demo
```

```bash
gcloud config set project "$PROJECT"
```

Enabling the Compute API takes a minute or two on a new project:

```bash
gcloud services enable compute.googleapis.com
```

## Step 1 — Reserve a static IP

Ephemeral external IPs are released when an instance stops, which would change your demo URL
every session. Reserve one so it survives.

```bash
gcloud compute addresses create datacern-demo-ip --region "${ZONE%-*}"
```

## Step 2 — Create the VM

```bash
gcloud compute instances create "$VM" --zone "$ZONE" --machine-type e2-standard-8 --image-family ubuntu-2404-lts-amd64 --image-project ubuntu-os-cloud --boot-disk-size 200GB --boot-disk-type pd-standard --address datacern-demo-ip --tags datacern-demo
```

## Step 3 — Firewall

Open 80/443 for the UI, and 6443 for the k3s API **from your IP only**.

```bash
gcloud compute firewall-rules create datacern-demo-web --allow tcp:80,tcp:443 --target-tags datacern-demo
```

```bash
gcloud compute firewall-rules create datacern-demo-api --allow tcp:6443 --target-tags datacern-demo --source-ranges "$(curl -s ifconfig.me)/32"
```

Do not widen `datacern-demo-api` to `0.0.0.0/0`. The Hetzner module ships that default for
first bring-up and its README tells you to tighten it; start tight instead.

## Step 4 — Install k3s

```bash
gcloud compute ssh "$VM" --zone "$ZONE" --command "curl -sfL https://get.k3s.io | sh -s - --write-kubeconfig-mode 644 --tls-san $(gcloud compute instances describe "$VM" --zone "$ZONE" --format='value(networkInterfaces[0].accessConfigs[0].natIP)')"
```

k3s ships Traefik as ingress and `local-path` as the default StorageClass — both are what
this deployment wants, so there is no CSI driver to install. `local-path` is backed by the
boot disk, which is precisely the disk that survives a stop.

## Step 5 — Get a kubeconfig locally

```bash
gcloud compute ssh "$VM" --zone "$ZONE" --command "sudo cat /etc/rancher/k3s/k3s.yaml" | sed "s/127.0.0.1/$(gcloud compute addresses describe datacern-demo-ip --region "${ZONE%-*}" --format='value(address)')/" > ~/.kube/datacern-demo.yaml
```

```bash
export KUBECONFIG=~/.kube/datacern-demo.yaml && kubectl get nodes
```

## Step 6 — Point the data tier at `local-path`

The manifests in `deploy/k8s/data-tier/` hardcode Hetzner's `hcloud-volumes` StorageClass.
Their README documents this swap explicitly:

> **StorageClass** is `hcloud-volumes` throughout — change it for a different CSI.

```bash
grep -rl hcloud-volumes deploy/k8s/data-tier/ | xargs sed -i '' 's/hcloud-volumes/local-path/g'
```

On Linux drop the `''` after `-i`. Do this on a branch — it edits tracked files.

## Step 7 — Deploy the data tier

Self-hosted Postgres, Redpanda, MinIO, Iceberg REST, OpenSearch, ClickHouse, Redis, OPA,
Keycloak, Temporal, MLflow, Ollama, Trino — the same components as `docker-compose.dev.yml`.

```bash
kubectl apply -k deploy/k8s/data-tier
```

```bash
kubectl -n datacern exec deploy/ollama -- ollama pull llama3.2:3b
```

Wait for it to settle before continuing — the app services will crashloop against a Postgres
that isn't up yet.

```bash
kubectl -n datacern wait --for=condition=available --timeout=900s deploy --all
```

## Step 8 — Secrets

```bash
cd deploy/k8s/data-tier && ./create-secrets.sh
```

```bash
GHCR_USERNAME=<your-gh-user> GHCR_TOKEN=<PAT with read:packages> deploy/k8s/data-tier/create-ghcr-pull-secret.sh
```

## Step 9 — Install the platform

`values-hetzner.yaml` is misleadingly named — read its header and it's really the
"no cloud managed services, self-host everything in-cluster" profile, which is exactly this
deployment.

Three overrides are needed, and getting the registry wrong is the most likely way this step
fails:

- **`global.registry`** — `values.yaml` defaults to `ghcr.io/datacern-ai`, but CI pushes to
  `ghcr.io/<your-github-owner>` (lowercased — see the "Normalize registry to lowercase" step
  in `ci.yml`). Point it at your own namespace.
- **`global.imageTag`** — CI publishes `${{ github.sha }}`, and **only on pushes to `main` or
  tags**, never on pull requests. So use the SHA of a `main` commit whose CI run went green,
  not your working branch's HEAD.
- **`storageClass`** — `local-path`, per step 6.

```bash
helm upgrade --install datacern deploy/helm/datacern -f deploy/helm/datacern/values-hetzner.yaml --set storageClass=local-path --set global.registry=ghcr.io/girithammisetty --set global.imageTag=<main-commit-sha>
```

Note the key is `global.registry`, not `global.image.registry` — the chart reads
`$g.registry` in `_helpers.tpl`. (`cd-aws.yml` and `cd-azure.yml` set the latter, which the
chart ignores; that's a bug in those workflows, not a pattern to copy.)

Database creation and migrations are Helm hooks (`bootstrap-job.yaml` at weight -10,
`migrate-job.yaml` at -5), so schema setup happens automatically in the right order. Watch
them land:

```bash
kubectl -n datacern get jobs -w
```

## Step 10 — Reach the UI

Point an A record at the reserved IP and set `ingress.host` in your values, or skip DNS for a
first look:

```bash
kubectl -n datacern port-forward svc/ui-web 3000:3000
```

## Step 11 — Demo data (the honest step)

**This is the part that isn't turnkey.** Self-serve signup provisions a tenant, but its
`SeedDefaults` step creates only the owner user and a default workspace — no rows. And every
pack ships **zero data** by design and refuses to install until real data satisfies its
declared contract. So a fresh cluster has a working platform and an empty one.

The seeders live in `deploy/local/` and `packs/`, and every service URL they use is
environment-driven (`deploy/e2e/lib/common.py` reads `IDENTITY_URL`, `DATASET_URL`,
`CHART_URL`, … all with `localhost:<port>` defaults). So the workable approach is to
port-forward each service on its expected local port and run the seeders unmodified from your
laptop:

```bash
deploy/gcp-demo/port-forward-all.sh
```

Then, in another shell, the normal seeding path — `packs/land_pack_data.py` to land a pack's
CSVs, or `deploy/local/seed_capability_tour.py` for the capability tour.

This works but it is the roughest part of the runbook: it means ~28 concurrent port-forwards,
and a dropped forward mid-seed leaves partial state. The cleaner long-term fix is to package
the seeders as an in-cluster Job with the URLs set to ClusterIP DNS names — worth doing if
this environment gets regular use.

---

## Daily use

```bash
deploy/gcp-demo/demo-up.sh
```

```bash
deploy/gcp-demo/demo-down.sh
```

`demo-up.sh` starts the instance, waits for the k3s API, and blocks until the workloads are
`Ready` — roughly two to four minutes, most of it the data tier. `demo-down.sh` gives Postgres
and ClickHouse a moment to checkpoint, then stops the instance. Seeded data persists across
cycles; you seed once.

## Caveats

1. **Untested.** See the note at the top. Expect to debug the first bring-up.
2. **32 GB may be tight** against a ~48 GB validated footprint. Resize a stopped instance
   with `set-machine-type` — no rebuild.
3. **No GPU**, so SLM training stays behind `GpuTrainerNotConfigured`. CPU Ollama covers the
   agent demos; `deploy/terraform/gcp/gpu_training_pool.tf` is the path if you need the
   trainer live.
4. **Single node, local-path storage, no backups.** Correct for a demo, wrong for anything
   else. The boot disk is a single point of failure — snapshot it after seeding.
5. **The first stop/start cycles want watching.** k3s generally recovers cleanly, but verify
   before you trust it in front of a customer.
