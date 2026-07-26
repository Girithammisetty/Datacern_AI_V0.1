//go:build integration

package integration

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/datacern-ai/identity-service/internal/adapters/keycloak"
	"github.com/datacern-ai/identity-service/internal/adapters/terraform"
	"github.com/datacern-ai/identity-service/internal/domain"
	pgstore "github.com/datacern-ai/identity-service/internal/store/postgres"
)

// fakeDemoBundleLoader/fakeDemoSeedRunner mirror internal/domain's unit-test
// fakes (demo_test.go), duplicated here because that file lives in an
// internal test package the integration build can't import.
type fakeDemoBundleLoader struct{ calls int }

func (f *fakeDemoBundleLoader) Load(pack string) (*domain.DemoBundle, error) {
	f.calls++
	return &domain.DemoBundle{Pack: pack, Version: "1.0.0", Provenance: "synthetic"}, nil
}

type fakeDemoSeedRunner struct{ calls int }

func (f *fakeDemoSeedRunner) Seed(_ context.Context, _ *domain.Tenant, _ *domain.DemoBundle) error {
	f.calls++
	return nil
}

// TestDemoTenantSagaOnPostgres: BRD 70 §3 test plan -- "full provisioning
// saga run with profile=demo against a real Postgres..., extended to assert
// SeedDemoContent runs and is skipped for profile=standard." Uses the SAME
// fake Keycloak/Terraform/DB adapters TestProvisioningPersistenceAndResume
// already uses, over the real postgres.Store.
func TestDemoTenantSagaOnPostgres(t *testing.T) {
	requirePG(t)
	ctx := context.Background()
	store := pgstore.New(appPool)

	cellID, _ := uuid.NewV7()
	if err := store.CreateCell(ctx, &domain.Cell{ID: cellID, Name: freshName("cell"), Cloud: "aws", Region: "us-east-1", Capacity: 100}); err != nil {
		t.Fatal(err)
	}

	loader := &fakeDemoBundleLoader{}
	seed := &fakeDemoSeedRunner{}
	deps := domain.StepDeps{
		Store: store, Keycloak: keycloak.NewFake(), Terraform: terraform.NewFake(),
		DB: terraform.NewFakeDB(), Prober: &terraform.FakeProber{},
		DemoBundles: loader, DemoSeed: seed,
	}
	cfg := domain.DefaultEngineConfig()
	cfg.Backoff = func(int) time.Duration { return 0 }
	engine := domain.NewEngine(store, cfg, deps.ProvisionSteps, deps.DestroySteps, nil)

	// profile=demo tenant: SeedDemoContent must run.
	ttl := domain.DefaultDemoTTLDays
	demoName := freshName("demo")
	demoID, _ := uuid.NewV7()
	now := time.Now().UTC()
	demoTenant := &domain.Tenant{
		ID: demoID, Name: demoName, DisplayName: demoName, OwnerEmail: "owner@" + demoName + ".com",
		Tier: "pool", Cloud: "aws", Status: domain.TenantProvisioning, Quotas: domain.DefaultQuotas(),
		PlatformVersion: "latest", Subdomain: demoName, K8sNamespace: demoName, SchemaPrefix: demoName,
		Modules: []string{"data"}, CreatedAt: now, UpdatedAt: now,
		Profile: domain.ProfileDemo, DemoPack: "insurance-claims-payer", TTLDays: &ttl,
	}
	if err := store.CreateTenant(ctx, demoTenant); err != nil {
		t.Fatal(err)
	}
	if err := engine.Provision(ctx, demoTenant.ID); err != nil {
		t.Fatalf("provision (demo): %v", err)
	}
	got, err := store.GetTenant(ctx, demoTenant.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.Status != domain.TenantActive {
		t.Fatalf("demo tenant status = %s, want active", got.Status)
	}
	if got.Profile != domain.ProfileDemo || got.DemoPack != "insurance-claims-payer" {
		t.Fatalf("profile/demo_pack did not round-trip through postgres: %+v", got)
	}
	if seed.calls != 1 {
		t.Fatalf("SeedDemoContent Seed() called %d times, want 1", seed.calls)
	}
	steps, err := store.ListProvisioningSteps(ctx, demoTenant.ID, domain.WorkflowIDFor(demoTenant.ID))
	if err != nil {
		t.Fatal(err)
	}
	if len(steps) != 8 {
		t.Fatalf("expected 8 persisted steps (incl. SeedDemoContent), got %d", len(steps))
	}

	// profile=standard sibling: SeedDemoContent must be a true no-op (Seed
	// never called for it).
	stdName := freshName("std")
	stdID, _ := uuid.NewV7()
	stdTenant := &domain.Tenant{
		ID: stdID, Name: stdName, DisplayName: stdName, OwnerEmail: "owner@" + stdName + ".com",
		Tier: "pool", Cloud: "aws", Status: domain.TenantProvisioning, Quotas: domain.DefaultQuotas(),
		PlatformVersion: "latest", Subdomain: stdName, K8sNamespace: stdName, SchemaPrefix: stdName,
		Modules: []string{"data"}, CreatedAt: now, UpdatedAt: now, Profile: domain.ProfileStandard,
	}
	if err := store.CreateTenant(ctx, stdTenant); err != nil {
		t.Fatal(err)
	}
	if err := engine.Provision(ctx, stdTenant.ID); err != nil {
		t.Fatalf("provision (standard): %v", err)
	}
	if seed.calls != 1 {
		t.Fatalf("SeedDemoContent ran for a profile=standard tenant: Seed() total calls = %d, want still 1", seed.calls)
	}

	// Profile immutability at the persistence boundary: UpdateTenant never
	// writes the profile column (tenant_service.go never sets it in
	// PatchTenantRequest either -- this asserts the DB side of that
	// contract independently).
	got.DisplayName = "renamed-via-update"
	if err := store.UpdateTenant(ctx, got); err != nil {
		t.Fatal(err)
	}
	after, err := store.GetTenant(ctx, demoTenant.ID)
	if err != nil {
		t.Fatal(err)
	}
	if after.Profile != domain.ProfileDemo {
		t.Fatalf("UpdateTenant mutated profile: got %s, want demo", after.Profile)
	}
}

// TestDemoTenantRLSIsolation is DSP-NFR-002 literally: "demo/poc tenants get
// the identical isolation test suite as production, no shortcuts." Mirrors
// TestRLSIsolation's cross-tenant-404 + raw-SQL-invisibility assertions for
// a profile=demo tenant's own rows -- the RLS policies (migrations/0002)
// never branch on profile, so this proves that generically rather than by
// inspection.
func TestDemoTenantRLSIsolation(t *testing.T) {
	requirePG(t)
	ctx := context.Background()
	store := pgstore.New(appPool)

	ttl := domain.DefaultDemoTTLDays
	demoName := freshName("demo-rls")
	demoID, _ := uuid.NewV7()
	now := time.Now().UTC()
	demo := &domain.Tenant{
		ID: demoID, Name: demoName, DisplayName: demoName, OwnerEmail: "owner@" + demoName + ".com",
		Tier: "pool", Cloud: "aws", Status: domain.TenantActive, Quotas: domain.DefaultQuotas(),
		PlatformVersion: "latest", Subdomain: demoName, K8sNamespace: demoName, SchemaPrefix: demoName,
		Modules: []string{"data"}, CreatedAt: now, UpdatedAt: now,
		Profile: domain.ProfileDemo, DemoPack: "insurance-claims-payer", TTLDays: &ttl,
	}
	if err := store.CreateTenant(ctx, demo); err != nil {
		t.Fatal(err)
	}
	other := newTenantRow(t, store, domain.TenantActive) // profile=standard sibling

	demoUser := newUserRow(t, store, demo.ID, "u@"+demoName+".com")
	otherUser := newUserRow(t, store, other.ID, "u@other.com")

	// Cross-tenant read of the demo tenant's user -> 404, same as a standard
	// tenant (no profile-based shortcut in the RLS-scoped store methods).
	if _, err := store.GetUser(ctx, other.ID, demoUser.ID); err == nil {
		t.Fatal("standard tenant read the demo tenant's user through RLS")
	} else if de, _ := domain.AsError(err); de == nil || de.HTTP != 404 {
		t.Fatalf("want NOT_FOUND, got %v", err)
	}
	if _, err := store.GetUser(ctx, demo.ID, otherUser.ID); err == nil {
		t.Fatal("demo tenant read a standard tenant's user through RLS")
	}

	// Raw SQL proof: a session scoped to the demo tenant sees only its own row.
	tx, err := appPool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, "SELECT set_config('app.tenant_id', $1, true)", demo.ID.String()); err != nil {
		t.Fatal(err)
	}
	var n int
	if err := tx.QueryRow(ctx, "SELECT count(*) FROM users WHERE id = $1", otherUser.ID).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Fatal("raw SQL under the demo tenant's context saw the standard tenant's user")
	}
	if err := tx.QueryRow(ctx, "SELECT count(*) FROM users WHERE id = $1", demoUser.ID).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatal("raw SQL under the demo tenant's context did not see its own user")
	}
}
