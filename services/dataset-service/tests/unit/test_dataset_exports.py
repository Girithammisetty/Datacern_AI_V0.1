"""Unit: dataset export by delegation to query-service (BRD 74 D1, AC-1..AC-3).

Two tiers here:

* the RUNNER is driven against an ``httpx.MockTransport`` that implements
  query-service's ACTUAL export contract (``POST /api/v1/sql/run`` → poll
  ``GET /api/v1/executions/{id}`` → ``POST /api/v1/executions/{id}/export`` →
  a signed ``/api/v1/downloads/{token}`` URL). Per CONVENTIONS.md cross-service
  calls in tests use a contract fake, never a live service.
* the SERVICE/API tier uses a recording runner so the operation lifecycle,
  authorization and tenant isolation are tested without any HTTP at all.

The contract fake below mirrors what was read out of
``services/query-service/internal/api/handlers_executions.go`` — including the
facts the BRD got wrong: export hangs off an EXECUTION (not
``POST /queries/{id}/export``), it is synchronous with a 201, and `parquet`
answers 501.
"""

from __future__ import annotations

import httpx
import pandas as pd
import pytest

from app.adapters.query_export import (
    QueryServiceExportRunner,
    UnsafeDatasetName,
    build_export_sql,
)
from app.container import build_container
from app.domain.ports import DatasetExportJobSpec
from app.main import create_app
from tests.conftest import (
    SPIFFE_INGESTION,
    TENANT_A,
    TENANT_B,
    auth,
    create_dataset,
    make_settings,
)

QS_URL = "http://query-service:8085"

DF = pd.DataFrame({"order_id": [1, 2, 3], "total": [10.0, 20.0, 30.0]})


# --------------------------------------------------------------------------
# query-service contract fake


class FakeQueryService:
    """Implements query-service's real export routes over httpx.MockTransport."""

    def __init__(self, *, run_status=202, statuses=("succeeded",), export_status=201,
                 export_error_code="NOT_IMPLEMENTED"):
        self.run_status = run_status
        self.statuses = list(statuses)
        self.export_status = export_status
        self.export_error_code = export_error_code
        self.sql_seen: list[str] = []
        self.tokens_seen: list[str] = []
        self.export_formats: list[str] = []
        self.poll_count = 0

    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self._handle)

    def client(self) -> httpx.AsyncClient:
        return httpx.AsyncClient(transport=self.transport())

    def _handle(self, request: httpx.Request) -> httpx.Response:
        self.tokens_seen.append(request.headers.get("authorization", ""))
        path = request.url.path
        if path == "/api/v1/sql/run" and request.method == "POST":
            import json as _json

            body = _json.loads(request.content)
            self.sql_seen.append(body["sql"])
            if self.run_status not in (200, 202):
                return httpx.Response(self.run_status, json={
                    "error": {"code": "PERMISSION_DENIED", "message": "not permitted"}})
            return httpx.Response(202, json={"data": {
                "execution_id": "exec-1", "status": "queued"}})
        if path == "/api/v1/executions/exec-1" and request.method == "GET":
            self.poll_count += 1
            status = self.statuses[min(self.poll_count - 1, len(self.statuses) - 1)]
            data = {"execution_id": "exec-1", "status": status,
                    "stats": {"result_rows": 3}}
            if status == "failed":
                data["error"] = {"code": "ENGINE_ERROR", "message": "boom"}
            return httpx.Response(200, json={"data": data})
        if path == "/api/v1/executions/exec-1/export" and request.method == "POST":
            import json as _json

            self.export_formats.append(_json.loads(request.content)["format"])
            if self.export_status != 201:
                return httpx.Response(self.export_status, json={"error": {
                    "code": self.export_error_code,
                    "message": "parquet export pending; use csv"}})
            return httpx.Response(201, json={"data": {
                "format": "csv",
                "url": "/api/v1/downloads/eyJ0Ijoi.c2ln",
                "expires_at": "2026-08-06T05:00:00Z"}})
        return httpx.Response(404, json={"error": {"code": "NOT_FOUND", "message": path}})


