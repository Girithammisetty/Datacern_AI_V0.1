"""BRD 62 — the REAL in-process pandas implementations of the data-prep operator
catalog, so a data-prep / feature-engineering pipeline runs end to end LOCALLY
without an Argo cluster (closing the P1 gap where only `*-train` components executed).

Each operator is a pure function ``op(inputs, params) -> outputs`` over pandas
DataFrames, registered in ``OPERATORS`` by its exact ``catalog.py`` name. Pure,
deterministic, no IO — the local DAG executor (``local_pipeline.py``) threads frames
between them; IO nodes (read/write-warehouse) are handled by the executor's injected
ports, not here. Operators fail CLOSED: a malformed param or missing column raises
``OperatorError`` (surfaced as a precise component error), never a silent passthrough.
"""

from __future__ import annotations

from collections.abc import Callable

import numpy as np
import pandas as pd

Operator = Callable[[list[pd.DataFrame], dict], list[pd.DataFrame]]


class OperatorError(ValueError):
    """A data-prep operator could not run with the given inputs/params."""


OPERATORS: dict[str, Operator] = {}


def _register(name: str) -> Callable[[Operator], Operator]:
    def deco(fn: Operator) -> Operator:
        OPERATORS[name] = fn
        return fn

    return deco


def _one(inputs: list[pd.DataFrame]) -> pd.DataFrame:
    if not inputs:
        raise OperatorError("operator requires an input dataframe")
    return inputs[0]


def _require_cols(df: pd.DataFrame, cols: list[str], op: str) -> None:
    missing = [c for c in cols if c not in df.columns]
    if missing:
        raise OperatorError(f"{op}: columns not found: {missing} (have {list(df.columns)})")


# --------------------------------------------------------------------------
# Column / row shaping
# --------------------------------------------------------------------------

@_register("select-columns")
def select_columns(inputs, params):
    df = _one(inputs)
    cols = list(params.get("columns") or [])
    if not cols:
        raise OperatorError("select-columns: 'columns' is required")
    _require_cols(df, cols, "select-columns")
    return [df[cols].copy()]


@_register("rename-columns")
def rename_columns(inputs, params):
    df = _one(inputs)
    mapping = params.get("mapping") or params.get("rename") or {}
    if not isinstance(mapping, dict) or not mapping:
        raise OperatorError("rename-columns: 'mapping' {old: new} is required")
    _require_cols(df, list(mapping), "rename-columns")
    return [df.rename(columns=mapping).copy()]


@_register("sort-data")
def sort_data(inputs, params):
    df = _one(inputs)
    by = params.get("by") or params.get("columns")
    if isinstance(by, str):
        by = [by]
    if not by:
        raise OperatorError("sort-data: 'by' column(s) required")
    _require_cols(df, by, "sort-data")
    ascending = params.get("ascending", True)
    return [df.sort_values(by=by, ascending=ascending, kind="mergesort").reset_index(drop=True)]


@_register("filter-data")
def filter_data(inputs, params):
    df = _one(inputs)
    expr = params.get("expression")
    if not expr:
        raise OperatorError("filter-data: 'expression' is required")
    try:
        out = df.query(expr, engine="python")
    except Exception as exc:  # noqa: BLE001
        raise OperatorError(f"filter-data: bad expression {expr!r}: {exc}") from exc
    return [out.reset_index(drop=True)]


@_register("sample-data")
def sample_data(inputs, params):
    df = _one(inputs)
    if "n_rows" in params and params["n_rows"] is not None:
        n = min(int(params["n_rows"]), len(df))
        out = df.sample(n=n, random_state=params.get("random_state", 42))
    else:
        frac = float(params.get("fraction", params.get("frac", 0.1)))
        out = df.sample(frac=frac, random_state=params.get("random_state", 42))
    return [out.reset_index(drop=True)]


