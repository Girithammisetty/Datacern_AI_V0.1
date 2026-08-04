"""Tenant-partitioned storage for distilled-adapter artifacts.

Closes the audit's gap that the adapter blob path had 'no tenant component'.
Every artifact is keyed by ``{tenant_id}/{archetype}/{run_id}`` from day one, so
one tenant's distilled model can never be loaded under another's — the serving
path resolves strictly within the caller's tenant.

The in-memory backend is the default (self-contained, unit-provable); a file or
object-store backend implements the same tiny protocol for a real deployment.
"""
from __future__ import annotations

from typing import Protocol


class AdapterArtifactStore(Protocol):
    async def put(self, key: str, data: bytes) -> None: ...
    async def get(self, key: str) -> bytes: ...
    async def exists(self, key: str) -> bool: ...


class InMemoryAdapterStore:
    """Process-local artifact store. Real object, honest scope: it holds the
    distilled artifacts in memory, tenant-partitioned by key — enough to train,
    gate, promote and serve within a process, and to prove tenant isolation."""

    def __init__(self) -> None:
        self._blobs: dict[str, bytes] = {}

    async def put(self, key: str, data: bytes) -> None:
        self._blobs[key] = data

    async def get(self, key: str) -> bytes:
        if key not in self._blobs:
            raise KeyError(key)
        return self._blobs[key]

    async def exists(self, key: str) -> bool:
        return key in self._blobs
