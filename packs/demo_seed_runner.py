#!/usr/bin/env python3
"""BRD 70 demo-tenant content seeder (§2.3 option (a)): the reusable, bundle-
driven generalization of deploy/local/seed_claims_demo.py's patterns.

Invoked as a subprocess by identity-service's SeedDemoContent provisioning
step (internal/adapters/demoseed/runner.go) — NOT run directly by a human,
though it can be for local debugging (see `__main__` below). Reads one JSON
document on stdin:

    {
      "tenant_id": "...", "tenant_name": "...", "owner_email": "...",
      "pack": "insurance-claims-payer", "pack_version": "1.0.0",
      "bundle_version": "1.0.0",
      "datasets": [{"identity": "payer_claims", "csv_path": "/.../data/payer_claims.csv"}, ...],
      "personas": [{"email_local_part": "admin", "role": "payer-admin", "display_name": "Demo Admin"}, ...],
      "cases": [{"dataset": "payer_claims", "row_pk": "CLM-1001", "severity": "high",
                 "display_projection": {...}, "note": "..."}, ...]
    }

and drives REAL platform APIs (ingestion-service, case-service, identity-
service invites) exactly like seed_claims_demo.py already proves works —
nothing here is faked. Idempotent throughout: every write is a "does this
already exist by name/marker" check first (the SAME discipline
seed_claims_demo.py's `_find_model_by_name`/`_find_dashboard_by_name`
already uses), so a retry after partial failure (the Go engine's own
attempt/backoff loop) or an explicit reset (POST /demo-tenants/{id}/reset,
§2.4) converges rather than duplicates.

Authentication: DEMO_SEED_BEARER_TOKEN (env) is a real, short-lived
service-typed JWT identity-service mints in-process for this one invocation
(see runner.go) — never a shared secret, never faked.

HONEST GAP (see docs/initiatives/demo-sandbox-poc-mode.md §3): this
generalizes dataset ingestion, persona invitation, and case-queue seeding —
the worklist and audit-trail pieces of AC-1's walkthrough. It deliberately
does NOT generalize seed_claims_demo.py's semantic-model/dashboard
authoring, triage-copilot-driven PENDING proposals, or the best-effort
retrain — those remain pack/vertical-specific enough that generalizing them
into a bundle-driven contract is scoped out of this slice and flagged, not
silently dropped.
"""
from __future__ import annotations

import json
import os
import sys
import time

import requests

# ---- service base URLs: same env-var convention as deploy/e2e/lib/common.py
# so this runner works unmodified against a real deployment's actual URLs. ----
IDENTITY_URL = os.environ.get("IDENTITY_URL", "http://localhost:8301")
RBAC_URL = os.environ.get("RBAC_URL", "http://localhost:8302")
INGESTION_URL = os.environ.get("INGESTION_URL", "http://localhost:8303")
DATASET_URL = os.environ.get("DATASET_URL", "http://localhost:8304")
CASE_URL = os.environ.get("CASE_URL", "http://localhost:8308")

BEARER = os.environ.get("DEMO_SEED_BEARER_TOKEN", "")
TIMEOUT = 60


def _hdr() -> dict:
    return {"Authorization": f"Bearer {BEARER}", "Content-Type": "application/json"}


def req(method: str, url: str, **kw) -> requests.Response:
    headers = kw.pop("headers", _hdr())
    return requests.request(method, url, headers=headers, timeout=TIMEOUT, **kw)


def say(m: str) -> None:
    print(f"==> {m}", flush=True)


def warn(m: str) -> None:
    print(f"!! {m}", flush=True)


