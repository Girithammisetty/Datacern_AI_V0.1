"""The CPU distilled decision student (pure domain) — real, deterministic, wins.

Proves the student is a genuine trained model that BEATS the majority-class
baseline on held-out decisions when the corpus carries signal, is reproducible
(same corpus → same model → same accuracy), and round-trips through JSON.
"""
from __future__ import annotations

import json

from app.domain.distill import (
    DistilledStudent,
    accuracy,
    majority_baseline,
    parse_corpus,
    split_holdout,
)


def _row(text: str, label: str) -> str:
    return json.dumps({"messages": [{"role": "user", "content": text},
                                    {"role": "assistant", "content": label}]})


# A separable corpus: fraud-signal inputs → deny, clean-signal inputs → approve.
CORPUS = "\n".join([
    _row("suspicious fraud ring flagged high risk", "deny"),
    _row("known fraud pattern duplicate billing", "deny"),
    _row("fraud alert stolen identity chargeback", "deny"),
    _row("fraudulent claim fabricated receipt", "deny"),
    _row("verified legitimate member routine visit", "approve"),
    _row("clean history verified provider in network", "approve"),
    _row("legitimate documented medically necessary", "approve"),
    _row("routine verified approved coverage active", "approve"),
])


def test_parse_corpus_extracts_input_and_gold():
    pairs = parse_corpus(CORPUS)
    assert len(pairs) == 8
    assert all(lbl in ("deny", "approve") for _, lbl in pairs)


def test_split_is_deterministic():
    pairs = parse_corpus(CORPUS)
    a1, h1 = split_holdout(pairs, holdout_frac=0.25)
    a2, h2 = split_holdout(pairs, holdout_frac=0.25)
    assert h1 == h2 and a1 == a2          # reproducible → a reproducible gate
    assert len(h1) == 2


def test_student_beats_majority_on_holdout():
    pairs = parse_corpus(CORPUS)
    train, holdout = split_holdout(pairs, holdout_frac=0.25)
    student = DistilledStudent.train(train)
    student_acc = accuracy(lambda t: student.predict(t)[0], holdout)
    base_acc = accuracy(majority_baseline(train), holdout)
    assert student_acc > base_acc          # the "wins" property
    assert student_acc == 1.0              # separable corpus → perfect on holdout


def test_predict_returns_label_and_bounded_confidence():
    student = DistilledStudent.train(parse_corpus(CORPUS))
    label, conf = student.predict("this looks like a fraud ring")
    assert label == "deny"
    assert 0.0 <= conf <= 1.0


def test_json_round_trip_is_faithful():
    student = DistilledStudent.train(parse_corpus(CORPUS))
    revived = DistilledStudent.from_dict(json.loads(json.dumps(student.to_dict())))
    assert revived.predict("verified legitimate visit")[0] == \
        student.predict("verified legitimate visit")[0]


def test_training_is_reproducible():
    pairs = parse_corpus(CORPUS)
    a = DistilledStudent.train(pairs).to_dict()
    b = DistilledStudent.train(pairs).to_dict()
    assert a == b
