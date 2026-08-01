#!/usr/bin/env python3
"""Land a demo bundle's CSVs into a pack tenant, so the pack can actually install.

WHY THIS EXISTS. Every pack in the fleet is data-free: `packs/<pack>/data/
datasets.yaml` declares BINDING CONTRACTS (a dataset name + the exact
landing-shape columns the workflow needs) and ships zero rows. At install,
pack-service resolves each declaration against a REAL tenant dataset and
validates the required columns, failing closed with the missing list.

`packs/demo.sh load <pack>` provisions an EMPTY tenant and installs
immediately, so there is nothing to resolve against and the install dies:

    FAIL pack card-disputes failed to install — see ledger
      datasets/cd_disputes: requires_binding: no dataset bound for
      'cd_disputes' and no tenant dataset named 'cd-disputes' exists
      (required columns: dispute_id, cardholder_id, account_id, txn_id, ...)

That is the contract working, not a bug in the pack — but it does mean
`demo.sh load` cannot succeed on its own for any data-free pack, which today
is all of them. The missing step is the one a real customer does first: land
your data.

The data already exists. `deploy/demo/<pack>/data/<identity>.csv` ships one
CSV per declared dataset, and their headers satisfy the declared
required_columns exactly. Nothing here fabricates a shape.

WHAT THIS DOES. For each declaration in the pack's datasets.yaml, ingest
`deploy/demo/<pack>/data/<identity>.csv` into the tenant's default workspace
under the pack's DECLARED name (`cd-disputes`, not `cd_disputes` and not
`demo-cd_disputes`). That name is the whole point: packctl's CLI installer
resolves a file-less declaration by same-name reuse only — explicit URN
bindings are a pack-service install parameter the CLI does not expose — so
the name is what makes the subsequent install resolve.

Idempotent: a dataset that already exists under the declared name is left
alone, so re-running is safe and cheap.

NOT the same as `packs/demo_sandbox.sh`, which seeds datasets under
`demo-<identity>` plus personas and cases through identity-service's
demo-sandbox path, and never installs the pack. The two are complementary:
this one makes the pack CONFIG installable; that one gives you a WORKLIST.

Usage (stack must be up — `make up`):
    packs/demo.sh load card-disputes          # creates the tenant, fails to install
    deploy/e2e/.venv/bin/python packs/land_pack_data.py --pack card-disputes
    packs/demo.sh load card-disputes          # now resolves and installs

    # any tenant, not just the wr-demo-* one demo.sh makes:
    ... land_pack_data.py --pack card-disputes --tenant wr-payer

Exit 0 = every declared dataset is present and readable. Non-zero = at least
one is not, with the reason printed.
"""
from __future__ import annotations

import argparse
import hashlib
import os
import sys
import time
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "deploy" / "e2e" / "lib"))
sys.path.insert(0, str(REPO / "packs"))

import common as c  # noqa: E402
import requests  # noqa: E402
import yaml  # noqa: E402

GRN, YEL, RED, BLD, NC = "\033[32m", "\033[33m", "\033[31m", "\033[1m", "\033[0m"


def ok(m: str) -> None:
    print(f"{GRN}  ok{NC} {m}")


def warn(m: str) -> None:
    print(f"{YEL}  warn{NC} {m}")


def die(m: str) -> None:
    print(f"{RED}ERROR{NC} {m}", file=sys.stderr)
    raise SystemExit(1)


def api(method, url, token, **kw):
    kw.setdefault("timeout", 300)
    headers = kw.pop("headers", {})
    headers["Authorization"] = f"Bearer {token}"
    return requests.request(method, url, headers=headers, **kw)


def resolve_tenant(name: str) -> str:
    su = c.superadmin_token()
    r = api("GET", f"{c.IDENTITY}/api/v1/tenants?limit=200", su)
    if r.status_code != 200:
        die(f"list tenants: {r.status_code} {r.text[:200]}")
    for t in (r.json().get("tenants") or r.json().get("data") or []):
        if (t.get("name") or "").lower() == name.lower():
            return t["id"]
    die(f"no tenant named {name!r} — run `packs/demo.sh load <pack>` first "
        f"(it provisions the tenant before it tries to install)")


