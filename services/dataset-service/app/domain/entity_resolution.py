"""First-party entity-resolution engine (BRD 56 inc1) — the "build" core.

Given a record set (a dataset's rows) and a per-entity-type config, produce
resolved entity CLUSTERS: which records are the same real-world entity, at what
confidence, on what evidence. Two-stage matching, exactly as the BRD specifies:

  1. Deterministic keys — records sharing an exact composite key (e.g.
     national_id, or name+dob) are the same entity. High confidence, no scoring.
  2. Probabilistic scoring — within a blocking key, remaining records are scored
     on weighted attribute similarity. A score >= auto_merge_threshold merges
     automatically; between review_threshold and auto it becomes a HUMAN-review
     merge candidate (four-eyes, ER-FR-030), never silently merged; below review
     the records stay separate entities.

Pure and deterministic (no I/O, no randomness) so it is exhaustively unit-
testable and its clusters are reproducible for audit (ER-FR-040). It produces a
LINK layer only — it never mutates source records (ER-FR-050).
"""

from __future__ import annotations

import unicodedata
from dataclasses import dataclass, field

# Per-field similarity comparators (ER-FR-010 depth). "dice" (the original,
# and the DEFAULT so existing configs/runs are byte-for-byte unchanged) suits
# free text; "jaro_winkler" is stronger on short person/org names and
# transpositions ("Viktor"/"Victor"); "phonetic" matches on sound (Soundex),
# for names spelled differently but pronounced alike ("Smith"/"Smyth");
# "exact" is a normalized equality (1.0 or 0.0) for codes/ids used as a
# soft (scored) signal; "numeric" compares magnitudes so near amounts/counts
# score high without exact equality.
COMPARATORS = ("dice", "jaro_winkler", "phonetic", "exact", "numeric")


@dataclass(slots=True)
class ScoringField:
    column: str
    weight: float = 1.0
    # One of COMPARATORS; unknown values fall back to "dice" (never raises —
    # resolution stays deterministic even on a hand-edited config).
    comparator: str = "dice"


@dataclass(slots=True)
class ResolutionConfig:
    entity_type: str
    # Each inner list is a COMPOSITE exact-match key (all columns must be present
    # and equal). Any one satisfied key merges the records deterministically.
    deterministic_keys: list[list[str]] = field(default_factory=list)
    scoring_fields: list[ScoringField] = field(default_factory=list)
    auto_merge_threshold: float = 0.85
    review_threshold: float = 0.60
    # Records must agree on ALL of these (when both present) to even be scored —
    # a cheap block that stops, e.g., merging two different DOBs on name alone.
    blocking_fields: list[str] = field(default_factory=list)


@dataclass(slots=True)
class Cluster:
    resolved_entity_id: str
    member_pks: list[str]
    confidence: float
    method: str            # "deterministic" | "probabilistic" | "singleton"
    evidence: list[dict] = field(default_factory=list)


@dataclass(slots=True)
class MergeCandidate:
    # A proposed (below auto, above review) merge for a steward's four-eyes review.
    left_pk: str
    right_pk: str
    score: float
    evidence: dict


@dataclass(slots=True)
class ResolutionResult:
    clusters: list[Cluster]
    merge_candidates: list[MergeCandidate]

    @property
    def resolved_count(self) -> int:
        return len(self.clusters)


# ---- normalization + similarity (dependency-free) --------------------------

def _norm(v) -> str:
    if v is None:
        return ""
    s = unicodedata.normalize("NFKD", str(v)).encode("ascii", "ignore").decode()
    return " ".join(s.lower().split())


def _bigrams(s: str) -> set[str]:
    s = s.replace(" ", "")
    return {s[i:i + 2] for i in range(len(s) - 1)} if len(s) >= 2 else ({s} if s else set())


def string_similarity(a: str, b: str) -> float:
    """Dice coefficient over character bigrams — 1.0 identical, 0.0 disjoint.
    Robust to minor spelling/format variation ("Viktor" vs "Victor") without a
    heavy dependency; exact-equal short tokens still score 1.0."""
    a, b = _norm(a), _norm(b)
    if not a and not b:
        return 1.0
    if not a or not b:
        return 0.0
    if a == b:
        return 1.0
    ga, gb = _bigrams(a), _bigrams(b)
    if not ga or not gb:
        return 0.0
    inter = len(ga & gb)
    return (2 * inter) / (len(ga) + len(gb))


