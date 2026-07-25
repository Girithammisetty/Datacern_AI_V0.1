package domain

import (
	"context"
	"strings"
	"time"

	"github.com/google/uuid"
)

// PlanService owns the plan-catalog use cases (CPL-FR-001/002). Every method
// is platform-operator scope; the API layer gates the endpoints with
// requireSuperAdmin (see internal/api/server.go), so this service does not
// re-check authorization itself -- same division of responsibility as
// TenantService.
type PlanService struct {
	Store Store
	Clock func() time.Time
}

func (s *PlanService) now() time.Time { return s.Clock().UTC() }

// PlanEntitlementInput is one entitlement line in a plan create/patch request.
type PlanEntitlementInput struct {
	Kind  EntitlementKind `json:"kind"`
	Key   string          `json:"key"`
	Value map[string]any  `json:"value,omitempty"`
}

// CreatePlanRequest is the POST /platform/plans body (CPL-FR-001).
type CreatePlanRequest struct {
	Key              string                 `json:"key"`
	Name             string                 `json:"name"`
	Description      string                 `json:"description"`
	TrialDaysDefault *int                   `json:"trial_days_default,omitempty"`
	Entitlements     []PlanEntitlementInput `json:"entitlements,omitempty"`
}

// Create validates and inserts a new plan at version 1 with its default
// entitlements (CPL-FR-001).
func (s *PlanService) Create(ctx context.Context, req CreatePlanRequest) (*Plan, error) {
	if err := ValidatePlanKey(req.Key); err != nil {
		return nil, err
	}
	if strings.TrimSpace(req.Name) == "" {
		return nil, EValidation("plan name required", FieldError{Field: "name", Message: "required"})
	}
	if req.TrialDaysDefault != nil && *req.TrialDaysDefault <= 0 {
		return nil, EValidation("trial_days_default must be positive",
			FieldError{Field: "trial_days_default", Message: "must be > 0"})
	}
	ents, err := buildPlanEntitlements(req.Entitlements, req.Key, 1, s.now())
	if err != nil {
		return nil, err
	}
	now := s.now()
	p := &Plan{
		Key: req.Key, Name: req.Name, Description: req.Description, TrialDaysDefault: req.TrialDaysDefault,
		Status: "active", Version: 1, CreatedAt: now, UpdatedAt: now,
	}
	if err := s.Store.CreatePlan(ctx, p, ents); err != nil {
		return nil, err
	}
	return p, nil
}

// PatchPlanRequest is the PATCH /platform/plans/{key} body. Presence of
// Entitlements (even an empty, non-nil slice) bumps Plan.Version and writes a
// new default set (CPL-FR-002); a nil Entitlements leaves the current
// version's defaults untouched.
type PatchPlanRequest struct {
	Name             *string                `json:"name,omitempty"`
	Description      *string                `json:"description,omitempty"`
	TrialDaysDefault *int                   `json:"trial_days_default,omitempty"`
	Status           *string                `json:"status,omitempty"`
	Entitlements     []PlanEntitlementInput `json:"entitlements,omitempty"`
	// EntitlementsSet distinguishes "entitlements omitted" from "entitlements
	// explicitly set to an empty list" (clearing all defaults), since the zero
	// value of a slice and an absent field both marshal to nil otherwise. The
	// handler sets this from whether the JSON key was present.
	EntitlementsSet bool `json:"-"`
}

func (s *PlanService) Patch(ctx context.Context, key string, req PatchPlanRequest) (*Plan, error) {
	p, err := s.Store.GetPlan(ctx, key)
	if err != nil {
		return nil, err
	}
	if req.Name != nil {
		if strings.TrimSpace(*req.Name) == "" {
			return nil, EValidation("plan name required", FieldError{Field: "name", Message: "required"})
		}
		p.Name = *req.Name
	}
	if req.Description != nil {
		p.Description = *req.Description
	}
	if req.TrialDaysDefault != nil {
		if *req.TrialDaysDefault <= 0 {
			return nil, EValidation("trial_days_default must be positive",
				FieldError{Field: "trial_days_default", Message: "must be > 0"})
		}
		p.TrialDaysDefault = req.TrialDaysDefault
	}
	if req.Status != nil {
		if !ValidPlanStatuses[*req.Status] {
			return nil, EValidation("invalid status", FieldError{Field: "status", Message: "must be active|deprecated"})
		}
		p.Status = *req.Status
	}
	var ents []PlanEntitlement
	if req.EntitlementsSet {
		p.Version++ // CPL-FR-002: defaults change bumps version; prior-version rows are immutable.
		ents, err = buildPlanEntitlements(req.Entitlements, p.Key, p.Version, s.now())
		if err != nil {
			return nil, err
		}
	}
	p.UpdatedAt = s.now()
	if err := s.Store.UpdatePlan(ctx, p, ents); err != nil {
		return nil, err
	}
	return p, nil
}

