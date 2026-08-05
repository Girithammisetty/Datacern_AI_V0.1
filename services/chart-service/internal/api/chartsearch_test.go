package api

import (
	"net/http"
	"net/url"
	"testing"

	"github.com/google/uuid"

	"github.com/datacern-ai/chart-service/internal/authz"
)

// searchIDs runs GET /charts with the given query and returns the hit ids plus
// the raw response.
func searchIDs(t *testing.T, h *harness, tenant uuid.UUID, q url.Values) ([]string, resp) {
	t.Helper()
	r := h.do(t, "GET", "/api/v1/charts?"+q.Encode(), h.token(t, tenant), nil, nil)
	var ids []string
	list, _ := r.body["data"].([]any)
	for _, item := range list {
		m, _ := item.(map[string]any)
		id, _ := m["id"].(string)
		ids = append(ids, id)
	}
	return ids, r
}

func contains(ids []string, want uuid.UUID) bool {
	for _, id := range ids {
		if id == want.String() {
			return true
		}
	}
	return false
}

// searchFixture seeds one workspace with two dashboards in different modules
// and three charts, so cross-dashboard search has something to cross.
type searchFixture struct {
	tenant                    uuid.UUID
	ws                        uuid.UUID
	dashA, dashB              uuid.UUID
	denial, revenue, archived uuid.UUID
}

func seedSearchFixture(t *testing.T, h *harness) searchFixture {
	t.Helper()
	f := searchFixture{tenant: uuid.New(), ws: uuid.New()}
	f.dashA = h.seedDashboard(t, f.tenant, f.ws, "Claims Ops", "insights", []string{"claims", "ops"})
	f.dashB = h.seedDashboard(t, f.tenant, f.ws, "Finance", "case_management", []string{"finance"})
	f.denial = h.seedNamedChart(t, f.tenant, f.dashB, "Denial rate by payer", "monthly denial percentage")
	f.revenue = h.seedNamedChart(t, f.tenant, f.dashA, "Revenue by region", "gross revenue")
	f.archived = h.seedNamedChart(t, f.tenant, f.dashA, "Legacy denial chart", "superseded")
	return f
}

// TestAC04_SearchFindsChartAcrossDashboards: the denial-rate chart lives on a
// different dashboard than the caller is looking at, and `q` still finds it —
// with the parent dashboard named in the hit.
func TestAC04_SearchFindsChartAcrossDashboards(t *testing.T) {
	h := newHarness(t)
	f := seedSearchFixture(t, h)

	ids, r := searchIDs(t, h, f.tenant, url.Values{"workspace_id": {f.ws.String()}, "q": {"denial rate"}})
	if r.status != http.StatusOK {
		t.Fatalf("status %d %v", r.status, r.body)
	}
	if len(ids) != 1 || ids[0] != f.denial.String() {
		t.Fatalf("want only the denial-rate chart, got %v", ids)
	}
	hit := r.body["data"].([]any)[0].(map[string]any)
	if hit["dashboard_id"] != f.dashB.String() {
		t.Fatalf("dashboard_id = %v, want %s", hit["dashboard_id"], f.dashB)
	}
	if hit["dashboard_name"] != "Finance" || hit["dashboard_module"] != "case_management" {
		t.Fatalf("missing dashboard context: %v", hit)
	}
}

// TestAC04_SearchMatchesDescription: `q` matches the description, not just the
// name.
func TestAC04_SearchMatchesDescription(t *testing.T) {
	h := newHarness(t)
	f := seedSearchFixture(t, h)
	ids, _ := searchIDs(t, h, f.tenant, url.Values{"workspace_id": {f.ws.String()}, "q": {"gross"}})
	if len(ids) != 1 || ids[0] != f.revenue.String() {
		t.Fatalf("description match failed: %v", ids)
	}
}

// TestAC04_SearchMatchesDocumentation: `q` matches the chart's documentation
// body (documentable_type='chart').
func TestAC04_SearchMatchesDocumentation(t *testing.T) {
	h := newHarness(t)
	f := seedSearchFixture(t, h)
	h.store.mu.Lock()
	h.store.chartDocs[f.revenue] = "Sourced from the ledger warehouse; owner is the FP&A team."
	h.store.mu.Unlock()

	ids, _ := searchIDs(t, h, f.tenant, url.Values{"workspace_id": {f.ws.String()}, "q": {"FP&A"}})
	if len(ids) != 1 || ids[0] != f.revenue.String() {
		t.Fatalf("documentation match failed: %v", ids)
	}
}

