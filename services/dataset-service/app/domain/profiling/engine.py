"""Profile document generation (BRD §4.4, schema_version 2).

This is the reference profiler implementation used by the in-process
ProfilerRunner; the containerized `datacern/profiler` image ships the same
logic. Deterministic thresholds are pinned to profiler_version.

schema_version 2 (BRD 75 — profiling depth parity) adds, additively:

- per column: `entropy` (Shannon, base 2, over the non-null value distribution)
  and `top_values` (`[{value, count, pct}]`, K = `TOP_VALUES_K`);
- numeric columns only: `skewness` (Fisher-Pearson, as pandas `Series.skew`),
  `kurtosis` (**excess** kurtosis, as pandas `Series.kurt`), `variance`
  (sample, ddof=1) and `mad` (**mean** absolute deviation about the mean — the
  definition of the pandas ≤1.x `Series.mad()` V1's pandas-profiling reported;
  removed in pandas 2, so it is computed here);
- ordered columns (numeric + temporal) only: `monotonic`
  (`none|increasing|decreasing|strictly_increasing|strictly_decreasing`);
- `correlation_matrices` (NEW) is a LIST of matrices (`pearson`, `spearman`,
  `cramers_v`); `correlations` keeps its v1 `{method, pairs}` spearman shape so
  schema_version 2 stays additive
  instead of the single spearman matrix of schema_version 1.

Fields that do not apply to a column are **absent**, never zero, so a consumer
can tell "not applicable" from "actually zero". Fields that apply but are not
computable on the data at hand (variance of a single row, skew of two rows) are
likewise absent rather than null-filled.
"""

from __future__ import annotations

import html as html_mod
import json
import math
from datetime import datetime, timedelta
from typing import Any

import numpy as np
import pandas as pd

from app.domain.entities import ProfileErrorCategory
from app.domain.profiling.types import InferredType, infer_logical_type, infer_semantic

SCHEMA_VERSION = 2
MAX_HISTOGRAM_BINS = 50
TOP_VALUES_K = 10  # default K for top_values
MAX_TOP_VALUES = 20  # hard cap on a caller-supplied K
TOP_VALUE_TRUNCATE = 128
MAX_CORRELATION_PAIRS = 200
CORRELATION_MIN_ABS = 0.5
SUMMARY_MAX_BYTES = 64 * 1024

# Cramér's V is O(k1·k2) in the contingency table and O(n) per pair, so it runs
# only for low-cardinality categorical columns and under a pair budget. Columns
# above the cardinality cap are SKIPPED and reported as skipped — never faked.
CRAMERS_V_MAX_CARDINALITY = 50
CRAMERS_V_MAX_COLUMNS = 25
CRAMERS_V_MAX_PAIRS = 100

MONOTONIC_NONE = "none"

# The HTML artifact lists top values for at most this many columns; a 3000-column
# frame would otherwise render a megabyte of tables. profile.json keeps them all.
REPORT_MAX_TOP_COLUMNS = 100


class ProfilerError(Exception):
    def __init__(self, category: str, message: str):
        super().__init__(message)
        self.category = category
        self.message = message


def _py(value: Any) -> Any:
    """Numpy/pandas scalar -> JSON-safe python scalar."""
    if value is None:
        return None
    if isinstance(value, (np.integer,)):
        return int(value)
    if isinstance(value, (np.floating, float)):
        f = float(value)
        return None if math.isnan(f) or math.isinf(f) else round(f, 6)
    if isinstance(value, np.bool_):
        return bool(value)
    if isinstance(value, (pd.Timestamp, datetime)):
        return value.isoformat()
    return value


def _check_columns(df: pd.DataFrame) -> None:
    for col in df.columns:
        name = str(col).strip()
        if not name or name.lower().startswith("unnamed:"):
            raise ProfilerError(
                ProfileErrorCategory.UNNAMED_COLUMNS, f"unnamed column at position {col!r}"
            )


