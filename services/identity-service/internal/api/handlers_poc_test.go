package api_test

import (
	"net/http"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/datacern-ai/identity-service/internal/domain"
)

func mustParseUUID(t *testing.T, s string) uuid.UUID {
	t.Helper()
	id, err := uuid.Parse(s)
	if err != nil {
		t.Fatalf("parse uuid %q: %v", s, err)
	}
	return id
}

// createPocTenantHTTP is the shared helper: POST /poc-tenants as super-admin
// and return the created tenant's response body (BRD 70 slice 3, DSP-FR-020).
func createPocTenantHTTP(t *testing.T, f *fixture, name string) map[string]any {
	t.Helper()
	r := f.do(http.MethodPost, "/api/v1/poc-tenants", f.superToken(), map[string]any{
		"name": name, "owner_email": "sponsor@" + name + ".example",
		"window_days": 30, "sponsor": "Jane Sponsor",
		"success_criteria": []map[string]any{
			{"key": "volume", "description": "500 decisions", "metric_ref": "decisions_total", "target": 500, "direction": "gte"},
			{"key": "cost", "description": "cost per decision under $0.40", "metric_ref": "manual", "target": 0.40, "direction": "lte"},
		},
	})
	if r.status != http.StatusAccepted {
		t.Fatalf("create poc tenant: %d %s", r.status, string(r.raw))
	}
	tenant, ok := r.body["tenant"].(map[string]any)
	if !ok {
		t.Fatalf("no tenant in response: %s", string(r.raw))
	}
	return tenant
}

// TestPocTenants_CreateAndReadCriteria exercises the full HTTP surface for
// creation + criteria read (DSP-FR-020): POST /poc-tenants -> active,
// profile=poc, commercial_state=trial; GET .../poc/criteria reads them back
// as the tenant's own admin.
func TestPocTenants_CreateAndReadCriteria(t *testing.T) {
	f := newFixture(t)
	tenant := createPocTenantHTTP(t, f, "acme-poc-http")

	if tenant["profile"] != "poc" {
		t.Fatalf("profile = %v, want poc", tenant["profile"])
	}
	if tenant["commercial_state"] != "trial" {
		t.Fatalf("commercial_state = %v, want trial", tenant["commercial_state"])
	}
	if tenant["trial_ends_at"] == nil {
		t.Fatal("trial_ends_at is nil, want set")
	}
	if tenant["status"] != "active" {
		t.Fatalf("status = %v, want active", tenant["status"])
	}
	tenantID := tenant["id"].(string)

	own := f.do(http.MethodGet, "/api/v1/tenants/"+tenantID+"/poc/criteria", f.adminToken(mustParseUUID(t, tenantID)), nil)
	if own.status != http.StatusOK {
		t.Fatalf("get criteria: %d %s", own.status, string(own.raw))
	}
	data, _ := own.body["data"].([]any)
	if len(data) != 2 {
		t.Fatalf("len(criteria) = %d, want 2: %s", len(data), string(own.raw))
	}
}

// TestPocTenants_CreateRequiresSuperAdmin: POST /poc-tenants is
// operator/partner-scoped exactly like /demo-tenants (BRD 70 §In-scope).
func TestPocTenants_CreateRequiresSuperAdmin(t *testing.T) {
	f := newFixture(t)
	other := f.activeTenant("other-tenant-poc")
	r := f.do(http.MethodPost, "/api/v1/poc-tenants", f.adminToken(other.ID), map[string]any{
		"name": "should-fail-poc", "owner_email": "x@example.com",
		"window_days": 30, "sponsor": "Jane",
		"success_criteria": []map[string]any{
			{"key": "k", "description": "d", "metric_ref": "manual", "target": 1, "direction": "gte"},
		},
	})
	if r.status == http.StatusAccepted {
		t.Fatal("expected non-superadmin POST /poc-tenants to be rejected")
	}
}

