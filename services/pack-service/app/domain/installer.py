"""Install orchestration — the governed, in-cluster promotion of packctl.

pack-service does NOT reinvent materialization: it reuses packctl's proven,
idempotent ``PlatformClient.ensure_*`` calls against Core's real public APIs.
What it ADDS over the packctl CLI is the governed-service envelope: it runs the
install AS THE INSTALLING USER (the user's JWT is forwarded, so every write is
authorized truthfully), persists a durable DB registry + ledger, computes a
dry-run PLAN before applying, origin-tags every materialized object, and can
reverse them on uninstall.

Increment 1 materializes the component kinds a single authorized principal can
create without a distinct four-eyes approver: dispositions, roles, saved
queries, and governed decision tables. Kinds that need a four-eyes approver
(semantic models, verified queries) or a data-ingestion chain (datasets,
dashboards, cases, pipelines) are reported in the plan as ``deferred`` — honest,
never faked — pending the follow-on that gives pack-service a governed approver
identity.
"""

from __future__ import annotations

import uuid
from typing import Any, Callable

from app.config import Settings
from app.domain import catalog

# Kinds inc1 materializes, in dependency order (dispositions before decision
# tables, whose outcome codes the case-service catalog validates). These are the
# self-contained kinds a single authorized principal creates without a four-eyes
# approver AND without the data-ingestion chain — so they install cleanly on
# their own. (saved_queries/dashboards need the pack's datasets first, which is
# a deferred kind; they're reported `deferred` in the plan, not faked.)
INC1_KINDS = ("dispositions", "roles", "decision_models")

# Kinds whose Core service exposes a real revert (delete) verb → reversible on
# uninstall. Others are ledgered + tombstoned honestly (PKG-FR-025): the object
# is retained and loses its pack-origin marker, because Core has no delete verb
# for it yet — a real, surfaced gap in the materialization contract (PKG-FR-030).
REVERSIBLE_KINDS = {"roles", "saved_queries", "dashboards"}


def _packctl_client():
    catalog._packctl()  # ensure packs dir on sys.path
    from packctl.client import Endpoints, PlatformClient  # noqa: PLC0415

    return Endpoints, PlatformClient


def _endpoints(settings: Settings):
    Endpoints, _ = _packctl_client()
    return Endpoints(
        ingestion=settings.ingestion_url, dataset=settings.dataset_url,
        semantic=settings.semantic_url, query=settings.query_url,
        chart=settings.chart_url, case=settings.case_url,
        rbac=settings.rbac_svc_url, agent=settings.agent_url,
        memory=settings.memory_url, pipeline=settings.pipeline_url,
    )


def build_client(settings: Settings, tenant_id: str, workspace_id: str, user_jwt: str):
    """A packctl PlatformClient that authors every write AS the installing user
    (the forwarded JWT is used for all three token roles; inc1 only exercises the
    single-principal author path)."""
    _, PlatformClient = _packctl_client()

    def token() -> str:
        return user_jwt

    return PlatformClient(
        endpoints=_endpoints(settings), tenant_id=tenant_id, workspace_id=workspace_id,
        author_token=token, approver_token=token, agent_token=token,
        log=lambda *_: None,
    )


# ---- dry-run plan -----------------------------------------------------------

def plan(client, manifest) -> list[dict]:
    """Compute what an install WOULD do without any side effect (PKG-FR-020):
    per component, `create` (new) or `exists` (idempotent no-op); kinds inc1
    doesn't materialize are `deferred` with a reason."""
    ops: list[dict] = []
    existing = _existing_names(client)
    for comp in manifest.components:
        if comp.kind not in INC1_KINDS:
            ops.append({"kind": comp.kind, "identity": comp.identity,
                        "action": "deferred",
                        "detail": "not materialized by pack-service inc1 "
                                  "(needs a four-eyes approver or data-ingestion chain)"})
            continue
        for name in _component_names(manifest, comp):
            action = "exists" if name in existing.get(comp.kind, set()) else "create"
            ops.append({"kind": comp.kind, "identity": comp.identity,
                        "name": name, "action": action})
    return ops


def _existing_names(client) -> dict[str, set[str]]:
    """The set of already-present object names/codes per kind (idempotency)."""
    ws = client.workspace_id
    out: dict[str, set[str]] = {}

    def names(resp, key) -> set[str]:
        if resp.status_code != 200:
            return set()
        return {str(d.get(key)) for d in (resp.json().get("data") or []) if d.get(key)}

    tok = client.author_token()
    e = client.endpoints
    out["dispositions"] = names(
        client._req("GET", f"{e.case}/api/v1/dispositions?workspace_id={ws}", tok), "code")
    out["roles"] = names(client._req("GET", f"{e.rbac}/api/v1/roles?limit=200", tok), "name")
    out["saved_queries"] = names(
        client._req("GET", f"{e.query}/api/v1/queries?workspace_id={ws}", tok), "name")
    dm = client._req("GET", f"{e.agent}/api/v1/decision-models", tok)
    out["decision_models"] = {str(d.get("name")) for d in (dm.json().get("data") or [])
                              if dm.status_code == 200 and d.get("workspace_id") == ws
                              and d.get("name")}
    return out


def _component_names(manifest, comp) -> list[str]:
    """The human names a component file will create (for the plan)."""
    from packctl.manifest import load_component_file  # noqa: PLC0415

    doc = load_component_file(manifest, comp)
    if comp.kind == "dispositions":
        return [d["code"] for d in doc]
    if comp.kind == "roles":
        return [r["name"] for r in doc]
    if comp.kind == "saved_queries":
        return [q["name"] for q in (doc if isinstance(doc, list) else [doc])]
    if comp.kind == "decision_models":
        return [dm["name"] for dm in (doc if isinstance(doc, list) else [doc])]
    return [comp.identity]


