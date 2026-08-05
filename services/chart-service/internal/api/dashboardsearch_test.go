package api

import (
	"fmt"
	"net/http"
	"net/url"
	"testing"

	"github.com/google/uuid"

	"github.com/datacern-ai/chart-service/internal/authz"
)

// BRD 74 D3 — `q` on GET /dashboards.
//
// The palette used to fetch `first: 50` dashboards and filter them in the
// browser, so a dashboard ranked below that page was unfindable. These tests
// pin the server-side behaviour that replaces it.

// listDashboards runs GET /dashboards and returns the ids plus the raw response.
func listDashboards(t *testing.T, h *harness, tenant uuid.UUID, q url.Values) ([]string, resp) {
	t.Helper()
	r := h.do(t, "GET", "/api/v1/dashboards?"+q.Encode(), h.token(t, tenant), nil, nil)
	var ids []string
	list, _ := r.body["data"].([]any)
	for _, item := range list {
		m, _ := item.(map[string]any)
		id, _ := m["id"].(string)
		ids = append(ids, id)
	}
	return ids, r
}

// seedDescribedDashboard creates a dashboard with an explicit description, which
// the shared seedDashboard helper does not set.
func seedDescribedDashboard(t *testing.T, h *harness, tenant, ws uuid.UUID, name, module, description string, tags []string) uuid.UUID {
	t.Helper()
	r := h.do(t, "POST", "/api/v1/dashboards", h.token(t, tenant), map[string]any{
		"name": name, "module": module, "workspace_id": ws.String(),
		"description": description, "tags": tags,
	}, nil)
	if r.status != http.StatusCreated {
		t.Fatalf("create dashboard %q: %d %v", name, r.status, r.body)
	}
	return uuid.MustParse(dataMap(r)["id"].(string))
}

// TestAC09_DashboardSearchFindsBeyondTheFirstPage is the service-tier proof of
// the palette defect: 60 dashboards in one workspace, and the one the user
// wants sorts LAST by id. A client fetching the first 50 and filtering locally
// never sees it; `q` returns it as the only hit.
func TestAC09_DashboardSearchFindsBeyondTheFirstPage(t *testing.T) {
	h := newHarness(t)
	tenant, ws := uuid.New(), uuid.New()
	for i := 0; i < 60; i++ {
		h.seedDashboard(t, tenant, ws, fmt.Sprintf("Ops board %02d", i), "insights", nil)
	}
	want := h.seedDashboard(t, tenant, ws, "Denial rate review", "insights", nil)

	// The unfiltered first page of 50 is what the palette used to get.
	page1, r := listDashboards(t, h, tenant, url.Values{
		"workspace_id": {ws.String()}, "limit": {"50"},
	})
	if r.status != http.StatusOK {
		t.Fatalf("list: %d %v", r.status, r.body)
	}
	if len(page1) != 50 {
		t.Fatalf("want a full first page of 50, got %d", len(page1))
	}
	if contains(page1, want) {
		// Not a correctness failure of the new code, but the fixture would no
		// longer be testing anything.
		t.Fatalf("fixture broken: the target dashboard is inside the first 50")
	}

	ids, r := listDashboards(t, h, tenant, url.Values{
		"workspace_id": {ws.String()}, "q": {"denial"}, "limit": {"50"},
	})
	if r.status != http.StatusOK {
		t.Fatalf("search: %d %v", r.status, r.body)
	}
	if len(ids) != 1 || ids[0] != want.String() {
		t.Fatalf("q=denial should return exactly the 61st dashboard, got %v", ids)
	}
}

func TestDashboardSearchMatchesDescriptionAndIsCaseInsensitive(t *testing.T) {
	h := newHarness(t)
	tenant, ws := uuid.New(), uuid.New()
	byDesc := seedDescribedDashboard(t, h, tenant, ws, "Board A", "insights",
		"Quarterly PAYER mix and denial trend", nil)
	seedDescribedDashboard(t, h, tenant, ws, "Board B", "insights", "unrelated", nil)

	for _, needle := range []string{"payer", "PAYER", "PaYeR"} {
		ids, r := listDashboards(t, h, tenant, url.Values{
			"workspace_id": {ws.String()}, "q": {needle},
		})
		if r.status != http.StatusOK {
			t.Fatalf("status %d %v", r.status, r.body)
		}
		if len(ids) != 1 || ids[0] != byDesc.String() {
			t.Fatalf("q=%q: want only the description match, got %v", needle, ids)
		}
	}
}

// A term containing LIKE metacharacters must match literally, not as a wildcard.
func TestDashboardSearchTreatsLikeMetacharactersLiterally(t *testing.T) {
	h := newHarness(t)
	tenant, ws := uuid.New(), uuid.New()
	pct := h.seedDashboard(t, tenant, ws, "Denial 100% board", "insights", nil)
	h.seedDashboard(t, tenant, ws, "Denial rate board", "insights", nil)

	ids, r := listDashboards(t, h, tenant, url.Values{
		"workspace_id": {ws.String()}, "q": {"100%"},
	})
	if r.status != http.StatusOK {
		t.Fatalf("status %d %v", r.status, r.body)
	}
	if len(ids) != 1 || ids[0] != pct.String() {
		t.Fatalf(`q="100%%" must match literally; got %v`, ids)
	}
}

