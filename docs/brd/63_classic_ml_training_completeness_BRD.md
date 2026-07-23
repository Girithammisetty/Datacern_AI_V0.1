# BRD 63 — Classic-ML training completeness

**Status:** in-progress — 2026-07-23 · part of the [Nemesis→Datacern parity initiative](62_nemesis_parity_index.md)
**Owner:** platform · **Service:** `pipeline-orchestrator` (executor) + `agent-runtime` (agent)
**Gaps closed:** M1 (hyperparameter tuning), M5 (cross-validation), M6 (in-training
feature selection), M4 (real LightGBM), M8 (regularized linear regression), M7
(rich per-family eval metrics).

---

## Analysis

Datacern's `LocalTrainingExecutor` (`app/executor/local.py`) trains a single
estimator per run and computes a thin metric set. Six classical-ML capabilities
Nemesis ships in production are missing or stubbed:

- **HPO (M1)** — Nemesis runs real grid + random search over per-algorithm ranges
  with a time budget, refits + registers the best. Datacern's `hyperparameter-search`
  component exists in the catalog but the executor **pops `n_trials`/`cv_folds` and
  does a single fit** — no optuna/grid/random anywhere.
- **Cross-validation (M5)** — Nemesis does k-fold / predefined-split CV inside HPO;
  Datacern collapses it with M1.
- **Feature selection (M6)** — Nemesis has wrapper-method selection (Sequential /
  Random column subset) bound to training; Datacern only has filter operators as
  standalone pipeline stages, nothing bound to the fit.
- **Real LightGBM (M4)** — Datacern's `light_gbm` maps to sklearn
  `HistGradientBoostingClassifier`, not the LightGBM library.
- **Regularized linear (M8)** — Datacern's `linear_regression` is plain OLS; Nemesis
  offers Ridge / Lasso / ElasticNet.
- **Rich eval metrics (M7)** — Nemesis logs ROC AUC + confusion matrix (classification),
  explained_variance + MAE (regression), Davies-Bouldin + Calinski-Harabasz
  (clustering). Datacern logs only accuracy/f1/r2/rmse/silhouette.

All six are **pure compute** — no GPU, no cloud — so they are fully local-testable
and live-verifiable on a Mac via the existing training run path.

## Design

1. **`app/executor/tuning.py` (new)** — pure, dependency-injected HPO:
   `search_space(algorithm)` (per-algorithm grid/distribution matching Nemesis's
   `DEFAULT_RANGES`), and `run_search(base_estimator, algorithm, X, y, *, kind,
   n_trials, cv_folds, scoring)` returning `(best_estimator, best_params, cv_score)`
   via sklearn `GridSearchCV` / `RandomizedSearchCV` with real k-fold CV. Feature
   selection: `wrap_feature_selection(estimator, kind, k)` using
   `SequentialFeatureSelector` (wrapper) or a random-subset selector, composed as an
   sklearn `Pipeline` so the selected features persist into the logged model.
2. **`app/executor/local.py`** —
   - `_build_estimator`: `light_gbm` → real `lightgbm.LGBMClassifier` (honest
     `ImportError` fallback to HistGradientBoosting with a logged warning if the wheel
     is absent); `linear_regression` honors a `regularization` param
     (`none|ridge|lasso|elasticnet` → `LinearRegression/Ridge/Lasso/ElasticNet`).
   - `_fit_and_score`: when the run's params request HPO (`search` ∈ {grid,random}
     and/or `cv_folds>1`) run `tuning.run_search` and log `best_params` + `cv_score`;
     when `feature_selection` is requested wrap the estimator first. Always compute
     the **richer metric set** per family (precision/recall/roc_auc + confusion matrix
     for classification, explained_variance/mae for regression, davies_bouldin/
     calinski_harabasz for clustering).
3. **`lightgbm` added to `pyproject.toml`** (real dep; CPU wheel, Mac-friendly).
4. **Agent (M-agent)** — extend `model_training` to optionally propose a **tuning
   strategy** (search kind, n_trials, cv_folds) and **feature selection** in the same
   governed training WriteIntent, grounded in the algorithm schema + prior-run history
   (it already fills hyperparameters; this adds the search knobs). So "tune an xgboost
   with 30 trials and 5-fold CV, select the best 8 features" becomes one proposal.

