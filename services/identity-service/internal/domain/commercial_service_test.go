package domain_test

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/datacern-ai/identity-service/internal/domain"
	"github.com/datacern-ai/identity-service/internal/store/memory"
)

type commercialFixture struct {
	t          *testing.T
	store      *memory.Store
	clock      time.Time
	plans      *domain.PlanService
	commercial *domain.CommercialService
	actor      domain.Actor
}

func newCommercialFixture(t *testing.T) *commercialFixture {
	t.Helper()
	f := &commercialFixture{
		t: t, store: memory.New(), clock: time.Now().UTC(),
		actor: domain.Actor{Type: "user", ID: "operator-1", Scope: "platform"},
	}
	now := func() time.Time { return f.clock }
	f.plans = &domain.PlanService{Store: f.store, Clock: now}
	f.commercial = &domain.CommercialService{Store: f.store, Clock: now}
	return f
}

func (f *commercialFixture) newTenant(name string) *domain.Tenant {
	f.t.Helper()
	id, _ := uuid.NewV7()
	tn := &domain.Tenant{
		ID: id, Name: name, DisplayName: name, OwnerEmail: "o@" + name + ".com",
		Tier: "pool", Cloud: "aws", Status: domain.TenantActive, Quotas: domain.DefaultQuotas(),
		PlatformVersion: "latest", Subdomain: name, K8sNamespace: name, SchemaPrefix: name,
		Modules: []string{"data"}, CreatedAt: f.clock, UpdatedAt: f.clock,
		CommercialState: domain.CommercialNone,
	}
	if err := f.store.CreateTenant(context.Background(), tn); err != nil {
		f.t.Fatal(err)
	}
	return tn
}

func (f *commercialFixture) mustCreatePlan(req domain.CreatePlanRequest) *domain.Plan {
	f.t.Helper()
	p, err := f.plans.Create(context.Background(), req)
	if err != nil {
		f.t.Fatalf("create plan %q: %v", req.Key, err)
	}
	return p
}

// TestPlanService_CreateAndGet covers CPL-FR-001: plan create + default
// entitlements round-trip.
func TestPlanService_CreateAndGet(t *testing.T) {
	f := newCommercialFixture(t)
	days := 60
	f.mustCreatePlan(domain.CreatePlanRequest{
		Key: "pilot", Name: "Pilot", TrialDaysDefault: &days,
		Entitlements: []domain.PlanEntitlementInput{
			{Kind: domain.KindSeatCap, Key: "seats", Value: map[string]any{"n": float64(15)}},
		},
	})
	p, ents, err := f.plans.Get(context.Background(), "pilot")
	if err != nil {
		t.Fatal(err)
	}
	if p.Version != 1 || p.Status != "active" {
		t.Errorf("new plan: version=%d status=%s, want 1/active", p.Version, p.Status)
	}
	if len(ents) != 1 || ents[0].Key != "seats" {
		t.Fatalf("expected 1 seed entitlement, got %+v", ents)
	}
	if _, err := f.plans.Create(context.Background(), domain.CreatePlanRequest{Key: "pilot", Name: "dup"}); err == nil {
		t.Fatal("expected duplicate plan key rejection")
	}
	if _, err := f.plans.Create(context.Background(), domain.CreatePlanRequest{Key: "Bad Key", Name: "x"}); err == nil {
		t.Fatal("expected invalid key rejection")
	}
}

