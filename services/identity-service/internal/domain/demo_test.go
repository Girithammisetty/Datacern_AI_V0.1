package domain_test

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/datacern-ai/identity-service/internal/adapters/keycloak"
	"github.com/datacern-ai/identity-service/internal/adapters/terraform"
	"github.com/datacern-ai/identity-service/internal/domain"
	"github.com/datacern-ai/identity-service/internal/store/memory"
)

// clockBox is a settable, thread-safe clock for controlling `now()` across a
// TenantService/Engine/DemoReaper triple in tests (TTL sweep tests need to
// move time forward without a real sleep).
type clockBox struct {
	mu sync.Mutex
	t  time.Time
}

func newClockBox(t time.Time) *clockBox { return &clockBox{t: t} }
func (c *clockBox) now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.t
}
func (c *clockBox) advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.t = c.t.Add(d)
}

// fakeSeedRunner is a scriptable domain.DemoSeedRunner. FailFirstN makes the
// first N calls fail (simulating a transient real-API failure the engine's
// own retry/backoff loop must absorb, engine_steps.go SeedDemoContent);
// after that it "seeds" idempotently: repeat calls for the same tenant do
// not grow SeededResources, mirroring seed_claims_demo.py's proven
// skip-if-exists pattern (§2.3/§2.4).
type fakeSeedRunner struct {
	mu              sync.Mutex
	Calls           int
	FailFirstN      int
	SeededResources map[uuid.UUID]int // tenant -> distinct "resources" created
	LastBundle      *domain.DemoBundle
}

func newFakeSeedRunner() *fakeSeedRunner {
	return &fakeSeedRunner{SeededResources: map[uuid.UUID]int{}}
}

func (f *fakeSeedRunner) Seed(_ context.Context, t *domain.Tenant, bundle *domain.DemoBundle) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.Calls++
	f.LastBundle = bundle
	if f.Calls <= f.FailFirstN {
		return domain.EInternal("simulated transient seeding failure")
	}
	if f.SeededResources[t.ID] == 0 {
		f.SeededResources[t.ID] = len(bundle.Personas) + len(bundle.Cases)
	}
	// idempotent: a repeat call never grows the resource count.
	return nil
}

type fakeBundleLoader struct {
	bundle *domain.DemoBundle
	err    error
	Loads  int
}

func (f *fakeBundleLoader) Load(pack string) (*domain.DemoBundle, error) {
	f.Loads++
	if f.err != nil {
		return nil, f.err
	}
	b := *f.bundle
	b.Pack = pack
	return &b, nil
}

func sampleBundle() *domain.DemoBundle {
	return &domain.DemoBundle{
		Pack: "insurance-claims-payer", Version: "1.0.0",
		Provenance: "synthetic data, no real PII",
		Personas: []domain.DemoPersona{
			{EmailLocalPart: "admin", Role: "payer-admin", DisplayName: "Demo Admin"},
			{EmailLocalPart: "analyst", Role: "claims-analyst", DisplayName: "Demo Analyst"},
		},
		Cases: []domain.DemoCase{
			{Dataset: "payer_claims", RowPK: "CLM-1001", Severity: "high", Note: "duplicate invoice"},
		},
	}
}

// demoFixture wires a full TenantService+Engine+DemoService+DemoReaper over
// the memory store with fake infra adapters, mirroring engineFixture
// (provisioning_test.go) but adding the demo-lifecycle services.
type demoFixture struct {
	store   *memory.Store
	clock   *clockBox
	kc      *keycloak.Fake
	tf      *terraform.Fake
	db      *terraform.FakeDBProvisioner
	prober  *terraform.FakeProber
	engine  *domain.Engine
	tenants *domain.TenantService
	commrcl *domain.CommercialService
	demo    *domain.DemoService
	seed    *fakeSeedRunner
	loader  *fakeBundleLoader
}