def jaro_similarity(a: str, b: str) -> float:
    """Jaro similarity — matching characters within a sliding window, penalizing
    transpositions. 1.0 identical, 0.0 disjoint. Dependency-free."""
    if a == b:
        return 1.0
    la, lb = len(a), len(b)
    if la == 0 or lb == 0:
        return 0.0
    window = max(la, lb) // 2 - 1
    if window < 0:
        window = 0
    a_matches = [False] * la
    b_matches = [False] * lb
    matches = 0
    for i in range(la):
        lo = max(0, i - window)
        hi = min(i + window + 1, lb)
        for j in range(lo, hi):
            if b_matches[j] or a[i] != b[j]:
                continue
            a_matches[i] = b_matches[j] = True
            matches += 1
            break
    if matches == 0:
        return 0.0
    # Count transpositions (half the out-of-order matched pairs).
    t = 0
    k = 0
    for i in range(la):
        if not a_matches[i]:
            continue
        while not b_matches[k]:
            k += 1
        if a[i] != b[k]:
            t += 1
        k += 1
    t //= 2
    m = matches
    return (m / la + m / lb + (m - t) / m) / 3.0


def jaro_winkler_similarity(a: str, b: str, *, prefix_weight: float = 0.1) -> float:
    """Jaro-Winkler — Jaro boosted for a shared prefix (up to 4 chars). Stronger
    than Dice on short person/org names and single-letter transpositions."""
    a, b = _norm(a), _norm(b)
    if not a and not b:
        return 1.0
    if not a or not b:
        return 0.0
    j = jaro_similarity(a, b)
    prefix = 0
    for ca, cb in zip(a, b, strict=False):  # prefix compare stops at the shorter
        if ca != cb or prefix == 4:
            break
        prefix += 1
    return j + prefix * prefix_weight * (1 - j)


# Soundex digit map (classic Russell/American Soundex); vowels + h/w/y drop out.
_SOUNDEX_MAP = {
    "b": "1", "f": "1", "p": "1", "v": "1",
    "c": "2", "g": "2", "j": "2", "k": "2", "q": "2", "s": "2", "x": "2", "z": "2",
    "d": "3", "t": "3", "l": "4", "m": "5", "n": "5", "r": "6",
}


def soundex(value: str) -> str:
    """Classic 4-char Soundex code (letter + 3 digits) for a single token, or ""
    for a blank/non-alpha value. Deterministic and dependency-free."""
    s = "".join(ch for ch in _norm(value) if ch.isalpha())
    if not s:
        return ""
    first = s[0].upper()
    prev = _SOUNDEX_MAP.get(s[0], "")
    digits = ""
    for ch in s[1:]:
        code = _SOUNDEX_MAP.get(ch, "")
        # h/w between two same-coded consonants don't reset the "previous" code;
        # a vowel does (so repeats separated by a vowel are both kept).
        if code:
            if code != prev:
                digits += code
            prev = code
        elif ch in "hw":
            pass
        else:  # vowel or y
            prev = ""
        if len(digits) == 3:
            break
    return (first + digits).ljust(4, "0")


def phonetic_similarity(a: str, b: str) -> float:
    """1.0 when two multi-token strings share the same Soundex code per token
    (order-insensitive on a best-match basis), else 0.0 — a crisp "sounds the
    same" signal ("Smith"/"Smyth", "Claire"/"Clair")."""
    ta = [t for t in (_norm(a).split()) if t]
    tb = [t for t in (_norm(b).split()) if t]
    if not ta and not tb:
        return 1.0
    if not ta or not tb:
        return 0.0
    ca = sorted(soundex(t) for t in ta)
    cb = sorted(soundex(t) for t in tb)
    return 1.0 if ca == cb else 0.0


def numeric_similarity(a: str, b: str) -> float:
    """Magnitude closeness for numbers: 1.0 equal, decaying to 0.0 as the
    relative difference grows (1 - |a-b| / max(|a|,|b|)). Non-numeric → 0.0."""
    try:
        na, nb = float(str(a).strip()), float(str(b).strip())
    except (TypeError, ValueError):
        return 0.0
    if na == nb:
        return 1.0
    denom = max(abs(na), abs(nb))
    if denom == 0:
        return 1.0
    return max(0.0, 1.0 - abs(na - nb) / denom)