// TestPlanService_PatchBumpsVersionOnlyWhenEntitlementsSet covers CPL-FR-002:
// a plain metadata patch does not bump the version; an entitlements patch
// does, and the OLD version's rows remain queryable.
func TestPlanService_PatchBumpsVersionOnlyWhenEntitlementsSet(t *testing.T) {
	f := newCommercialFixture(t)
	f.mustCreatePlan(domain.CreatePlanRequest{
		Key: "enterprise", Name: "Enterprise",
		Entitlements: []domain.PlanEntitlementInput{{Kind: domain.KindSeatCap, Key: "seats", Value: map[string]any{"n": float64(200)}}},
	})

	newDesc := "updated description"
	p, err := f.plans.Patch(context.Background(), "enterprise", domain.PatchPlanRequest{Description: &newDesc})
	if err != nil {
		t.Fatal(err)
	}
	if p.Version != 1 {
		t.Fatalf("metadata-only patch bumped version to %d, want 1", p.Version)
	}

	p, err = f.plans.Patch(context.Background(), "enterprise", domain.PatchPlanRequest{
		EntitlementsSet: true,
		Entitlements:    []domain.PlanEntitlementInput{{Kind: domain.KindSeatCap, Key: "seats", Value: map[string]any{"n": float64(500)}}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if p.Version != 2 {
		t.Fatalf("entitlements patch: version=%d, want 2", p.Version)
	}
	v1ents, err := f.store.ListPlanEntitlements(context.Background(), "enterprise", 1)
	if err != nil {
		t.Fatal(err)
	}
	if len(v1ents) != 1 || v1ents[0].Value["n"] != float64(200) {
		t.Fatalf("version-1 defaults were mutated: %+v", v1ents)
	}
	v2ents, err := f.store.ListPlanEntitlements(context.Background(), "enterprise", 2)
	if err != nil {
		t.Fatal(err)
	}
	if len(v2ents) != 1 || v2ents[0].Value["n"] != float64(500) {
		t.Fatalf("version-2 defaults wrong: %+v", v2ents)
	}
}

// TestCommercialService_AssignPlan_SnapshotSemantics covers CPL-FR-002 (US-2):
// assignment snapshots the plan version at attach time; a later plan default
// change does not silently alter an already-assigned tenant's effective set.
func TestCommercialService_AssignPlan_SnapshotSemantics(t *testing.T) {
	f := newCommercialFixture(t)
	f.mustCreatePlan(domain.CreatePlanRequest{
		Key: "pilot", Name: "Pilot",
		Entitlements: []domain.PlanEntitlementInput{{Kind: domain.KindSeatCap, Key: "seats", Value: map[string]any{"n": float64(15)}}},
	})
	tn := f.newTenant("acme")
	tn.CommercialState = domain.CommercialNone
	if err := f.store.UpdateTenant(context.Background(), tn); err != nil {
		t.Fatal(err)
	}

	tp, err := f.commercial.AssignPlan(context.Background(), tn.ID, "pilot", f.actor)
	if err != nil {
		t.Fatal(err)
	}
	if tp.PlanVersionSnapshot != 1 {
		t.Fatalf("snapshot version = %d, want 1", tp.PlanVersionSnapshot)
	}

	// CPL-FR-020: none -> active happens automatically on direct assignment.
	got, err := f.store.GetTenant(context.Background(), tn.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.CommercialState != domain.CommercialActive {
		t.Fatalf("commercial_state = %s, want active", got.CommercialState)
	}

	// Bump the plan's defaults to version 2.
	if _, err := f.plans.Patch(context.Background(), "pilot", domain.PatchPlanRequest{
		EntitlementsSet: true,
		Entitlements:    []domain.PlanEntitlementInput{{Kind: domain.KindSeatCap, Key: "seats", Value: map[string]any{"n": float64(999)}}},
	}); err != nil {
		t.Fatal(err)
	}

	eff, err := f.commercial.EffectiveEntitlements(context.Background(), tn.ID)
	if err != nil {
		t.Fatal(err)
	}
	if eff.PlanVersion != 1 {
		t.Fatalf("effective set still pinned to version %d, want 1 (unaffected by the v2 patch)", eff.PlanVersion)
	}
	if len(eff.Entitlements) != 1 || eff.Entitlements[0].Value["n"] != float64(15) {
		t.Fatalf("expected the v1 seat cap (15), got %+v", eff.Entitlements)
	}

	// Explicit resync moves the snapshot forward.
	tp2, err := f.commercial.Resync(context.Background(), tn.ID, f.actor)
	if err != nil {
		t.Fatal(err)
	}
	if tp2.PlanVersionSnapshot != 2 {
		t.Fatalf("resync snapshot = %d, want 2", tp2.PlanVersionSnapshot)
	}
	eff2, err := f.commercial.EffectiveEntitlements(context.Background(), tn.ID)
	if err != nil {
		t.Fatal(err)
	}
	if eff2.Entitlements[0].Value["n"] != float64(999) {
		t.Fatalf("post-resync entitlement value = %+v, want 999", eff2.Entitlements[0].Value)
	}
}

// TestCommercialService_OverridesWinAndAreRemovable covers CPL-FR-010.
func TestCommercialService_OverridesWinAndAreRemovable(t *testing.T) {
	f := newCommercialFixture(t)
	f.mustCreatePlan(domain.CreatePlanRequest{
		Key: "pilot", Name: "Pilot",
		Entitlements: []domain.PlanEntitlementInput{{Kind: domain.KindSeatCap, Key: "seats", Value: map[string]any{"n": float64(15)}}},
	})
	tn := f.newTenant("beta")
	if _, err := f.commercial.AssignPlan(context.Background(), tn.ID, "pilot", f.actor); err != nil {
		t.Fatal(err)
	}

	if _, err := f.commercial.UpsertOverride(context.Background(), tn.ID, domain.KindSeatCap, "seats",
		map[string]any{"n": float64(30)}, "negotiated expansion", f.actor); err != nil {
		t.Fatal(err)
	}
	eff, err := f.commercial.EffectiveEntitlements(context.Background(), tn.ID)
	if err != nil {
		t.Fatal(err)
	}
	if eff.Entitlements[0].Provenance != domain.ProvenanceOverride || eff.Entitlements[0].Value["n"] != float64(30) {
		t.Fatalf("expected override n=30, got %+v", eff.Entitlements[0])
	}

	if err := f.commercial.RemoveOverride(context.Background(), tn.ID, domain.KindSeatCap, "seats", f.actor); err != nil {
		t.Fatal(err)
	}
	eff2, err := f.commercial.EffectiveEntitlements(context.Background(), tn.ID)
	if err != nil {
		t.Fatal(err)
	}
	if eff2.Entitlements[0].Provenance != domain.ProvenancePlanDefault || eff2.Entitlements[0].Value["n"] != float64(15) {
		t.Fatalf("expected plan default n=15 after override removal, got %+v", eff2.Entitlements[0])
	}

	if err := f.commercial.RemoveOverride(context.Background(), tn.ID, domain.KindSeatCap, "seats", f.actor); err == nil {
		t.Fatal("expected NOT_FOUND removing an already-removed override")
	}
}

// TestCommercialService_EffectiveEntitlements_NoPlanAssigned covers the "no
// plan yet, overrides alone" path CPL-FR-010 requires.
func TestCommercialService_EffectiveEntitlements_NoPlanAssigned(t *testing.T) {
	f := newCommercialFixture(t)
	tn := f.newTenant("gamma")
	if _, err := f.commercial.UpsertOverride(context.Background(), tn.ID, domain.KindFeature, "beta-ui", nil, "early access", f.actor); err != nil {
		t.Fatal(err)
	}
	eff, err := f.commercial.EffectiveEntitlements(context.Background(), tn.ID)
	if err != nil {
		t.Fatal(err)
	}
	if eff.PlanKey != "" {
		t.Fatalf("expected no plan key, got %q", eff.PlanKey)
	}
	if len(eff.Entitlements) != 1 || eff.Entitlements[0].Provenance != domain.ProvenanceOverride {
		t.Fatalf("expected 1 additive override, got %+v", eff.Entitlements)
	}
}

// TestCommercialService_AssignPlan_RejectsDeprecatedPlan.
func TestCommercialService_AssignPlan_RejectsDeprecatedPlan(t *testing.T) {
	f := newCommercialFixture(t)
	f.mustCreatePlan(domain.CreatePlanRequest{Key: "internal-demo", Name: "Internal Demo"})
	deprecated := "deprecated"
	if _, err := f.plans.Patch(context.Background(), "internal-demo", domain.PatchPlanRequest{Status: &deprecated}); err != nil {
		t.Fatal(err)
	}
	tn := f.newTenant("delta")
	if _, err := f.commercial.AssignPlan(context.Background(), tn.ID, "internal-demo", f.actor); err == nil {
		t.Fatal("expected assignment to a deprecated plan to be rejected")
	}
}

// TestErrorConstructors_CommercialCodes: the four new stable error codes
// (BRD 66 design doc "Enforcement hook contracts") carry the right HTTP
// status + envelope shape, even though nothing raises them until slice 3.
func TestErrorConstructors_CommercialCodes(t *testing.T) {
	if e := domain.EEntitlementRequired("banking-aml"); e.HTTP != 403 || e.Code != domain.CodeEntitlementRequired {
		t.Errorf("EEntitlementRequired: %+v", e)
	}
	if e := domain.ETrialExpired(); e.HTTP != 403 || e.Code != domain.CodeTrialExpired {
		t.Errorf("ETrialExpired: %+v", e)
	}
	if e := domain.ECapExceeded(5, 5); e.HTTP != 403 || e.Code != domain.CodeCapExceeded {
		t.Errorf("ECapExceeded: %+v", e)
	}
	if e := domain.EEntitlementUnavailable(); e.HTTP != 503 || e.Code != domain.CodeEntitlementUnavailable {
		t.Errorf("EEntitlementUnavailable: %+v", e)
	}
}
