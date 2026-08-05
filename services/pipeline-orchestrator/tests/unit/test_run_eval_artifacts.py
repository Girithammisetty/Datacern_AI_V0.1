"""BRD 72 inc3 — the evaluation artifacts the RUN CHARTS render.

chart-service has always catalogued `roc_curve`, `confusion_matrix` and
`decision_tree` (ClassRun), but nothing produced the data they draw: the executor
logged a flattened confusion matrix and a SCALAR `roc_auc`, and no curve points or
tree structure at all. A renderer built on top of that would have had to invent
its data, so these come first.

Everything asserted here is computed from a real sklearn fit — no fixtures stand in
for model output.
"""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest
from sklearn.model_selection import train_test_split

from app.executor.local import (
    EVAL_ARTIFACT_PATH,
    MAX_ROC_POINTS,
    MAX_TREE_DEPTH,
    LocalTrainingExecutor,
    _build_estimator,
    _tree_structure,
)


def _xy(n=200, seed=0):
    rng = np.random.default_rng(seed)
    X = pd.DataFrame(rng.normal(size=(n, 5)), columns=[f"f{i}" for i in range(5)])
    y = (X["f0"] + X["f1"] > 0).astype(int).to_numpy()
    return X, y


def _fit(algorithm="random_forest", params=None, family="classification", n=200, seed=0):
    """Run a real fit and return (metrics, fitted, artifacts)."""
    ex = LocalTrainingExecutor(tracking_uri="file:///tmp/does-not-matter")
    X, y = _xy(n, seed)
    if family == "regression":
        y = X["f0"] * 3 - X["f1"] * 2
    artifacts: dict = {}
    metrics, fitted = ex._fit_and_score(
        _build_estimator(algorithm, params or {}), X, pd.Series(y), family,
        train_test_split, params={}, algorithm=algorithm, artifacts=artifacts)
    return metrics, fitted, artifacts


# ---------------------------------------------------------------------------
# Opt-in contract
# ---------------------------------------------------------------------------

def test_artifacts_are_only_collected_when_asked_for():
    # The 2-tuple return is unchanged, so every existing caller is unaffected.
    ex = LocalTrainingExecutor(tracking_uri="file:///tmp/x")
    X, y = _xy()
    out = ex._fit_and_score(_build_estimator("random_forest", {"n_estimators": 10}),
                            X, pd.Series(y), "classification", train_test_split,
                            params={}, algorithm="random_forest")
    assert len(out) == 2


def test_eval_artifact_path_is_the_cross_service_contract():
    # experiment-service reads this exact path to serve the run artifact.
    assert EVAL_ARTIFACT_PATH == "evaluation.json"


# ---------------------------------------------------------------------------
# ROC curve
# ---------------------------------------------------------------------------

def test_roc_curve_points_are_produced_for_a_binary_classifier():
    metrics, _, art = _fit(params={"n_estimators": 20})
    assert "roc_auc" in metrics, "the scalar must still be logged"
    roc = art["roc_curve"]
    assert len(roc["points"]) >= 2


def test_roc_curve_is_monotonic_and_spans_the_unit_square():
    _, _, art = _fit(params={"n_estimators": 20})
    pts = art["roc_curve"]["points"]
    fpr = [p["fpr"] for p in pts]
    tpr = [p["tpr"] for p in pts]
    # A real ROC curve starts at (0,0), ends at (1,1) and never decreases.
    assert fpr[0] == 0.0 and tpr[0] == 0.0
    assert fpr[-1] == 1.0 and tpr[-1] == 1.0
    assert fpr == sorted(fpr) and tpr == sorted(tpr)


def test_roc_curve_names_the_positive_label_it_scored():
    # predict_proba[:, 1] scores the SECOND class; without recording which class
    # that is, a rendered curve cannot say what it is the ROC *of*.
    _, fitted, art = _fit(params={"n_estimators": 20})
    assert art["roc_curve"]["positive_label"] == str(fitted.classes_[1])


def test_roc_curve_is_downsampled_to_a_bounded_point_count():
    # sklearn returns one threshold per distinct score, so a large test split
    # would otherwise put thousands of points in every run's artifact.
    _, _, art = _fit(params={"n_estimators": 50}, n=2000)
    pts = art["roc_curve"]["points"]
    assert len(pts) <= MAX_ROC_POINTS + 2  # +endpoints
    assert pts[0]["fpr"] == 0.0 and pts[-1]["fpr"] == 1.0


def test_roc_curve_drops_the_infinite_first_threshold():
    # sklearn's first threshold is +inf (the "predict nothing" corner). JSON has
    # no infinity, so it must not be serialized as a value a reader would trust.
    _, _, art = _fit(params={"n_estimators": 20})
    assert "threshold" not in art["roc_curve"]["points"][0]
    assert all(np.isfinite(p["threshold"]) for p in art["roc_curve"]["points"] if "threshold" in p)


def test_no_roc_curve_for_a_multiclass_fit():
    # roc_auc/ROC is only computed for the binary case; the artifact must not
    # claim a curve that was never computed.
    ex = LocalTrainingExecutor(tracking_uri="file:///tmp/x")
    rng = np.random.default_rng(5)
    X = pd.DataFrame(rng.normal(size=(150, 3)), columns=list("abc"))
    y = pd.Series(rng.integers(0, 3, 150).astype(str))
    art: dict = {}
    ex._fit_and_score(_build_estimator("random_forest", {"n_estimators": 10}), X, y,
                      "classification", train_test_split, params={},
                      algorithm="random_forest", artifacts=art)
    assert "roc_curve" not in art
    assert "confusion_matrix" in art  # this one IS defined for multiclass