func TestDashboardSearchComposesWithModuleTagAndArchived(t *testing.T) {
	h := newHarness(t)
	tenant, ws := uuid.New(), uuid.New()
	insights := h.seedDashboard(t, tenant, ws, "Denial insights", "insights", []string{"claims"})
	cases := h.seedDashboard(t, tenant, ws, "Denial cases", "case_management", []string{"ops"})
	archived := h.seedDashboard(t, tenant, ws, "Denial legacy", "insights", []string{"claims"})
	if r := h.do(t, "POST", "/api/v1/dashboards/"+archived.String()+"/archive",
		h.token(t, tenant), nil, nil); r.status != http.StatusOK {
		t.Fatalf("archive: %d %v", r.status, r.body)
	}

	// q alone: both live dashboards, never the archived one.
	ids, _ := listDashboards(t, h, tenant, url.Values{"workspace_id": {ws.String()}, "q": {"denial"}})
	if len(ids) != 2 || !contains(ids, insights) || !contains(ids, cases) {
		t.Fatalf("q alone: want the two live matches, got %v", ids)
	}

	// q + module.
	ids, _ = listDashboards(t, h, tenant, url.Values{
		"workspace_id": {ws.String()}, "q": {"denial"}, "filter[module]": {"case_management"},
	})
	if len(ids) != 1 || ids[0] != cases.String() {
		t.Fatalf("q+module: got %v", ids)
	}

	// q + tag.
	ids, _ = listDashboards(t, h, tenant, url.Values{
		"workspace_id": {ws.String()}, "q": {"denial"}, "filter[tag]": {"ops"},
	})
	if len(ids) != 1 || ids[0] != cases.String() {
		t.Fatalf("q+tag: got %v", ids)
	}

	// q + archived=true: only the archived one.
	ids, _ = listDashboards(t, h, tenant, url.Values{
		"workspace_id": {ws.String()}, "q": {"denial"}, "filter[archived]": {"true"},
	})
	if len(ids) != 1 || ids[0] != archived.String() {
		t.Fatalf("q+archived: got %v", ids)
	}
}

func TestDashboardSearchIsCursorPaged(t *testing.T) {
	h := newHarness(t)
	tenant, ws := uuid.New(), uuid.New()
	for i := 0; i < 3; i++ {
		h.seedDashboard(t, tenant, ws, fmt.Sprintf("Denial board %d", i), "insights", nil)
	}
	seen := map[string]bool{}
	cursor := ""
	for i := 0; i < 5; i++ {
		q := url.Values{"workspace_id": {ws.String()}, "q": {"denial"}, "limit": {"1"}}
		if cursor != "" {
			q.Set("cursor", cursor)
		}
		ids, r := listDashboards(t, h, tenant, q)
		if r.status != http.StatusOK {
			t.Fatalf("page %d: %d %v", i, r.status, r.body)
		}
		for _, id := range ids {
			if seen[id] {
				t.Fatalf("cursor repeated %s", id)
			}
			seen[id] = true
		}
		page, _ := r.body["page"].(map[string]any)
		if more, _ := page["has_more"].(bool); !more {
			if len(seen) != 3 {
				t.Fatalf("paged %d dashboards, want 3", len(seen))
			}
			return
		}
		cursor, _ = page["next_cursor"].(string)
		if cursor == "" {
			t.Fatal("has_more without next_cursor")
		}
	}
	t.Fatalf("did not terminate; seen=%d", len(seen))
}

// Cross-tenant isolation: tenant B searching tenant A's workspace id gets an
// empty page, never A's dashboards (MASTER-FR-003).
func TestDashboardSearchCrossTenantFindsNothing(t *testing.T) {
	h := newHarness(t)
	tenantA, ws := uuid.New(), uuid.New()
	h.seedDashboard(t, tenantA, ws, "Denial rate review", "insights", nil)

	ids, r := listDashboards(t, h, uuid.New(), url.Values{
		"workspace_id": {ws.String()}, "q": {"denial"},
	})
	if r.status != http.StatusOK {
		t.Fatalf("status %d %v", r.status, r.body)
	}
	if len(ids) != 0 {
		t.Fatalf("cross-tenant leak: %v", ids)
	}
}

// Another workspace of the SAME tenant is not searched either — workspace_id
// stays a hard scope, because chart.dashboard.read is a workspace-scoped grant.
func TestDashboardSearchNeverCrossesWorkspaces(t *testing.T) {
	h := newHarness(t)
	tenant, wsA, wsB := uuid.New(), uuid.New(), uuid.New()
	h.seedDashboard(t, tenant, wsA, "Denial rate review", "insights", nil)

	ids, r := listDashboards(t, h, tenant, url.Values{
		"workspace_id": {wsB.String()}, "q": {"denial"},
	})
	if r.status != http.StatusOK {
		t.Fatalf("status %d %v", r.status, r.body)
	}
	if len(ids) != 0 {
		t.Fatalf("workspace leak: %v", ids)
	}
}

func TestDashboardSearchRequiresDashboardRead(t *testing.T) {
	h := newHarness(t)
	tenant, ws := uuid.New(), uuid.New()
	h.seedDashboard(t, tenant, ws, "Denial rate review", "insights", nil)
	h.srv.Authz = authz.Static{Denied: map[string]bool{authz.ActionDashboardRead: true}}

	_, r := listDashboards(t, h, tenant, url.Values{"workspace_id": {ws.String()}, "q": {"denial"}})
	if r.status != http.StatusForbidden || errCode(r) != "PERMISSION_DENIED" {
		t.Fatalf("want 403 PERMISSION_DENIED, got %d %s", r.status, errCode(r))
	}
}