def _spec(**over) -> DatasetExportJobSpec:
    base = dict(
        tenant_id=TENANT_A, export_id="exp-1", dataset_id="ds-1",
        dataset_name="Orders", version_no=2, format="csv",
        bearer_token="tok-abc", actor={"type": "user", "id": "user-1"},
        trace_id="trace-1",
    )
    base.update(over)
    return DatasetExportJobSpec(**base)


def _runner(qs: FakeQueryService, reporter=None) -> QueryServiceExportRunner:
    async def _noop(spec, body):
        return None

    return QueryServiceExportRunner(
        QS_URL, reporter or _noop, poll_interval_seconds=0,
        timeout_seconds=5, client_factory=qs.client,
    )


# --------------------------------------------------------------------------
# SQL construction


class TestExportSql:
    def test_sql_is_version_pinned(self):
        """AC-1: the query names the VERSION, not just the dataset."""
        assert build_export_sql("Orders", 3) == (
            "SELECT * FROM {{dataset('Orders', version=3)}}"
        )

    @pytest.mark.parametrize("name", ["it's", "a\\b", "x{{y", "no}}", "a\nb", ""])
    def test_unsafe_names_are_refused(self, name):
        """query-service's macro parser has no escape sequence — a name that
        could break out of the quotes is refused, never mangled into SQL."""
        with pytest.raises(UnsafeDatasetName):
            build_export_sql(name, 1)

    def test_non_positive_version_refused(self):
        with pytest.raises(UnsafeDatasetName):
            build_export_sql("Orders", 0)


# --------------------------------------------------------------------------
# The runner against the query-service contract


class TestExportRunner:
    async def test_happy_path_returns_query_services_signed_url(self):
        """AC-3: the artifact URL is query-service's signed link, made absolute —
        dataset-service mints no signature and stores no bytes."""
        qs = FakeQueryService(statuses=("running", "succeeded"))
        result = await _runner(qs).run(_spec())
        assert result["status"] == "completed"
        assert result["query_execution_id"] == "exec-1"
        assert result["download_url"] == QS_URL + "/api/v1/downloads/eyJ0Ijoi.c2ln"
        assert result["expires_at"] == "2026-08-06T05:00:00Z"
        assert result["row_count"] == 3
        assert qs.sql_seen == ["SELECT * FROM {{dataset('Orders', version=2)}}"]
        assert qs.export_formats == ["csv"]

    async def test_caller_token_is_forwarded(self):
        """query-service re-authorizes under the SAME user, so the caller's
        bearer token must reach every call."""
        qs = FakeQueryService()
        await _runner(qs).run(_spec(bearer_token="tok-xyz"))
        assert qs.tokens_seen
        assert all(t == "Bearer tok-xyz" for t in qs.tokens_seen)

    async def test_failed_execution_is_reported_not_swallowed(self):
        qs = FakeQueryService(statuses=("running", "failed"))
        result = await _runner(qs).run(_spec())
        assert result["status"] == "failed"
        assert result["query_execution_id"] == "exec-1"
        assert "boom" in result["error"]

    async def test_rejected_run_is_reported(self):
        qs = FakeQueryService(run_status=403)
        result = await _runner(qs).run(_spec())
        assert result["status"] == "failed"
        assert "PERMISSION_DENIED" in result["error"]

    async def test_query_service_export_error_is_surfaced(self):
        """query-service answers parquet with 501; the runner reports it rather
        than inventing a local parquet writer."""
        qs = FakeQueryService(export_status=501)
        result = await _runner(qs).run(_spec(format="parquet"))
        assert result["status"] == "failed"
        assert "NOT_IMPLEMENTED" in result["error"]

    async def test_timeout_fails_the_export(self):
        qs = FakeQueryService(statuses=("running",))
        runner = QueryServiceExportRunner(
            QS_URL, _noop_reporter, poll_interval_seconds=1, timeout_seconds=2,
            client_factory=qs.client, sleep=_instant_sleep,
        )
        result = await runner.run(_spec())
        assert result["status"] == "failed"
        assert "timed out" in result["error"]

    async def test_launch_runs_in_background_and_reports(self):
        qs = FakeQueryService()
        reported: list[dict] = []

        async def reporter(spec, body):
            reported.append(body)

        runner = _runner(qs, reporter)
        await runner.launch(_spec())
        await runner.drain()
        assert len(reported) == 1
        assert reported[0]["status"] == "completed"

    async def test_launch_reports_failure_when_the_run_crashes(self):
        """A crash must still produce a terminal report — an export never hangs
        in `pending` because of an unexpected exception."""
        reported: list[dict] = []

        async def reporter(spec, body):
            reported.append(body)

        def exploding_client():
            raise RuntimeError("connection refused")

        runner = QueryServiceExportRunner(
            QS_URL, reporter, client_factory=exploding_client
        )
        await runner.launch(_spec())
        await runner.drain()
        assert reported[0]["status"] == "failed"
        assert "connection refused" in reported[0]["error"]


