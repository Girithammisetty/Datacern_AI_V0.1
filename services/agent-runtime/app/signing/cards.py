"""A2A v1.0 agent-card signing (ART-FR-050). Cards are signed with the registry
key (same key as grants) so consumers can verify authenticity; the signature is a
detached RS256 JWS over the canonical card body (minus the signature field)."""

from __future__ import annotations

import jwt as pyjwt

from app.constants import A2A_PROTOCOL_VERSION
from app.domain.canonical import canonical_json
from app.signing.keys import SigningKey


def build_card(
    *,
    agent_key: str,
    version: int,
    display_name: str,
    description: str,
    write_mode: str,
    skills: list[dict],
    endpoint: str,
    eval_score_ref: str | None = None,
) -> dict:
    return {
        "name": f"datacern-{agent_key}",
        "version": str(version),
        "protocolVersion": A2A_PROTOCOL_VERSION,
        "description": description,
        "url": endpoint,
        "capabilities": {"streaming": True, "pushNotifications": False},
        "skills": skills,
        "securitySchemes": {"datacern-obo": {"type": "http", "scheme": "bearer"}},
        "x-datacern": {
            "agent_key": agent_key,
            "write_mode": write_mode,
            "eval_score_ref": eval_score_ref,
            "display_name": display_name,
        },
    }


def sign_card(key: SigningKey, card: dict) -> str:
    """Return a detached RS256 signature (compact JWS) over the canonical card.

    Uses the same Go-compatible ``canonical_json`` as the grant digest, so cards
    with non-ASCII ``display_name``/``description`` (e.g. "Zürich") sign and
    verify deterministically across languages/runtimes."""
    body = {k: v for k, v in card.items() if k != "signature"}
    payload_digest = canonical_json(body).hex()
    return pyjwt.encode(
        {"card_digest": payload_digest}, key.private_pem, algorithm="RS256",
        headers={"kid": key.kid},
    )


def verify_card(
    public_pem: str, card: dict, signature: str, *, expected_agent_key: str | None = None,
) -> bool:
    """Verify a detached A2A card signature — the counterpart to ``sign_card`` (P1).

    An inter-agent handoff must carry a VERIFIABLE identity claim, not be trusted by
    workflow position (MS AI Red Team: reject self-asserted roles at handoffs). This
    confirms the JWS was produced by the holder of the private key AND that the card
    body is unmodified (recomputed canonical digest must match). When
    ``expected_agent_key`` is given, the card's self-declared ``x-datacern.agent_key``
    must match it — so a card cannot assert an identity other than the one the caller
    resolved it for. Returns False on any signature/tamper/identity mismatch (never
    raises)."""
    if not signature or not isinstance(card, dict):
        return False
    body = {k: v for k, v in card.items() if k != "signature"}
    expected_digest = canonical_json(body).hex()
    try:
        claims = pyjwt.decode(signature, public_pem, algorithms=["RS256"])
    except pyjwt.InvalidTokenError:
        return False
    if claims.get("card_digest") != expected_digest:
        return False
    if expected_agent_key is not None:
        claimed = (card.get("x-datacern") or {}).get("agent_key")
        if claimed != expected_agent_key:
            return False
    return True
