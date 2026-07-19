"""4-signal human-correction capture (P1, Agent-in-the-Loop): the transcript
records adoption+rationale, pairwise preference, knowledge-relevance and
missing-knowledge as first-class retraining inputs."""

from __future__ import annotations

from app.domain.transcripts import build_feedback


def test_reject_captures_adoption_preference_and_pii_redacted_rationale():
    fb = build_feedback(action="reject",
                        rationale="wrong — cardholder jane.doe@example.com already refunded")
    assert fb["adoption"] == "reject"
    assert fb["preference"] == "rejected"
    assert "jane.doe@example.com" not in fb["rationale"]  # rationale is PII-redacted
    assert "refunded" in fb["rationale"]


def test_edit_is_a_pairwise_preference_of_corrected_over_proposed():
    fb = build_feedback(action="edit_args", rationale="severity should be low")
    assert fb["adoption"] == "edit"
    assert fb["preference"] == "corrected_over_proposed"


def test_approve_is_adopted():
    assert build_feedback(action="approve")["preference"] == "adopted"


def test_knowledge_signals_included_only_when_supplied():
    bare = build_feedback(action="approve")
    assert "knowledge_relevance" not in bare and "missing_knowledge" not in bare
    rich = build_feedback(action="reject", knowledge_relevance="irrelevant",
                          missing_knowledge="the policy exclusion for cosmetic claims")
    assert rich["knowledge_relevance"] == "irrelevant"
    assert "cosmetic claims" in rich["missing_knowledge"]