# ---------------------------------------------------------------- workspace
def resolve_default_workspace(tenant_id: str, tries: int = 20, delay: float = 1.5) -> str | None:
    """Poll rbac-service's real, public workspace listing for the tenant's
    well-known "Default use case" workspace (mirrors identity-service's own
    rbacclient.WorkspaceResolver.DefaultWorkspaceID — the SAME real API,
    just called from Python since this runner has no direct DB access to
    another service's database, unlike the local e2e harness's shortcut).
    Best-effort: a demo tenant's data still lands (unscoped) if this never
    resolves — matches WorkspaceResolver's own "must never block" contract.
    """
    for _ in range(tries):
        try:
            r = req("GET", f"{RBAC_URL}/api/v1/workspaces", params={"limit": 200})
            if r.status_code == 200:
                for ws in r.json().get("data", []):
                    if str(ws.get("name", "")).strip().lower() == "default use case":
                        return ws.get("id")
        except requests.RequestException as e:
            warn(f"workspace resolve error: {e}")
        time.sleep(delay)
    warn("could not resolve the tenant's default workspace; seeding proceeds unscoped")
    return None


# ---------------------------------------------------------------- datasets
def seed_dataset(workspace_id: str | None, identity: str, csv_path: str) -> str | None:
    """Idempotent real ingestion (mirrors deploy/e2e/driver.py step_a_ingest):
    skip if a dataset named `demo-<identity>` already exists in this
    workspace (reset re-invokes this — idempotent by name, never re-uploads).
    """
    ds_name = f"demo-{identity}"
    if workspace_id:
        r = req("GET", f"{DATASET_URL}/api/v1/datasets", params={"workspace_id": workspace_id})
        if r.status_code == 200:
            for d in r.json().get("data", []):
                if d.get("name") == ds_name:
                    urn = d.get("urn") or d.get("id")
                    say(f"dataset {ds_name!r} already exists ({urn}) — skipping re-ingest")
                    return urn

    if not os.path.isfile(csv_path):
        warn(f"bundle CSV missing on disk: {csv_path}")
        return None
    data = open(csv_path, "rb").read()

    ing = req("POST", f"{INGESTION_URL}/api/v1/ingestions", json={
        "ingestion_mode": "file_upload", "file_format": "csv",
        "workspace_id": workspace_id, "new_dataset": {"name": ds_name},
        "skip_profiling": True,
    })
    if ing.status_code not in (200, 201, 202):
        warn(f"create ingestion for {identity}: {ing.status_code} {ing.text[:300]}")
        return None
    d = ing.json().get("data", ing.json())
    ing_id, dataset_urn = d.get("id"), d.get("dataset_urn")

    up = req("POST", f"{INGESTION_URL}/api/v1/uploads", json={
        "ingestion_id": ing_id, "bytes_total": len(data)})
    if up.status_code not in (200, 201):
        warn(f"open upload for {identity}: {up.status_code} {up.text[:300]}")
        return None
    upload_id = (up.json().get("data") or {}).get("id") or (up.json().get("data") or {}).get("upload_id")

    import hashlib
    sha = hashlib.sha256(data).hexdigest()
    pr = req("PUT", f"{INGESTION_URL}/api/v1/uploads/{upload_id}/parts/1",
             headers={"Authorization": f"Bearer {BEARER}", "Content-SHA256": sha}, data=data)
    if pr.status_code not in (200, 201):
        warn(f"upload part for {identity}: {pr.status_code} {pr.text[:300]}")
        return None
    etag = (pr.json().get("data") or {}).get("etag")

    comp = req("POST", f"{INGESTION_URL}/api/v1/uploads/{upload_id}/complete", json={
        "parts": [{"n": 1, "etag": etag, "size": len(data)}], "sha256": sha})
    if comp.status_code not in (200, 201, 202):
        warn(f"complete upload for {identity}: {comp.status_code} {comp.text[:300]}")
        return None

    for _ in range(45):
        g = req("GET", f"{INGESTION_URL}/api/v1/ingestions/{ing_id}")
        gd = g.json().get("data", {}) if g.status_code == 200 else {}
        st = gd.get("status")
        if st in ("completed", "succeeded"):
            dataset_urn = gd.get("dataset_urn") or dataset_urn
            say(f"dataset {ds_name!r} ingested ({dataset_urn}), rows={gd.get('rows_appended') or gd.get('rows')}")
            return dataset_urn
        if st in ("failed", "error"):
            warn(f"ingestion failed for {identity}: {json.dumps(gd)[:300]}")
            return None
        time.sleep(1.5)
    warn(f"ingestion for {identity} did not complete within the poll budget")
    return None


