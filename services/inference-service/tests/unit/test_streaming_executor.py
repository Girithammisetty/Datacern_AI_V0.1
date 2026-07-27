"""LocalScoringExecutor streams: the job's memory tracks the chunk size, not the
dataset size (INF-FR-004/040).

No MinIO and no MLflow here — a fake S3 client that honours HTTP ranges and a
stub pyfunc model are enough to prove the properties that matter: the input is
never materialized whole, predict is never handed more than a chunk, and the
parts read back as exactly the input rows in order.
"""

from __future__ import annotations

import io
import types
from types import SimpleNamespace

import numpy as np
import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq
import pytest

from app.adapters import executor as ex_mod
from app.adapters.executor import (
    DEFAULT_CHUNK_ROWS,
    LocalScoringExecutor,
    _chunk_rows,
    _S3RangeReader,
)
from app.domain.ports import ResolvedDataset, ResolvedModel

BUCKET = "datacern-datasets"
IN_KEY = "inputs/txn.parquet"


class FakeS3:
    """In-memory S3 with real Range semantics, so the reader is exercised the way
    MinIO would exercise it."""

    def __init__(self, objects: dict[str, bytes] | None = None):
        self.objects = dict(objects or {})
        self.range_lengths: list[int] = []

    def head_object(self, *, Bucket, Key):
        return {"ContentLength": len(self.objects[Key])}

    def get_object(self, *, Bucket, Key, Range=None):
        blob = self.objects[Key]
        if Range:
            start, _, end = Range.removeprefix("bytes=").partition("-")
            blob = blob[int(start):int(end) + 1]  # inclusive on both ends
            self.range_lengths.append(len(blob))
        return {"Body": io.BytesIO(blob)}

    def put_object(self, *, Bucket, Key, Body, ContentType=None):
        self.objects[Key] = Body

    def list_objects_v2(self, *, Bucket, Prefix):
        return {"Contents": [{"Key": k} for k in sorted(self.objects) if k.startswith(Prefix)]}


def _parquet_bytes(n_rows: int, row_group_size: int = 64) -> bytes:
    df = pd.DataFrame({"amount": np.arange(n_rows, dtype="float64"),
                       "age": np.arange(n_rows, dtype="int64") % 60 + 20})
    buf = io.BytesIO()
    pq.write_table(pa.Table.from_pandas(df, preserve_index=False), buf,
                   row_group_size=row_group_size)
    return buf.getvalue()


class StubModel:
    """Records the size of every batch it is asked to predict."""

    def __init__(self):
        self.batch_sizes: list[int] = []

    def predict(self, features):
        self.batch_sizes.append(len(features))
        return np.asarray(features["amount"]) * 2.0


def _executor(s3: FakeS3) -> LocalScoringExecutor:
    # Bypass __init__: it builds a real boto3 client against a live endpoint, and
    # none of the streaming behaviour under test depends on it.
    ex = object.__new__(LocalScoringExecutor)
    ex._bucket = BUCKET
    ex._s3 = s3
    ex._mlflow_uri = "http://unused"
    return ex


def _run(monkeypatch, s3: FakeS3, *, n_rows: int, parameters: dict | None = None,
         model_inputs=("amount", "age")):
    stub = StubModel()
    monkeypatch.setattr(ex_mod, "set_global_mlflow_uri", lambda uri: None, raising=False)
    fake_mlflow = types.ModuleType("mlflow")
    fake_mlflow.pyfunc = SimpleNamespace(load_model=lambda uri: stub)
    monkeypatch.setitem(__import__("sys").modules, "mlflow", fake_mlflow)
    monkeypatch.setattr("app.adapters.mlflow_registry.set_global_mlflow_uri",
                        lambda uri: None)

    s3.objects[IN_KEY] = _parquet_bytes(n_rows)
    model = ResolvedModel(
        name="fraud", version=3, stage="production", model_uri="models:/fraud/3",
        inputs=[SimpleNamespace(name=c) for c in model_inputs], model_id="m-1")
    dataset = ResolvedDataset(urn="wr:t:dataset:dataset/ds-1", dataset_id="ds-1", version=1,
                              schema={}, row_count=n_rows,
                              storage_uri=f"s3://{BUCKET}/{IN_KEY}")
    job = SimpleNamespace(id="job-1", tenant_id="tnt-1")
    result = _executor(s3)._run_sync(model, dataset, job, parameters or {})
    return result, stub


def _read_parts(s3: FakeS3, uri: str) -> pd.DataFrame:
    prefix = uri.removeprefix(f"s3://{BUCKET}/")
    keys = sorted(k for k in s3.objects if k.startswith(prefix) and k.endswith(".parquet"))
    assert keys, f"no parts under {prefix}"
    return pd.concat([pq.read_table(io.BytesIO(s3.objects[k])).to_pandas() for k in keys],
                     ignore_index=True)


# ---- the property that makes large volume possible -------------------------

