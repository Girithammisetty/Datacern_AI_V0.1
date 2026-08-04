#!/usr/bin/env python3
"""Does the tenant's clinical system of record change ONLY through the governed
loop? Assert on the FHIR server's state.

fhir-bridge fronts an external FHIR R4 backend (Epic/Cerner/HAPI-class) behind
tool-plane: reads are direct-tier tools, writes are write-proposal tools that
require a human-approved RS256 grant. Every one of those claims is a thing the
platform SAYS about itself — the acknowledgements all read clean whether or not
the clinical store actually moved (see test_governed_write_loop.py for the day
that lesson was paid for). So this journey runs its own in-process FHIR R4
sandbox server as the system of record and asserts on ITS bytes, never on a
gateway response:

  - the bridge attaches the tenant's Vault-stored bearer auth (the sandbox
    401s every unauthenticated call, so /metadata ok:true proves attachment);
  - a governed READ through mcp-gateway returns the actual patient;
  - an UNGRANTED write is refused (proposal_required) and the sandbox store is
    byte-for-byte unchanged;
  - a FORGED grant (wrong signing key) is refused the same way — unchanged;
  - the legitimately-minted grant (same issuer/key/claims agent-runtime uses,
    args_digest over the exact args) lands EXACTLY ONE new resource whose
    fields match the approved args — read back from the sandbox directly;
  - all of read + 2 refused + 1 executed appear in tool-plane's invocation_log
    (the persisted row behind ai.tool_invoked.v1, audit completeness).

Usage (needs a running stack -- `make up` / `make journey-fhir`):
    deploy/e2e/.venv/bin/python deploy/e2e/test_fhir_journey.py
Sandbox-server self-check only (stdlib, no stack, no venv):
    python3 deploy/e2e/test_fhir_journey.py --selftest-sandbox
Exit 0 = the governed FHIR loop is intact. Non-zero = it is not.
"""
from __future__ import annotations

import json
import os
import sys
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qsl, urlparse

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "deploy" / "e2e" / "lib"))

FHIR_BRIDGE = os.environ.get("FHIR_BRIDGE_URL", "http://localhost:8325")
TOOL_PLANE_DSN = "postgresql://datacern:datacern_dev@localhost:5432/tool_plane"
READ_TOOL = "fhir.read_resource"
CREATE_TOOL = "fhir.create_resource"
RUN = uuid.uuid4().hex[:8]

_fail: list[str] = []


def check(ok: bool, label: str, detail: str = "") -> bool:
    print(("  ok   " if ok else "  FAIL ") + label
          + (f"  -- {detail}" if detail and not ok else ""))
    if not ok:
        _fail.append(label)
    return ok


# ---------------------------------------------------------------- sandbox FHIR
class SandboxFHIRServer(ThreadingHTTPServer):
    """Minimal FHIR R4 system of record, held in memory so the journey can
    assert on its exact state. Every route requires the fixed bearer token —
    an ok:true probe through the bridge therefore PROVES auth attachment."""

    daemon_threads = True

    def __init__(self, token: str):
        super().__init__(("127.0.0.1", 0), _SandboxHandler)
        self.token = token
        self.lock = threading.Lock()
        self.store: dict[str, dict] = {}   # "Type/id" -> resource
        self._next_id = 0

    @property
    def base_url(self) -> str:
        return f"http://127.0.0.1:{self.server_address[1]}"

    def put_resource(self, rtype: str, rid: str, resource: dict) -> None:
        with self.lock:
            self.store[f"{rtype}/{rid}"] = {**resource,
                                            "resourceType": rtype, "id": rid}

    def assign_id(self) -> str:
        with self.lock:
            self._next_id += 1
            return f"srv-{self._next_id}"

    def snapshot(self) -> str:
        """Canonical byte snapshot — the ground truth the refusal checks
        compare against."""
        with self.lock:
            return json.dumps(self.store, sort_keys=True,
                              separators=(",", ":"), ensure_ascii=False)


