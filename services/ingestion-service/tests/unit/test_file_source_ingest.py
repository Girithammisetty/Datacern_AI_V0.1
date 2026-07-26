"""SFTP / FTP as an ingestion source (ING-FR-064).

`sftp` and `ftp` connections tested green, previewed rows, and then could not
ingest: `file_poll` resolved to UnsupportedObjectIngestor and the registered
fetchers had no caller anywhere. These tests pin the pipeline against injected
protocol clients (the live counterpart, against a real SFTP server, is in
tests/integration/test_local_drivers.py).
"""

from __future__ import annotations

from datetime import UTC, datetime

import pytest

from app.domain.connectors import FtpConfig, SftpConfig, validate_config
from app.domain.drivers.filesource import (
    FtpFileIngestor,
    SftpFileIngestor,
    _mtime,
    _parse_mlsd_modify,
)
from app.domain.tablewriter import ParquetFileTableWriter

CSV_A = b"id,name\n1,alpha\n2,beta\n"
CSV_B = b"id,name\n3,gamma\n"


# --------------------------------------------------------------------------- fakes


class _Attrs:
    def __init__(self, size: int, mtime: int | None, permissions: int | None) -> None:
        self.size = size
        self.mtime = mtime
        self.permissions = permissions


class _Handle:
    def __init__(self, data: bytes) -> None:
        self._data = data
        self._pos = 0
        self.closed = False

    async def read(self, n: int) -> bytes:
        chunk = self._data[self._pos : self._pos + n]
        self._pos += n
        return chunk

    async def close(self) -> None:
        self.closed = True


class FakeSftp:
    """Records every listdir/open so tests can prove no watermark is spliced."""

    def __init__(self, files: dict[str, tuple[bytes, int | None, int]]) -> None:
        self.files = files
        self.listdir_calls: list[str] = []
        self.opened: list[str] = []
        self.exited = False

    async def listdir(self, path: str) -> list[str]:
        self.listdir_calls.append(path)
        return [".", "..", *[k.rsplit("/", 1)[-1] for k in self.files]]

    async def stat(self, path: str):
        data, mtime, mode = self.files[path]
        return _Attrs(len(data), mtime, mode)

    async def open(self, path: str, _mode: str) -> _Handle:
        self.opened.append(path)
        return _Handle(self.files[path][0])

    def exit(self) -> None:
        self.exited = True


class _FakeConn:
    def __init__(self, sftp: FakeSftp) -> None:
        self._sftp = sftp
        self.closed = False

    async def start_sftp_client(self) -> FakeSftp:
        return self._sftp

    def close(self) -> None:
        self.closed = True


_REG = 0o100644  # S_IFREG | 0644
_DIR = 0o040755  # S_IFDIR | 0755


def _install_fake_sftp(monkeypatch, sftp: FakeSftp) -> _FakeConn:
    import asyncssh

    conn = _FakeConn(sftp)

    async def _connect(**_kwargs):
        return conn

    monkeypatch.setattr(asyncssh, "connect", _connect)
    return conn


@pytest.fixture()
def writer(tmp_path) -> ParquetFileTableWriter:
    return ParquetFileTableWriter(tmp_path / "bronze")


# --------------------------------------------------------------------------- sftp


async def test_sftp_file_poll_ingests_every_matching_file(monkeypatch, writer) -> None:
    sftp = FakeSftp(
        {
            "/drop/a.csv": (CSV_A, 1_760_000_000, _REG),
            "/drop/b.csv": (CSV_B, 1_760_000_100, _REG),
        }
    )
    _install_fake_sftp(monkeypatch, sftp)
    config = SftpConfig(host="h", username="u", root_directory="/drop", file_format="csv")

    result = await SftpFileIngestor().ingest(
        config, {}, table_writer=writer, table="t", ingestion_id="ing-1"
    )

    assert result.rows == 3  # 2 + 1 across both files
    assert result.objects == 2
    assert sorted(sftp.opened) == ["/drop/a.csv", "/drop/b.csv"]
    # BR-9: one snapshot for the whole pull, not one per file.
    assert len(writer.all_snapshots()) == 1


async def test_sftp_glob_narrows_the_drop(monkeypatch, writer) -> None:
    sftp = FakeSftp(
        {
            "/drop/claims.csv": (CSV_A, 1_760_000_000, _REG),
            "/drop/notes.txt": (b"ignore me", 1_760_000_100, _REG),
        }
    )
    _install_fake_sftp(monkeypatch, sftp)
    config = SftpConfig(host="h", username="u", root_directory="/drop", glob="*.csv")

    result = await SftpFileIngestor().ingest(
        config, {}, table_writer=writer, table="t", ingestion_id="ing-1"
    )
    assert result.objects == 1
    assert sftp.opened == ["/drop/claims.csv"]


async def test_sftp_incremental_watermark_skips_already_pulled_files(monkeypatch, writer) -> None:
    old, new = 1_760_000_000, 1_760_009_999
    sftp = FakeSftp(
        {"/drop/old.csv": (CSV_A, old, _REG), "/drop/new.csv": (CSV_B, new, _REG)}
    )
    _install_fake_sftp(monkeypatch, sftp)
    config = SftpConfig(host="h", username="u", root_directory="/drop")

    result = await SftpFileIngestor().ingest(
        config,
        {},
        table_writer=writer,
        table="t",
        ingestion_id="ing-2",
        since=datetime.fromtimestamp(old, tz=UTC),
    )

    assert sftp.opened == ["/drop/new.csv"]  # the old file is not re-pulled
    # The listing request carries only the directory — the bound is compared
    # client-side on typed mtimes, never spliced into a protocol call (BR-5).
    assert sftp.listdir_calls == ["/drop"]
    # ...and the next run's watermark advances to the newest mtime seen.
    assert result.new_watermark is not None
    assert str(new) not in "".join(sftp.listdir_calls)


