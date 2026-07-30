#!/usr/bin/env python3
"""Does the Learn flywheel hold, live? Labels → training → four-eyes promotion
→ scoring → cases, asserted on STATE.

The marketing claim this gates (gtm narrative, Learn verb): "every signed
decision becomes a training label; models retrain in governed pipelines,
promote under four-eyes, and pre-score the next batch — high scores open
their own cases." Each leg is asserted on state — Postgres rows, MLflow
registry stages, output parquet bytes — never on acknowledgements.

The arc:
  1. GOVERN    fresh tenant; two humans with identical Admin grants (what
               separates them below is only who signs what)
  2. LABEL     24 REAL governed resolutions (create → assign → start →
               resolve) emit case.disposition_applied; pipeline-orchestrator
               assembles them + the feature snapshot into labeled_examples
  3. TRAIN     a real random_forest pipeline run over the labeled dataset →
               succeeded, with a real MLflow run
  4. PROMOTE   register the mirrored run as a model version; the requester's
               self-approval is REJECTED (403 SELF_APPROVAL); a DIFFERENT
               human approves staging → production
  5. REGISTRY  the MLflow model registry version reads Production — pushed by
               experiment-service's own stage sync, NO harness bridging
  6. SCORE     a batch job over 10 NEW rows with auto_case
               (positive_label=true_positive) — the score→case bridge this
               slice completed (the consumer existed; no producer ever
               emitted inference.completed before)
  7. CASES     exactly the rows the model scored true_positive exist as cases
               created by agent/inference in the workspace — no more, no less

Needs a running stack (`make up`). Usage:
    deploy/e2e/.venv/bin/python deploy/e2e/test_learn_journey.py
Exit 0 = the flywheel held. Non-zero = it did not.
"""
from __future__ import annotations

import csv
import io
import json
import subprocess
import sys
import time
import uuid
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "deploy" / "e2e" / "lib"))
import common as c  # noqa: E402
import requests  # noqa: E402

RUN = uuid.uuid4().hex[:8]
# Case assignment requires uuid subjects (assigned_to_id/assignee_id are
# parsed as uuids) — the FIRST full-stack run failed 0/24 because these were
# readable strings and every assign 4xx'd silently.
U_WORK, U_APPROVE = str(uuid.uuid4()), str(uuid.uuid4())
DATASET_URN_TMPL = "wr:{tenant}:dataset:dataset/learn-src-" + RUN
FEATURE_COLS = ["amount", "invoice_gap_days", "prior_claims"]
N_LABELS = 24

_fail: list[str] = []


def check(ok: bool, label: str, detail: str = "") -> bool:
    print(("  ok   " if ok else "  FAIL ") + label + (f"  -- {detail}" if detail and not ok else ""))
    if not ok:
        _fail.append(label)
    return ok


def bail(label: str, detail: str = "") -> int:
    check(False, label, detail)
    print(f"\nFAIL -- {len(_fail)} check(s): {', '.join(_fail)}\n")
    return 1


def api(method, url, token, body=None, headers=None, timeout=180):
    h = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
    if headers:
        h.update(headers)
    return requests.request(method, url, json=body, timeout=timeout, headers=h)


def psql(sql: str, db: str = "postgres") -> str:
    return subprocess.run(
        ["psql", "-h", "localhost", "-U", "datacern", "-d", db, "-tA", "-c", sql],
        env={"PGPASSWORD": "datacern_dev", "PATH": "/usr/bin:/bin:/usr/local/bin"},
        capture_output=True, text=True, check=True,
    ).stdout.strip()


def s3client():
    import boto3
    from botocore.client import Config

    return boto3.client("s3", endpoint_url=c.S3_ENDPOINT, aws_access_key_id=c.S3_KEY,
                        aws_secret_access_key=c.S3_SECRET, region_name="us-east-1",
                        config=Config(signature_version="s3v4"))


def feature_row(i: int) -> dict:
    """Cleanly separable fraud/legit profiles so the classifier's behavior is
    deterministic in practice: fraud = high amount, tight resubmission gap,
    prior history."""
    if i % 2 == 0:  # fraud-profile
        return {"amount": 8000 + i * 10, "invoice_gap_days": 1, "prior_claims": 4}
    return {"amount": 100 + i, "invoice_gap_days": 45, "prior_claims": 0}


