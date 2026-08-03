"""Unit tests for the pack catalog + install planner (no live stack needed)."""

from __future__ import annotations

import types
from pathlib import Path

import pytest

from app.domain import catalog, installer

REPO_PACKS = Path(__file__).resolve().parents[4] / "packs"


@pytest.fixture(autouse=True)
def _configure_catalog():
    catalog.configure(str(REPO_PACKS))


def test_catalog_lists_real_packs():
    packs = catalog.list_packs()
    names = {p["name"] for p in packs}
    assert "card-disputes" in names
    assert len(packs) >= 10  # the repo ships 28 authored packs
    cd = next(p for p in packs if p["name"] == "card-disputes")
    assert cd["version"]  # semver present
    assert cd["components"].get("dispositions", 0) >= 1
    assert "agent_recipes" in cd["deferred_kinds"]  # honest deferral surfaced


def test_get_pack_detail_and_missing():
    detail = catalog.get_pack("card-disputes")
    assert detail is not None
    assert detail["deferred"]  # list of {kind, reason}
    assert all("reason" in d for d in detail["deferred"])
    assert catalog.get_pack("no-such-pack") is None


def test_lint_pack_reports_clean_for_a_shipped_pack():
    # inc19: the authoring linter over a real catalog pack — a shipped pack must
    # lint clean (no errors), and a missing pack returns None.
    report = catalog.lint_pack("card-disputes")
    assert report is not None
    assert report["ok"] is True and report["errors"] == 0
    assert report["pack"] == "card-disputes"
    assert catalog.lint_pack("no-such-pack") is None


def test_origin_tag_and_urn_id():
    of = installer.origin_tag("card-disputes", "1.0.0")
    assert of("dispositions", "dispositions") == "pack:card-disputes@1.0.0:dispositions/dispositions"  # noqa: E501
    assert installer._urn_id("wr:t:query:query/abc-123") == "abc-123"
    assert installer._urn_id(None) is None


def test_inc1_kinds_and_reversibility_contract():
    # inc1 materializes self-contained kinds (no dataset/four-eyes chain).
    # inc3 adds case_fields (case-service custom-field catalog) here.
    assert set(installer.INC1_KINDS) == {"dispositions", "case_fields", "case_schemas",
                                         "display_labels", "guardrails", "agent_configs",
                                         "eval_sets", "model_archetypes", "ontology",
                                         "write_adapters", "connection_templates",
                                         "roles", "decision_models"}
    assert "model_archetypes" in installer.REVERSIBLE_KINDS  # DELETE /archetypes/{key}
    assert "case_schemas" in installer.REVERSIBLE_KINDS  # DELETE /case-schemas/{key}
    assert "ontology" in installer.REVERSIBLE_KINDS  # DELETE /ontology/entities/{key}
    assert "write_adapters" in installer.REVERSIBLE_KINDS  # DELETE /connections/{id}
    assert "connection_templates" in installer.REVERSIBLE_KINDS  # DELETE /connections/{id}
    assert "saved_queries" not in installer.INC1_KINDS  # needs its datasets first
    # Roles/case_fields carry a real Core delete verb → reversible; dispositions/
    # decision tables do not (tombstoned honestly on uninstall).
    assert "roles" in installer.REVERSIBLE_KINDS
    assert "case_fields" in installer.REVERSIBLE_KINDS  # DELETE /case-fields/{id}
    assert "display_labels" in installer.REVERSIBLE_KINDS  # DELETE /tenants/self/labels/{key}
    assert "guardrails" in installer.REVERSIBLE_KINDS  # PUT empty envelope clears it
    assert "agent_configs" in installer.REVERSIBLE_KINDS  # PUT empty prompt_params clears it
    assert "dispositions" not in installer.REVERSIBLE_KINDS
    assert "decision_models" not in installer.REVERSIBLE_KINDS


def test_guardrail_envelope_binds_workspace_and_clamps_shape():
    ws = "019f62c1-0f5e-7af0-b9be-cbe343ea0ad4"
    env = installer._guardrail_envelope(
        {"budget": {"max_tokens_per_session": 60000},
         "pii": {"block_pii_egress": True, "redact": True},
         "bind_workspace": True}, ws)
    assert env["budget"]["max_tokens_per_session"] == 60000
    assert env["pii"]["block_pii_egress"] is True
    assert env["data_scope"]["workspaces"] == [ws]  # install workspace injected
    # no bind_workspace, no data_scope key at all
    env2 = installer._guardrail_envelope({"pii": {"redact": True}}, ws)
    assert "data_scope" not in env2 and env2["pii"]["redact"] is True