@_register("remove-duplicate-rows")
def remove_duplicate_rows(inputs, params):
    df = _one(inputs)
    subset = params.get("subset") or params.get("columns") or None
    if subset:
        _require_cols(df, subset, "remove-duplicate-rows")
    keep = params.get("keep", "first")
    return [df.drop_duplicates(subset=subset, keep=keep).reset_index(drop=True)]


@_register("add-guid-column")
def add_guid_column(inputs, params):
    import uuid

    df = _one(inputs).copy()
    col = params.get("column", "_row_guid_")
    # Deterministic per-row uuid5 so a re-run of the same frame is reproducible.
    ns = uuid.NAMESPACE_OID
    df[col] = [str(uuid.uuid5(ns, f"{i}")) for i in range(len(df))]
    return [df]


# --------------------------------------------------------------------------
# Multi-input: join / union / merge
# --------------------------------------------------------------------------

@_register("join-data")
def join_data(inputs, params):
    if len(inputs) < 2:
        raise OperatorError("join-data: needs 2 inputs")
    left, right = inputs[0], inputs[1]
    join_type = params.get("join_type", "inner")
    if join_type not in ("inner", "left", "outer", "right"):  # P3: 'right' added
        raise OperatorError(f"join-data: unknown join_type {join_type!r}")
    on = params.get("on")
    left_on = params.get("left_on")
    right_on = params.get("right_on")
    if on:
        on_cols = [on] if isinstance(on, str) else list(on)
        _require_cols(left, on_cols, "join-data(left)")
        _require_cols(right, on_cols, "join-data(right)")
        out = left.merge(right, how=join_type, on=on_cols,
                         suffixes=("", "_r"))
    elif left_on and right_on:
        out = left.merge(right, how=join_type, left_on=left_on, right_on=right_on,
                         suffixes=("", "_r"))
    else:
        raise OperatorError("join-data: 'on' (or left_on+right_on) is required")
    if params.get("drop_duplicates"):
        out = out.drop_duplicates()
    return [out.reset_index(drop=True)]


@_register("union")
def union(inputs, params):
    if len(inputs) < 2:
        raise OperatorError("union: needs >=2 inputs")
    return [pd.concat(inputs, ignore_index=True, sort=False)]


@_register("merge-data")
def merge_data(inputs, params):
    if len(inputs) < 2:
        raise OperatorError("merge-data: needs >=2 inputs")
    on = params.get("on")
    how = params.get("join_type", params.get("how", "outer"))
    out = inputs[0]
    for nxt in inputs[1:]:
        if on:
            on_cols = [on] if isinstance(on, str) else list(on)
            out = out.merge(nxt, how=how, on=on_cols, suffixes=("", "_r"))
        else:
            # No key → column-wise align by index (horizontal concat).
            out = pd.concat([out.reset_index(drop=True), nxt.reset_index(drop=True)], axis=1)
    return [out.reset_index(drop=True)]


# --------------------------------------------------------------------------
# Aggregation / reshape
# --------------------------------------------------------------------------

_AGG_FUNCS = {"mean", "median", "sum", "count", "size", "min", "max", "std", "var",
              "sem", "first", "last"}


@_register("group-by")
def group_by(inputs, params):
    df = _one(inputs)
    keys = params.get("by") or params.get("group_columns")
    if isinstance(keys, str):
        keys = [keys]
    if not keys:
        raise OperatorError("group-by: 'by' column(s) required")
    _require_cols(df, keys, "group-by")
    aggs = params.get("aggregations") or params.get("agg")
    if not aggs:
        raise OperatorError("group-by: 'aggregations' {col: func} required")
    for func in aggs.values():
        if func not in _AGG_FUNCS:
            raise OperatorError(f"group-by: unsupported agg {func!r}; allowed {sorted(_AGG_FUNCS)}")
    _require_cols(df, list(aggs), "group-by")
    out = df.groupby(keys, dropna=False).agg(aggs).reset_index()
    if params.get("join_with_original"):
        out = df.merge(out, on=keys, how="left", suffixes=("", "_agg"))
    return [out]


