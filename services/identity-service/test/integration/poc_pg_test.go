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

// fakePocValueReader is a scriptable domain.ValueSummaryReader, duplicated
// here (rather than imported) because internal/domain's own test fakes live
// in an internal test package the integration build can't import -- same
// convention fakeDemoBundleLoader/fakeDemoSeedRunner already follow in
// demo_test.go.
type fakePocValueReader struct {
	views map[string]*domain.ValueSummaryView
}

func (f *fakePocValueReader) Summary(_ context.Context, tenantID uuid.UUID, period string) (*domain.ValueSummaryView, error) {
	if v, ok := f.views[tenantID.String()+"|"+period]; ok {
		return v, nil
	}
	gap := "no data for " + period
	return &domain.ValueSummaryView{Period: period, MeterGap: &gap}, nil
}

type fakePocExportStore struct {
	puts map[string][]byte
}

func (f *fakePocExportStore) Put(_ context.Context, key string, data []byte, _ time.Duration) (string, time.Time, error) {
	if f.puts == nil {
		f.puts = map[string][]byte{}
	}
	f.puts[key] = data
	return "http://test.local/" + key, time.Now().Add(time.Hour), nil
}

// TestPocSuccessCriteriaRoundTripOnPostgres: BRD 70 slice 3's end-to-end
// happy path against a REAL Postgres -- profile=poc creation (Tenant.Profile
// + commercial_state=trial round-trips through the new tenants columns
// exactly like TestDemoTenantSagaOnPostgres already proves for profile=demo
// + ttl_days/demo_pack), success criteria persisted to poc_success_criteria,
// a manual value update, live progress computed from a fake value reader,
// and a poc-report.v1 export round-tripped through poc_exports.
func TestPocSuccessCriteriaRoundTripOnPostgres(t *testing.T) {
	requirePG(t)
	ctx := context.Background()
	store := pgstore.New(appPool)

	cellID, _ := uuid.NewV7()
	if err := store.CreateCell(ctx, &domain.Cell{ID: cellID, Name: freshName("cell"), Cloud: "aws", Region: "us-east-1", Capacity: 100}); err != nil {
		t.Fatal(err)
	}
	// domain.PocTenantPlanKey ("internal-demo") is NOT seeded here -- unlike
	// internal/domain/demo_test.go's in-memory-store unit tests (which start
	// from a genuinely empty store and must create it), this tier runs
	// against a REAL, already-migrated Postgres database: migration
	// 0010_commercial_plans.up.sql seeds this exact plan row before any test
	// runs. Creating it again collided with VALIDATION_FAILED "plan key
	// already exists" (confirmed live in CI, since Docker/Postgres are
	// unavailable in the dev sandbox this test was authored in).

	// PocService.Create unconditionally calls Tenants.Publish (poc_service.go:
	// "publish explicitly below, after criteria are recorded"), which drives
	// Engine.Provision through TenantService.runWorkflow -- a nil Engine
	// panics (nil pointer dereference) the moment Publish runs, since Async
	// defaults false and runWorkflow calls the workflow fn inline rather than
	// swallowing it in a goroutine. Wire the same fake-backed Engine
	// TestAPITenantIsolationOnPostgres (api_pg_test.go) already uses so the
	// real saga actually runs against fake Keycloak/Terraform/DB/Prober
	// adapters -- confirmed live in CI (Docker/Postgres are unavailable in
	// the dev sandbox this test was authored in, so the nil Engine was never
	// exercised until now).
	deps := domain.StepDeps{Store: store, Keycloak: keycloak.NewFake(), Terraform: terraform.NewFake(), DB: terraform.NewFakeDB(), Prober: &terraform.FakeProber{}}
	cfg := domain.DefaultEngineConfig()
	cfg.Backoff = func(int) time.Duration { return 0 }
	engine := domain.NewEngine(store, cfg, deps.ProvisionSteps, deps.DestroySteps, nil)
	tenants := &domain.TenantService{Store: store, Engine: engine, Graph: domain.DefaultModuleGraph(), Prober: deps.Prober, Clock: time.Now}
	commercial := &domain.CommercialService{Store: store, Clock: time.Now}
	valueReader := &fakePocValueReader{views: map[string]*domain.ValueSummaryView{}}
	exports := &fakePocExportStore{}
	poc := &domain.PocService{Store: store, Tenants: tenants, Commercial: commercial, Value: valueReader, Exports: exports, Clock: time.Now}

	tenant, _, err := poc.Create(ctx, domain.CreatePocTenantRequest{
		Name: freshName("poc"), OwnerEmail: "sponsor@example.com",
		WindowDays: 30, Sponsor: "Jane Sponsor",
		SuccessCriteria: []domain.SuccessCriterion{
			{Key: "volume", Description: "500 decisions", MetricRef: domain.MetricDecisionsTotal, Target: 500, Direction: domain.DirectionGTE},
			{Key: "cost", Description: "cost under target", MetricRef: domain.MetricManual, Target: 0.40, Direction: domain.DirectionLTE},
		},
	}, domain.Actor{Type: "user", ID: "se-1"})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if tenant.Profile != domain.ProfilePOC {
		t.Fatalf("profile = %s, want poc (did not round-trip through postgres)", tenant.Profile)
	}
	if tenant.CommercialState != domain.CommercialTrial || tenant.TrialEndsAt == nil {
		t.Fatalf("commercial_state/trial_ends_at did not round-trip: state=%s ends=%v", tenant.CommercialState, tenant.TrialEndsAt)
	}

	criteria, err := store.GetPocSuccessCriteria(ctx, tenant.ID)
	if err != nil || len(criteria) != 2 {
		t.Fatalf("GetPocSuccessCriteria: %v %+v", err, criteria)
	}

	if err := poc.UpdateManualValue(ctx, tenant.ID, "cost", 0.30, domain.Actor{Type: "user", ID: "sponsor"}); err != nil {
		t.Fatalf("UpdateManualValue: %v", err)
	}

	period := time.Now().UTC().Format("2006-01")
	decisions := int64(600)
	valueReader.views[tenant.ID.String()+"|"+period] = &domain.ValueSummaryView{
		Period: period, DecisionsTotal: &decisions, Raw: map[string]any{"period": period},
	}

	progress, err := poc.Progress(ctx, tenant.ID)
	if err != nil {
		t.Fatalf("Progress: %v", err)
	}
	for _, c := range progress.Criteria {
		if c.Outcome != domain.OutcomeMet {
			t.Fatalf("criterion %s outcome = %s, want met (actual=%v)", c.Key, c.Outcome, c.ActualValue)
		}
	}

	export, err := poc.ExportReport(ctx, tenant.ID, domain.Actor{Type: "user", ID: "se-1"})
	if err != nil {
		t.Fatalf("ExportReport: %v", err)
	}
	if export.Version != 1 {
		t.Fatalf("export version = %d, want 1", export.Version)
	}
	exportsList, err := store.ListPocExports(ctx, tenant.ID)
	if err != nil || len(exportsList) != 1 {
		t.Fatalf("ListPocExports: %v %+v", err, exportsList)
	}
}

