#!/usr/bin/env python3
"""Upload the card-disputes demo datasets into the demo tenant through the REAL
ingestion path (the same calls the product's Data > Upload wizard makes):

    POST /api/v1/ingestions          -> create the ingestion + target dataset
    POST /api/v1/uploads             -> open an upload session
    PUT  /api/v1/uploads/{id}/parts/1 (Content-SHA256) -> the bytes
    POST /api/v1/uploads/{id}/complete -> commit, then poll to Iceberg

Dataset names match the pack's binding contract exactly, so the next pack
install resolves them by same-name reuse instead of failing closed.

Usage:
    python upload_demo_data.py <tenant_id> <workspace_id> [admin_sub]

The tenant id is printed by `packs/demo.sh load card-disputes`; the workspace is
that tenant's "Default use case" row in rbac. The admin sub is deterministic:
user-admin-<short>, where short is the pack label demo.sh derives
(card-disputes -> carddisputes).
"""
from __future__ import annotations
import hashlib, json, sys, time
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO / "deploy" / "e2e" / "lib"))
import common as c  # noqa: E402
import requests  # noqa: E402

if len(sys.argv) < 3:
    raise SystemExit(__doc__)
TID = sys.argv[1]
WS = sys.argv[2]
SUB = sys.argv[3] if len(sys.argv) > 3 else "user-admin-carddisputes"
ING = "http://localhost:8303"          # ingestion-service (NOT 8302)
DATA = Path(__file__).parent / "data"

TOK = c.user_token(SUB, TID, ["*"], workspace_id=WS)
H = {"Authorization": f"Bearer {TOK}"}
J = {**H, "Content-Type": "application/json"}


def upload(name: str, path: Path) -> None:
    data = path.read_bytes()
    r = requests.post(f"{ING}/api/v1/ingestions", headers=J, json={
        "ingestion_mode": "file_upload", "file_format": "csv",
        "workspace_id": WS, "new_dataset": {"name": name}, "skip_profiling": True})
    assert r.status_code in (200, 201, 202), f"{name} create: {r.status_code} {r.text[:300]}"
    ing_id = (r.json().get("data") or r.json())["id"]

    r = requests.post(f"{ING}/api/v1/uploads", headers=J,
                      json={"ingestion_id": ing_id, "bytes_total": len(data)})
    assert r.status_code in (200, 201), f"{name} open: {r.status_code} {r.text[:300]}"
    up = r.json().get("data", {})
    uid = up.get("id") or up.get("upload_id")

    sha = hashlib.sha256(data).hexdigest()
    r = requests.put(f"{ING}/api/v1/uploads/{uid}/parts/1",
                     headers={**H, "Content-SHA256": sha}, data=data)
    assert r.status_code in (200, 201), f"{name} part: {r.status_code} {r.text[:300]}"
    etag = r.json().get("data", {}).get("etag")

    r = requests.post(f"{ING}/api/v1/uploads/{uid}/complete", headers=J,
                      json={"parts": [{"n": 1, "etag": etag, "size": len(data)}], "sha256": sha})
    assert r.status_code in (200, 201, 202), f"{name} complete: {r.status_code} {r.text[:300]}"

    for _ in range(60):
        g = requests.get(f"{ING}/api/v1/ingestions/{ing_id}", headers=H)
        gd = g.json().get("data", {}) if g.status_code == 200 else {}
        st = gd.get("status")
        if st in ("completed", "succeeded"):
            print(f"  ok  {name}: rows={gd.get('rows_appended') or gd.get('rows')} urn={gd.get('dataset_urn')}")
            return
        if st in ("failed", "error"):
            raise SystemExit(f"  FAIL {name}: {json.dumps(gd)[:400]}")
        time.sleep(2)
    raise SystemExit(f"  TIMEOUT {name}")


for n in ("cd-cardholders", "cd-transactions", "cd-disputes"):
    upload(n, DATA / f"{n}.csv")
print("ALL 3 BINDING DATASETS UPLOADED")
