package domain_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/datacern-ai/identity-service/internal/adapters/keycloak"
	"github.com/datacern-ai/identity-service/internal/adapters/terraform"
	"github.com/datacern-ai/identity-service/internal/domain"
	"github.com/datacern-ai/identity-service/internal/store/memory"
)

// TestSeedDemoContent_SkipDemoSeed: StepDeps.SkipDemoSeed (DEMO_SEED_MODE=
// skip) provisions a demo tenant to ACTIVE without touching the bundle
// loader or the seed runner. This is the explicit operator opt-out for
// deployments whose identity image cannot run the seed pipeline (the
// distroless production image has neither python nor deploy/demo on disk) —
// before it, every /public/demo-signup on such a deployment died at the
// final SeedDemoContent step. The loader here is primed to FAIL, proving
// skip short-circuits before Load; a silent skip that still loaded the
// bundle would go red on real hardware exactly like the rollout did.
func TestSeedDemoContent_SkipDemoSeed(t *testing.T) {
	ctx := context.Background()
	store := memory.New()
	clock := newClockBox(time.Now().UTC())
	seed := newFakeSeedRunner()
	loader := &fakeBundleLoader{err: errors.New("no bundles on this image")}

	deps := domain.StepDeps{
		Store: store, Keycloak: keycloak.NewFake(), Terraform: terraform.NewFake(),
		DB: terraform.NewFakeDB(), Prober: &terraform.FakeProber{}, Clock: clock.now,
		DemoBundles: loader, DemoSeed: seed, SkipDemoSeed: true,
	}
	cfg := domain.DefaultEngineConfig()
	cfg.Backoff = func(int) time.Duration { return 0 }
	cfg.Clock = clock.now
	engine := domain.NewEngine(store, cfg, deps.ProvisionSteps, deps.DestroySteps, nil)
	tenants := &domain.TenantService{
		Store: store, Engine: engine, Graph: domain.DefaultModuleGraph(),
		Prober: &terraform.FakeProber{}, Clock: clock.now, Async: false,
	}
	commercial := &domain.CommercialService{Store: store, Clock: clock.now}
	demo := &domain.DemoService{
		Store: store, Tenants: tenants, Commercial: commercial,
		Bundles: loader, Seed: seed, Clock: clock.now,
	}
	if err := store.CreatePlan(ctx, &domain.Plan{
		Key: domain.DemoTenantPlanKey, Name: "Internal Demo", Status: "active", Version: 1,
		CreatedAt: clock.now(), UpdatedAt: clock.now(),
	}, nil); err != nil {
		t.Fatalf("seed internal-demo plan: %v", err)
	}
	cellID, _ := uuid.NewV7()
	if err := store.CreateCell(ctx, &domain.Cell{
		ID: cellID, Name: "cell-aws-1", Cloud: "aws", Region: "us-east-1", Capacity: 10,
	}); err != nil {
		t.Fatalf("seed cell: %v", err)
	}

	tn, _, err := demo.Create(ctx, domain.CreateDemoTenantRequest{
		Name: "demo-skip-1", OwnerEmail: "owner@demo-skip.test",
		Pack: "insurance-claims-payer", Tier: "pool", Cloud: "aws",
	}, domain.Actor{Type: "user", ID: "op-1"})
	if err != nil {
		t.Fatalf("create demo tenant: %v", err)
	}

	got, err := store.GetTenant(ctx, tn.ID)
	if err != nil {
		t.Fatalf("get tenant: %v", err)
	}
	if got.Status != domain.TenantActive {
		t.Fatalf("tenant status = %s, want active (skip must not fail provisioning)", got.Status)
	}
	if seed.Calls != 0 {
		t.Fatalf("seed runner called %d times, want 0 under SkipDemoSeed", seed.Calls)
	}
	if loader.Loads != 0 {
		t.Fatalf("bundle loader called %d times, want 0 under SkipDemoSeed", loader.Loads)
	}
}
