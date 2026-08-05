"""Unit: profile generation on synthetic dataframes (DST-FR-021/022/025, §4.4).

Covers V1-parity type inference edge cases, semantics, quality flags, failure
taxonomy, and the 64KB summary cap.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime
from decimal import Decimal

import numpy as np
import pandas as pd
import pytest

from app.domain.profiling.engine import (
    CRAMERS_V_MAX_CARDINALITY,
    CRAMERS_V_MAX_COLUMNS,
    MAX_CORRELATION_PAIRS,
    MAX_TOP_VALUES,
    SCHEMA_VERSION,
    SUMMARY_MAX_BYTES,
    TOP_VALUES_K,
    ProfilerError,
    build_summary,
    profile_dataframe,
    render_html_report,
)
from app.domain.profiling.types import infer_logical_type

GEN_AT = datetime(2026, 7, 9, tzinfo=UTC)

# Fields that only make sense for a numeric column — they must be ABSENT (not
# zero, not null) everywhere else, so a consumer can tell "not applicable" from
# "actually zero" (BRD 75 AC-1).
NUMERIC_ONLY_FIELDS = ("skewness", "kurtosis", "mad", "variance")


def profile(df: pd.DataFrame, **kwargs) -> dict:
    return profile_dataframe(
        df,
        dataset_urn="wr:t1:dataset:dataset/d1",
        version_no=1,
        profiler_version="test/1",
        generated_at=GEN_AT,
        **kwargs,
    )


def col(doc: dict, name: str) -> dict:
    return next(c for c in doc["columns"] if c["name"] == name)


def matrix(doc: dict, method: str) -> dict:
    return next(m for m in doc["correlations"] if m["method"] == method)


class TestTypeInference:
    def test_native_dtypes(self):
        df = pd.DataFrame(
            {
                "flag": [True, False, True],
                "small": pd.Series([1, 2, 3], dtype="int64"),
                "big": pd.Series([2**40, 2**41, 2**42], dtype="int64"),
                "ratio": [0.5, 1.5, 2.5],
                "ts": pd.to_datetime(["2026-01-01 10:00", "2026-01-02 11:30",
                                      "2026-01-03 09:15"]),
                "day": pd.to_datetime(["2026-01-01", "2026-01-02", "2026-01-03"]),
            }
        )
        doc = profile(df)
        assert col(doc, "flag")["logical_type"] == "boolean"
        assert col(doc, "small")["logical_type"] == "int"
        assert col(doc, "big")["logical_type"] == "long"
        assert col(doc, "ratio")["logical_type"] == "double"
        assert col(doc, "ts")["logical_type"] == "timestamp"
        assert col(doc, "day")["logical_type"] == "date"

    @pytest.mark.parametrize(
        ("values", "hint"),
        [
            (["Y", "N", "y", "N"], "Y/N"),
            (["T", "F", "t", "f"], "T/F"),
            (["true", "FALSE", "True", "false"], "true/false"),
        ],
    )
    def test_boolean_like_strings_with_coercion_hint(self, values, hint):
        """DST-FR-025: boolean-like strings report boolean + coercion_hint."""
        doc = profile(pd.DataFrame({"active": values}))
        c = col(doc, "active")
        assert c["logical_type"] == "boolean"
        assert c["coercion_hint"] == hint
        assert c["true_count"] + c["false_count"] == len(values)

    def test_numeric_strings(self):
        doc = profile(pd.DataFrame({"n": ["1", "2", "3"], "d": ["1.5", "2.5", "0.5"]}))
        assert col(doc, "n")["logical_type"] == "int"
        assert col(doc, "d")["logical_type"] == "double"

    def test_decimal_objects(self):
        doc = profile(pd.DataFrame({"amt": [Decimal("12.30"), Decimal("100.05")]}))
        assert col(doc, "amt")["logical_type"] == "decimal(5,2)"

    def test_datetime_strings(self):
        doc = profile(
            pd.DataFrame({"when": ["2026-01-01T10:00:00", "2026-02-01T11:00:00",
                                   "2026-03-01T12:00:00"]})
        )
        assert col(doc, "when")["logical_type"] == "timestamp"

    def test_categorical_vs_string(self):
        n = 1000
        doc = profile(
            pd.DataFrame(
                {
                    "cat": (["red", "green", "blue"] * (n // 3) + ["red"])[:n],
                    "free": [f"value-{i}" for i in range(n)],
                }
            )
        )
        assert col(doc, "cat")["logical_type"] == "categorical"
        assert col(doc, "free")["logical_type"] == "string"

    def test_mixed_types_flagged(self):
        """>1% parse failures against the inferred type -> MIXED_TYPES."""
        values = [str(i) for i in range(97)] + ["oops", "bad", "nan?"]
        doc = profile(pd.DataFrame({"mostly_num": values}))
        c = col(doc, "mostly_num")
        assert c["logical_type"] in ("int", "long")
        assert "MIXED_TYPES" in c["quality_flags"]


class TestSemantics:
    def test_semantics(self):
        n = 20
        df = pd.DataFrame(
            {
                "user_id": range(n),
                "email": [f"user{i}@example.com" for i in range(n)],
                "homepage": [f"https://example.com/{i}" for i in range(n)],
                "phone_number": [f"+1 (555) 010-{1000 + i}" for i in range(n)],
                "country": ["US", "GB", "DE", "FR"] * (n // 4),
                "order_total": [10.5 + i for i in range(n)],
                "notes": [
                    f"Long free text description number {i} with plenty of words "
                    f"to push average length up beyond the threshold {i}"
                    for i in range(n)
                ],
            }
        )
        doc = profile(df)
        assert col(doc, "user_id")["inferred_semantic"] == "id"
        assert col(doc, "email")["inferred_semantic"] == "email"
        assert col(doc, "homepage")["inferred_semantic"] == "url"
        assert col(doc, "phone_number")["inferred_semantic"] == "phone"
        assert col(doc, "country")["inferred_semantic"] == "country"
        assert col(doc, "order_total")["inferred_semantic"] == "currency"
        assert col(doc, "notes")["inferred_semantic"] == "free_text"


class TestQualityFlags:
    def test_high_nulls_and_constant_and_mostly_unique(self):
        n = 100
        df = pd.DataFrame(
            {
                "sparse": [None] * 30 + list(range(70)),
                "fixed": ["same"] * n,
                "nearly_unique": [f"tok-{i}" for i in range(n)],
            }
        )
        doc = profile(df)
        assert "HIGH_NULLS" in col(doc, "sparse")["quality_flags"]
        assert col(doc, "sparse")["null_pct"] == 30.0
        assert "CONSTANT" in col(doc, "fixed")["quality_flags"]
        assert "MOSTLY_UNIQUE" in col(doc, "nearly_unique")["quality_flags"]

    def test_id_column_not_mostly_unique(self):
        doc = profile(pd.DataFrame({"customer_id": range(100)}))
        assert "MOSTLY_UNIQUE" not in col(doc, "customer_id")["quality_flags"]

    def test_outliers_and_skew(self):
        rng = np.random.default_rng(7)
        base = rng.normal(100, 5, 990).tolist()
        outliers = [10_000.0] * 10  # 1% > 0.5% threshold
        skewed = np.concatenate([rng.uniform(0, 1, 990), [10_000] * 10])
        doc = profile(pd.DataFrame({"with_outliers": base + outliers, "skewed": skewed}))
        assert "OUTLIERS_IQR" in col(doc, "with_outliers")["quality_flags"]
        assert "SKEWED" in col(doc, "skewed")["quality_flags"]

    def test_future_dates(self):
        doc = profile(
            pd.DataFrame({"seen_at": pd.to_datetime(["2026-01-01", "2027-06-01"])})
        )
        assert "FUTURE_DATES" in col(doc, "seen_at")["quality_flags"]

    def test_negative_in_amount(self):
        doc = profile(pd.DataFrame({"order_total": [10.0, -3.5, 22.0]}))
        c = col(doc, "order_total")
        assert c["inferred_semantic"] == "currency"
        assert "NEGATIVE_IN_AMOUNT" in c["quality_flags"]

    def test_alerts_generated_with_severity(self):
        doc = profile(pd.DataFrame({"sparse": [None] * 60 + list(range(40))}))
        alert = next(a for a in doc["alerts"] if a["flag"] == "HIGH_NULLS")
        assert alert["severity"] == "warn"
        assert alert["column"] == "sparse"
        assert "60.0% null" in alert["detail"]


class TestFailureTaxonomy:
    def test_empty_data(self):
        """AC-4 (engine tier): 0 rows -> EMPTY_DATA."""
        with pytest.raises(ProfilerError) as err:
            profile(pd.DataFrame({"a": pd.Series([], dtype="float64")}))
        assert err.value.category == "EMPTY_DATA"

    def test_unnamed_columns(self):
        with pytest.raises(ProfilerError) as err:
            profile(pd.DataFrame({"Unnamed: 0": [1, 2], "ok": [3, 4]}))
        assert err.value.category == "UNNAMED_COLUMNS"


class TestDocumentShape:
    def test_stats_histogram_topvalues(self):
        n = 500
        df = pd.DataFrame(
            {
                "value": np.arange(n, dtype="float64"),
                "word": (["alpha", "beta"] * (n // 2)),
                "long_text": ["x" * 300] * n,
            }
        )
        doc = profile(df)
        v = col(doc, "value")
        for stat in ("min", "max", "mean", "stddev", "median", "p5", "p25", "p75", "p95"):
            assert v[stat] is not None
        assert len(v["histogram"]["bins"]) <= 50
        assert sum(b["count"] for b in v["histogram"]["bins"]) == n
        w = col(doc, "word")
        assert len(w["top_values"]) <= 20
        assert all(len(t["value"]) <= 128 for t in col(doc, "long_text")["top_values"])
        assert doc["table"]["row_count"] == n
        assert doc["table"]["column_count"] == 3
        assert doc["sample"] == {"strategy": "full", "fraction": 1.0, "seed": 42}
        assert json.dumps(doc)  # JSON-serializable (no numpy scalars)

    def test_duplicate_row_pct(self):
        doc = profile(pd.DataFrame({"a": [1, 1, 2, 3], "b": ["x", "x", "y", "z"]}))
        assert doc["table"]["duplicate_row_pct"] == 25.0

    def test_correlations_spearman(self):
        n = 200
        x = np.arange(n, dtype="float64")
        rng = np.random.default_rng(3)
        doc = profile(
            pd.DataFrame({"x": x, "y": x * 2 + 1, "noise": rng.normal(size=n)})
        )
        spearman = matrix(doc, "spearman")
        pair = next(p for p in spearman["pairs"] if {p[0], p[1]} == {"x", "y"})
        assert pair[2] == pytest.approx(1.0)

    def test_sampling_deterministic(self):
        df = pd.DataFrame({"v": np.arange(1000, dtype="float64")})
        d1 = profile(df, max_rows=100)
        d2 = profile(df, max_rows=100)
        assert d1["sample"]["strategy"] == "reservoir"
        assert d1["sample"]["fraction"] == 0.1
        assert d1["columns"] == d2["columns"]  # same seed -> same sample

    def test_summary_capped_at_64kb(self):
        """BR-4 / MASTER-FR-061: pointer summary stays under 64KB."""
        cols = {f"column_with_a_rather_long_name_{i:04d}": ["v"] * 2 for i in range(3000)}
        doc = profile(pd.DataFrame(cols))
        summary = build_summary(doc)
        assert len(json.dumps(summary).encode()) <= SUMMARY_MAX_BYTES

    def test_html_report_renders(self):
        doc = profile(pd.DataFrame({"a": [1, 2, 3]}))
        html = render_html_report(doc)
        assert "<html" in html and "wr:t1:dataset:dataset/d1" in html


def test_infer_handles_all_null_column():
    inferred = infer_logical_type(pd.Series([None, None], dtype="object"))
    assert inferred.logical_type == "string"


# ---------------------------------------------------------------------------
# BRD 75 — profiling depth parity (schema_version 2)
# ---------------------------------------------------------------------------


class TestRicherColumnStatistics:
    """AC-1 / AC-2: shape statistics, entropy and top values."""

    def test_ac1_numeric_columns_carry_shape_statistics(self):
        doc = profile(pd.DataFrame({"v": [1.0, 2.0, 3.0, 4.0]}))
        v = col(doc, "v")
        # variance is the sample variance (ddof=1) of 1..4; mad is the MEAN
        # absolute deviation about the mean (pandas <=1.x Series.mad, which is
        # what V1's pandas-profiling reported).
        assert v["variance"] == pytest.approx(1.666667, abs=1e-5)
        assert v["mad"] == pytest.approx(1.0)
        assert v["skewness"] == pytest.approx(0.0, abs=1e-9)
        assert v["kurtosis"] == pytest.approx(-1.2, abs=1e-3)  # excess kurtosis

    def test_ac1_skewness_now_exposed_not_only_alerted(self):
        """The engine used to compute skew solely to raise SKEWED; it is now a
        first-class statistic AND still drives the flag."""
        skewed = np.concatenate([np.zeros(990), np.full(10, 10_000.0)])
        doc = profile(pd.DataFrame({"s": skewed}))
        c = col(doc, "s")
        assert c["skewness"] > 3
        assert "SKEWED" in c["quality_flags"]

    def test_ac1_numeric_only_fields_absent_on_non_numeric_columns(self):
        df = pd.DataFrame(
            {
                "num": [1.0, 2.0, 3.0, 4.0],
                "word": ["a", "b", "a", "c"],
                "flag": [True, False, True, True],
                "day": pd.to_datetime(["2026-01-01", "2026-01-02", "2026-01-03",
                                       "2026-01-04"]),
                "cat": ["x", "y", "x", "y"],
            }
        )
        doc = profile(df)
        for field in NUMERIC_ONLY_FIELDS:
            assert field in col(doc, "num")
            for name in ("word", "flag", "day", "cat"):
                assert field not in col(doc, name), f"{field} leaked onto {name}"

    def test_ac1_undefined_shape_statistics_are_omitted_not_zeroed(self):
        """A single row has no sample variance/skew/kurtosis — the keys are
        absent rather than reported as 0."""
        doc = profile(pd.DataFrame({"v": [7.0]}))
        v = col(doc, "v")
        assert v["mad"] == 0.0  # defined: |7-7| = 0
        for field in ("variance", "skewness", "kurtosis"):
            assert field not in v

    def test_ac2_entropy_on_every_column(self):
        df = pd.DataFrame(
            {
                "uniform4": ["a", "b", "c", "d"],  # 4 equiprobable -> 2 bits
                "constant": ["z", "z", "z", "z"],  # no information -> 0 bits
                "num": [1.0, 2.0, 3.0, 4.0],
                "day": pd.to_datetime(["2026-01-01", "2026-01-02", "2026-01-03",
                                       "2026-01-04"]),
            }
        )
        doc = profile(df)
        assert all("entropy" in c for c in doc["columns"])
        assert col(doc, "uniform4")["entropy"] == pytest.approx(2.0)
        assert col(doc, "constant")["entropy"] == 0.0
        assert col(doc, "num")["entropy"] == pytest.approx(2.0)
        assert col(doc, "day")["entropy"] == pytest.approx(2.0)

    def test_ac2_top_values_counts_and_pcts(self):
        values = ["a"] * 50 + ["b"] * 30 + ["c"] * 20
        doc = profile(pd.DataFrame({"letter": values}))
        top = col(doc, "letter")["top_values"]
        assert [t["value"] for t in top] == ["a", "b", "c"]
        assert [t["count"] for t in top] == [50, 30, 20]
        assert [t["pct"] for t in top] == [50.0, 30.0, 20.0]
        assert sum(t["pct"] for t in top) == pytest.approx(100.0)

    def test_ac2_top_values_pct_is_of_non_null_rows(self):
        doc = profile(pd.DataFrame({"letter": ["a"] * 30 + [None] * 70}))
        top = col(doc, "letter")["top_values"]
        assert top == [{"value": "a", "count": 30, "pct": 100.0}]

    def test_ac2_top_values_bounded_by_k(self):
        doc = profile(pd.DataFrame({"tok": [f"t{i}" for i in range(100)]}))
        assert len(col(doc, "tok")["top_values"]) == TOP_VALUES_K

    def test_ac2_top_k_is_capped(self):
        doc = profile(pd.DataFrame({"tok": [f"t{i}" for i in range(100)]}), top_k=1000)
        assert len(col(doc, "tok")["top_values"]) == MAX_TOP_VALUES

    def test_ac2_top_values_present_for_every_column_type(self):
        df = pd.DataFrame(
            {
                "num": [1.0, 1.0, 2.0],
                "flag": [True, True, False],
                "day": pd.to_datetime(["2026-01-01", "2026-01-01", "2026-01-02"]),
                "word": ["a", "a", "b"],
            }
        )
        doc = profile(df)
        for c in doc["columns"]:
            assert c["top_values"], f"{c['name']} has no top_values"
            assert c["top_values"][0]["count"] == 2
        # temporal top values render as ISO strings (JSON-safe)
        assert col(doc, "day")["top_values"][0]["value"] == "2026-01-01T00:00:00"
        assert json.dumps(doc)

    def test_ac2_all_null_column_has_zero_entropy_and_no_top_values(self):
        doc = profile(pd.DataFrame({"a": [1, 2], "empty": [None, None]}))
        c = col(doc, "empty")
        assert c["entropy"] == 0.0
        assert c["top_values"] == []


class TestMonotonicity:
    """AC-3."""

    @pytest.mark.parametrize(
        ("values", "expected"),
        [
            ([1.0, 2.0, 3.0, 4.0], "strictly_increasing"),
            ([1.0, 1.0, 2.0, 3.0], "increasing"),
            ([4.0, 3.0, 2.0, 1.0], "strictly_decreasing"),
            ([4.0, 4.0, 3.0, 2.0], "decreasing"),
            ([2.0, 1.0, 3.0, 0.5], "none"),
            ([5.0, 5.0, 5.0, 5.0], "none"),  # constant is neither
        ],
    )
    def test_ac3_monotonic_numeric(self, values, expected):
        doc = profile(pd.DataFrame({"v": values}))
        assert col(doc, "v")["monotonic"] == expected

    def test_ac3_monotonic_temporal(self):
        df = pd.DataFrame(
            {
                "up": pd.to_datetime(["2026-01-01", "2026-02-01", "2026-03-01"]),
                "jumbled": pd.to_datetime(["2026-02-01", "2026-01-01", "2026-03-01"]),
            }
        )
        doc = profile(df)
        assert col(doc, "up")["monotonic"] == "strictly_increasing"
        assert col(doc, "jumbled")["monotonic"] == "none"

    def test_ac3_monotonic_absent_for_unordered_types(self):
        doc = profile(pd.DataFrame({"word": ["a", "b", "c"], "flag": [True, False, True]}))
        assert "monotonic" not in col(doc, "word")
        assert "monotonic" not in col(doc, "flag")


class TestCorrelationMatrices:
    """AC-4 / AC-5."""

    def test_ac4_pearson_and_spearman_both_present(self):
        n = 200
        x = np.arange(1, n + 1, dtype="float64")
        doc = profile(pd.DataFrame({"x": x, "linear": x * 3 - 4, "cubed": x**3}))
        assert [m["method"] for m in doc["correlations"]] == [
            "pearson", "spearman", "cramers_v",
        ]
        pearson, spearman = matrix(doc, "pearson"), matrix(doc, "spearman")
        lin_p = next(p for p in pearson["pairs"] if {p[0], p[1]} == {"x", "linear"})
        assert lin_p[2] == pytest.approx(1.0)
        # a monotonic-but-non-linear relation separates the two methods: rank
        # correlation is exactly 1, pearson is not.
        cube_p = next(p for p in pearson["pairs"] if {p[0], p[1]} == {"x", "cubed"})
        cube_s = next(p for p in spearman["pairs"] if {p[0], p[1]} == {"x", "cubed"})
        assert cube_s[2] == pytest.approx(1.0)
        assert cube_p[2] < 1.0

    def test_ac4_matrices_present_even_without_numeric_columns(self):
        doc = profile(pd.DataFrame({"word": ["a", "b", "a"]}))
        assert matrix(doc, "pearson")["pairs"] == []
        assert matrix(doc, "spearman")["pairs"] == []

    def test_ac4_pairs_bounded(self):
        """40 mutually correlated columns => 780 candidate pairs, capped."""
        n = 60
        rng = np.random.default_rng(11)
        base = rng.normal(size=n)
        df = pd.DataFrame(
            {f"c{i}": base + rng.normal(scale=0.01, size=n) for i in range(40)}
        )
        doc = profile(df)
        for method in ("pearson", "spearman"):
            pairs = matrix(doc, method)["pairs"]
            assert len(pairs) == MAX_CORRELATION_PAIRS
            assert all(abs(p[2]) >= abs(pairs[-1][2]) for p in pairs)  # sorted desc

    def test_ac5_cramers_v_for_categorical_pairs(self):
        n = 300
        left = ["a", "b", "c"] * (n // 3)
        doc = profile(
            pd.DataFrame(
                {
                    "left": left,
                    "mirror": [v.upper() for v in left],  # perfect association
                    "independent": [("x", "y")[i % 2] for i in range(n)],
                }
            )
        )
        cramers = matrix(doc, "cramers_v")
        pair = next(p for p in cramers["pairs"] if {p[0], p[1]} == {"left", "mirror"})
        assert pair[2] == pytest.approx(1.0, abs=1e-3)
        assert not [p for p in cramers["pairs"] if "independent" in (p[0], p[1])]

    def test_ac5_high_cardinality_columns_skipped_not_faked(self):
        n = CRAMERS_V_MAX_CARDINALITY * 4
        wide = [f"k{i}" for i in range(n)]  # cardinality n > cap
        doc = profile(
            pd.DataFrame(
                {
                    "wide": wide,
                    "wide_mirror": [v.upper() for v in wide],
                    "small": ["a", "b"] * (n // 2),
                }
            )
        )
        cramers = matrix(doc, "cramers_v")
        assert cramers["max_cardinality"] == CRAMERS_V_MAX_CARDINALITY
        assert set(cramers["skipped_high_cardinality"]) == {"wide", "wide_mirror"}
        # skipped means NOT computed — no fabricated value for the pair that
        # would (trivially) have been a perfect association.
        assert all(
            "wide" not in (p[0], p[1]) and "wide_mirror" not in (p[0], p[1])
            for p in cramers["pairs"]
        )

    def test_ac5_cramers_v_column_budget_bounds_a_wide_frame(self):
        df = pd.DataFrame({f"c{i}": ["a", "b", "c"] * 10 for i in range(60)})
        doc = profile(df)
        cramers = matrix(doc, "cramers_v")
        assert len(cramers["columns"]) == CRAMERS_V_MAX_COLUMNS
        assert len(cramers["pairs"]) <= MAX_CORRELATION_PAIRS


class TestReproducibilityAndCompatibility:
    """AC-6 / AC-7."""

    def test_ac6_profile_reproducible_under_the_seed(self):
        rng = np.random.default_rng(5)
        df = pd.DataFrame(
            {
                "v": rng.normal(size=2000),
                "w": rng.normal(size=2000),
                "cat": [("a", "b", "c")[i % 3] for i in range(2000)],
            }
        )
        first = profile(df, max_rows=500)
        second = profile(df, max_rows=500)
        assert first["sample"]["strategy"] == "reservoir"
        assert first == second
        assert first["correlations"] == second["correlations"]

    def test_ac7_schema_version_bumped(self):
        doc = profile(pd.DataFrame({"a": [1, 2, 3]}))
        assert doc["schema_version"] == SCHEMA_VERSION == 2

    def test_ac7_old_schema_v1_profile_still_deserializes(self):
        """A profile stored under schema_version 1 (no entropy/top_values/shape
        stats, correlations a single dict) must still load and render."""
        old = json.loads(json.dumps(SCHEMA_V1_DOC))
        summary = build_summary(old)
        assert summary["table"]["row_count"] == 3
        assert [c["name"] for c in summary["columns"]] == ["amount", "region"]
        assert summary["alerts"][0]["flag"] == "HIGH_NULLS"
        html = render_html_report(old)
        assert "<html" in html
        assert "spearman" in html  # the v1 single-matrix dict still renders

    def test_ac7_new_fields_are_additive(self):
        """Every schema_version 1 key survives the bump."""
        doc = profile(pd.DataFrame({"amount": [1.0, 2.0, 3.0], "region": ["x", "y", "x"]}))
        assert set(SCHEMA_V1_DOC).issubset(doc)
        for name in ("amount", "region"):
            v1_keys = set(next(c for c in SCHEMA_V1_DOC["columns"] if c["name"] == name))
            assert v1_keys.issubset(col(doc, name))


class TestReportArtifact:
    """AC-8 / AC-9."""

    def test_ac8_html_artifact_is_self_contained_and_carries_new_stats(self):
        n = 60
        df = pd.DataFrame(
            {
                "amount": np.arange(n, dtype="float64"),
                "region": [("emea", "amer", "apac")[i % 3] for i in range(n)],
            }
        )
        doc = profile(df)
        html = render_html_report(doc)
        assert html.startswith("<!doctype html>") and html.rstrip().endswith("</html>")
        # self-contained: no external stylesheet/script/font/image references
        for marker in ("<script", "src=", "href=", "@import", "http://", "https://"):
            assert marker not in html.lower()
        for section in ("Distribution statistics", "Top values", "Correlations",
                        "entropy", "skewness", "kurtosis", "monotonic"):
            assert section in html
        assert "emea" in html  # a real top value made it into the artifact

    def test_ac9_wide_frame_stays_within_budget(self):
        """The new statistics must not turn a wide frame into a slow profile:
        200 columns x 400 rows, mixed types, well inside the profile budget."""
        import time

        n = 400
        rng = np.random.default_rng(2)
        data: dict[str, list] = {}
        for i in range(100):
            data[f"num_{i}"] = rng.normal(size=n)
            data[f"cat_{i}"] = [f"v{j % 8}" for j in range(n)]
        df = pd.DataFrame(data)
        started = time.monotonic()
        doc = profile(df)
        elapsed = time.monotonic() - started
        assert elapsed < 60, f"wide-frame profile took {elapsed:.1f}s"
        assert doc["table"]["column_count"] == 200
        assert len(matrix(doc, "cramers_v")["columns"]) == CRAMERS_V_MAX_COLUMNS


# A profile document exactly as schema_version 1 wrote it (pre-BRD-75): no
# entropy, no top_values pct, no shape statistics, correlations a single dict.
SCHEMA_V1_DOC = {
    "schema_version": 1,
    "dataset_urn": "wr:t1:dataset:dataset/legacy",
    "version_no": 3,
    "generated_at": "2026-05-01T00:00:00+00:00",
    "profiler_version": "profiler/0.9",
    "sample": {"strategy": "full", "fraction": 1.0, "seed": 42},
    "table": {"row_count": 3, "column_count": 2, "bytes": 128, "duplicate_row_pct": 0.0},
    "columns": [
        {
            "name": "amount",
            "logical_type": "double",
            "nullable": True,
            "null_count": 1,
            "null_pct": 33.3333,
            "distinct_count": 2,
            "distinct_pct": 100.0,
            "is_unique": True,
            "tags": [],
            "quality_flags": ["HIGH_NULLS"],
            "min": 1.0,
            "max": 2.0,
            "mean": 1.5,
            "stddev": 0.7071,
            "median": 1.5,
            "p5": 1.05,
            "p25": 1.25,
            "p75": 1.75,
            "p95": 1.95,
            "histogram": {"bins": [{"lo": 1.0, "hi": 2.0, "count": 2}], "max_bins": 50},
            "inferred_semantic": None,
        },
        {
            "name": "region",
            "logical_type": "categorical",
            "nullable": False,
            "null_count": 0,
            "null_pct": 0.0,
            "distinct_count": 2,
            "distinct_pct": 66.6667,
            "is_unique": False,
            "tags": [],
            "quality_flags": [],
            "min_length": 4,
            "max_length": 4,
            "avg_length": 4.0,
            "top_values": [{"value": "emea", "count": 2}, {"value": "amer", "count": 1}],
            "inferred_semantic": None,
        },
    ],
    "correlations": {"method": "spearman", "pairs": []},
    "alerts": [
        {"column": "amount", "flag": "HIGH_NULLS", "severity": "warn",
         "detail": "33.3333% null"},
    ],
}
