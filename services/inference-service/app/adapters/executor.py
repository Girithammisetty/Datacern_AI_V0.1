"""Real local scoring executor (INF-FR-004/040).

Loads the registered model from MLflow, streams the real input parquet from
object storage in row-group batches, runs ``model.predict`` on each batch, and
writes the scored output as one or more parquet parts under a job-scoped prefix.
Returns a pointer to that prefix so the finalize step can register it as an
output dataset version.

Streaming is what makes the job's memory a function of the chunk size rather
than of the dataset: the input is fetched by byte range (only the footer plus the
row groups being scored), each batch is decoded, predicted and written, and then
released. Scoring 50M rows costs the same resident memory as scoring 50k.

Nothing partial is ever *referenceable*: parts land under
``scores/<tenant>/<job>/``, and that prefix is only recorded as an output dataset
version by the finalize step once the whole run has succeeded. Retry mints a new
job id (see InferenceService.retry), so a prefix is written exactly once and the
parts left behind by a cancelled or failed run can never be mistaken for a
complete output.

This is the local, Mac-testable real substitute for the pipeline-orchestrator /
Argo scoring run. It speaks the real MLflow + S3 wire protocols end to end.
"""

from __future__ import annotations

import asyncio
import io
import os
import uuid
from urllib.parse import urlparse

import pyarrow as pa
import pyarrow.parquet as pq

from app.domain.ports import ResolvedDataset, ResolvedModel, ScoringResult

_SYS_JOB = "_datacern_job_id"
_SYS_MODEL = "_datacern_model_version"
_SYS_SCORED = "_scored_at"

#: Rows decoded, predicted and written per part. The whole point of the number is
#: that it, and not the dataset size, sets peak memory — so it is deliberately
#: modest. Overridable per job via the ``chunk_rows`` parameter.
DEFAULT_CHUNK_ROWS = 50_000

#: Bytes buffered per ranged GET. Parquet reads a row group as a few large runs;
#: buffering keeps that from degenerating into many tiny range requests.
_READ_BUFFER = 4 * 1024 * 1024