// Get returns a plan and its current-version default entitlements.
func (s *PlanService) Get(ctx context.Context, key string) (*Plan, []PlanEntitlement, error) {
	p, err := s.Store.GetPlan(ctx, key)
	if err != nil {
		return nil, nil, err
	}
	ents, err := s.Store.ListPlanEntitlements(ctx, key, p.Version)
	if err != nil {
		return nil, nil, err
	}
	return p, ents, nil
}

func (s *PlanService) List(ctx context.Context) ([]*Plan, error) { return s.Store.ListPlans(ctx) }

func buildPlanEntitlements(in []PlanEntitlementInput, planKey string, version int, now time.Time) ([]PlanEntitlement, error) {
	out := make([]PlanEntitlement, 0, len(in))
	seen := map[entKey]bool{}
	for _, e := range in {
		if err := ValidateEntitlementRef(e.Kind, e.Key); err != nil {
			return nil, err
		}
		k := entKey{e.Kind, e.Key}
		if seen[k] {
			return nil, EValidation("duplicate entitlement in request",
				FieldError{Field: "entitlements", Message: string(e.Kind) + ":" + e.Key})
		}
		seen[k] = true
		id, _ := uuid.NewV7()
		out = append(out, PlanEntitlement{
			ID: id, PlanKey: planKey, PlanVersion: version, Kind: e.Kind, Key: e.Key, Value: e.Value, CreatedAt: now,
		})
	}
	return out, nil
}

// CommercialService owns tenant-facing commercial use cases: plan assignment
// (CPL-FR-002, US-2), entitlement overrides (CPL-FR-010), and
// effective-entitlement resolution (CPL-FR-011). Write methods are
// platform-operator scope (requireSuperAdmin at the API layer); the read
// method (EffectiveEntitlements) is also called by a tenant admin's own
// GET /tenants/{id}/entitlements and by the entitlements_flat projection
// worker, so both share this single resolution code path.
type CommercialService struct {
	Store Store
	Clock func() time.Time
}

func (s *CommercialService) now() time.Time { return s.Clock().UTC() }

// AssignPlan attaches a plan to a tenant, snapshotting the plan's current
// version (CPL-FR-002, US-2). CPL-FR-020: a tenant with commercial_state=none
// transitions directly to active (no trial); any other current state is left
// untouched here -- trial start/convert are slice-2 endpoints.
func (s *CommercialService) AssignPlan(ctx context.Context, tenantID uuid.UUID, planKey string, actor Actor) (*TenantPlan, error) {
	t, err := s.Store.GetTenant(ctx, tenantID)
	if err != nil {
		return nil, err
	}
	plan, err := s.Store.GetPlan(ctx, planKey)
	if err != nil {
		return nil, err
	}
	if plan.Status != "active" {
		return nil, EValidation("plan is not active",
			FieldError{Field: "plan_key", Message: "plan " + planKey + " is " + plan.Status})
	}
	now := s.now()
	tp := &TenantPlan{TenantID: tenantID, PlanKey: plan.Key, PlanVersionSnapshot: plan.Version, AssignedAt: now, AssignedBy: actor.ID}
	ev := NewEvent(EvCommercialPlanAssigned, tenantID, actor, t.URN(), now, map[string]any{
		"plan_key": plan.Key, "plan_version": plan.Version,
	})
	if err := s.Store.AssignTenantPlan(ctx, tp, ev); err != nil {
		return nil, err
	}
	if t.CommercialState == CommercialNone {
		// DSP-FR-003: a demo/poc tenant assigned a plan (e.g. the forced
		// internal-demo plan, DSP-FR-001) stays commercial_state=none --
		// CanTransitionCommercial's non-convertible table has no none->active
		// edge for those profiles, so this is a silent no-op for them rather
		// than an error, matching "demo tenants have no commercial
		// relationship" (BRD 70 §2.1).
		if CanTransitionCommercial(t.Profile, CommercialNone, CommercialActive) {
			cev := NewEvent(EvCommercialEntitlementChanged, tenantID, actor, t.URN(), now, map[string]any{
				"commercial_state_before": string(CommercialNone), "commercial_state_after": string(CommercialActive),
			})
			if err := s.Store.TransitionTenantCommercial(ctx, tenantID, t.Profile, CommercialNone, CommercialActive, cev); err != nil {
				return nil, err
			}
		}
	}
	return tp, nil
}