// TestAC04_SearchFiltersByModuleTagAndDashboard: the three non-`q` filters
// narrow on the parent dashboard.
func TestAC04_SearchFiltersByModuleTagAndDashboard(t *testing.T) {
	h := newHarness(t)
	f := seedSearchFixture(t, h)

	ids, _ := searchIDs(t, h, f.tenant, url.Values{"workspace_id": {f.ws.String()}, "module": {"case_management"}})
	if len(ids) != 1 || ids[0] != f.denial.String() {
		t.Fatalf("module filter: %v", ids)
	}
	ids, _ = searchIDs(t, h, f.tenant, url.Values{"workspace_id": {f.ws.String()}, "tag": {"claims"}})
	if len(ids) != 2 || !contains(ids, f.revenue) || !contains(ids, f.archived) {
		t.Fatalf("tag filter: %v", ids)
	}
	ids, _ = searchIDs(t, h, f.tenant, url.Values{"workspace_id": {f.ws.String()}, "dashboard_id": {f.dashB.String()}})
	if len(ids) != 1 || ids[0] != f.denial.String() {
		t.Fatalf("dashboard_id filter: %v", ids)
	}
	// q + filter compose (AND).
	ids, _ = searchIDs(t, h, f.tenant, url.Values{
		"workspace_id": {f.ws.String()}, "q": {"denial"}, "module": {"insights"}})
	if len(ids) != 1 || ids[0] != f.archived.String() {
		t.Fatalf("q+module compose: %v", ids)
	}
}

// TestAC04_SearchExcludesArchivedDashboards: charts on an archived dashboard
// drop out unless include_archived=true.
func TestAC04_SearchExcludesArchivedDashboards(t *testing.T) {
	h := newHarness(t)
	f := seedSearchFixture(t, h)
	ar := h.do(t, "POST", "/api/v1/dashboards/"+f.dashA.String()+"/archive", h.token(t, f.tenant), nil, nil)
	if ar.status != http.StatusOK {
		t.Fatalf("archive: %d %v", ar.status, ar.body)
	}
	ids, _ := searchIDs(t, h, f.tenant, url.Values{"workspace_id": {f.ws.String()}, "q": {"denial"}})
	if len(ids) != 1 || ids[0] != f.denial.String() {
		t.Fatalf("archived dashboard should be excluded: %v", ids)
	}
	ids, _ = searchIDs(t, h, f.tenant, url.Values{
		"workspace_id": {f.ws.String()}, "q": {"denial"}, "include_archived": {"true"}})
	if len(ids) != 2 {
		t.Fatalf("include_archived should surface both: %v", ids)
	}
}

// TestAC05_SearchIsCursorPaged: limit=1 pages through every hit with a
// next_cursor, and has_more clears on the last page.
func TestAC05_SearchIsCursorPaged(t *testing.T) {
	h := newHarness(t)
	f := seedSearchFixture(t, h)

	seen := map[string]bool{}
	cursor := ""
	for i := 0; i < 5; i++ {
		q := url.Values{"workspace_id": {f.ws.String()}, "limit": {"1"}}
		if cursor != "" {
			q.Set("cursor", cursor)
		}
		ids, r := searchIDs(t, h, f.tenant, q)
		if r.status != http.StatusOK {
			t.Fatalf("page %d status %d %v", i, r.status, r.body)
		}
		for _, id := range ids {
			if seen[id] {
				t.Fatalf("id %s returned twice", id)
			}
			seen[id] = true
		}
		page := r.body["page"].(map[string]any)
		if page["has_more"] != true {
			if len(seen) != 3 {
				t.Fatalf("finished with %d of 3 charts", len(seen))
			}
			return
		}
		if len(ids) != 1 {
			t.Fatalf("limit=1 returned %d rows", len(ids))
		}
		next, _ := page["next_cursor"].(string)
		if next == "" {
			t.Fatal("has_more without next_cursor")
		}
		cursor = next
	}
	t.Fatalf("did not terminate; seen=%d", len(seen))
}