class LocalScoringExecutor:
    def __init__(
        self,
        *,
        datasets_bucket: str = "datacern-datasets",
        s3_endpoint_url: str = "http://localhost:9000",
        s3_access_key: str = "datacern",
        s3_secret_key: str = "datacern_dev",
        s3_region: str = "us-east-1",
        mlflow_tracking_uri: str = "http://localhost:5500",
    ) -> None:
        from datacern_common.objectstore import S3Config, build_s3_client

        self._bucket = datasets_bucket
        self._cfg = S3Config(
            endpoint_url=s3_endpoint_url, access_key=s3_access_key,
            secret_key=s3_secret_key, bucket=datasets_bucket, region=s3_region)
        self._s3 = build_s3_client(self._cfg)
        self._mlflow_uri = mlflow_tracking_uri

    async def run(self, *, model: ResolvedModel, dataset: ResolvedDataset, job,
                  parameters: dict) -> ScoringResult:
        return await asyncio.to_thread(self._run_sync, model, dataset, job, parameters or {})

    def _describe_model_source(self, model: ResolvedModel) -> str:
        """Where the registry says this model's artifacts live, and what is
        actually there. Diagnostic only — must never raise, because it runs on a
        path that is already failing and its own error would replace the real one.
        """
        parts: list[str] = []
        try:
            from mlflow.tracking import MlflowClient
            mv = MlflowClient(tracking_uri=self._mlflow_uri).get_model_version(
                model.name, str(model.version))
            parts.append(f"registry source={mv.source!r} run_id={mv.run_id!r}")
        except Exception as exc:  # noqa: BLE001
            parts.append(f"registry source unavailable: {type(exc).__name__}: {exc}")
        try:
            import tempfile

            from mlflow.artifacts import download_artifacts
            with tempfile.TemporaryDirectory() as tmp:
                got = download_artifacts(artifact_uri=model.model_uri, dst_path=tmp)
                listing = sorted(os.listdir(got))[:25]
            parts.append(f"downloaded {got!r} contains {listing}")
        except Exception as exc:  # noqa: BLE001
            parts.append(f"download failed: {type(exc).__name__}: {exc}")
        return "; ".join(parts)

    def _run_sync(self, model: ResolvedModel, dataset: ResolvedDataset, job,
                  parameters: dict) -> ScoringResult:
        import mlflow

        from app.adapters.mlflow_registry import set_global_mlflow_uri

        # ``models:/`` load uses MLflow's GLOBAL uri (BUG-2) — set tracking+registry.
        set_global_mlflow_uri(self._mlflow_uri)
        try:
            loaded = mlflow.pyfunc.load_model(model.model_uri)
        except Exception as exc:  # noqa: BLE001 — re-raised below, enriched
            # A load failure here reports only the TEMP DIRECTORY MLflow happened
            # to download into ("Could not find an MLmodel configuration file at
            # /tmp/tmpXXXX/MLmodel"), which names nothing an operator can act on:
            # not the model, not where its artifacts were supposed to come from,
            # not what actually arrived. That message cost two CI rounds and two
            # wrong hypotheses.
            #
            # Resolution and load disagree here — `get_model_info(model_uri)`
            # succeeds during resolve (a job cannot be submitted otherwise) while
            # this load fails on the same URI — so the registry's SOURCE and the
            # downloaded contents are exactly the two facts needed to tell those
            # apart. Report both, then re-raise unchanged.
            raise RuntimeError(
                f"could not load {model.model_uri}: {exc} "
                f"[{self._describe_model_source(model)}]") from exc

        chunk_rows = _chunk_rows(parameters)
        scored_at = _now_iso()  # one timestamp for the whole snapshot, not per part
        prefix = f"scores/{job.tenant_id}/{job.id}/"
        include_features = bool(parameters.get("include_features", True))

        pf = self._open_parquet(dataset.storage_uri)
        declared = [c.name for c in model.inputs]
        available = list(pf.schema_arrow.names)
        input_cols = [c for c in (declared or available) if c in available]

        # auto_case (score→case bridge): collect over-threshold rows WHILE
        # streaming so the finalize step never has to re-read the output.
        # Bounded by max_cases; total_over keeps counting so truncation is
        # visible to the emitter (no silent caps).
        ac = parameters.get("auto_case") or {}
        ac_rows: list[dict] = []
        ac_total_over = 0

        rows = 0
        parts = 0
        schema = None  # pinned from part 0 so every part reads back as one dataset
        for batch in pf.iter_batches(batch_size=chunk_rows):
            table = self._score_batch(batch, loaded, model, job, input_cols,
                                      include_features, scored_at)
            if schema is None:
                schema = table.schema
            elif table.schema != schema:
                table = _align(table, schema, parts)
            self._write_parquet(f"{prefix}part-{parts:05d}.parquet", table)
            if ac:
                ac_total_over += _collect_auto_case_rows(table, ac, ac_rows)
            rows += table.num_rows
            parts += 1

        if parts == 0:
            # An empty input still has to produce a readable, correctly-shaped
            # output — an absent prefix would look like a lost result.
            empty = pa.RecordBatch.from_pylist([], schema=pf.schema_arrow)
            self._write_parquet(
                f"{prefix}part-00000.parquet",
                self._score_batch(empty, loaded, model, job, input_cols,
                                  include_features, scored_at))

        return ScoringResult(
            output_storage_uri=f"s3://{self._bucket}/{prefix}",
            snapshot_id=uuid.uuid4().hex,
            row_count=int(rows),
            prediction_columns=["prediction"],
            auto_case_rows=ac_rows if ac else None,
            auto_case_total_over=ac_total_over,
        )

    def _score_batch(self, batch: pa.RecordBatch, loaded, model: ResolvedModel, job,
                     input_cols: list[str], include_features: bool,
                     scored_at: str) -> pa.Table:
        """Predict one batch and attach the prediction + provenance columns.

        The features go to the model as pandas because that is what pyfunc takes,
        but the OUTPUT is assembled in arrow so the carried-through columns keep
        the input file's declared types on every part. Rebuilding them from
        pandas instead would let a column's type depend on whether a given chunk
        happened to contain a null.
        """
        n = batch.num_rows
        features = pa.Table.from_batches([batch]).select(input_cols).to_pandas()
        base = pa.Table.from_batches([batch])
        if not include_features:
            base = base.select(input_cols)
        return (base
                .append_column("prediction", pa.array(_as_series(loaded.predict(features), n)))
                .append_column(_SYS_JOB, pa.array([job.id] * n, pa.string()))
                .append_column(_SYS_MODEL,
                               pa.array([f"{model.name}@{model.version}"] * n, pa.string()))
                .append_column(_SYS_SCORED, pa.array([scored_at] * n, pa.string())))

    def _open_parquet(self, storage_uri: str) -> pq.ParquetFile:
        bucket, key = _parse_s3(storage_uri)
        raw = _S3RangeReader(self._s3, bucket, key)
        return pq.ParquetFile(io.BufferedReader(raw, buffer_size=_READ_BUFFER))

    def _write_parquet(self, key: str, table: pa.Table) -> None:
        buf = io.BytesIO()
        pq.write_table(table, buf)
        self._s3.put_object(Bucket=self._bucket, Key=key, Body=buf.getvalue(),
                            ContentType="application/octet-stream")