class _SandboxHandler(BaseHTTPRequestHandler):
    server: SandboxFHIRServer

    def log_message(self, *_args):  # journey output stays readable
        pass

    def _json(self, status: int, body: dict, location: str | None = None):
        raw = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/fhir+json")
        self.send_header("Content-Length", str(len(raw)))
        if location:
            self.send_header("Location", location)
        self.end_headers()
        self.wfile.write(raw)

    def _outcome(self, status: int, code: str):
        self._json(status, {"resourceType": "OperationOutcome",
                            "issue": [{"severity": "error", "code": code}]})

    def _authed(self) -> bool:
        if self.headers.get("Authorization") == f"Bearer {self.server.token}":
            return True
        self._outcome(401, "login")
        return False

    def _read_body(self) -> dict | None:
        n = int(self.headers.get("Content-Length") or 0)
        try:
            obj = json.loads(self.rfile.read(n) or b"{}")
        except json.JSONDecodeError:
            obj = None
        if not isinstance(obj, dict):
            self._outcome(400, "invalid")
            return None
        return obj

    def do_GET(self):
        if not self._authed():
            return
        u = urlparse(self.path)
        parts = [p for p in u.path.split("/") if p]
        if parts == ["metadata"]:
            self._json(200, {"resourceType": "CapabilityStatement",
                             "status": "active", "fhirVersion": "4.0.1",
                             "kind": "instance",
                             "format": ["application/fhir+json"]})
            return
        if len(parts) == 2:  # read: /{Type}/{id}
            res = self.server.store.get(f"{parts[0]}/{parts[1]}")
            if res is None:
                self._outcome(404, "not-found")
            else:
                self._json(200, res)
            return
        if len(parts) == 1:  # search: /{Type}?{params}
            params = dict(parse_qsl(u.query))
            with self.server.lock:
                matches = [r for k, r in sorted(self.server.store.items())
                           if k.startswith(parts[0] + "/")
                           and all(str(r.get(pk)) == pv
                                   for pk, pv in params.items())]
            self._json(200, {"resourceType": "Bundle", "type": "searchset",
                             "total": len(matches),
                             "entry": [{"resource": r} for r in matches]})
            return
        self._outcome(404, "not-found")

    def do_POST(self):  # create: /{Type} -> server-assigned id, 201
        if not self._authed():
            return
        parts = [p for p in urlparse(self.path).path.split("/") if p]
        if len(parts) != 1:
            self._outcome(404, "not-found")
            return
        body = self._read_body()
        if body is None:
            return
        rid = self.server.assign_id()
        self.server.put_resource(parts[0], rid, body)
        self._json(201, self.server.store[f"{parts[0]}/{rid}"],
                   location=f"{parts[0]}/{rid}")

    def do_PUT(self):  # upsert: /{Type}/{id}
        if not self._authed():
            return
        parts = [p for p in urlparse(self.path).path.split("/") if p]
        if len(parts) != 2:
            self._outcome(404, "not-found")
            return
        body = self._read_body()
        if body is None:
            return
        existed = f"{parts[0]}/{parts[1]}" in self.server.store
        self.server.put_resource(parts[0], parts[1], body)
        self._json(200 if existed else 201,
                   self.server.store[f"{parts[0]}/{parts[1]}"])


def start_sandbox(token: str) -> SandboxFHIRServer:
    srv = SandboxFHIRServer(token)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


def sandbox_get(base: str, token: str, path: str) -> tuple[int, dict]:
    """Direct read of the system of record (stdlib on purpose: the state
    assertion must not share a client stack with the path under test)."""
    import urllib.error
    import urllib.request
    req = urllib.request.Request(f"{base}/{path}",
                                 headers={"Authorization": f"Bearer {token}"})
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")


def selftest_sandbox() -> int:
    """Stdlib-only unit run of the sandbox server (no stack needed)."""
    srv = start_sandbox("tok-selftest")
    base = srv.base_url
    st, _ = sandbox_get(base, "wrong-token", "metadata")
    check(st == 401, "sandbox rejects a bad bearer token")
    st, caps = sandbox_get(base, "tok-selftest", "metadata")
    check(st == 200 and caps.get("fhirVersion") == "4.0.1",
          "metadata serves an R4 CapabilityStatement")
    srv.put_resource("Patient", "p1", {"name": [{"family": "Kelly"}]})
    st, res = sandbox_get(base, "tok-selftest", "Patient/p1")
    check(st == 200 and res["name"][0]["family"] == "Kelly", "read returns the stored resource")
    st, _ = sandbox_get(base, "tok-selftest", "Patient/absent")
    check(st == 404, "read of a missing id is 404")
    import urllib.request
    req = urllib.request.Request(
        f"{base}/Observation", method="POST",
        data=json.dumps({"status": "final"}).encode(),
        headers={"Authorization": "Bearer tok-selftest",
                 "Content-Type": "application/fhir+json"})
    with urllib.request.urlopen(req, timeout=10) as r:
        created = json.loads(r.read())
        check(r.status == 201 and created["id"].startswith("srv-"),
              "create assigns a server id and returns 201")
    st, bundle = sandbox_get(base, "tok-selftest", "Observation?status=final")
    check(st == 200 and bundle["type"] == "searchset" and bundle["total"] == 1,
          "search returns a searchset Bundle of matches")
    snap = srv.snapshot()
    check(snap == srv.snapshot() and "srv-1" in snap, "snapshot is stable and canonical")
    srv.shutdown()
    print("\n" + ("sandbox selftest PASS" if not _fail else "sandbox selftest FAIL"))
    return 0 if not _fail else 1