@_register("long-to-wide-converter")
def long_to_wide(inputs, params):
    df = _one(inputs)
    index = params.get("index")
    columns = params.get("columns")
    values = params.get("values")
    if not (index and columns and values):
        raise OperatorError("long-to-wide-converter: 'index','columns','values' required")
    _require_cols(df, [columns, values] + ([index] if isinstance(index, str) else list(index)),
                  "long-to-wide-converter")
    out = df.pivot_table(index=index, columns=columns, values=values,
                         aggfunc=params.get("aggfunc", "first")).reset_index()
    out.columns = [str(c) for c in out.columns]
    return [out]


@_register("wide-to-long-converter")
def wide_to_long(inputs, params):
    df = _one(inputs)
    id_vars = params.get("id_vars") or params.get("index")
    value_vars = params.get("value_vars") or params.get("columns")
    if isinstance(id_vars, str):
        id_vars = [id_vars]
    if not id_vars:
        raise OperatorError("wide-to-long-converter: 'id_vars' required")
    _require_cols(df, id_vars, "wide-to-long-converter")
    out = df.melt(id_vars=id_vars, value_vars=value_vars,
                  var_name=params.get("var_name", "variable"),
                  value_name=params.get("value_name", "value"))
    return [out.reset_index(drop=True)]


# --------------------------------------------------------------------------
# Type / value cleaning
# --------------------------------------------------------------------------

_CAST_TYPES = {"int": "Int64", "integer": "Int64", "float": "float64",
               "double": "float64", "string": "string", "str": "string",
               "bool": "boolean", "boolean": "boolean", "datetime": "datetime64[ns]",
               "date": "datetime64[ns]"}


@_register("cast-data")
def cast_data(inputs, params):
    df = _one(inputs).copy()
    casts = params.get("casts") or params.get("columns")
    if not isinstance(casts, dict) or not casts:
        raise OperatorError("cast-data: 'casts' {col: type} required")
    _require_cols(df, list(casts), "cast-data")
    for col, typ in casts.items():
        pdtype = _CAST_TYPES.get(str(typ).lower())
        if pdtype is None:
            raise OperatorError(f"cast-data: unknown type {typ!r} for {col}")
        try:
            if pdtype.startswith("datetime"):
                df[col] = pd.to_datetime(df[col], errors="coerce")
            elif pdtype == "Int64":
                df[col] = pd.to_numeric(df[col], errors="coerce").astype("Int64")
            elif pdtype == "float64":
                df[col] = pd.to_numeric(df[col], errors="coerce")
            else:
                df[col] = df[col].astype(pdtype)
        except Exception as exc:  # noqa: BLE001
            raise OperatorError(f"cast-data: {col}->{typ} failed: {exc}") from exc
    return [df]


