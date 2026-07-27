"""DatasetReader: a read-from-warehouse node materializes an uploaded dataset's rows
at run time. URN->id parsing, the in-memory + HTTP adapters, and the _assemble_rows
fallback that feeds those rows into the training spec."""

from __future__ import annotations

from types import SimpleNamespace

import httpx
import pytest

from app.adapters import dataset_reader as dr
from app.adapters.dataset_reader import (
    HttpDatasetReader,
    InMemoryDatasetReader,
    dataset_id_from_urn,
)
from app.domain.errors import DependencyUnavailable
from app.domain.params import validate_params
from tests.conftest import TENANT_A

URN = "wr:t:dataset:dataset/ds-42"


# ---- pure URN parsing ------------------------------------------------------

def test_dataset_id_from_urn_extracts_last_segment():
    assert dataset_id_from_urn(URN) == "ds-42"
    assert dataset_id_from_urn("wr:tenant-9:dataset:dataset/abc/def") == "def"


@pytest.mark.parametrize("bad", ["", "nodashes", "wr:t:dataset:dataset/"])
def test_dataset_id_from_urn_rejects_malformed(bad):
    with pytest.raises(ValueError):
        dataset_id_from_urn(bad)


# ---- in-memory adapter -----------------------------------------------------

async def test_in_memory_reader_returns_seeded_and_empty_for_unknown():
    reader = InMemoryDatasetReader({URN: [{"amount": 1}, {"amount": 2}]})
    assert await reader.read_rows(TENANT_A, URN) == [{"amount": 1}, {"amount": 2}]
    assert await reader.read_rows(TENANT_A, "wr:t:dataset:dataset/missing") == []


async def test_in_memory_reader_respects_limit():
    reader = InMemoryDatasetReader({URN: [{"i": i} for i in range(5)]})
    assert await reader.read_rows(TENANT_A, URN, limit=2) == [{"i": 0}, {"i": 1}]


# ---- HTTP adapter (mocked transport, no live server) -----------------------

def _patch_transport(monkeypatch, handler):
    transport = httpx.MockTransport(handler)
    orig = httpx.AsyncClient

    def factory(*a, **kw):
        kw["transport"] = transport
        return orig(*a, **kw)

    monkeypatch.setattr(dr.httpx, "AsyncClient", factory)


async def test_http_reader_parses_urn_sends_headers_returns_rows(monkeypatch):
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        seen["spiffe"] = request.headers.get("x-client-spiffe-id")
        seen["tenant"] = request.headers.get("x-datacern-tenant-id")
        seen["limit"] = request.url.params.get("limit")
        return httpx.Response(
            200, json={"data": {"columns": ["amount", "prior"],
                                 "rows": [{"amount": 100, "prior": 2}]}})

    _patch_transport(monkeypatch, handler)
    reader = HttpDatasetReader("http://localhost:8304",
                               "spiffe://datacern/ns/data/sa/pipeline-orchestrator")
    rows = await reader.read_rows(TENANT_A, URN, limit=500)

    assert rows == [{"amount": 100, "prior": 2}]
    assert seen["url"].startswith(
        "http://localhost:8304/internal/v1/datasets/ds-42/rows")
    assert seen["spiffe"] == "spiffe://datacern/ns/data/sa/pipeline-orchestrator"
    assert seen["tenant"] == TENANT_A
    assert seen["limit"] == "500"


async def test_http_reader_raises_on_non_200(monkeypatch):
    _patch_transport(monkeypatch,
                     lambda req: httpx.Response(404, json={"error": "no dataset"}))
    reader = HttpDatasetReader("http://localhost:8304", "spiffe://x")
    with pytest.raises(DependencyUnavailable):
        await reader.read_rows(TENANT_A, URN)


async def test_http_reader_raises_on_connection_error(monkeypatch):
    def handler(req):
        raise httpx.ConnectError("refused")

    _patch_transport(monkeypatch, handler)
    reader = HttpDatasetReader("http://localhost:8304", "spiffe://x")
    with pytest.raises(DependencyUnavailable):
        await reader.read_rows(TENANT_A, URN)


# ---- _assemble_rows fallback -----------------------------------------------

async def test_assemble_rows_uses_dataset_reader_when_no_labels(container):
    container.deps.dataset_reader = InMemoryDatasetReader(
        {URN: [{"amount": 100, "prior": 2}, {"amount": 9000, "prior": 5}]})
    version = SimpleNamespace(definition={
        "nodes": [{"alias": "read-1", "component": "read-from-warehouse",
                   "parameters": {"dataset": URN}}]})
    run = SimpleNamespace(run_parameters={})

    rows, cols = await container.run_service._assemble_rows(
        TENANT_A, run, version, "label")

    assert rows == [{"amount": 100, "prior": 2}, {"amount": 9000, "prior": 5}]
    assert cols == ["amount", "prior"]


