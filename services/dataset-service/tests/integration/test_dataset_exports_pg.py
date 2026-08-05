"""Integration: dataset export against real Postgres (BRD 74 D1, AC-1/AC-2).

The unit tier proves the export logic against the in-memory policy fake; this
tier proves the same flow against the shipped migration (`0007`) and the real
tenant_isolation RLS policy, driven through the non-superuser `dataset_rt` role.
query-service is still the contract fake from the unit tier — a real one would
need DuckDB, MinIO and an Iceberg catalog, which is what `make e2e` is for.
"""

from __future__ import annotations

import pytest
from sqlalchemy import text

from tests.conftest import SPIFFE_INGESTION, TENANT_A, TENANT_B, auth, create_dataset
from tests.unit.test_dataset_exports import DF, FakeQueryService

pytestmark = pytest.mark.integration


async def _seed(client, container, name="Claims"):
    ds = await create_dataset(client, name=name)
    await container.catalog.commit_snapshot(ds["iceberg_table"], 3001, DF)
    resp = await client.post(
        f"/internal/v1/datasets/{ds['id']}/versions",
        json={
            "tenant_id": TENANT_A,
            "iceberg_snapshot_id": 3001,
            "schema": {c: {"type": "string", "nullable": True, "tags": []}
                       for c in DF.columns},
            "row_count": len(DF), "bytes": 512,
            "produced_by_urn": f"wr:{TENANT_A}:ingestion:ingestion/i-3001",
            "skip_profiling": True,
        },
        headers={"x-client-spiffe-id": SPIFFE_INGESTION},
    )
    assert resp.status_code == 201, resp.text
    return ds


class TestDatasetExportOnPostgres:
    async def test_round_trip_persists_and_is_version_pinned(self, client, container):
        qs = FakeQueryService(statuses=("running", "succeeded"))
        container.export_runner.client_factory = qs.client
        container.export_runner.poll_interval_seconds = 0

        ds = await _seed(client, container)
        created = await client.post(
            f"/api/v1/datasets/{ds['id']}/exports", json={"format": "csv"},
            headers=auth(TENANT_A),
        )
        assert created.status_code == 202, created.text
        export_id = created.json()["data"]["id"]
        await container.export_runner.drain()

        data = (await client.get(
            f"/api/v1/exports/{export_id}", headers=auth(TENANT_A))).json()["data"]
        assert data["status"] == "completed"
        assert data["version_no"] == 1
        assert data["version_urn"].endswith("@v1")
        assert "/api/v1/downloads/" in data["download_url"]
        assert qs.sql_seen == ["SELECT * FROM {{dataset('Claims', version=1)}}"]

    async def test_cross_tenant_export_id_404s_under_rls(self, client, container):
        """AC-2, enforced by the Postgres policy rather than app-level filtering."""
        qs = FakeQueryService()
        container.export_runner.client_factory = qs.client
        container.export_runner.poll_interval_seconds = 0

        ds = await _seed(client, container, name="ClaimsRls")
        created = await client.post(
            f"/api/v1/datasets/{ds['id']}/exports", json={}, headers=auth(TENANT_A)
        )
        export_id = created.json()["data"]["id"]
        await container.export_runner.drain()

        assert (await client.get(
            f"/api/v1/exports/{export_id}", headers=auth(TENANT_A))).status_code == 200
        theirs = await client.get(
            f"/api/v1/exports/{export_id}", headers=auth(TENANT_B))
        assert theirs.status_code == 404
        assert theirs.json()["error"]["code"] == "NOT_FOUND"

    async def test_rls_hides_the_row_at_sql_level(self, client, container, engine):
        qs = FakeQueryService()
        container.export_runner.client_factory = qs.client
        container.export_runner.poll_interval_seconds = 0
        ds = await _seed(client, container, name="ClaimsRaw")
        await client.post(
            f"/api/v1/datasets/{ds['id']}/exports", json={}, headers=auth(TENANT_A)
        )
        await container.export_runner.drain()

        async with engine.connect() as conn:
            count = (await conn.execute(
                text("SELECT count(*) FROM dataset_exports"))).scalar()
            assert count == 0, "no tenant context must see nothing"
            await conn.execute(
                text("SELECT set_config('app.tenant_id', :t, true)"), {"t": TENANT_B})
            assert (await conn.execute(
                text("SELECT count(*) FROM dataset_exports"))).scalar() == 0
            await conn.execute(
                text("SELECT set_config('app.tenant_id', :t, true)"), {"t": TENANT_A})
            assert (await conn.execute(
                text("SELECT count(*) FROM dataset_exports"))).scalar() == 1