def test_plan_marks_inc1_kinds_create_and_others_deferred():
    manifest = catalog.load_manifest("card-disputes")

    class _Resp:
        status_code = 200

        @staticmethod
        def json():
            return {"data": []}  # nothing exists yet → everything is a create

    class _FakeClient:
        workspace_id = "ws-1"
        endpoints = types.SimpleNamespace(
            case="c", rbac="r", query="q", agent="a", semantic="s",
            chart="ch", dataset="d", ingestion="i", memory="m", pipeline="p", identity="id")

        @staticmethod
        def author_token():
            return "tok"

        @staticmethod
        def _req(method, url, tok):
            return _Resp()

    ops = installer.plan(_FakeClient(), manifest)
    kinds = {o["kind"]: o["action"] for o in ops}
    # inc1 kinds present in card-disputes are planned as create
    assert kinds.get("dispositions") == "create"
    assert kinds.get("decision_models") == "create"
    # inc20 (no-dummy-data rule): card-disputes v2 ships NO seed data — its
    # file-less dataset contracts, with nothing bound and no same-name tenant
    # dataset, plan as an honest requires_binding (the apply would fail).
    assert kinds.get("datasets") == "requires_binding"
    assert kinds.get("semantic_models") == "create"
    # dashboards wait for the steward to approve the semantic model (phase 2)
    assert any(o["kind"] == "dashboards" and o["action"] == "after_approval" for o in ops)

    # An explicit binding flips the same entries to `bind`.
    bound = installer.plan(_FakeClient(), manifest, {
        "cd_cardholders": "wr:t:dataset:dataset/111",
        "cd_transactions": "wr:t:dataset:dataset/222",
        "cd_disputes": "wr:t:dataset:dataset/333"})
    assert {o["action"] for o in bound if o["kind"] == "datasets"} == {"bind"}


def test_plan_reuses_same_name_tenant_dataset_for_fileless_contract():
    # inc20: with no explicit binding, a file-less dataset contract whose
    # declared name matches an EXISTING tenant dataset plans as `reuse`.
    manifest = catalog.load_manifest("card-disputes")

    class _Resp:
        status_code = 200

        @staticmethod
        def json():
            return {"data": [{"id": "d1", "name": "cd-disputes"},
                             {"id": "d2", "name": "cd-transactions"},
                             {"id": "d3", "name": "cd-cardholders"}]}

    class _FakeClient:
        workspace_id = "ws-1"
        endpoints = types.SimpleNamespace(
            case="c", rbac="r", query="q", agent="a", semantic="s",
            chart="ch", dataset="d", ingestion="i", memory="m", pipeline="p", identity="id")

        @staticmethod
        def author_token():
            return "tok"

        @staticmethod
        def _req(method, url, tok):
            return _Resp()

    ops = installer.plan(_FakeClient(), manifest)
    ds = [o for o in ops if o["kind"] == "datasets"]
    assert ds and all(o["action"] == "reuse" for o in ds)


def test_rewrite_dataset_macros_binds_pack_names_to_real_names():
    sql = "SELECT count(*) FROM {{dataset('cd-disputes')}} d " \
          "JOIN {{dataset('cd-transactions')}} t ON d.txn_id = t.txn_id"
    out = installer._rewrite_dataset_macros(
        sql, {"cd-disputes": "issuer-disputes-2026", "cd-transactions": "issuer-txns"})
    assert "{{dataset('issuer-disputes-2026')}}" in out
    assert "{{dataset('issuer-txns')}}" in out
    assert "cd-disputes" not in out
    # no bindings → untouched
    assert installer._rewrite_dataset_macros(sql, {}) == sql


