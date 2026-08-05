"""Unit: internal dataset-detail endpoints semantic-service calls for binding
validation (SEM-FR-002 / B3):

- GET /internal/v1/datasets/{id}          -> {physical_table, schema, primary_key}
- GET /internal/v1/datasets/{id}/profile  -> {schema, top_values}

Guarded by require_internal (SPIFFE allowlist incl. semantic-service) with the
tenant supplied via the x-datacern-tenant-id header.
"""

from __future__ import annotations

import pandas as pd

from app.domain.profiling.engine import TOP_VALUES_K
from tests.conftest import SPIFFE_INGESTION, TENANT_A, TENANT_B, create_dataset

SPIFFE_SEMANTIC = "spiffe://datacern/ns/data/sa/semantic-service"

DF = pd.DataFrame(
    {
        "claim_id": [f"C{i}" for i in range(14)],
        "claim_type": ["auto"] * 14,
        "vendor": ["acme"] * 14,
        "amount": [str(100 + i) for i in range(14)],
    }
)


async def _register_version(
    client, container, ds, snapshot_id=2001, df=DF, schema=None, skip_profiling=True
):
    await container.catalog.commit_snapshot(ds["iceberg_table"], snapshot_id, df)
    resp = await client.post(
        f"/internal/v1/datasets/{ds['id']}/versions",
        json={
            "tenant_id": TENANT_A,
            "iceberg_snapshot_id": snapshot_id,
            "schema": schema if schema is not None else {},
            "row_count": len(df),
            "bytes": 4044,
            "skip_profiling": skip_profiling,
        },
        headers={"x-client-spiffe-id": SPIFFE_INGESTION},
    )
    assert resp.status_code == 201, resp.text
    return resp


def _sem_headers(tenant=TENANT_A):
    return {"x-client-spiffe-id": SPIFFE_SEMANTIC, "x-datacern-tenant-id": tenant}


class TestInternalDetail:
    async def test_detail_returns_physical_table_and_schema(self, client, container):
        ds = await create_dataset(client, name="auto-claims-1783755028")
        await _register_version(client, container, ds)

        resp = await client.get(
            f"/internal/v1/datasets/{ds['id']}", headers=_sem_headers()
        )
        assert resp.status_code == 200, resp.text
        data = resp.json()["data"]
        # physical_table = main.<normalized relation> (matches entity.table).
        assert data["physical_table"] == "main.auto_claims_1783755028"
        assert data["primary_key"] == []
        # Empty version schema -> columns fall back to the physical Iceberg table.
        assert {"claim_type", "vendor", "amount"} <= set(data["schema"].keys())

    async def test_detail_uses_version_schema_types(self, client, container):
        ds = await create_dataset(client, name="Orders")
        await _register_version(
            client, container, ds,
            schema={"order_id": {"type": "long", "nullable": False, "tags": []},
                    "email": {"type": "string", "nullable": True, "tags": ["pii:email"]}},
        )
        resp = await client.get(
            f"/internal/v1/datasets/{ds['id']}", headers=_sem_headers()
        )
        assert resp.status_code == 200, resp.text
        schema = resp.json()["data"]["schema"]
        assert schema == {"order_id": "long", "email": "string"}

    async def test_profile_returns_schema_dict(self, client, container):
        """skip_profiling=True: no profile exists yet -> top_values legitimately {}."""
        ds = await create_dataset(client, name="auto-claims-1783755028")
        await _register_version(client, container, ds)
        resp = await client.get(
            f"/internal/v1/datasets/{ds['id']}/profile", headers=_sem_headers()
        )
        assert resp.status_code == 200, resp.text
        data = resp.json()["data"]
        assert {"claim_type", "vendor", "amount"} <= set(data["schema"].keys())
        assert data["top_values"] == {}

    async def test_profile_projects_real_top_values_once_profiled(self, client, container):
        """SEM-FR-002/080: after a REAL profile completes, top_values projects the
        per-column sample values from profile.json ({col: [most-frequent, ...]})
        for semantic-service's sample-value validation — not a hardcoded {}."""
        ds = await create_dataset(client, name="profiled-claims")
        # skip_profiling=False -> the in-process profiler runs and completes via
        # the signed callback, persisting profile.json to the object store.
        await _register_version(client, container, ds, skip_profiling=False)

        resp = await client.get(
            f"/internal/v1/datasets/{ds['id']}/profile", headers=_sem_headers()
        )
        assert resp.status_code == 200, resp.text
        data = resp.json()["data"]
        top = data["top_values"]
        assert top, "top_values must be projected from the completed profile"
        # categorical string columns carry their real most-frequent values
        assert top["claim_type"] == ["auto"]
        assert top["vendor"] == ["acme"]
        # the most frequent K values only (BRD 75: K = TOP_VALUES_K = 10, the
        # same slice semantic-service applies to sample_values anyway)
        assert len(top["claim_id"]) == TOP_VALUES_K
        assert set(top["claim_id"]) <= {f"C{i}" for i in range(14)}
        # values are raw strings (semantic-service slices sample_values[:10])
        assert all(isinstance(v, str) for vals in top.values() for v in vals)

    async def test_profile_top_values_tenant_scoped(self, client, container):
        ds = await create_dataset(client, name="profiled-claims-2")
        await _register_version(client, container, ds, skip_profiling=False)
        resp = await client.get(
            f"/internal/v1/datasets/{ds['id']}/profile", headers=_sem_headers(TENANT_B)
        )
        assert resp.status_code == 404

    async def test_detail_requires_allowed_spiffe(self, client, container):
        ds = await create_dataset(client, name="Orders")
        await _register_version(client, container, ds)
        resp = await client.get(
            f"/internal/v1/datasets/{ds['id']}",
            headers={"x-client-spiffe-id": "spiffe://datacern/ns/x/sa/rogue",
                     "x-datacern-tenant-id": TENANT_A},
        )
        assert resp.status_code == 403

    async def test_detail_requires_tenant_header(self, client, container):
        ds = await create_dataset(client, name="Orders")
        await _register_version(client, container, ds)
        resp = await client.get(
            f"/internal/v1/datasets/{ds['id']}",
            headers={"x-client-spiffe-id": SPIFFE_SEMANTIC},
        )
        assert resp.status_code == 422

    async def test_detail_is_tenant_scoped(self, client, container):
        ds = await create_dataset(client, name="Orders")
        await _register_version(client, container, ds)
        # Correct dataset id but a foreign tenant header -> 404.
        resp = await client.get(
            f"/internal/v1/datasets/{ds['id']}", headers=_sem_headers(TENANT_B)
        )
        assert resp.status_code == 404


