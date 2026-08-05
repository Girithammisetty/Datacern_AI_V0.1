"""BRD 74 D3 — `q` + keyset paging on GET /decision-models.

Before this increment the route returned EVERY decision table for the tenant,
unfiltered and unpaged, which is why the ⌘K palette fetched the lot and matched
names in the browser. These tests pin the server-side behaviour that replaced
it, including tenant isolation.
"""

from __future__ import annotations

import httpx
import pytest

from app.container import build_container
from app.main import create_app
from app.store.paging import decode_cursor, encode_cursor, like_contains, text_match
from tests.conftest import TENANT_A, TENANT_B, make_settings, make_token


class _AllowAuthz:
    async def allow(self, *, subject, action, tenant, resource_urn=None, workspace_id=None):
        return True


class _NoCatalog:
    """No disposition catalog -> author-time code validation is skipped, which
    keeps these fixtures about names rather than dispositions."""


@pytest.fixture
async def client_and_container():
    c = build_container(make_settings(), mode="memory", authz=_AllowAuthz(),
                        case_reader=_NoCatalog())
    app = create_app(c)
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        yield client, c


def _auth(tenant=TENANT_A, sub="u-mgr"):
    return {"Authorization": f"Bearer {make_token(sub=sub, tenant_id=tenant, scopes=[])}"}


def _body(name, dataset_urn=None):
    b = {"name": name,
         "rules": [{"when": [{"column": "amount", "op": "gt", "value": 1000}],
                    "then": {"disposition_code": "escalate_fraud_review",
                             "severity": "high"}}],
         "default_outcome": {"disposition_code": "deny_no_error_found",
                             "severity": "medium"}}
    if dataset_urn:
        b["dataset_urn"] = dataset_urn
    return b


async def _create(client, name, tenant=TENANT_A, dataset_urn=None):
    r = await client.post("/api/v1/decision-models", json=_body(name, dataset_urn),
                          headers=_auth(tenant))
    assert r.status_code == 201, r.text
    return r.json()["data"]["id"]


async def _names(client, url, tenant=TENANT_A):
    r = await client.get(url, headers=_auth(tenant))
    assert r.status_code == 200, r.text
    return [m["name"] for m in r.json()["data"]], r.json()


# ---- helpers -----------------------------------------------------------------

def test_like_contains_escapes_metacharacters():
    assert like_contains("denial") == "%denial%"
    assert like_contains("100%") == "%100\\%%"
    assert like_contains("a_b") == "%a\\_b%"


def test_cursor_roundtrip_and_rejection():
    assert decode_cursor(encode_cursor({"n": "a", "v": 2})) == {"n": "a", "v": 2}
    for bad in ("not-base64!!", encode_cursor([1, 2]), "x" * 600):
        with pytest.raises(ValueError):
            decode_cursor(bad)


def test_text_match_is_case_insensitive_over_several_fields():
    assert text_match("DENIAL", "denial rate", None)
    assert text_match(None, "anything")
    assert not text_match("denial", "churn", "wr:t:dataset:dataset/claims")


# ---- the route ---------------------------------------------------------------

async def test_q_filters_by_name_and_dataset_urn(client_and_container):
    client, _ = client_and_container
    await _create(client, "Denial rate table")
    await _create(client, "Churn table", dataset_urn="wr:t:dataset:dataset/denials")
    await _create(client, "Unrelated table", dataset_urn="wr:t:dataset:dataset/claims")

    names, _ = await _names(client, "/api/v1/decision-models?q=denial")
    assert sorted(names) == ["Churn table", "Denial rate table"]


async def test_q_is_case_insensitive(client_and_container):
    client, _ = client_and_container
    await _create(client, "Denial rate table")
    for needle in ("denial", "DENIAL", "DeNiAl"):
        names, _ = await _names(client, f"/api/v1/decision-models?q={needle}")
        assert names == ["Denial rate table"]


async def test_q_treats_like_metacharacters_literally(client_and_container):
    client, _ = client_and_container
    await _create(client, "Coverage 100% table")
    await _create(client, "Coverage partial table")

    names, _ = await _names(client, "/api/v1/decision-models?q=100%25")
    assert names == ["Coverage 100% table"]


async def test_list_is_keyset_paged_and_the_cursor_terminates(client_and_container):
    client, _ = client_and_container
    for i in range(5):
        await _create(client, f"Denial table {i}")

    seen: list[str] = []
    url = "/api/v1/decision-models?q=denial&limit=2"
    for _ in range(6):
        names, body = await _names(client, url)
        assert len(names) <= 2
        seen.extend(names)
        if not body["page"]["has_more"]:
            break
        url = ("/api/v1/decision-models?q=denial&limit=2&cursor="
               + body["page"]["next_cursor"])
    else:
        pytest.fail("paging did not terminate")

    assert sorted(seen) == [f"Denial table {i}" for i in range(5)]
    assert len(set(seen)) == 5  # no row repeated across pages


async def test_a_row_beyond_the_first_page_is_still_findable(client_and_container):
    """The palette defect in miniature: 60 tables, and the one the user wants
    sorts last. Unfiltered page 1 misses it; `q` returns it."""
    client, _ = client_and_container
    for i in range(60):
        await _create(client, f"Ops table {i:02d}")
    await _create(client, "Zebra denial table")

    page1, body = await _names(client, "/api/v1/decision-models?limit=50")
    assert len(page1) == 50 and body["page"]["has_more"] is True
    assert "Zebra denial table" not in page1

    found, _ = await _names(client, "/api/v1/decision-models?q=zebra denial")
    assert found == ["Zebra denial table"]


async def test_a_bad_cursor_is_422_not_500(client_and_container):
    client, _ = client_and_container
    r = await client.get("/api/v1/decision-models?cursor=not-a-cursor", headers=_auth())
    assert r.status_code == 422, r.text


async def test_search_is_tenant_isolated(client_and_container):
    client, _ = client_and_container
    await _create(client, "Denial rate table", tenant=TENANT_A)

    names, _ = await _names(client, "/api/v1/decision-models?q=denial", tenant=TENANT_B)
    assert names == []
