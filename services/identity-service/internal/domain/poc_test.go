package domain_test

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/datacern-ai/identity-service/internal/adapters/keycloak"
	"github.com/datacern-ai/identity-service/internal/adapters/terraform"
	"github.com/datacern-ai/identity-service/internal/domain"
	"github.com/datacern-ai/identity-service/internal/store/memory"
)

// fakeValueReader is a scriptable domain.ValueSummaryReader for POC progress
// tests -- Views is keyed by "tenantID|period"; a miss returns an error
// (simulating usage-service being unreachable) unless AllowMiss is set, in
// which case it returns the same "no data yet" honest-null shape
// fakeValueSummaryReader in the api package's fixture uses.
type fakeValueReader struct {
	Views     map[string]*domain.ValueSummaryView
	AllowMiss bool
	Err       error
}

func (f *fakeValueReader) Summary(_ context.Context, tenantID uuid.UUID, period string) (*domain.ValueSummaryView, error) {
	if f.Err != nil {
		return nil, f.Err
	}
	k := tenantID.String() + "|" + period
	if v, ok := f.Views[k]; ok {
		return v, nil
	}
	if f.AllowMiss {
		gap := "no data for " + period
		return &domain.ValueSummaryView{Period: period, MeterGap: &gap}, nil
	}
	return nil, domain.EInternal("unexpected query for period " + period)
}

// fakeExportStore is an in-memory domain.PocReportObjectStore for export
// tests -- avoids touching the filesystem.
type fakeExportStore struct {
	puts map[string][]byte
}

func newFakeExportStore() *fakeExportStore { return &fakeExportStore{puts: map[string][]byte{}} }

func (f *fakeExportStore) Put(_ context.Context, key string, data []byte, _ time.Duration) (string, time.Time, error) {
	f.puts[key] = data
	return "http://test.local/" + key, time.Now().Add(time.Hour), nil
}

// pocFixture wires a full TenantService+Engine+PocService over the memory
// store with fake infra adapters, mirroring demoFixture (demo_test.go).
type pocFixture struct {
	store   *memory.Store
	clock   *clockBox
	tenants *domain.TenantService
	poc     *domain.PocService
	value   *fakeValueReader
	exports *fakeExportStore
}

func newPocFixture(t *testing.T) *pocFixture {
	t.Helper()
	f := &pocFixture{store: memory.New(), clock: newClockBox(time.Now().UTC())}
	kc, tf, db, prober := keycloak.NewFake(), terraform.NewFake(), terraform.NewFakeDB(), &terraform.FakeProber{}
	deps := domain.StepDeps{Store: f.store, Keycloak: kc, Terraform: tf, DB: db, Prober: prober, Clock: f.clock.now}
	cfg := domain.DefaultEngineConfig()
	cfg.Backoff = func(int) time.Duration { return 0 }
	cfg.Clock = f.clock.now
	engine := domain.NewEngine(f.store, cfg, deps.ProvisionSteps, deps.DestroySteps, nil)
	f.tenants = &domain.TenantService{
		Store: f.store, Engine: engine, Graph: domain.DefaultModuleGraph(),
		Prober: prober, Clock: f.clock.now, Async: false,
	}
	f.value = &fakeValueReader{Views: map[string]*domain.ValueSummaryView{}, AllowMiss: true}
	f.exports = newFakeExportStore()
	commercial := &domain.CommercialService{Store: f.store, Clock: f.clock.now}
	f.poc = &domain.PocService{Store: f.store, Tenants: f.tenants, Commercial: commercial, Value: f.value, Exports: f.exports, Clock: f.clock.now}

	cellID, _ := uuid.NewV7()
	if err := f.store.CreateCell(context.Background(), &domain.Cell{
		ID: cellID, Name: "cell-aws-1", Cloud: "aws", Region: "us-east-1", Capacity: 10,
	}); err != nil {
		t.Fatalf("seed cell: %v", err)
	}
	// PocService.Create assigns PocTenantPlanKey (=internal-demo) for
	// entitlement defaults, mirroring demoFixture's own plan seed.
	if err := f.store.CreatePlan(context.Background(), &domain.Plan{
		Key: domain.PocTenantPlanKey, Name: "Internal Demo", Status: "active", Version: 1,
		CreatedAt: f.clock.now(), UpdatedAt: f.clock.now(),
	}, nil); err != nil {
		t.Fatalf("seed poc plan: %v", err)
	}
	return f
}

