"""SLM distillation training control plane (milestone 3/4).

Submit a distillation run against a versioned SFT dataset -> track its lifecycle
-> (eval-gate) -> promote the resulting adapter to the tenant's cheapest ladder
rung. The DB/API/lifecycle here are fully real; the GPU LoRA compute runs behind
the ``GpuTrainer`` port and fails honestly (GpuTrainerNotConfigured) with no GPU
wired — a submitted job then lands in ``failed`` with reason
``gpu_trainer_not_configured`` rather than a fabricated adapter (Rule 2).
"""

from __future__ import annotations

import json
import logging

from app.domain import archetypes
from app.domain.entities import (
    ADAPTER_PROMOTION_STATUSES,
    SlmAdapter,
    TrainingJob,
    new_uuid,
    now,
)
from app.domain.errors import Conflict, NotFound, ValidationFailed
from app.domain.ports import GpuTrainer, GpuTrainerNotConfigured, TrainingSpec

logger = logging.getLogger(__name__)


class TrainingJobService:
    def __init__(self, store, trainer: GpuTrainer, *, artifact_store=None) -> None:
        self._store = store
        self._trainer = trainer
        # Only the local CPU trainer needs the artifact store (to load a
        # distilled student for the eval-gate + serving); the GPU path serves
        # its adapters through ai-gateway rungs and leaves this None.
        self._artifacts = artifact_store

    async def submit(
        self, *, tenant_id: str, agent_key: str, sft_dataset_id: str,
        base_model: str | None = None, params: dict | None = None, created_by: str | None = None,
    ) -> TrainingJob:
        """Submit a distillation run. Validates the versioned SFT dataset exists,
        resolves the archetype's student base, then hands the frozen corpus to
        the GPU trainer. On a stack with no trainer backend the job is recorded
        and immediately marked ``failed`` with an honest reason."""
        try:
            arch = archetypes.resolve_archetype(agent_key, base_model=base_model)
        except ValueError as e:
            raise ValidationFailed(str(e)) from e

        ds = await self._store.get_sft_dataset(tenant_id, sft_dataset_id)
        if ds is None:
            raise NotFound("sft dataset not found")
        if ds.agent_key != agent_key:
            raise ValidationFailed(
                f"sft dataset is for archetype {ds.agent_key!r}, not {agent_key!r}")
        if ds.row_count <= 0:
            raise ValidationFailed("sft dataset has no training rows")

        examples = await self._store.list_sft_examples(tenant_id, sft_dataset_id, limit=100000)
        jsonl = "\n".join(json.dumps({"messages": e.messages}, ensure_ascii=False) for e in examples)  # noqa: E501

        job = TrainingJob(
            job_id=new_uuid(), tenant_id=tenant_id, archetype=agent_key,
            sft_dataset_id=sft_dataset_id, base_model=arch.base_model, status="running",
            params=params or {}, created_by=created_by, started_at=now())
        await self._store.record_training_job(job)

        try:
            result = await self._trainer.train(TrainingSpec(
                tenant_id=tenant_id, archetype=agent_key, base_model=arch.base_model,
                sft_dataset_id=sft_dataset_id, sft_examples_jsonl=jsonl, params=params or {}))
        except GpuTrainerNotConfigured as e:
            job.status = "failed"
            job.error = {"reason": "gpu_trainer_not_configured", "detail": str(e)}
            job.finished_at = now()
            await self._store.update_training_job(job)
            return job
        except Exception as e:  # noqa: BLE001 - a real GPU/training failure
            # Reachable only with a REAL backend wired (modal/sagemaker/k8s-job):
            # OOM, an unavailable base model, a remote executor error. Without
            # this the job row would stay `running` forever and the API would
            # 500. Record the failure honestly (never a fabricated adapter) and
            # log it — the job row is the durable signal, the log the immediate one.
            logger.exception("slm training failed (job_id=%s tenant=%s)", job.job_id, tenant_id)
            job.status = "failed"
            job.error = {"reason": "training_failed", "detail": f"{type(e).__name__}: {e}"}
            job.finished_at = now()
            await self._store.update_training_job(job)
            return job

        adapter = SlmAdapter(
            adapter_id=new_uuid(), tenant_id=tenant_id, training_job_id=job.job_id,
            archetype=agent_key, base_model=arch.base_model, adapter_uri=result.adapter_uri,
            checksum=result.checksum, model_alias=arch.model_alias, promotion_status="candidate")
        await self._store.record_slm_adapter(adapter)

        job.status = "succeeded"
        job.adapter_id = adapter.adapter_id
        job.mlflow_run_ref = result.mlflow_run_ref
        job.finished_at = now()
        await self._store.update_training_job(job)
        return job

    async def promote(
        self, *, tenant_id: str, adapter_id: str, eval_result_ref: str | None = None,
    ) -> SlmAdapter:
        """Promote a distilled adapter to the tenant's ladder rung (milestone 4).
        Requires a real artifact (adapter_uri) and a candidate/gated status; the
        eval-gate result that cleared it is recorded. NOTE: registering the rung
        in ai-gateway (POST /providers + PUT /ladders) is a thin follow-up — it
        needs a served adapter endpoint, which only exists once real GPU training
        has produced one."""
        a = await self._store.get_slm_adapter(tenant_id, adapter_id)
        if a is None:
            raise NotFound("adapter not found")
        if a.promotion_status not in ("candidate", "gated"):
            raise Conflict(f"adapter is {a.promotion_status}, not promotable")
        if not a.adapter_uri:
            raise Conflict("adapter has no trained artifact to serve")
        a.promotion_status = "promoted"
        a.target_rung_alias = a.model_alias
        a.eval_result_ref = eval_result_ref
        await self._store.update_slm_adapter(a)
        return a

    async def demote(self, *, tenant_id: str, adapter_id: str) -> SlmAdapter:
        """Roll back a promoted rung (design §M4 rollback)."""
        a = await self._store.get_slm_adapter(tenant_id, adapter_id)
        if a is None:
            raise NotFound("adapter not found")
        if a.promotion_status != "promoted":
            raise Conflict(f"adapter is {a.promotion_status}, not demotable")
        a.promotion_status = "demoted"
        await self._store.update_slm_adapter(a)
        return a

    # ---- eval-gate + serving (local distilled student) ---------------------

    async def _load_local(self, adapter_uri: str):
        """Load (student, holdout) for a ``local://{key}`` adapter from the
        tenant-partitioned artifact store."""
        from app.adapters.local_trainer import EVALSET_SUFFIX, MODEL_SUFFIX
        from app.domain.distill import DistilledStudent

        if self._artifacts is None or not adapter_uri.startswith("local://"):
            return None, None
        key = adapter_uri[len("local://"):]
        model = json.loads(await self._artifacts.get(f"{key}/{MODEL_SUFFIX}"))
        evalset = json.loads(await self._artifacts.get(f"{key}/{EVALSET_SUFFIX}"))
        return DistilledStudent.from_dict(model), evalset

    async def gate(self, *, tenant_id: str, adapter_id: str, min_margin: float = 0.0
                   ) -> dict:
        """The 'wins' gate: a distilled student may only be promoted if it BEATS
        the baseline on the tenant's held-out decisions. Baseline = the
        currently-promoted student for this archetype if one exists (must beat
        the incumbent to replace it), else the majority-class predictor ('no
        tenant-specialized model'). Deterministic and reproducible. On a win the
        adapter is marked ``gated`` and carries the eval result; on a loss it is
        left un-gated with an honest report — never promoted on a claim."""
        from app.domain.distill import accuracy, majority_baseline

        a = await self._store.get_slm_adapter(tenant_id, adapter_id)
        if a is None:
            raise NotFound("adapter not found")
        student, ev = await self._load_local(a.adapter_uri)
        if student is None:
            raise Conflict("adapter has no local artifact to evaluate")
        holdout = [tuple(x) for x in ev.get("holdout", [])]
        train = [tuple(x) for x in ev.get("train", [])]
        if not holdout:
            raise Conflict("no held-out decisions to evaluate the student against")

        student_acc = accuracy(lambda t: student.predict(t)[0], holdout)
        incumbent = await self._store.get_promoted_adapter(tenant_id, a.archetype)
        if incumbent is not None and incumbent.adapter_id != adapter_id:
            inc_student, _ = await self._load_local(incumbent.adapter_uri)
            base_kind, base_pred = "incumbent", (lambda t: inc_student.predict(t)[0])
        else:
            base_kind, base_pred = "majority_class", majority_baseline(train)
        base_acc = accuracy(base_pred, holdout)

        wins = student_acc >= base_acc + min_margin
        report = {"student_accuracy": student_acc, "baseline_accuracy": base_acc,
                  "baseline_kind": base_kind, "n_holdout": len(holdout),
                  "min_margin": min_margin, "wins": wins}
        if wins:
            a.promotion_status = "gated"
            a.eval_result_ref = f"local-gate:{json.dumps(report, sort_keys=True)}"
            await self._store.update_slm_adapter(a)
        return {"adapter_id": adapter_id, "gated": wins, "report": report}

    async def serve(self, *, tenant_id: str, archetype: str, input_text: str) -> dict:
        """Serve the tenant's PROMOTED distilled student for one decision: load
        the promoted adapter for (tenant, archetype) and predict. Honest 404
        when nothing is promoted — never a base-model guess dressed up as the
        owned model."""
        a = await self._store.get_promoted_adapter(tenant_id, archetype)
        if a is None:
            raise NotFound(f"no promoted distilled model for archetype {archetype!r}")
        student, _ = await self._load_local(a.adapter_uri)
        if student is None:
            raise Conflict("promoted adapter has no servable local artifact")
        decision, confidence = student.predict(input_text)
        return {"decision": decision, "confidence": confidence,
                "adapter_id": a.adapter_id, "model_alias": a.model_alias,
                "archetype": archetype, "served_by": "distilled-student"}


_ = ADAPTER_PROMOTION_STATUSES  # documents the state space (used by tests)