async def test_assemble_rows_prefers_training_data_over_reader(container):
    # An inline training_data param takes precedence; the reader is not consulted.
    container.deps.dataset_reader = InMemoryDatasetReader(
        {URN: [{"amount": 1, "label": "y"}]})
    version = SimpleNamespace(definition={
        "nodes": [{"component": "read-from-warehouse", "parameters": {"dataset": URN}}]})
    run = SimpleNamespace(run_parameters={"training_data": [{"amount": 7, "label": "x"}]})

    rows, cols = await container.run_service._assemble_rows(
        TENANT_A, run, version, "label")

    assert rows == [{"amount": 7, "label": "x"}]
    assert cols == ["amount"]


# ---- params.py dataset_ref validation --------------------------------------

def _schema():
    return {"dataset": {"type": "dataset_ref", "required": True}}


def test_dataset_ref_accepts_valid_urn():
    items = validate_params("read-1", {"dataset": URN}, _schema(),
                            model_type=None, require_present=True)
    assert items == []


def test_dataset_ref_rejects_non_urn_string():
    items = validate_params("read-1", {"dataset": "just-a-name"}, _schema(),
                            model_type=None, require_present=True)
    assert any(i["code"] == "DATASET_REF_INVALID" for i in items)


def test_dataset_ref_rejects_empty():
    items = validate_params("read-1", {"dataset": ""}, _schema(),
                            model_type=None, require_present=True)
    assert items and items[0]["field"] == "parameters.dataset"


# ---- row budget: refuse rather than silently truncate -----------------------

def _read_node_version(ram_gb: int | None = None):
    node = {"alias": "read-1", "component": "read-from-warehouse",
            "parameters": {"dataset": URN}}
    if ram_gb is not None:
        node["resources"] = {"cpus": 1, "ram_gb": ram_gb, "timeout_minutes": 30}
    return SimpleNamespace(definition={"nodes": [node], "edges": []})


async def test_oversized_dataset_is_refused_not_silently_truncated(container):
    """The defect this guards: read_rows' limit defaults to 10_000, so a dataset
    larger than that used to train on its first 10_000 rows while MLflow recorded
    n_rows=10000 and the promotion approval described a model nobody could tell
    was fitted to a sliver of the data."""
    from app.domain.errors import TrainingDataExceedsBudget
    from app.domain.resources import training_row_budget

    budget = training_row_budget(2)  # the 2 GB default
    oversized = [{"amount": i, "label": "y"} for i in range(budget + 5)]
    container.deps.dataset_reader = InMemoryDatasetReader({URN: oversized})
    run = SimpleNamespace(run_parameters={})

    with pytest.raises(TrainingDataExceedsBudget) as ei:
        await container.run_service._assemble_rows(
            TENANT_A, run, _read_node_version(), "label")

    # The message has to be actionable: what it found, what it allows, and the
    # two legitimate ways forward.
    assert ei.value.details["row_budget"] == budget
    assert ei.value.details["rows"] > budget
    assert "ram_gb" in ei.value.message and "sample upstream" in ei.value.message


async def test_dataset_exactly_at_budget_is_accepted(container):
    """Off-by-one guard: the reader is asked for budget+1 rows precisely so
    "exactly fits" can be told apart from "there is more we cannot see"."""
    from app.domain.resources import training_row_budget

    budget = training_row_budget(2)
    exact = [{"amount": i, "label": "y"} for i in range(budget)]
    container.deps.dataset_reader = InMemoryDatasetReader({URN: exact})
    run = SimpleNamespace(run_parameters={})

    rows, cols = await container.run_service._assemble_rows(
        TENANT_A, run, _read_node_version(), "label")

    assert len(rows) == budget
    assert cols == ["amount"]


async def test_a_bigger_node_buys_a_bigger_budget(container):
    """The resource model finally does something on the local backend: the same
    dataset that a 2 GB node refuses is accepted by a node declared larger."""
    from app.domain.resources import training_row_budget

    rows_n = training_row_budget(2) + 100
    data = [{"amount": i, "label": "y"} for i in range(rows_n)]
    container.deps.dataset_reader = InMemoryDatasetReader({URN: data})
    run = SimpleNamespace(run_parameters={})

    rows, _ = await container.run_service._assemble_rows(
        TENANT_A, run, _read_node_version(ram_gb=4), "label")

    assert len(rows) == rows_n


async def test_oversized_inline_training_data_is_refused(container):
    from app.domain.errors import TrainingDataExceedsBudget
    from app.domain.resources import training_row_budget

    budget = training_row_budget(2)
    run = SimpleNamespace(run_parameters={
        "training_data": [{"amount": i, "label": "y"} for i in range(budget + 1)]})

    with pytest.raises(TrainingDataExceedsBudget) as ei:
        await container.run_service._assemble_rows(
            TENANT_A, run, _read_node_version(), "label")

    assert ei.value.details["source"] == "training_data parameter"


def test_row_budget_scales_with_declared_ram():
    from app.domain.resources import PLATFORM_CEILING, training_row_budget

    assert training_row_budget(4) == 2 * training_row_budget(2)
    # Never zero: a node clamped to the floor still gets a usable budget.
    assert training_row_budget(0) >= 1
    assert training_row_budget(PLATFORM_CEILING["ram_gb"]) > training_row_budget(2)