def main() -> int:  # noqa: PLR0911, PLR0912, PLR0915
    print(f"\nLearn-loop journey (run {RUN}) -- labels → model → four-eyes → scores → cases\n")
    su = c.superadmin_token()

    # ---- 1. GOVERN: fresh tenant, two humans, same grants -------------------
    r = api("POST", f"{c.IDENTITY}/api/v1/tenants", su,
            {"name": f"journey-learn-{RUN}", "display_name": "Learn Journey Co",
             "owner_email": f"owner-{RUN}@journey.test", "tier": "pool", "cloud": "aws"})
    if r.status_code not in (200, 201, 202):
        return bail("tenant provisioned", f"{r.status_code} {r.text[:160]}")
    tenant = (r.json().get("tenant") or r.json()).get("id") or r.json().get("id")
    check(bool(tenant), "tenant provisioned")
    dataset_urn = DATASET_URN_TMPL.format(tenant=tenant)

    r = api("POST", f"{c.RBAC}/api/v1/admin/tenants/{tenant}/seed", su, {})
    check(r.status_code == 200, "rbac tenant seed", r.text[:120])

    # The seeder's own bootstrap recipe (same as the streams journey): durable
    # Admin + Use-case-Admin membership rows, then a projection rebuild.
    for sub in (U_WORK, U_APPROVE):
        for gname in ("Admin", "Use case Admin"):
            psql(
                f"SELECT set_config('app.tenant_id', '{tenant}', false); "
                "INSERT INTO members (id, tenant_id, group_id, user_id) "
                f"SELECT gen_random_uuid(), '{tenant}', id, '{sub}' FROM groups "
                f"WHERE tenant_id = '{tenant}' AND group_type = 'permission' "
                f"AND lower(name) = lower('{gname}') "
                "ON CONFLICT (group_id, user_id) DO NOTHING", db="rbac")
    r = api("POST", f"{c.RBAC}/api/v1/admin/projection/rebuild?tenant={tenant}", su, {})
    check(r.status_code in (200, 202), "rbac projection rebuild enqueued", r.text[:120])

    ws = psql("SELECT id FROM workspaces WHERE tenant_id = "
              f"'{tenant}' ORDER BY created_at LIMIT 1", db="rbac")
    if not check(bool(ws), "default workspace resolved"):
        return bail("workspace")

    def tok(sub: str) -> str:
        return c.user_token(sub, tenant, ["*"], workspace_id=ws)

    tok_w, tok_a = tok(U_WORK), tok(U_APPROVE)

    warm = False
    for _ in range(45):
        pr = api("GET", f"{c.CASE}/api/v1/dispositions", tok_w)
        if pr.status_code == 200:
            warm = True
            break
        time.sleep(2)
    if not check(warm, "rbac perm:* projection materialized (case surface opens)"):
        return bail("authz warm-up")

    # ---- 2. LABEL: features first, then 24 governed resolutions -------------
    # Feature snapshot BEFORE the first disposition event: the pipeline feature
    # source resolves (dataset_urn,row_pk) → features from this CSV.
    s3 = s3client()
    try:
        s3.head_bucket(Bucket="datacern-pipelines")
    except Exception:  # noqa: BLE001
        s3.create_bucket(Bucket="datacern-pipelines")
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["row_pk", *FEATURE_COLS])
    for i in range(1, N_LABELS + 1):
        fr = feature_row(i)
        w.writerow([f"CLM-{i}", *[fr[cn] for cn in FEATURE_COLS]])
    import re as _re
    slug = _re.sub(r"[^A-Za-z0-9]+", "_", dataset_urn).strip("_")
    s3.put_object(Bucket="datacern-pipelines", Key=f"features/{slug}.csv",
                  Body=buf.getvalue().encode(), ContentType="text/csv")
    check(True, "feature snapshot materialized before the first label event")

    disp = {}
    for code, cat in (("fraud_confirmed", "true_positive"), ("approved", "false_positive")):
        r = api("POST", f"{c.CASE}/api/v1/dispositions", tok_w,
                {"code": code, "label": code, "category": cat, "requires_note": False})
        if r.status_code not in (200, 201):
            return bail(f"disposition {code}", f"{r.status_code} {r.text[:160]}")
        disp[cat] = r.json()["data"]["id"]
    check(True, "disposition vocabulary created (true_positive / false_positive)")

    due = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() + 7 * 86400))
    applied = 0
    first_err = ""  # the FIRST failing response, verbatim — a silent loop
    # here cost a full CI roundtrip to diagnose ("0/24" with no reason).
    for i in range(1, N_LABELS + 1):
        fraud = (i % 2 == 0)
        fr = feature_row(i)
        steps = [("create", api("POST", f"{c.CASE}/api/v1/cases", tok_w,
                                {"dataset_urn": dataset_urn, "due_date": due,
                                 "severity": "high" if fraud else "low",
                                 "rows": [{"row_pk": f"CLM-{i}", "display_projection": {
                                     "amount": str(fr["amount"]), "claim": f"CLM-{i}"}}]}))]
        cr = steps[0][1]
        created = ((cr.json().get("data") or {}).get("created") or []) \
            if cr.status_code in (200, 201) else []
        if created:
            cid = created[0]["id"]
            steps.append(("assign", api("POST", f"{c.CASE}/api/v1/cases/{cid}/assign",
                                        tok_w, {"assignee_id": U_WORK})))
            steps.append(("start", api("POST", f"{c.CASE}/api/v1/cases/{cid}/start", tok_w, {})))
            rr = api("POST", f"{c.CASE}/api/v1/cases/{cid}/resolve", tok_w,
                     {"disposition_id": disp["true_positive" if fraud else "false_positive"],
                      "resolution_note": f"triage decision CLM-{i}"})
            steps.append(("resolve", rr))
            if rr.status_code in (200, 201):
                applied += 1
        if not first_err:
            for name, resp in steps:
                if resp.status_code not in (200, 201):
                    first_err = f"{name} -> {resp.status_code} {resp.text[:220]}"
                    break
    if not check(applied >= 20, f"drove {applied}/24 REAL governed resolutions (need ≥20)",
                 first_err or "all steps returned 2xx"):
        return bail("resolutions", first_err)

    n = 0
    for _ in range(45):
        n = int(psql("SELECT count(*) FROM labeled_examples WHERE dataset_urn = "
                     f"'{dataset_urn}'", db="pipeline") or 0)
        if n >= 20:
            break
        time.sleep(2)
    if not check(n >= 20, f"pipeline assembled the labels into labeled_examples ({n})"):
        return bail("labeled examples")
    by_label = psql("SELECT label, count(*) FROM labeled_examples WHERE dataset_urn = "
                    f"'{dataset_urn}' GROUP BY label", db="pipeline")
    check("true_positive" in by_label and "false_positive" in by_label,
          "both decision categories present as labels", by_label)

    # ---- 3. TRAIN ------------------------------------------------------------
    r = api("POST", f"{c.EXPERIMENT}/api/v1/experiments", tok_w,
            {"workspace_id": ws, "name": f"learn-{RUN}", "model_type": "classification",
             "model_pipeline_urn": f"wr:{tenant}:pipeline:pipeline/m-{RUN}",
             "feature_engineering_pipeline_urn": f"wr:{tenant}:pipeline:pipeline/f-{RUN}",
             "training_pipeline_urn": f"wr:{tenant}:pipeline:pipeline/t-{RUN}"})
    if r.status_code not in (200, 201):
        return bail("experiment created", f"{r.status_code} {r.text[:200]}")
    exp = r.json().get("data", r.json())
    experiment_id, mlflow_exp_id = exp.get("id"), exp.get("mlflow_experiment_id")
    check(bool(experiment_id and mlflow_exp_id),
          "experiment + its REAL MLflow experiment created")

    r = api("POST", f"{c.PIPELINE}/api/v1/algorithm-templates/random_forest/pipelines",
            tok_w, {"workspace_id": ws, "name": f"learn-train-{RUN}", "mode": "train",
                    "dataset_refs": {"TRAIN": dataset_urn},
                    "parameters": {"n_estimators": 60, "max_depth": 5}})
    if r.status_code not in (200, 201):
        return bail("training template", f"{r.status_code} {r.text[:200]}")
    template_id = (r.json().get("data") or {}).get("id")

    r = api("POST", f"{c.PIPELINE}/api/v1/pipelines/{template_id}/run", tok_w,
            {"run_parameters": {"labeled_dataset_urn": dataset_urn, "label_column": "label",
                                "algorithm": "random_forest",
                                "mlflow_experiment_id": mlflow_exp_id}})
    if r.status_code not in (200, 201, 202):
        return bail("training run submitted", f"{r.status_code} {r.text[:200]}")
    run_id = (r.json().get("data") or r.json()).get("id")

    final = None
    for _ in range(90):
        g = api("GET", f"{c.PIPELINE}/api/v1/runs/{run_id}", tok_w)
        if g.status_code == 200:
            gd = g.json().get("data", {})
            if gd.get("status") in ("succeeded", "failed", "cancelled"):
                final = gd
                break
        time.sleep(2)
    if not check(bool(final) and final.get("status") == "succeeded",
                 "REAL training run succeeded",
                 json.dumps(final)[:200] if final else "timeout"):
        return bail("training")
    mlflow_run_id = final.get("mlflow_run_id")

    # ---- 4. PROMOTE: register + four-eyes ------------------------------------
    repaired = False
    for _ in range(30):
        rr = requests.post(f"{c.EXPERIMENT}/internal/reconcile",
                           headers={"x-client-spiffe-id":
                                    "spiffe://datacern/ns/platform/sa/operator",
                                    "Content-Type": "application/json"},
                           json={"tenant_id": tenant}, timeout=60)
        if rr.status_code == 200 and (rr.json().get("data") or {}).get("repaired_count", 0) >= 1:
            repaired = True
            break
        time.sleep(2)
    check(repaired, "experiment-service mirrored the run from REAL MLflow")

    exp_run_id = None
    for _ in range(20):
        g = api("GET", f"{c.EXPERIMENT}/api/v1/experiments/{experiment_id}/runs", tok_w)
        if g.status_code == 200:
            for run in g.json().get("data", []):
                if run.get("mlflow_run_id") == mlflow_run_id:
                    exp_run_id = run.get("id")
                    break
        if exp_run_id:
            break
        time.sleep(2)
    if not check(bool(exp_run_id), "training run mirrored (registrable)"):
        return bail("mirror")

    reg_name = f"learn-model-{RUN}"
    r = api("POST",
            f"{c.EXPERIMENT}/api/v1/experiments/{experiment_id}/runs/{exp_run_id}/register",
            tok_w, {"model_name": reg_name, "flavor": "mlflow.sklearn"})
    if r.status_code not in (200, 201):
        return bail("model version registered", f"{r.status_code} {r.text[:200]}")
    d = r.json().get("data", r.json())
    model_id, version = d.get("model_id"), d.get("version")
    check(bool(model_id), f"model version {version} registered (system of record)")

    def promote(stage: str, assert_self_rejected: bool) -> bool:
        pr = api("POST",
                 f"{c.EXPERIMENT}/api/v1/models/{model_id}/versions/{version}/promote",
                 tok_w, {"target_stage": stage, "rationale": f"journey → {stage}"})
        if pr.status_code != 202:
            check(False, f"promotion to {stage} requested", f"{pr.status_code} {pr.text[:160]}")
            return False
        pid = (pr.json().get("data") or {}).get("promotion_id")
        if assert_self_rejected:
            sd = api("POST", f"{c.EXPERIMENT}/api/v1/promotions/{pid}/decision", tok_w,
                     {"decision": "approve"})
            check(sd.status_code == 403 and "SELF_APPROVAL" in sd.text.upper(),
                  "four-eyes REJECTED the requester approving their own promotion",
                  f"{sd.status_code} {sd.text[:120]}")
        dec = api("POST", f"{c.EXPERIMENT}/api/v1/promotions/{pid}/decision", tok_a,
                  {"decision": "approve"})
        return dec.status_code == 200

    if not (promote("staging", True) and promote("production", False)):
        return bail("four-eyes promotion to production")
    check(True, "a DIFFERENT human approved staging → production")

    # ---- 5. REGISTRY: the approved stage reached MLflow, no harness bridge ---
    mv: dict = {}
    stages: list = []
    for _ in range(20):
        g = requests.get(f"{c.MLFLOW}/api/2.0/mlflow/model-versions/search",
                         params={"filter": f"name='{reg_name}'"}, timeout=30)
        vs = (g.json().get("model_versions") or []) if g.status_code == 200 else []
        stages = [v.get("current_stage") for v in vs]
        prod = [v for v in vs if v.get("current_stage") == "Production"]
        if prod:
            mv = prod[0]
            break
        time.sleep(2)
    if not check(mv.get("current_stage") == "Production",
                 "MLflow registry shows Production — pushed by experiment-service's "
                 "own stage sync (no harness bridging)", f"stages={stages}"):
        return bail("registry stage")
    mlflow_version = mv.get("version")

    # ---- 6. SCORE with auto_case ---------------------------------------------
    import pandas as pd
    import pyarrow as pa
    import pyarrow.parquet as pq

    rows = []
    for j in range(1, 11):
        fr = feature_row(100 + j)  # 102/104/106/108/110 carry the fraud profile
        rows.append({"claim_id": f"CLM-{100 + j}", **fr})
    df = pd.DataFrame(rows)
    for cn in FEATURE_COLS:
        df[cn] = df[cn].astype("int64")
    try:
        s3.head_bucket(Bucket="datacern-datasets")
    except Exception:  # noqa: BLE001
        s3.create_bucket(Bucket="datacern-datasets")
    key = f"inputs/learn-{RUN}.parquet"
    b = io.BytesIO()
    pq.write_table(pa.Table.from_pandas(df, preserve_index=False), b)
    s3.put_object(Bucket="datacern-datasets", Key=key, Body=b.getvalue(),
                  ContentType="application/octet-stream")
    input_urn = f"wr:{tenant}:dataset:dataset/learn-in-{RUN}"
    schema = {"claim_id": {"type": "string", "nullable": False},
              **{cn: {"type": "long", "nullable": False} for cn in FEATURE_COLS}}
    psql("INSERT INTO input_datasets (id, tenant_id, urn, dataset_id, version_no, schema, "
         "storage_uri, row_count, created_at) VALUES "
         f"('{uuid.uuid4()}', '{tenant}', '{input_urn}', '{input_urn.split('/')[-1]}', 1, "
         f"'{json.dumps(schema)}'::jsonb, 's3://datacern-datasets/{key}', {len(rows)}, now())",
         db="inference")
    check(True, "NEW scoring input registered (10 unseen rows, 5 fraud-profile)")

    mv_urn = f"wr:{tenant}:experiment:model_version/{reg_name}@{mlflow_version}"
    sub = api("POST", f"{c.INFERENCE}/api/v1/inferences", tok_w,
              {"model_version_urn": mv_urn, "input_dataset_urn": input_urn,
               "output": {"dataset_name": f"learn-scores-{RUN}"},
               "parameters": {"auto_case": {
                   "positive_label": "true_positive", "row_pk_field": "claim_id",
                   "projection_fields": ["claim_id", "amount"]}}})
    if sub.status_code != 202:
        return bail("scoring job submitted (auto_case)", f"{sub.status_code} {sub.text[:250]}")
    job_id = (sub.json().get("data") or {}).get("job_id")

    jfinal = None
    for _ in range(90):
        g = api("GET", f"{c.INFERENCE}/api/v1/inferences/{job_id}", tok_w)
        if g.status_code == 200:
            jd = g.json().get("data", {})
            if jd.get("status") in ("succeeded", "failed", "cancelled", "rejected"):
                jfinal = jd
                break
        time.sleep(2)
    if not check(bool(jfinal) and jfinal.get("status") == "succeeded",
                 "batch scoring succeeded with the PROMOTED model",
                 json.dumps(jfinal)[:200] if jfinal else "timeout"):
        return bail("scoring")

    # ground truth: what did the model actually predict? (output parquet bytes)
    listing = s3.list_objects_v2(Bucket="datacern-datasets", Prefix=f"scores/{tenant}/{job_id}/")
    frames = []
    for o in listing.get("Contents", []):
        if o["Key"].endswith(".parquet"):
            body = s3.get_object(Bucket="datacern-datasets", Key=o["Key"])["Body"].read()
            frames.append(pq.read_table(io.BytesIO(body)).to_pandas())
    pdf = pd.concat(frames, ignore_index=True)
    predicted_fraud = sorted(pdf.loc[pdf["prediction"].astype(str) == "true_positive",
                                     "claim_id"].astype(str))
    check(len(pdf) == 10 and len(predicted_fraud) >= 1,
          f"REAL predictions in the output parquet ({len(predicted_fraud)}/10 true_positive)")

    # ---- 7. CASES: exactly the flagged rows, opened by agent/inference -------
    case_pks: list[str] = []
    for _ in range(36):
        out = psql("SELECT row_pk FROM cases WHERE tenant_id = "
                   f"'{tenant}' AND workspace_id = '{ws}' AND created_by_id = 'agent/inference' "
                   "AND deleted_at IS NULL ORDER BY row_pk", db="case_svc")
        case_pks = [x for x in out.splitlines() if x]
        if len(case_pks) >= len(predicted_fraud):
            break
        time.sleep(5)
    check(case_pks == predicted_fraud,
          "cases exist for EXACTLY the model-flagged rows (no more, no less)",
          f"cases={case_pks} predicted={predicted_fraud}")

    print("\n" + ("PASS -- the Learn flywheel held end to end\n" if not _fail
                  else f"FAIL -- {len(_fail)} check(s): {', '.join(_fail)}\n"))
    return 0 if not _fail else 1


if __name__ == "__main__":
    sys.exit(main())