class TestInternalOntologyType:
    """WS2: GET /internal/v1/ontology/{workspace}/{key} — the existence check
    semantic-service uses to validate Entity.ontology_entity_key at authoring."""

    async def _declare(self, client, key="vendor", name="Vendor"):
        from tests.conftest import WORKSPACE, auth

        r = await client.post(
            "/api/v1/ontology/entities",
            json={"workspace_id": WORKSPACE, "entity_key": key, "name": name,
                  "attributes": [{"name": "vendor_id", "data_type": "string"},
                                 {"name": "tax_id", "data_type": "string"}]},
            headers=auth(),
        )
        assert r.status_code == 201, r.text
        return WORKSPACE

    async def test_declared_type_exists_with_name(self, client):
        ws = await self._declare(client)
        resp = await client.get(
            f"/internal/v1/ontology/{ws}/vendor", headers=_sem_headers()
        )
        assert resp.status_code == 200
        assert resp.json()["data"] == {
            "exists": True, "name": "Vendor", "attributes": ["vendor_id", "tax_id"],
            # WS4: constraint specs for the binding-contract check.
            "attribute_specs": [
                {"name": "vendor_id", "required": False, "enum": []},
                {"name": "tax_id", "required": False, "enum": []},
            ]}

    async def test_undeclared_type_is_a_definitive_miss_not_an_error(self, client):
        ws = await self._declare(client)
        resp = await client.get(
            f"/internal/v1/ontology/{ws}/mystery", headers=_sem_headers()
        )
        # 200 with exists:false — so the caller can tell "not declared" apart
        # from "registry unreachable" (a transport error).
        assert resp.status_code == 200
        assert resp.json()["data"] == {
            "exists": False, "name": None, "attributes": [], "attribute_specs": []}

    async def test_lookup_is_tenant_scoped(self, client):
        ws = await self._declare(client)
        resp = await client.get(
            f"/internal/v1/ontology/{ws}/vendor", headers=_sem_headers(TENANT_B)
        )
        assert resp.json()["data"]["exists"] is False
