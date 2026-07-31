"""The run tag that tells experiment-service where the model actually is.

CROSS-SERVICE CONTRACT. Under MLflow 3 `log_model` returns a logged-model uri
(models:/m-<id>) that cannot be reconstructed from the run id: `runs:/<run>/model`
resolves but downloads the model nested one level in, and the run's artifact_uri
is the artifact root. Both register into the model registry without complaint and
then fail at LOAD time, in inference-service, with 'Could not find an "MLmodel"
configuration file'. That is exactly how every batch scoring job broke.

experiment-service reads this tag when it registers a promoted version, so the
NAME is part of the contract, not an implementation detail. If this test and
experiment-service's MODEL_URI_TAG ever disagree, promotions silently go back to
hand-built sources that resolve and will not load.
"""

from app.executor.local import MODEL_URI_TAG


def test_tag_name_matches_the_experiment_service_contract():
    # Hard-coded on purpose: importing experiment-service here is impossible
    # (separate venv), so the literal IS the contract both sides are pinned to.
    assert MODEL_URI_TAG == "datacern.model_uri"


def test_trainer_records_the_model_uri_on_the_run():
    """The tag is written from the value log_model returned — never rebuilt."""
    import inspect

    from app.executor import local

    src = inspect.getsource(local.LocalTrainingExecutor)
    assert "mlflow.set_tag(MODEL_URI_TAG, model_uri)" in src, (
        "the trainer must tag the run with the uri log_model returned; "
        "anything reconstructed from the run id does not load under MLflow 3")
