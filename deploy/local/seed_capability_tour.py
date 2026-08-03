#!/usr/bin/env python3
"""Capability-tour seed — the links `make up` was NOT already showing.

seed_claims_demo.py already walks a real chain end to end:

    source file -> ingestion -> dataset -> semantic model -> dashboard + charts
                -> saved query -> cases -> AI triage proposals -> retrain

That is most of the story but not all of it. Four capabilities the platform
genuinely has were invisible on a fresh boot, so a demo had to *describe* them
instead of *showing* them:

    ontology + entity relationships   the governed domain type model (inc11/WS3)
    ML pipeline templates             pipeline-orchestrator, distinct from a run
    evaluation                        eval-service suites + gate rules
    grids + scheduled reports         chart families beyond time-series, and the
                                      digest notification-service actually sends

This module adds exactly those, plus **Jessie** — a TENANT-CUSTOM agent, so the
case-management story has both halves on screen: a human working a case by hand,
and a named AI colleague proposing writes that a human still has to approve.

Design rules, matching seed_claims_demo.py:

  * every stage is BEST-EFFORT and independently skippable. A demo boot must
    never fail because one optional flourish 404s on a service that moved.
  * every stage is IDEMPOTENT — re-running `make up` re-converges rather than
    duplicating. Each one looks for its object by name first.
  * nothing here invents data. Every object is built over the dataset the
    claims seed really ingested; when that dataset is absent the stage says so
    and skips, rather than materializing something a customer would then find
    is not connected to anything.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "e2e"))
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "e2e" / "lib"))

import common as c  # noqa: E402
import driver as d  # noqa: E402

B, G, Y, N = "\033[1m", "\033[32m", "\033[33m", "\033[0m"

SEMANTIC_URL = os.environ.get("SEMANTIC_URL", "http://localhost:8086")
CHART_URL = os.environ.get("CHART_URL", "http://localhost:8320")
NOTIFICATION_URL = os.environ.get("NOTIFICATION_URL", "http://localhost:8323")
EVAL_URL = os.environ.get("EVAL_URL", "http://localhost:8324")

TENANT = d.TENANT


def say(m):
    print(f"{B}==>{N} {m}")


def ok(m):
    print(f"  {G}ok{N}   {m}")


def warn(m):
    print(f"  {Y}!!{N} {m}")


def _tok():
    return c.user_token(d.MANAGER, TENANT, ["*"], workspace_id=d.WORKSPACE)


def _resolve_dataset_urn(tok, dataset_name: str | None) -> str | None:
    """Re-resolve the dataset urn by NAME inside this workspace.

    EVID carries `ingest_dataset_name` but not the urn, and the urn is the one
    thing every downstream stage needs. Resolving by name in-workspace also
    survives a reused dev environment, where prior boots leave same-named
    datasets belonging to other tenants visible (the dev DB role does not FORCE
    row-level security) — the same reason seed_claims_demo re-resolves rather
    than trusting a urn threaded through from earlier."""
    if not dataset_name:
        return None
    r = d.req("GET", f"{c.DATASET}/api/v1/datasets?workspace_id={d.WORKSPACE}", tok)
    if r.status_code != 200:
        return None
    for x in (r.json().get("data") or []):
        if x.get("name") == dataset_name:
            return f"wr:{TENANT}:dataset:dataset/{x['id']}"
    return None


# ---------------------------------------------------------------- 1. ONTOLOGY
# The governed domain TYPE model: what a claim IS, what a provider IS, and how
# they relate. Distinct from the semantic model (flat, dataset-derived, for
# querying) and from entity RESOLUTION (which dedups instances). This is the
# layer a customer's domain expert recognises as "our business", and it is the
# one the copilot grounds on when it explains a case.
ONTOLOGY = [
    {"entity_key": "claim", "name": "Claim",
     "description": "A submitted request for payment against a policy.",
     "attributes": [
         {"name": "claim_id", "data_type": "string", "description": "Natural key"},
         {"name": "amount", "data_type": "number", "description": "Billed amount"},
         {"name": "service_date", "data_type": "date"},
         {"name": "status", "data_type": "string"},
     ],
     "relationships": [
         {"name": "provider", "target": "provider", "cardinality": "belongs_to"},
         {"name": "member", "target": "member", "cardinality": "belongs_to"},
         {"name": "lines", "target": "claim_line", "cardinality": "has_many"},
     ]},
    {"entity_key": "provider", "name": "Provider",
     "description": "The billing entity that rendered the service.",
     "attributes": [
         {"name": "provider_id", "data_type": "string"},
         {"name": "npi", "data_type": "string", "description": "National Provider Identifier"},
         {"name": "specialty", "data_type": "string"},
     ],
     "relationships": [
         {"name": "claims", "target": "claim", "cardinality": "has_many"},
     ]},
    {"entity_key": "member", "name": "Member",
     "description": "The covered individual the claim was submitted for.",
     "attributes": [
         {"name": "member_id", "data_type": "string"},
         {"name": "plan", "data_type": "string"},
     ],
     "relationships": [
         {"name": "claims", "target": "claim", "cardinality": "has_many"},
     ]},
    {"entity_key": "claim_line", "name": "Claim line",
     "description": "One billed service line within a claim.",
     "attributes": [
         {"name": "line_no", "data_type": "number"},
         {"name": "procedure_code", "data_type": "string"},
         {"name": "units", "data_type": "number"},
         {"name": "allowed_amount", "data_type": "number"},
     ],
     "relationships": [
         {"name": "claim", "target": "claim", "cardinality": "belongs_to"},
     ]},
]


def seed_ontology() -> int:
    """Register the domain type model. Idempotent by entity_key per workspace."""
    say("ontology — the governed domain type model (4 types, typed relationships)")
    tok = _tok()
    existing = set()
    r = d.req("GET", f"{c.DATASET}/api/v1/ontology/entities"
                     f"?filter[workspace_id]={d.WORKSPACE}", tok)
    if r.status_code == 200:
        existing = {str(e.get("entity_key")) for e in (r.json().get("data") or [])}
    made = 0
    for e in ONTOLOGY:
        if e["entity_key"] in existing:
            continue
        body = dict(e, workspace_id=d.WORKSPACE)
        rr = d.req("POST", f"{c.DATASET}/api/v1/ontology/entities", tok,
                   headers=d.J(), json=body)
        if rr.status_code in (200, 201):
            made += 1
        else:
            warn(f"ontology {e['entity_key']}: {rr.status_code} {rr.text[:140]}")
    ok(f"{len(existing) + made} entity types registered "
       f"({made} new) — Claim→Provider, Claim→Member, Claim→ClaimLine")
    return made


# ------------------------------------------------------- 2. ML PIPELINE (TEMPLATE)
def seed_pipeline_template(dataset_urn: str | None) -> str | None:
    """An ML pipeline TEMPLATE over the claims dataset.

    Distinct from the retrain the claims seed already runs: that produces a run
    and a model version, this is the reusable authored definition a data
    scientist edits in the builder. Both matter, and only the run was visible.
    """
    say("ML pipeline — an authored, reusable training template")
    if not dataset_urn:
        warn("no dataset_urn — skipping (a pipeline over nothing teaches nothing)")
        return None
    tok = _tok()
    name = "Claims anomaly — training pipeline"
    g = d.req("GET", f"{c.PIPELINE}/api/v1/pipelines?filter[name]={name}", tok)
    if g.status_code == 200:
        for t in (g.json().get("data") or []):
            if t.get("name") == name:
                ok(f"pipeline template already present ({t.get('id')})")
                return str(t.get("id"))
    body = {
        "workspace_id": d.WORKSPACE,
        "name": name,
        "pipeline_type": "training",
        "model_type": "anomaly_detection",
        "definition": {
            "nodes": [
                {"id": "src", "type": "dataset_source",
                 "config": {"dataset_urn": dataset_urn}},
                {"id": "prep", "type": "transform",
                 "config": {"drop_nulls": True, "standardize": True}},
                {"id": "train", "type": "train",
                 "config": {"algorithm": "isolation_forest", "contamination": 0.08}},
            ],
            "edges": [{"from": "src", "to": "prep"}, {"from": "prep", "to": "train"}],
        },
        "run_parameters": {"test_size": 0.2, "random_state": 42},
    }
    r = d.req("POST", f"{c.PIPELINE}/api/v1/pipelines", tok, headers=d.J(), json=body)
    if r.status_code not in (200, 201):
        warn(f"pipeline template: {r.status_code} {r.text[:180]}")
        return None
    tid = str((r.json().get("data") or {}).get("id") or "")
    ok(f"training pipeline authored over the real claims dataset ({tid[:8]}…)")
    return tid or None


# ----------------------------------------------------------------- 3. EVALUATION
def seed_eval_suite() -> str | None:
    """An eval suite with a real gate rule.

    The point on screen is the GATE: a suite that can refuse a promotion is what
    separates "we have evals" from "our evals decide something".
    """
    say("evaluation — a scored suite with a promotion gate")
    tok = _tok()
    suite_id = "claims-triage-quality"
    g = d.req("GET", f"{EVAL_URL}/api/v1/suites/{suite_id}", tok)
    if g.status_code == 200:
        ok(f"eval suite already present ({suite_id})")
        return suite_id
    body = {
        "suite_id": suite_id,
        "agent_key": "case-triage",
        "datasets": [{"name": "golden-triage-set", "kind": "golden", "size": 24}],
        "scorers": [
            {"name": "disposition_exact_match", "kind": "deterministic", "weight": 0.6},
            {"name": "rationale_grounded", "kind": "judge", "weight": 0.4},
        ],
        "gate_rule": "disposition_exact_match >= 0.80 AND rationale_grounded >= 0.70",
        "min_cases": 20,
    }
    r = d.req("POST", f"{EVAL_URL}/api/v1/suites", tok, headers=d.J(), json=body)
    if r.status_code not in (200, 201):
        warn(f"eval suite: {r.status_code} {r.text[:180]}")
        return None
    ok("eval suite created — 2 scorers, gate blocks promotion under 0.80 / 0.70")
    return suite_id


# ------------------------------------------------------- 4. GRID CHART + REPORT
def _dashboard_id(tok) -> str | None:
    r = d.req("GET", f"{CHART_URL}/api/v1/dashboards?workspace_id={d.WORKSPACE}", tok)
    if r.status_code != 200:
        return None
    rows = r.json().get("data") or []
    return str(rows[0].get("id")) if rows else None


def seed_grid_and_report(dataset_name: str | None) -> None:
    """A GRID chart (the analyst's table, not a time-series) and the scheduled
    report that mails the dashboard. Both are shipped capabilities that a fresh
    boot never surfaced, so the demo could only assert them."""
    say("grid chart + scheduled report")
    tok = _tok()
    dash = _dashboard_id(tok)
    if not dash:
        warn("no dashboard yet — skipping (the claims chart seed did not run)")
        return

    # -- grid --------------------------------------------------------------
    have = d.req("GET", f"{CHART_URL}/api/v1/charts?workspace_id={d.WORKSPACE}", tok)
    names = {str(x.get("name")) for x in (have.json().get("data") or [])} \
        if have.status_code == 200 else set()
    grid_name = "Claims detail (grid)"
    if grid_name in names:
        ok("grid chart already present")
    else:
        r = d.req("POST", f"{CHART_URL}/api/v1/charts", tok, headers=d.J(), json={
            "workspace_id": d.WORKSPACE, "dashboard_id": dash,
            "name": grid_name, "chart_type": "grid_chart",
            "config": {"page_size": 25},
        })
        if r.status_code in (200, 201):
            ok("grid chart added to the Insights dashboard")
        else:
            warn(f"grid chart: {r.status_code} {r.text[:160]}")

    # -- scheduled report ---------------------------------------------------
    gr = d.req("GET", f"{NOTIFICATION_URL}/api/v1/reports?workspace_id={d.WORKSPACE}", tok)
    rnames = {str(x.get("name")) for x in (gr.json().get("data") or [])} \
        if gr.status_code == 200 else set()
    rep_name = "Weekly claims digest"
    if rep_name in rnames:
        ok("scheduled report already present")
        return
    r = d.req("POST", f"{NOTIFICATION_URL}/api/v1/reports", tok, headers=d.J(), json={
        "dashboard_id": dash, "workspace_id": d.WORKSPACE, "name": rep_name,
        "recipients": ["manager@demo.datacern"], "cadence": "weekly",
        "send_hour": 8, "send_weekday": 1, "timezone": "UTC",
        "format": "html", "enabled": True,
    })
    if r.status_code in (200, 201):
        ok("weekly digest scheduled to manager@demo.datacern (Mondays 08:00 UTC)")
    else:
        warn(f"report: {r.status_code} {r.text[:160]}")


# -------------------------------------------------------------------- 5. JESSIE
def seed_jessie() -> str | None:
    """Jessie — a TENANT-CUSTOM agent, authored as governed configuration.

    Why a custom agent and not the built-in case-triage agent: the demo's whole
    claim is that a customer can field their own named AI colleague without
    writing code. A platform agent shows the capability; a tenant-authored one
    shows the CUSTOMER's capability. Jessie is forced onto the shared graph, her
    allow-list becomes the runtime toolset, and her tier is capped at
    write-proposal — so she can propose a disposition and never commit one.
    That cap is the demo: the human approval leg is not a setting Jessie can
    turn off.
    """
    say("Jessie — a tenant-authored AI caseworker (proposals only, never commits)")
    tok = _tok()
    g = d.req("GET", f"{c.AGENT_RUNTIME}/api/v1/tenants/self/agents", tok)
    if g.status_code == 200:
        for a in (g.json().get("data") or []):
            if str(a.get("display_name") or "").lower() == "jessie":
                ok(f"Jessie already present ({a.get('agent_key')})")
                return str(a.get("agent_key"))
    body = {
        "display_name": "Jessie",
        "description": "Claims caseworker. Reads the case, its evidence and the "
                       "domain ontology, then PROPOSES a disposition with a "
                       "grounded rationale for a human to approve or reject.",
        "persona": "Case Analyst",
        "allowed_tools": ["case.read", "case.evidence.read", "memory.retrieve",
                          "case.propose_disposition"],
        "propose_tool": "case.propose_disposition",
        "max_tier": "write-proposal",
    }
    r = d.req("POST", f"{c.AGENT_RUNTIME}/api/v1/tenants/self/agents", tok,
              headers=d.J(), json=body)
    if r.status_code not in (200, 201):
        warn(f"Jessie: {r.status_code} {r.text[:200]}")
        return None
    key = str((r.json().get("data") or {}).get("agent_key") or "")
    ok(f"Jessie published ({key or 'custom agent'}) — capped at write-proposal, "
       f"so every disposition still needs a named human")
    return key or None


def main() -> int:
    print(f"{B}Datacern capability tour — the links a fresh boot was not showing{N}")
    dataset_name = d.EVID.get("ingest_dataset_name") or os.environ.get("DEMO_DATASET_NAME")
    dataset_urn = _resolve_dataset_urn(_tok(), dataset_name)
    if not dataset_urn:
        warn(f"could not resolve a dataset urn for {dataset_name!r} — "
             f"dataset-bound stages will skip and say so")

    stages = [
        ("ontology", lambda: seed_ontology()),
        ("pipeline", lambda: seed_pipeline_template(dataset_urn)),
        ("evaluation", lambda: seed_eval_suite()),
        ("grid + report", lambda: seed_grid_and_report(dataset_name)),
        ("Jessie", lambda: seed_jessie()),
    ]
    failed = []
    for label, fn in stages:
        try:
            fn()
        except Exception as e:  # noqa: BLE001 — one flourish must not fail the boot
            warn(f"{label} stage error: {e}")
            failed.append(label)

    print(f"\n{G}capability tour seed complete{N}")
    if failed:
        print(f"  {Y}stages that did not complete{N}: {', '.join(failed)}")
        print("  (the platform is still usable — these are additive demo objects)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
