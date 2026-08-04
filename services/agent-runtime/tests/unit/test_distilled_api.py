"""HTTP wiring for the distilled-model loop: the train-job → gate → promote →
serve routes over the real app with the local CPU trainer, proving the
container wires ONE tenant-partitioned artifact store across trainer + serving.
"""
from __future__ import annotations

import httpx
import pytest

from app.container import build_container
from app.domain.entities import SftDataset, SftExample, new_uuid, now
from app.main import create_app
from tests.conftest import TENANT_A, make_settings, make_token

_FRAUD = ["suspicious fraud ring high risk", "known fraud duplicate billing",
          "fraud alert stolen identity", "fraudulent fabricated receipt"]
_CLEAN = ["verified legitimate routine visit", "clean history in network",
          "legitimate documented necessary", "routine verified active coverage"]


class _AllowAuthz:
    async def allow(self, **_):
        return True


@pytest.fixture
async def app_client():
    c = build_container(make_settings(slm_trainer_backend="local"),
                        mode="memory", authz=_AllowAuthz())
    app = create_app(c)
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        yield client, c


def _auth(tenant=TENANT_A):
    return {"Authorization": f"Bearer {make_token(sub='u', tenant_id=tenant, scopes=[])}"}


async def _seed(c, tenant=TENANT_A):
    ds = SftDataset(dataset_id=new_uuid(), tenant_id=tenant, agent_key="triage",
                    version=1, status="built", row_count=8, source_count=8,
                    curation_params={}, checksum="x", consent_verified=True,
                    created_by="u", created_at=now())
    rows = []
    for i, txt in enumerate(_FRAUD + _CLEAN):
        rows.append(SftExample(
            dataset_id=ds.dataset_id, tenant_id=tenant, ord=i,
            messages=[{"role": "user", "content": txt},
                      {"role": "assistant", "content": "deny" if i < 4 else "approve"}],
            target_kind="approve", source_transcript_id=None, example_hash=f"h{i}"))
    await c.store.record_sft_dataset(ds, rows)
    return ds


async def test_train_gate_promote_serve_over_http(app_client):
    client, c = app_client
    ds = await _seed(c)

    job = (await client.post("/api/v1/training-jobs", headers=_auth(),
           json={"agent_key": "triage", "sft_dataset_id": ds.dataset_id})).json()["data"]
    assert job["status"] == "succeeded", job
    adapter_id = job["adapter_id"]

    # gate: student beats baseline → gated true
    gate = (await client.post(f"/api/v1/slm-adapters/{adapter_id}/gate",
            headers=_auth(), json={})).json()["data"]
    assert gate["gated"] is True

    # promote, then serve — the owned model decides
    await client.post(f"/api/v1/slm-adapters/{adapter_id}/promote", headers=_auth(), json={})
    served = (await client.post("/api/v1/distilled/serve", headers=_auth(),
              json={"archetype": "triage", "input": "clear fraud ring pattern"})).json()["data"]
    assert served["decision"] == "deny"
    assert served["served_by"] == "distilled-student"


async def test_serve_404_when_nothing_promoted(app_client):
    client, _ = app_client
    r = await client.post("/api/v1/distilled/serve", headers=_auth(),
                          json={"archetype": "triage", "input": "anything"})
    assert r.status_code == 404
