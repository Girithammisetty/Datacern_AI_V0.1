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
import seed_platform as sp  # noqa: E402

B, G, Y, N = "\033[1m", "\033[32m", "\033[33m", "\033[0m"

SEMANTIC_URL = os.environ.get("SEMANTIC_URL", "http://localhost:8086")
CHART_URL = os.environ.get("CHART_URL", "http://localhost:8320")
QUERY_URL = os.environ.get("QUERY_URL", "http://localhost:8085")
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


def _resolve_dataset(tok) -> tuple[str | None, str | None]:
    """Find the claims dataset the seed really ingested. Returns (urn, name).

    NOT via driver.EVID. EVID is in-PROCESS state, and this tour runs as its own
    process from up.sh, so EVID is empty here — the first version read
    `EVID["ingest_dataset_name"]`, got None, and skipped every dataset-bound
    stage while reporting a clean run. Asking dataset-service is the only source
    of truth that survives a process boundary.

    driver names the ingested dataset `auto-claims-<epoch>` (driver.py:235), so
    prefer that prefix and take the newest; fall back to the newest dataset in
    the workspace so a differently-named vertical still gets a tour.
    """
    r = d.req("GET", f"{c.DATASET}/api/v1/datasets?workspace_id={d.WORKSPACE}", tok)
    if r.status_code != 200:
        return None, None
    rows = [x for x in (r.json().get("data") or []) if x.get("id") and x.get("name")]
    if not rows:
        return None, None
    claims = [x for x in rows if str(x["name"]).startswith("auto-claims-")]
    pick = sorted(claims or rows, key=lambda x: str(x.get("created_at") or x["name"]))[-1]
    return f"wr:{TENANT}:dataset:dataset/{pick['id']}", str(pick["name"])


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
        # Node keys are alias/component/parameters — NOT id/type/config, which is
        # what I had invented and what three rounds of "draft" were really telling
        # me. Component names come from the catalog (domain/catalog.py), not from
        # what a pipeline node plausibly ought to be called.
        "definition": {
            "nodes": [
                # A training pipeline MUST contain read-from-warehouse (dag.py
                # _validate_terminals/MISSING_READ). `dataset` is a dataset_ref:
                # it has to be a real wr:{tenant}:dataset:dataset/{id} URN.
                {"alias": "claims", "component": "read-from-warehouse",
                 "parameters": {"dataset": dataset_urn}},
                {"alias": "fill gaps", "component": "handle-missing-values",
                 "parameters": {"strategy": "median"}},
                # No `columns` on the scalers: omitting it means "all numeric",
                # and naming columns here would hard-code this tour to one
                # dataset's schema.
                {"alias": "normalize", "component": "zscore-normalization",
                 "parameters": {}},
                # model-input is what gives the training feed its role. Anomaly
                # detection is unsupervised, so TRAIN is the only role it takes.
                {"alias": "train feed", "component": "model-input",
                 "parameters": {"role": "TRAIN"}},
                {"alias": "detect anomalies", "component": "isolation_forest-train",
                 "parameters": {"n_estimators": 200, "contamination": 0.08}},
            ],
            # `from` is alias.port, `to` is a bare alias. read-from-warehouse and
            # every data-prep node expose a single "out" port of type dataframe;
            # isolation_forest-train emits `model` and is the terminal.
            "edges": [
                {"from": "claims.out", "to": "fill gaps"},
                {"from": "fill gaps.out", "to": "normalize"},
                {"from": "normalize.out", "to": "train feed"},
                {"from": "train feed.out", "to": "detect anomalies"},
            ],
        },
        "run_parameters": {"test_size": 0.2, "random_state": 42},
    }
    # VALIDATE BEFORE CREATING. Two rounds were spent treating this as an
    # activation problem: create returns 201, activate returns 200, and the
    # version is STILL `draft` — because draft here means "the definition did not
    # validate", not "nobody pressed activate". The UI says so plainly ("active
    # version is a draft; fix validation first") and I read it as a state to
    # toggle rather than a verdict to satisfy.
    #
    # A template whose definition does not validate is worse than no template:
    # it sits in the shared workspace, the UI refuses to run it, and e2e:live's
    # pipeline spec picks it up and fails. So validate first and only create
    # when the platform agrees the definition is sound — and when it does not,
    # print the platform's own field errors instead of materializing anyway.
    v = d.req("POST", f"{c.PIPELINE}/api/v1/pipelines/validate?mode=all", tok,
              headers=d.J(), json={"definition": body["definition"],
                                   "pipeline_type": body["pipeline_type"],
                                   "model_type": body["model_type"]})
    if v.status_code != 200:
        warn(f"pipeline definition did not validate ({v.status_code}) — NOT creating it, "
             f"because an unrunnable template breaks the pipelines page for everyone")
        warn(f"     {v.text[:260]}")
        return None

    r = d.req("POST", f"{c.PIPELINE}/api/v1/pipelines", tok, headers=d.J(), json=body)
    if r.status_code not in (200, 201):
        warn(f"pipeline template: {r.status_code} {r.text[:180]}")
        return None
    data = r.json().get("data") or {}
    tid = str(data.get("id") or "")
    status = str(data.get("validation_status") or "")

    # The version id is NOT on the create response. template_payload carries
    # `active_version_id`, and on a fresh template that is null BY DEFINITION —
    # nothing is active yet, which is the exact condition we are here to fix.
    # Reading it gave an empty id, the activate branch never ran, and the stage
    # printed "version draft" with no warning because there was no failed call
    # to warn about. Ask for the versions instead.
    vid = ""
    gv = d.req("GET", f"{c.PIPELINE}/api/v1/pipelines/{tid}/versions", tok)
    if gv.status_code == 200:
        vers = gv.json().get("data") or []
        if vers:
            newest = sorted(vers, key=lambda v: v.get("version_no") or 0)[-1]
            vid = str(newest.get("id") or "")
            status = str(newest.get("validation_status") or status)
    if not vid:
        warn(f"could not resolve a version id for {tid[:8]}… "
             f"(GET versions {gv.status_code}) — it will stay a draft and refuse to run")

    # ACTIVATE the version. A created template's version is a DRAFT, and a draft
    # is not merely incomplete — the UI refuses to run it:
    #
    #   Run now -> "active version is a draft; fix validation first"
    #
    # Leaving one in the shared workspace broke e2e:live's pipeline schedule spec
    # on 27dfa59 (data-pipeline-journeys.spec.ts:341), because that spec picks a
    # row and clicks Run now. It is also a poor demo object on its own terms: a
    # pipeline you cannot run teaches nothing, which is this module's whole rule.
    if vid and status != "valid":
        a = d.req("POST", f"{c.PIPELINE}/api/v1/pipelines/{tid}/versions/{vid}/activate",
                  tok, headers=d.J(), json={})
        if a.status_code in (200, 201):
            status = str((a.json().get("data") or {}).get("validation_status") or status)
        else:
            warn(f"pipeline version not activated ({a.status_code} {a.text[:120]}) — "
                 f"the template will show as a draft and refuse to run")
    ok(f"training pipeline authored over the real claims dataset "
       f"({tid[:8]}…, version {status or 'unknown'})")
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
    if r.status_code == 403:
        # Not a seeding problem. This principal is a TENANT ADMIN — the same
        # token created the ontology types, the pipeline template, the report
        # subscription and Jessie, all of which are equally privileged writes.
        # eval-service alone refuses it, so its require() does not honour the
        # tenant-admin bypass every other service on this path honours.
        #
        # eval.suite.update was also missing from the rbac catalog entirely
        # until it was added alongside eval.canary.update; declaring it made it
        # grantable but did not change eval-service's own check. That is a
        # platform inconsistency to settle in eval-service, not something a demo
        # seeder should paper over by hunting for a token that happens to work.
        warn(f"eval suite: 403 {r.text[:150]}")
        warn("     ^ this token is tenant admin and every other stage accepted "
             "it — eval-service does not honour the admin bypass (platform bug, "
             "not a seeding gap)")
        return None
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