# ---------------------------------------------------------------------------
# Confusion matrix
# ---------------------------------------------------------------------------

def test_confusion_matrix_is_labelled_and_square():
    _, fitted, art = _fit(params={"n_estimators": 20})
    cm = art["confusion_matrix"]
    labels = cm["labels"]
    assert labels == [str(c) for c in fitted.classes_]
    assert len(cm["matrix"]) == len(labels)
    assert all(len(row) == len(labels) for row in cm["matrix"])


def test_confusion_matrix_cells_sum_to_the_test_row_count():
    metrics, _, art = _fit(params={"n_estimators": 20})
    total = sum(sum(row) for row in art["confusion_matrix"]["matrix"])
    assert total == int(metrics["test_rows"])


def test_matrix_agrees_with_the_flattened_cm_metrics():
    # The flattened cm_{i}_{j} metrics and the labelled matrix must describe the
    # same matrix — they are pinned to classes_ order precisely so they agree
    # even when a class is missing from the test split.
    metrics, _, art = _fit(params={"n_estimators": 20})
    matrix = art["confusion_matrix"]["matrix"]
    for i, row in enumerate(matrix):
        for j, v in enumerate(row):
            assert metrics[f"cm_{i}_{j}"] == float(v)


def test_labels_survive_a_class_absent_from_the_test_split():
    # A rare third class can vanish from the split. Pinning labels=classes_ keeps
    # the matrix square and the label list aligned; without it sklearn would
    # return a smaller matrix and the indices would silently shift.
    ex = LocalTrainingExecutor(tracking_uri="file:///tmp/x")
    rng = np.random.default_rng(7)
    X = pd.DataFrame(rng.normal(size=(120, 3)), columns=list("abc"))
    y = pd.Series(["a"] * 59 + ["b"] * 59 + ["c"] * 2)
    art: dict = {}
    ex._fit_and_score(_build_estimator("decision_tree", {}), X, y, "classification",
                      train_test_split, params={}, algorithm="decision_tree",
                      artifacts=art)
    cm = art["confusion_matrix"]
    assert cm["labels"] == ["a", "b", "c"]
    assert len(cm["matrix"]) == 3


# ---------------------------------------------------------------------------
# Decision tree
# ---------------------------------------------------------------------------

def test_decision_tree_structure_is_exported_with_real_split_conditions():
    _, _, art = _fit(algorithm="decision_tree", params={"max_depth": 3})
    tree = art["tree"]
    root = tree["root"]
    assert root["leaf"] is False
    assert root["feature"] in [f"f{i}" for i in range(5)]
    assert isinstance(root["threshold"], float)
    assert len(root["children"]) == 2
    assert tree["node_count"] >= 3


def test_leaves_carry_the_predicted_class_name():
    _, fitted, art = _fit(algorithm="decision_tree", params={"max_depth": 2})

    def leaves(n):
        return [n] if n["leaf"] else [x for c in n["children"] for x in leaves(c)]

    preds = {leaf["prediction"] for leaf in leaves(art["tree"]["root"])}
    assert preds <= {str(c) for c in fitted.classes_}


def test_samples_split_between_children():
    _, _, art = _fit(algorithm="decision_tree", params={"max_depth": 3})
    root = art["tree"]["root"]
    left, right = root["children"]
    assert left["samples"] + right["samples"] == root["samples"]


def test_a_deep_tree_is_depth_bounded_and_says_so():
    # An unbounded export of a depth-20 tree is ~10^6 nodes: unusable, and it
    # bloats every run's artifact. Truncation must be VISIBLE, not silent.
    _, _, art = _fit(algorithm="decision_tree", params={"max_depth": 20}, n=3000)
    tree = art["tree"]

    def depth(n):
        return 0 if n["leaf"] or "children" not in n else 1 + max(depth(c) for c in n["children"])

    assert depth(tree["root"]) <= MAX_TREE_DEPTH
    if tree["node_count"] > 2 ** (MAX_TREE_DEPTH + 1):
        assert tree.get("truncated") is True


def test_a_regressor_tree_is_exported_with_numeric_leaf_predictions():
    _, _, art = _fit(algorithm="decision_tree_regressor", params={"max_depth": 3},
                     family="regression")
    root = art["tree"]["root"]

    def leaves(n):
        return [n] if n["leaf"] else [x for c in n["children"] for x in leaves(c)]

    assert all(isinstance(leaf["prediction"], float) for leaf in leaves(root))


def test_no_tree_is_exported_for_a_forest():
    # A random forest has hundreds of trees and no single one explains the model,
    # so exporting tree 0 would be a misleading answer dressed as authoritative.
    _, _, art = _fit(algorithm="random_forest", params={"n_estimators": 10})
    assert "tree" not in art


@pytest.mark.parametrize("obj", [object(), None, "not-an-estimator"])
def test_tree_structure_returns_none_for_a_non_tree(obj):
    assert _tree_structure(obj, ["a"], []) is None