def _value_counts(values: pd.Series) -> pd.Series:
    """Frequency table of the (non-null) values, most frequent first.

    Falls back to the string rendering for columns holding unhashable objects
    (lists/dicts survive an Iceberg round trip as python objects) so a single
    odd column can never fail the whole profile.
    """
    try:
        return values.value_counts()
    except TypeError:
        return values.astype(str).value_counts()


def _entropy(counts: pd.Series) -> float:
    """Shannon entropy of the value distribution, in bits (log base 2)."""
    total = float(counts.sum())
    if total <= 0:
        return 0.0
    p = counts.to_numpy(dtype="float64") / total
    p = p[p > 0]
    return float(-(p * np.log2(p)).sum())


def _top_value(value: Any) -> Any:
    """JSON-safe rendering of a top-value key (strings truncated)."""
    rendered = _py(value)
    if rendered is None or isinstance(rendered, (bool, int, float)):
        return rendered
    return str(rendered)[:TOP_VALUE_TRUNCATE]


def _top_values(counts: pd.Series, non_null_count: int, k: int) -> list[dict]:
    return [
        {
            "value": _top_value(value),
            "count": int(count),
            "pct": round(int(count) / non_null_count * 100, 4) if non_null_count else 0.0,
        }
        for value, count in counts.head(k).items()
    ]


def _monotonic(values: pd.Series) -> str:
    """Monotonicity of an ordered column, in row order.

    A constant column is neither increasing nor decreasing (pandas reports it as
    both), so it reports `none` — same convention as pandas-profiling.
    """
    if len(values) < 2:
        return MONOTONIC_NONE
    increasing = bool(values.is_monotonic_increasing)
    decreasing = bool(values.is_monotonic_decreasing)
    if increasing == decreasing:  # constant (both) or unordered (neither)
        return MONOTONIC_NONE
    strict = int(values.nunique()) == len(values)
    if increasing:
        return "strictly_increasing" if strict else "increasing"
    return "strictly_decreasing" if strict else "decreasing"


def _numeric_stats(values: pd.Series) -> dict:
    if len(values) == 0:
        return {}
    q = values.quantile([0.05, 0.25, 0.5, 0.75, 0.95])
    stats = {
        "min": _py(values.min()),
        "max": _py(values.max()),
        "mean": _py(values.mean()),
        "stddev": _py(values.std()),
        "median": _py(q.loc[0.5]),
        "p5": _py(q.loc[0.05]),
        "p25": _py(q.loc[0.25]),
        "p75": _py(q.loc[0.75]),
        "p95": _py(q.loc[0.95]),
    }
    # Shape statistics — numeric-only, and only when defined on the rows at hand
    # (sample variance needs n≥2, skew n≥3, excess kurtosis n≥4; mad is defined
    # from n=1). An undefined one is omitted, never reported as 0.
    for key, raw in (
        ("variance", values.var()),
        ("skewness", values.skew()),
        ("kurtosis", values.kurt()),
        ("mad", (values - values.mean()).abs().mean()),
    ):
        value = _py(raw)
        if value is not None:
            stats[key] = value
    stats["monotonic"] = _monotonic(values)
    bins = min(MAX_HISTOGRAM_BINS, max(1, int(values.nunique())))
    counts, edges = np.histogram(values.to_numpy(dtype="float64"), bins=bins)
    stats["histogram"] = {
        "bins": [
            {"lo": _py(edges[i]), "hi": _py(edges[i + 1]), "count": int(counts[i])}
            for i in range(len(counts))
        ],
        "max_bins": MAX_HISTOGRAM_BINS,
    }
    return stats


def _temporal_stats(values: pd.Series, generated_at: datetime) -> tuple[dict, bool]:
    if len(values) == 0:
        return {}, False
    q = values.quantile([0.05, 0.25, 0.5, 0.75, 0.95])
    stats = {
        "min": _py(values.min()),
        "max": _py(values.max()),
        "median": _py(q.loc[0.5]),
        "p5": _py(q.loc[0.05]),
        "p25": _py(q.loc[0.25]),
        "p75": _py(q.loc[0.75]),
        "p95": _py(q.loc[0.95]),
        "monotonic": _monotonic(values),
    }
    gen = pd.Timestamp(generated_at)
    max_ts = values.max()
    if max_ts.tzinfo is None and gen.tzinfo is not None:
        gen = gen.tz_localize(None)
    elif max_ts.tzinfo is not None and gen.tzinfo is None:
        gen = gen.tz_localize("UTC")
    future = bool(max_ts > gen + timedelta(days=1))
    return stats, future