def _dataset_columns(tok, dataset_urn: str | None) -> list[tuple[str, str]]:
    """The dataset's REAL columns, as (name, type), newest version first.

    The detail grid and its saved query must both name columns that actually
    exist. The first version of this seeder hardcoded `claim_id, provider,
    amount, service_date, status` — a plausible-looking claims schema that the
    ingested dataset does not have (it carries vendor / claim_type /
    incident_date). The saved query was created fine, because query-service
    does not bind SQL until it runs; the failure only surfaced at render time
    as `duckdb prepare: Binder Error: Referenced column "provider" not found`,
    which chart-service reports to the UI as the far less obvious
    `saved query results status 409` (results are unavailable because the
    execution failed).

    So: ask the dataset what its columns are. Guessing a schema is how a seeder
    stays green while producing a dashboard that cannot render.
    """
    if not dataset_urn:
        return []
    ds_id = dataset_urn.rsplit("/", 1)[-1]
    r = d.req("GET", f"{c.DATASET}/api/v1/datasets/{ds_id}/versions", tok)
    if r.status_code != 200:
        warn(f"dataset versions {r.status_code} — cannot derive detail columns")
        return []
    rows = r.json().get("data") or []
    if not rows:
        return []
    newest = sorted(rows, key=lambda x: int(x.get("version_no") or 0))[-1]
    # schema is an OBJECT keyed by column name ({"amount": {"type": "double"}}),
    # not a list of field records. JSON object order is preserved by json.loads,
    # so this keeps the dataset's own column order.
    return [(n, str((f or {}).get("type") or "")) for n, f in (newest.get("schema") or {}).items()]


