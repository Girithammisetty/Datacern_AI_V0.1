"""Small shared helpers: uuid7, clock, cursors, etags, hashing, canonical JSON."""

from __future__ import annotations

import base64
import hashlib
import json
import secrets
import time
import uuid
from datetime import UTC, datetime

#: LIKE escape character, paired with ``escape=LIKE_ESCAPE`` at every call site.
LIKE_ESCAPE = "\\"


def like_contains(term: str) -> str:
    """Turn a user search term into a contains-style ILIKE pattern, escaping the
    LIKE metacharacters so a term containing ``%`` or ``_`` matches LITERALLY.

    Without this, ``filter[name]=100%`` matched every template and ``a_b`` matched
    ``axb`` — the search silently returned wrong results rather than failing, which
    is the harder kind of bug to notice. Mirrors experiment-service's identical
    helper (BRD 74 D3); kept per-service because there is no shared Python lib for
    store-layer helpers.
    """
    escaped = (term.replace(LIKE_ESCAPE, LIKE_ESCAPE * 2)
               .replace("%", LIKE_ESCAPE + "%")
               .replace("_", LIKE_ESCAPE + "_"))
    return f"%{escaped}%"


def uuid7() -> uuid.UUID:
    """RFC 9562 UUIDv7 (time-ordered)."""
    ts_ms = int(time.time() * 1000)
    rand_a = secrets.randbits(12)
    rand_b = secrets.randbits(62)
    value = (ts_ms << 80) | (0x7 << 76) | (rand_a << 64) | (0b10 << 62) | rand_b
    return uuid.UUID(int=value)


def new_id() -> str:
    return str(uuid7())


def utcnow() -> datetime:
    return datetime.now(UTC)


class Clock:
    """Injectable clock; tests replace with FakeClock."""

    def now(self) -> datetime:
        return utcnow()


def encode_cursor(payload: dict) -> str:
    return base64.urlsafe_b64encode(json.dumps(payload, default=str).encode()).decode()


def decode_cursor(cursor: str) -> dict:
    try:
        return json.loads(base64.urlsafe_b64decode(cursor.encode()).decode())
    except Exception as exc:  # noqa: BLE001
        raise ValueError("invalid cursor") from exc


def etag_for(updated_at: datetime) -> str:
    return hashlib.sha256(updated_at.isoformat().encode()).hexdigest()[:16]


def canonical_json(doc) -> str:
    """Deterministic JSON (sorted keys, no whitespace) — the basis for byte-identical
    compilation digests (PIPE-FR-020)."""
    return json.dumps(doc, sort_keys=True, separators=(",", ":"), default=str)


def sha256_hex(value: str | bytes) -> str:
    data = value.encode() if isinstance(value, str) else value
    return hashlib.sha256(data).hexdigest()