**Increment plan:** inc1 = executor (HPO/CV/feature-selection/LightGBM/regularized/
rich-metrics) + unit tests (pure, real sklearn/xgboost/lightgbm). inc2 = agent
extension + live-verify through the real training run path.

## Implement & Test log

### inc1 — executor: HPO / CV / feature-selection / LightGBM / regularized-linear / rich-metrics — DONE

- **`app/executor/tuning.py` (new)** — real HPO: `search_space` (per-algorithm
  grid/dist matching Nemesis DEFAULT_RANGES), `run_search` (sklearn
  `GridSearchCV`/`RandomizedSearchCV` with real k-fold CV → best_estimator +
  best_params + cv_score; honest single-fit fallback when the space is empty or rows
  < folds×2), `wrap_feature_selection` (`SequentialFeatureSelector`/`SelectKBest`
  composed as a Pipeline so the selection persists into the logged model), and the
  `hpo_requested`/`feature_selection_requested` param predicates.
- **`app/executor/local.py`** — `light_gbm` → REAL `lightgbm.LGBMClassifier` (M4,
  honest `HistGradientBoosting` fallback only if the wheel is absent);
  `linear_regression` honors `regularization` → Ridge/Lasso/ElasticNet (M8);
  `_fit_and_score` now runs `tuning.run_search`/`wrap_feature_selection` when the run
  params request it (M1/M5/M6), returns the fitted/tuned estimator (logged), and
  always computes the richer metrics — classification: +precision/recall/roc_auc +
  flattened confusion matrix; regression: +mae/explained_variance; clustering:
  +davies_bouldin/calinski_harabasz (M7).
- **`pyproject.toml`** — `lightgbm>=4.0` added (real CPU dep, installed 4.7).

### inc2 — agent: `model_training` proposes a tuning strategy — DONE

`model_training` (the governed no-code builder) now also proposes a **tuning
strategy** (`search`∈grid/random, `n_trials`, `cv_folds`) and **feature selection**
(`sequential`/`kbest`, `n_features`) in the same training WriteIntent, grounded in
the algorithm schema + prior-run history. `_normalise_tuning` clamps the strategy
(n_trials ≤200, cv_folds 2–10) and only proposes a search when the request asks to
tune/optimize — so "tune an xgboost with a random search and select the best
features" becomes one governed proposal that the executor executes as real HPO +
selection. Prompt updated; strategy surfaced in the proposal summary.

**Test:** `tests/unit/test_training_completeness.py` (14, pipeline-orchestrator) —
real LightGBM is the actual library; regularized-linear variants; grid + random
search return real best_params + a CV score; too-few-rows falls back honestly (not a
fake search); kbest/sequential wrapper composes + fits; rich classification/
regression/clustering metrics present; end-to-end HPO through `_fit_and_score`
reports `hpo_search`+`cv_score`. `tests/unit/test_model_training_graph.py` (+2,
agent-runtime) — the agent carries a clamped tuning+selection strategy into the
proposal, and omits it when not asked. Full pipeline-orchestrator suite green
(**139**); model_training + prompt suites green (**19**). No regression.

_inc3 (live-verify): drive a tuned training run through the real training path +
`model_training` agent against the running stack (next)._

### Live-verified (2026-07-23)

Drove the REAL `LocalTrainingExecutor` against the running MLflow (:5500),
`scratchpad/parity_live_verify.py`: a `random_forest` run with `{search:grid,
cv_folds:3}` logged `hpo_search=1.0` + `cv_score≈0.95` + `roc_auc≈0.96` (real
GridSearchCV+CV); `light_gbm` is the real `lightgbm.sklearn.LGBMClassifier` and
trains+logs a run; rich metrics present; runs persisted in live MLflow. This
surfaced + fixed 3 real bugs the unit tier missed (commit 261b0f5): mlflow
LightGBM-flavor logging, the tabular-prep crash on non-tabular inputs, and a
logger UnboundLocalError.
