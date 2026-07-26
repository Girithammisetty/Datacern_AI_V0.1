"""Settings.from_env() env-var overrides (BUG: inline_execution must be
genuinely environment-controlled, not a hardcoded True with no override)."""

from __future__ import annotations

import pytest
from httpx import ASGITransport, AsyncClient

from app.config import Settings
from app.container import build_container
from app.domain.querysource import FakeQuerySource
from app.main import create_app
from tests.util import AUDIENCE, ISSUER, bearer, create_connection, make_token


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("INGESTION_INLINE_EXECUTION", raising=False)


def test_inline_execution_defaults_true_when_unset() -> None:
    assert Settings.from_env().inline_execution is True


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("false", False),
        ("0", False),
        ("no", False),
        ("off", False),
        ("true", True),
        ("1", True),
        ("yes", True),
        ("TRUE", True),
    ],
)
def test_inline_execution_reads_env_override(
    monkeypatch: pytest.MonkeyPatch, raw: str, expected: bool
) -> None:
    monkeypatch.setenv("INGESTION_INLINE_EXECUTION", raw)
    assert Settings.from_env().inline_execution is expected


async def test_inline_execution_false_leaves_job_queued_not_run(tmp_path, rsa_keys) -> None:
    """Proves the flag actually gates execution end-to-end: with it off, a
    query ingestion is accepted and queued but IngestionRunner never touches
    it — there is no other consumer in this deployment (see scheduler.py)."""
    private_pem, public_pem = rsa_keys
    settings = Settings(
        database_url=f"sqlite+aiosqlite:///{tmp_path}/test.db",
        environment="test",
        data_dir=str(tmp_path / "data"),
        jwt_public_key_pem=public_pem.decode(),
        jwt_issuer=ISSUER,
        jwt_audience=AUDIENCE,
        inline_execution=False,
    )
    container = build_container(settings)
    await container.db.create_all()
    container.query_sources.set("postgres", FakeQuerySource(rows=[{"id": 1}]))
    app = create_app(container)
    transport = ASGITransport(app=app)
    try:
        async with AsyncClient(transport=transport, base_url="http://ingestion.test") as client:
            auth = bearer(make_token(private_pem))
            conn = await create_connection(client, auth)
            resp = await client.post(
                "/api/v1/ingestions",
                json={
                    "ingestion_mode": "query",
                    "connection_id": conn["id"],
                    "statement": "SELECT * FROM public.orders",
                    "new_dataset": {"name": "Orders"},
                },
                headers=auth,
            )
            assert resp.status_code == 202, resp.text
            job = resp.json()["data"]
            assert job["status"] == "queued"
            assert job["rows_appended"] == 0
            assert job["iceberg_snapshot_id"] is None
    finally:
        await container.db.dispose()
