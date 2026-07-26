package domain_test

import (
	"context"
	"testing"
	"time"

	"github.com/datacern-ai/identity-service/internal/domain"
)

// --- Trial start/extend/convert (CPL-FR-021, US-3) ------------------------

// TestTrialService_StartUsesPlanDefaultDays covers CPL-FR-021's "trial_days
// from plan default, operator-overridable": no trial_days in the request
// falls back to the assigned plan's trial_days_default.
func TestTrialService_StartUsesPlanDefaultDays(t *testing.T) {
	f := newCommercialFixture(t)
	days := 60
	f.mustCreatePlan(domain.CreatePlanRequest{Key: "pilot", Name: "Pilot", TrialDaysDefault: &days})
	tn := f.newTenant("acme")
	// Attach the plan snapshot directly at the store layer (bypassing
	// CommercialService.AssignPlan, which auto-transitions a CommercialNone
	// tenant straight to active per slice 1's "direct assignment, no trial"
	// rule) -- this fixture wants "plan attached" and "still none" as two
	// independent preconditions, mirroring a pilot tenant whose plan is
	// pinned before the trial clock starts (US-3's own example).
	if err := f.store.AssignTenantPlan(context.Background(), &domain.TenantPlan{
		TenantID: tn.ID, PlanKey: "pilot", PlanVersionSnapshot: 1, AssignedAt: f.clock, AssignedBy: "test",
	}); err != nil {
		t.Fatal(err)
	}

	got, err := f.trials.Start(context.Background(), tn.ID, domain.StartTrialRequest{}, f.actor)
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	if got.CommercialState != domain.CommercialTrial {
		t.Fatalf("commercial_state = %s, want trial", got.CommercialState)
	}
	if got.TrialEndsAt == nil {
		t.Fatal("trial_ends_at not set")
	}
	wantEnds := f.clock.Add(60 * 24 * time.Hour)
	if !got.TrialEndsAt.Equal(wantEnds) {
		t.Fatalf("trial_ends_at = %v, want %v (60-day plan default)", got.TrialEndsAt, wantEnds)
	}
	evs := f.store.EventsOfType(domain.EvCommercialTrialStarted)
	if len(evs) != 1 {
		t.Fatalf("expected 1 commercial.trial_started event, got %d", len(evs))
	}
	rows, err := f.store.ListTrialEvents(context.Background(), tn.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 1 || rows[0].EventType != domain.TrialEventStarted || rows[0].TrialDays != 60 {
		t.Fatalf("trial_events row wrong: %+v", rows)
	}
}

// TestTrialService_StartExplicitDaysOverridesPlanDefault covers the
// operator-overridable half of CPL-FR-021.
func TestTrialService_StartExplicitDaysOverridesPlanDefault(t *testing.T) {
	f := newCommercialFixture(t)
	tn := f.newTenant("acme")
	got, err := f.trials.Start(context.Background(), tn.ID, domain.StartTrialRequest{TrialDays: 14}, f.actor)
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	want := f.clock.Add(14 * 24 * time.Hour)
	if !got.TrialEndsAt.Equal(want) {
		t.Fatalf("trial_ends_at = %v, want %v", got.TrialEndsAt, want)
	}
}

// TestTrialService_StartNoDaysNoDefault_Rejected: neither an explicit
// trial_days nor a plan default -- must be a clean validation error, not a
// silent hardcoded fallback (design doc explicitly calls this out).
func TestTrialService_StartNoDaysNoDefault_Rejected(t *testing.T) {
	f := newCommercialFixture(t)
	tn := f.newTenant("acme")
	if _, err := f.trials.Start(context.Background(), tn.ID, domain.StartTrialRequest{}, f.actor); err == nil {
		t.Fatal("expected validation error with no trial_days and no plan default")
	} else if de, ok := domain.AsError(err); !ok || de.Code != domain.CodeValidationFailed {
		t.Fatalf("expected VALIDATION_FAILED, got %v", err)
	}
}

// TestTrialService_StartRejectsIllegalTransition: a tenant already active
// cannot "start" a trial (no active->trial edge in the guard table).
func TestTrialService_StartRejectsIllegalTransition(t *testing.T) {
	f := newCommercialFixture(t)
	f.mustCreatePlan(domain.CreatePlanRequest{Key: "pilot", Name: "Pilot"})
	tn := f.newTenant("acme")
	if _, err := f.commercial.AssignPlan(context.Background(), tn.ID, "pilot", f.actor); err != nil {
		t.Fatal(err)
	} // tenant is now commercial_state=active
	if _, err := f.trials.Start(context.Background(), tn.ID, domain.StartTrialRequest{TrialDays: 30}, f.actor); err == nil {
		t.Fatal("expected CONFLICT starting a trial on an already-active tenant")
	} else if de, ok := domain.AsError(err); !ok || de.Code != domain.CodeConflict {
		t.Fatalf("expected CONFLICT, got %v", err)
	}
}

// TestTrialService_Extend covers CPL-FR-021's "extends with reason
// (audited)": extension is additive from the CURRENT end date, requires a
// reason, and requires commercial_state=trial.
func TestTrialService_Extend(t *testing.T) {
	f := newCommercialFixture(t)
	tn := f.newTenant("acme")
	started, err := f.trials.Start(context.Background(), tn.ID, domain.StartTrialRequest{TrialDays: 10}, f.actor)
	if err != nil {
		t.Fatal(err)
	}
	wantBase := *started.TrialEndsAt

	if _, err := f.trials.Extend(context.Background(), tn.ID, domain.ExtendTrialRequest{Days: 5}, f.actor); err == nil {
		t.Fatal("expected reason-required validation error")
	}

	got, err := f.trials.Extend(context.Background(), tn.ID, domain.ExtendTrialRequest{Days: 5, Reason: "customer asked for more time"}, f.actor)
	if err != nil {
		t.Fatalf("Extend: %v", err)
	}
	want := wantBase.Add(5 * 24 * time.Hour)
	if !got.TrialEndsAt.Equal(want) {
		t.Fatalf("extended trial_ends_at = %v, want %v (additive from current end date)", got.TrialEndsAt, want)
	}
	rows, err := f.store.ListTrialEvents(context.Background(), tn.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 2 || rows[0].EventType != domain.TrialEventExtended || rows[0].Reason == "" {
		t.Fatalf("expected a reasoned 'extended' trial_events row (newest first), got %+v", rows)
	}
	// No bus event for extend (BRD §6's closed topic list omits trial_extended).
	if evs := f.store.EventsOfType("commercial.trial_extended"); len(evs) != 0 {
		t.Fatalf("unexpected commercial.trial_extended bus event: %+v", evs)
	}
}

// TestTrialService_ExtendRequiresActiveTrial: extend on a non-trial tenant is CONFLICT.
func TestTrialService_ExtendRequiresActiveTrial(t *testing.T) {
	f := newCommercialFixture(t)
	tn := f.newTenant("acme")
	if _, err := f.trials.Extend(context.Background(), tn.ID, domain.ExtendTrialRequest{Days: 5, Reason: "x"}, f.actor); err == nil {
		t.Fatal("expected CONFLICT extending a tenant with no active trial")
	} else if de, ok := domain.AsError(err); !ok || de.Code != domain.CodeConflict {
		t.Fatalf("expected CONFLICT, got %v", err)
	}
}

// TestTrialService_Convert covers CPL-FR-021's "moves trial->active with
// target plan" and AC-3-adjacent plan-snapshot semantics.
func TestTrialService_Convert(t *testing.T) {
	f := newCommercialFixture(t)
	f.mustCreatePlan(domain.CreatePlanRequest{
		Key: "enterprise", Name: "Enterprise",
		Entitlements: []domain.PlanEntitlementInput{{Kind: domain.KindSeatCap, Key: "seats", Value: map[string]any{"n": float64(200)}}},
	})
	tn := f.newTenant("acme")
	if _, err := f.trials.Start(context.Background(), tn.ID, domain.StartTrialRequest{TrialDays: 30}, f.actor); err != nil {
		t.Fatal(err)
	}
	got, err := f.trials.Convert(context.Background(), tn.ID, domain.ConvertTrialRequest{PlanKey: "enterprise"}, f.actor)
	if err != nil {
		t.Fatalf("Convert: %v", err)
	}
	if got.CommercialState != domain.CommercialActive {
		t.Fatalf("commercial_state = %s, want active", got.CommercialState)
	}
	if got.TrialEndsAt != nil {
		t.Fatalf("trial_ends_at should be cleared on convert, got %v", got.TrialEndsAt)
	}
	tp, err := f.store.GetTenantPlan(context.Background(), tn.ID)
	if err != nil {
		t.Fatal(err)
	}
	if tp.PlanKey != "enterprise" {
		t.Fatalf("plan_key = %s, want enterprise", tp.PlanKey)
	}
	if evs := f.store.EventsOfType(domain.EvCommercialConverted); len(evs) != 1 {
		t.Fatalf("expected 1 commercial.converted event, got %d", len(evs))
	}
	rows, err := f.store.ListTrialEvents(context.Background(), tn.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 2 || rows[0].EventType != domain.TrialEventConverted {
		t.Fatalf("expected a 'converted' trial_events row, got %+v", rows)
	}
}

// TestTrialService_ConvertRejectsInactivePlan.
func TestTrialService_ConvertRejectsInactivePlan(t *testing.T) {
	f := newCommercialFixture(t)
	f.mustCreatePlan(domain.CreatePlanRequest{Key: "enterprise", Name: "Enterprise"})
	deprecated := "deprecated"
	if _, err := f.plans.Patch(context.Background(), "enterprise", domain.PatchPlanRequest{Status: &deprecated}); err != nil {
		t.Fatal(err)
	}
	tn := f.newTenant("acme")
	if _, err := f.trials.Start(context.Background(), tn.ID, domain.StartTrialRequest{TrialDays: 30}, f.actor); err != nil {
		t.Fatal(err)
	}
	if _, err := f.trials.Convert(context.Background(), tn.ID, domain.ConvertTrialRequest{PlanKey: "enterprise"}, f.actor); err == nil {
		t.Fatal("expected rejection converting onto a deprecated plan")
	}
}

// --- Trial sweep (CPL-FR-022/023, design doc "Trial sweep job") -----------

// TestTrialSweep_ExpiresTrialAndIsIdempotent covers AC-2 + CPL-NFR-003:
// a trial past trial_ends_at transitions to suspended_commercial exactly
// once, emits commercial.trial_expired.v1 exactly once, and a re-run after
// the transition is a silent no-op (not an error) -- the "re-run after a
// partial batch is a no-op via the state guard" requirement.
func TestTrialSweep_ExpiresTrialAndIsIdempotent(t *testing.T) {
	f := newCommercialFixture(t)
	tn := f.newTenant("acme")
	if _, err := f.trials.Start(context.Background(), tn.ID, domain.StartTrialRequest{TrialDays: 5}, f.actor); err != nil {
		t.Fatal(err)
	}
	// A trial with days left must never be swept.
	tn2 := f.newTenant("beta")
	if _, err := f.trials.Start(context.Background(), tn2.ID, domain.StartTrialRequest{TrialDays: 60}, f.actor); err != nil {
		t.Fatal(err)
	}

	expired, _, err := f.sweep.SweepOnce(context.Background())
	if err != nil {
		t.Fatalf("sweep: %v", err)
	}
	if expired != 0 {
		t.Fatalf("swept %d before expiry, want 0", expired)
	}

	f.advance(6 * 24 * time.Hour) // past the 5-day trial, not the 60-day one

	expired, _, err = f.sweep.SweepOnce(context.Background())
	if err != nil {
		t.Fatalf("sweep: %v", err)
	}
	if expired != 1 {
		t.Fatalf("swept %d tenants, want 1", expired)
	}
	got, err := f.store.GetTenant(context.Background(), tn.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.CommercialState != domain.CommercialSuspendedCommercial {
		t.Fatalf("commercial_state = %s, want suspended_commercial", got.CommercialState)
	}
	got2, err := f.store.GetTenant(context.Background(), tn2.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got2.CommercialState != domain.CommercialTrial {
		t.Fatalf("the 60-day trial was swept early: commercial_state = %s", got2.CommercialState)
	}
	if evs := f.store.EventsOfType(domain.EvCommercialTrialExpired); len(evs) != 1 {
		t.Fatalf("expected exactly 1 commercial.trial_expired.v1 event, got %d", len(evs))
	}

	// Idempotency: re-running finds the tenant no longer `trial` -> no-op.
	expired, _, err = f.sweep.SweepOnce(context.Background())
	if err != nil {
		t.Fatalf("second sweep: %v", err)
	}
	if expired != 0 {
		t.Fatalf("second sweep expired %d, want 0 (idempotent no-op)", expired)
	}
	if evs := f.store.EventsOfType(domain.EvCommercialTrialExpired); len(evs) != 1 {
		t.Fatalf("second sweep emitted more events: got %d, want still 1", len(evs))
	}
}

// TestTrialSweep_NotLeaderSkips mirrors the demo reaper's leader-election test.
func TestTrialSweep_NotLeaderSkips(t *testing.T) {
	f := newCommercialFixture(t)
	tn := f.newTenant("acme")
	if _, err := f.trials.Start(context.Background(), tn.ID, domain.StartTrialRequest{TrialDays: 1}, f.actor); err != nil {
		t.Fatal(err)
	}
	f.advance(2 * 24 * time.Hour)
	f.sweep.Lease = &fakeLease{leader: false}

	expired, ending, err := f.sweep.SweepOnce(context.Background())
	if err != nil {
		t.Fatalf("sweep: %v", err)
	}
	if expired != 0 || ending != 0 {
		t.Fatalf("non-leader swept expired=%d ending=%d, want 0/0", expired, ending)
	}
}

// TestTrialSweep_ThresholdEventsAndDedup covers CPL-FR-023: T-14/T-7/T-1
// threshold events fire once each, deduplicated against existing trial_events
// rows on a second tick.
func TestTrialSweep_ThresholdEventsAndDedup(t *testing.T) {
	f := newCommercialFixture(t)
	tn := f.newTenant("acme")
	if _, err := f.trials.Start(context.Background(), tn.ID, domain.StartTrialRequest{TrialDays: 14}, f.actor); err != nil {
		t.Fatal(err)
	}

	_, ending, err := f.sweep.SweepOnce(context.Background())
	if err != nil {
		t.Fatalf("sweep: %v", err)
	}
	if ending != 1 {
		t.Fatalf("threshold events emitted = %d, want 1 (T-14 fires immediately at trial_days=14)", ending)
	}
	if evs := f.store.EventsOfType(domain.EvCommercialTrialEnding); len(evs) != 1 {
		t.Fatalf("expected 1 commercial.trial_ending.v1 event, got %d", len(evs))
	}

	// Re-running the SAME tick's threshold query must not re-fire T-14 (dedup
	// against the trial_events row just written).
	_, ending2, err := f.sweep.SweepOnce(context.Background())
	if err != nil {
		t.Fatalf("second sweep: %v", err)
	}
	if ending2 != 0 {
		t.Fatalf("second sweep re-fired %d threshold events, want 0 (dedup)", ending2)
	}

	// Advance to 7 days left: T-7 should now fire (T-14 must not re-fire).
	f.advance(7 * 24 * time.Hour)
	_, ending3, err := f.sweep.SweepOnce(context.Background())
	if err != nil {
		t.Fatalf("third sweep: %v", err)
	}
	if ending3 != 1 {
		t.Fatalf("threshold events at T-7 = %d, want 1", ending3)
	}
	rows, err := f.store.ListTrialEvents(context.Background(), tn.ID)
	if err != nil {
		t.Fatal(err)
	}
	types := map[string]int{}
	for _, r := range rows {
		types[r.EventType]++
	}
	if types[domain.TrialEventEndingT14] != 1 || types[domain.TrialEventEndingT7] != 1 {
		t.Fatalf("expected exactly one T-14 and one T-7 row, got %+v", types)
	}
}