class _S3RangeReader(io.RawIOBase):
    """A seekable, read-only file over ranged S3 GETs.

    Parquet is read footer-first and then row group by row group, but an S3
    response body is a forward-only stream — so the previous code called
    ``Body.read()`` and pulled the entire object into memory before it could
    parse a single row. Serving pyarrow's seeks with ``Range`` requests instead
    means a 10 GB input costs the footer plus the row groups actually being
    scored.
    """

    def __init__(self, s3, bucket: str, key: str) -> None:
        super().__init__()
        self._s3, self._bucket, self._key = s3, bucket, key
        self._pos = 0
        self._size = int(s3.head_object(Bucket=bucket, Key=key)["ContentLength"])

    def readable(self) -> bool:
        return True

    def seekable(self) -> bool:
        return True

    def writable(self) -> bool:
        return False

    def tell(self) -> int:
        return self._pos

    def seek(self, offset: int, whence: int = io.SEEK_SET) -> int:
        base = {io.SEEK_SET: 0, io.SEEK_CUR: self._pos, io.SEEK_END: self._size}[whence]
        self._pos = max(0, min(self._size, base + offset))
        return self._pos

    def readinto(self, b) -> int:
        want = min(len(b), self._size - self._pos)
        if want <= 0:
            return 0
        end = self._pos + want - 1  # HTTP ranges are inclusive on both ends
        body = self._s3.get_object(
            Bucket=self._bucket, Key=self._key,
            Range=f"bytes={self._pos}-{end}")["Body"].read()
        b[:len(body)] = body
        self._pos += len(body)
        return len(body)


def _align(table: pa.Table, schema: pa.Schema, part: int) -> pa.Table:
    """Make a later part match part 0's schema, or fail the job saying why.

    Only ``prediction`` can realistically drift — the feature columns keep the
    parquet file's declared arrow types because they are never rebuilt from
    pandas. A widening drift (part 0 int, this part float, or the reverse) is
    cast losslessly. A cast that would LOSE information is refused: writing
    0.5 into an int64 column would silently record a prediction the model never
    made, and a scored dataset that misstates its own predictions is worse than
    a failed job, which is at least recoverable by re-running.
    """
    try:
        return table.cast(schema)  # safe=True: raises rather than truncating
    except pa.ArrowInvalid as exc:
        drifted = [f"{f.name}: part 0 is {schema.field(f.name).type}, "
                   f"part {part} is {f.type}"
                   for f in table.schema
                   if f.name in schema.names and schema.field(f.name).type != f.type]
        raise ValueError(
            "scoring output columns changed type between chunks and cannot be "
            f"reconciled without losing data ({'; '.join(drifted) or exc}). The "
            "model returned inconsistent prediction types across batches; scoring "
            "the whole dataset in one chunk (a larger chunk_rows) avoids the split."
        ) from exc


