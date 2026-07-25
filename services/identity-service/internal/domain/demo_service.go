package domain

import (
	"context"
	"strings"
	"time"

	"github.com/google/uuid"
)

// DemoTenantPlanKey is DSP-FR-001's forced plan for every profile=demo
// tenant -- BRD 66's seeded internal-demo plan (migrations/
// 0010_commercial_plans.up.sql). Demo tenants never leave commercial_state=
// none (non-convertibility, tenant.go), so this plan only ever supplies
// entitlement defaults (seat_cap/workspace_cap) -- it is not a billing
// relationship.
const DemoTenantPlanKey = "internal-demo"

// CreateDemoTenantRequest is POST /demo-tenants's body (DSP-FR-010).
type CreateDemoTenantRequest struct {
	Name        string `json:"name"`
	DisplayName string `json:"display_name"`
	OwnerEmail  string `json:"owner_email"`
	// Pack names the deploy/demo/<pack>/ bundle to seed (§2.2). Required.
	Pack    string `json:"pack"`
	Tier    string `json:"tier,omitempty"`  // default "pool"
	Cloud   string `json:"cloud,omitempty"` // default "aws"
	TTLDays *int   `json:"ttl_days,omitempty"`
}

// CloneDemoTenantRequest is POST /demo-tenants/{id}/clone's body (§2.4): a
// fresh sibling from the SAME recipe as the source tenant, not a data copy.
type CloneDemoTenantRequest struct {
	Name        string `json:"name"`
	DisplayName string `json:"display_name"`
	OwnerEmail  string `json:"owner_email,omitempty"` // defaults to the source's owner_email
}

// DemoService owns the demo-sandbox lifecycle use cases (BRD 70 §2.3/§2.4):
// create-from-template, idempotent reset, sibling clone. It composes
// TenantService (the 7(+1)-step provisioning saga) and CommercialService
// (the forced internal-demo plan assignment) rather than duplicating either.
type DemoService struct {
	Store      Store
	Tenants    *TenantService
	Commercial *CommercialService
	// Bundles/Seed are the SAME adapters wired into StepDeps for the
	// SeedDemoContent provisioning step (engine_steps.go) -- Reset drives
	// them directly rather than through the saga, since re-seeding is not a
	// provisioning-lifecycle event (§2.4).
	Bundles DemoBundleLoader
	Seed    DemoSeedRunner
	Clock   func() time.Time
}

func (s *DemoService) now() time.Time { return s.Clock().UTC() }

// Create provisions a profile=demo tenant end-to-end (DSP-FR-010): the
// tenant record + forced internal-demo plan assignment happen before the
// saga starts, so the SeedDemoContent step (engine_steps.go) always sees a
// fully profile/commercial-aware tenant on its first attempt.
func (s *DemoService) Create(ctx context.Context, req CreateDemoTenantRequest, actor Actor) (*Tenant, string, error) {
	if strings.TrimSpace(req.Pack) == "" {
		return nil, "", EValidation("pack is required", FieldError{Field: "pack", Message: "required"})
	}
	ttl := DefaultDemoTTLDays
	if req.TTLDays != nil {
		if *req.TTLDays <= 0 {
			return nil, "", EValidation("ttl_days must be positive", FieldError{Field: "ttl_days", Message: "must be > 0"})
		}
		ttl = *req.TTLDays
	}
	t, _, err := s.Tenants.Create(ctx, CreateTenantRequest{
		Name: req.Name, DisplayName: req.DisplayName, OwnerEmail: req.OwnerEmail,
		Tier: firstNonEmpty(req.Tier, "pool"), Cloud: firstNonEmpty(req.Cloud, "aws"),
		Publish:  false, // publish explicitly below, after the plan is assigned
		Profile:  ProfileDemo,
		DemoPack: req.Pack,
		TTLDays:  &ttl,
	}, actor)
	if err != nil {
		return nil, "", err
	}
	if s.Commercial != nil {
		// DSP-FR-001: "forced plan=internal-demo". CanTransitionCommercial's
		// non-convertible table (tenant.go) keeps this a no-op on
		// commercial_state itself (stays `none`) -- only entitlement
		// defaults (seat_cap/workspace_cap) attach.
		if _, err := s.Commercial.AssignPlan(ctx, t.ID, DemoTenantPlanKey, actor); err != nil {
			return nil, "", err
		}
	}
	opID, err := s.Tenants.Publish(ctx, t.ID, actor)
	if err != nil {
		return nil, "", err
	}
	t2, err := s.Store.GetTenant(ctx, t.ID)
	if err != nil {
		return nil, "", err
	}
	return t2, opID, nil
}

