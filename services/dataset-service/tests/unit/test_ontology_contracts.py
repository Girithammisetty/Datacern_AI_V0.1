"""Knowledge Spine WS4 — SHACL-style data contracts on ontology attributes.

Attributes may carry ``required`` / ``enum`` constraints, shape-checked at
authoring (a malformed constraint can never silently disable enforcement) and
enforced against a dataset's REAL rows through the WS2 attribute -> column map
by ``check_ontology_contract``. Violations are reported honestly: a required
attribute with no mapped column is itself a violation; an unmapped OPTIONAL
attribute is simply not checked; blanks belong to the required check (the enum
check skips them, so one bad cell never double-counts).
"""

from __future__ import annotations

import pytest

from app.domain.services import CallCtx
from tests.conftest import TENANT_A, WORKSPACE, auth, create_dataset

pytestmark = pytest.mark.asyncio

ROWS = [
    {"pk": "r1", "status": "active", "country": "DE"},
    {"pk": "r2", "status": "dormant", "country": ""},        # blank country
    {"pk": "r3", "status": "ACTIVE!!", "country": "FR"},     # not in enum
    {"pk": "r4", "status": "active", "country": None},       # null country
    {"pk": "r5", "status": "closed", "country": "XX"},
]
COLUMNS = ["pk", "status", "country"]

VENDOR = {
    "workspace_id": WORKSPACE, "entity_key": "vendor", "name": "Vendor",
    "attributes": [
        {"name": "status", "data_type": "string", "required": True,
         "enum": ["active", "dormant", "closed"]},
        {"name": "country", "data_type": "string", "required": True},
        {"name": "nickname", "data_type": "string"},  # optional, unconstrained
    ],
}


def _ctx():
    return CallCtx(tenant_id=TENANT_A, actor={"type": "user", "id": "steward-1"})


@pytest.fixture
def svc(container, monkeypatch):
    s = container.dataset_service

    async def _fake_read_rows(tenant_id, dataset_id, row_limit=20000):
        return COLUMNS, ROWS

    monkeypatch.setattr(s, "read_rows", _fake_read_rows)
    return s


async def _declare_vendor(client, **over):
    body = {**VENDOR, **over}
    r = await client.post("/api/v1/ontology/entities", json=body, headers=auth())
    return r


# ---- constraint authoring validation ----------------------------------------


async def test_constraints_author_and_round_trip(client):
    r = await _declare_vendor(client)
    assert r.status_code == 201, r.text
    attrs = {a["name"]: a for a in r.json()["data"]["attributes"]}
    assert attrs["status"]["required"] is True
    assert attrs["status"]["enum"] == ["active", "dormant", "closed"]


async def test_malformed_constraints_rejected_at_authoring(client):
    bad_required = await _declare_vendor(
        client, entity_key="v2",
        attributes=[{"name": "status", "required": "yes"}])
    assert bad_required.status_code == 422
    bad_enum = await _declare_vendor(
        client, entity_key="v3",
        attributes=[{"name": "status", "enum": []}])
    assert bad_enum.status_code == 422
    nested_enum = await _declare_vendor(
        client, entity_key="v4",
        attributes=[{"name": "status", "enum": [{"not": "scalar"}]}])
    assert nested_enum.status_code == 422


async def test_proposed_update_validates_constraints_too(client):
    await _declare_vendor(client)
    r = await client.post(
        "/api/v1/ontology/entities/vendor/versions",
        json={"workspace_id": WORKSPACE,
              "attributes": [{"name": "status", "required": "nope"}]},
        headers=auth(sub="author"))
    assert r.status_code == 422


# ---- the data-contract checker ----------------------------------------------


async def _check(svc, client, attribute_map, dataset_name="ContractDs"):
    ds = await create_dataset(client, name=dataset_name)
    return await svc.check_ontology_contract(
        _ctx(), WORKSPACE, "vendor", ds["id"], attribute_map=attribute_map)


async def test_contract_reports_enum_and_null_violations(client, svc):
    await _declare_vendor(client)
    out = await _check(svc, client, {"status": "status", "country": "country"})
    assert out["checked_rows"] == 5
    assert out["passed"] is False
    by_kind = {(v["kind"], v["attribute"]): v for v in out["violations"]}
    # status: ACTIVE!! is outside the enum (blanks would be skipped).
    enum_v = by_kind[("value_not_in_enum", "status")]
    assert enum_v["count"] == 1 and enum_v["examples"] == ["ACTIVE!!"]
    # country: one blank + one null = 2 nulls in a required attribute.
    null_v = by_kind[("nulls_in_required", "country")]
    assert null_v["count"] == 2
    # The optional unmapped attribute is not checked and not a violation.
    assert ("required_unmapped", "nickname") not in by_kind
    assert out["checked_attributes"] == ["status", "country"]


async def test_required_attribute_with_no_mapping_is_itself_a_violation(client, svc):
    await _declare_vendor(client)
    out = await _check(svc, client, {"status": "status"}, dataset_name="ContractDs2")
    kinds = {(v["kind"], v["attribute"]) for v in out["violations"]}
    assert ("required_unmapped", "country") in kinds


async def test_mapped_column_missing_from_dataset_is_reported(client, svc):
    await _declare_vendor(client)
    out = await _check(svc, client, {"status": "status", "country": "no_such"},
                       dataset_name="ContractDs3")
    kinds = {(v["kind"], v["attribute"]): v for v in out["violations"]}
    assert kinds[("column_missing", "country")]["column"] == "no_such"


async def test_clean_data_passes(client, svc, monkeypatch):
    await _declare_vendor(client)

    async def _clean_rows(tenant_id, dataset_id, row_limit=20000):
        return COLUMNS, [{"pk": "r1", "status": "active", "country": "DE"}]

    monkeypatch.setattr(svc, "read_rows", _clean_rows)
    out = await _check(svc, client, {"status": "status", "country": "country"},
                       dataset_name="ContractDs4")
    assert out["passed"] is True and out["violations"] == []
