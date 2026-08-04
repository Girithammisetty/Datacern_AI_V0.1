"""End-to-end: a real distilled model that TRAINS, GATES (wins), PROMOTES,
SERVES — on CPU, no GPU (SLM local backend).

Drives the full own-your-model loop through TrainingJobService with the
LocalCpuTrainer + a tenant-partitioned artifact store: distil the governed SFT
corpus into a student, gate it (promotable only if it beats the baseline on the
tenant's held-out decisions), promote it, then SERVE it and confirm the owned
model actually answers the tenant's decision — and that a loser is refused,
nothing is promoted-then-served across tenants, and the artifact is tenant-keyed.
"""
from __future__ import annotations

import json

import pytest

from app.adapters.artifact_store import InMemoryAdapterStore
from app.adapters.local_trainer import LocalCpuTrainer
from app.domain.entities import SftDataset, SftExample, new_uuid, now
from app.domain.errors import NotFound
from app.domain.training import TrainingJobService
from app.store.memory import InMemoryStore

TENANT = "11111111-1111-1111-1111-111111111111"
TENANT_B = "22222222-2222-2222-2222-222222222222"

_FRAUD = ["suspicious fraud ring high risk", "known fraud duplicate billing",
          "fraud alert stolen identity", "fraudulent fabricated receipt"]
_CLEAN = ["verified legitimate routine visit", "clean history in network",
          "legitimate documented necessary", "routine verified active coverage"]


async def _seed_dataset(store, tenant=TENANT, agent="triage"):
    ds = SftDataset(
        dataset_id=new_uuid(), tenant_id=tenant, agent_key=agent, version=1,
        status="built", row_count=8, source_count=8, curation_params={},
        checksum="sha256:x", consent_verified=True, created_by="u", created_at=now())
    rows = []
    for i, txt in enumerate(_FRAUD):
        rows.append(_ex(ds.dataset_id, tenant, i, txt, "deny"))
    for i, txt in enumerate(_CLEAN):
        rows.append(_ex(ds.dataset_id, tenant, i + 4, txt, "approve"))
    await store.record_sft_dataset(ds, rows)
    return ds


def _ex(dataset_id, tenant, ordv, text, label):
    return SftExample(
        dataset_id=dataset_id, tenant_id=tenant, ord=ordv,
        messages=[{"role": "user", "content": text},
                  {"role": "assistant", "content": label}],
        target_kind="approve", source_transcript_id=None, example_hash=f"h{ordv}")


def _svc(store, artifacts):
    return TrainingJobService(store, LocalCpuTrainer(artifacts), artifact_store=artifacts)


async def _train(store, artifacts, tenant=TENANT, agent="triage"):
    ds = await _seed_dataset(store, tenant=tenant, agent=agent)
    svc = _svc(store, artifacts)
    job = await svc.submit(tenant_id=tenant, agent_key=agent, sft_dataset_id=ds.dataset_id)
    assert job.status == "succeeded", job.error
    return svc, job.adapter_id


async def test_full_loop_train_gate_promote_serve():
    store, artifacts = InMemoryStore(), InMemoryAdapterStore()
    svc, adapter_id = await _train(store, artifacts)

    # Before promotion, the owned model is honestly absent (no faked base guess).
    with pytest.raises(NotFound):
        await svc.serve(tenant_id=TENANT, archetype="triage", input_text="fraud ring")

    # Gate: the student must BEAT the baseline on held-out decisions.
    gate = await svc.gate(tenant_id=TENANT, adapter_id=adapter_id)
    assert gate["gated"] is True
    assert gate["report"]["student_accuracy"] > gate["report"]["baseline_accuracy"]
    assert gate["report"]["baseline_kind"] == "majority_class"

    a = await store.get_slm_adapter(TENANT, adapter_id)
    assert a.promotion_status == "gated"

    await svc.promote(tenant_id=TENANT, adapter_id=adapter_id, eval_result_ref=a.eval_result_ref)

    # Serve: the owned model actually decides — and decides CORRECTLY.
    deny = await svc.serve(tenant_id=TENANT, archetype="triage",
                           input_text="this claim shows a fraud pattern")
    approve = await svc.serve(tenant_id=TENANT, archetype="triage",
                              input_text="verified legitimate routine coverage")
    assert deny["decision"] == "deny"
    assert approve["decision"] == "approve"
    assert deny["served_by"] == "distilled-student"
    assert 0.0 <= deny["confidence"] <= 1.0


async def test_artifact_is_tenant_partitioned():
    store, artifacts = InMemoryStore(), InMemoryAdapterStore()
    _, adapter_id = await _train(store, artifacts)
    a = await store.get_slm_adapter(TENANT, adapter_id)
    # local://{tenant_id}/{archetype}/{run_id} — the blob path carries the tenant.
    assert a.adapter_uri.startswith(f"local://{TENANT}/triage/")
    assert await artifacts.exists(a.adapter_uri[len("local://"):] + "/model.json")


async def test_gate_refuses_a_student_that_does_not_beat_baseline():
    # Degenerate corpus: identical inputs, split labels — the student can only
    # predict the majority, so it cannot beat the majority baseline by a margin.
    store, artifacts = InMemoryStore(), InMemoryAdapterStore()
    ds = SftDataset(dataset_id=new_uuid(), tenant_id=TENANT, agent_key="triage",
                    version=1, status="built", row_count=8, source_count=8,
                    curation_params={}, checksum="x", consent_verified=True,
                    created_by="u", created_at=now())
    rows = [_ex(ds.dataset_id, TENANT, i, "same tokens everywhere",
                "deny" if i % 2 == 0 else "approve") for i in range(8)]
    await store.record_sft_dataset(ds, rows)
    svc = _svc(store, artifacts)
    job = await svc.submit(tenant_id=TENANT, agent_key="triage", sft_dataset_id=ds.dataset_id)
    gate = await svc.gate(tenant_id=TENANT, adapter_id=job.adapter_id, min_margin=0.01)
    assert gate["gated"] is False
    a = await store.get_slm_adapter(TENANT, job.adapter_id)
    assert a.promotion_status == "candidate"   # never gated on a non-win


async def test_serving_is_tenant_isolated():
    store, artifacts = InMemoryStore(), InMemoryAdapterStore()
    svc, adapter_id = await _train(store, artifacts, tenant=TENANT)
    await svc.gate(tenant_id=TENANT, adapter_id=adapter_id)
    await svc.promote(tenant_id=TENANT, adapter_id=adapter_id)
    # Tenant B has promoted nothing — serving its archetype is an honest 404,
    # never tenant A's model.
    with pytest.raises(NotFound):
        await svc.serve(tenant_id=TENANT_B, archetype="triage", input_text="fraud")


async def test_too_little_signal_fails_honestly():
    store, artifacts = InMemoryStore(), InMemoryAdapterStore()
    ds = SftDataset(dataset_id=new_uuid(), tenant_id=TENANT, agent_key="triage",
                    version=1, status="built", row_count=2, source_count=2,
                    curation_params={}, checksum="x", consent_verified=True,
                    created_by="u", created_at=now())
    rows = [_ex(ds.dataset_id, TENANT, i, "one two three", "deny") for i in range(2)]
    await store.record_sft_dataset(ds, rows)
    svc = _svc(store, artifacts)
    job = await svc.submit(tenant_id=TENANT, agent_key="triage", sft_dataset_id=ds.dataset_id)
    assert job.status == "failed"
    assert "governed examples" in json.dumps(job.error)