async def _noop_reporter(spec, body):
    return None


async def _instant_sleep(_seconds):
    return None


# --------------------------------------------------------------------------
# Service + API tier


class RecordingExportRunner:
    def __init__(self):
        self.specs: list[DatasetExportJobSpec] = []

    async def launch(self, spec):
        self.specs.append(spec)


@pytest.fixture
def export_runner():
    return RecordingExportRunner()


@pytest.fixture
def export_container(tmp_path, clock, export_runner):
    return build_container(
        make_settings(tmp_path), mode="memory", clock=clock,
        export_runner=export_runner,
    )


@pytest.fixture
async def export_client(export_container):
    transport = httpx.ASGITransport(app=create_app(export_container))
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
        yield c


async def _seed_versioned_dataset(client, container, name="Orders", versions=1):
    ds = await create_dataset(client, name=name)
    for i in range(versions):
        snapshot = 2000 + i
        await container.catalog.commit_snapshot(ds["iceberg_table"], snapshot, DF)
        resp = await client.post(
            f"/internal/v1/datasets/{ds['id']}/versions",
            json={
                "tenant_id": TENANT_A,
                "iceberg_snapshot_id": snapshot,
                "schema": {c: {"type": "string", "nullable": True, "tags": []}
                           for c in DF.columns},
                "row_count": len(DF), "bytes": 512,
                "produced_by_urn": f"wr:{TENANT_A}:ingestion:ingestion/i-{snapshot}",
                "skip_profiling": True,
            },
            headers={"x-client-spiffe-id": SPIFFE_INGESTION},
        )
        assert resp.status_code == 201, resp.text
    return ds