def resolve_workspace(tid: str) -> str:
    """Reuse the onboarding script's own resolver rather than reimplementing it.

    Deliberate: `GET /api/v1/workspaces` is visibility-filtered per principal
    (rbac router.go: "list/get are visibility-filtered for any authenticated
    principal"), so a fresh admin with no materialized projection can legally
    see zero workspaces — and picking the wrong workspace here would land the
    datasets somewhere the installer never looks. install_packs_multitenant
    reads the row directly for exactly that reason, so call ITS resolver and
    the workspace is the same one by construction."""
    import install_packs_multitenant as base  # noqa: PLC0415
    return base.ensure_rbac_seeded(tid)


def short_of(tenant_name: str, pack: str) -> str:
    """The `short` token onboarding derives its admin sub from.

    demo.sh builds `wr-demo-<pack>` and passes short=<pack minus non-alnum>;
    the hand-rolled pack tenants in MULTITENANT_LOGINS.md are `wr-<short>`.
    Stripping the prefix off the TENANT name covers both, so --tenant against
    an existing pack tenant mints a sub that actually has the admin grant."""
    n = tenant_name
    for prefix in ("wr-demo-", "wr-"):
        if n.startswith(prefix):
            n = n[len(prefix):]
            break
    else:
        n = pack
    return "".join(ch for ch in n if ch.isalnum())


def existing_dataset(tok: str, ws: str, name: str) -> dict | None:
    r = api("GET", f"{c.DATASET}/api/v1/datasets?workspace_id={ws}", tok)
    if r.status_code != 200:
        return None
    for ds in r.json().get("data", []):
        if ds.get("name") == name:
            return ds
    return None


def readable_columns(tok: str, ds_id: str) -> list[str] | None:
    """The 1-row browse pack-service itself uses to validate required_columns.
    None means "not readable yet", which the installer treats as unverifiable
    and fails on — so this, not the dataset row, is what we wait for."""
    r = api("GET", f"{c.DATASET}/api/v1/datasets/{ds_id}/rows?limit=1", tok)
    if r.status_code != 200:
        return None
    cols = (r.json().get("data") or r.json()).get("columns")
    return [str(x) for x in cols] if isinstance(cols, list) else None


def ingest_csv(tok: str, ws: str, name: str, blob: bytes) -> bool:
    r = api("POST", f"{c.INGESTION}/api/v1/ingestions", tok,
            json={"ingestion_mode": "file_upload", "file_format": "csv",
                  "workspace_id": ws, "new_dataset": {"name": name},
                  "skip_profiling": True})
    if r.status_code not in (200, 201, 202):
        warn(f"create ingestion for {name!r}: {r.status_code} {r.text[:200]}")
        return False
    ing_id = (r.json().get("data") or r.json()).get("id")

    r = api("POST", f"{c.INGESTION}/api/v1/uploads", tok,
            json={"ingestion_id": ing_id, "bytes_total": len(blob)})
    if r.status_code not in (200, 201):
        warn(f"open upload for {name!r}: {r.status_code} {r.text[:200]}")
        return False
    up = r.json().get("data") or {}
    upload_id = up.get("id") or up.get("upload_id")

    sha = hashlib.sha256(blob).hexdigest()
    r = api("PUT", f"{c.INGESTION}/api/v1/uploads/{upload_id}/parts/1", tok,
            data=blob, headers={"Content-SHA256": sha})
    if r.status_code not in (200, 201):
        warn(f"put part for {name!r}: {r.status_code} {r.text[:200]}")
        return False
    etag = (r.json().get("data") or {}).get("etag")

    r = api("POST", f"{c.INGESTION}/api/v1/uploads/{upload_id}/complete", tok,
            json={"parts": [{"n": 1, "etag": etag, "size": len(blob)}], "sha256": sha})
    if r.status_code not in (200, 201, 202):
        warn(f"complete upload for {name!r}: {r.status_code} {r.text[:200]}")
        return False

    for _ in range(60):
        g = api("GET", f"{c.INGESTION}/api/v1/ingestions/{ing_id}", tok)
        st = ((g.json().get("data") or {}) if g.status_code == 200 else {}).get("status")
        if st in ("completed", "succeeded"):
            return True
        if st in ("failed", "error"):
            warn(f"ingestion for {name!r} failed: {g.text[:200]}")
            return False
        time.sleep(2)
    warn(f"ingestion for {name!r} did not complete within the poll budget")
    return False