def test_plan_materializes_case_fields(tmp_path):
    # ap-invoice-audit ships a case_fields component (inc3) — it must plan as a
    # real create (case-service custom-field catalog), never `deferred`/faked.
    manifest = catalog.load_manifest("ap-invoice-audit")

    class _Resp:
        status_code = 200

        @staticmethod
        def json():
            return {"data": []}

    class _FakeClient:
        workspace_id = "ws-1"
        endpoints = types.SimpleNamespace(
            case="c", rbac="r", query="q", agent="a", semantic="s",
            chart="ch", dataset="d", ingestion="i", memory="m", pipeline="p", identity="id")

        @staticmethod
        def author_token():
            return "tok"

        @staticmethod
        def _req(method, url, tok):
            return _Resp()

    ops = installer.plan(_FakeClient(), manifest)
    field_ops = [o for o in ops if o["kind"] == "case_fields"]
    assert field_ops, "case_fields must appear in the plan"
    assert all(o["action"] == "create" for o in field_ops)
    names = {o["name"] for o in field_ops}
    assert {"exception_type", "invoice_amount", "recovered_amount"} <= names
    # display_labels (inc3) also materialize as real creates (identity registry),
    # never deferred — the AP "Cases -> AP Exceptions" vocabulary.
    label_ops = [o for o in ops if o["kind"] == "display_labels"]
    assert label_ops and all(o["action"] == "create" for o in label_ops)
    assert {"cases.title", "nav.cases"} <= {o["name"] for o in label_ops}
    # guardrails (inc4) materialize as real creates onto the fixed agents the pack
    # specializes — never deferred.
    guard_ops = [o for o in ops if o["kind"] == "guardrails"]
    assert guard_ops and all(o["action"] == "create" for o in guard_ops)
    assert {"case-triage", "analytics"} <= {o["name"] for o in guard_ops}
    # agent_configs (inc5) — prompt-param specialization of the same fixed agents,
    # now materialized (was installer-deferred).
    cfg_ops = [o for o in ops if o["kind"] == "agent_configs"]
    assert cfg_ops and all(o["action"] == "create" for o in cfg_ops)
    assert {"case-triage", "analytics"} <= {o["name"] for o in cfg_ops}
    # v2.0.0 (no-dummy-data rule): the pack ships NO seeded cases and NO frozen
    # eval golden set — cases arrive from real rows via triggers/intake, and the
    # tenant curates goldens from its own adjudicated history.
    assert not [o for o in ops if o["kind"] == "cases"]
    assert not [o for o in ops if o["kind"] == "eval_sets"]
    # its file-less dataset contracts, with nothing bound and no same-name
    # tenant dataset, plan as an honest requires_binding.
    ds_ops = [o for o in ops if o["kind"] == "datasets"]
    assert ds_ops and all(o["action"] == "requires_binding" for o in ds_ops)
    # pipelines (inc7) — algorithm-template seeds, data-chain (need the dataset),
    # materializable (was deferred).
    pipe_ops = [o for o in ops if o["kind"] == "pipelines"]
    assert pipe_ops and all(o["action"] == "create" for o in pipe_ops)
    assert {"Invoice anomaly detector (isolation forest)",
            "Exception outcome scorer (xgboost)"} <= {o["name"] for o in pipe_ops}
    # memories (inc7) — tenant grounding via the governed memory.corpus.admin
    # path, materializable (was deferred behind the agent-token barrier).
    mem_ops = [o for o in ops if o["kind"] == "memories"]
    assert mem_ops and all(o["action"] == "create" for o in mem_ops)
    # decision_models (BRD 54) — governed routing tables, planned as creates.
    dm_ops = [o for o in ops if o["kind"] == "decision_models"]
    assert dm_ops and all(o["action"] == "create" for o in dm_ops)
    assert {"Exception recovery-review routing",
            "High-value and deadline expedite"} <= {o["name"] for o in dm_ops}
    # model_archetypes (inc9) — governed model blueprints, materializable (new
    # experiment-service archetype registry), one per shipped pipeline.
    arch_ops = [o for o in ops if o["kind"] == "model_archetypes"]
    assert arch_ops and all(o["action"] == "create" for o in arch_ops)
    assert {"ap_exception_outcome_scorer", "ap_invoice_anomaly_detector"} <= {o["name"] for o in arch_ops}  # noqa: E501
    # case_schemas (inc10) — typed case types, materializable (new case-service
    # case-schema registry).
    schema_ops = [o for o in ops if o["kind"] == "case_schemas"]
    assert schema_ops and all(o["action"] == "create" for o in schema_ops)
    assert "ap_invoice_exception" in {o["name"] for o in schema_ops}
    # ontology (inc11) — governed entity-type registry, materializable (new
    # dataset-service ontology surface).
    onto_ops = [o for o in ops if o["kind"] == "ontology"]
    assert onto_ops and all(o["action"] == "create" for o in onto_ops)
    assert {"vendor", "invoice", "exception", "recovery"} <= {o["name"] for o in onto_ops}
    # write_adapters (inc12) — governed SoR write-back adapters (outgoing
    # ingestion connections), materializable by reusing the decision-writeback
    # surface (skip_test declaration, proposal-mode + four-eyes preserved).
    wa_ops = [o for o in ops if o["kind"] == "write_adapters"]
    assert wa_ops and all(o["action"] == "create" for o in wa_ops)
    assert "AP platform exception-status sync" in {o["name"] for o in wa_ops}
    # connection_templates (inc13) — governed incoming source connectors, the
    # mirror of write_adapters (skip_test declaration, tenant completes creds).
    ct_ops = [o for o in ops if o["kind"] == "connection_templates"]
    assert ct_ops and all(o["action"] == "create" for o in ct_ops)
    assert "ERP AP subledger extract drop (SFTP)" in {o["name"] for o in ct_ops}