// Reset re-invokes the seeding runner idempotently (§2.4 Option A): a demo
// tenant mutated by a persona re-converges to the seeded baseline through
// the SAME real APIs the initial seed used (the bundle runner's own
// skip-if-exists idempotency, generalized from seed_claims_demo.py's proven
// pattern) -- never a storage-level snapshot/restore. Scoped exactly as the
// design accepts (§2.4 "Trade-off acknowledged"): it converges what the
// seeding step manages, not byte-for-byte snapshot parity.
func (s *DemoService) Reset(ctx context.Context, id uuid.UUID, actor Actor) (*Tenant, error) {
	t, err := s.Store.GetTenant(ctx, id)
	if err != nil {
		return nil, err
	}
	if t.Profile != ProfileDemo {
		return nil, EValidation("reset is only valid for profile=demo tenants",
			FieldError{Field: "profile", Message: string(t.Profile)})
	}
	if t.Status != TenantActive {
		return nil, EConflict("tenant must be active to reset, is " + string(t.Status))
	}
	if s.Bundles == nil || s.Seed == nil {
		return nil, EInternal("demo seeding is not configured on this deployment (Bundles/Seed adapters unset)")
	}
	bundle, err := s.Bundles.Load(t.DemoPack)
	if err != nil {
		return nil, err
	}
	if err := s.Seed.Seed(ctx, t, bundle); err != nil {
		return nil, err
	}
	now := s.now()
	if err := s.Store.AppendOutbox(ctx, NewEvent(EvDemoTenantReset, id, actor, t.URN(), now,
		map[string]any{"pack": t.DemoPack})); err != nil {
		return nil, err
	}
	return s.Store.GetTenant(ctx, id)
}

// Clone provisions an independent sibling from the same recipe (§2.4): NOT a
// data copy of the source tenant (RLS makes cross-tenant data copying
// deliberately hard, MASTER-FR-001..004) -- a fresh Create using the
// source's pack/tier/cloud and the source's own TTL countdown, restarted
// from creation. Mutations never cross (AC-2) because nothing is ever
// shared in the first place.
func (s *DemoService) Clone(ctx context.Context, sourceID uuid.UUID, req CloneDemoTenantRequest, actor Actor) (*Tenant, string, error) {
	src, err := s.Store.GetTenant(ctx, sourceID)
	if err != nil {
		return nil, "", err
	}
	if src.Profile != ProfileDemo {
		return nil, "", EValidation("clone is only valid for profile=demo tenants",
			FieldError{Field: "profile", Message: string(src.Profile)})
	}
	ttl := DefaultDemoTTLDays
	if src.TTLDays != nil {
		ttl = *src.TTLDays
	}
	sibling, opID, err := s.Create(ctx, CreateDemoTenantRequest{
		Name: req.Name, DisplayName: req.DisplayName,
		OwnerEmail: firstNonEmpty(req.OwnerEmail, src.OwnerEmail),
		Pack:       src.DemoPack, Tier: src.Tier, Cloud: src.Cloud, TTLDays: &ttl,
	}, actor)
	if err != nil {
		return nil, "", err
	}
	if err := s.Store.AppendOutbox(ctx, NewEvent(EvDemoTenantCloned, sibling.ID, actor, sibling.URN(), s.now(),
		map[string]any{"source_tenant_id": src.ID.String()})); err != nil {
		return nil, "", err
	}
	return sibling, opID, nil
}
