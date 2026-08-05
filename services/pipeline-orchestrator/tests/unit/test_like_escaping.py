"""A search term containing LIKE metacharacters must match LITERALLY.

`SqlTemplateRepo.list` built its `filter[name]` pattern as `f"%{name}%"` with no
ESCAPE, so `100%` matched every template and `a_b` matched `axb`. It returned
WRONG RESULTS rather than failing, which is the harder kind of bug to notice.

It survived because the two stores disagreed and the safe one is the one unit
tests use: the memory store has always done a plain substring match (literal by
construction), so nothing in the unit tier could see the SQL defect. These tests
pin the shared contract on both sides, so the stores cannot drift again.
"""

from __future__ import annotations

import pytest

from app.domain.ports import TemplateFilters
from app.utils import LIKE_ESCAPE, like_contains


class TestLikeContains:
    def test_wraps_a_plain_term_for_a_contains_match(self):
        assert like_contains("claims") == "%claims%"

    @pytest.mark.parametrize("term,expected", [
        ("100%", "%100\\%%"),
        ("a_b", "%a\\_b%"),
        ("%_%", "%\\%\\_\\%%"),
    ])
    def test_escapes_like_metacharacters(self, term, expected):
        assert like_contains(term) == expected

    def test_escapes_the_escape_character_itself_first(self):
        # A literal backslash must not turn the NEXT character into an escape.
        assert like_contains("a\\b") == "%a\\\\b%"
        assert like_contains("\\%") == "%\\\\\\%%"

    def test_escape_char_matches_what_the_call_site_passes(self):
        # The pattern is only literal if ilike(..., escape=LIKE_ESCAPE) agrees.
        assert LIKE_ESCAPE == "\\"

    def test_an_empty_term_is_a_match_all_not_a_crash(self):
        assert like_contains("") == "%%"


class TestMemoryStoreParity:
    """The memory store is the unit tier's store; its matching must mean the same
    thing as the escaped SQL, or the tier goes on hiding SQL defects."""

    async def _names(self, container, tenant, term):
        async with container.template_service.d.uow_factory(tenant) as uow:
            page = await uow.templates.list(TemplateFilters(name=term), 50, None)
        return [r.name for r in page.items]

    async def test_percent_is_literal_not_a_wildcard(self, container):
        from tests.conftest import TENANT_A
        async with container.template_service.d.uow_factory(TENANT_A) as uow:
            from app.domain.entities import PipelineTemplate
            from app.utils import new_id, utcnow
            for name in ("100% coverage", "claims triage"):
                await uow.templates.add(PipelineTemplate(
                    id=new_id(), tenant_id=TENANT_A, workspace_id="ws-1", name=name,
                    pipeline_type=0, model_type=None, algorithm_template_name=None,
                    active_version_id=None, is_system=False, created_by="u",
                    created_at=utcnow(), updated_at=utcnow()))
            await uow.commit()
        found = await self._names(container, TENANT_A, "100%")
        assert found == ["100% coverage"], "a % in the term must not act as a wildcard"

    async def test_underscore_is_literal_not_a_single_char_wildcard(self, container):
        from tests.conftest import TENANT_A
        async with container.template_service.d.uow_factory(TENANT_A) as uow:
            from app.domain.entities import PipelineTemplate
            from app.utils import new_id, utcnow
            for name in ("a_b run", "axb run"):
                await uow.templates.add(PipelineTemplate(
                    id=new_id(), tenant_id=TENANT_A, workspace_id="ws-1", name=name,
                    pipeline_type=0, model_type=None, algorithm_template_name=None,
                    active_version_id=None, is_system=False, created_by="u",
                    created_at=utcnow(), updated_at=utcnow()))
            await uow.commit()
        found = await self._names(container, TENANT_A, "a_b")
        assert found == ["a_b run"], "an _ in the term must not match any character"
