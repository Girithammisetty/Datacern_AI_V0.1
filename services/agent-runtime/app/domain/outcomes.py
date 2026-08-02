"""Decision outcome labels + effectiveness (BRD 55).

A pure domain layer: the OutcomeLabel record and the effectiveness aggregation
(decided-vs-realized agreement, sliced by decision type + producer). No I/O —
the store persists, the API captures, this computes. Correlational effectiveness
only (BR-3): agreement, never a causal claim.
"""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass


@dataclass(slots=True)
class OutcomeLabel:
    label_id: str
    tenant_id: str
    decision_ref: str
    decision_type: str
    realized_outcome: str
    decided_outcome: str | None = None
    correct: bool | None = None
    label_source: str = "human"   # human | sor | event
    note: str | None = None
    labeled_by: str | None = None
    producer: str | None = None


LABEL_SOURCES = ("human", "sor", "event")


def compute_correct(decided: str | None, realized: str) -> bool | None:
    """None when we can't compare (no decided outcome recorded); else a
    case-insensitive equality — the correlational agreement signal."""
    if decided is None or str(decided).strip() == "":
        return None
    return str(decided).strip().lower() == str(realized).strip().lower()


@dataclass(slots=True)
class EffectivenessRow:
    key: str
    total: int = 0
    correct: int = 0
    incorrect: int = 0
    unknown: int = 0

    @property
    def effectiveness_rate(self) -> float | None:
        scored = self.correct + self.incorrect
        return round(self.correct / scored, 4) if scored else None

    def to_dict(self) -> dict:
        return {"key": self.key, "total": self.total, "correct": self.correct,
                "incorrect": self.incorrect, "unknown": self.unknown,
                "effectiveness_rate": self.effectiveness_rate}


def effectiveness(labels: list[OutcomeLabel], *, by: str = "decision_type") -> list[dict]:
    """Aggregate agreement (decided vs realized) grouped by ``decision_type`` or
    ``producer``. Rows sorted by total desc. Deterministic (BR-2/BR-5)."""
    buckets: dict[str, EffectivenessRow] = defaultdict(lambda: EffectivenessRow(key=""))
    for lab in labels:
        k = (lab.decision_type if by == "decision_type" else (lab.producer or "unknown"))
        row = buckets[k]
        row.key = k
        row.total += 1
        if lab.correct is True:
            row.correct += 1
        elif lab.correct is False:
            row.incorrect += 1
        else:
            row.unknown += 1
    return [r.to_dict() for r in sorted(buckets.values(),
                                        key=lambda r: r.total, reverse=True)]


# ---------------------------------------------------------------------------
# OM-FR-030 — Decision drift detection.
#
# Split each decision type's scored labels into an earlier "baseline" window and
# a later "recent" window (by label order — callers pass chronologically-sorted
# labels), and flag a MATERIAL drop in effectiveness. Pure + deterministic
# (BR-2/BR-5): no clock, no I/O, no randomness. The output is a review SIGNAL,
# never an action — the governance agent turns a flag into a proposal-mode
# review (AC-3), and a human decides. Correlational only (BR-3).
# ---------------------------------------------------------------------------

@dataclass(slots=True)
class DriftSignal:
    key: str                       # decision_type (or producer) that drifted
    baseline_rate: float
    recent_rate: float
    drop: float                    # baseline_rate - recent_rate (positive = worse)
    baseline_scored: int
    recent_scored: int

    def to_dict(self) -> dict:
        return {"key": self.key, "baseline_rate": round(self.baseline_rate, 4),
                "recent_rate": round(self.recent_rate, 4), "drop": round(self.drop, 4),
                "baseline_scored": self.baseline_scored, "recent_scored": self.recent_scored}


def detect_drift(
    labels: list[OutcomeLabel],
    *,
    by: str = "decision_type",
    min_drop: float = 0.15,
    min_scored_per_window: int = 10,
    recent_fraction: float = 0.5,
) -> list[dict]:
    """Per group, compare effectiveness on the earliest ``1-recent_fraction`` of
    its scored labels (baseline) against the latest ``recent_fraction`` (recent),
    and emit a signal when the effectiveness rate dropped by at least
    ``min_drop`` AND both windows have at least ``min_scored_per_window`` scored
    labels (so a couple of unlucky labels can't manufacture a flag).

    ``labels`` MUST already be in chronological order; unknown (uncomparable)
    labels are ignored — drift is measured on the scored signal only. Rows
    sorted by drop desc. Never mutates its input."""
    if not (0.0 < recent_fraction < 1.0):
        raise ValueError("recent_fraction must be in (0, 1)")

    grouped: dict[str, list[OutcomeLabel]] = defaultdict(list)
    for lab in labels:
        if lab.correct is None:
            continue  # scored-only
        k = (lab.decision_type if by == "decision_type" else (lab.producer or "unknown"))
        grouped[k].append(lab)

    signals: list[DriftSignal] = []
    for k, scored in grouped.items():
        n = len(scored)
        recent_n = int(round(n * recent_fraction))
        baseline_n = n - recent_n
        if baseline_n < min_scored_per_window or recent_n < min_scored_per_window:
            continue
        baseline = scored[:baseline_n]
        recent = scored[baseline_n:]
        b_rate = sum(1 for x in baseline if x.correct) / baseline_n
        r_rate = sum(1 for x in recent if x.correct) / recent_n
        drop = b_rate - r_rate
        if drop >= min_drop:
            signals.append(DriftSignal(key=k, baseline_rate=b_rate, recent_rate=r_rate,
                                       drop=drop, baseline_scored=baseline_n,
                                       recent_scored=recent_n))
    return [s.to_dict() for s in sorted(signals, key=lambda s: s.drop, reverse=True)]


# ---------------------------------------------------------------------------
# OM-FR-040 — Learning-loop enrichment.
#
# An outcome label attaches to the decision that produced a transcript, so SFT
# curation can WEIGHT or FILTER by realized correctness (extends BRD 12 M2). A
# correct decision is a gold positive; an incorrect one is a negative the
# student should not imitate; an unlabeled/uncomparable one carries neutral
# weight. Pure — the curator applies these; this only assigns them.
# ---------------------------------------------------------------------------

def sft_enrichment(label: OutcomeLabel, *, positive: float = 1.0,
                   negative: float = 0.0, neutral: float = 0.5) -> dict:
    """Map one outcome label to the SFT curation annotation for its transcript:
    a ``sample_weight`` and an ``outcome`` tag. ``correct is True`` → positive
    (imitate), ``False`` → negative (down-weight/exclude), ``None`` → neutral
    (no realized signal yet). Deterministic; carries the decision_ref so the
    curator joins it back to the transcript."""
    if label.correct is True:
        weight, tag = positive, "correct"
    elif label.correct is False:
        weight, tag = negative, "incorrect"
    else:
        weight, tag = neutral, "unlabeled"
    return {"decision_ref": label.decision_ref, "decision_type": label.decision_type,
            "outcome": tag, "sample_weight": weight,
            "realized_outcome": label.realized_outcome, "label_source": label.label_source}
