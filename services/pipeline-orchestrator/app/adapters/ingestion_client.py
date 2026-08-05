"""BRD 73 — the trigger half of a batch job: create an ingestion in
ingestion-service over the internal (SPIFFE-authenticated) service-to-service path.

**Which endpoint, and why this one.** BRD 73's design named
``POST /internal/ingestions``. That endpoint does not exist. ingestion-service's
ingestion-create surfaces are:

* ``POST /api/v1/ingestions`` — the human path. Requires a *user* bearer token
  (``PrincipalDep`` → ``verify_token_async``), which a cron-fired batch job does
  not have and must not mint.
* ``POST /internal/v1/mcp/invoke`` with ``tool_id="ingestion.create"`` — the
  internal path, gated by ``require_internal`` (SPIFFE peer identity injected by
  the mesh after mTLS) and delegating to the *same* ``IngestionService.create``
  the REST route uses. No shadow write path.

So this client speaks the second one. It is a REAL dependency: any non-2xx or
transport failure raises :class:`DependencyUnavailable`, and the batch job run
fails in the ``trigger`` phase — it never fabricates an ingestion id.

**Idempotency.** ``idempotency_key`` is carried into the invoke body and applied
by ingestion-service's own ``run_idempotent`` (the same insert-first
``(tenant_id, key)`` unique-constraint mechanism the REST route uses). That is
what makes a reaper re-drive replay the ORIGINAL ingestion instead of creating a
second one — a duplicated pipeline run wastes compute, a duplicated ingestion
corrupts the data.
"""

from __future__ import annotations

from typing import Any, Protocol, runtime_checkable

import httpx

from app.domain.errors import DependencyUnavailable


@runtime_checkable
class IngestionClient(Protocol):
    async def create_ingestion(self, tenant_id: str, args: dict,
                               *, idempotency_key: str) -> dict:
        """Create (or replay) an ingestion. Returns the ingestion projection,
        which always carries at least ``{"id": ...}``."""
        ...


class HttpIngestionClient:
    """Real client for ingestion-service's internal MCP facade."""

    def __init__(self, base_url: str, spiffe: str, *, timeout: float = 30):
        self._base_url = base_url.rstrip("/")
        self._spiffe = spiffe
        self._timeout = timeout
        # One client (and its connection pool) reused across triggers rather than
        # a fresh TLS handshake per binding.
        self._client: httpx.AsyncClient | None = None

    def _http(self) -> httpx.AsyncClient:
        if self._client is None:
            self._client = httpx.AsyncClient(timeout=self._timeout)
        return self._client

    async def create_ingestion(self, tenant_id: str, args: dict,
                               *, idempotency_key: str) -> dict:
        url = f"{self._base_url}/internal/v1/mcp/invoke"
        body: dict[str, Any] = {
            "tool_id": "ingestion.create",
            "tenant": tenant_id,
            "args": dict(args),
            "idempotency_key": idempotency_key,
        }
        headers = {"x-client-spiffe-id": self._spiffe}
        try:
            resp = await self._http().post(url, json=body, headers=headers)
            resp.raise_for_status()
            payload = resp.json()
        except httpx.HTTPStatusError as exc:
            raise DependencyUnavailable(
                f"ingestion-service returned {exc.response.status_code} for "
                f"ingestion.create: {exc.response.text[:200]}") from exc
        except httpx.HTTPError as exc:
            raise DependencyUnavailable(
                f"ingestion-service unreachable at {self._base_url}: {exc}") from exc
        out = (payload or {}).get("output") or {}
        if out.get("error"):
            raise DependencyUnavailable(
                f"ingestion-service refused ingestion.create: {out['error']}")
        ingestion = out.get("ingestion") or {}
        if not ingestion.get("id"):
            raise DependencyUnavailable(
                "ingestion-service ingestion.create response carried no ingestion id")
        return ingestion
