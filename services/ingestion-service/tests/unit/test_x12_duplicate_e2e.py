"""X12 duplicate-ISA rejection, driven through the REAL upload pipeline
(BRD 57 STD-FR-043, AC-5) -- not just the domain function in isolation.

Uses `upload_file_flow` (API create -> init upload -> PUT parts -> complete)
against the inline runner, the same harness `test_file_format_ingest.py` uses
to prove parquet/avro ingest end-to-end. This is the closest thing to AC-1's
"real fixture ingested" this unit tier can exercise without a live SFTP
connector: real HTTP API, real DB, real `_attempt_file` -> `_guard_x12_duplicate`
-> `decode_x12` -> stage -> commit path, nothing mocked.
"""

from __future__ import annotations

from tests.unit.test_x12 import build_837
from tests.util import upload_file_flow


async def test_second_upload_with_same_isa_is_rejected_as_duplicate(client, auth_a):
    data = build_837(claims=1, isa_control="000000777")

    first = await upload_file_flow(client, auth_a, data, part_size=4096, file_format="x12")
    assert first["status"] == "completed", first
    assert first["rows_appended"] == 1

    second = await upload_file_flow(client, auth_a, data, part_size=4096, file_format="x12")
    assert second["status"] == "failed", second
    assert second["rows_appended"] == 0
    error = str(second.get("error_log") or "")
    assert "000000777" in error
    assert "already been processed" in error


async def test_a_different_isa_control_number_is_not_a_duplicate(client, auth_a):
    first = await upload_file_flow(
        client, auth_a, build_837(claims=1, isa_control="000000801"),
        part_size=4096, file_format="x12",
    )
    second = await upload_file_flow(
        client, auth_a, build_837(claims=1, isa_control="000000802"),
        part_size=4096, file_format="x12",
    )
    assert first["status"] == "completed" and second["status"] == "completed"
    assert first["rows_appended"] == 1 and second["rows_appended"] == 1


async def test_duplicate_isa_from_a_different_tenant_is_not_a_duplicate(client, auth_a, auth_b):
    data = build_837(claims=1, isa_control="000000900")
    a = await upload_file_flow(client, auth_a, data, part_size=4096, file_format="x12")
    b = await upload_file_flow(client, auth_b, data, part_size=4096, file_format="x12")
    assert a["status"] == "completed" and b["status"] == "completed"