// Resync re-snapshots a tenant's assignment to its plan's CURRENT version
// (an explicit operator action per CPL-FR-002 -- plan changes never
// implicitly re-sync existing assignments).
func (s *CommercialService) Resync(ctx context.Context, tenantID uuid.UUID, actor Actor) (*TenantPlan, error) {
	t, err := s.Store.GetTenant(ctx, tenantID)
	if err != nil {
		return nil, err
	}
	tp, err := s.Store.GetTenantPlan(ctx, tenantID)
	if err != nil {
		return nil, err
	}
	plan, err := s.Store.GetPlan(ctx, tp.PlanKey)
	if err != nil {
		return nil, err
	}
	now := s.now()
	tp2 := &TenantPlan{TenantID: tenantID, PlanKey: plan.Key, PlanVersionSnapshot: plan.Version, AssignedAt: now, AssignedBy: actor.ID}
	ev := NewEvent(EvCommercialEntitlementChanged, tenantID, actor, t.URN(), now, map[string]any{
		"resync_from_version": tp.PlanVersionSnapshot, "resync_to_version": plan.Version,
	})
	if err := s.Store.AssignTenantPlan(ctx, tp2, ev); err != nil {
		return nil, err
	}
	return tp2, nil
}

// UpsertOverride sets (creates or replaces) one tenant entitlement override
// (CPL-FR-010, US-2).
func (s *CommercialService) UpsertOverride(ctx context.Context, tenantID uuid.UUID, kind EntitlementKind, key string, value map[string]any, reason string, actor Actor) (*TenantEntitlementOverride, error) {
	if err := ValidateEntitlementRef(kind, key); err != nil {
		return nil, err
	}
	t, err := s.Store.GetTenant(ctx, tenantID)
	if err != nil {
		return nil, err
	}
	id, _ := uuid.NewV7()
	now := s.now()
	o := &TenantEntitlementOverride{
		ID: id, TenantID: tenantID, Kind: kind, Key: key, Value: value,
		GrantedBy: actor.ID, GrantedAt: now, Reason: reason,
	}
	ev := NewEvent(EvCommercialEntitlementChanged, tenantID, actor, t.URN(), now, map[string]any{
		"action": "override_set", "kind": string(kind), "key": key,
	})
	if err := s.Store.UpsertEntitlementOverride(ctx, o, ev); err != nil {
		return nil, err
	}
	return o, nil
}

// RemoveOverride deletes one tenant entitlement override, reverting that
// (kind, key) to its plan default (or to absent, if the plan has no default
// for it either).
func (s *CommercialService) RemoveOverride(ctx context.Context, tenantID uuid.UUID, kind EntitlementKind, key string, actor Actor) error {
	if err := ValidateEntitlementRef(kind, key); err != nil {
		return err
	}
	t, err := s.Store.GetTenant(ctx, tenantID)
	if err != nil {
		return err
	}
	now := s.now()
	ev := NewEvent(EvCommercialEntitlementChanged, tenantID, actor, t.URN(), now, map[string]any{
		"action": "override_removed", "kind": string(kind), "key": key,
	})
	return s.Store.DeleteEntitlementOverride(ctx, tenantID, kind, key, ev)
}

// EffectiveEntitlements resolves the effective entitlement set for a tenant
// (CPL-FR-010/011): plan defaults at the tenant's snapshot version, with
// overrides layered on top. A tenant with no plan assignment yet still
// resolves (overrides alone, if any) rather than erroring -- CPL-FR-010 does
// not require a plan default to exist for an override to apply.
func (s *CommercialService) EffectiveEntitlements(ctx context.Context, tenantID uuid.UUID) (EffectiveSet, error) {
	t, err := s.Store.GetTenant(ctx, tenantID)
	if err != nil {
		return EffectiveSet{}, err
	}
	out := EffectiveSet{TenantID: tenantID, CommercialState: t.CommercialState, TrialEndsAt: t.TrialEndsAt}
	overrides, err := s.Store.ListEntitlementOverrides(ctx, tenantID)
	if err != nil {
		return EffectiveSet{}, err
	}
	tp, err := s.Store.GetTenantPlan(ctx, tenantID)
	if err != nil {
		if de, ok := AsError(err); ok && de.Code == CodeNotFound {
			out.Entitlements = ResolveEffectiveEntitlements(nil, overrides)
			return out, nil
		}
		return EffectiveSet{}, err
	}
	out.PlanKey, out.PlanVersion = tp.PlanKey, tp.PlanVersionSnapshot
	defaults, err := s.Store.ListPlanEntitlements(ctx, tp.PlanKey, tp.PlanVersionSnapshot)
	if err != nil {
		return EffectiveSet{}, err
	}
	out.Entitlements = ResolveEffectiveEntitlements(defaults, overrides)
	return out, nil
}
