"""Expertise Ledger aggregate — the governed-decision flywheel made visible.

Proves the ledger composes REAL reads: exact decision counts (GROUP BY, never
a truncated page), the correction subset (edits+rejects), outcome agreement,
SFT corpus size, the owned-model/honest-not-trained state, and tenant
isolation. No number is fabricated: empty tenants read zero / null, not a
placeholder.
"""
from __future__ import annotations

from datetime import UTC, datetime

import httpx
import pytest

from app.container import build_container
from app.domain.entities import Proposal, new_uuid, now
from app.main import create_app
from tests.conftest import TENANT_A, TENANT_B, make_settings, make_token


class _AllowAuthz:
    async def allow(self, **_):
        return True


@pytest.fixture
async def client_and_container():
    c = build_container(make_settings(), mode="memory", authz=_AllowAuthz())
    app = create_app(c)
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        yield client, c


def _auth(tenant=TENANT_A, sub="u-mgr"):
    return {"Authorization": f"Bearer {make_token(sub=sub, tenant_id=tenant, scopes=[])}"}


async def _seed_proposal(c, *, tenant=TENANT_A, status="approved"):
    pid = new_uuid()
    await c.store.create_proposal(Proposal(
        proposal_id=pid, tenant_id=tenant, session_id=new_uuid(), run_id=new_uuid(),
        agent_key="cust-x-copilot", agent_version=1, obo_user="u-77",
        tool_id="case.apply_disposition", tool_version="1.2.0", tier="write-proposal",
        side_effects="reversible",
        args={"case_id": "c-91", "disposition_code": "deny", "severity": "high"},
        rationale="x", affected_urns=[f"wr:{tenant}:case:case/c-91"],
        predicted_effect={"summary": "x", "reversibility": "reversible", "blast_radius": 1},
        expires_at=datetime.fromtimestamp(now().timestamp() + 3600, tz=UTC),
        status=status))
    return pid


async def test_empty_tenant_reads_zeros_not_placeholders(client_and_container):
    client, _ = client_and_container
    r = await client.get("/api/v1/expertise-ledger", headers=_auth())
    assert r.status_code == 200, r.text
    d = r.json()["data"]
    assert d["decisions"]["captured_all_time"] == 0
    assert d["decisions"]["corrections_in_window"] == 0
    # agreement with nothing scored is an honest null, never 0.
    assert d["agreement"]["agreement_rate"] is None
    assert d["corpus"]["example_rows"] == 0
    assert d["owned_model"]["has_owned_model"] is False
    assert d["owned_model"]["promoted"] is None


async def test_decision_counts_are_exact_and_classify_corrections(client_and_container):
    client, c = client_and_container
    # 3 approved, 2 edited (corrections), 1 rejected (correction), 1 pending (not a decision)
    for _ in range(3):
        await _seed_proposal(c, status="approved")
    for _ in range(2):
        await _seed_proposal(c, status="edited_approved")
    await _seed_proposal(c, status="rejected")
    await _seed_proposal(c, status="pending")

    d = (await client.get("/api/v1/expertise-ledger", headers=_auth())).json()["data"]
    # decided = approved + edited_approved + rejected = 6 (pending excluded)
    assert d["decisions"]["captured_all_time"] == 6
    # corrections = edits + rejects = 3
    assert d["decisions"]["corrections_in_window"] == 3
    assert d["decisions"]["by_status"]["approved"] == 3
    assert d["decisions"]["by_status"]["edited_approved"] == 2
    assert d["decisions"]["by_status"]["pending"] == 1


async def test_corpus_sums_real_sft_row_counts(client_and_container):
    client, c = client_and_container
    from app.domain.entities import SftDataset

    # persist two datasets via the real store method so example_rows is a real sum.
    for i, rows in enumerate((40, 60)):
        await c.store.record_sft_dataset(SftDataset(
            dataset_id=new_uuid(), tenant_id=TENANT_A, agent_key="cust-x-copilot",
            version=i + 1, status="built", row_count=rows, source_count=rows,
            curation_params={}, checksum=f"sha256:{i}", consent_verified=True,
            created_by="u-mgr", created_at=now()), [])
    d = (await client.get("/api/v1/expertise-ledger", headers=_auth())).json()["data"]
    assert d["corpus"]["dataset_versions"] == 2
    assert d["corpus"]["example_rows"] == 100
    assert d["corpus"]["consent_verified_versions"] == 2
    assert d["corpus"]["latest"] is not None


async def test_tenant_isolation(client_and_container):
    client, c = client_and_container
    await _seed_proposal(c, tenant=TENANT_A, status="approved")
    await _seed_proposal(c, tenant=TENANT_A, status="approved")
    await _seed_proposal(c, tenant=TENANT_B, status="approved")

    a = (await client.get("/api/v1/expertise-ledger",
                          headers=_auth(tenant=TENANT_A))).json()["data"]
    b = (await client.get("/api/v1/expertise-ledger",
                          headers=_auth(tenant=TENANT_B))).json()["data"]
    assert a["decisions"]["captured_all_time"] == 2
    assert b["decisions"]["captured_all_time"] == 1