// TestPocTenants_CrossTenantReadIs404: mirrors
// TestGetTenantEntitlements_Authz's cross-tenant-404 + audit-event pattern.
func TestPocTenants_CrossTenantReadIs404(t *testing.T) {
	f := newFixture(t)
	tenant := createPocTenantHTTP(t, f, "acme-poc-cross")
	other := f.activeTenant("other-poc-reader")

	cross := f.do(http.MethodGet, "/api/v1/tenants/"+tenant["id"].(string)+"/poc/criteria", f.adminToken(other.ID), nil)
	if cross.status != http.StatusNotFound {
		t.Fatalf("cross-tenant read: %d, want 404", cross.status)
	}
	found := false
	for _, ev := range f.store.EventsOfType("security.cross_tenant_denied") {
		if ev.TenantID == other.ID {
			found = true
		}
	}
	if !found {
		t.Error("expected a security.cross_tenant_denied audit event for the cross-tenant poc/criteria read")
	}

	asSuper := f.do(http.MethodGet, "/api/v1/tenants/"+tenant["id"].(string)+"/poc/criteria", f.superToken(), nil)
	if asSuper.status != http.StatusOK {
		t.Fatalf("super-admin cross-tenant read: %d %s", asSuper.status, string(asSuper.raw))
	}
}

// TestPocTenants_ManualValueUpdateAndProgress: PATCH .../manual-value updates
// the sponsor-reported figure (DSP-FR-021, audited); GET .../poc/progress
// reflects real (fake-sourced) usage-service data for the BRD69-backed
// criterion and the manual value for the other -- never a fabricated number.
func TestPocTenants_ManualValueUpdateAndProgress(t *testing.T) {
	f := newFixture(t)
	tenant := createPocTenantHTTP(t, f, "acme-poc-progress")
	tenantID := tenant["id"].(string)
	tid := mustParseUUID(t, tenantID)

	// No usage-service data recorded yet -> both criteria inconclusive.
	progress := f.do(http.MethodGet, "/api/v1/tenants/"+tenantID+"/poc/progress", f.adminToken(tid), nil)
	if progress.status != http.StatusOK {
		t.Fatalf("get progress: %d %s", progress.status, string(progress.raw))
	}
	criteria, _ := progress.body["criteria"].([]any)
	if len(criteria) != 2 {
		t.Fatalf("len(criteria) = %d, want 2", len(criteria))
	}
	for _, c := range criteria {
		cm := c.(map[string]any)
		if cm["outcome"] != "inconclusive" {
			t.Fatalf("criterion %v outcome = %v, want inconclusive (no data yet)", cm["key"], cm["outcome"])
		}
		if cm["actual_value"] != nil {
			t.Fatalf("criterion %v actual_value = %v, want null", cm["key"], cm["actual_value"])
		}
	}

	// Report the manual criterion under target -> met.
	patch := f.do(http.MethodPatch, "/api/v1/tenants/"+tenantID+"/poc/criteria/cost/manual-value",
		f.adminToken(tid), map[string]any{"value": 0.25})
	if patch.status != http.StatusOK {
		t.Fatalf("patch manual-value: %d %s", patch.status, string(patch.raw))
	}

	// Wire real-shaped data for the decisions_total criterion via the
	// fixture's fake usage-service reader, keyed by the current month.
	period := time.Now().UTC().Format("2006-01")
	decisions := int64(600)
	f.pocValue.Views[tenantID+"|"+period] = &domain.ValueSummaryView{Period: period, DecisionsTotal: &decisions}

	progress2 := f.do(http.MethodGet, "/api/v1/tenants/"+tenantID+"/poc/progress", f.adminToken(tid), nil)
	if progress2.status != http.StatusOK {
		t.Fatalf("get progress (2nd): %d %s", progress2.status, string(progress2.raw))
	}
	criteria2, _ := progress2.body["criteria"].([]any)
	byKey := map[string]map[string]any{}
	for _, c := range criteria2 {
		cm := c.(map[string]any)
		byKey[cm["key"].(string)] = cm
	}
	if byKey["cost"]["outcome"] != "met" {
		t.Fatalf("cost outcome = %v, want met", byKey["cost"]["outcome"])
	}
	if byKey["volume"]["outcome"] != "met" {
		t.Fatalf("volume outcome = %v, want met (600 >= 500)", byKey["volume"]["outcome"])
	}

	// Attempting to hand-update the BRD69-backed criterion is rejected.
	badPatch := f.do(http.MethodPatch, "/api/v1/tenants/"+tenantID+"/poc/criteria/volume/manual-value",
		f.adminToken(tid), map[string]any{"value": 999})
	if badPatch.status == http.StatusOK {
		t.Fatal("expected error hand-updating a non-manual criterion")
	}
}