# ---- inc14: version lifecycle (upgrade + rollback) --------------------------

def _write_case_field_pack(root: Path, version: str, field_names: list[str],
                           label_value: str) -> None:
    """Author a minimal, self-contained pack (case_fields + one display label) at
    a given version — the fixture the diff/snapshot tests exercise."""
    root.mkdir(parents=True, exist_ok=True)
    (root / "pack.yaml").write_text(
        "pack_manifest: 1\n"
        "name: lifecycle-fixture\n"
        f"version: {version}\n"
        "description: lifecycle test fixture\n"
        "publisher: {id: test}\n"
        "components:\n"
        "  case_fields:\n"
        "    - {file: fields.yaml, identity: lc_fields}\n"
        "  display_labels:\n"
        "    - {file: labels.yaml, identity: lc_labels}\n"
    )
    (root / "fields.yaml").write_text(
        "".join(f"- {{name: {n}, data_type: string, purpose: both}}\n" for n in field_names))
    (root / "labels.yaml").write_text(f"- {{key: lc.demo.title, value: {label_value!r}}}\n")


def _load(pack_dir: Path):
    catalog._packctl()  # ensure packs dir (with packctl) is importable
    from packctl.manifest import load_manifest  # noqa: PLC0415
    return load_manifest(pack_dir)


def test_snapshot_bundle_roundtrips(tmp_path):
    src = tmp_path / "v1"
    _write_case_field_pack(src, "1.0.0", ["lc_alpha", "lc_bravo"], "V1")
    manifest = _load(src)
    snap = installer.snapshot_bundle(manifest)
    assert snap["version"] == "1.0.0"
    assert set(snap["files"]) == {"pack.yaml", "fields.yaml", "labels.yaml"}

    # rehydrate the stored bundle into a *different* dir and it re-validates equal.
    dest = tmp_path / "restored"
    dest.mkdir()
    restored = installer.rehydrate_bundle(snap, str(dest))
    assert restored.version == "1.0.0"
    assert {(c.kind, c.identity) for c in restored.components} == \
           {(c.kind, c.identity) for c in manifest.components}


def test_diff_plan_added_removed_retained(tmp_path):
    # prior version materialized case fields [alpha, bravo, charlie] + the label.
    prior_ledger = [
        {"kind": "case_fields", "identity": "lc_alpha", "reversible": True, "target_id": "id-a"},
        {"kind": "case_fields", "identity": "lc_bravo", "reversible": True, "target_id": "id-b"},
        {"kind": "case_fields", "identity": "lc_charlie", "reversible": True, "target_id": "id-c"},
        {"kind": "display_labels", "identity": "lc.demo.title", "reversible": True, "target_id": "lc.demo.title"},  # noqa: E501
    ]
    # target version drops charlie, adds delta, keeps alpha/bravo + the label.
    tgt = tmp_path / "v2"
    _write_case_field_pack(tgt, "1.1.0", ["lc_alpha", "lc_bravo", "lc_delta"], "V2")
    diff = installer.diff_plan(prior_ledger, _load(tgt))

    assert {d["name"] for d in diff["added"]} == {"lc_delta"}
    assert {d["name"] for d in diff["removed"]} == {"lc_charlie"}
    assert {d["name"] for d in diff["retained"]} == {"lc_alpha", "lc_bravo", "lc.demo.title"}
    # the removed set carries the real ledger ROW (with target_id) for reversal.
    assert diff["removed_rows"][0]["target_id"] == "id-c"