@_register("handle-missing-values")
def handle_missing_values(inputs, params):
    df = _one(inputs).copy()
    strategy = params.get("strategy", "mean")
    cols = params.get("columns") or list(df.columns)
    _require_cols(df, cols, "handle-missing-values")
    group = params.get("group_by")
    if group:
        _require_cols(df, [group] if isinstance(group, str) else group, "handle-missing-values")

    def _fill(frame: pd.DataFrame) -> pd.DataFrame:
        f = frame.copy()
        for c in cols:
            if strategy == "drop":
                continue
            elif strategy == "mean":
                f[c] = f[c].fillna(f[c].mean())
            elif strategy == "median":
                f[c] = f[c].fillna(f[c].median())
            elif strategy in ("most_frequent", "mode"):
                m = f[c].mode()
                if len(m):
                    f[c] = f[c].fillna(m.iloc[0])
            elif strategy == "constant":
                f[c] = f[c].fillna(params.get("fill_value", 0))
            elif strategy == "linear_interpolation":  # P4
                f[c] = f[c].interpolate(method="linear", limit_direction="both")
            elif strategy == "previous_existing":  # P4 (ffill)
                f[c] = f[c].ffill()
            elif strategy == "next_existing":  # P4 (bfill)
                f[c] = f[c].bfill()
            elif strategy == "expression":  # P4: fill from a python expression over the row
                pass  # handled below (whole-frame)
            else:
                raise OperatorError(f"handle-missing-values: unknown strategy {strategy!r}")
        return f

    if strategy == "expression":
        expr = params.get("expression")
        if not expr:
            raise OperatorError("handle-missing-values(expression): 'expression' required")
        filled = df.eval(expr, engine="python")
        for c in cols:
            df[c] = df[c].fillna(filled)
        return [df]

    if strategy == "drop":
        return [df.dropna(subset=cols).reset_index(drop=True)]

    if group:
        out = df.groupby(group, group_keys=False, dropna=False).apply(_fill)
        return [out.reset_index(drop=True)]
    return [_fill(df)]


@_register("remove-outliers")
def remove_outliers(inputs, params):
    df = _one(inputs).copy()
    cols = params.get("columns") or df.select_dtypes(include=np.number).columns.tolist()
    _require_cols(df, cols, "remove-outliers")
    method = params.get("method", "iqr")
    mask = pd.Series(True, index=df.index)
    for c in cols:
        s = pd.to_numeric(df[c], errors="coerce")
        if method == "zscore":
            thr = float(params.get("threshold", 3.0))
            z = (s - s.mean()) / (s.std(ddof=0) or 1.0)
            mask &= z.abs() <= thr
        else:  # iqr
            q1, q3 = s.quantile(0.25), s.quantile(0.75)
            iqr = q3 - q1
            k = float(params.get("k", 1.5))
            mask &= (s >= q1 - k * iqr) & (s <= q3 + k * iqr)
    return [df[mask].reset_index(drop=True)]


@_register("quantization")
def quantization(inputs, params):
    df = _one(inputs).copy()
    col = params.get("column")
    if not col:
        raise OperatorError("quantization: 'column' required")
    _require_cols(df, [col], "quantization")
    bins = int(params.get("bins", 4))
    out_col = params.get("output_column", f"{col}_bin")
    strategy = params.get("strategy", "quantile")
    s = pd.to_numeric(df[col], errors="coerce")
    if strategy == "uniform":
        df[out_col] = pd.cut(s, bins=bins, labels=False, duplicates="drop")
    else:
        df[out_col] = pd.qcut(s, q=bins, labels=False, duplicates="drop")
    return [df]


# --------------------------------------------------------------------------
# Scaling / normalization / decomposition
# --------------------------------------------------------------------------

def _numeric_cols(df, params, op):
    cols = params.get("columns") or df.select_dtypes(include=np.number).columns.tolist()
    _require_cols(df, cols, op)
    if not cols:
        raise OperatorError(f"{op}: no numeric columns")
    return cols


@_register("minmax-scale")
def minmax_scale(inputs, params):
    df = _one(inputs).copy()
    cols = _numeric_cols(df, params, "minmax-scale")
    for c in cols:
        s = pd.to_numeric(df[c], errors="coerce")
        lo, hi = s.min(), s.max()
        rng = (hi - lo) or 1.0
        df[c] = (s - lo) / rng
    return [df]


@_register("zscore-normalization")
def zscore_normalization(inputs, params):
    df = _one(inputs).copy()
    cols = _numeric_cols(df, params, "zscore-normalization")
    for c in cols:
        s = pd.to_numeric(df[c], errors="coerce")
        std = s.std(ddof=0) or 1.0
        df[c] = (s - s.mean()) / std
    return [df]


