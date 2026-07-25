package domain

import (
	"context"
	"log/slog"
	"time"
)

// TrialSweep implements the leader-elected trial-expiry + threshold-event job
// (CPL-FR-022/023, design doc "Trial sweep job"). Structurally mirrors
// DemoReaper: same LeaseChecker seam, same nil="always leader" default
// (correct for single-replica dev/tests, NOT leader-elected for real
// multi-replica safety -- callers wire a real leaderlease.Lease in main.go
// exactly like the demo reaper does).
type TrialSweep struct {
	Store Store
	Clock func() time.Time
	Lease LeaseChecker
	Log   *slog.Logger
}

func (sw *TrialSweep) now() time.Time {
	if sw.Clock != nil {
		return sw.Clock().UTC()
	}
	return time.Now().UTC()
}

func (sw *TrialSweep) log() *slog.Logger {
	if sw.Log != nil {
		return sw.Log
	}
	return slog.Default()
}

// trialThresholds maps each T-N threshold event to its day offset
// (CPL-FR-023: "trial threshold events at T-14/T-7/T-1 days").
var trialThresholds = []struct {
	eventType string
	days      int
}{
	{TrialEventEndingT14, 14},
	{TrialEventEndingT7, 7},
	{TrialEventEndingT1, 1},
}

// SweepOnce runs one sweep tick (design doc "Trial sweep job" steps 1-3):
// first expires trials past trial_ends_at (CPL-FR-022), then -- same tick,
// same leader -- emits T-14/T-7/T-1 threshold events for trials not yet
// expired (CPL-FR-023). Returns (expired, thresholdEventsEmitted, error).
// Idempotent: a re-run after a partial batch (e.g. a leader handoff mid-
// sweep) re-lists the same candidates; already-transitioned tenants are a
// silent no-op via the state guard (CPL-NFR-003), and already-recorded
// threshold events are excluded by ListTrialsForThreshold's dedup query, so
// re-running never double-transitions or double-emits.
func (sw *TrialSweep) SweepOnce(ctx context.Context) (int, int, error) {
	if sw.Lease != nil && !sw.Lease.IsLeader() {
		return 0, 0, nil
	}
	now := sw.now()
	expired, err := sw.expireOnce(ctx, now)
	if err != nil {
		return expired, 0, err
	}
	thresholds, err := sw.thresholdsOnce(ctx, now)
	return expired, thresholds, err
}

func (sw *TrialSweep) expireOnce(ctx context.Context, now time.Time) (int, error) {
	tenants, err := sw.Store.ListExpiredTrials(ctx, now, MaxPageLimit)
	if err != nil {
		return 0, err
	}
	actor := Actor{Type: "service", ID: "identity-service-trial-sweep"}
	n := 0
	for _, t := range tenants {
		tev := newTrialEvent(t.ID, TrialEventExpired, 0, "", actor.ID, now)
		ev := NewEvent(EvCommercialTrialExpired, t.ID, actor, t.URN(), now, map[string]any{
			"trial_ends_at": t.TrialEndsAt,
		})
		transitioned, err := sw.Store.SweepExpireTrial(ctx, t.ID, t.Profile, now, tev, ev)
		if err != nil {
			// Swallowed and retried next tick -- mirrors DemoReaper.Sweep's
			// per-tenant failure contract (a bad row must never block the
			// rest of the batch).
			sw.log().Error("trial sweep: expire failed", "tenant", t.ID, "err", err)
			continue
		}
		if transitioned {
			n++
		}
	}
	return n, nil
}

func (sw *TrialSweep) thresholdsOnce(ctx context.Context, now time.Time) (int, error) {
	actor := Actor{Type: "service", ID: "identity-service-trial-sweep"}
	n := 0
	for _, th := range trialThresholds {
		windowEnd := now.Add(time.Duration(th.days) * 24 * time.Hour)
		tenants, err := sw.Store.ListTrialsForThreshold(ctx, th.eventType, now, windowEnd, MaxPageLimit)
		if err != nil {
			return n, err
		}
		for _, t := range tenants {
			tev := newTrialEvent(t.ID, th.eventType, 0, "", actor.ID, now)
			ev := NewEvent(EvCommercialTrialEnding, t.ID, actor, t.URN(), now, map[string]any{
				"threshold_days": th.days, "trial_ends_at": t.TrialEndsAt,
			})
			if err := sw.Store.InsertTrialEvent(ctx, tev, ev); err != nil {
				sw.log().Error("trial sweep: threshold event failed", "tenant", t.ID, "type", th.eventType, "err", err)
				continue
			}
			n++
		}
	}
	return n, nil
}
