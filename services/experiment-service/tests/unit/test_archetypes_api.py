"""Model archetypes (inc9): governed model BLUEPRINTS — create/list/get/delete,
idempotency, and validation."""

from __future__ import annotations

import pytest

from tests.conftest import WORKSPACE, auth

pytestmark = pytest.mark.asyncio


def _body(**over):
    b = {
        "workspace_id": WORKSPACE, "archetype_key": "dup_pair_conf",
        "name": "Duplicate pair confidence", "task_type": "pairwise_binary_classification",
        "target": "is_duplicate",
        "expected_metrics": {"precision_min": 0.95, "primary": "precision"},
        "governance_notes": "advisory hold only",
    }
    b.update(over)
    return b


async def test_create_list_get_archetype(client):
    r = await client.post("/api/v1/archetypes", json=_body(), headers=auth())
    assert r.status_code == 201, r.text
    d = r.json()["data"]
    assert d["archetype_key"] == "dup_pair_conf"
    assert d["expected_metrics"]["primary"] == "precision"

    lr = await client.get(f"/api/v1/archetypes?filter[workspace_id]={WORKSPACE}", headers=auth())
    assert any(a["archetype_key"] == "dup_pair_conf" for a in lr.json()["data"])

    gr = await client.get(
        f"/api/v1/archetypes/dup_pair_conf?filter[workspace_id]={WORKSPACE}", headers=auth())
    assert gr.status_code == 200
    assert gr.json()["data"]["task_type"] == "pairwise_binary_classification"


async def test_create_is_idempotent(client):
    await client.post("/api/v1/archetypes", json=_body(), headers=auth())
    r2 = await client.post("/api/v1/archetypes", json=_body(name="changed"), headers=auth())
    assert r2.status_code == 201  # returns the existing blueprint, not a duplicate
    lr = await client.get(f"/api/v1/archetypes?filter[workspace_id]={WORKSPACE}", headers=auth())
    keys = [a for a in lr.json()["data"] if a["archetype_key"] == "dup_pair_conf"]
    assert len(keys) == 1


async def test_delete_archetype(client):
    await client.post("/api/v1/archetypes", json=_body(), headers=auth())
    dr = await client.delete(
        f"/api/v1/archetypes/dup_pair_conf?filter[workspace_id]={WORKSPACE}", headers=auth())
    assert dr.status_code == 204
    gr = await client.get(
        f"/api/v1/archetypes/dup_pair_conf?filter[workspace_id]={WORKSPACE}", headers=auth())
    assert gr.status_code == 404


async def test_create_requires_task_type(client):
    r = await client.post("/api/v1/archetypes", json=_body(task_type=""), headers=auth())
    assert r.status_code >= 400