func (f *pocFixture) actor() domain.Actor { return domain.Actor{Type: "user", ID: "se-1"} }

func sampleCriteria() []domain.SuccessCriterion {
	return []domain.SuccessCriterion{
		{Key: "volume", Description: "500 decisions processed", MetricRef: domain.MetricDecisionsTotal, Target: 500, Direction: domain.DirectionGTE},
		{Key: "cost", Description: "cost per decision under $0.40", MetricRef: domain.MetricManual, Target: 0.40, Direction: domain.DirectionLTE},
	}
}

func createPoc(t *testing.T, f *pocFixture, windowDays int) *domain.Tenant {
	t.Helper()
	tenant, _, err := f.poc.Create(context.Background(), domain.CreatePocTenantRequest{
		Name: "acme-poc", DisplayName: "Acme POC", OwnerEmail: "sponsor@acme.example",
		WindowDays: windowDays, Sponsor: "Jane Sponsor", SuccessCriteria: sampleCriteria(),
	}, f.actor())
	if err != nil {
		t.Fatalf("create poc tenant: %v", err)
	}
	return tenant
}

// --- SuccessCriterion.Validate --------------------------------------------

func TestSuccessCriterion_Validate(t *testing.T) {
	base := domain.SuccessCriterion{Key: "k", Description: "d", MetricRef: domain.MetricDecisionsTotal, Target: 1, Direction: domain.DirectionGTE}
	if err := base.Validate(); err != nil {
		t.Fatalf("expected valid, got %v", err)
	}
	cases := []struct {
		name string
		mut  func(domain.SuccessCriterion) domain.SuccessCriterion
	}{
		{"empty key", func(c domain.SuccessCriterion) domain.SuccessCriterion { c.Key = ""; return c }},
		{"empty description", func(c domain.SuccessCriterion) domain.SuccessCriterion { c.Description = ""; return c }},
		{"bad metric_ref", func(c domain.SuccessCriterion) domain.SuccessCriterion { c.MetricRef = "bogus"; return c }},
		{"bad direction", func(c domain.SuccessCriterion) domain.SuccessCriterion { c.Direction = "sideways"; return c }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if err := tc.mut(base).Validate(); err == nil {
				t.Fatal("expected validation error")
			}
		})
	}
}

// --- Create ---------------------------------------------------------------

// TestPocService_Create_SetsProfileAndTrialState: DSP-FR-020 verbatim --
// profile=poc, commercial_state=trial, trial_ends_at = window end, criteria
// stored, all set at creation without going through TrialService.Start's
// guarded path (which has no none->trial edge for poc, by design).
func TestPocService_Create_SetsProfileAndTrialState(t *testing.T) {
	f := newPocFixture(t)
	before := f.clock.now()
	tenant := createPoc(t, f, 30)

	if tenant.Profile != domain.ProfilePOC {
		t.Fatalf("profile = %q, want poc", tenant.Profile)
	}
	if tenant.CommercialState != domain.CommercialTrial {
		t.Fatalf("commercial_state = %q, want trial", tenant.CommercialState)
	}
	if tenant.TrialStartedAt == nil || tenant.TrialEndsAt == nil {
		t.Fatal("expected trial_started_at/trial_ends_at to be set")
	}
	wantEnd := before.Add(30 * 24 * time.Hour)
	if tenant.TrialEndsAt.Sub(wantEnd).Abs() > time.Second {
		t.Fatalf("trial_ends_at = %v, want ~%v", tenant.TrialEndsAt, wantEnd)
	}
	if tenant.Status != domain.TenantActive {
		t.Fatalf("status = %q, want active (Publish should have run the saga)", tenant.Status)
	}

	criteria, err := f.poc.GetCriteria(context.Background(), tenant.ID)
	if err != nil {
		t.Fatalf("GetCriteria: %v", err)
	}
	if len(criteria) != 2 {
		t.Fatalf("len(criteria) = %d, want 2", len(criteria))
	}

	events, err := f.store.ListTrialEvents(context.Background(), tenant.ID)
	if err != nil {
		t.Fatalf("ListTrialEvents: %v", err)
	}
	if len(events) != 1 || events[0].EventType != domain.TrialEventStarted {
		t.Fatalf("expected one trial_events(started) row, got %+v", events)
	}
}

