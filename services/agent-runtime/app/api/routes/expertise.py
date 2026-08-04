"""Expertise Ledger — the governed-decision flywheel, made visible.

One read-only aggregate that composes what the platform already captures into
the single view a buyer signs for: how much expert judgment has been captured
as governed decisions, how well the model agrees with those experts, the size
and provenance of the training corpus those decisions produced, and the state
of the model the tenant owns.

It INVENTS nothing. Every number is a real read: decision counts are an exact
GROUP BY (never a truncated list-page), corpus size is the sum of frozen SFT
row counts, agreement is the outcome-effectiveness aggregate, and the owned
model reflects the real adapter/training state — including honest "not trained
yet" and "gpu_trainer_not_configured" states, never a fabricated model. Tenant-
scoped (RLS); authN-only, matching the sibling learning-loop reads.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Query, Request

from app.api.auth import principal_of
from app.domain.entities import PROPOSAL_STATUSES
from app.domain.outcomes import effectiveness

router = APIRouter(prefix="/api/v1")

# Statuses that represent a HUMAN having decided (the four-eyes chokepoint =
# the label factory). Pending/expired/superseded/cancelled are not decisions.
_DECIDED = ("approved", "edited_approved", "rejected")


@router.get("/expertise-ledger")
async def expertise_ledger(
    request: Request,
    window_days: int = Query(default=90, ge=1, le=3650),
):
    principal = await principal_of(request)
    tenant = principal.tenant_id
    store = request.app.state.container.store
    since = datetime.now(timezone.utc) - timedelta(days=window_days)

    # --- 1. Governed decisions captured (exact counts, windowed + all-time) ---
    counts_window = await store.count_proposals_by_status(tenant, since=since)
    counts_all = await store.count_proposals_by_status(tenant)

    def _decided_total(counts: dict[str, int]) -> int:
        return sum(counts.get(s, 0) for s in _DECIDED)

    decisions = {
        "window_days": window_days,
        "captured_in_window": _decided_total(counts_window),
        "captured_all_time": _decided_total(counts_all),
        # the correction signal specifically: edits + rejects are where an
        # expert changed or refused the AI — the highest-value training rows.
        "corrections_in_window": counts_window.get("edited_approved", 0)
        + counts_window.get("rejected", 0),
        "by_status": {s: counts_all.get(s, 0) for s in PROPOSAL_STATUSES},
    }

    # --- 2. Model agreement with the experts (outcome effectiveness) ---
    labels = await store.list_outcome_labels(tenant)
    groups = effectiveness(labels, by="decision_type")
    scored = sum(g["correct"] + g["incorrect"] for g in groups)
    correct = sum(g["correct"] for g in groups)
    agreement = {
        "labeled_decisions": len(labels),
        # None (not 0) when nothing is comparable yet — an honest "no signal".
        "agreement_rate": (correct / scored) if scored else None,
        "scored": scored,
        "by_decision_type": groups,
    }

    # --- 3. The proprietary corpus those decisions produced ---
    sft = await store.list_sft_datasets(tenant, limit=200)
    corpus = {
        "dataset_versions": len(sft),
        "example_rows": sum(int(getattr(d, "row_count", 0) or 0) for d in sft),
        "consent_verified_versions": sum(
            1 for d in sft if getattr(d, "consent_verified", False)
        ),
        "latest": (
            {
                "dataset_id": sft[0].dataset_id,
                "agent_key": sft[0].agent_key,
                "version": sft[0].version,
                "row_count": sft[0].row_count,
                "checksum": sft[0].checksum,
                "created_at": sft[0].created_at.isoformat() if sft[0].created_at else None,
            }
            if sft
            else None
        ),
    }

    # --- 4. The model the tenant owns (honest about "not trained yet") ---
    adapters = await store.list_slm_adapters(tenant, limit=200)
    promoted = next(
        (a for a in adapters if getattr(a, "promotion_status", None) == "promoted"),
        None,
    )
    jobs = await store.list_training_jobs(tenant, limit=1)
    latest_job = jobs[0] if jobs else None
    owned_model = {
        "has_owned_model": promoted is not None,
        "adapter_count": len(adapters),
        "promoted": (
            {
                "adapter_id": promoted.adapter_id,
                "archetype": promoted.archetype,
                "base_model": promoted.base_model,
                "checksum": promoted.checksum,
                "model_alias": getattr(promoted, "model_alias", None),
            }
            if promoted
            else None
        ),
        # Surface the real training status verbatim — including the honest
        # gpu_trainer_not_configured failure — never a fabricated "ready".
        "latest_training": (
            {
                "job_id": latest_job.job_id,
                "archetype": latest_job.archetype,
                "base_model": latest_job.base_model,
                "status": latest_job.status,
                "error": getattr(latest_job, "error", None),
            }
            if latest_job
            else None
        ),
    }

    return {
        "data": {
            "decisions": decisions,
            "agreement": agreement,
            "corpus": corpus,
            "owned_model": owned_model,
        }
    }