# -------------------------------------------------------------------- journey
def main() -> int:  # noqa: PLR0915 — journeys read top to bottom, like the others
    import common as c  # noqa: E402
    import psycopg  # noqa: E402
    import requests  # noqa: E402
    import seed  # noqa: E402

    print("\nGoverned FHIR loop -- does the clinical store change ONLY via the loop?\n")

    P = json.load(open(REPO / "deploy" / "local" / "run" / "personas.json"))
    HUMAN = P["admin@demo.datacern"]      # the effective human (obo_sub)
    APPROVER = P["manager@demo.datacern"]  # a DIFFERENT human signs the grant
    TENANT = HUMAN["tenantId"]
    SESSION = f"fhir-journey-{RUN}"

    def api(method, url, token, body=None, timeout=60):
        return requests.request(method, url, json=body, timeout=timeout,
                                headers={"Authorization": f"Bearer {token}",
                                         "Content-Type": "application/json"})

    def mcp_call(token, tool_id, args, grant=None):
        # No _meta.version: the pipeline resolves the published version (the
        # 1.0.0 that step 1 asserted), same as the e2e driver's calls.
        params = {"name": tool_id, "arguments": args, "_meta": {}}
        if grant is not None:
            params["_meta"]["proposal_grant"] = grant
        r = requests.post(f"{c.MCP_GATEWAY}/mcp", timeout=60,
                          headers={"Authorization": f"Bearer {token}",
                                   "Content-Type": "application/json"},
                          json={"jsonrpc": "2.0", "id": RUN,
                                "method": "tools/call", "params": params})
        r.raise_for_status()
        body = r.json()
        # A JSON-RPC error (bad token, policy unavailable) has no result; keep
        # it visible so a failed check prints the actual refusal.
        return body.get("result") or {"rpc_error": body.get("error")}

    # --- 0. sandbox FHIR system of record ------------------------------------
    sandbox_token = f"sbx-{uuid.uuid4().hex}"
    srv = start_sandbox(sandbox_token)
    st, _ = sandbox_get(srv.base_url, "not-the-token", "metadata")
    if not check(st == 401, "fixture: sandbox refuses unauthenticated calls",
                 f"got {st} — an open sandbox proves nothing about auth attachment"):
        return 1
    st, caps = sandbox_get(srv.base_url, sandbox_token, "metadata")
    if not check(st == 200 and caps.get("fhirVersion") == "4.0.1",
                 "fixture: sandbox serves R4 metadata", f"{st} {caps}"):
        return 1
    print(f"  sandbox FHIR server at {srv.base_url}\n")

    # --- 1. the four fhir.* tools are registered (idempotent re-seed) --------
    seed.register_fhir_tools(TENANT)
    with psycopg.connect(TOOL_PLANE_DSN) as cn:
        cn.execute("SELECT set_config('app.role','platform', false)")
        pub = {row[0] for row in cn.execute(
            "SELECT tool_id FROM tool_versions WHERE tool_id LIKE 'fhir.%' "
            "AND version='1.0.0' AND status='published'").fetchall()}
        backend_row = cn.execute(
            "SELECT internal_url FROM mcp_backends WHERE name='fhir-bridge' "
            "AND status='active'").fetchone()
        db_start = cn.execute("SELECT now()").fetchone()[0]
    want = {READ_TOOL, "fhir.search_resources", CREATE_TOOL, "fhir.update_resource"}
    if not check(want <= pub, "fhir.* tools published at 1.0.0 in tool-plane",
                 f"published={sorted(pub)}"):
        return 1
    if not check(bool(backend_row) and backend_row[0].startswith(FHIR_BRIDGE),
                 "mcp_backends federates fhir tools to the bridge facade",
                 f"row={backend_row}"):
        return 1

    # --- 2. connect the sandbox as the tenant's backend (REST + Vault) -------
    # A platform-signed service token with the EXACT fhir.backend.* scopes: the
    # rbac policy's explicit-scope service rule authorizes it without any
    # per-user projection (datacern_authz_input.rego), so this stays about the
    # bridge, not about persona seeding.
    admin_tok = c.service_token(f"svc:fhir-journey-{RUN}", TENANT,
                                ["fhir.backend.create", "fhir.backend.read",
                                 "fhir.backend.list", "fhir.backend.delete"])
    r = api("POST", f"{FHIR_BRIDGE}/api/v1/fhir-backends", admin_tok,
            {"name": f"e2e-sandbox-{RUN}", "base_url": srv.base_url,
             "auth_method": "bearer", "secret": {"token": sandbox_token}})
    if not check(r.status_code == 201, "backend registered via the bridge REST API",
                 f"{r.status_code} {r.text[:200]}"):
        return 1
    backend_id = r.json()["data"]["id"]
    try:
        r = api("POST", f"{FHIR_BRIDGE}/api/v1/fhir-backends/{backend_id}/test",
                admin_tok)
        probe = (r.json().get("data") or {}) if r.status_code == 200 else {}
        # ok:true is only reachable with the Vault-stored bearer attached — the
        # sandbox 401s everything else (proved in step 0).
        if not check(probe.get("ok") is True and probe.get("fhir_version") == "4.0.1",
                     "bridge reached the sandbox WITH auth attached (/test ok:true)",
                     f"{r.status_code} {r.text[:200]}"):
            return 1

        # --- 3. fixture state: a patient exists in the system of record ------
        patient_id = f"pat-{RUN}"
        srv.put_resource("Patient", patient_id,
                         {"name": [{"family": "Okafor", "given": ["Adaeze"]}],
                          "birthDate": "1984-02-17"})

        # --- 4. governed READ through mcp-gateway ----------------------------
        # The OBO token's dotted scopes ARE the pinned toolset (TPL-FR-031);
        # the facade then re-authorizes the effective human against OPA for
        # fhir.resource.* (admin persona -> rbac admin flag).
        obo_tok = c.agent_obo_token(HUMAN["sub"], TENANT,
                                    ["*", READ_TOOL, CREATE_TOOL], SESSION,
                                    workspace_id=HUMAN.get("workspaceId"))
        read_args = {"backend_id": backend_id, "resource_type": "Patient",
                     "resource_id": patient_id}
        res = mcp_call(obo_tok, READ_TOOL, read_args)
        got = ((res.get("structuredContent") or {}).get("resource") or {})
        if not check(res.get("isError") is False
                     and got.get("id") == patient_id
                     and got.get("name", [{}])[0].get("family") == "Okafor",
                     "governed READ returned the actual patient",
                     json.dumps(res)[:300]):
            return 1

        # Identical args for every write attempt below: the refusals and the
        # approved execution then share one args_digest, so the audit query and
        # the exactly-one-new-resource check bind to THESE calls and duplicates
        # from the refused attempts cannot hide.
        create_args = {"backend_id": backend_id, "resource_type": "Observation",
                       "resource": {"resourceType": "Observation", "status": "final",
                                    "code": {"text": f"triage-note-{RUN}"},
                                    "valueString": "governed-fhir-journey"}}
        before = srv.snapshot()

        # --- 5. UNGRANTED write refused, store unchanged ---------------------
        res = mcp_call(obo_tok, CREATE_TOOL, create_args)
        sc = res.get("structuredContent") or {}
        check(sc.get("status") == "proposal_required",
              "ungranted write refused with proposal_required", json.dumps(res)[:300])
        check(srv.snapshot() == before,
              "clinical store byte-for-byte unchanged after the ungranted attempt")

        # --- 6. FORGED grant refused, store unchanged ------------------------
        import jwt as pyjwt
        from cryptography.hazmat.primitives.asymmetric import rsa
        rogue = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        forged = pyjwt.encode(
            {"iss": "datacern-agent-runtime", "sub": APPROVER["sub"],
             "iat": int(time.time()), "exp": int(time.time()) + 120,
             "proposal_id": "p-forged", "tenant_id": TENANT,
             "tool_id": CREATE_TOOL, "tier": "write-proposal",
             "args_digest": c.args_digest(create_args)},
            rogue, algorithm="RS256", headers={"kid": "rogue-key"})
        res = mcp_call(obo_tok, CREATE_TOOL, create_args, grant=forged)
        sc = res.get("structuredContent") or {}
        check(sc.get("status") == "proposal_required" and "resource" not in sc,
              "FORGED grant refused — falls back to proposal_required",
              json.dumps(res)[:300])
        check(srv.snapshot() == before,
              "clinical store byte-for-byte unchanged after the forged attempt")

        # --- 7. the legitimate grant lands, and the STATE proves it ----------
        # Minted exactly as agent-runtime's GrantIssuer does on human APPROVE
        # (same issuer, same harness signing key tool-plane's PROPOSAL_JWKS_URL
        # trusts, args_digest over the exact args) — the same recipe the e2e
        # driver uses for case.apply_disposition.
        grant = c.proposal_grant(sub=APPROVER["sub"], tenant_id=TENANT,
                                 tool_id=CREATE_TOOL,
                                 args_digest_hex=c.args_digest(create_args),
                                 proposal_id=f"p-fhir-{RUN}")
        res = mcp_call(obo_tok, CREATE_TOOL, create_args, grant=grant)
        sc = res.get("structuredContent") or {}
        created = sc.get("resource") or {}
        if not check(res.get("isError") is False and sc.get("status") == 201
                     and created.get("id"),
                     "granted write executed through the federated path",
                     json.dumps(res)[:300]):
            return 1

        # THE ASSERTION THAT MATTERS: read the system of record directly.
        st, stored = sandbox_get(srv.base_url, sandbox_token,
                                 f"Observation/{created['id']}")
        check(st == 200
              and stored.get("code", {}).get("text") == f"triage-note-{RUN}"
              and stored.get("valueString") == "governed-fhir-journey"
              and stored.get("status") == "final",
              "THE RESOURCE EXISTS IN THE CLINICAL STORE with the approved fields",
              f"GET -> {st} {json.dumps(stored)[:200]}")
        after = json.loads(srv.snapshot())
        new_keys = set(after) - set(json.loads(before))
        check(new_keys == {f"Observation/{created['id']}"},
              "EXACTLY ONE new resource (refused attempts left no duplicates)",
              f"new={sorted(new_keys)}")

        # --- 8. audit trail: every attempt is on the record ------------------
        # invocation_log is the persisted row RecordInvocation writes alongside
        # each ai.tool_invoked.v1 event — the same ground truth `make journey`
        # points at for denied writes.
        with psycopg.connect(TOOL_PLANE_DSN) as cn:
            cn.execute("SELECT set_config('app.tenant_id', %s, false)", (TENANT,))
            audit = {row[0]: row[1] for row in cn.execute(
                "SELECT decision, count(*) FROM invocation_log "
                "WHERE tool_id=%s AND args_digest=%s AND created_at >= %s "
                "GROUP BY decision",
                (CREATE_TOOL, c.args_digest(create_args), db_start)).fetchall()}
            read_audit = cn.execute(
                "SELECT count(*) FROM invocation_log "
                "WHERE tool_id=%s AND args_digest=%s AND created_at >= %s "
                "AND decision='allowed'",
                (READ_TOOL, c.args_digest(read_args), db_start)).fetchone()[0]
        check(read_audit >= 1, "audit: the governed read is on the record",
              f"allowed read rows={read_audit}")
        check(audit.get("proposal_required", 0) >= 2,
              "audit: BOTH refused write attempts are on the record",
              f"decisions={audit}")
        check(audit.get("allowed", 0) == 1,
              "audit: exactly one EXECUTED write is on the record",
              f"decisions={audit}")
    finally:
        # The sandbox dies with this process; the backend row would dangle.
        api("DELETE", f"{FHIR_BRIDGE}/api/v1/fhir-backends/{backend_id}", admin_tok)
        srv.shutdown()

    print("\n" + ("PASS -- governed FHIR loop intact\n" if not _fail
                  else f"FAIL -- {len(_fail)} check(s): {', '.join(_fail)}\n"))
    return 0 if not _fail else 1


if __name__ == "__main__":
    if "--selftest-sandbox" in sys.argv:
        sys.exit(selftest_sandbox())
    sys.exit(main())
