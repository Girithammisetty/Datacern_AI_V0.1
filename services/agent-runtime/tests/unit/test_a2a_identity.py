"""Verifiable inter-agent identity (P1): A2A card verify + orchestrator handoff
allow-listing (reject self-asserted roles, MS AI Red Team taxonomy v2.0)."""

from __future__ import annotations

from app.graphs.meta_router import _ALLOWED, _DEFAULT, _safe_delegate_target
from app.signing import SigningKey, build_card, sign_card, verify_card


def _card(agent_key="case-triage"):
    return build_card(
        agent_key=agent_key, version=1, display_name="Zürich Triage", description="d",
        write_mode="proposal", skills=[], endpoint="https://x/a2a/case-triage",
        eval_score_ref="g-1")


def test_sign_then_verify_roundtrips():
    k = SigningKey(None, "kid-1")
    card = _card()
    sig = sign_card(k, card)
    assert verify_card(k.public_pem, card, sig) is True
    assert verify_card(k.public_pem, card, sig, expected_agent_key="case-triage") is True


def test_tampered_card_body_fails_verification():
    k = SigningKey(None, "kid-1")
    card = _card()
    sig = sign_card(k, card)
    card["x-windrose"]["write_mode"] = "direct"  # attacker upgrades the write mode
    assert verify_card(k.public_pem, card, sig) is False


def test_wrong_key_fails_verification():
    signer, attacker = SigningKey(None, "a"), SigningKey(None, "b")
    card = _card()
    sig = sign_card(signer, card)
    assert verify_card(attacker.public_pem, card, sig) is False


def test_self_asserted_identity_mismatch_is_rejected():
    k = SigningKey(None, "kid-1")
    card = _card(agent_key="case-triage")
    sig = sign_card(k, card)
    # Card is validly signed, but it claims to be case-triage while the caller
    # resolved it as the (higher-privilege) governance agent → reject.
    assert verify_card(k.public_pem, card, sig, expected_agent_key="governance") is False


def test_empty_signature_is_rejected():
    k = SigningKey(None, "kid-1")
    assert verify_card(k.public_pem, _card(), "") is False


def test_orchestrator_only_dispatches_to_allowlisted_registered_delegate():
    runners = {a: object() for a in _ALLOWED}
    # A legitimate, registered target passes through unchanged.
    some = next(iter(_ALLOWED))
    assert _safe_delegate_target(some, runners) == some
    # An off-list (self-asserted) target falls back to the safe default.
    assert _safe_delegate_target("attacker-agent", runners) == _DEFAULT
    # An allow-listed but UN-registered target also falls back (never KeyErrors).
    assert _safe_delegate_target(some, {}) == _DEFAULT
