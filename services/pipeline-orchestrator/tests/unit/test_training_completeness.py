"""BRD 63 — classic-ML training completeness: real HPO (grid/random + CV, M1/M5),
wrapper feature selection (M6), real LightGBM (M4), regularized linear (M8), and the
richer per-family eval metric set (M7). Pure sklearn/xgboost/lightgbm — no infra.
"""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest
from sklearn.model_selection import train_test_split

from app.executor import tuning
from app.executor.local import LocalTrainingExecutor, _build_estimator


def _classification_xy(n=200, seed=0):
    rng = np.random.default_rng(seed)
    X = pd.DataFrame(rng.normal(size=(n, 5)), columns=[f"f{i}" for i in range(5)])
    y = (X["f0"] + X["f1"] > 0).astype(int).to_numpy()
    return X, y


def _regression_xy(n=200, seed=1):
    rng = np.random.default_rng(seed)
    X = pd.DataFrame(rng.normal(size=(n, 4)), columns=[f"f{i}" for i in range(4)])
    y = (3 * X["f0"] - 2 * X["f1"] + rng.normal(scale=0.1, size=n)).to_numpy()
    return X, y


# ---- M4: real LightGBM ----

def test_light_gbm_is_the_real_library():
    est = _build_estimator("light_gbm", {"n_estimators": 20})
    assert type(est).__module__.startswith("lightgbm"), type(est).__module__
    X, y = _classification_xy()
    est.fit(X, y)
    assert est.predict(X).shape[0] == len(X)


# ---- M8: regularized linear ----

@pytest.mark.parametrize("reg,cls", [("none", "LinearRegression"), ("ridge", "Ridge"),
                                     ("lasso", "Lasso"), ("elasticnet", "ElasticNet")])
def test_regularized_linear_regression(reg, cls):
    est = _build_estimator("linear_regression", {"regularization": reg, "alpha": 0.5})
    assert type(est).__name__ == cls


# ---- M1/M5: HPO with CV ----

def test_hpo_grid_search_returns_best_params_and_cv_score():
    X, y = _classification_xy()
    base = _build_estimator("random_forest", {})
    best, best_params, cv_score = tuning.run_search(
        base, "random_forest", X, y, kind="grid", cv_folds=3, family="classification")
    assert best_params  # a real search happened → non-empty best params
    assert 0.0 <= cv_score <= 1.0
    # best_estimator is refit and predicts.
    assert best.predict(X).shape[0] == len(X)


def test_hpo_random_search_respects_n_trials():
    X, y = _classification_xy()
    base = _build_estimator("xgboost", {})
    best, best_params, cv_score = tuning.run_search(
        base, "xgboost", X, y, kind="random", n_trials=4, cv_folds=3,
        family="classification")
    assert best_params and cv_score is not None


def test_hpo_falls_back_to_single_fit_when_too_few_rows():
    X, y = _classification_xy(n=4)
    base = _build_estimator("random_forest", {})
    best, best_params, cv_score = tuning.run_search(
        base, "random_forest", X, y, kind="grid", cv_folds=5, family="classification")
    assert best_params == {} and cv_score is None  # honest fallback, not a fake search


def test_hpo_requested_and_feature_selection_requested_flags():
    assert tuning.hpo_requested({"search": "grid"})
    assert tuning.hpo_requested({"cv_folds": 5})
    assert not tuning.hpo_requested({"cv_folds": 1})
    assert tuning.feature_selection_requested({"feature_selection": "sequential"})
    assert not tuning.feature_selection_requested({"feature_selection": "none"})


# ---- M6: wrapper feature selection composes into a Pipeline ----

def test_feature_selection_wraps_and_fits():
    X, y = _classification_xy()
    base = _build_estimator("logistic_regression", {"max_iter": 200})
    pipe = tuning.wrap_feature_selection(base, kind="kbest", n_features=3)
    pipe.fit(X, y)
    # SelectKBest reduces to 3 features before the model.
    assert pipe.named_steps["select"].get_support().sum() == 3
    assert pipe.predict(X).shape[0] == len(X)


# ---- M7: richer per-family metrics via the executor's _fit_and_score ----

def test_classification_metrics_are_rich():
    ex = LocalTrainingExecutor(tracking_uri="file:///tmp/does-not-matter")
    X, y = _classification_xy()
    metrics, fitted = ex._fit_and_score(
        _build_estimator("random_forest", {"n_estimators": 20}),
        X, pd.Series(y), "classification", train_test_split,
        params={}, algorithm="random_forest")
    for k in ("accuracy", "f1_weighted", "precision_weighted", "recall_weighted",
              "roc_auc", "cm_0_0", "cm_1_1"):
        assert k in metrics, f"missing metric {k}"
    assert fitted is not None


def test_regression_metrics_are_rich():
    ex = LocalTrainingExecutor(tracking_uri="file:///tmp/does-not-matter")
    X, y = _regression_xy()
    metrics, _ = ex._fit_and_score(
        _build_estimator("random_forest_regressor", {"n_estimators": 20}),
        X, pd.Series(y), "regression", train_test_split,
        params={}, algorithm="random_forest_regressor")
    for k in ("r2", "rmse", "mae", "explained_variance"):
        assert k in metrics


def test_clustering_metrics_are_rich():
    ex = LocalTrainingExecutor(tracking_uri="file:///tmp/x")
    rng = np.random.default_rng(3)
    X = pd.DataFrame(np.vstack([rng.normal(0, 1, (50, 2)), rng.normal(6, 1, (50, 2))]),
                     columns=["a", "b"])
    metrics, _ = ex._fit_and_score(
        _build_estimator("kmeans", {"n_clusters": 2}),
        X, None, "clustering", train_test_split, params={}, algorithm="kmeans")
    for k in ("silhouette", "davies_bouldin", "calinski_harabasz", "n_clusters"):
        assert k in metrics


def test_fit_and_score_runs_hpo_end_to_end_and_reports_cv():
    ex = LocalTrainingExecutor(tracking_uri="file:///tmp/x")
    X, y = _classification_xy()
    metrics, fitted = ex._fit_and_score(
        _build_estimator("random_forest", {}), X, pd.Series(y), "classification",
        train_test_split, params={"search": "grid", "cv_folds": 3},
        algorithm="random_forest")
    assert metrics.get("hpo_search") == 1.0 and "cv_score" in metrics
    assert fitted.predict(X.head(3)).shape[0] == 3
