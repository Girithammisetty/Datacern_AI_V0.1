"""A classifier must predict the LABELS it was trained on, not class indices.

CROSS-SERVICE CONTRACT. inference-service's auto_case rule compares
`str(prediction) == positive_label` (adapters/executor.py) to decide which scored
rows become cases. The trainer used to LabelEncoder the target and discard the
encoder, so predict() returned 0/1 and that comparison could never be true — the
scored parquet held opaque integers and auto_case opened zero cases, silently.

journey-learn caught it as '0/10 true_positive' on rows that were 5/10 fraud, a
failure that reads like a bad model and is actually a lost mapping. Assert on the
VALUES, not just on accuracy, or this regresses invisibly.
"""

import pandas as pd
import pytest

from app.executor.local import LocalTrainingExecutor, _build_estimator


def _fit(labels, rows=40):
    X = pd.DataFrame({"amount": [float(i) for i in range(rows)],
                      "prior_claims": [float(i % 5) for i in range(rows)]})
    y = pd.Series([labels[i % len(labels)] for i in range(rows)])
    from sklearn.model_selection import train_test_split
    return LocalTrainingExecutor._fit_and_score(
        None, _build_estimator("random_forest", {}), X, y, "classification",
        train_test_split, params={}, algorithm="random_forest", cpus=1)


def test_predictions_are_the_original_string_labels():
    metrics, fitted = _fit(["true_positive", "false_positive"])
    preds = set(map(str, fitted.predict(pd.DataFrame(
        {"amount": [1.0, 2.0, 3.0], "prior_claims": [0.0, 1.0, 2.0]}))))
    assert preds <= {"true_positive", "false_positive"}, (
        f"predicted {preds}; inference-service compares these to positive_label "
        "as strings, so class indices match nothing and open zero cases")
    assert not preds & {"0", "1"}


def test_positive_class_still_maps_to_proba_column_1():
    """predict_proba[:, 1] must stay the same class LabelEncoder made positive —
    both sort, so this is preserved, and roc_auc would silently invert if not."""
    _, fitted = _fit(["true_positive", "false_positive"])
    assert list(fitted.classes_) == ["false_positive", "true_positive"]


def test_metrics_survive_string_targets():
    metrics, _ = _fit(["true_positive", "false_positive"])
    for k in ("accuracy", "f1_weighted", "precision_weighted", "recall_weighted"):
        assert isinstance(metrics[k], float)
    assert metrics["n_classes"] == 2.0


@pytest.mark.parametrize("labels", [["a", "b", "c"], ["yes", "no"]])
def test_arbitrary_label_vocabularies_round_trip(labels):
    _, fitted = _fit(labels)
    assert set(map(str, fitted.classes_)) == set(labels)