class TestExportApi:
    async def test_export_pins_the_current_version(
        self, export_client, export_container, export_runner
    ):
        """AC-1: exporting a dataset exports a VERSION, and the operation records
        which one — including in its URN."""
        ds = await _seed_versioned_dataset(export_client, export_container, versions=2)
        resp = await export_client.post(
            f"/api/v1/datasets/{ds['id']}/exports", json={"format": "csv"},
            headers=auth(TENANT_A),
        )
        assert resp.status_code == 202, resp.text
        data = resp.json()["data"]
        assert data["status"] == "pending"
        assert data["version_no"] == 2
        assert data["version_urn"].endswith("@v2")
        assert data["format"] == "csv"
        assert data["operation_id"] == data["id"]
        # The launched job carries the pinned version + the caller's token.
        assert len(export_runner.specs) == 1
        spec = export_runner.specs[0]
        assert spec.version_no == 2
        assert spec.dataset_name == "Orders"
        assert spec.bearer_token

    async def test_explicit_version_is_honoured(
        self, export_client, export_container, export_runner
    ):
        ds = await _seed_versioned_dataset(export_client, export_container, versions=2)
        resp = await export_client.post(
            f"/api/v1/datasets/{ds['id']}/exports", json={"version": 1},
            headers=auth(TENANT_A),
        )
        assert resp.status_code == 202, resp.text
        assert resp.json()["data"]["version_no"] == 1
        assert export_runner.specs[0].version_no == 1

    async def test_unknown_version_is_404(self, export_client, export_container):
        ds = await _seed_versioned_dataset(export_client, export_container)
        resp = await export_client.post(
            f"/api/v1/datasets/{ds['id']}/exports", json={"version": 99},
            headers=auth(TENANT_A),
        )
        assert resp.status_code == 404

    async def test_dataset_without_a_version_is_422(self, export_client):
        ds = await create_dataset(export_client, name="Empty")
        resp = await export_client.post(
            f"/api/v1/datasets/{ds['id']}/exports", json={}, headers=auth(TENANT_A)
        )
        assert resp.status_code == 422
        assert "no registered version" in resp.json()["error"]["message"]

    async def test_parquet_is_refused_with_the_real_reason(
        self, export_client, export_container, export_runner
    ):
        """No second export machine (AC-3): query-service does not implement
        parquet, so this is an honest 422, not a locally-written parquet file."""
        ds = await _seed_versioned_dataset(export_client, export_container)
        resp = await export_client.post(
            f"/api/v1/datasets/{ds['id']}/exports", json={"format": "parquet"},
            headers=auth(TENANT_A),
        )
        assert resp.status_code == 422
        assert "parquet" in resp.json()["error"]["message"]
        assert export_runner.specs == []

    async def test_concurrency_cap(self, export_client, export_container):
        ds = await _seed_versioned_dataset(export_client, export_container)
        cap = export_container.settings.export_max_concurrent_per_dataset
        for _ in range(cap):
            r = await export_client.post(
                f"/api/v1/datasets/{ds['id']}/exports", json={},
                headers=auth(TENANT_A),
            )
            assert r.status_code == 202, r.text
        resp = await export_client.post(
            f"/api/v1/datasets/{ds['id']}/exports", json={}, headers=auth(TENANT_A)
        )
        assert resp.status_code == 429

    async def test_requires_the_export_action(self, export_client, export_container):
        ds = await _seed_versioned_dataset(export_client, export_container)
        resp = await export_client.post(
            f"/api/v1/datasets/{ds['id']}/exports", json={},
            headers=auth(TENANT_A, scopes=["dataset.dataset.read"]),
        )
        assert resp.status_code == 403

    async def test_cross_tenant_dataset_is_404(self, export_client, export_container):
        """AC-2."""
        ds = await _seed_versioned_dataset(export_client, export_container)
        resp = await export_client.post(
            f"/api/v1/datasets/{ds['id']}/exports", json={}, headers=auth(TENANT_B)
        )
        assert resp.status_code == 404
        assert resp.json()["error"]["code"] == "NOT_FOUND"

    async def test_cross_tenant_export_id_is_404(self, export_client, export_container):
        """AC-2: another tenant cannot read the export operation either."""
        ds = await _seed_versioned_dataset(export_client, export_container)
        created = await export_client.post(
            f"/api/v1/datasets/{ds['id']}/exports", json={}, headers=auth(TENANT_A)
        )
        export_id = created.json()["data"]["id"]
        mine = await export_client.get(
            f"/api/v1/exports/{export_id}", headers=auth(TENANT_A)
        )
        assert mine.status_code == 200
        theirs = await export_client.get(
            f"/api/v1/exports/{export_id}", headers=auth(TENANT_B)
        )
        assert theirs.status_code == 404
        assert theirs.json()["error"]["code"] == "NOT_FOUND"

    async def test_unknown_export_id_is_404(self, export_client):
        resp = await export_client.get(
            "/api/v1/exports/019000aa-0000-7000-8000-000000000000",
            headers=auth(TENANT_A),
        )
        assert resp.status_code == 404


