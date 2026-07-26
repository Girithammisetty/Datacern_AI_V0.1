package domain

import (
	"context"
	"strings"
	"time"

	"github.com/google/uuid"
)

// TrialService owns the trial lifecycle write paths (CPL-FR-021, US-3):
// start/extend/convert. All three are requireSuperAdmin-gated at the API
// layer (design doc's endpoint table); this service does not re-check
// authorization itself, mirroring PlanService/CommercialService's division
// of responsibility.
type TrialService struct {
	Store Store
	Clock func() time.Time
}

func (s *TrialService) now() time.Time { return s.Clock().UTC() }

// StartTrialRequest is the POST /tenants/{id}/trial body (CPL-FR-021).
// TrialDays, when zero/absent, falls back to the tenant's assigned plan's
// trial_days_default; a request with neither is a validation error -- an
// operator must pick a length somehow, there is no silent hardcoded default.
type StartTrialRequest struct {
	TrialDays int `json:"trial_days,omitempty"`
}

// Start begins a trial (CPL-FR-021, US-3). Only reachable from the edges
// CanTransitionCommercial actually allows into CommercialTrial (none, for
// profile=standard tenants; demo/poc tenants have no edge into trial at all
// per DSP-FR-003) -- an illegal call surfaces as the same 409 CONFLICT every
// other guarded transition in this service uses.
func (s *TrialService) Start(ctx context.Context, tenantID uuid.UUID, req StartTrialRequest, actor Actor) (*Tenant, error) {
	t, err := s.Store.GetTenant(ctx, tenantID)
	if err != nil {
		return nil, err
	}
	days := req.TrialDays
	if days <= 0 {
		// CPL-FR-021: trial_days from the plan default when not overridden.
		if tp, tpErr := s.Store.GetTenantPlan(ctx, tenantID); tpErr == nil {
			if plan, pErr := s.Store.GetPlan(ctx, tp.PlanKey); pErr == nil && plan.TrialDaysDefault != nil {
				days = *plan.TrialDaysDefault
			}
		}
	}
	if days <= 0 {
		return nil, EValidation("trial_days is required (no plan default available)",
			FieldError{Field: "trial_days", Message: "must be > 0, or assign a plan with trial_days_default first"})
	}
	if !CanTransitionCommercial(t.Profile, t.CommercialState, CommercialTrial) {
		return nil, EConflict("invalid commercial state transition " + string(t.CommercialState) + " -> trial")
	}
	now := s.now()
	endsAt := now.Add(time.Duration(days) * 24 * time.Hour)
	ev := NewEvent(EvCommercialTrialStarted, tenantID, actor, t.URN(), now, map[string]any{
		"trial_days": days, "trial_ends_at": endsAt,
	})
	tev := newTrialEvent(tenantID, TrialEventStarted, days, "", actor.ID, now)
	if err := s.Store.StartTrial(ctx, tenantID, t.Profile, now, endsAt, tev, ev); err != nil {
		return nil, err
	}
	t.CommercialState = CommercialTrial
	t.TrialStartedAt = &now
	t.TrialEndsAt = &endsAt
	return t, nil
}

// ExtendTrialRequest is the POST /tenants/{id}/trial/extend body (CPL-FR-021:
// "extends with reason (audited)").
type ExtendTrialRequest struct {
	Days   int    `json:"days"`
	Reason string `json:"reason"`
}

// Extend pushes trial_ends_at out by Days, from the CURRENT trial_ends_at
// (not from "now") when the trial hasn't already lapsed -- so extending a
// trial with 10 days left by 5 more days lands 15 days out, not 5. A trial
// that has already lapsed extends from now (there's no meaningful "current
// end date" to add to once it's in the past). Requires commercial_state=trial
// (a suspended_commercial tenant is extended via convert or a fresh trial,
// not this endpoint) and a non-empty reason (audited via the trial_events row).
func (s *TrialService) Extend(ctx context.Context, tenantID uuid.UUID, req ExtendTrialRequest, actor Actor) (*Tenant, error) {
	if req.Days <= 0 {
		return nil, EValidation("days must be > 0", FieldError{Field: "days", Message: "must be > 0"})
	}
	if strings.TrimSpace(req.Reason) == "" {
		return nil, EValidation("reason is required", FieldError{Field: "reason", Message: "required (audited, CPL-FR-021)"})
	}
	t, err := s.Store.GetTenant(ctx, tenantID)
	if err != nil {
		return nil, err
	}
	if t.CommercialState != CommercialTrial {
		return nil, EConflict("tenant is not on an active trial (commercial_state=" + string(t.CommercialState) + ")")
	}
	now := s.now()
	base := now
	if t.TrialEndsAt != nil && t.TrialEndsAt.After(now) {
		base = *t.TrialEndsAt
	}
	newEnds := base.Add(time.Duration(req.Days) * 24 * time.Hour)
	tev := newTrialEvent(tenantID, TrialEventExtended, req.Days, req.Reason, actor.ID, now)
	if err := s.Store.ExtendTrial(ctx, tenantID, newEnds, tev); err != nil {
		return nil, err
	}
	t.TrialEndsAt = &newEnds
	return t, nil
}

// ConvertTrialRequest is the POST /tenants/{id}/convert body (CPL-FR-021:
// "moves trial->active with target plan").
type ConvertTrialRequest struct {
	PlanKey string `json:"plan_key"`
}

// Convert moves a trial (or a late-expired suspended_commercial tenant, per
// AC-2's "conversion after expiry is one API call") to active on the given
// plan, snapshotting its version exactly like CommercialService.AssignPlan.
func (s *TrialService) Convert(ctx context.Context, tenantID uuid.UUID, req ConvertTrialRequest, actor Actor) (*Tenant, error) {
	if strings.TrimSpace(req.PlanKey) == "" {
		return nil, EValidation("plan_key is required", FieldError{Field: "plan_key", Message: "required"})
	}
	t, err := s.Store.GetTenant(ctx, tenantID)
	if err != nil {
		return nil, err
	}
	if !CanTransitionCommercial(t.Profile, t.CommercialState, CommercialActive) {
		return nil, EConflict("invalid commercial state transition " + string(t.CommercialState) + " -> active")
	}
	plan, err := s.Store.GetPlan(ctx, req.PlanKey)
	if err != nil {
		return nil, err
	}
	if plan.Status != "active" {
		return nil, EValidation("plan is not active",
			FieldError{Field: "plan_key", Message: "plan " + req.PlanKey + " is " + plan.Status})
	}
	now := s.now()
	fromState := t.CommercialState
	tp := TenantPlan{TenantID: tenantID, PlanKey: plan.Key, PlanVersionSnapshot: plan.Version, AssignedAt: now, AssignedBy: actor.ID}
	ev := NewEvent(EvCommercialConverted, tenantID, actor, t.URN(), now, map[string]any{
		"plan_key": plan.Key, "plan_version": plan.Version, "from_state": string(fromState),
	})
	tev := newTrialEvent(tenantID, TrialEventConverted, 0, "", actor.ID, now)
	if err := s.Store.ConvertTrial(ctx, tenantID, t.Profile, fromState, tp, tev, ev); err != nil {
		return nil, err
	}
	t.CommercialState = CommercialActive
	t.TrialEndsAt = nil
	return t, nil
}