def _profile_column(
    name: str,
    series: pd.Series,
    inferred: InferredType,
    generated_at: datetime,
    top_k: int = TOP_VALUES_K,
) -> dict:
    total = len(series)
    non_null = series.dropna()
    null_count = int(total - len(non_null))
    null_pct = round(null_count / total * 100, 4) if total else 0.0
    distinct_count = int(non_null.nunique())
    distinct_pct = round(distinct_count / len(non_null) * 100, 4) if len(non_null) else 0.0
    is_unique = len(non_null) > 0 and distinct_count == len(non_null)

    col: dict[str, Any] = {
        "name": name,
        "logical_type": inferred.logical_type,
        "nullable": null_count > 0,
        "null_count": null_count,
        "null_pct": null_pct,
        "distinct_count": distinct_count,
        "distinct_pct": distinct_pct,
        "is_unique": is_unique,
        "tags": [],
        "quality_flags": [],
    }
    if inferred.coercion_hint:
        col["coercion_hint"] = inferred.coercion_hint

    # Distribution stats every column carries, computed once from the raw
    # (untyped) non-null values so `value` keeps its natural JSON type.
    counts = _value_counts(non_null) if len(non_null) else pd.Series(dtype="int64")
    col["entropy"] = _py(_entropy(counts))
    col["top_values"] = _top_values(counts, len(non_null), top_k)

    flags: list[str] = []
    avg_length: float | None = None
    future_dates = False

    numeric_like = inferred.logical_type in ("int", "long", "float", "double") or (
        inferred.logical_type.startswith("decimal")
    )

    if inferred.logical_type == "boolean":
        truthy = {"y", "t", "true", "1", "yes"}
        if pd.api.types.is_bool_dtype(series) or all(isinstance(v, bool) for v in non_null):
            true_count = int(non_null.astype(bool).sum())
        else:
            true_count = int(non_null.astype(str).str.strip().str.lower().isin(truthy).sum())
        col["true_count"] = true_count
        col["false_count"] = int(len(non_null) - true_count)
    elif numeric_like:
        if inferred.coerced is not None:
            values = inferred.coerced.dropna().astype(float)
        else:
            values = pd.to_numeric(non_null, errors="coerce").dropna().astype(float)
        col.update(_numeric_stats(values))
        if len(values) >= 4:
            q1, q3 = values.quantile(0.25), values.quantile(0.75)
            iqr = q3 - q1
            if iqr > 0:
                lo, hi = q1 - 3 * iqr, q3 + 3 * iqr
                frac = float(((values < lo) | (values > hi)).mean())
                if frac > 0.005:
                    flags.append("OUTLIERS_IQR")
            # Skewness is now an exposed statistic (schema_version 2) rather
            # than something computed only to raise this alert.
            skew = col.get("skewness")
            if skew is not None and abs(float(skew)) > 3:
                flags.append("SKEWED")
    elif inferred.logical_type in ("date", "timestamp"):
        if inferred.coerced is not None:
            values = inferred.coerced.dropna()
        else:
            values = pd.to_datetime(non_null, errors="coerce").dropna()
        stats, future_dates = _temporal_stats(values, generated_at)
        col.update(stats)
    else:  # string / categorical
        text = non_null.astype(str)
        if len(text):
            lengths = text.str.len()
            avg_length = float(lengths.mean())
            col["min_length"] = int(lengths.min())
            col["max_length"] = int(lengths.max())
            col["avg_length"] = round(avg_length, 4)

    semantic = infer_semantic(
        name,
        series,
        inferred.logical_type,
        is_unique=is_unique,
        avg_length=avg_length,
        distinct_pct=distinct_pct,
    )
    col["inferred_semantic"] = semantic

    # Quality flags (deterministic thresholds — BRD §4.4 table)
    if null_pct > 20:
        flags.append("HIGH_NULLS")
    if len(non_null) > 0 and distinct_count == 1:
        flags.append("CONSTANT")
    if distinct_pct > 95 and semantic != "id" and len(non_null) > 1:
        flags.append("MOSTLY_UNIQUE")
    if inferred.parse_fail_pct > 1:
        flags.append("MIXED_TYPES")
    if future_dates:
        flags.append("FUTURE_DATES")
    if semantic == "currency" and numeric_like:
        min_v = col.get("min")
        if min_v is not None and float(min_v) < 0:
            flags.append("NEGATIVE_IN_AMOUNT")

    col["quality_flags"] = sorted(set(flags))
    return col