def test_diff_plan_ignores_tombstoned_rows(tmp_path):
    # a tombstoned prior row is not "live" — re-adding its object counts as added.
    prior_ledger = [
        {"kind": "case_fields", "identity": "lc_alpha", "tombstoned": True, "reversible": True},
    ]
    tgt = tmp_path / "v"
    _write_case_field_pack(tgt, "1.0.0", ["lc_alpha"], "V")
    diff = installer.diff_plan(prior_ledger, _load(tgt))
    # neither the tombstoned field nor the (never-installed) label is live → both add.
    assert {d["name"] for d in diff["added"]} == {"lc_alpha", "lc.demo.title"}
    assert diff["removed"] == []


# ---- inc15: drift detection ------------------------------------------------

class _DriftResp:
    def __init__(self, payload, code=200):
        self._p, self.status_code = payload, code

    def json(self):
        return self._p


class _DriftClient:
    """Fake client: returns the given case-fields list for the case-fields GET,
    empty for every other existence probe."""
    workspace_id = "ws-1"
    endpoints = types.SimpleNamespace(
        case="c", rbac="r", query="q", agent="a", semantic="s", chart="ch",
        dataset="d", ingestion="i", memory="m", pipeline="p", identity="id")

    def __init__(self, fields, datasets=None):
        self._fields = fields
        self._datasets = datasets or []

    def author_token(self):
        return "tok"

    def _req(self, method, url, tok, **kw):
        if "/case-fields" in url:
            return _DriftResp({"data": self._fields})
        if "/datasets" in url:
            return _DriftResp({"data": self._datasets})
        return _DriftResp({"data": []})


def test_detect_drift_in_sync_modified_missing_unverified(tmp_path):
    src = tmp_path / "pack"
    _write_case_field_pack(src, "1.0.0", ["lc_alpha", "lc_bravo", "lc_charlie"], "V1")
    manifest = _load(src)

    # live: alpha matches, bravo's field_meta was hand-edited, charlie was deleted.
    live_fields = [
        {"name": "lc_alpha", "data_type": "string", "purpose": "both", "field_meta": {}},
        {"name": "lc_bravo", "data_type": "string", "purpose": "both", "field_meta": {"label": "EDITED"}},  # noqa: E501
    ]
    client = _DriftClient(live_fields)
    ledger = [
        {"kind": "case_fields", "identity": "lc_alpha", "tombstoned": False, "target_id": "a", "origin": "o"},  # noqa: E501
        {"kind": "case_fields", "identity": "lc_bravo", "tombstoned": False, "target_id": "b", "origin": "o"},  # noqa: E501
        {"kind": "case_fields", "identity": "lc_charlie", "tombstoned": False, "target_id": "c", "origin": "o"},  # noqa: E501
        {"kind": "pipelines", "identity": "some_pipe", "tombstoned": False, "target_id": "p", "origin": "o"},  # noqa: E501
        {"kind": "case_fields", "identity": "lc_ghost", "tombstoned": True, "target_id": "g", "origin": "o"},  # noqa: E501
    ]
    rows = installer.detect_drift(client, ledger, manifest)
    by = {r["identity"]: r for r in rows}

    assert len(rows) == 4  # the tombstoned row is skipped (owned by a successor)
    assert by["lc_alpha"]["status"] == "in_sync" and by["lc_alpha"]["contentChecked"]
    assert by["lc_bravo"]["status"] == "modified" and "field_meta" in by["lc_bravo"]["detail"]
    assert by["lc_charlie"]["status"] == "missing"
    assert by["some_pipe"]["status"] == "unverified" and not by["some_pipe"]["contentChecked"]


