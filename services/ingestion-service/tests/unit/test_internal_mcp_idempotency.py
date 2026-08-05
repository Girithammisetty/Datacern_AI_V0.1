"""BRD 73 — the internal MCP facade's Idempotency-Key.

pipeline-orchestrator's batch jobs create ingestions through
`POST /internal/v1/mcp/invoke` (a cron-fired job has no user token and must not
mint one, so SPIFFE is the only honest way in). That path had no equivalent of
the REST route's `Idempotency-Key` header, so a caller that crashed between
sending the request and recording the response had no way to retry without
creating a SECOND ingestion — which for a batch job is not a wasted request but
the same batch ingested twice.
"""

from __future__ import annotations

import sqlalchemy as sa

from app.domain.querysource import FakeQuerySource
from app.store.models import Ingestion
from tests.util import TENANT_A, create_connection

SPIFFE = {"x-client-spiffe-id": "spiffe://datacern/ns/ml/sa/pipeline-orchestrator"}
ROWS = [{"id": i, "name": f"n{i}"} for i in range(3)]


def _invoke_body(connection_id: str, key: str | None):
    body = {
        "tool_id": "ingestion.create",
        "tenant": TENANT_A,
        "args": {"ingestion_mode": "query", "connection_id": connection_id,
                 "statement": "SELECT * FROM public.orders",
                 "new_dataset": {"name": "Orders"}},
    }
    if key is not None:
        body["idempotency_key"] = key
    return body


async def _count(container) -> int:
    async with container.db.tenant_session(TENANT_A) as session:
        return int((await session.execute(
            sa.select(sa.func.count()).select_from(Ingestion))).scalar_one())


async def test_pipeline_orchestrator_is_an_allowed_internal_caller(client, auth_a,
                                                                    container):
    container.query_sources.set("postgres", FakeQuerySource(rows=ROWS))
    conn = await create_connection(client, auth_a)
    resp = await client.post("/internal/v1/mcp/invoke",
                             json=_invoke_body(conn["id"], "batch-1:b0"),
                             headers=SPIFFE)
    assert resp.status_code == 200, resp.text
    assert resp.json()["output"]["ingestion"]["id"]


async def test_an_unknown_spiffe_is_still_refused(client, auth_a, container):
    conn = await create_connection(client, auth_a)
    resp = await client.post("/internal/v1/mcp/invoke",
                             json=_invoke_body(conn["id"], "batch-1:b0"),
                             headers={"x-client-spiffe-id": "spiffe://evil/ns/x/sa/y"})
    assert resp.status_code == 403


async def test_a_repeated_idempotency_key_replays_instead_of_ingesting_twice(
        client, auth_a, container):
    container.query_sources.set("postgres", FakeQuerySource(rows=ROWS))
    conn = await create_connection(client, auth_a)
    body = _invoke_body(conn["id"], "batch-42:b0")

    first = await client.post("/internal/v1/mcp/invoke", json=body, headers=SPIFFE)
    second = await client.post("/internal/v1/mcp/invoke", json=body, headers=SPIFFE)

    assert first.status_code == 200 and second.status_code == 200
    one = first.json()["output"]["ingestion"]["id"]
    two = second.json()["output"]["ingestion"]["id"]
    assert one == two, "the retry created a second ingestion for the same batch"
    assert await _count(container) == 1


async def test_a_different_key_creates_a_genuinely_new_ingestion(client, auth_a,
                                                                 container):
    """Retrying a FAILED binding must be a new ingestion, not a replay of the
    failed one — so the key has to actually key something."""
    container.query_sources.set("postgres", FakeQuerySource(rows=ROWS))
    conn = await create_connection(client, auth_a)

    first = await client.post("/internal/v1/mcp/invoke",
                              json=_invoke_body(conn["id"], "batch-42:b0"),
                              headers=SPIFFE)
    second = await client.post("/internal/v1/mcp/invoke",
                               json=_invoke_body(conn["id"], "batch-43:b0"),
                               headers=SPIFFE)
    assert (first.json()["output"]["ingestion"]["id"]
            != second.json()["output"]["ingestion"]["id"])
    assert await _count(container) == 2


async def test_no_key_still_works_for_the_existing_tool_plane_path(client, auth_a,
                                                                   container):
    """mcp-gateway does not send a key; the change must be purely additive."""
    container.query_sources.set("postgres", FakeQuerySource(rows=ROWS))
    conn = await create_connection(client, auth_a)
    for _ in range(2):
        resp = await client.post("/internal/v1/mcp/invoke",
                                 json=_invoke_body(conn["id"], None),
                                 headers={"x-client-spiffe-id":
                                          "spiffe://datacern/ns/tools/sa/mcp-gateway"})
        assert resp.status_code == 200, resp.text
    assert await _count(container) == 2