def _matrix_pairs(corr: pd.DataFrame) -> list[list]:
    """Upper-triangle pairs of a correlation matrix, |r| >= threshold, bounded."""
    pairs: list[list] = []
    names = list(corr.columns)
    for i, a in enumerate(names):
        for b in names[i + 1 :]:
            r = corr.loc[a, b]
            if pd.notna(r) and abs(float(r)) >= CORRELATION_MIN_ABS:
                pairs.append([a, b, round(float(r), 4)])
    pairs.sort(key=lambda p: (-abs(p[2]), p[0], p[1]))
    return pairs[:MAX_CORRELATION_PAIRS]


def _cramers_v(a: pd.Series, b: pd.Series) -> float | None:
    """Bias-corrected Cramér's V (Bergsma 2013) over the contingency table.

    Returns None when the association is undefined for this pair (fewer than two
    observed categories on a side, or a correction that collapses the
    denominator) — the pair is then omitted, never reported as 0.
    """
    joint = pd.DataFrame({"a": a, "b": b}).dropna()
    n = len(joint)
    if n < 2:
        return None
    table = pd.crosstab(joint["a"], joint["b"])
    rows, cols = table.shape
    if rows < 2 or cols < 2:
        return None
    observed = table.to_numpy(dtype="float64")
    expected = np.outer(observed.sum(axis=1), observed.sum(axis=0)) / n
    if not np.all(expected > 0):
        return None
    chi2 = float((((observed - expected) ** 2) / expected).sum())
    phi2 = chi2 / n
    phi2corr = max(0.0, phi2 - (cols - 1) * (rows - 1) / (n - 1))
    rows_corr = rows - (rows - 1) ** 2 / (n - 1)
    cols_corr = cols - (cols - 1) ** 2 / (n - 1)
    denominator = min(rows_corr - 1, cols_corr - 1)
    if denominator <= 0:
        return None
    return float(np.sqrt(phi2corr / denominator))


def _categorical_association(df: pd.DataFrame, columns: list[dict]) -> dict:
    """Cramér's V matrix for categorical×categorical pairs.

    Only columns with 2..CRAMERS_V_MAX_CARDINALITY distinct values take part —
    the measure is O(k1·k2) in the contingency table, so high-cardinality
    columns are reported in `skipped_high_cardinality` and not computed at all.
    The number of columns and evaluated pairs is bounded too, keeping the pass
    O(pairs·rows) on a wide frame.
    """
    eligible: list[str] = []
    skipped: list[str] = []
    for c in columns:
        if c["logical_type"] not in ("string", "categorical", "boolean"):
            continue
        if c["name"] not in df.columns or c["distinct_count"] < 2:
            continue
        if c["distinct_count"] > CRAMERS_V_MAX_CARDINALITY:
            skipped.append(c["name"])
        else:
            eligible.append(c["name"])

    considered = eligible[:CRAMERS_V_MAX_COLUMNS]
    pairs: list[list] = []
    evaluated = 0
    for i, a in enumerate(considered):
        for b in considered[i + 1 :]:
            if evaluated >= CRAMERS_V_MAX_PAIRS:
                break
            evaluated += 1
            v = _cramers_v(df[a], df[b])
            if v is not None and v >= CORRELATION_MIN_ABS:
                pairs.append([a, b, round(v, 4)])
        if evaluated >= CRAMERS_V_MAX_PAIRS:
            break
    pairs.sort(key=lambda p: (-p[2], p[0], p[1]))
    return {
        "method": "cramers_v",
        "pairs": pairs[:MAX_CORRELATION_PAIRS],
        "max_cardinality": CRAMERS_V_MAX_CARDINALITY,
        "columns": considered,
        "skipped_high_cardinality": skipped,
    }