def test_detect_drift_without_snapshot_is_presence_only():
    # no manifest (a pre-inc14 install) → content kinds fall back to presence.
    client = _DriftClient([{"name": "lc_alpha", "data_type": "string", "purpose": "both", "field_meta": {}}])  # noqa: E501
    ledger = [
        {"kind": "case_fields", "identity": "lc_alpha", "tombstoned": False, "target_id": "a", "origin": "o"},  # noqa: E501
        {"kind": "case_fields", "identity": "lc_gone", "tombstoned": False, "target_id": "z", "origin": "o"},  # noqa: E501
    ]
    rows = installer.detect_drift(client, ledger, None)
    by = {r["identity"]: r for r in rows}
    assert by["lc_alpha"]["status"] == "in_sync" and not by["lc_alpha"]["contentChecked"]  # presence only  # noqa: E501
    assert by["lc_gone"]["status"] == "missing"


def test_unbound_dataset_is_a_failed_install_here_even_though_the_cli_tolerates_it():
    """The API's install status is a product contract; the CLI's is an operator
    convenience. They deliberately disagree, and this pins the disagreement.

    packctl's client records an unbindable dataset as `requires_binding` so
    `packs/demo.sh load <pack>` can stand up a demo tenant's taxonomy and roles
    while its data is still outstanding. pack-service imports THAT SAME client,
    so without an explicit remap the CLI's leniency would silently become this
    endpoint's — an install whose declared datasets never resolved would report
    status=installed. run_data_chain maps it back to `failed` for exactly this
    reason; delete that mapping and this test goes red.

    A caller who wants the partial outcome asks for it: pass dataset_bindings,
    or dry-run, where plan() reports `requires_binding` and materializes
    nothing (asserted separately above)."""
    from packctl.client import PlatformClient

    client = PlatformClient(
        endpoints=None, tenant_id="t-1", workspace_id="ws-1",
        author_token=lambda: "t", approver_token=lambda: "t",
        agent_token=lambda: "t", log=lambda *_: None,
    )
    client.find_dataset = lambda name: None  # tenant has landed nothing

    assert client.bind_dataset("some_ds", "some-ds",
                               required_columns=["a", "b"]) is None
    recorded = client.actions[-1]
    assert recorded["action"] == "requires_binding", (
        "packctl's own vocabulary changed; the remap in run_data_chain and the "
        "expectation below must be revisited together")
    assert "some-ds" in recorded["detail"] and "a, b" in recorded["detail"], \
        "the detail must name the dataset and the columns the tenant still owes"

    # And the status rule this endpoint applies to that record.
    ledger = [{"action": "failed" if recorded["action"] == "requires_binding"
               else recorded["action"]}]
    failed = sum(1 for r in ledger if r["action"] == "failed")
    assert failed == 1 and ("failed" if failed else "installed") == "failed"