def test_predict_never_sees_more_than_one_chunk(monkeypatch):
    """The defect this guards: the executor used to read the whole input into a
    DataFrame and call predict once, so a 50M-row dataset needed 50M rows'
    worth of resident memory to score."""
    s3 = FakeS3()
    result, stub = _run(monkeypatch, s3, n_rows=250, parameters={"chunk_rows": 100})

    assert max(stub.batch_sizes) <= 100
    assert len(stub.batch_sizes) > 1  # it really did stream, not fall back to one pass
    assert sum(stub.batch_sizes) == 250
    assert result.row_count == 250


def test_parts_reassemble_into_exactly_the_input_rows(monkeypatch):
    s3 = FakeS3()
    result, _ = _run(monkeypatch, s3, n_rows=250, parameters={"chunk_rows": 100})
    out = _read_parts(s3, result.output_storage_uri)

    assert len(out) == 250
    # Order is preserved across parts, and the predictions are the model's.
    assert out["amount"].tolist() == list(range(250))
    assert out["prediction"].tolist() == [float(i) * 2 for i in range(250)]
    assert set(out["_datacern_job_id"]) == {"job-1"}
    assert set(out["_datacern_model_version"]) == {"fraud@3"}


def test_output_uri_is_the_prefix_and_parts_are_ordered(monkeypatch):
    s3 = FakeS3()
    result, _ = _run(monkeypatch, s3, n_rows=250, parameters={"chunk_rows": 100})

    assert result.output_storage_uri == f"s3://{BUCKET}/scores/tnt-1/job-1/"
    parts = sorted(k for k in s3.objects if k.startswith("scores/"))
    assert parts == ["scores/tnt-1/job-1/part-00000.parquet",
                     "scores/tnt-1/job-1/part-00001.parquet",
                     "scores/tnt-1/job-1/part-00002.parquet"]
    # Zero-padded so lexical key order is chunk order past part 9.
    assert parts == sorted(parts)


def test_one_snapshot_timestamp_across_every_part(monkeypatch):
    """All parts belong to one scoring snapshot; a per-part timestamp would make
    the output look like several runs stitched together."""
    s3 = FakeS3()
    result, _ = _run(monkeypatch, s3, n_rows=250, parameters={"chunk_rows": 100})
    out = _read_parts(s3, result.output_storage_uri)

    assert out["_scored_at"].nunique() == 1


def test_empty_input_still_produces_a_readable_output(monkeypatch):
    """An absent prefix would be indistinguishable from a lost result."""
    s3 = FakeS3()
    result, _ = _run(monkeypatch, s3, n_rows=0)
    out = _read_parts(s3, result.output_storage_uri)

    assert result.row_count == 0
    assert len(out) == 0
    assert "prediction" in out.columns


def test_include_features_false_drops_the_non_input_columns(monkeypatch):
    s3 = FakeS3()
    result, _ = _run(monkeypatch, s3, n_rows=120,
                     parameters={"chunk_rows": 50, "include_features": False},
                     model_inputs=("amount",))
    out = _read_parts(s3, result.output_storage_uri)

    assert "age" not in out.columns and "amount" in out.columns
    assert len(out) == 120


def test_a_single_chunk_still_yields_one_part(monkeypatch):
    """The common small-dataset case keeps its old shape: one object."""
    s3 = FakeS3()
    result, stub = _run(monkeypatch, s3, n_rows=40)
    assert stub.batch_sizes == [40]
    assert sorted(k for k in s3.objects if k.startswith("scores/")) == [
        "scores/tnt-1/job-1/part-00000.parquet"]


# ---- parts must read back as ONE dataset -----------------------------------

def _run_over(monkeypatch, s3: FakeS3, table: pa.Table, stub, *, chunk_rows: int,
              input_cols=("amount",)):
    buf = io.BytesIO()
    pq.write_table(table, buf)
    s3.objects[IN_KEY] = buf.getvalue()

    monkeypatch.setattr("app.adapters.mlflow_registry.set_global_mlflow_uri",
                        lambda uri: None)
    fake_mlflow = types.ModuleType("mlflow")
    fake_mlflow.pyfunc = SimpleNamespace(load_model=lambda uri: stub)
    monkeypatch.setitem(__import__("sys").modules, "mlflow", fake_mlflow)

    model = ResolvedModel(name="fraud", version=3, stage="production",
                          model_uri="models:/fraud/3",
                          inputs=[SimpleNamespace(name=c) for c in input_cols],
                          model_id="m-1")
    dataset = ResolvedDataset(urn="wr:t:dataset:dataset/ds-1", dataset_id="ds-1", version=1,
                              schema={}, row_count=table.num_rows,
                              storage_uri=f"s3://{BUCKET}/{IN_KEY}")
    job = SimpleNamespace(id="job-1", tenant_id="tnt-1")
    return _executor(s3)._run_sync(model, dataset, job, {"chunk_rows": chunk_rows})


