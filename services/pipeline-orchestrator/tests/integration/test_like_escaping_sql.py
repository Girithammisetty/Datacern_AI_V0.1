"""BRD 74 follow-up, against REAL Postgres: `filter[name]` must match literally.

`SqlTemplateRepo.list` built its ILIKE pattern as `f"%{name}%"` with no ESCAPE, so
`100%` matched every template and `a_b` matched `axb`. It returned WRONG RESULTS
rather than failing.

The unit tier could not catch it: the memory store does a plain Python substring
match, which is literal by construction, so the two stores disagreed and the safe
one was the one unit tests use. Only real Postgres executes the LIKE pattern, so
the regression test has to live here.
"""

from __future__ import annotations

import pytest

from app.container import build_container
from app.domain.entities import CallCtx
from app.domain.ports import TemplateFilters
from tests.conftest import TENANT_A, WORKSPACE, data_prep_definition, make_settings

pytestmark = pytest.mark.integration

DATASET = "wr:t:dataset:dataset/claims"


def _ctx(tenant=TENANT_A):
    return CallCtx(tenant_id=tenant, actor={"type": "user", "id": "a"},
                   workspace_id=WORKSPACE)


async def _seed(c, names):
    for n in names:
        await c.template_service.create(_ctx(), {
            "workspace_id": WORKSPACE, "name": n, "pipeline_type": "data_prep",
            "definition": data_prep_definition(dataset=DATASET)})


async def _search(c, term):
    async with c.deps.uow_factory(TENANT_A) as uow:
        page = await uow.templates.list(TemplateFilters(name=term), 50, None)
    return sorted(t.name for t in page.items)


async def test_percent_in_a_search_term_is_literal(app_sf, clock):
    c = build_container(make_settings(), mode="sql", session_factory=app_sf, clock=clock)
    # "1000 runs" is the load-bearing row. Unescaped, the term "100%" becomes the
    # pattern "%100%%" — and since SQL collapses "%%" to one wildcard, that is just
    # "contains 100", which still matches "1000 runs". Seeding only rows that do
    # NOT contain "100" would let this test pass against the unescaped code, i.e.
    # pass for the wrong reason.
    await _seed(c, ["100% coverage", "1000 runs", "claims triage"])
    assert await _search(c, "100%") == ["100% coverage"]


async def test_underscore_in_a_search_term_is_literal(app_sf, clock):
    c = build_container(make_settings(), mode="sql", session_factory=app_sf, clock=clock)
    await _seed(c, ["a_b run", "axb run"])
    # Unescaped, "_" matches any single character and this matched both.
    assert await _search(c, "a_b") == ["a_b run"]


async def test_a_backslash_in_a_search_term_is_literal(app_sf, clock):
    # The escape character itself must be escaped first, or it swallows the next
    # character and the pattern silently changes meaning.
    c = build_container(make_settings(), mode="sql", session_factory=app_sf, clock=clock)
    await _seed(c, ["path\\to", "pathXto"])
    assert await _search(c, "path\\to") == ["path\\to"]


async def test_ordinary_terms_still_match_as_before(app_sf, clock):
    c = build_container(make_settings(), mode="sql", session_factory=app_sf, clock=clock)
    await _seed(c, ["claims triage", "claims scoring", "denial rates"])
    assert await _search(c, "claims") == ["claims scoring", "claims triage"]