func newDemoFixture(t *testing.T) *demoFixture {
	t.Helper()
	f := &demoFixture{
		store: memory.New(), clock: newClockBox(time.Now().UTC()),
		kc: keycloak.NewFake(), tf: terraform.NewFake(),
		db: terraform.NewFakeDB(), prober: &terraform.FakeProber{},
		seed: newFakeSeedRunner(), loader: &fakeBundleLoader{bundle: sampleBundle()},
	}
	deps := domain.StepDeps{
		Store: f.store, Keycloak: f.kc, Terraform: f.tf, DB: f.db, Prober: f.prober,
		Clock: f.clock.now, DemoBundles: f.loader, DemoSeed: f.seed,
	}
	cfg := domain.DefaultEngineConfig()
	cfg.Backoff = func(int) time.Duration { return 0 } // no waiting in tests
	cfg.Clock = f.clock.now
	f.engine = domain.NewEngine(f.store, cfg, deps.ProvisionSteps, deps.DestroySteps, nil)
	f.tenants = &domain.TenantService{
		Store: f.store, Engine: f.engine, Graph: domain.DefaultModuleGraph(),
		Prober: f.prober, Clock: f.clock.now, Async: false,
	}
	f.commrcl = &domain.CommercialService{Store: f.store, Clock: f.clock.now}
	f.demo = &domain.DemoService{
		Store: f.store, Tenants: f.tenants, Commercial: f.commrcl,
		Bundles: f.loader, Seed: f.seed, Clock: f.clock.now,
	}

	// internal-demo plan must exist for DemoService.Create's forced-plan
	// assignment (BRD 66 migrations/0010 seeds it in postgres; the memory
	// store needs it created explicitly).
	if err := f.store.CreatePlan(context.Background(), &domain.Plan{
		Key: domain.DemoTenantPlanKey, Name: "Internal Demo", Status: "active", Version: 1,
		CreatedAt: f.clock.now(), UpdatedAt: f.clock.now(),
	}, nil); err != nil {
		t.Fatalf("seed internal-demo plan: %v", err)
	}
	cellID, _ := uuid.NewV7()
	if err := f.store.CreateCell(context.Background(), &domain.Cell{
		ID: cellID, Name: "cell-aws-1", Cloud: "aws", Region: "us-east-1", Capacity: 10,
	}); err != nil {
		t.Fatalf("seed cell: %v", err)
	}
	return f
}

func (f *demoFixture) actor() domain.Actor { return domain.Actor{Type: "user", ID: "op-1"} }

// --- Profile immutability (BRD 70 §2.1) ---------------------------------

// TestTenantProfileImmutability: Profile is set once at Create and no
// mutation path -- including Patch's full field surface -- ever changes it,
// mirroring the "absence from the mutable surface" pattern the design
// commits to (docs/initiatives/demo-sandbox-poc-mode.md §2.1).
func TestTenantProfileImmutability(t *testing.T) {
	f := newDemoFixture(t)
	ctx := context.Background()

	demoTenant, _, err := f.demo.Create(ctx, domain.CreateDemoTenantRequest{
		Name: "acme-demo", OwnerEmail: "owner@acme-demo.com", Pack: "insurance-claims-payer",
	}, f.actor())
	if err != nil {
		t.Fatalf("create demo tenant: %v", err)
	}
	if demoTenant.Profile != domain.ProfileDemo {
		t.Fatalf("profile = %s, want demo", demoTenant.Profile)
	}

	// A standard-profile Create (no Profile set on the request) must default
	// to ProfileStandard, not leak the previous test's demo value.
	std, _, err := f.tenants.Create(ctx, domain.CreateTenantRequest{
		Name: "acme-std", OwnerEmail: "owner@acme-std.com", Tier: "pool", Cloud: "aws",
	}, f.actor())
	if err != nil {
		t.Fatalf("create standard tenant: %v", err)
	}
	if std.Profile != domain.ProfileStandard {
		t.Fatalf("profile = %s, want standard", std.Profile)
	}

	// PatchTenantRequest's full field surface cannot touch Profile: exercise
	// every field it DOES expose and confirm Profile survives unchanged.
	newName := "renamed"
	newAuto := true
	if _, err := f.tenants.Patch(ctx, demoTenant.ID, domain.PatchTenantRequest{
		DisplayName: &newName,
		Quotas:      &domain.Quotas{CPU: 8, Memory: "32Gi", ProcessingCPU: 8, ProcessingMemory: "32Gi"},
		AutoUpgrade: &newAuto,
	}, f.actor()); err != nil {
		t.Fatalf("patch: %v", err)
	}
	after, err := f.store.GetTenant(ctx, demoTenant.ID)
	if err != nil {
		t.Fatal(err)
	}
	if after.Profile != domain.ProfileDemo {
		t.Fatalf("profile mutated by Patch: got %s, want demo", after.Profile)
	}
	if after.DisplayName != newName {
		t.Fatalf("patch did not apply: display_name = %s", after.DisplayName)
	}
}