@_register("pca")
def pca(inputs, params):
    from sklearn.decomposition import PCA

    df = _one(inputs).copy()
    cols = _numeric_cols(df, params, "pca")
    n = int(params.get("n_components", min(2, len(cols))))
    n = max(1, min(n, len(cols)))
    model = PCA(n_components=n, random_state=params.get("random_state", 42))
    comps = model.fit_transform(df[cols].fillna(0.0).to_numpy(dtype=float))
    keep_original = params.get("keep_original", False)
    out = df.copy() if keep_original else df.drop(columns=cols)
    for i in range(n):
        out[f"pc_{i + 1}"] = comps[:, i]
    return [out.reset_index(drop=True)]


@_register("linear-combination")
def linear_combination(inputs, params):
    df = _one(inputs).copy()
    weights = params.get("weights")  # {col: weight}
    if not isinstance(weights, dict) or not weights:
        raise OperatorError("linear-combination: 'weights' {col: weight} required")
    _require_cols(df, list(weights), "linear-combination")
    out_col = params.get("output_column", "linear_combination")
    acc = pd.Series(float(params.get("bias", 0.0)), index=df.index)
    for c, w in weights.items():
        acc = acc + pd.to_numeric(df[c], errors="coerce").fillna(0.0) * float(w)
    df[out_col] = acc
    return [df]


@_register("python-expression")
def python_expression(inputs, params):
    df = _one(inputs).copy()
    expr = params.get("expression")
    out_col = params.get("output_column", "expr_result")
    if not expr:
        raise OperatorError("python-expression: 'expression' required")
    try:
        df[out_col] = df.eval(expr, engine="python")
    except Exception as exc:  # noqa: BLE001
        raise OperatorError(f"python-expression: {expr!r} failed: {exc}") from exc
    return [df]


@_register("transform-data")
def transform_data(inputs, params):
    # Apply a named numeric transform to selected columns (log/sqrt/abs/exp).
    df = _one(inputs).copy()
    fn = params.get("function", "log")
    cols = _numeric_cols(df, params, "transform-data")
    fns = {"log": np.log1p, "sqrt": np.sqrt, "abs": np.abs, "exp": np.exp,
           "square": np.square}
    if fn not in fns:
        raise OperatorError(f"transform-data: unknown function {fn!r}; allowed {sorted(fns)}")
    for c in cols:
        df[c] = fns[fn](pd.to_numeric(df[c], errors="coerce"))
    return [df]


# --------------------------------------------------------------------------
# Encoders
# --------------------------------------------------------------------------

@_register("one-hot-encoder")
def one_hot_encoder(inputs, params):
    df = _one(inputs)
    cols = params.get("columns")
    if not cols:
        raise OperatorError("one-hot-encoder: 'columns' required")
    _require_cols(df, cols, "one-hot-encoder")
    return [pd.get_dummies(df, columns=cols, dtype=int)]


@_register("ordinal-encoder")
def ordinal_encoder(inputs, params):
    df = _one(inputs).copy()
    cols = params.get("columns")
    if not cols:
        raise OperatorError("ordinal-encoder: 'columns' required")
    _require_cols(df, cols, "ordinal-encoder")
    for c in cols:
        df[c] = df[c].astype("category").cat.codes
    return [df]


@_register("target-encoder")
def target_encoder(inputs, params):
    df = _one(inputs).copy()
    cols = params.get("columns")
    target = params.get("target")
    if not cols or not target:
        raise OperatorError("target-encoder: 'columns' and 'target' required")
    _require_cols(df, list(cols) + [target], "target-encoder")
    y = pd.to_numeric(df[target], errors="coerce")
    global_mean = y.mean()
    for c in cols:
        means = y.groupby(df[c]).transform("mean")
        df[c] = means.fillna(global_mean)
    return [df]


# --------------------------------------------------------------------------
# Feature-selection filters
# --------------------------------------------------------------------------

