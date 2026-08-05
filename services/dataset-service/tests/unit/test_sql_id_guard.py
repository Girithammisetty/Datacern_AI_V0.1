"""The SQL layer's non-UUID id guard.

These tests exist because the API-level regression test for the same bug runs
against the MEMORY store (conftest builds the container with mode="memory"),
where a missing key is just a dict miss — it would pass with or without the
fix. The defect was in the SQL repositories, so it is asserted here directly,
with no database: a non-UUID id must be rejected BEFORE it reaches the session,
because that is precisely what asyncpg cannot be handed.

Live symptom this covers: GET /api/v1/datasets/forms-journey returned 500 with
an asyncpg/SQLAlchemy traceback instead of 404.
"""

from __future__ import annotations

import pytest

from app.store.sql import (
    SqlDatasetRepo,
    SqlEntityResolutionRepo,
    SqlProfileRepo,
    SqlVersionRepo,
    _is_uuid,
)


class ExplodingSession:
    """Stands in for AsyncSession. Any query at all is a test failure: reaching
    the database with a value the column type cannot hold is the bug."""

    async def get(self, *args, **kwargs):  # pragma: no cover - must not run
        raise AssertionError(
            "the repository queried the database with a non-UUID id; "
            "the guard was skipped"
        )


@pytest.mark.parametrize(
    "value",
    ["forms-journey", "not-a-uuid", "123", "", None, "  ", "0192f1a2-xxxx", 42],
)
def test_is_uuid_rejects_non_uuids(value):
    assert _is_uuid(value) is False


@pytest.mark.parametrize(
    "value",
    [
        "0192f1a2-4c3e-7a1b-9d2f-3e4a5b6c7d8e",
        "00000000-0000-0000-0000-000000000000",
        "0192F1A2-4C3E-7A1B-9D2F-3E4A5B6C7D8E",  # case-insensitive
    ],
)
def test_is_uuid_accepts_real_uuids(value):
    assert _is_uuid(value) is True


async def test_dataset_repo_returns_none_without_querying():
    repo = SqlDatasetRepo(ExplodingSession())
    assert await repo.get("forms-journey") is None


async def test_version_profile_and_resolution_repos_are_guarded_too():
    """The same trap exists on every by-id reader that takes a route parameter,
    so the guard is asserted across them rather than only where it was found."""
    assert await SqlVersionRepo(ExplodingSession()).get_by_id("nope") is None
    assert await SqlProfileRepo(ExplodingSession()).get("nope") is None

    resolution = SqlEntityResolutionRepo(
        ExplodingSession(), "0192f1a2-4c3e-7a1b-9d2f-3e4a5b6c7d8e"
    )
    assert await resolution.get_config("nope") is None
    assert await resolution.get_run("nope") is None