def field_similarity(a, b, comparator: str) -> float:
    """Dispatch to the field's comparator; unknown → "dice" (never raises)."""
    if comparator == "jaro_winkler":
        return jaro_winkler_similarity(a, b)
    if comparator == "phonetic":
        return phonetic_similarity(a, b)
    if comparator == "exact":
        na, nb = _norm(a), _norm(b)
        if not na and not nb:
            return 1.0
        return 1.0 if (na and nb and na == nb) else 0.0
    if comparator == "numeric":
        return numeric_similarity(a, b)
    return string_similarity(a, b)


def _det_key_values(row: dict, key: list[str]) -> tuple | None:
    """The composite key's normalized value tuple, or None if any part is blank
    (a partial key must NEVER merge — missing id != missing id)."""
    vals = []
    for col in key:
        v = _norm(row.get(col))
        if not v:
            return None
        vals.append(v)
    return tuple(vals)


def _pair_score(a: dict, b: dict, cfg: ResolutionConfig) -> tuple[float, dict]:
    # Blocking gate: if any blocking field is present on BOTH and disagrees, the
    # pair is not a match regardless of name similarity.
    for bf in cfg.blocking_fields:
        va, vb = _norm(a.get(bf)), _norm(b.get(bf))
        if va and vb and va != vb:
            return 0.0, {"blocked_on": bf}
    total_w = sum(max(0.0, f.weight) for f in cfg.scoring_fields) or 1.0
    acc = 0.0
    per_field = {}
    for f in cfg.scoring_fields:
        s = field_similarity(a.get(f.column), b.get(f.column), f.comparator)
        # Record the comparator alongside the score so a steward reviewing a
        # candidate sees WHY it matched (name sounded alike vs spelled alike).
        per_field[f.column] = {"score": round(s, 4), "comparator": f.comparator}
        acc += s * max(0.0, f.weight)
    return acc / total_w, {"fields": per_field}


class _UnionFind:
    def __init__(self, items: list[str]) -> None:
        self._p = {x: x for x in items}

    def find(self, x: str) -> str:
        while self._p[x] != x:
            self._p[x] = self._p[self._p[x]]
            x = self._p[x]
        return x

    def union(self, a: str, b: str) -> None:
        ra, rb = self.find(a), self.find(b)
        if ra != rb:
            self._p[ra] = rb


def resolve(rows: list[dict], config: ResolutionConfig, *, pk_column: str,
            id_prefix: str = "ent") -> ResolutionResult:
    """Resolve a record set into entity clusters + human-review merge candidates.

    ``rows`` are dicts (a dataset's materialized rows); ``pk_column`` is the stable
    record id. Deterministic across runs: cluster ids derive from the smallest
    member pk, so the same input yields the same resolved_entity_ids (audit)."""
    pks = [str(r.get(pk_column)) for r in rows if r.get(pk_column) is not None]
    by_pk = {str(r.get(pk_column)): r for r in rows if r.get(pk_column) is not None}
    uf = _UnionFind(pks)
    method: dict[str, str] = {p: "singleton" for p in pks}
    evidence: dict[str, list[dict]] = {p: [] for p in pks}
    candidates: list[MergeCandidate] = []

    # Stage 1 — deterministic keys: records sharing an exact composite key merge.
    for key in config.deterministic_keys:
        buckets: dict[tuple, list[str]] = {}
        for p in pks:
            kv = _det_key_values(by_pk[p], key)
            if kv is not None:
                buckets.setdefault(kv, []).append(p)
        for kv, members in buckets.items():
            if len(members) > 1:
                anchor = members[0]
                for m in members[1:]:
                    uf.union(anchor, m)
                    method[m] = method[anchor] = "deterministic"
                    evidence[m].append({"key": key, "values": list(kv)})

    # Stage 2 — probabilistic scoring on the residual (block by blocking_fields to
    # keep it O(block^2), not O(n^2)). Only score pairs not already merged.
    if config.scoring_fields:
        blocks: dict[tuple, list[str]] = {}
        for p in pks:
            bkey = tuple(_norm(by_pk[p].get(bf)) for bf in config.blocking_fields)
            blocks.setdefault(bkey, []).append(p)
        for members in blocks.values():
            for i in range(len(members)):
                for j in range(i + 1, len(members)):
                    a, b = members[i], members[j]
                    if uf.find(a) == uf.find(b):
                        continue  # already same entity (deterministic)
                    score, ev = _pair_score(by_pk[a], by_pk[b], config)
                    if score >= config.auto_merge_threshold:
                        uf.union(a, b)
                        if method[a] == "singleton":
                            method[a] = "probabilistic"
                        if method[b] == "singleton":
                            method[b] = "probabilistic"
                        evidence[b].append({"score": round(score, 4), **ev})
                    elif score >= config.review_threshold:
                        candidates.append(MergeCandidate(
                            left_pk=a, right_pk=b, score=round(score, 4), evidence=ev))

    # Materialize clusters (stable id = smallest member pk).
    groups: dict[str, list[str]] = {}
    for p in pks:
        groups.setdefault(uf.find(p), []).append(p)
    clusters: list[Cluster] = []
    for members in groups.values():
        members_sorted = sorted(members)
        cid = f"{id_prefix}:{config.entity_type}:{members_sorted[0]}"
        cmethod = "singleton"
        if len(members_sorted) > 1:
            cmethod = "deterministic" if any(
                method[m] == "deterministic" for m in members_sorted) else "probabilistic"
        ev = [e for m in members_sorted for e in evidence[m]]
        confidence = 1.0 if cmethod in ("deterministic", "singleton") else round(
            min(1.0, max((e.get("score", 0.0) for e in ev), default=0.0)), 4)
        clusters.append(Cluster(resolved_entity_id=cid, member_pks=members_sorted,
                                confidence=confidence, method=cmethod, evidence=ev))
    clusters.sort(key=lambda c: c.resolved_entity_id)
    return ResolutionResult(clusters=clusters, merge_candidates=candidates)


