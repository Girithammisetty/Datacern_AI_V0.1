"""Unit tests for the pack catalog + install planner (no live stack needed)."""

from __future__ import annotations

import types
from pathlib import Path

import pytest

from app.domain import catalog, installer

REPO_PACKS = Path(__file__).resolve().parents[3] / "packs"


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
    assert "guardrails" in cd["deferred_kinds"]  # honest deferral surfaced


def test_get_pack_detail_and_missing():
    detail = catalog.get_pack("card-disputes")
    assert detail is not None
    assert detail["deferred"]  # list of {kind, reason}
    assert all("reason" in d for d in detail["deferred"])
    assert catalog.get_pack("no-such-pack") is None


def test_origin_tag_and_urn_id():
    of = installer.origin_tag("card-disputes", "1.0.0")
    assert of("dispositions", "dispositions") == "pack:card-disputes@1.0.0:dispositions/dispositions"
    assert installer._urn_id("wr:t:query:query/abc-123") == "abc-123"
    assert installer._urn_id(None) is None


def test_inc1_kinds_and_reversibility_contract():
    # inc1 materializes self-contained kinds (no dataset/four-eyes chain).
    # inc3 adds case_fields (case-service custom-field catalog) here.
    assert set(installer.INC1_KINDS) == {"dispositions", "case_fields", "display_labels", "roles", "decision_models"}
    assert "saved_queries" not in installer.INC1_KINDS  # needs its datasets first
    # Roles/case_fields carry a real Core delete verb → reversible; dispositions/
    # decision tables do not (tombstoned honestly on uninstall).
    assert "roles" in installer.REVERSIBLE_KINDS
    assert "case_fields" in installer.REVERSIBLE_KINDS  # DELETE /case-fields/{id}
    assert "display_labels" in installer.REVERSIBLE_KINDS  # DELETE /tenants/self/labels/{key}
    assert "dispositions" not in installer.REVERSIBLE_KINDS
    assert "decision_models" not in installer.REVERSIBLE_KINDS


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
    # inc2 data chain is now materializable (create), not faked
    assert kinds.get("datasets") == "create"
    assert kinds.get("semantic_models") == "create"
    # dashboards wait for the steward to approve the semantic model (phase 2)
    assert any(o["kind"] == "dashboards" and o["action"] == "after_approval" for o in ops)


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
    assert {"root_cause", "oob_verified", "recovered_amount"} <= names
    # display_labels (inc3) also materialize as real creates (identity registry),
    # never deferred — the AP "Cases -> AP Exceptions" vocabulary.
    label_ops = [o for o in ops if o["kind"] == "display_labels"]
    assert label_ops and all(o["action"] == "create" for o in label_ops)
    assert {"cases.title", "nav.cases"} <= {o["name"] for o in label_ops}
