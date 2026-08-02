"""Knowledge Spine WS2 — link the vertebrae on entity_key.

Entity resolution's ``entity_type`` was a free string, never resolved against
the governed ontology registry (gap #2 of the initiative). A resolution run now
reports ``ontology_linked``: true when the type is declared in the dataset's
workspace ontology, false otherwise — honest metadata, never an error, so
free-string types and resolve-before-declare workflows keep working.
"""

from __future__ import annotations

import pytest

from app.domain.services import CallCtx
from tests.conftest import TENANT_A, WORKSPACE, auth, create_dataset

pytestmark = pytest.mark.asyncio

ROWS = [
    {"pk": "r1", "name": "Viktor Petrov", "national_id": "N-100"},
    {"pk": "r2", "name": "V. Petrov", "national_id": "N-100"},
]
COLUMNS = ["pk", "name", "national_id"]


def _config(entity_type: str) -> dict:
    return {"entity_type": entity_type, "deterministic_keys": [["national_id"]]}


def _ctx():
    return CallCtx(tenant_id=TENANT_A, actor={"type": "user", "id": "steward-1"})


@pytest.fixture
def svc(container, monkeypatch):
    s = container.dataset_service

    async def _fake_read_rows(tenant_id, dataset_id, row_limit=20000):
        return COLUMNS, ROWS

    monkeypatch.setattr(s, "read_rows", _fake_read_rows)
    return s


async def _declare_person(client):
    r = await client.post(
        "/api/v1/ontology/entities",
        json={"workspace_id": WORKSPACE, "entity_key": "person", "name": "Person"},
        headers=auth(),
    )
    assert r.status_code == 201, r.text


async def test_run_links_when_the_type_is_declared_in_the_workspace(client, svc):
    await _declare_person(client)
    ds = await create_dataset(client, name="Ws2Linked")
    out = await svc.resolve_entities(
        TENANT_A, ds["id"], config=_config("person"), pk_column="pk",
        persist=True, ctx=_ctx(), created_by="steward-1")
    assert out["ontology_linked"] is True
    assert out["entity_type"] == "person"


async def test_run_reports_unlinked_for_an_undeclared_type(client, svc):
    ds = await create_dataset(client, name="Ws2Unlinked")
    # No ontology type declared -> honest false, the run still succeeds.
    out = await svc.resolve_entities(
        TENANT_A, ds["id"], config=_config("mystery_thing"), pk_column="pk",
        persist=True, ctx=_ctx(), created_by="steward-1")
    assert out["ontology_linked"] is False
    assert out["resolved_entity_count"] >= 1


async def test_unknown_dataset_never_claims_a_link(svc):
    # The dataset row can't be read -> linkage cannot be established -> false
    # (never fabricated), and resolution itself still works over the rows.
    out = await svc.resolve_entities(
        TENANT_A, "no-such-dataset", config=_config("person"), pk_column="pk",
        persist=False, ctx=_ctx())
    assert out["ontology_linked"] is False
