"""SFTP / FTP as an ingestion SOURCE — the file-drop path (ING-FR-064).

`sftp` and `ftp` connections could be created, tested green and previewed, and
then could not ingest anything: the fetchers registered in
``wire_local_drivers`` were never called by any runner, and `file_poll` resolved
to ``UnsupportedObjectIngestor`` because only s3/gcs/azure_blob had one. A
customer dropping X12 835s on an SFTP server got a connection that looked
healthy and moved no data — the exact overclaim corrected in
docs/demo/wellstar-rcm-demo.md.

This closes it by treating a remote directory as what it is: a listing of files
with names and mtimes. That is the same shape a bucket has, so the pipeline is
NOT rewritten — ``run_file_ingest`` (objectsource.py) does the list → glob +
incremental-mtime filter → stream-decode → single snapshot, and each protocol
supplies only three things: how to list, how to stream one file, how to
disconnect. The watermark stays a typed mtime compared client-side (BR-5); no
path or timestamp is ever spliced into a request.

Both protocols are natively async (asyncssh / aioftp), so unlike the object
backends there is no thread wrapping here.
"""

from __future__ import annotations

import asyncio
import stat
from collections.abc import AsyncIterator
from datetime import UTC, datetime
from typing import Any

from pydantic import BaseModel

from app.domain.drivers.objectsource import IngestResult, ObjectRef, run_file_ingest

_READ_CHUNK = 1024 * 1024  # 1 MiB — matches the object-store engine


def _mtime(raw: Any) -> datetime | None:
    """Coerce a protocol-reported modification time to an aware datetime.

    Returning None (rather than a fabricated "now") is deliberate: an entry with
    no usable mtime is skipped by an incremental run instead of being re-pulled
    on every poll or, worse, silently advancing the watermark past files that
    were never read.
    """
    if raw is None:
        return None
    if isinstance(raw, datetime):
        return raw if raw.tzinfo else raw.replace(tzinfo=UTC)
    try:
        return datetime.fromtimestamp(int(raw), tz=UTC)
    except (TypeError, ValueError):
        return None


def _join(directory: str, name: str) -> str:
    return f"{directory.rstrip('/')}/{name}"


class SftpFileIngestor:
    """file_poll over SFTP: list `root_directory`, decode each matching file."""

    def __init__(self, *, connect_timeout_s: float = 15.0) -> None:
        self.connect_timeout_s = connect_timeout_s

    async def ingest(
        self,
        config: BaseModel,
        secrets: dict[str, str],
        *,
        table_writer: Any,
        table: str,
        ingestion_id: str,
        since: datetime | None = None,
        batch_size: int = 5000,
        error_row_limit: int = 100,
    ) -> IngestResult:
        import asyncssh

        from app.domain.drivers.sftp import _connect_kwargs

        root = getattr(config, "root_directory", "/") or "/"
        state: dict[str, Any] = {}

        async def list_refs() -> list[ObjectRef]:
            conn = await asyncssh.connect(
                **_connect_kwargs(config, secrets), connect_timeout=self.connect_timeout_s
            )
            state["conn"] = conn
            sftp = await conn.start_sftp_client()
            state["sftp"] = sftp
            refs: list[ObjectRef] = []
            for name in await sftp.listdir(root):
                if name in (".", ".."):
                    continue
                path = _join(root, name)
                attrs = await sftp.stat(path)
                # Skip anything that is not a regular file. A file drop is a
                # flat inbox; recursing would silently widen what a glob matches
                # and a directory entry would blow up the decoder.
                mode = getattr(attrs, "permissions", None)
                if mode is not None and not stat.S_ISREG(mode):
                    continue
                refs.append(
                    ObjectRef(
                        key=path,
                        size=int(getattr(attrs, "size", 0) or 0),
                        last_modified=_mtime(getattr(attrs, "mtime", None)),
                    )
                )
            return refs

        async def stream(key: str) -> AsyncIterator[bytes]:
            handle = await state["sftp"].open(key, "rb")
            try:
                while True:
                    chunk = await handle.read(_READ_CHUNK)
                    if not chunk:
                        break
                    yield chunk if isinstance(chunk, bytes) else chunk.encode()
            finally:
                await handle.close()

        async def close() -> None:
            sftp = state.pop("sftp", None)
            if sftp is not None:
                sftp.exit()
            conn = state.pop("conn", None)
            if conn is not None:
                conn.close()

        return await run_file_ingest(
            list_refs=list_refs,
            stream=stream,
            close=close,
            glob=getattr(config, "glob", None),
            since=since,
            file_format=getattr(config, "file_format", "csv"),
            table_writer=table_writer,
            table=table,
            ingestion_id=ingestion_id,
            source_label="file:sftp",
            batch_size=batch_size,
            error_row_limit=error_row_limit,
        )


class FtpFileIngestor:
    """file_poll over FTP/FTPS — same contract as SftpFileIngestor."""

    def __init__(self, *, connect_timeout_s: float = 15.0) -> None:
        self.connect_timeout_s = connect_timeout_s

    async def ingest(
        self,
        config: BaseModel,
        secrets: dict[str, str],
        *,
        table_writer: Any,
        table: str,
        ingestion_id: str,
        since: datetime | None = None,
        batch_size: int = 5000,
        error_row_limit: int = 100,
    ) -> IngestResult:
        import aioftp

        root = getattr(config, "root_directory", "/") or "/"
        state: dict[str, Any] = {}

        async def list_refs() -> list[ObjectRef]:
            client = (
                aioftp.Client(ssl=True) if getattr(config, "ftps", False) else aioftp.Client()
            )
            await asyncio.wait_for(
                client.connect(config.host, getattr(config, "port", 21)),
                timeout=self.connect_timeout_s,
            )
            await asyncio.wait_for(
                client.login(config.username, secrets.get("password", "")),
                timeout=self.connect_timeout_s,
            )
            state["client"] = client
            refs: list[ObjectRef] = []
            async for path_obj, info in client.list(root):
                if info.get("type") != "file":
                    continue
                refs.append(
                    ObjectRef(
                        key=str(path_obj),
                        size=int(info.get("size") or 0),
                        last_modified=_parse_mlsd_modify(info.get("modify")),
                    )
                )
            return refs

        async def stream(key: str) -> AsyncIterator[bytes]:
            async with state["client"].download_stream(key) as ftp_stream:
                async for block in ftp_stream.iter_by_block(_READ_CHUNK):
                    yield bytes(block)

        async def close() -> None:
            client = state.pop("client", None)
            if client is None:
                return
            try:
                await client.quit()
            except Exception:  # noqa: BLE001
                client.close()

        return await run_file_ingest(
            list_refs=list_refs,
            stream=stream,
            close=close,
            glob=getattr(config, "glob", None),
            since=since,
            file_format=getattr(config, "file_format", "csv"),
            table_writer=table_writer,
            table=table,
            ingestion_id=ingestion_id,
            source_label="file:ftp",
            batch_size=batch_size,
            error_row_limit=error_row_limit,
        )


def _parse_mlsd_modify(raw: str | None) -> datetime | None:
    """FTP MLSD reports `modify` as YYYYMMDDHHMMSS in UTC (RFC 3659)."""
    if not raw:
        return None
    try:
        return datetime.strptime(str(raw)[:14], "%Y%m%d%H%M%S").replace(tzinfo=UTC)
    except ValueError:
        return None