def _detail_sql(dataset_name: str, cols: list[tuple[str, str]]) -> str:
    """Row-level SELECT over the dataset's own columns, newest rows first."""
    names = ", ".join(n for n, _ in cols)
    sql = f"SELECT {names} FROM {{{{dataset('{dataset_name}')}}}}"
    # Order by a real date/timestamp column when the dataset has one; a detail
    # grid with no time column is still a valid detail grid, so this is optional
    # rather than a reason to skip the chart.
    order = next((n for n, t in cols if t in ("date", "timestamp", "timestamptz")), None)
    if order:
        sql += f" ORDER BY {order} DESC"
    return sql


def _ensure_detail_query(tok, dataset_urn: str | None,
                         dataset_name: str | None) -> tuple[str | None, list[str]]:
    """Idempotently create (or REPAIR) the saved query the DETAIL grid reads.

    Mirrors seed_claims_demo.py's network-query helper, which already records the
    rule this seeder missed: a chart with no measures for the compiler resolves
    only through source_type=saved_query.

    Repairs as well as creates, because an earlier run of this seeder wrote a
    query whose SQL named columns the dataset does not have. A create-only
    helper would find that query by name, return it, and leave the dashboard
    broken on every rerun.
    """
    if not dataset_name:
        return None, []
    cols = _dataset_columns(tok, dataset_urn)
    if not cols:
        return None, []
    names = [n for n, _ in cols]
    sql = _detail_sql(dataset_name, cols)
    name = "Claims: detail rows"
    r = d.req("GET", f"{QUERY_URL}/api/v1/queries?workspace_id={d.WORKSPACE}", tok)
    if r.status_code == 200:
        for q in r.json().get("data", []):
            if q.get("name") != name:
                continue
            qid = str(q.get("id"))
            if str(q.get("sql_text") or "") != sql:
                p = d.req("PATCH", f"{QUERY_URL}/api/v1/queries/{qid}", tok,
                          headers=d.J(), json={"sql_text": sql})
                if p.status_code == 200:
                    ok(f"{name!r} saved query SQL repaired to the dataset's real columns")
                else:
                    warn(f"detail saved query repair failed: {p.status_code} {p.text[:160]}")
                    return None, []
            return qid, names
    r = d.req("POST", f"{QUERY_URL}/api/v1/queries", tok, headers=d.J(), json={
        "name": name, "description": "Row-level claim detail — source for the detail grid",
        "module_names": ["insights"], "workspace_id": d.WORKSPACE,
        "sql_text": sql, "tags": ["claims", "demo"]})
    if r.status_code != 201:
        warn(f"detail saved query create failed: {r.status_code} {r.text[:160]}")
        return None, []
    qid = str(r.json()["data"]["id"])
    ok(f"{name!r} saved query created (id={qid})")
    return qid, names


