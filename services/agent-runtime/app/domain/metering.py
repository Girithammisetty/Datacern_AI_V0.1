"""Value-metering helpers for the ``governed_decision`` meter (BRD 67 slice 1,
docs/initiatives/value-metering-billing-export.md §2.1/§2.2).

Pure functions only — no I/O, no store access — so proposals/service.py's
commit path (`decide()`) gains no new failure mode by calling them, and they
are trivially unit-testable in isolation (matches the repo convention of
testing BR-15-style pure functions standalone, e.g.
usage-service's `budget/window_test.go::CrossedThresholds`).
"""

from __future__ import annotations

from datetime import datetime

# proposal_kind: derived from tool_id's leading namespace segment (design
# §2.1), e.g. "case.apply_disposition" -> "case", "chart.dashboard.create" ->
# "chart". A pure function of tool_id — already present on every Proposal —
# so no new stored column is needed. Kept as a lookup (identity today) rather
# than an inline split so a future namespace can be remapped to a coarser
# proposal_kind without touching call sites.
_PROPOSAL_KIND_OVERRIDES: dict[str, str] = {}


def proposal_kind(tool_id: str) -> str:
    namespace = (tool_id or "").split(".", 1)[0]
    return _PROPOSAL_KIND_OVERRIDES.get(namespace, namespace or "unknown")


# decision(approved|edited|rejected) — the governed_decision dimension
# (VMB-FR-002), collapsing the proposal's terminal `status` (which keeps
# edited_approved distinct from approved for audit/UI purposes) onto the
# three-value billing/showback cut. Deliberately excludes "cancelled" (the
# `respond` action) and any non-terminal status — those are not governed
# decisions and must never produce a meter-shaped payload.
_DECISION_BY_STATUS: dict[str, str] = {
    "approved": "approved",
    "edited_approved": "edited",
    "rejected": "rejected",
}


def decision_label(status: str) -> str | None:
    """None for any status that is not a metered terminal human decision
    (VMB-FR-002: "decisions are metered once per proposal terminal decision;
    supersede/expiry are not metered") — callers use None to skip emitting
    metering fields entirely."""
    return _DECISION_BY_STATUS.get(status)


def edit_distance_bucket(diff: list[dict] | None) -> str | None:
    """none|minor|major bucket from the field-level diff produced by
    proposals/service.py's ``_diff()`` (design §2.1). Only meaningful for
    edited_approved decisions; callers pass ``None`` for every other action
    and get ``None`` back."""
    if diff is None:
        return None
    n = len(diff)
    if n == 0:
        return "none"
    if n <= 2:
        return "minor"
    return "major"


def decision_latency_ms(created_at: datetime, decided_at: datetime) -> int:
    return int((decided_at - created_at).total_seconds() * 1000)