# ---- execute ----------------------------------------------------------------

def run_install(client, manifest, origin_of: Callable[[str, str], str]) -> list[dict]:
    """Materialize the inc1 kinds in order, capturing each object's real id (so
    uninstall can reverse it) + its create/noop/failed action. One ledger row
    per materialized object, origin-tagged."""
    from packctl.manifest import load_component_file  # noqa: PLC0415

    records: list[dict] = []

    def do(kind, comp, name, target_id_call):
        before = len(client.actions)
        obj_id = target_id_call()
        acts = client.actions[before:]
        # The object's OWN action is the first one this ensure_* recorded
        # (a later 'verify' row, e.g. role→group binding, is not the object's).
        first = acts[0] if acts else {}
        action = first.get("action") or ("failed" if obj_id is None else "create")
        urn = first.get("urn")
        records.append({
            "id": str(uuid.uuid4()), "kind": kind, "identity": name,
            "target_urn": urn, "target_id": obj_id or _urn_id(urn),
            "origin": origin_of(kind, name), "action": action,
            "detail": first.get("detail", ""),
            "reversible": kind in REVERSIBLE_KINDS and action == "create" and bool(obj_id),
        })

    for kind in INC1_KINDS:
        for comp in manifest.components_of(kind):
            doc = load_component_file(manifest, comp)
            if kind == "dispositions":
                for d in doc:
                    do("dispositions", comp, d["code"],
                       lambda d=d: client.ensure_disposition(
                           comp.identity, d["code"], d["label"], d["category"],
                           d.get("requires_note", False)))
            elif kind == "roles":
                for role in doc:
                    do("roles", comp, role["name"],
                       lambda role=role: client.ensure_role(
                           comp.identity, role["name"], role["actions"]))
            elif kind == "decision_models":
                for dm in (doc if isinstance(doc, list) else [doc]):
                    do("decision_models", comp, dm["name"],
                       lambda dm=dm: client.ensure_decision_model(
                           dm.get("identity", comp.identity), dm["name"], dm["rules"],
                           dm.get("default_outcome")))
    return records


def _urn_id(urn: str | None) -> str | None:
    if not urn or "/" not in urn:
        return None
    return urn.rsplit("/", 1)[-1]


def run_uninstall(client, ledger: list[dict]) -> list[dict]:
    """Reverse what the pack created (PKG-FR-025). Kinds with a real Core delete
    verb are deleted; the rest are tombstoned (retained, pack-origin cleared)
    with an honest reason. Returns per-row outcomes."""
    e = client.endpoints
    tok = client.author_token()
    outcomes: list[dict] = []
    for row in ledger:
        if row.get("tombstoned"):
            continue
        kind, tid = row["kind"], row.get("target_id")
        if kind == "roles" and row.get("reversible") and tid:
            # A role can't be deleted while bound to its permission group (409).
            # ensure_role creates a same-named permission group + binds the role,
            # so unbind (+ drop the group) before deleting the role.
            _unbind_role_group(client, e, tok, role_name=row["identity"], role_id=tid)
            r = client._req("DELETE", f"{e.rbac}/api/v1/roles/{tid}", tok)
            ok = r.status_code in (200, 204)
            outcomes.append({"ledger_id": row["id"], "deleted": ok,
                             "detail": "role + permission group removed" if ok
                                       else f"delete {r.status_code}"})
        elif kind == "saved_queries" and tid:
            r = client._req("DELETE", f"{e.query}/api/v1/queries/{tid}", tok)
            ok = r.status_code in (200, 204)
            outcomes.append({"ledger_id": row["id"], "deleted": ok,
                             "detail": "deleted" if ok else f"delete {r.status_code}"})
        elif kind == "dashboards" and tid:
            r = client._req("DELETE", f"{e.chart}/api/v1/dashboards/{tid}", tok)
            ok = r.status_code in (200, 204)
            outcomes.append({"ledger_id": row["id"], "deleted": ok,
                             "detail": "deleted" if ok else f"delete {r.status_code}"})
        else:
            outcomes.append({"ledger_id": row["id"], "deleted": False,
                             "detail": f"Core exposes no revert verb for '{kind}'; "
                                       "object retained, pack-origin marker cleared"})
    return outcomes


def _unbind_role_group(client, e, tok, *, role_name: str, role_id: str) -> None:
    """Unbind a pack role from its same-named permission group and drop the
    group, so the role becomes deletable (rbac 409s on a still-bound role)."""
    g = client._req("GET", f"{e.rbac}/api/v1/groups?filter[group_type]=permission&limit=300", tok)
    if g.status_code != 200:
        return
    grp = next((x for x in g.json().get("data", []) if x.get("name") == role_name), None)
    if not grp:
        return
    gid = grp["id"]
    client._req("DELETE", f"{e.rbac}/api/v1/groups/{gid}/roles/{role_id}", tok)
    client._req("DELETE", f"{e.rbac}/api/v1/groups/{gid}", tok)


def origin_tag(pack: str, version: str) -> Callable[[str, str], str]:
    def _of(kind: str, identity: str) -> str:
        return f"pack:{pack}@{version}:{kind}/{identity}"

    return _of


def to_jsonable(v: Any) -> Any:  # pragma: no cover
    return v