def land_bundle(tok: str, ws: str, pack: str) -> list[str]:
    """Land `pack`'s demo-bundle CSVs into workspace `ws` under the pack's
    DECLARED dataset names, so a subsequent install resolves them by same-name
    reuse. Returns a list of failure strings — empty means every declared
    dataset is present and readable.

    Shared by this script's CLI and by install_packs_multitenant.onboard_tenant,
    which calls it BEFORE installing so the flagship packs install in one shot.
    Idempotent: an existing dataset under the declared name is reused, never
    re-ingested."""
    decl_path = REPO / "packs" / pack / "data" / "datasets.yaml"
    if not decl_path.exists():
        return []
    declared = yaml.safe_load(decl_path.read_text()) or []
    fileless = [d for d in declared if not d.get("file")]
    if not fileless:
        return []

    bundle = REPO / "deploy" / "demo" / pack / "data"
    if not bundle.is_dir():
        return [f"no demo bundle at deploy/demo/{pack}/data — "
                f"{len(fileless)} dataset(s) must be landed from real tenant data"]

    failures: list[str] = []
    for d in fileless:
        identity, name = d["identity"], d["name"]
        need = d.get("required_columns") or []

        ds = existing_dataset(tok, ws, name)
        if ds is None:
            csv_path = bundle / f"{identity}.csv"
            if not csv_path.exists():
                failures.append(f"{identity}: no {csv_path.name} in the bundle")
                continue
            if not ingest_csv(tok, ws, name, csv_path.read_bytes()):
                failures.append(f"{identity}: ingestion failed")
                continue
            for _ in range(60):
                ds = existing_dataset(tok, ws, name)
                if ds:
                    break
                time.sleep(2)
            if ds is None:
                failures.append(f"{identity}: never registered in dataset-service")
                continue
        else:
            ok(f"{name!r} already exists — reusing")

        # Wait on the 1-row browse, not the dataset row: bind_dataset treats
        # unreadable columns as unverifiable and fails the component, so
        # stopping at registration would just move the failure into the install.
        cols = None
        for _ in range(60):
            cols = readable_columns(tok, ds["id"])
            if cols is not None:
                break
            time.sleep(2)
        if cols is None:
            failures.append(f"{identity}: {name!r} has no readable version — "
                            f"the installer cannot validate its columns")
            continue
        missing = [x for x in need if x not in cols]
        if missing:
            failures.append(f"{identity}: {name!r} is missing required columns: "
                            f"{', '.join(missing)}")
            continue
        ok(f"{name!r} ready ({len(cols)} columns, all {len(need)} required present)")
    return failures


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--pack", required=True, help="pack name, e.g. card-disputes")
    ap.add_argument("--tenant", default=None,
                    help="tenant name (default: wr-demo-<pack>, what demo.sh makes)")
    ap.add_argument("--admin-sub", default=None,
                    help="override the admin subject (default: user-admin-<short>, "
                         "derived from the tenant name the way onboarding does)")
    args = ap.parse_args()

    if not (REPO / "packs" / args.pack / "pack.yaml").exists():
        die(f"unknown pack {args.pack!r} (no packs/{args.pack}/pack.yaml)")

    tenant_name = args.tenant or f"wr-demo-{args.pack}"
    tid = resolve_tenant(tenant_name)
    ws = resolve_workspace(tid)
    ok(f"tenant {tenant_name} = {tid}")
    ok(f"workspace = {ws}")
    sub = args.admin_sub or f"user-admin-{short_of(tenant_name, args.pack)}"
    ok(f"acting as {sub}")
    tok = c.user_token(sub, tid, ["*"], workspace_id=ws)

    failures = land_bundle(tok, ws, args.pack)

    print()
    if failures:
        for f in failures:
            print(f"{RED}  FAIL{NC} {f}")
        print(f"\n{RED}{len(failures)} dataset(s) not landed{NC} — the pack install "
              f"will report these as awaiting binding.\n")
        return 1
    print(f"{GRN}{BLD}every declared dataset is landed and readable{NC} — now run:"
          f"\n    packs/demo.sh load {args.pack}\n")
    return 0


if __name__ == "__main__":
    os.environ.setdefault("PYTHONUNBUFFERED", "1")
    sys.exit(main())
