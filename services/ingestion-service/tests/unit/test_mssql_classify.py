"""Unit coverage for the SQL Server error classifier (app/domain/drivers/mssql).

The integration test (test_new_db_drivers) needs a real SQL Server container; this
pins the classification logic directly against the exception shapes FreeTDS/pymssql
actually raises, so a bad-login to a reachable server is reported AUTH_FAILED (not
SOURCE_UNREACHABLE) regardless of whether the SQL number lands in args[0] or only
in the DB-Lib message text — and a genuine network failure still stays UNREACHABLE.
"""

from __future__ import annotations

import pymssql

from app.domain.drivers.mssql import _classify
from app.domain.errors import ErrorCategory


def test_login_failure_with_numeric_arg_is_auth_failed():
    exc = pymssql.OperationalError(18456, b"Login failed for user 'sa'.")
    cat, detail = _classify(exc)
    assert cat == ErrorCategory.AUTH_FAILED
    assert "sa" not in detail and "password" not in detail  # scrubbed


def test_login_failure_text_only_is_auth_failed():
    # FreeTDS variant: args[0] is the message, the SQL number only in the text.
    exc = pymssql.OperationalError(
        "DB-Lib error: Login failed for user 'sa'. (18456)")
    assert _classify(exc)[0] == ErrorCategory.AUTH_FAILED


def test_cannot_open_database_is_auth_failed():
    exc = pymssql.OperationalError(4060, b"Cannot open database requested by the login.")
    assert _classify(exc)[0] == ErrorCategory.AUTH_FAILED


def test_unreachable_server_stays_source_unreachable():
    # A genuine network failure carries none of the auth signatures.
    exc = pymssql.OperationalError(
        20009, b"DB-Lib error: Unable to connect: Adaptive Server is unavailable "
               b"or does not exist")
    assert _classify(exc)[0] == ErrorCategory.SOURCE_UNREACHABLE


def test_timeout_is_timeout():
    assert _classify(TimeoutError("timed out"))[0] == ErrorCategory.TIMEOUT


def test_non_pymssql_error_is_source_unreachable():
    assert _classify(RuntimeError("boom"))[0] == ErrorCategory.SOURCE_UNREACHABLE