// TestPocTenants_ExportReportChecksumAndDownload exercises DSP-FR-022 over
// real HTTP end to end: POST .../poc-reports generates a checksummed
// poc-report.v1 artifact, GET .../poc-reports lists it with a signed
// download URL, and downloading via the signed URL returns bytes whose
// SHA256 matches the API-reported checksum (the same "AC-4-style" assertion
// BRD 69's value-report.v1 export tests use).
func TestPocTenants_ExportReportChecksumAndDownload(t *testing.T) {
	f := newFixture(t)
	tenant := createPocTenantHTTP(t, f, "acme-poc-export")
	tenantID := tenant["id"].(string)
	tid := mustParseUUID(t, tenantID)

	exp := f.do(http.MethodPost, "/api/v1/tenants/"+tenantID+"/poc-reports", f.adminToken(tid), nil)
	if exp.status != http.StatusCreated {
		t.Fatalf("export report: %d %s", exp.status, string(exp.raw))
	}
	if exp.body["version"] != float64(1) {
		t.Fatalf("version = %v, want 1", exp.body["version"])
	}
	sha, _ := exp.body["json_sha256"].(string)
	if sha == "" {
		t.Fatal("json_sha256 is empty")
	}
	jsonURL, _ := exp.body["json_url"].(string)
	if jsonURL == "" {
		t.Fatal("json_url is empty")
	}

	list := f.do(http.MethodGet, "/api/v1/tenants/"+tenantID+"/poc-reports", f.adminToken(tid), nil)
	if list.status != http.StatusOK {
		t.Fatalf("list reports: %d %s", list.status, string(list.raw))
	}
	items, _ := list.body["data"].([]any)
	if len(items) != 1 {
		t.Fatalf("len(exports) = %d, want 1", len(items))
	}

	// Download via the signed URL (strip the http://test.local prefix and
	// hit the real router directly, same as the value-report-artifacts
	// pattern this mirrors).
	path := jsonURL[len("http://test.local"):]
	dl := f.do(http.MethodGet, path, "", nil)
	if dl.status != http.StatusOK {
		t.Fatalf("download artifact: %d %s", dl.status, string(dl.raw))
	}
	if dl.body["schema"] != "poc-report.v1" {
		t.Fatalf("downloaded schema = %v, want poc-report.v1", dl.body["schema"])
	}
	if dl.body["checksum_sha256"] != sha {
		t.Fatalf("downloaded checksum = %v, want %v (must match API-reported hash)", dl.body["checksum_sha256"], sha)
	}

	// Re-exporting bumps the version without discarding the first.
	exp2 := f.do(http.MethodPost, "/api/v1/tenants/"+tenantID+"/poc-reports", f.adminToken(tid), nil)
	if exp2.status != http.StatusCreated || exp2.body["version"] != float64(2) {
		t.Fatalf("2nd export: %d %v", exp2.status, exp2.body["version"])
	}
	list2 := f.do(http.MethodGet, "/api/v1/tenants/"+tenantID+"/poc-reports", f.adminToken(tid), nil)
	items2, _ := list2.body["data"].([]any)
	if len(items2) != 2 {
		t.Fatalf("len(exports) after 2nd export = %d, want 2", len(items2))
	}
}

// TestPocTenants_OperatorSetCriteria: PUT .../criteria (requireSuperAdmin)
// replaces the full set.
func TestPocTenants_OperatorSetCriteria(t *testing.T) {
	f := newFixture(t)
	tenant := createPocTenantHTTP(t, f, "acme-poc-set")
	tenantID := tenant["id"].(string)

	set := f.do(http.MethodPut, "/api/v1/poc-tenants/"+tenantID+"/criteria", f.superToken(), map[string]any{
		"success_criteria": []map[string]any{
			{"key": "adoption", "description": "20 active users", "metric_ref": "adoption_active_users", "target": 20, "direction": "gte"},
		},
	})
	if set.status != http.StatusOK {
		t.Fatalf("set criteria: %d %s", set.status, string(set.raw))
	}
	data, _ := set.body["data"].([]any)
	if len(data) != 1 {
		t.Fatalf("len(criteria) after replace = %d, want 1", len(data))
	}

	// Non-superadmin cannot replace the set.
	forbidden := f.do(http.MethodPut, "/api/v1/poc-tenants/"+tenantID+"/criteria", f.adminToken(mustParseUUID(t, tenantID)), map[string]any{
		"success_criteria": []map[string]any{
			{"key": "x", "description": "d", "metric_ref": "manual", "target": 1, "direction": "gte"},
		},
	})
	if forbidden.status == http.StatusOK {
		t.Fatal("expected non-superadmin PUT criteria to be rejected")
	}
}
