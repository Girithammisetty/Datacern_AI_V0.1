"""ExportRunner: dataset export by DELEGATION to query-service (BRD 74 D1).

There is deliberately no export machine in this service. Datacern already has
one — query-service owns result materialization, the HMAC signing secret, the
signed ``/api/v1/downloads/{token}`` route and the 24h retention GC — so a
dataset export is routed through it instead of duplicated (BRD 74 AC-3).

The real contract, verified against ``services/query-service/internal/api``
rather than the BRD's description of it:

* Export hangs off an **execution**, not a saved query:
  ``POST /api/v1/executions/{id}/export`` — there is no
  ``POST /queries/{id}/export``.
* An ad-hoc ``POST /api/v1/sql/run`` produces a real execution, so no saved
  query row has to be created first.
* Export is **synchronous** (201 with the signed URL); the asynchronous part is
  the execution, which is what this runner polls.
* ``format: "parquet"`` is answered 501 NOT_IMPLEMENTED by query-service today,
  which is why ``csv`` is the only value this service accepts.

Version pinning is expressed through query-service's own dataset macro,
``{{dataset('<name>', version=<n>)}}``: the version number is resolved and
recorded here, and query-service resolves that (tenant, name, version) to the
pinned physical parquet snapshot. The SQL never contains a raw table name.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable

import httpx

from app.domain.ports import DatasetExportJobSpec

logger = logging.getLogger(__name__)

# reporter(spec, result_body) -> None; wired to ExportService.complete.
Reporter = Callable[[DatasetExportJobSpec, dict], Awaitable[None]]

# query-service execution statuses that will never change again
# (internal/domain/types.go).
TERMINAL_STATUSES = frozenset(
    {"succeeded", "failed", "cancelled", "rejected", "ceiling_exceeded"}
)

# Characters that would let a dataset name escape the {{dataset('...')}} macro.
# query-service's parser has no escape sequence — the name is read verbatim up
# to the next single quote — so a name containing one is refused rather than
# mangled.
_UNSAFE_NAME_CHARS = ("'", "\\", "{", "}", "\n", "\r")


class UnsafeDatasetName(ValueError):
    """A dataset name that cannot be expressed in the {{dataset(...)}} macro."""


def build_export_sql(dataset_name: str, version_no: int) -> str:
    """``SELECT * FROM {{dataset('<name>', version=<n>)}}`` — version-pinned.

    query-service replaces the macro with the server-resolved, engine-quoted
    physical identifier for exactly that version, so nothing user-controlled
    reaches the engine as an identifier.
    """
    if not dataset_name or any(c in dataset_name for c in _UNSAFE_NAME_CHARS):
        raise UnsafeDatasetName(
            f"dataset name {dataset_name!r} cannot be referenced in a query "
            "(contains a quote, backslash, brace or newline)"
        )
    if version_no <= 0:
        raise UnsafeDatasetName("version_no must be a positive integer")
    return f"SELECT * FROM {{{{dataset('{dataset_name}', version={version_no})}}}}"


def _error_message(response: httpx.Response) -> str:
    """Pull a message out of the master error envelope, falling back to text."""
    try:
        body = response.json()
    except ValueError:
        return f"HTTP {response.status_code}: {response.text[:200]}"
    err = body.get("error") if isinstance(body, dict) else None
    if isinstance(err, dict):
        code = err.get("code") or response.status_code
        return f"{code}: {err.get('message') or ''}".strip()
    return f"HTTP {response.status_code}: {response.text[:200]}"


class QueryServiceExportRunner:
    """Runs one dataset export against a real query-service over HTTP."""

    def __init__(
        self,
        base_url: str,
        reporter: Reporter,
        *,
        poll_interval_seconds: float = 1.0,
        timeout_seconds: float = 900.0,
        client_factory: Callable[[], httpx.AsyncClient] | None = None,
        sleep=asyncio.sleep,
    ):
        self.base_url = base_url.rstrip("/")
        self.reporter = reporter
        self.poll_interval_seconds = poll_interval_seconds
        self.timeout_seconds = timeout_seconds
        # Public so a deployment (or a contract test) can supply its own client
        # — a shared pool, different timeouts, mesh certs.
        self.client_factory = client_factory
        self._sleep = sleep
        self._tasks: set[asyncio.Task] = set()

    # -- lifecycle ---------------------------------------------------------

    async def launch(self, spec: DatasetExportJobSpec) -> None:
        """Schedule the export without blocking the HTTP request that asked for
        it (the caller already has its 202 + export id)."""
        task = asyncio.create_task(self._drive(spec))
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    async def drain(self) -> None:
        """Await every in-flight export (shutdown + tests)."""
        while self._tasks:
            await asyncio.gather(*list(self._tasks), return_exceptions=True)

    async def _drive(self, spec: DatasetExportJobSpec) -> None:
        try:
            result = await self.run(spec)
        except Exception as exc:  # noqa: BLE001 — an export must always report
            logger.exception("dataset export %s crashed", spec.export_id)
            result = {"status": "failed", "error": str(exc)}
        try:
            await self.reporter(spec, result)
        except Exception:  # noqa: BLE001
            logger.exception("dataset export %s: reporting failed", spec.export_id)

    # -- the real work -----------------------------------------------------

    def _client(self) -> httpx.AsyncClient:
        if self.client_factory is not None:
            return self.client_factory()
        return httpx.AsyncClient(timeout=30)

    async def run(self, spec: DatasetExportJobSpec) -> dict:
        """sql/run → poll the execution → export → signed URL.

        Returns the completion body ExportService.complete consumes:
        ``{status, query_execution_id?, download_url?, expires_at?, row_count?,
        error?}``.
        """
        sql = build_export_sql(spec.dataset_name, spec.version_no)
        headers = {"Authorization": f"Bearer {spec.bearer_token}"}
        if spec.trace_id:
            headers["X-Trace-Id"] = spec.trace_id

        async with self._client() as client:
            run = await client.post(
                f"{self.base_url}/api/v1/sql/run",
                json={"sql": sql, "mode": "async"},
                headers=headers,
            )
            if run.status_code not in (200, 202):
                return {"status": "failed",
                        "error": "query-service rejected the export query: "
                                 + _error_message(run)}
            execution_id = (run.json().get("data") or {}).get("execution_id")
            if not execution_id:
                return {"status": "failed",
                        "error": "query-service returned no execution_id"}

            status, row_count, err = await self._await_execution(
                client, execution_id, headers
            )
            if status != "succeeded":
                return {"status": "failed", "query_execution_id": execution_id,
                        "error": err or f"query execution {status}"}

            exp = await client.post(
                f"{self.base_url}/api/v1/executions/{execution_id}/export",
                json={"format": spec.format},
                headers=headers,
            )
            if exp.status_code != 201:
                return {"status": "failed", "query_execution_id": execution_id,
                        "error": "query-service export failed: " + _error_message(exp)}
            data = exp.json().get("data") or {}
            url = data.get("url") or ""
            if not url:
                return {"status": "failed", "query_execution_id": execution_id,
                        "error": "query-service returned no download url"}
            return {
                "status": "completed",
                "query_execution_id": execution_id,
                # query-service returns a HOST-RELATIVE url; make it usable.
                "download_url": url if url.startswith("http") else self.base_url + url,
                "expires_at": data.get("expires_at"),
                "row_count": row_count,
            }

    async def _await_execution(
        self, client: httpx.AsyncClient, execution_id: str, headers: dict
    ) -> tuple[str, int | None, str | None]:
        deadline = self.timeout_seconds
        waited = 0.0
        while True:
            got = await client.get(
                f"{self.base_url}/api/v1/executions/{execution_id}", headers=headers
            )
            if got.status_code != 200:
                return "failed", None, _error_message(got)
            data = got.json().get("data") or {}
            status = str(data.get("status") or "")
            if status in TERMINAL_STATUSES:
                stats = data.get("stats") or {}
                error = data.get("error")
                if isinstance(error, dict):
                    error = error.get("message") or error.get("code")
                return status, stats.get("result_rows"), error
            if waited >= deadline:
                return "failed", None, (
                    f"timed out after {deadline:.0f}s waiting for query execution "
                    f"{execution_id} (last status {status or 'unknown'})"
                )
            await self._sleep(self.poll_interval_seconds)
            waited += self.poll_interval_seconds