async def test_sftp_skips_subdirectories(monkeypatch, writer) -> None:
    sftp = FakeSftp(
        {"/drop/a.csv": (CSV_A, 1_760_000_000, _REG), "/drop/archive": (b"", 1_760_000_100, _DIR)}
    )
    _install_fake_sftp(monkeypatch, sftp)
    config = SftpConfig(host="h", username="u", root_directory="/drop")

    result = await SftpFileIngestor().ingest(
        config, {}, table_writer=writer, table="t", ingestion_id="ing-3"
    )
    assert result.objects == 1
    assert sftp.opened == ["/drop/a.csv"]


async def test_sftp_disconnects_even_when_decoding_fails(monkeypatch, writer) -> None:
    sftp = FakeSftp({"/drop/a.parquet": (b"not parquet at all", 1_760_000_000, _REG)})
    conn = _install_fake_sftp(monkeypatch, sftp)
    config = SftpConfig(host="h", username="u", root_directory="/drop", file_format="parquet")

    with pytest.raises(Exception):  # noqa: B017 — any decode failure, not a specific class
        await SftpFileIngestor().ingest(
            config, {}, table_writer=writer, table="t", ingestion_id="ing-4"
        )
    assert sftp.exited and conn.closed  # no leaked SSH connection


async def test_sftp_connect_failure_is_transient_not_permanent(monkeypatch, writer) -> None:
    """ING-FR-081: an unreachable server is retryable, not a dead job."""
    import asyncssh

    from app.domain.errors import TransientSourceError

    async def _boom(**_kwargs):
        raise OSError("connection refused")

    monkeypatch.setattr(asyncssh, "connect", _boom)
    with pytest.raises(TransientSourceError):
        await SftpFileIngestor().ingest(
            SftpConfig(host="h", username="u"),
            {},
            table_writer=writer,
            table="t",
            ingestion_id="ing-5",
        )


# --------------------------------------------------------------------------- ftp


class FakeFtpClient:
    def __init__(self, files: dict[str, tuple[bytes, str, str]]) -> None:
        self.files = files
        self.list_calls: list[str] = []
        self.downloaded: list[str] = []
        self.quit_called = False

    async def list(self, path: str):
        self.list_calls.append(path)
        for key, (data, modify, kind) in self.files.items():
            yield key, {"type": kind, "size": str(len(data)), "modify": modify}

    def download_stream(self, key: str):
        self.downloaded.append(key)
        data = self.files[key][0]

        class _Stream:
            async def __aenter__(self_inner):
                return self_inner

            async def __aexit__(self_inner, *_exc):
                return False

            async def iter_by_block(self_inner, _n):
                yield data

        return _Stream()

    async def quit(self) -> None:
        self.quit_called = True

    def close(self) -> None:
        pass


def _install_fake_ftp(monkeypatch, client: FakeFtpClient) -> None:
    import aioftp

    async def _noop(*_a, **_k):
        return None

    monkeypatch.setattr(aioftp, "Client", lambda **_k: client)
    client.connect = _noop  # type: ignore[method-assign]
    client.login = _noop  # type: ignore[method-assign]


async def test_ftp_file_poll_ingests_and_honours_type_and_watermark(monkeypatch, writer) -> None:
    client = FakeFtpClient(
        {
            "/drop/old.csv": (CSV_A, "20260701000000", "file"),
            "/drop/new.csv": (CSV_B, "20260705000000", "file"),
            "/drop/archive": (b"", "20260706000000", "dir"),
        }
    )
    _install_fake_ftp(monkeypatch, client)
    config = FtpConfig(host="h", username="u", root_directory="/drop")

    result = await FtpFileIngestor().ingest(
        config,
        {},
        table_writer=writer,
        table="t",
        ingestion_id="ing-6",
        since=datetime(2026, 7, 2, tzinfo=UTC),
    )

    assert client.downloaded == ["/drop/new.csv"]  # dir skipped, old file skipped
    assert result.rows == 1
    assert client.quit_called  # the control connection is always closed


# --------------------------------------------------------------------------- helpers


def test_mtime_returns_none_rather_than_inventing_a_timestamp() -> None:
    """A fabricated "now" would advance the watermark past files never read."""
    assert _mtime(None) is None
    assert _mtime("not a number") is None
    assert _mtime(1_760_000_000) == datetime.fromtimestamp(1_760_000_000, tz=UTC)


def test_parse_mlsd_modify_reads_rfc3659_utc() -> None:
    assert _parse_mlsd_modify("20260705123045") == datetime(2026, 7, 5, 12, 30, 45, tzinfo=UTC)
    assert _parse_mlsd_modify("garbage") is None
    assert _parse_mlsd_modify(None) is None


# --------------------------------------------------------------------------- wiring


def test_sftp_config_accepts_the_file_poll_fields() -> None:
    cfg = validate_config("sftp", {"host": "h", "username": "u", "glob": "*.csv"})
    assert cfg.file_format == "csv"  # defaulted, so existing connections still validate
    assert cfg.glob == "*.csv"


def test_real_container_wires_file_poll_ingestors_for_sftp_and_ftp(tmp_path) -> None:
    from app.config import Settings
    from app.container import _build_real
    from app.domain.drivers.objectsource import UnsupportedObjectIngestor

    c = _build_real(
        Settings(
            database_url=f"sqlite+aiosqlite:///{tmp_path}/real.db",
            adapter_mode="real",
            data_dir=str(tmp_path / "data"),
        )
    )
    for ctype in ("sftp", "ftp"):
        assert not isinstance(c.object_ingestors.get(ctype), UnsupportedObjectIngestor), ctype