def _legacy_correlations(matrices: list[dict]) -> dict:
    """The schema_version 1 `correlations` value: the single spearman matrix.

    v1 emitted exactly `{method: "spearman", pairs: [...]}`. Keeping that key at
    that shape is what makes v2 additive rather than breaking — a consumer that
    never learned about `correlation_matrices` reads the same thing it always did.
    """
    for m in matrices:
        if m.get("method") == "spearman":
            return m
    return {"method": "spearman", "pairs": []}


def _correlations(df: pd.DataFrame, columns: list[dict]) -> list[dict]:
    """All correlation/association matrices (schema_version 2 — a LIST).

    pearson + spearman over the numeric columns (spearman via rank+pearson, no
    scipy dependency) and Cramér's V over the low-cardinality categoricals.
    Every matrix is present even when it has no qualifying pairs, so a consumer
    never has to guess whether a method ran.
    """
    numeric_names = [
        c["name"]
        for c in columns
        if c["logical_type"] in ("int", "long", "float", "double")
        or c["logical_type"].startswith("decimal")
    ]
    numeric_df = pd.DataFrame(
        {n: pd.to_numeric(df[n], errors="coerce") for n in numeric_names if n in df.columns}
    )
    pearson: list[list] = []
    spearman: list[list] = []
    if numeric_df.shape[1] >= 2:
        pearson = _matrix_pairs(numeric_df.corr())
        spearman = _matrix_pairs(numeric_df.rank().corr())
    return [
        {"method": "pearson", "pairs": pearson},
        {"method": "spearman", "pairs": spearman},
        _categorical_association(df, columns),
    ]


def _alerts(columns: list[dict]) -> list[dict]:
    alerts = []
    for col in columns:
        for flag in col["quality_flags"]:
            severity = "warn" if flag in ("HIGH_NULLS", "MIXED_TYPES", "FUTURE_DATES") else "info"
            detail = flag.replace("_", " ").lower()
            if flag == "HIGH_NULLS":
                detail = f"{col['null_pct']}% null"
            alerts.append(
                {"column": col["name"], "flag": flag, "severity": severity, "detail": detail}
            )
    return alerts


def profile_dataframe(
    df: pd.DataFrame,
    *,
    dataset_urn: str,
    version_no: int,
    profiler_version: str,
    generated_at: datetime,
    sample_strategy: str = "full",
    max_rows: int = 10_000_000,
    sample_seed: int = 42,
    total_bytes: int | None = None,
    top_k: int = TOP_VALUES_K,
) -> dict:
    """Produce the profile.json document (schema_version 2). Raises ProfilerError."""
    if len(df) == 0:
        raise ProfilerError(ProfileErrorCategory.EMPTY_DATA, "dataset has 0 rows")
    _check_columns(df)

    total_rows = len(df)
    if sample_strategy == "full" and total_rows > max_rows:
        sample_strategy = "reservoir"
    if sample_strategy == "reservoir" and total_rows > max_rows:
        try:
            fraction = max_rows / total_rows
            df = df.sample(n=max_rows, random_state=sample_seed)
        except Exception as exc:
            raise ProfilerError(ProfileErrorCategory.SAMPLING_FAILED, str(exc)) from exc
        sample = {"strategy": "reservoir", "fraction": round(fraction, 6), "seed": sample_seed}
    else:
        sample = {"strategy": "full", "fraction": 1.0, "seed": sample_seed}

    k = max(1, min(int(top_k), MAX_TOP_VALUES))
    columns = []
    for name in df.columns:
        series = df[name]
        inferred = infer_logical_type(series)
        columns.append(_profile_column(str(name), series, inferred, generated_at, k))

    dup_pct = round(float(df.duplicated().mean()) * 100, 4) if len(df) else 0.0
    matrices = _correlations(df, columns)
    doc = {
        "schema_version": SCHEMA_VERSION,
        "dataset_urn": dataset_urn,
        "version_no": version_no,
        "generated_at": generated_at.isoformat(),
        "profiler_version": profiler_version,
        "sample": sample,
        "table": {
            "row_count": int(total_rows),
            "column_count": int(df.shape[1]),
            "bytes": total_bytes,
            "duplicate_row_pct": dup_pct,
        },
        "columns": columns,
        # schema_version 2 adds the multi-method matrices ADDITIVELY: the
        # original `correlations` key keeps its v1 `{method, pairs}` shape so a
        # reader written against v1 still works on a v2 document, and every
        # method lives under the new `correlation_matrices`. Changing
        # `correlations` from a dict to a list was a silent break for any
        # consumer doing `doc["correlations"]["pairs"]`.
        "correlations": _legacy_correlations(matrices),
        "correlation_matrices": matrices,
    }
    doc["alerts"] = _alerts(columns)
    return doc