// TestPocService_Create_DefaultsWindowDays: an omitted window_days falls
// back to the roadmap's 90-day playbook default, not zero/error.
func TestPocService_Create_DefaultsWindowDays(t *testing.T) {
	f := newPocFixture(t)
	before := f.clock.now()
	tenant := createPoc(t, f, 0)
	want := before.Add(domain.DefaultPocWindowDays * 24 * time.Hour)
	if tenant.TrialEndsAt.Sub(want).Abs() > time.Second {
		t.Fatalf("trial_ends_at = %v, want ~%v (default %d days)", tenant.TrialEndsAt, want, domain.DefaultPocWindowDays)
	}
}

func TestPocService_Create_RejectsMissingSponsorOrCriteria(t *testing.T) {
	f := newPocFixture(t)
	_, _, err := f.poc.Create(context.Background(), domain.CreatePocTenantRequest{
		Name: "no-sponsor", WindowDays: 30, SuccessCriteria: sampleCriteria(),
	}, f.actor())
	if err == nil {
		t.Fatal("expected error for missing sponsor")
	}
	_, _, err = f.poc.Create(context.Background(), domain.CreatePocTenantRequest{
		Name: "no-criteria", WindowDays: 30, Sponsor: "Jane",
	}, f.actor())
	if err == nil {
		t.Fatal("expected error for zero criteria")
	}
	tooMany := append(sampleCriteria(), domain.SuccessCriterion{
		Key: "extra", Description: "d", MetricRef: domain.MetricManual, Target: 1, Direction: domain.DirectionGTE,
	}, domain.SuccessCriterion{
		Key: "extra2", Description: "d", MetricRef: domain.MetricManual, Target: 1, Direction: domain.DirectionGTE,
	})
	_, _, err = f.poc.Create(context.Background(), domain.CreatePocTenantRequest{
		Name: "too-many", WindowDays: 30, Sponsor: "Jane", SuccessCriteria: tooMany,
	}, f.actor())
	if err == nil {
		t.Fatal("expected error for >3 criteria")
	}
	dup := []domain.SuccessCriterion{
		{Key: "a", Description: "d", MetricRef: domain.MetricManual, Target: 1, Direction: domain.DirectionGTE},
		{Key: "a", Description: "d2", MetricRef: domain.MetricManual, Target: 2, Direction: domain.DirectionGTE},
	}
	_, _, err = f.poc.Create(context.Background(), domain.CreatePocTenantRequest{
		Name: "dup-key", WindowDays: 30, Sponsor: "Jane", SuccessCriteria: dup,
	}, f.actor())
	if err == nil {
		t.Fatal("expected error for duplicate criterion key")
	}
}

// --- SetCriteria / UpdateManualValue ---------------------------------------

func TestPocService_SetCriteria_RejectsNonPocProfile(t *testing.T) {
	f := newPocFixture(t)
	standard, _, err := f.tenants.Create(context.Background(), domain.CreateTenantRequest{
		Name: "standard-1", OwnerEmail: "a@b.com", Tier: "pool", Cloud: "aws",
	}, f.actor())
	if err != nil {
		t.Fatalf("create standard tenant: %v", err)
	}
	err = f.poc.SetCriteria(context.Background(), standard.ID, sampleCriteria(), f.actor())
	if err == nil {
		t.Fatal("expected error setting criteria on a non-poc tenant")
	}
}