def test_nulls_in_a_later_chunk_do_not_change_that_parts_column_types(monkeypatch):
    """The hazard the arrow assembly removes: pandas widens an integer column to
    float64 as soon as it contains a null, so a chunk that happens to have a null
    would have written a part with a different schema than its neighbours — and
    the parts would then refuse to read back as one dataset."""
    s3 = FakeS3()
    table = pa.table({
        "amount": pa.array([float(i) for i in range(200)], pa.float64()),
        # first 100 rows complete, second 100 riddled with nulls
        "age": pa.array([30] * 100 + [None if i % 2 else 40 for i in range(100)],
                        pa.int64()),
    })
    result = _run_over(monkeypatch, s3, table, StubModel(), chunk_rows=100)

    prefix = result.output_storage_uri.removeprefix(f"s3://{BUCKET}/")
    keys = sorted(k for k in s3.objects if k.startswith(prefix))
    assert len(keys) == 2
    schemas = [pq.read_table(io.BytesIO(s3.objects[k])).schema for k in keys]
    assert schemas[0] == schemas[1]
    assert schemas[0].field("age").type == pa.int64()  # not widened to double

    combined = _read_parts(s3, result.output_storage_uri)
    assert len(combined) == 200


class DriftingModel(StubModel):
    """Returns ints for the first batch and floats afterwards."""

    def __init__(self, later_dtype="float64", offset=0.5):
        super().__init__()
        self._later_dtype, self._offset = later_dtype, offset

    def predict(self, features):
        self.batch_sizes.append(len(features))
        if len(self.batch_sizes) == 1:
            return np.arange(len(features), dtype="int64")
        return np.arange(len(features), dtype=self._later_dtype) + self._offset


def test_a_widening_prediction_type_is_cast_losslessly(monkeypatch):
    """Whole-number floats fit in the int64 part 0 established — cast and carry on
    rather than failing a job over a representable value."""
    s3 = FakeS3()
    table = pa.table({"amount": pa.array([float(i) for i in range(200)], pa.float64())})
    result = _run_over(monkeypatch, s3, table,
                       DriftingModel(offset=0.0), chunk_rows=100)

    combined = _read_parts(s3, result.output_storage_uri)
    assert len(combined) == 200  # readable as one dataset, which is the point
    assert result.row_count == 200


def test_a_lossy_prediction_drift_fails_loudly_instead_of_truncating(monkeypatch):
    """0.5 does not fit in part 0's int64 column. Writing 0 there would record a
    prediction the model never made — a scored dataset that misstates its own
    predictions is worse than a failed job, because the failure is recoverable
    and the false number is not."""
    s3 = FakeS3()
    table = pa.table({"amount": pa.array([float(i) for i in range(200)], pa.float64())})

    with pytest.raises(ValueError) as ei:
        _run_over(monkeypatch, s3, table, DriftingModel(), chunk_rows=100)

    msg = str(ei.value)
    assert "prediction" in msg and "int64" in msg and "double" in msg
    assert "chunk_rows" in msg  # the message says how to get unstuck


# ---- chunk size ------------------------------------------------------------

@pytest.mark.parametrize("bad", [None, 0, -5, "", "lots", {}])
def test_bad_chunk_rows_falls_back_to_the_default(bad):
    """Never to "unbounded": a nonsense value must not silently restore the
    whole-dataset read this change exists to remove."""
    assert _chunk_rows({"chunk_rows": bad}) == DEFAULT_CHUNK_ROWS
    assert _chunk_rows({}) == DEFAULT_CHUNK_ROWS


def test_chunk_rows_honours_a_deliberate_override():
    assert _chunk_rows({"chunk_rows": 1000}) == 1000
    assert _chunk_rows({"chunk_rows": "2500"}) == 2500


# ---- the ranged reader -----------------------------------------------------

def test_range_reader_matches_the_underlying_bytes():
    blob = bytes(range(256)) * 8
    s3 = FakeS3({IN_KEY: blob})
    r = _S3RangeReader(s3, BUCKET, IN_KEY)

    assert r.seekable() and r.readable() and not r.writable()
    assert r.read(10) == blob[:10]
    assert r.tell() == 10
    r.seek(-4, io.SEEK_END)
    assert r.read() == blob[-4:]
    r.seek(100)
    assert r.read(50) == blob[100:150]
    r.seek(0, io.SEEK_END)
    assert r.read(10) == b""  # reads past the end are empty, not an error


def test_parquet_is_parsed_without_fetching_the_whole_object():
    """Footer-first, then only the row groups asked for — that is the whole
    reason the reader exists. The old code called Body.read() and paid for every
    byte of the object before it could parse a single row."""
    blob = _parquet_bytes(400_000, row_group_size=2_000)
    s3 = FakeS3({IN_KEY: blob})

    pf = pq.ParquetFile(io.BufferedReader(_S3RangeReader(s3, BUCKET, IN_KEY),
                                          buffer_size=64 * 1024))
    first = next(pf.iter_batches(batch_size=2_000))

    assert first.num_rows == 2_000
    assert s3.range_lengths, "nothing was fetched by range"
    assert max(s3.range_lengths) < len(blob), "a single request pulled the whole object"
    # Reading one 2k-row batch out of 400k rows must cost a small fraction of the
    # object — the footer plus the row groups touched, not the file.
    assert sum(s3.range_lengths) < len(blob) // 4, (
        f"one batch cost {sum(s3.range_lengths)} of {len(blob)} bytes")
