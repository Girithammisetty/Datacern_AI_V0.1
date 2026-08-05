"""A real, CPU-only distilled decision student (SLM milestone 3, local backend).

Distils the tenant's governed-decision corpus — the SFT chat rows whose gold
target is the human-approved/-corrected action — into a small, servable
classifier that predicts the decision for a new input. It is a genuine trained
model (multinomial Naive Bayes over token counts, the classic text baseline),
deterministic and stdlib+numpy only, so it runs in-process on any stack with no
GPU. It is NOT a generative LLM: for the NARROW decision task a small
discriminative student is the right, honest tool (small models win on narrow
tasks) and it mirrors the platform's PROVEN classical-ML leg. Production-scale
generative LoRA distillation stays the GPU path (ModalGpuTrainer).

Pure domain: no I/O. The trainer serializes/stores; the server loads and
predicts; this trains, scores, and compares — deterministically (BR: same
corpus + split → same model → same accuracy, so an eval-gate is reproducible).
"""
from __future__ import annotations

import hashlib
import math
import re
from dataclasses import dataclass

import numpy as np

_TOKEN = re.compile(r"[a-z0-9]+")


def _tokens(text: str) -> list[str]:
    return _TOKEN.findall((text or "").lower())


def parse_corpus(examples_jsonl: str) -> list[tuple[str, str]]:
    """Extract (input_text, gold_decision) pairs from the frozen SFT JSONL.
    Input = the system+user turns the model saw; gold = the assistant turn (the
    human-approved decision). Rows without both are skipped, not invented."""
    import json

    out: list[tuple[str, str]] = []
    for line in examples_jsonl.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            msgs = json.loads(line).get("messages", [])
        except (ValueError, AttributeError):
            continue
        prompt = " ".join(
            str(m.get("content", "")) for m in msgs if m.get("role") in ("system", "user")
        )
        gold = next(
            (str(m.get("content", "")).strip() for m in reversed(msgs)
             if m.get("role") == "assistant"),
            "",
        )
        if prompt.strip() and gold:
            out.append((prompt, gold))
    return out


def split_holdout(examples: list[tuple[str, str]], *, holdout_frac: float = 0.25
                  ) -> tuple[list, list]:
    """Deterministic train/holdout split — ordered by a stable hash of the input
    so the same corpus always yields the same evaluation set (a reproducible
    gate, never a lucky shuffle)."""
    ordered = sorted(examples, key=lambda e: hashlib.sha256(e[0].encode()).hexdigest())
    n_hold = max(1, int(round(len(ordered) * holdout_frac))) if len(ordered) > 1 else 0
    if n_hold == 0:
        return ordered, []
    return ordered[:-n_hold], ordered[-n_hold:]


@dataclass
class DistilledStudent:
    """A trained multinomial-NB decision classifier. Serializes to plain JSON."""

    classes: list[str]
    vocab: dict[str, int]
    class_log_prior: list[float]
    feature_log_prob: list[list[float]]  # [n_classes][n_vocab]

    @classmethod
    def train(cls, examples: list[tuple[str, str]], *, alpha: float = 1.0
              ) -> DistilledStudent:
        classes = sorted({label for _, label in examples})
        cidx = {c: i for i, c in enumerate(classes)}
        vocab: dict[str, int] = {}
        for text, _ in examples:
            for tok in _tokens(text):
                if tok not in vocab:
                    vocab[tok] = len(vocab)
        n_c, n_v = len(classes), max(1, len(vocab))
        counts = np.full((n_c, n_v), 0.0)
        class_docs = np.zeros(n_c)
        for text, label in examples:
            ci = cidx[label]
            class_docs[ci] += 1
            for tok in _tokens(text):
                counts[ci, vocab[tok]] += 1.0
        # Laplace-smoothed multinomial likelihood + class prior (log space).
        smoothed = counts + alpha
        feature_log_prob = np.log(smoothed) - np.log(smoothed.sum(axis=1, keepdims=True))
        class_log_prior = np.log(class_docs + alpha) - math.log(
            class_docs.sum() + alpha * n_c)
        return cls(classes=classes, vocab=vocab,
                   class_log_prior=class_log_prior.tolist(),
                   feature_log_prob=feature_log_prob.tolist())

    def predict(self, text: str) -> tuple[str, float]:
        """Return (decision, confidence). Confidence = softmax mass on the top
        class over the log-joint scores."""
        prior = np.asarray(self.class_log_prior)
        flp = np.asarray(self.feature_log_prob)
        scores = prior.copy()
        for tok in _tokens(text):
            j = self.vocab.get(tok)
            if j is not None:
                scores = scores + flp[:, j]
        top = int(np.argmax(scores))
        # softmax for a bounded confidence (stable via max-subtraction).
        ex = np.exp(scores - scores.max())
        conf = float(ex[top] / ex.sum()) if ex.sum() else 0.0
        return self.classes[top], round(conf, 4)

    def to_dict(self) -> dict:
        return {
            "kind": "nb-decision-student/v1",
            "classes": self.classes, "vocab": self.vocab,
            "class_log_prior": self.class_log_prior,
            "feature_log_prob": self.feature_log_prob,
        }

    @classmethod
    def from_dict(cls, d: dict) -> DistilledStudent:
        return cls(classes=d["classes"], vocab=d["vocab"],
                   class_log_prior=d["class_log_prior"],
                   feature_log_prob=d["feature_log_prob"])


def accuracy(predict, evalset: list[tuple[str, str]]) -> float:
    """Fraction of held-out decisions the predictor gets right."""
    if not evalset:
        return 0.0
    hits = sum(1 for text, gold in evalset if predict(text) == gold)
    return round(hits / len(evalset), 4)


def majority_baseline(trainset: list[tuple[str, str]]):
    """The 'no tenant-specialized model' baseline: always predict the most common
    decision. Beating THIS is the minimum bar; the gate also compares against a
    real incumbent student when one is already promoted."""
    from collections import Counter

    if not trainset:
        return lambda _t: ""
    top = Counter(label for _, label in trainset).most_common(1)[0][0]
    return lambda _t: top
