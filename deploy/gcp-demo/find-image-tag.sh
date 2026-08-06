#!/usr/bin/env bash
# Print the newest main-branch commits whose container images cover EVERY service
# in the chart — i.e. the SHAs that are safe to pass as global.imageTag.
#
# WHY NOT just use the newest main commit. CI publishes ${{ github.sha }} only on
# pushes to main and tags, and it does so from a per-service build matrix with
# fail-fast disabled. A run where two services fail still publishes the other
# twenty-two, so a SHA can look current and complete and not be: helm installs
# happily, then the two missing services sit in ImagePullBackOff while everything
# else runs. That reads as a registry-credentials problem and is not one.
#
# So this intersects the tag lists of all 24 repositories and reports only SHAs
# present in every one, newest first.
#
# Credentials come from the ghcr-pull Secret already in the cluster, so there is
# nothing extra to export and no token is printed or written anywhere.
set -euo pipefail

NS="${NS:-datacern}"
KCFG="${KUBECONFIG:-$HOME/.kube/datacern-demo.yaml}"
OWNER="${GHCR_OWNER:-}"
DEPTH="${DEPTH:-40}"

command -v kubectl >/dev/null || { echo "kubectl not on PATH" >&2; exit 1; }
command -v python3 >/dev/null || { echo "python3 not on PATH" >&2; exit 1; }
[[ -f "$KCFG" ]] || { echo "no kubeconfig at $KCFG — see README step 5" >&2; exit 1; }
export KUBECONFIG="$KCFG"

DOCKERCFG="$(kubectl -n "$NS" get secret ghcr-pull -o jsonpath='{.data.\.dockerconfigjson}' 2>/dev/null | base64 -d || true)"
[[ -n "$DOCKERCFG" ]] || { echo "no ghcr-pull secret in namespace '$NS' — see README step 8" >&2; exit 1; }

AUTH="$(printf '%s' "$DOCKERCFG" | python3 -c "import sys,json;d=json.load(sys.stdin);print(list(d['auths'].values())[0].get('auth',''))" 2>/dev/null || true)"
[[ -n "$AUTH" ]] || { echo "ghcr-pull secret has no usable auth entry" >&2; exit 1; }

# Infer the namespace from the SECRET, not from values.yaml. values.yaml carries
# the upstream default (ghcr.io/datacern-ai), which is exactly the namespace a
# fork's token cannot read — inferring from it made every repository look
# "unreachable" and reported that no SHA had a complete image set, when in fact
# all 24 did under the operator's own namespace. The pull secret's username is
# the account whose packages we can actually see, so it is the right source.
# Lowercased because GHCR paths must be, while GitHub usernames need not be.
if [[ -z "$OWNER" ]]; then
  OWNER="$(printf '%s' "$AUTH" | base64 -d 2>/dev/null | cut -d: -f1 | tr '[:upper:]' '[:lower:]')"
fi
[[ -n "$OWNER" ]] || { echo "set GHCR_OWNER (could not infer it from the pull secret)" >&2; exit 1; }
echo "querying ghcr.io/$OWNER"

AUTH="$AUTH" OWNER="$OWNER" DEPTH="$DEPTH" python3 - <<'PY'
import json, os, subprocess, urllib.request, urllib.error, re

auth, owner, depth = os.environ["AUTH"], os.environ["OWNER"], int(os.environ["DEPTH"])

# Service list straight from the chart, so this cannot drift out of sync with
# what helm will actually try to pull.
text = open("deploy/helm/datacern/values.yaml").read()
block = text.split("\nservices:", 1)[1] if "\nservices:" in text else ""
svcs = re.findall(r"^\s*-?\s*name:\s*([a-z0-9-]+)\s*$", block, re.M)
svcs = list(dict.fromkeys(svcs))
if not svcs:
    raise SystemExit("could not read the service list from values.yaml")

def get(url, hdr):
    return json.load(urllib.request.urlopen(urllib.request.Request(url, headers=hdr), timeout=30))

common, unreachable = None, []
for s in svcs:
    try:
        tok = get(f"https://ghcr.io/token?scope=repository:{owner}/{s}:pull&service=ghcr.io",
                  {"Authorization": f"Basic {auth}"})["token"]
        tags = set(get(f"https://ghcr.io/v2/{owner}/{s}/tags/list",
                       {"Authorization": f"Bearer {tok}"}).get("tags") or [])
    except Exception as e:
        unreachable.append(s)
        # An unreachable repo is NOT the same as one with no matching tags, and
        # must not silently shrink the intersection — that would recommend a SHA
        # whose images are missing for exactly this service.
        continue
    common = tags if common is None else (common & tags)

print(f"{len(svcs)} services in the chart; {len(unreachable)} unreachable"
      + (f": {', '.join(unreachable)}" if unreachable else ""))
if unreachable:
    print("  !! those were skipped — a SHA below is NOT proven complete for them")
print(f"{len(common or [])} tags present across all reachable services\n")

log = subprocess.run(["git", "log", "--format=%H %s", "origin/main", f"-{depth}"],
                     capture_output=True, text=True).stdout.splitlines()
print(f"newest origin/main commits with a complete image set (of the last {depth}):")
hits = 0
for line in log:
    sha, _, msg = line.partition(" ")
    if sha in (common or ()):
        print(f"  {sha}  {msg[:60]}")
        hits += 1
        if hits == 5:
            break
if not hits:
    print("  NONE — check the Actions tab for a green build-push run on main")
PY
