"""Ontology versioning + four-eyes update (WS3 — govern the ontology like
semantic models). A proposed update lands in_review; a DISTINCT approver
publishes it (author≠approver), superseding the prior version, updating the live
type and recording a machine diff. The live type never changes on a proposal or
a rejection."""

from __future__ import annotations

import pytest

from tests.conftest import WORKSPACE, auth

pytestmark = pytest.mark.asyncio

VERSIONS = "/api/v1/ontology/entities/vendor/versions"
GET_LIVE = f"/api/v1/ontology/entities/vendor?filter[workspace_id]={WORKSPACE}"


def _create_body(**over):
    b = {
        "workspace_id": WORKSPACE, "entity_key": "vendor", "name": "Vendor",
        "description": "A supplier the org pays.",
        "attributes": [{"name": "vendor_id", "data_type": "string"}],
        "relationships": [{"name": "invoices", "target": "invoice", "cardinality": "has_many"}],
    }
    b.update(over)
    return b


async def _create(client):
    r = await client.post("/api/v1/ontology/entities", json=_create_body(), headers=auth())
    assert r.status_code == 201, r.text
    return r.json()["data"]


async def test_create_seeds_a_v1_published_version(client):
    d = await _create(client)
    assert d["version_no"] == 1
    vr = await client.get(f"{VERSIONS}?filter[workspace_id]={WORKSPACE}", headers=auth())
    versions = vr.json()["data"]
    assert len(versions) == 1
    assert versions[0]["version_no"] == 1
    assert versions[0]["status"] == "published"


async def test_propose_creates_in_review_without_touching_the_live_type(client):
    await _create(client)
    pr = await client.post(
        VERSIONS,
        json={"workspace_id": WORKSPACE, "name": "Supplier",
              "attributes": [{"name": "vendor_id", "data_type": "string"},
                             {"name": "tax_id", "data_type": "string"}]},
        headers=auth(sub="author"))
    assert pr.status_code == 201, pr.text
    v = pr.json()["data"]
    assert v["version_no"] == 2
    assert v["status"] == "in_review"
    assert v["submitted_by"] == "author"
    # The LIVE type is unchanged — a proposal is not a publish.
    live = (await client.get(GET_LIVE, headers=auth())).json()["data"]
    assert live["name"] == "Vendor"
    assert live["version_no"] == 1


async def test_author_cannot_approve_own_update(client):
    await _create(client)
    await client.post(VERSIONS, json={"workspace_id": WORKSPACE, "name": "Supplier"},
                      headers=auth(sub="author"))
    ar = await client.post(
        f"{VERSIONS}/2/approve", json={"workspace_id": WORKSPACE}, headers=auth(sub="author"))
    assert ar.status_code == 403  # four-eyes: author≠approver


async def test_distinct_approver_publishes_supersedes_and_diffs(client):
    await _create(client)
    await client.post(
        VERSIONS,
        json={"workspace_id": WORKSPACE, "name": "Supplier",
              "attributes": [{"name": "vendor_id", "data_type": "string"},
                             {"name": "tax_id", "data_type": "string"}],
              "relationships": []},
        headers=auth(sub="author"))

    ar = await client.post(
        f"{VERSIONS}/2/approve",
        json={"workspace_id": WORKSPACE, "note": "add tax id"}, headers=auth(sub="approver"))
    assert ar.status_code == 200, ar.text
    v = ar.json()["data"]
    assert v["status"] == "published"
    assert v["approved_by"] == "approver"
    # Diff names exactly what changed.
    assert v["diff"]["name_changed"] is True
    assert v["diff"]["attributes"]["added"] == ["tax_id"]
    assert v["diff"]["relationships"]["removed"] == ["invoices"]

    # The live type now reflects the approved update at v2.
    live = (await client.get(GET_LIVE, headers=auth())).json()["data"]
    assert live["name"] == "Supplier"
    assert live["version_no"] == 2
    assert {a["name"] for a in live["attributes"]} == {"vendor_id", "tax_id"}

    # v1 is superseded; v2 is published (history complete).
    vr = await client.get(f"{VERSIONS}?filter[workspace_id]={WORKSPACE}", headers=auth())
    by_no = {x["version_no"]: x["status"] for x in vr.json()["data"]}
    assert by_no == {1: "superseded", 2: "published"}


async def test_reject_leaves_the_live_type_unchanged(client):
    await _create(client)
    await client.post(VERSIONS, json={"workspace_id": WORKSPACE, "name": "Supplier"},
                      headers=auth(sub="author"))
    rr = await client.post(
        f"{VERSIONS}/2/reject", json={"workspace_id": WORKSPACE, "note": "not now"},
        headers=auth(sub="approver"))
    assert rr.status_code == 200, rr.text
    assert rr.json()["data"]["status"] == "rejected"
    live = (await client.get(GET_LIVE, headers=auth())).json()["data"]
    assert live["name"] == "Vendor" and live["version_no"] == 1


async def test_only_one_open_proposal_at_a_time(client):
    await _create(client)
    await client.post(VERSIONS, json={"workspace_id": WORKSPACE, "name": "Supplier"},
                      headers=auth(sub="author"))
    second = await client.post(
        VERSIONS, json={"workspace_id": WORKSPACE, "name": "Merchant"}, headers=auth(sub="author2"))
    assert second.status_code == 409  # one in_review at a time


async def test_can_propose_again_after_a_rejection(client):
    await _create(client)
    await client.post(VERSIONS, json={"workspace_id": WORKSPACE, "name": "Supplier"},
                      headers=auth(sub="author"))
    await client.post(f"{VERSIONS}/2/reject", json={"workspace_id": WORKSPACE},
                      headers=auth(sub="approver"))
    again = await client.post(
        VERSIONS, json={"workspace_id": WORKSPACE, "name": "Merchant"}, headers=auth(sub="author"))
    assert again.status_code == 201  # the rejected one no longer blocks
    assert again.json()["data"]["version_no"] == 3