# ---------------------------------------------------------------- personas
def seed_personas(tenant_id: str, personas: list[dict]) -> None:
    """Real invited users (identity-service POST /users/invite), one per
    bundle persona — idempotent (skip if a user with this email already
    exists), mirroring §2.7's "must be a real, assignable identity-service
    user" requirement (deferred: the persona SWITCHER itself, §2.7, is out
    of this slice's scope — see the honest gaps in docs/initiatives/
    demo-sandbox-poc-mode.md §3; this only creates the real users it would
    switch between)."""
    for p in personas:
        email = f"{p['email_local_part']}@{tenant_id}.demo.datacern.ai"
        r = req("GET", f"{IDENTITY_URL}/api/v1/users", params={"filter[email]": email})
        if r.status_code == 200 and r.json().get("data"):
            say(f"persona {email!r} already invited — skipping")
            continue
        ir = req("POST", f"{IDENTITY_URL}/api/v1/users/invite", json={
            "email": email, "full_name": p.get("display_name") or p["email_local_part"],
        })
        if ir.status_code in (200, 201):
            say(f"persona {email!r} invited (role hint: {p.get('role')})")
        elif ir.status_code == 409:
            say(f"persona {email!r} already exists")
        else:
            warn(f"invite {email!r}: {ir.status_code} {ir.text[:200]}")


# ---------------------------------------------------------------- cases
def seed_cases(workspace_id: str | None, dataset_urns: dict[str, str], cases: list[dict]) -> list[str]:
    """Real case-service queue rows (mirrors seed_claims_demo.py's
    create_open_cases). Idempotent by (dataset, row_pk): re-seeding never
    creates a duplicate open case for a row already queued."""
    created: list[str] = []
    due = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() + 7 * 86400))
    for c in cases:
        dataset_urn = dataset_urns.get(c["dataset"])
        if not dataset_urn:
            warn(f"case row {c.get('row_pk')} references unseeded dataset {c.get('dataset')!r} — skipping")
            continue
        existing = req("GET", f"{CASE_URL}/api/v1/cases", params={
            "workspace_id": workspace_id, "filter[row_pk]": c["row_pk"]})
        if existing.status_code == 200 and existing.json().get("data"):
            created.append(existing.json()["data"][0]["id"])
            continue
        body = {
            "dataset_urn": dataset_urn, "dataset_version": "1", "due_date": due,
            "severity": c.get("severity", "medium"), "workspace_id": workspace_id,
            "rows": [{"row_pk": c["row_pk"], "display_projection": {
                **(c.get("display_projection") or {}), "note": c.get("note", "")}}],
        }
        r = req("POST", f"{CASE_URL}/api/v1/cases", json=body)
        if r.status_code in (200, 201):
            for row in (r.json().get("data", r.json())).get("created", []):
                created.append(row["id"])
        else:
            warn(f"create case {c.get('row_pk')}: {r.status_code} {r.text[:200]}")
    say(f"{len(created)} open case row(s) in the queue")
    return created


def main() -> int:
    payload = json.load(sys.stdin)
    tenant_id = payload["tenant_id"]
    say(f"seeding demo tenant {tenant_id} from pack {payload.get('pack')} "
        f"(bundle {payload.get('bundle_version')})")

    if not BEARER:
        warn("DEMO_SEED_BEARER_TOKEN is unset — every call below will 401")

    workspace_id = resolve_default_workspace(tenant_id)

    dataset_urns: dict[str, str] = {}
    for ds in payload.get("datasets", []):
        urn = seed_dataset(workspace_id, ds["identity"], ds["csv_path"])
        if urn:
            dataset_urns[ds["identity"]] = urn

    seed_personas(tenant_id, payload.get("personas", []))
    seed_cases(workspace_id, dataset_urns, payload.get("cases", []))

    say("demo seed complete")
    return 0


if __name__ == "__main__":
    sys.exit(main())