func TestPocService_UpdateManualValue_OnlyManualMetric(t *testing.T) {
	f := newPocFixture(t)
	tenant := createPoc(t, f, 30)

	// "cost" is manual -- update should succeed and be readable back.
	if err := f.poc.UpdateManualValue(context.Background(), tenant.ID, "cost", 0.35, f.actor()); err != nil {
		t.Fatalf("UpdateManualValue(manual): %v", err)
	}
	criteria, _ := f.poc.GetCriteria(context.Background(), tenant.ID)
	var found bool
	for _, c := range criteria {
		if c.Key == "cost" {
			found = true
			if c.ManualValue == nil || *c.ManualValue != 0.35 {
				t.Fatalf("manual_value = %v, want 0.35", c.ManualValue)
			}
		}
	}
	if !found {
		t.Fatal("criterion 'cost' not found")
	}

	// "volume" is metric_ref=decisions_total -- must be rejected.
	if err := f.poc.UpdateManualValue(context.Background(), tenant.ID, "volume", 999, f.actor()); err == nil {
		t.Fatal("expected error updating a non-manual criterion by hand")
	}

	// Unknown key -> not found.
	if err := f.poc.UpdateManualValue(context.Background(), tenant.ID, "nope", 1, f.actor()); err == nil {
		t.Fatal("expected not-found error for unknown key")
	}
}

// --- Progress: met / missed / inconclusive ---------------------------------

// TestPocService_Progress_MetMissedInconclusive is the core honesty
// assertion (ROI-NFR-004 spirit applied to POC progress): a criterion whose
// metric_ref resolves to real data is scored met/missed; a criterion with
// no data anywhere (manual, never reported) is "inconclusive" with a nil
// actual_value -- never a fabricated 0 or a fabricated "missed".
func TestPocService_Progress_MetMissedInconclusive(t *testing.T) {
	f := newPocFixture(t)
	tenant := createPoc(t, f, 30)
	period := f.clock.now().Format("2006-01")
	decisions := int64(600) // >= target 500 -> met
	f.value.Views[tenant.ID.String()+"|"+period] = &domain.ValueSummaryView{
		Period: period, DecisionsTotal: &decisions,
	}
	// "cost" stays manual/unreported -> inconclusive.

	progress, err := f.poc.Progress(context.Background(), tenant.ID)
	if err != nil {
		t.Fatalf("Progress: %v", err)
	}
	if len(progress.Criteria) != 2 {
		t.Fatalf("len(criteria) = %d, want 2", len(progress.Criteria))
	}
	byKey := map[string]domain.CriterionProgress{}
	for _, c := range progress.Criteria {
		byKey[c.Key] = c
	}
	if got := byKey["volume"].Outcome; got != domain.OutcomeMet {
		t.Fatalf("volume outcome = %q, want met (actual=%v)", got, byKey["volume"].ActualValue)
	}
	if byKey["volume"].ActualValue == nil || *byKey["volume"].ActualValue != 600 {
		t.Fatalf("volume actual_value = %v, want 600", byKey["volume"].ActualValue)
	}
	if got := byKey["cost"].Outcome; got != domain.OutcomeInconclusive {
		t.Fatalf("cost outcome = %q, want inconclusive", got)
	}
	if byKey["cost"].ActualValue != nil {
		t.Fatalf("cost actual_value = %v, want nil (never reported)", byKey["cost"].ActualValue)
	}

	// Now report the manual value below target ($0.40) -> met (lte).
	if err := f.poc.UpdateManualValue(context.Background(), tenant.ID, "cost", 0.30, f.actor()); err != nil {
		t.Fatalf("UpdateManualValue: %v", err)
	}
	progress, err = f.poc.Progress(context.Background(), tenant.ID)
	if err != nil {
		t.Fatalf("Progress (2nd): %v", err)
	}
	for _, c := range progress.Criteria {
		if c.Key == "cost" && c.Outcome != domain.OutcomeMet {
			t.Fatalf("cost outcome after report = %q, want met", c.Outcome)
		}
	}

	// Above target -> missed.
	if err := f.poc.UpdateManualValue(context.Background(), tenant.ID, "cost", 0.55, f.actor()); err != nil {
		t.Fatalf("UpdateManualValue: %v", err)
	}
	progress, err = f.poc.Progress(context.Background(), tenant.ID)
	if err != nil {
		t.Fatalf("Progress (3rd): %v", err)
	}
	for _, c := range progress.Criteria {
		if c.Key == "cost" && c.Outcome != domain.OutcomeMissed {
			t.Fatalf("cost outcome above target = %q, want missed", c.Outcome)
		}
	}
}