def test_drift_separates_never_created_from_awaiting_approval(tmp_path):
    """Three outcomes, and only one of them is drift.

    Drift compares what the install PUT into Core against what is there now, and
    `missing` has to keep meaning "somebody deleted this" or the check stops
    raising the one signal it exists for. Two ledger actions break that:

      never created  — requires_binding / awaiting_binding / after_approval /
                       deferred / blocked. Nothing was put anywhere, so there is
                       nothing to compare. Absent from the report entirely.

      submitted      — a governed DRAFT. The semantic model or verified query is
                       real and in Core, awaiting a steward's four-eyes approval,
                       but it is not in the PUBLISHED listing _existing_names
                       reads. `unverified`, not `missing`.

    The second one is what actually failed. journey-packs on PR #45 reported
    drifted=11 missing=11 against an install whose own summary said created=55,
    submitted=9, failed=0 — the 11 were the drafts and the dashboards behind
    them. A first pass here assumed unbound datasets and skipped the wrong set,
    which changed nothing.
    """
    src = tmp_path / "pack"
    _write_case_field_pack(src, "1.0.0", ["lc_alpha"], "V1")
    manifest = _load(src)
    client = _DriftClient([
        {"name": "lc_alpha", "data_type": "string", "purpose": "both", "field_meta": {}},
    ])
    ledger = [
        {"kind": "case_fields", "identity": "lc_alpha", "tombstoned": False,
         "target_id": "a", "origin": "o", "action": "create"},
        # never created
        {"kind": "datasets", "identity": "fwa_claims", "tombstoned": False,
         "target_id": None, "origin": "o", "action": "requires_binding"},
        {"kind": "dashboards", "identity": "fwa_overview", "tombstoned": False,
         "target_id": None, "origin": "o", "action": "after_approval"},
        # created, but as a governed draft awaiting approval
        {"kind": "semantic_models", "identity": "fwa_core", "tombstoned": False,
         "target_id": "s1", "origin": "o", "action": "submitted"},
        # a real deletion must STILL be caught
        {"kind": "case_fields", "identity": "lc_deleted", "tombstoned": False,
         "target_id": "d", "origin": "o", "action": "create"},
    ]
    rows = installer.detect_drift(client, ledger, manifest)
    by = {r["identity"]: r for r in rows}

    assert "fwa_claims" not in by and "fwa_overview" not in by, (
        "components that were never created do not belong in a drift report"
    )
    assert by["fwa_core"]["status"] == "unverified", (
        "a submitted draft exists in Core — reporting it missing calls a healthy "
        "install drifted, which is the bug this test pins"
    )
    assert by["lc_alpha"]["status"] == "in_sync"
    assert by["lc_deleted"]["status"] == "missing", (
        "a genuinely deleted object must still read missing — the exemptions are "
        "scoped to actions that never published anything, not to everything "
        "inconvenient"
    )
    drifted = sum(1 for r in rows if r["status"] in ("modified", "missing"))
    assert drifted == 1, f"only the deletion is drift; got {drifted}"


def test_bound_dataset_resolves_by_urn_not_by_the_packs_declared_name(tmp_path):
    """A bound dataset is not missing just because the tenant named it something else.

    The install records a dataset under the PACK's declared name
    (_rec("datasets", ds["name"], ...)), while _existing_names lists the TENANT's
    dataset names. Bind to a tenant dataset called anything else and the name
    lookup cannot find it, so a live, bound, working dataset reads `missing`.

    That is what journey-packs hit on 680d3182: missing=4, for exactly the four
    datasets the same run had just landed, bound, and asserted were present.

    target_urn is what the install actually bound, so it settles the question the
    name cannot. Strictly a fallback — the name lookup still runs first, and a
    dataset whose URN is also gone from the tenant listing still reads missing.
    """
    src = tmp_path / "pack"
    _write_case_field_pack(src, "1.0.0", ["lc_alpha"], "V1")
    manifest = _load(src)

    client = _DriftClient(
        [{"name": "lc_alpha", "data_type": "string", "purpose": "both", "field_meta": {}}],
        # The tenant's dataset is called `tenant_claims_2026`, NOT `fwa_claims`.
        datasets=[{"name": "tenant_claims_2026", "urn": "wr:t1:dataset/abc"}],
    )
    ledger = [
        {"kind": "case_fields", "identity": "lc_alpha", "tombstoned": False,
         "target_id": "a", "origin": "o", "action": "create"},
        # bound: pack calls it fwa_claims, tenant calls it something else
        {"kind": "datasets", "identity": "fwa_claims", "tombstoned": False,
         "target_urn": "wr:t1:dataset/abc", "target_id": "abc", "origin": "o",
         "action": "bind"},
        # a dataset whose URN is NOT in the tenant listing really is gone
        {"kind": "datasets", "identity": "fwa_deleted", "tombstoned": False,
         "target_urn": "wr:t1:dataset/gone", "target_id": "gone", "origin": "o",
         "action": "bind"},
    ]
    rows = installer.detect_drift(client, ledger, manifest)
    by = {r["identity"]: r for r in rows}

    assert by["fwa_claims"]["status"] == "in_sync", (
        "a bound dataset present under the tenant's own name is not drift — this "
        "is the missing=4 journey-packs reported against a healthy install"
    )
    assert by["fwa_deleted"]["status"] == "missing", (
        "the URN fallback must not swallow a real deletion: no name match AND no "
        "URN match still means somebody deleted it"
    )
    assert by["lc_alpha"]["status"] == "in_sync"
    drifted = sum(1 for r in rows if r["status"] in ("modified", "missing"))
    assert drifted == 1, f"only the real deletion is drift; got {drifted}"
