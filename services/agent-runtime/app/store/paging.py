"""Keyset-cursor + LIKE helpers (BRD 74 D3).

The decision-model list was the one list in this service that returned every
row for the tenant with no filter and no page, which is why the ⌘K palette had
to fetch it whole and match names in the browser. These are the two primitives
that fixed it — a real opaque keyset cursor and a LIKE pattern that treats the
user's metacharacters literally.
"""

from __future__ import annotations

import base64
import json

LIKE_ESCAPE = "\\"

MAX_CURSOR_BYTES = 512


def encode_cursor(payload: dict) -> str:
    """Opaque base64url cursor. Opaque to the client, not encrypted — it carries
    only the sort key of the last row on the page."""
    return base64.urlsafe_b64encode(json.dumps(payload, default=str).encode()).decode()


def decode_cursor(cursor: str) -> dict:
    """Decode a cursor, raising ValueError on anything malformed so the route can
    answer 422 instead of 500."""
    if len(cursor) > MAX_CURSOR_BYTES:
        raise ValueError("invalid cursor")
    try:
        payload = json.loads(base64.urlsafe_b64decode(cursor.encode()).decode())
    except Exception as exc:  # noqa: BLE001 - normalize any decode failure
        raise ValueError("invalid cursor") from exc
    if not isinstance(payload, dict):
        raise ValueError("invalid cursor")
    return payload


def like_contains(term: str) -> str:
    """Contains-style ILIKE pattern with the LIKE metacharacters escaped, so a
    search term containing ``%`` or ``_`` matches literally. Paired with
    ``ESCAPE '\\'`` at every call site."""
    escaped = (term.replace(LIKE_ESCAPE, LIKE_ESCAPE * 2)
               .replace("%", LIKE_ESCAPE + "%")
               .replace("_", LIKE_ESCAPE + "_"))
    return f"%{escaped}%"


def text_match(q: str | None, *fields: str | None) -> bool:
    """In-memory stand-in for the SQL contains, for the memory store."""
    if not q:
        return True
    needle = q.casefold()
    return any(needle in (f or "").casefold() for f in fields)
