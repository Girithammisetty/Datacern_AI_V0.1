"""Real MLflow tracking/registry gateway (BRD §8, BR-15).

The run lifecycle creates the MLflow run BEFORE submitting to the executor, so a run
row never exists without a real MLflow run and no orphan workflow can exist. If MLflow
is unavailable at submit, ``create_run`` raises ``DependencyUnavailable`` (503) and the
run is not created. The local training executor resumes this same run id."""

from __future__ import annotations

import asyncio

from app.domain.errors import DependencyUnavailable
from app.domain.ports import TrainingResult


class MlflowGateway:
    def __init__(self, tracking_uri: str, experiment: str):
        self.tracking_uri = tracking_uri
        self.experiment = experiment

    async def create_run(self, *, tags: dict, experiment_id: str | None = None,
                         experiment_name: str | None = None) -> str:
        return await asyncio.to_thread(self._create_sync, tags, experiment_id,
                                       experiment_name)

    def _create_sync(self, tags: dict, experiment_id: str | None = None,
                     experiment_name: str | None = None) -> str:
        try:
            from mlflow.tracking import MlflowClient

            client = MlflowClient(tracking_uri=self.tracking_uri)
            # A retrain run targets the experiment-service experiment so the mirror
            # reconciliation sweep can materialize it (experiment_id is exact; name is
            # a fallback). Otherwise the caller passes a PER-TENANT experiment name so
            # each tenant's runs land in their own MLflow experiment (never a shared
            # one) — experiment-service keys the mirror on a globally-unique
            # mlflow_experiment_id, so a shared experiment would collide across
            # tenants. A freshly created experiment is tagged with the tenant/workspace
            # so it is attributable the same way authoritative experiments are.
            if experiment_id:
                exp_id = experiment_id
            else:
                name = experiment_name or self.experiment
                exp = client.get_experiment_by_name(name)
                if exp:
                    exp_id = exp.experiment_id
                else:
                    exp_tags = {}
                    if tags.get("tenant_id"):
                        exp_tags["datacern_tenant"] = str(tags["tenant_id"])
                    if tags.get("workspace_id"):
                        exp_tags["datacern_workspace"] = str(tags["workspace_id"])
                    exp_id = client.create_experiment(name, tags=exp_tags or None)
            run = client.create_run(
                exp_id, tags={f"datacern.{k}": str(v) for k, v in tags.items()})
            return run.info.run_id
        except DependencyUnavailable:
            raise
        except Exception as exc:  # noqa: BLE001 — MLflow down → fail fast (BR-15)
            raise DependencyUnavailable(f"MLflow unavailable: {exc}") from exc

    async def result_for_run(self, mlflow_run_id: str | None) -> TrainingResult | None:
        """Read back what the TRAINING POD actually produced (Argo path).

        On the local backend the executor returns its own TrainingResult in
        process. On Argo the fit happens in a pod the orchestrator never sees, and
        that pod is the one that logs metrics and registers the model — so the
        outcome has to be read from MLflow. Reading it is the point: the run's
        recorded metrics are then always the ones a real fit produced, never a
        value the orchestrator assumed because the workflow exited zero.

        Returns None when the workflow succeeded but registered nothing, which the
        caller surfaces as a failure rather than a model-less success.
        """
        if not mlflow_run_id:
            return None
        return await asyncio.to_thread(self._result_sync, mlflow_run_id)

    def _result_sync(self, mlflow_run_id: str) -> TrainingResult | None:
        try:
            from mlflow.tracking import MlflowClient

            client = MlflowClient(tracking_uri=self.tracking_uri)
            run = client.get_run(mlflow_run_id)
            versions = client.search_model_versions(f"run_id='{mlflow_run_id}'")
            if not versions:
                return None
            # Newest registered version for this run — a retry within the same
            # MLflow run would otherwise resolve to the earlier model.
            mv = max(versions, key=lambda v: int(v.version))
            return TrainingResult(
                mlflow_run_id=mlflow_run_id,
                model_uri=f"models:/{mv.name}/{mv.version}",
                registered_model_name=mv.name,
                model_version=str(mv.version),
                metrics=dict(run.data.metrics or {}),
                params=dict(run.data.params or {}),
                row_count=int(float(run.data.metrics.get("n_rows", 0) or 0)),
            )
        except Exception as exc:  # noqa: BLE001
            raise DependencyUnavailable(
                f"could not read MLflow result for run {mlflow_run_id}: {exc}") from exc

    async def set_terminated(self, run_id: str, status: str) -> None:
        await asyncio.to_thread(self._terminate_sync, run_id, status)

    def _terminate_sync(self, run_id: str, status: str) -> None:
        try:
            from mlflow.tracking import MlflowClient

            MlflowClient(tracking_uri=self.tracking_uri).set_terminated(run_id, status)
        except Exception:  # noqa: BLE001 — terminal bookkeeping is best-effort
            pass