// TestPocService_Progress_NilValueReaderIsHonestNotFabricated: a deployment
// with no ValueSummaryReader configured must not silently return zeros --
// every BRD69-backed criterion is inconclusive, the manual one still reads
// from its own stored value.
func TestPocService_Progress_NilValueReaderIsHonestNotFabricated(t *testing.T) {
	f := newPocFixture(t)
	tenant := createPoc(t, f, 30)
	f.poc.Value = nil

	progress, err := f.poc.Progress(context.Background(), tenant.ID)
	if err != nil {
		t.Fatalf("Progress: %v", err)
	}
	for _, c := range progress.Criteria {
		if c.MetricRef == domain.MetricManual {
			continue
		}
		if c.ActualValue != nil {
			t.Fatalf("criterion %q actual_value = %v, want nil with no Value reader configured", c.Key, c.ActualValue)
		}
		if c.Outcome != domain.OutcomeInconclusive {
			t.Fatalf("criterion %q outcome = %q, want inconclusive", c.Key, c.Outcome)
		}
	}
}

// TestPocService_Progress_PartialMonthGapMakesAggregateNil: a POC window
// spanning two months where only one month has data must NOT silently sum
// just the available month and present it as the total -- that would be
// exactly the "invented number" the honesty convention forbids.
func TestPocService_Progress_PartialMonthGapMakesAggregateNil(t *testing.T) {
	f := newPocFixture(t)
	tenant := createPoc(t, f, 45) // spans >1 calendar month from "now"
	f.clock.advance(40 * 24 * time.Hour)

	// Only report data for the FIRST month in the window; the second (most
	// recent) month is left as a genuine gap (AllowMiss=true fixture default
	// returns a MeterGap-carrying view with DecisionsTotal=nil for it).
	startPeriod := tenant.TrialStartedAt.Format("2006-01")
	decisions := int64(1000)
	f.value.Views[tenant.ID.String()+"|"+startPeriod] = &domain.ValueSummaryView{
		Period: startPeriod, DecisionsTotal: &decisions,
	}

	progress, err := f.poc.Progress(context.Background(), tenant.ID)
	if err != nil {
		t.Fatalf("Progress: %v", err)
	}
	for _, c := range progress.Criteria {
		if c.Key == "volume" {
			if c.ActualValue != nil {
				t.Fatalf("volume actual_value = %v, want nil (one month in the window has no data)", c.ActualValue)
			}
			if c.Outcome != domain.OutcomeInconclusive {
				t.Fatalf("volume outcome = %q, want inconclusive", c.Outcome)
			}
		}
	}
}

// --- pocMonthsInWindow (pure function, exercised indirectly above; this
// test locks down the boundary behavior directly via Progress on a
// same-day window). ---

func TestPocService_Progress_RejectsNonPocProfile(t *testing.T) {
	f := newPocFixture(t)
	standard, _, err := f.tenants.Create(context.Background(), domain.CreateTenantRequest{
		Name: "standard-2", OwnerEmail: "a@b.com", Tier: "pool", Cloud: "aws",
	}, f.actor())
	if err != nil {
		t.Fatalf("create standard tenant: %v", err)
	}
	if _, err := f.poc.Progress(context.Background(), standard.ID); err == nil {
		t.Fatal("expected error computing progress for a non-poc tenant")
	}
}

// --- ExportReport -----------------------------------------------------------