// TestAC05_SearchRequiresChartRead: chart.chart.read denied → 403.
func TestAC05_SearchRequiresChartRead(t *testing.T) {
	h := newHarness(t)
	f := seedSearchFixture(t, h)
	h.srv.Authz = authz.Static{Denied: map[string]bool{authz.ActionChartRead: true}}
	_, r := searchIDs(t, h, f.tenant, url.Values{"workspace_id": {f.ws.String()}})
	if r.status != http.StatusForbidden || errCode(r) != "PERMISSION_DENIED" {
		t.Fatalf("want 403 PERMISSION_DENIED, got %d %s", r.status, errCode(r))
	}
}

// TestAC05_SearchCrossTenantFindsNothing: tenant B searching tenant A's
// workspace id sees an empty page, never A's charts (MASTER-FR-003).
func TestAC05_SearchCrossTenantFindsNothing(t *testing.T) {
	h := newHarness(t)
	f := seedSearchFixture(t, h)
	ids, r := searchIDs(t, h, uuid.New(), url.Values{"workspace_id": {f.ws.String()}, "q": {"denial"}})
	if r.status != http.StatusOK {
		t.Fatalf("status %d %v", r.status, r.body)
	}
	if len(ids) != 0 {
		t.Fatalf("cross-tenant leak: %v", ids)
	}
}

// TestAC05_SearchCrossTenantChartIDStill404s: the sibling guarantee — a
// cross-tenant chart id is not readable by id either.
func TestAC05_SearchCrossTenantChartIDStill404s(t *testing.T) {
	h := newHarness(t)
	f := seedSearchFixture(t, h)
	r := h.do(t, "GET", "/api/v1/charts/"+f.denial.String(), h.token(t, uuid.New()), nil, nil)
	if r.status != http.StatusNotFound {
		t.Fatalf("want 404, got %d", r.status)
	}
}

// TestSearchRejectsBadInput: missing workspace_id, unknown module, malformed
// dashboard_id and a corrupt cursor are all 422s, not 500s.
func TestSearchRejectsBadInput(t *testing.T) {
	h := newHarness(t)
	f := seedSearchFixture(t, h)
	ws := f.ws.String()
	cases := []struct {
		name string
		q    url.Values
	}{
		{"missing workspace_id", url.Values{"q": {"denial"}}},
		{"bad workspace_id", url.Values{"workspace_id": {"not-a-uuid"}}},
		{"unknown module", url.Values{"workspace_id": {ws}, "module": {"nope"}}},
		{"bad dashboard_id", url.Values{"workspace_id": {ws}, "dashboard_id": {"nope"}}},
		{"bad cursor", url.Values{"workspace_id": {ws}, "cursor": {"!!!"}}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			_, r := searchIDs(t, h, f.tenant, c.q)
			if r.status != http.StatusUnprocessableEntity {
				t.Fatalf("want 422, got %d %v", r.status, r.body)
			}
		})
	}
}

// TestSearchScopedToWorkspace: a chart in another workspace of the same tenant
// is not returned — the authorization decision covers one workspace only.
func TestSearchScopedToWorkspace(t *testing.T) {
	h := newHarness(t)
	f := seedSearchFixture(t, h)
	otherWS := uuid.New()
	otherDash := h.seedDashboard(t, f.tenant, otherWS, "Other WS", "insights", nil)
	other := h.seedNamedChart(t, f.tenant, otherDash, "Denial rate elsewhere", "")

	ids, _ := searchIDs(t, h, f.tenant, url.Values{"workspace_id": {f.ws.String()}, "q": {"denial"}})
	if contains(ids, other) {
		t.Fatalf("leaked a chart from another workspace: %v", ids)
	}
	ids, _ = searchIDs(t, h, f.tenant, url.Values{"workspace_id": {otherWS.String()}, "q": {"denial"}})
	if len(ids) != 1 || ids[0] != other.String() {
		t.Fatalf("other workspace search: %v", ids)
	}
}