def build_summary(doc: dict) -> dict:
    """Headline stats only — the ≤64KB pointer summary stored in Postgres (BR-4)."""
    summary = {
        "table": doc["table"],
        "columns": [
            {
                "name": c["name"],
                "logical_type": c["logical_type"],
                "null_pct": c["null_pct"],
                "distinct_count": c["distinct_count"],
                "quality_flags": c["quality_flags"],
            }
            for c in doc["columns"]
        ],
        "alerts": doc["alerts"],
    }
    encoded = json.dumps(summary).encode()
    if len(encoded) > SUMMARY_MAX_BYTES:
        # Trim alerts first, then columns, until under the cap (no-blob rule).
        summary["alerts"] = summary["alerts"][:50]
        while len(json.dumps(summary).encode()) > SUMMARY_MAX_BYTES and summary["columns"]:
            summary["columns"] = summary["columns"][: max(1, len(summary["columns"]) // 2)]
            summary["columns_truncated"] = True
    return summary


_REPORT_CSS = (
    "body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;"
    "margin:2rem;color:#1b1b1b}"
    "table{border-collapse:collapse;margin-bottom:1rem;font-size:14px}"
    "td,th{border:1px solid #ccc;padding:4px 8px;text-align:left}"
    "th{background:#f3f4f6}"
    "h1{margin-bottom:.2rem}h2{margin-top:1.6rem}"
    "code{background:#f3f4f6;padding:0 3px}"
    ".muted{color:#666}"
)


def _cell(value: Any) -> str:
    """Table cell for an optional statistic — em dash when not applicable."""
    return "—" if value is None else html_mod.escape(str(value))


def _correlation_matrices(doc: dict) -> list[dict]:
    """The doc's correlation matrices as a list.

    v2 stores every method under `correlation_matrices` and keeps `correlations`
    at its v1 `{method, pairs}` shape. Older documents have only `correlations`,
    which may be that dict or — for profiles written by the brief window when v2
    made it a list — a list. All three are accepted.
    """
    matrices = doc.get("correlation_matrices")
    if matrices:
        return list(matrices)
    corr = doc.get("correlations")
    if isinstance(corr, dict):
        return [corr]
    return list(corr or [])


def render_html_report(doc: dict) -> str:
    """Self-contained static HTML rendering of the profile document.

    Deliberately not pandas-profiling: the document is already computed, so this
    is a template over it (no external CSS/JS/fonts — the artifact renders
    standalone from the object store).
    """
    esc = html_mod.escape
    rows = "".join(
        f"<tr><td>{esc(c['name'])}</td><td>{esc(c['logical_type'])}</td>"
        f"<td>{esc(str(c.get('inferred_semantic')))}</td><td>{c['null_pct']}%</td>"
        f"<td>{c['distinct_count']}</td>"
        f"<td>{esc(', '.join(c['quality_flags']) or '—')}</td></tr>"
        for c in doc["columns"]
    )
    stat_rows = "".join(
        f"<tr><td>{esc(c['name'])}</td><td>{_cell(c.get('entropy'))}</td>"
        f"<td>{_cell(c.get('skewness'))}</td><td>{_cell(c.get('kurtosis'))}</td>"
        f"<td>{_cell(c.get('mad'))}</td><td>{_cell(c.get('variance'))}</td>"
        f"<td>{_cell(c.get('monotonic'))}</td></tr>"
        for c in doc["columns"]
    )
    with_top = [c for c in doc["columns"] if c.get("top_values")]
    top_blocks = "".join(
        f"<h3>{esc(c['name'])}</h3><table><tr><th>value</th><th>count</th><th>%</th></tr>"
        + "".join(
            f"<tr><td>{esc(str(t['value']))}</td><td>{t['count']}</td>"
            f"<td>{t.get('pct', '—')}</td></tr>"
            for t in c["top_values"]
        )
        + "</table>"
        for c in with_top[:REPORT_MAX_TOP_COLUMNS]
    )
    if len(with_top) > REPORT_MAX_TOP_COLUMNS:
        top_blocks += (
            f"<p class='muted'>{len(with_top) - REPORT_MAX_TOP_COLUMNS} further columns "
            f"omitted from this section — see profile.json.</p>"
        )
    corr_blocks = ""
    for matrix in _correlation_matrices(doc):
        pairs = matrix.get("pairs") or []
        body = "".join(
            f"<tr><td>{esc(str(p[0]))}</td><td>{esc(str(p[1]))}</td><td>{p[2]}</td></tr>"
            for p in pairs
        )
        skipped = matrix.get("skipped_high_cardinality") or []
        note = (
            f"<p class='muted'>skipped above cardinality "
            f"{matrix.get('max_cardinality')}: {esc(', '.join(map(str, skipped)))}</p>"
            if skipped
            else ""
        )
        corr_blocks += (
            f"<h3>{esc(str(matrix.get('method')))}</h3>"
            + (
                f"<table><tr><th>a</th><th>b</th><th>value</th></tr>{body}</table>"
                if pairs
                else "<p class='muted'>no pairs above the reporting threshold</p>"
            )
            + note
        )
    alerts = "".join(
        f"<li><b>{esc(a['flag'])}</b> [{esc(a['severity'])}] "
        f"{esc(str(a.get('column')))}: {esc(a['detail'])}</li>"
        for a in doc["alerts"]
    )
    t = doc["table"]
    return (
        "<!doctype html><html><head><meta charset='utf-8'>"
        "<meta name='viewport' content='width=device-width,initial-scale=1'>"
        f"<title>Profile — {esc(doc['dataset_urn'])} v{doc['version_no']}</title>"
        f"<style>{_REPORT_CSS}</style></head><body>"
        f"<h1>Dataset profile</h1><p>{esc(doc['dataset_urn'])} · v{doc['version_no']} · "
        f"generated {esc(doc['generated_at'])} · {esc(doc['profiler_version'])} · "
        f"schema v{doc.get('schema_version')}</p>"
        f"<p>Rows: {t['row_count']} · Columns: {t['column_count']} · "
        f"Duplicate rows: {t['duplicate_row_pct']}%</p>"
        f"<h2>Columns</h2><table><tr><th>name</th><th>type</th><th>semantic</th>"
        f"<th>null %</th><th>distinct</th><th>flags</th></tr>{rows}</table>"
        f"<h2>Distribution statistics</h2><table><tr><th>name</th><th>entropy (bits)</th>"
        f"<th>skewness</th><th>kurtosis</th><th>mad</th><th>variance</th>"
        f"<th>monotonic</th></tr>{stat_rows}</table>"
        f"<h2>Top values</h2>{top_blocks or '<p class=muted>none</p>'}"
        f"<h2>Correlations</h2>{corr_blocks or '<p class=muted>none</p>'}"
        f"<h2>Alerts</h2><ul>{alerts or '<li>none</li>'}</ul>"
        "</body></html>"
    )