// TestPocStoreRLSIsolation: a session scoped to tenant A must see zero
// poc_success_criteria/poc_exports rows belonging to tenant B, mirroring
// TestTrialEventsRLSIsolation's exact proof shape (store-level read +
// raw-SQL session-scoped read).
func TestPocStoreRLSIsolation(t *testing.T) {
	requirePG(t)
	ctx := context.Background()
	store := pgstore.New(appPool)
	a := newTenantRow(t, store, domain.TenantActive)
	b := newTenantRow(t, store, domain.TenantActive)

	if err := store.SetPocSuccessCriteria(ctx, b.ID, []domain.SuccessCriterion{
		{Key: "k", Description: "d", MetricRef: domain.MetricManual, Target: 1, Direction: domain.DirectionGTE},
	}); err != nil {
		t.Fatalf("SetPocSuccessCriteria(b): %v", err)
	}
	if _, err := store.CreatePocExport(ctx, b.ID, domain.PocExport{
		JSONKey: "poc-reports/" + b.ID.String() + "/1/report.json", JSONSHA256: "deadbeef", GeneratedBy: "user:se-1",
	}); err != nil {
		t.Fatalf("CreatePocExport(b): %v", err)
	}

	aCriteria, err := store.GetPocSuccessCriteria(ctx, a.ID)
	if err != nil || len(aCriteria) != 0 {
		t.Fatalf("tenant A sees tenant B's poc_success_criteria through RLS: %v %+v", err, aCriteria)
	}
	aExports, err := store.ListPocExports(ctx, a.ID)
	if err != nil || len(aExports) != 0 {
		t.Fatalf("tenant A sees tenant B's poc_exports through RLS: %v %+v", err, aExports)
	}

	bCriteria, err := store.GetPocSuccessCriteria(ctx, b.ID)
	if err != nil || len(bCriteria) != 1 {
		t.Fatalf("tenant B own-tenant poc_success_criteria read failed: %v %+v", err, bCriteria)
	}

	// Raw SQL proof: a session scoped to tenant A sees zero rows in either
	// table even though tenant B's rows exist.
	tx, err := appPool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, "SELECT set_config('app.tenant_id', $1, true)", a.ID.String()); err != nil {
		t.Fatal(err)
	}
	var nCriteria, nExports int
	if err := tx.QueryRow(ctx, "SELECT count(*) FROM poc_success_criteria").Scan(&nCriteria); err != nil {
		t.Fatal(err)
	}
	if err := tx.QueryRow(ctx, "SELECT count(*) FROM poc_exports").Scan(&nExports); err != nil {
		t.Fatal(err)
	}
	if nCriteria != 0 {
		t.Errorf("raw SQL under tenant A sees %d poc_success_criteria rows, want 0", nCriteria)
	}
	if nExports != 0 {
		t.Errorf("raw SQL under tenant A sees %d poc_exports rows, want 0", nExports)
	}
}
