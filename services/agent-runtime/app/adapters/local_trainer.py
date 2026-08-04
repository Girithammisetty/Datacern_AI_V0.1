"""LocalCpuTrainer — a real distilled model, no GPU (SLM milestone 3, local).

Satisfies the same ``GpuTrainer.train(TrainingSpec) -> TrainingResult`` contract
as ``ModalGpuTrainer``, but distils the SFT corpus into a CPU decision student
(app.domain.distill) in-process. It produces a genuine trained artifact —
serialized JSON of the model plus the reserved held-out evaluation set — stored
TENANT-PARTITIONED (``{tenant_id}/{archetype}/{run_id}``), so the eval-gate and
serving path have something real to load. Production-scale generative LoRA
distillation remains ModalGpuTrainer (GPU); this is the honest existence proof
of the full train -> gate(wins) -> promote -> serve loop on any stack.
"""
from __future__ import annotations

import hashlib
import json

from app.adapters.artifact_store import AdapterArtifactStore
from app.domain.distill import DistilledStudent, parse_corpus, split_holdout
from app.domain.ports import GpuTrainerNotConfigured, TrainingResult, TrainingSpec

MODEL_SUFFIX = "model.json"
EVALSET_SUFFIX = "evalset.json"


def artifact_key(tenant_id: str, archetype: str, run_id: str) -> str:
    return f"{tenant_id}/{archetype}/{run_id}"


class LocalCpuTrainer:
    def __init__(self, store: AdapterArtifactStore, *, holdout_frac: float = 0.25) -> None:
        self._store = store
        self._holdout_frac = holdout_frac

    async def train(self, spec: TrainingSpec) -> TrainingResult:
        examples = parse_corpus(spec.sft_examples_jsonl)
        if len(examples) < 4:
            # Honest failure: too little governed signal to distil a real model
            # (never emit a fabricated adapter). Mirrors the Rule-2 discipline.
            raise GpuTrainerNotConfigured(
                "local trainer needs >= 4 governed examples to distil a student; "
                f"the SFT dataset yielded {len(examples)}")
        train, evalset = split_holdout(examples, holdout_frac=self._holdout_frac)
        student = DistilledStudent.train(train or examples)

        model_bytes = json.dumps(student.to_dict()).encode("utf-8")
        run_id = hashlib.sha256(spec.sft_examples_jsonl.encode("utf-8")).hexdigest()[:16]
        key = artifact_key(spec.tenant_id, spec.archetype, run_id)
        await self._store.put(f"{key}/{MODEL_SUFFIX}", model_bytes)
        await self._store.put(
            f"{key}/{EVALSET_SUFFIX}",
            json.dumps({"holdout": evalset, "train": train or examples}).encode("utf-8"))
        return TrainingResult(
            adapter_uri=f"local://{key}",
            mlflow_run_ref=f"local-cpu/{run_id}",
            checksum=hashlib.sha256(model_bytes).hexdigest())
