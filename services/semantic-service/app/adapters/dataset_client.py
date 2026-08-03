"""dataset-service facade (SEM-FR-002 binding validation, sample values).

Runtime: ``HttpDatasetClient`` — a real httpx client that calls dataset-service
over HTTP (SPIFFE identity forwarded by the mesh sidecar after mTLS). Unit tests:
``StaticDatasetClient`` — an in-memory registry double (never reachable from
``app.main`` when ``use_real_adapters`` is True).
"""

from __future__ import annotations

import re

import httpx

# dataset URN shape: wr:<tenant>:dataset:dataset/<dataset_id>
_URN_ID_RE = re.compile(r"dataset/([0-9a-fA-F-]+)$")


class StaticDatasetClient:
    """In-memory dataset registry: register(tenant, urn, table, schema, ...).
    Unit-test double only — NOT wired into the real runtime container."""

    def __init__(self):
        self._datasets: dict[tuple[str, str], dict] = {}
        # WS2: (tenant, workspace) -> declared ontology entity_keys. None as the
        # whole registry simulates an unreachable registry (get returns None).
        self._ontology: dict[tuple[str, str], set[str]] | None = {}

    def register(self, tenant_id: str, dataset_urn: str, *, table: str,
                 schema: dict[str, str], primary_key: list[str] | None = None,
                 top_values: dict[str, list] | None = None) -> None:
        self._datasets[(tenant_id, dataset_urn)] = {
            "exists": True,
            "table": table,
            "schema": schema,
            "primary_key": primary_key or [],
            "top_values": top_values or {},
        }

    async def get_dataset(self, tenant_id: str, dataset_urn: str) -> dict | None:
        return self._datasets.get((tenant_id, dataset_urn))

    def register_ontology_type(self, tenant_id: str, workspace_id: str, entity_key: str) -> None:
        assert self._ontology is not None
        self._ontology.setdefault((tenant_id, workspace_id), set()).add(entity_key)

    def simulate_ontology_outage(self) -> None:
        self._ontology = None

    async def get_ontology_type(
        self, tenant_id: str, workspace_id: str, entity_key: str
    ) -> bool | None:
        if self._ontology is None:
            return None  # registry unreachable -> caller fails soft
        return entity_key in self._ontology.get((tenant_id, workspace_id), set())


class HttpDatasetClient:
    """Real dataset-service client (SEM-FR-002). Resolves the dataset id from the
    URN and GETs its metadata + latest-version schema/profile, projecting the
    response into the ``{exists, table, schema, primary_key, top_values}`` shape
    the semantic layer's binding validation consumes. Returns None on 404 so a
    missing binding is reported as a validation problem, not a hard error."""

    def __init__(
        self,
        base_url: str = "http://localhost:8083",
        *,
        spiffe_id: str = "spiffe://datacern/ns/data/sa/semantic-service",
        spiffe_header: str = "x-client-spiffe-id",
        timeout_s: float = 5.0,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.spiffe_id = spiffe_id
        self.spiffe_header = spiffe_header
        self.timeout_s = timeout_s
        # Reuse one client (and its TCP+TLS connection pool) across calls rather
        # than paying a fresh handshake per request.
        self._client: httpx.AsyncClient | None = None

    def _http(self) -> httpx.AsyncClient:
        if self._client is None:
            self._client = httpx.AsyncClient(timeout=self.timeout_s)
        return self._client

    @staticmethod
    def _dataset_id(dataset_urn: str) -> str | None:
        m = _URN_ID_RE.search(dataset_urn or "")
        return m.group(1) if m else None

    def _headers(self, tenant_id: str) -> dict[str, str]:
        return {
            self.spiffe_header: self.spiffe_id,
            "x-datacern-tenant-id": tenant_id,
            "accept": "application/json",
        }

    async def get_dataset(self, tenant_id: str, dataset_urn: str) -> dict | None:
        dataset_id = self._dataset_id(dataset_urn)
        if dataset_id is None:
            return None
        headers = self._headers(tenant_id)
        client = self._http()
        resp = await client.get(
            f"{self.base_url}/internal/v1/datasets/{dataset_id}", headers=headers)
        if resp.status_code == 404:
            return None
        resp.raise_for_status()
        body = resp.json().get("data", resp.json())
        # Latest-version profile carries column schema + top values.
        profile_resp = await client.get(
            f"{self.base_url}/internal/v1/datasets/{dataset_id}/profile",
            headers=headers)
        profile = (
            profile_resp.json().get("data", {})
            if profile_resp.status_code == 200 else {}
        )
        schema = body.get("schema") or profile.get("schema") or {}
        return {
            "exists": True,
            "table": body.get("physical_table") or body.get("table") or "",
            "schema": schema,
            "primary_key": body.get("primary_key") or [],
            "top_values": profile.get("top_values") or {},
        }

    async def get_ontology_type(
        self, tenant_id: str, workspace_id: str, entity_key: str
    ) -> bool | None:
        """WS2: does the workspace's governed ontology declare ``entity_key``?
        True/False from a definitive registry answer; None when the registry is
        unreachable — the caller fails SOFT (the link is optional metadata, so an
        outage must not block authoring), while a definitive miss fails the
        save."""
        try:
            resp = await self._http().get(
                f"{self.base_url}/internal/v1/ontology/{workspace_id}/{entity_key}",
                headers=self._headers(tenant_id),
            )
            if resp.status_code != 200:
                return None
            return bool(resp.json().get("data", {}).get("exists"))
        except httpx.HTTPError:
            return None
