"""Entity-resolution similarity comparators (BRD 56, ER-FR-010 depth).

The engine gains per-field comparators beyond the original Dice bigram: Jaro-
Winkler (stronger on short names + transpositions), phonetic/Soundex (sounds-
alike), exact (normalized equality as a scored signal) and numeric (magnitude
closeness). These are pure + deterministic, so they are unit-tested directly,
and the default stays "dice" so existing configs resolve byte-for-byte the same.
"""

from __future__ import annotations

import pytest

from app.domain.entity_resolution import (
    ResolutionConfig,
    ScoringField,
    field_similarity,
    jaro_similarity,
    jaro_winkler_similarity,
    numeric_similarity,
    phonetic_similarity,
    resolve,
    soundex,
    string_similarity,
)

# ---- Jaro-Winkler ----------------------------------------------------------

def test_jaro_winkler_identical_and_disjoint():
    assert jaro_winkler_similarity("petrov", "petrov") == 1.0
    assert jaro_winkler_similarity("abc", "xyz") == 0.0


def test_jaro_winkler_beats_dice_on_short_name_transposition():
    # A single transposition on a short token: Jaro-Winkler should score it high
    # AND higher than the Dice bigram coefficient (the reason to offer it).
    jw = jaro_winkler_similarity("martha", "marhta")
    assert jw > 0.9
    assert jw > string_similarity("martha", "marhta")


def test_jaro_winkler_prefix_boost():
    # A shared prefix lifts Jaro-Winkler above plain Jaro (which is its floor).
    assert jaro_winkler_similarity("dixon", "dickson") > jaro_similarity("dixon", "dickson")


# ---- phonetic / Soundex ----------------------------------------------------

def test_soundex_classic_codes():
    assert soundex("Robert") == "R163"
    assert soundex("Rupert") == "R163"        # same code
    assert soundex("Tymczak") == "T522"       # adjacent c,z collapse; vowel splits the last 2
    assert soundex("") == ""


def test_phonetic_matches_sounds_alike_not_spelling():
    assert phonetic_similarity("Smith", "Smyth") == 1.0
    assert phonetic_similarity("Claire", "Clair") == 1.0
    # Different-sounding names do not phonetic-match.
    assert phonetic_similarity("Smith", "Jones") == 0.0
    # Soundex keeps the FIRST letter, so a different initial never matches even
    # when the rest sounds alike (Catherine C365 vs Katharine K365).
    assert phonetic_similarity("Catherine", "Katharine") == 0.0
    # Order-insensitive, and sounds-alike within a token (Cathryn ~ Catherine).
    assert phonetic_similarity("Cathryn Zeta", "Zeta Catherine") == 1.0


def test_phonetic_empty_handling():
    assert phonetic_similarity("", "") == 1.0
    assert phonetic_similarity("Smith", "") == 0.0


# ---- exact + numeric -------------------------------------------------------

def test_exact_is_normalized_equality():
    # Normalization lowercases + collapses whitespace but keeps punctuation, so a
    # hyphen vs space still differs; case/whitespace-only differences match.
    assert field_similarity("AB-123", "ab 123", "exact") == 0.0
    assert field_similarity("Acme", "  acme ", "exact") == 1.0
    assert field_similarity("a", "b", "exact") == 0.0


def test_numeric_magnitude_closeness():
    assert numeric_similarity("100", "100") == 1.0
    assert numeric_similarity("100", "90") == pytest.approx(0.9)
    assert numeric_similarity("100", "0") == 0.0
    assert numeric_similarity("abc", "100") == 0.0  # non-numeric


# ---- dispatcher + default --------------------------------------------------

def test_field_similarity_default_and_unknown_fall_back_to_dice():
    a, b = "Viktor Petrov", "Victor Petrov"
    assert field_similarity(a, b, "dice") == string_similarity(a, b)
    # An unknown comparator never raises — it resolves as dice.
    assert field_similarity(a, b, "totally-made-up") == string_similarity(a, b)


# ---- end-to-end: comparator changes clustering -----------------------------

_ROWS = [
    {"pk": "p1", "name": "Smith", "dob": "1980-01-01"},
    {"pk": "p2", "name": "Smyth", "dob": "1980-01-01"},  # sounds alike, spelled apart
]


def test_phonetic_comparator_merges_where_dice_would_not():
    # Dice on "Smith"/"Smyth" is below a 0.8 auto-merge threshold; phonetic is 1.0.
    dice_cfg = ResolutionConfig(
        entity_type="person", scoring_fields=[ScoringField("name", 1.0, comparator="dice")],
        blocking_fields=["dob"], auto_merge_threshold=0.8, review_threshold=0.5)
    phon_cfg = ResolutionConfig(
        entity_type="person", scoring_fields=[ScoringField("name", 1.0, comparator="phonetic")],
        blocking_fields=["dob"], auto_merge_threshold=0.8, review_threshold=0.5)

    dice = resolve(_ROWS, dice_cfg, pk_column="pk")
    phon = resolve(_ROWS, phon_cfg, pk_column="pk")

    # Dice keeps them separate (2 singletons); phonetic merges them into 1.
    assert dice.resolved_count == 2
    assert phon.resolved_count == 1


def test_evidence_records_the_comparator_used():
    # A phonetic 1.0 auto-merges (>= threshold); the MERGED cluster's lineage
    # evidence names which comparator produced the score, so a steward reviewing
    # the resolved entity sees names matched by sound, not spelling.
    cfg = ResolutionConfig(
        entity_type="person", scoring_fields=[ScoringField("name", 1.0, comparator="phonetic")],
        blocking_fields=["dob"], auto_merge_threshold=0.8, review_threshold=0.5)
    result = resolve(_ROWS, cfg, pk_column="pk")
    merged = [c for c in result.clusters if len(c.member_pks) > 1]
    assert merged, "phonetic 1.0 should have merged Smith/Smyth"
    field_ev = [e for e in merged[0].evidence if "fields" in e]
    assert field_ev and field_ev[0]["fields"]["name"] == {"score": 1.0, "comparator": "phonetic"}