// TestPocService_ExportReport_ChecksumAndVersioning: the poc-report.v1
// document is checksummed over itself with the checksum field zeroed
// (design §2.9), stored, and re-exporting bumps the version without
// touching the prior row -- the exact discipline BRD 69's value-report.v1
// export already proves out.
func TestPocService_ExportReport_ChecksumAndVersioning(t *testing.T) {
	f := newPocFixture(t)
	tenant := createPoc(t, f, 30)
	period := f.clock.now().Format("2006-01")
	decisions := int64(600)
	f.value.Views[tenant.ID.String()+"|"+period] = &domain.ValueSummaryView{
		Period: period, DecisionsTotal: &decisions, Raw: map[string]any{"period": period, "decisions": map[string]any{"total": 600}},
	}

	export, err := f.poc.ExportReport(context.Background(), tenant.ID, f.actor())
	if err != nil {
		t.Fatalf("ExportReport: %v", err)
	}
	if export.Version != 1 {
		t.Fatalf("version = %d, want 1", export.Version)
	}
	stored, ok := f.exports.puts[export.JSONKey]
	if !ok {
		t.Fatalf("no artifact stored at key %q", export.JSONKey)
	}
	var doc struct {
		Schema         string `json:"schema"`
		ChecksumSHA256 string `json:"checksum_sha256"`
	}
	if err := json.Unmarshal(stored, &doc); err != nil {
		t.Fatalf("decode stored artifact: %v", err)
	}
	if doc.Schema != domain.PocReportSchema {
		t.Fatalf("schema = %q, want %q", doc.Schema, domain.PocReportSchema)
	}
	if doc.ChecksumSHA256 != export.JSONSHA256 {
		t.Fatalf("checksum in document (%q) != stored row's JSONSHA256 (%q)", doc.ChecksumSHA256, export.JSONSHA256)
	}
	if doc.ChecksumSHA256 == "" {
		t.Fatal("checksum_sha256 is empty")
	}

	export2, err := f.poc.ExportReport(context.Background(), tenant.ID, f.actor())
	if err != nil {
		t.Fatalf("ExportReport (2nd): %v", err)
	}
	if export2.Version != 2 {
		t.Fatalf("2nd export version = %d, want 2", export2.Version)
	}
	if _, ok := f.exports.puts[export.JSONKey]; !ok {
		t.Fatal("first export's artifact was removed/overwritten by the second export")
	}

	exports, err := f.poc.ListExports(context.Background(), tenant.ID)
	if err != nil {
		t.Fatalf("ListExports: %v", err)
	}
	if len(exports) != 2 {
		t.Fatalf("len(exports) = %d, want 2", len(exports))
	}
	if exports[0].Version != 2 {
		t.Fatalf("ListExports[0].Version = %d, want 2 (newest first)", exports[0].Version)
	}
}

func TestPocService_ExportReport_FailsLoudWithoutExportsAdapter(t *testing.T) {
	f := newPocFixture(t)
	tenant := createPoc(t, f, 30)
	f.poc.Exports = nil
	if _, err := f.poc.ExportReport(context.Background(), tenant.ID, f.actor()); err == nil {
		t.Fatal("expected error exporting with no Exports adapter configured")
	}
}

func TestPocService_ExportReport_CarriesValueSummaryVerbatim(t *testing.T) {
	f := newPocFixture(t)
	tenant := createPoc(t, f, 30)
	period := f.clock.now().Format("2006-01")
	decisions := int64(42)
	raw := map[string]any{"period": period, "custom_field_from_usage_service": "should survive untouched"}
	f.value.Views[tenant.ID.String()+"|"+period] = &domain.ValueSummaryView{
		Period: period, DecisionsTotal: &decisions, Raw: raw,
	}
	export, err := f.poc.ExportReport(context.Background(), tenant.ID, f.actor())
	if err != nil {
		t.Fatalf("ExportReport: %v", err)
	}
	stored := f.exports.puts[export.JSONKey]
	var doc struct {
		ValueSummary map[string]any `json:"value_summary"`
	}
	if err := json.Unmarshal(stored, &doc); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if doc.ValueSummary["custom_field_from_usage_service"] != "should survive untouched" {
		t.Fatalf("value_summary did not carry the raw usage-service field verbatim: %+v", doc.ValueSummary)
	}
}