# ---- BRD 56 inc3: golden-record rollup (the governed resolved-entity view) --

_NUMERIC_AGGS = {"sum", "max", "min", "avg", "count_distinct"}


def _to_float(v) -> float | None:
    try:
        return float(str(v).replace(",", "").strip())
    except (TypeError, ValueError):
        return None


def build_golden_records(
    entities: list[dict], members_by_entity: dict[str, list[str]],
    rows_by_pk: dict[str, dict], attributes: list[dict], *, id_column: str = "resolved_entity_id",
) -> tuple[list[str], list[list]]:
    """One golden row per resolved entity for the governed resolved-entity VIEW
    (ER-FR-020): ``resolved_entity_id, member_count, confidence, method`` + one
    column per configured attribute. All values are strings (bronze convention —
    the warehouse table is created string-typed like ingested data).

    Each attribute is ``{"column": <source col>, "agg": first|sum|max|min|avg|
    count_distinct}``. Default ``first`` carries a representative value (first
    non-empty across the cluster's sorted members — deterministic for audit); the
    numeric aggs realise cross-record rollups the BRD's US-3 wants (e.g.
    ``total_exposure_across_accounts`` = sum of each member's exposure)."""
    attr_cols = [a["column"] for a in attributes]
    columns = [id_column, "member_count", "confidence", "method", *attr_cols]
    out: list[list] = []
    # entities is a list of dicts with resolved_entity_id/member_count/confidence/method
    for e in sorted(entities, key=lambda x: x["resolved_entity_id"]):
        eid = e["resolved_entity_id"]
        members = sorted(members_by_entity.get(eid, []))
        row = [eid, str(e.get("member_count") or len(members)),
               str(e.get("confidence")), str(e.get("method") or "")]
        for a in attributes:
            col, agg = a["column"], (a.get("agg") or "first")
            vals = [rows_by_pk.get(pk, {}).get(col) for pk in members]
            if agg in _NUMERIC_AGGS:
                if agg == "count_distinct":
                    row.append(str(len({str(v) for v in vals if v not in (None, "")})))
                    continue
                nums = [n for n in (_to_float(v) for v in vals) if n is not None]
                if not nums:
                    row.append("")
                elif agg == "sum":
                    row.append(_fmt_num(sum(nums)))
                elif agg == "max":
                    row.append(_fmt_num(max(nums)))
                elif agg == "min":
                    row.append(_fmt_num(min(nums)))
                else:  # avg
                    row.append(_fmt_num(sum(nums) / len(nums)))
            else:  # "first": first non-empty representative value
                row.append(next((str(v) for v in vals if v not in (None, "")), ""))
        out.append(row)
    return columns, out


def _fmt_num(x: float) -> str:
    """Compact numeric string: drop the trailing .0 on integral values."""
    return str(int(x)) if x == int(x) else repr(round(x, 6))