// TestDemoTenantNonConvertible is BRD 70's AC-3 at the service layer (not
// just the transition-table unit test in commercial_test.go): assigning the
// forced internal-demo plan to a demo tenant must never move
// commercial_state past `none`, even though the SAME AssignPlan call moves a
// standard tenant none->active.
func TestDemoTenantNonConvertible(t *testing.T) {
	f := newDemoFixture(t)
	ctx := context.Background()

	demoTenant, _, err := f.demo.Create(ctx, domain.CreateDemoTenantRequest{
		Name: "acme-demo2", OwnerEmail: "owner@acme-demo2.com", Pack: "insurance-claims-payer",
	}, f.actor())
	if err != nil {
		t.Fatalf("create demo tenant: %v", err)
	}
	got, err := f.store.GetTenant(ctx, demoTenant.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.CommercialState != domain.CommercialNone {
		t.Fatalf("demo tenant commercial_state = %s, want none (plan assignment must not activate it)", got.CommercialState)
	}
}

// --- SeedDemoContent step (§2.3) ----------------------------------------

// TestSeedDemoContent_GatedByProfile: the step is a true no-op (Seed never
// called) for a standard-profile tenant, and calls Seed exactly once with
// the tenant's own DemoPack for a demo-profile tenant.
func TestSeedDemoContent_GatedByProfile(t *testing.T) {
	f := newDemoFixture(t)
	ctx := context.Background()

	std, _, err := f.tenants.Create(ctx, domain.CreateTenantRequest{
		Name: "std-1", OwnerEmail: "o@std1.com", Tier: "pool", Cloud: "aws", Publish: true,
	}, f.actor())
	if err != nil {
		t.Fatalf("create+publish standard tenant: %v", err)
	}
	got, _ := f.store.GetTenant(ctx, std.ID)
	if got.Status != domain.TenantActive {
		t.Fatalf("standard tenant status = %s, want active", got.Status)
	}
	if f.seed.Calls != 0 {
		t.Fatalf("SeedDemoContent must no-op for profile=standard; Seed called %d times", f.seed.Calls)
	}

	demoTenant, _, err := f.demo.Create(ctx, domain.CreateDemoTenantRequest{
		Name: "demo-1", OwnerEmail: "o@demo1.com", Pack: "insurance-claims-payer",
	}, f.actor())
	if err != nil {
		t.Fatalf("create demo tenant: %v", err)
	}
	got2, _ := f.store.GetTenant(ctx, demoTenant.ID)
	if got2.Status != domain.TenantActive {
		t.Fatalf("demo tenant status = %s, want active", got2.Status)
	}
	if f.seed.Calls != 1 {
		t.Fatalf("Seed called %d times for the demo tenant, want 1", f.seed.Calls)
	}
	if f.seed.LastBundle == nil || f.seed.LastBundle.Pack != "insurance-claims-payer" {
		t.Fatalf("Seed received the wrong bundle: %+v", f.seed.LastBundle)
	}
}

// TestSeedDemoContent_RetryAfterPartialFailureDoesNotDuplicate: the engine's
// own attempt/backoff loop (provisioning.go runStep) retries a failed
// SeedDemoContent Run; a real seeding runner is idempotent (skip-if-exists),
// so the resource count seeded ends up the same whether it took one attempt
// or several -- exactly the property DSP-FR-010/§2.3 depends on for both
// first-run retries and the reset endpoint's repeat invocations.
func TestSeedDemoContent_RetryAfterPartialFailureDoesNotDuplicate(t *testing.T) {
	f := newDemoFixture(t)
	f.seed.FailFirstN = 2 // fail attempts 1-2, succeed on attempt 3 (max is 5)
	ctx := context.Background()

	demoTenant, _, err := f.demo.Create(ctx, domain.CreateDemoTenantRequest{
		Name: "demo-retry", OwnerEmail: "o@demoretry.com", Pack: "insurance-claims-payer",
	}, f.actor())
	if err != nil {
		t.Fatalf("create demo tenant: %v", err)
	}
	got, _ := f.store.GetTenant(ctx, demoTenant.ID)
	if got.Status != domain.TenantActive {
		t.Fatalf("status = %s, want active (engine must retry through the transient failures)", got.Status)
	}
	if f.seed.Calls != 3 {
		t.Fatalf("Seed called %d times, want 3 (2 failures + 1 success)", f.seed.Calls)
	}
	firstCount := f.seed.SeededResources[demoTenant.ID]
	if firstCount == 0 {
		t.Fatal("no resources recorded as seeded after the successful attempt")
	}

	// Now simulate an explicit reset (§2.4): re-invoke Seed directly again
	// (as DemoService.Reset does) and confirm the idempotent runner does not
	// grow the resource count.
	bundle, err := f.loader.Load(demoTenant.DemoPack)
	if err != nil {
		t.Fatal(err)
	}
	if err := f.seed.Seed(ctx, got, bundle); err != nil {
		t.Fatalf("re-seed: %v", err)
	}
	if f.seed.SeededResources[demoTenant.ID] != firstCount {
		t.Fatalf("re-seeding duplicated resources: got %d, want %d",
			f.seed.SeededResources[demoTenant.ID], firstCount)
	}
}

// TestSeedDemoContent_MissingAdapterFailsLoud: CONVENTIONS.md's "no stub
// reachable from runtime" -- a demo tenant with no DemoBundles/DemoSeed
// configured must fail the saga, never silently provision an unseeded demo
// tenant.
func TestSeedDemoContent_MissingAdapterFailsLoud(t *testing.T) {
	store := memory.New()
	clock := newClockBox(time.Now().UTC())
	deps := domain.StepDeps{
		Store: store, Keycloak: keycloak.NewFake(), Terraform: terraform.NewFake(),
		DB: terraform.NewFakeDB(), Prober: &terraform.FakeProber{}, Clock: clock.now,
		// DemoBundles/DemoSeed deliberately left nil.
	}
	cfg := domain.DefaultEngineConfig()
	cfg.Backoff = func(int) time.Duration { return 0 }
	cfg.MaxAttempts = 1 // fail fast; this isn't a transient-error test
	cfg.Clock = clock.now
	engine := domain.NewEngine(store, cfg, deps.ProvisionSteps, deps.DestroySteps, nil)
	tenants := &domain.TenantService{
		Store: store, Engine: engine, Graph: domain.DefaultModuleGraph(),
		Prober: &terraform.FakeProber{}, Clock: clock.now, Async: false,
	}
	cellID, _ := uuid.NewV7()
	if err := store.CreateCell(context.Background(), &domain.Cell{
		ID: cellID, Name: "cell-aws-1", Cloud: "aws", Region: "us-east-1", Capacity: 10,
	}); err != nil {
		t.Fatal(err)
	}
	ttl := domain.DefaultDemoTTLDays
	_, _, err := tenants.Create(context.Background(), domain.CreateTenantRequest{
		Name: "demo-noadapter", OwnerEmail: "o@x.com", Tier: "pool", Cloud: "aws", Publish: true,
		Profile: domain.ProfileDemo, DemoPack: "insurance-claims-payer", TTLDays: &ttl,
	}, domain.Actor{Type: "user", ID: "op"})
	if err != nil {
		t.Fatalf("Create/Publish itself must succeed (failure surfaces via provisioning status): %v", err)
	}
	got, err := store.GetTenantByName(context.Background(), "demo-noadapter")
	if err != nil {
		t.Fatal(err)
	}
	if got.Status != domain.TenantProvisionFailed {
		t.Fatalf("status = %s, want provision_failed (unconfigured seeding must not silently succeed)", got.Status)
	}
}

// --- DemoReaper (§2.5) ---------------------------------------------------

// TestDemoReaper_SweepReapsExpiredAndIsIdempotent covers AC-4 exactly: TTL
// expiry reaps via the real deprovision saga, is audited
// (demo.tenant_reaped.v1), and re-running the reaper is a no-op.
func TestDemoReaper_SweepReapsExpiredAndIsIdempotent(t *testing.T) {
	f := newDemoFixture(t)
	ctx := context.Background()
	ttl := 1
	demoTenant, _, err := f.demo.Create(ctx, domain.CreateDemoTenantRequest{
		Name: "demo-ttl", OwnerEmail: "o@demottl.com", Pack: "insurance-claims-payer",
		TTLDays: &ttl,
	}, f.actor())
	if err != nil {
		t.Fatalf("create demo tenant: %v", err)
	}
	// A standard tenant with no TTL must never be swept, even if very old.
	std, _, err := f.tenants.Create(ctx, domain.CreateTenantRequest{
		Name: "std-old", OwnerEmail: "o@stdold.com", Tier: "pool", Cloud: "aws", Publish: true,
	}, f.actor())
	if err != nil {
		t.Fatalf("create standard tenant: %v", err)
	}

	reaper := &domain.DemoReaper{Store: f.store, Tenants: f.tenants, Engine: f.engine, Clock: f.clock.now}

	// Not yet expired: sweep is a no-op.
	n, err := reaper.Sweep(ctx)
	if err != nil {
		t.Fatalf("sweep: %v", err)
	}
	if n != 0 {
		t.Fatalf("swept %d tenants before TTL expiry, want 0", n)
	}

	f.clock.advance(25 * time.Hour) // past ttl_days=1

	n, err = reaper.Sweep(ctx)
	if err != nil {
		t.Fatalf("sweep: %v", err)
	}
	if n != 1 {
		t.Fatalf("swept %d tenants, want 1", n)
	}
	got, err := f.store.GetTenant(ctx, demoTenant.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.Status != domain.TenantDeleted {
		t.Fatalf("demo tenant status = %s, want deleted", got.Status)
	}
	reaped := f.store.EventsOfType(domain.EvDemoTenantReaped)
	if len(reaped) != 1 {
		t.Fatalf("expected exactly 1 demo.tenant_reaped.v1 event, got %d", len(reaped))
	}

	stdAfter, err := f.store.GetTenant(ctx, std.ID)
	if err != nil {
		t.Fatal(err)
	}
	if stdAfter.Status != domain.TenantActive {
		t.Fatalf("standard tenant (no TTL) was reaped: status = %s", stdAfter.Status)
	}

	// AC-4: re-running the reaper is a no-op (already deleted, excluded from
	// the candidate list).
	n, err = reaper.Sweep(ctx)
	if err != nil {
		t.Fatalf("second sweep: %v", err)
	}
	if n != 0 {
		t.Fatalf("second sweep reaped %d, want 0 (idempotent no-op)", n)
	}
	reapedAfter := f.store.EventsOfType(domain.EvDemoTenantReaped)
	if len(reapedAfter) != 1 {
		t.Fatalf("second sweep emitted more events: got %d, want still 1", len(reapedAfter))
	}
}

// fakeLease is a scriptable domain.LeaseChecker.
type fakeLease struct{ leader bool }

func (f *fakeLease) IsLeader() bool { return f.leader }

// TestDemoReaper_NotLeaderSkipsSweep: §2.5's leader-election requirement --
// a non-leader replica must never reap, even when tenants are expired.
func TestDemoReaper_NotLeaderSkipsSweep(t *testing.T) {
	f := newDemoFixture(t)
	ctx := context.Background()
	ttl := 1
	if _, _, err := f.demo.Create(ctx, domain.CreateDemoTenantRequest{
		Name: "demo-notleader", OwnerEmail: "o@nl.com", Pack: "insurance-claims-payer", TTLDays: &ttl,
	}, f.actor()); err != nil {
		t.Fatalf("create demo tenant: %v", err)
	}
	f.clock.advance(25 * time.Hour)

	reaper := &domain.DemoReaper{
		Store: f.store, Tenants: f.tenants, Engine: f.engine, Clock: f.clock.now,
		Lease: &fakeLease{leader: false},
	}
	n, err := reaper.Sweep(ctx)
	if err != nil {
		t.Fatalf("sweep: %v", err)
	}
	if n != 0 {
		t.Fatalf("non-leader swept %d tenants, want 0", n)
	}
}

// --- Reset / Clone (§2.4) -------------------------------------------------

func TestDemoService_ResetReSeedsIdempotently(t *testing.T) {
	f := newDemoFixture(t)
	ctx := context.Background()
	demoTenant, _, err := f.demo.Create(ctx, domain.CreateDemoTenantRequest{
		Name: "demo-reset", OwnerEmail: "o@dr.com", Pack: "insurance-claims-payer",
	}, f.actor())
	if err != nil {
		t.Fatalf("create demo tenant: %v", err)
	}
	if f.seed.Calls != 1 {
		t.Fatalf("Seed calls after create = %d, want 1", f.seed.Calls)
	}
	if _, err := f.demo.Reset(ctx, demoTenant.ID, f.actor()); err != nil {
		t.Fatalf("reset: %v", err)
	}
	if f.seed.Calls != 2 {
		t.Fatalf("Seed calls after reset = %d, want 2", f.seed.Calls)
	}
	resetEvents := f.store.EventsOfType(domain.EvDemoTenantReset)
	if len(resetEvents) != 1 {
		t.Fatalf("expected 1 demo.tenant_reset event, got %d", len(resetEvents))
	}

	// Reset on a standard tenant is rejected.
	std, _, err := f.tenants.Create(ctx, domain.CreateTenantRequest{
		Name: "std-reset", OwnerEmail: "o@stdreset.com", Tier: "pool", Cloud: "aws", Publish: true,
	}, f.actor())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.demo.Reset(ctx, std.ID, f.actor()); err == nil {
		t.Fatal("expected reset on a standard tenant to be rejected")
	}
}

func TestDemoService_CloneCreatesIndependentSibling(t *testing.T) {
	f := newDemoFixture(t)
	ctx := context.Background()
	source, _, err := f.demo.Create(ctx, domain.CreateDemoTenantRequest{
		Name: "demo-src", OwnerEmail: "o@src.com", Pack: "insurance-claims-payer",
	}, f.actor())
	if err != nil {
		t.Fatalf("create source: %v", err)
	}
	sibling, _, err := f.demo.Clone(ctx, source.ID, domain.CloneDemoTenantRequest{
		Name: "demo-sibling",
	}, f.actor())
	if err != nil {
		t.Fatalf("clone: %v", err)
	}
	if sibling.ID == source.ID {
		t.Fatal("clone returned the same tenant id as the source")
	}
	if sibling.DemoPack != source.DemoPack {
		t.Fatalf("sibling pack = %s, want %s", sibling.DemoPack, source.DemoPack)
	}
	if sibling.OwnerEmail != source.OwnerEmail {
		t.Fatalf("sibling did not default owner_email from source: got %s", sibling.OwnerEmail)
	}
	cloned := f.store.EventsOfType(domain.EvDemoTenantCloned)
	if len(cloned) != 1 {
		t.Fatalf("expected 1 demo.tenant_cloned event, got %d", len(cloned))
	}
}