@_register("variance-filter")
def variance_filter(inputs, params):
    df = _one(inputs)
    thr = float(params.get("threshold", 0.0))
    num = df.select_dtypes(include=np.number)
    keep_num = [c for c in num.columns if num[c].var(ddof=0) > thr]
    non_num = [c for c in df.columns if c not in num.columns]
    return [df[non_num + keep_num].copy()]


@_register("quasi-constant-filter")
def quasi_constant_filter(inputs, params):
    df = _one(inputs)
    thr = float(params.get("threshold", 0.99))
    drop = []
    for c in df.columns:
        top = df[c].value_counts(normalize=True, dropna=False)
        if len(top) and top.iloc[0] >= thr:
            drop.append(c)
    return [df.drop(columns=drop).copy()]


@_register("correlation-filter")
def correlation_filter(inputs, params):
    df = _one(inputs)
    thr = float(params.get("threshold", 0.95))
    num = df.select_dtypes(include=np.number)
    if num.shape[1] < 2:
        return [df.copy()]
    with np.errstate(invalid="ignore", divide="ignore"):
        corr = num.corr().abs()
    upper = corr.where(np.triu(np.ones(corr.shape), k=1).astype(bool))
    drop = [c for c in upper.columns if (upper[c] >= thr).any()]
    return [df.drop(columns=drop).copy()]


@_register("statistical-filter")
def statistical_filter(inputs, params):
    # Drop numeric features whose |corr with target| is below a threshold.
    df = _one(inputs)
    target = params.get("target")
    if not target:
        raise OperatorError("statistical-filter: 'target' required")
    _require_cols(df, [target], "statistical-filter")
    thr = float(params.get("threshold", 0.05))
    y = pd.to_numeric(df[target], errors="coerce")
    num = df.select_dtypes(include=np.number)
    keep = [target]
    for c in num.columns:
        if c == target:
            continue
        with np.errstate(invalid="ignore", divide="ignore"):
            corr = pd.to_numeric(df[c], errors="coerce").corr(y)
        if pd.notna(corr) and abs(corr) >= thr:
            keep.append(c)
    non_num = [c for c in df.columns if c not in num.columns and c != target]
    return [df[non_num + keep].copy()]


# --------------------------------------------------------------------------
# Split (P5: stratified) + passthroughs
# --------------------------------------------------------------------------

@_register("split-data")
def split_data(inputs, params):
    from sklearn.model_selection import train_test_split

    df = _one(inputs)
    size = float(params.get("split_size", 0.8))
    shuffle = bool(params.get("shuffle", True))
    rs = params.get("random_state", 42)
    stratify_cols = params.get("stratify_columns")  # P5
    stratify = None
    if stratify_cols:
        _require_cols(df, stratify_cols, "split-data")
        stratify = df[stratify_cols]
        shuffle = True  # stratify requires shuffle
    train, test = train_test_split(df, train_size=size, shuffle=shuffle,
                                   random_state=rs if shuffle else None,
                                   stratify=stratify)
    return [train.reset_index(drop=True), test.reset_index(drop=True)]


@_register("clone-input")
def clone_input(inputs, params):
    df = _one(inputs)
    n = int(params.get("copies", params.get("n", 2)))
    return [df.copy() for _ in range(max(1, n))]


@_register("model-input")
def model_input(inputs, params):
    # A role marker (TRAIN/VALIDATION/TEST) — passthrough at execution time.
    return [_one(inputs).copy()]


@_register("data-profiler")
def data_profiler(inputs, params):
    # Profiling is computed by dataset-service; at execution time this is a
    # transparent passthrough so a compiled DAG with an injected profiler still runs.
    return [_one(inputs).copy()]


def run_operator(name: str, inputs: list[pd.DataFrame], params: dict) -> list[pd.DataFrame]:
    """Dispatch to a registered operator. Raises OperatorError for an unknown op."""
    op = OPERATORS.get(name)
    if op is None:
        raise OperatorError(f"no local implementation for operator {name!r}")
    return op(inputs, params or {})