def seed_grid_and_report(dataset_urn: str | None, dataset_name: str | None) -> None:
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
    existing = {str(x.get("name")): x for x in (have.json().get("data") or [])} \
        if have.status_code == 200 else {}
    grid_name = "Claims detail (grid)"
    if grid_name in existing:
        # Present, but possibly from the run that wrote invented column names.
        # Re-derive and PATCH when they differ, so a rerun repairs the dashboard
        # instead of reporting "already present" over a chart that 409s.
        query_id, cols = _ensure_detail_query(tok, dataset_urn, dataset_name)
        cur = existing[grid_name]
        cur_cols = list((cur.get("config") or {}).get("columns") or [])
        if query_id and cols and cur_cols != cols:
            p = d.req("PATCH", f"{CHART_URL}/api/v1/charts/{cur.get('id')}", tok,
                      headers=d.J(), json={
                          "config": {"columns": cols, "page_size": 25},
                          "sources": [{"position": 0, "source_type": "saved_query",
                                       "source_urn": f"wr:{TENANT}:query:saved_query/{query_id}"}],
                      })
            if p.status_code == 200:
                ok("grid chart columns repaired to the dataset's real columns")
            else:
                warn(f"grid chart repair: {p.status_code} {p.text[:160]}")
        else:
            ok("grid chart already present")
    else:
        # POST /dashboards/{id}/charts — a chart is created UNDER its dashboard
        # (server.go:141). POST /charts does not exist and answered a bare
        # "404 page not found", which reads like the service is down rather than
        # like the path is wrong.
        # A DETAIL grid is row-level, so it resolves through a saved query, not
        # through the semantic compiler. Without one this chart rendered "chart
        # has no measures to resolve" on every load, forever: chart-service
        # routes a chart with no saved_query source to compileAndRun, and a
        # columns-only config yields zero metrics for it to compile.
        #
        # (An AGGREGATE grid is different — it carries x + y like an axis chart
        # and compiles normally, which is what every pack dashboard and
        # seed_claims_demo.py's "Claims grid" do. This one is deliberately
        # row-level, so the saved query is the right source, not measures.)
        query_id, cols = _ensure_detail_query(tok, dataset_urn, dataset_name)
        if not query_id:
            warn("no saved query for the detail grid — skipping "
                 "(a columns-only grid with no saved_query source cannot render)")
            return

        r = d.req("POST", f"{CHART_URL}/api/v1/dashboards/{dash}/charts", tok,
                  headers=d.J(), json={
                      "workspace_id": d.WORKSPACE,
                      "name": grid_name, "chart_type": "grid_chart",
                      # `columns` is REQUIRED for the grid family
                      # (charttypes.go:132) — omitting it 422s with
                      # config.columns/REQUIRED. A grid without columns is not a
                      # grid, so this is the schema being right, not fussy.
                      "config": {"columns": cols, "page_size": 25},
                      "sources": [{"position": 0, "source_type": "saved_query",
                                   "source_urn": f"wr:{TENANT}:query:saved_query/{query_id}"}],
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
    # /api/v1/REGISTRY/tenants/self/agents — registry.py declares
    # APIRouter(prefix="/api/v1/registry"). The first version omitted the
    # registry segment and got a bare 404 {"detail":"Not Found"}, which reads
    # like "the feature does not exist" rather than "you typed the path wrong".
    base = f"{c.AGENT_RUNTIME}/api/v1/registry/tenants/self/agents"
    g = d.req("GET", base, tok)
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
    r = d.req("POST", base, tok, headers=d.J(), json=body)
    if r.status_code not in (200, 201):
        warn(f"Jessie: {r.status_code} {r.text[:200]}")
        return None
    key = str((r.json().get("data") or {}).get("agent_key") or "")
    ok(f"Jessie published ({key or 'custom agent'}) — capped at write-proposal, "
       f"so every disposition still needs a named human")
    return key or None


def main() -> int:
    print(f"{B}Datacern capability tour — the links a fresh boot was not showing{N}")

    # MUST run first. ensure_platform_seeded() re-points d.WORKSPACE at rbac's
    # REAL default workspace (seed_platform.py:291); until it does, driver holds
    # a FABRICATED workspace id. seed_claims_demo calls it, this did not, and the
    # whole first run therefore addressed a workspace nothing else uses:
    # dashboards and datasets came back empty, the eval suite 403'd on
    # workspace-scoped authz, and — worst — the ontology stage reported `ok` for
    # 4 entity types it had written somewhere no one would ever look. A green
    # line for work landing in the wrong place is worse than a failure.
    sp.ensure_platform_seeded()
    say(f"workspace {d.WORKSPACE} (rbac's real default)")

    dataset_urn, dataset_name = _resolve_dataset(_tok())
    if not dataset_urn:
        warn("no dataset in this workspace — dataset-bound stages will skip and say so")
    else:
        ok(f"resolved the ingested dataset: {dataset_name}")

    stages = [
        ("ontology", lambda: seed_ontology()),
        ("pipeline", lambda: seed_pipeline_template(dataset_urn)),
        ("evaluation", lambda: seed_eval_suite()),
        ("grid + report", lambda: seed_grid_and_report(dataset_urn, dataset_name)),
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