class TestExportCompletion:
    async def test_completion_records_url_and_emits_event(
        self, export_client, export_container
    ):
        ds = await _seed_versioned_dataset(export_client, export_container)
        created = await export_client.post(
            f"/api/v1/datasets/{ds['id']}/exports", json={}, headers=auth(TENANT_A)
        )
        export_id = created.json()["data"]["id"]
        spec = export_container.export_runner.specs[0]
        await export_container.export_service.complete(
            _ctx(spec), export_id,
            {"status": "completed", "query_execution_id": "exec-9",
             "download_url": QS_URL + "/api/v1/downloads/tok",
             "expires_at": "2026-08-06T05:00:00Z", "row_count": 3},
        )
        resp = await export_client.get(
            f"/api/v1/exports/{export_id}", headers=auth(TENANT_A)
        )
        data = resp.json()["data"]
        assert data["status"] == "completed"
        assert data["download_url"] == QS_URL + "/api/v1/downloads/tok"
        assert data["expires_at"].startswith("2026-08-06T05:00:00")
        assert data["row_count"] == 3
        assert data["query_execution_id"] == "exec-9"
        events = export_container.memory_state.events_of_type("dataset.export.completed")
        assert len(events) == 1
        assert events[0]["payload"]["version_no"] == 1

    async def test_failure_is_recorded(self, export_client, export_container):
        ds = await _seed_versioned_dataset(export_client, export_container)
        created = await export_client.post(
            f"/api/v1/datasets/{ds['id']}/exports", json={}, headers=auth(TENANT_A)
        )
        export_id = created.json()["data"]["id"]
        spec = export_container.export_runner.specs[0]
        await export_container.export_service.complete(
            _ctx(spec), export_id, {"status": "failed", "error": "engine down"}
        )
        data = (await export_client.get(
            f"/api/v1/exports/{export_id}", headers=auth(TENANT_A))).json()["data"]
        assert data["status"] == "failed"
        assert data["error"] == "engine down"
        assert export_container.memory_state.events_of_type("dataset.export.failed")

    async def test_completion_is_idempotent(self, export_client, export_container):
        """A redelivered/duplicated report cannot rewrite a terminal export."""
        ds = await _seed_versioned_dataset(export_client, export_container)
        created = await export_client.post(
            f"/api/v1/datasets/{ds['id']}/exports", json={}, headers=auth(TENANT_A)
        )
        export_id = created.json()["data"]["id"]
        spec = export_container.export_runner.specs[0]
        body = {"status": "completed", "download_url": QS_URL + "/api/v1/downloads/t1"}
        await export_container.export_service.complete(_ctx(spec), export_id, body)
        await export_container.export_service.complete(
            _ctx(spec), export_id, {"status": "failed", "error": "late failure"}
        )
        data = (await export_client.get(
            f"/api/v1/exports/{export_id}", headers=auth(TENANT_A))).json()["data"]
        assert data["status"] == "completed"
        assert data["error"] is None
        assert len(
            export_container.memory_state.events_of_type("dataset.export.completed")
        ) == 1


def _ctx(spec):
    from app.domain.services import CallCtx

    return CallCtx(tenant_id=spec.tenant_id, actor=spec.actor, trace_id=spec.trace_id)


class TestExportEndToEndThroughRealRunner:
    """POST → the REAL QueryServiceExportRunner drives the query-service contract
    fake → GET shows completed with query-service's signed URL. This is the
    whole D1 path with nothing faked but the remote service."""

    async def test_full_round_trip(self, tmp_path, clock):
        qs = FakeQueryService(statuses=("running", "succeeded"))
        settings = make_settings(tmp_path)
        container = build_container(settings, mode="memory", clock=clock)
        container.export_runner.client_factory = qs.client
        container.export_runner.poll_interval_seconds = 0
        transport = httpx.ASGITransport(app=create_app(container))
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
            ds = await _seed_versioned_dataset(c, container, name="Claims")
            created = await c.post(
                f"/api/v1/datasets/{ds['id']}/exports", json={"format": "csv"},
                headers=auth(TENANT_A),
            )
            assert created.status_code == 202, created.text
            export_id = created.json()["data"]["id"]
            await container.export_runner.drain()

            data = (await c.get(
                f"/api/v1/exports/{export_id}", headers=auth(TENANT_A))).json()["data"]

        assert data["status"] == "completed"
        assert data["version_no"] == 1
        # The URL is query-service's own signed link, prefixed with the
        # configured query-service base (it is returned host-relative).
        assert data["download_url"] == (
            settings.query_service_url + "/api/v1/downloads/eyJ0Ijoi.c2ln"
        )
        assert data["row_count"] == 3
        # AC-1: the SQL query-service actually received was version-pinned.
        assert qs.sql_seen == ["SELECT * FROM {{dataset('Claims', version=1)}}"]