def _collect_auto_case_rows(table: pa.Table, spec: dict, out: list[dict]) -> int:
    """Collect this part's rows scoring at/over the auto_case threshold into
    ``out`` (as {row_pk, score, display_projection}), stopping at max_cases.
    Returns how many rows in this part were at/over threshold REGARDLESS of the
    cap, so the caller can report truncation instead of hiding it. A missing
    row_pk/score column contributes nothing — the emitter's empty-rows log is
    the diagnosable signal (config error, not a crash)."""
    score_field = spec.get("score_field") or "prediction"
    pk_field = spec.get("row_pk_field") or ""
    if score_field not in table.column_names or pk_field not in table.column_names:
        return 0
    positive_label = spec.get("positive_label")
    threshold = float(spec.get("threshold") or 0.0)
    max_cases = int(spec.get("max_cases", 500))
    proj_fields = [c for c in (spec.get("projection_fields") or [])
                   if c in table.column_names]
    scores = table.column(score_field).to_pylist()
    pks = table.column(pk_field).to_pylist()
    proj_cols = {c: table.column(c).to_pylist() for c in proj_fields}
    over = 0
    for i, s in enumerate(scores):
        if positive_label is not None:
            # categorical (classifier labels): equality on the predicted class;
            # a matched row reports score 1.0 so the consumer's numeric filter
            # (score >= score_threshold) always passes it.
            if s is None or str(s) != positive_label:
                continue
            score = 1.0
            shown = str(s)
        else:
            try:
                score = float(s)
            except (TypeError, ValueError):
                continue
            if score < threshold:
                continue
            shown = f"{score:.6g}"
        if pks[i] is None:
            continue
        over += 1
        if len(out) >= max_cases:
            continue
        proj = {c: ("" if vals[i] is None else str(vals[i]))
                for c, vals in proj_cols.items()}
        proj["score"] = shown
        out.append({"row_pk": str(pks[i]), "score": score, "display_projection": proj})
    return over


def _chunk_rows(parameters: dict) -> int:
    """Rows per part. A caller may tune it; a nonsensical value falls back to the
    default rather than becoming an accidental whole-dataset read."""
    try:
        n = int(parameters.get("chunk_rows") or DEFAULT_CHUNK_ROWS)
    except (TypeError, ValueError):
        return DEFAULT_CHUNK_ROWS
    return n if n > 0 else DEFAULT_CHUNK_ROWS


def _parse_s3(uri: str) -> tuple[str, str]:
    parsed = urlparse(uri)
    if parsed.scheme != "s3":
        raise ValueError(f"expected s3:// uri, got {uri!r}")
    return parsed.netloc, parsed.path.lstrip("/")


def _as_series(preds, n: int):
    import numpy as np
    import pandas as pd

    if isinstance(preds, pd.DataFrame):
        return preds.iloc[:, 0].reset_index(drop=True)
    if isinstance(preds, pd.Series):
        return preds.reset_index(drop=True)
    arr = np.asarray(preds)
    if arr.size == 0:
        # reshape(0, -1) is ambiguous and raises; an empty input is a legitimate
        # scoring job that must still produce a correctly-shaped output.
        return pd.Series(arr.ravel())
    return pd.Series(arr.reshape(n, -1)[:, 0])


def _now_iso() -> str:
    from datetime import UTC, datetime

    return datetime.now(UTC).isoformat()
